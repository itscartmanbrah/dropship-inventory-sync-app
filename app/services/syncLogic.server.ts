import { unauthenticated } from '../shopify.server';
import prisma from '../db.server';
import { fetchSheetData } from './googleSheets.server';

// Resilient wrapper for Shopify Admin GraphQL calls. Fetches a fresh admin
// client (latest stored token) per call, and on a 401 from a rotated offline
// token it re-fetches the client and retries. Also backs off on transient 5xx.
async function retryGraphql(shop: string, query: string, options: any, maxRetries = 6): Promise<any> {
  let admin = (await unauthenticated.admin(shop)).admin;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await admin.graphql(query, options);
    } catch (err: any) {
      const statusCode = err?.response?.code || err?.response?.statusCode || err?.response?.status;
      const isAuth = statusCode === 401 || /unauthorized|401/i.test(String(err?.message || ""));
      const isTransient = statusCode === 500 || statusCode === 502 || statusCode === 503;

      if (isAuth && attempt < maxRetries) {
        // Offline token rotated mid-run — re-fetch the admin client and retry.
        admin = (await unauthenticated.admin(shop)).admin;
        await new Promise(resolve => setTimeout(resolve, 300));
      } else if (isTransient && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`Shopify API returned ${statusCode}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
}

export async function runSyncForShop(shop: string, type: string = "MANUAL") {
  console.log(`Starting sync for shop: ${shop}`);
  
  // 0. Create SyncRun record
  const syncRun = await prisma.syncRun.create({
    data: {
      shop,
      type,
      status: "IN_PROGRESS",
      totalItems: 0,
      processedItems: 0,
    }
  });

  const reportRows: string[] = [];
  reportRows.push(["SKU", "Product Title", "Variant Title", "Barcode", "Qty Before", "Qty After"].map(s => `"${s}"`).join(","));

  try {
    // 1. Get settings
    const settings = await prisma.settings.findUnique({
      where: { shop }
    });

    if (!settings || !settings.googleSheetId || !settings.googleServiceAccount) {
        throw new Error("Missing Google Sheet ID or Service Account JSON. Please save your settings first.");
    }

    // 2. Fetch Google Sheets Data
    const sheetRows = await fetchSheetData(settings.googleSheetId, settings.googleServiceAccount);
    
    await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: { totalItems: sheetRows.length }
    });

    // 3. Admin client is created per-call inside retryGraphql, so it always uses
    //    the latest token and survives offline-token rotation mid-run.

    // 4. Get Target Location ID
    const locationId = settings.locationId;
    if (!locationId) {
        throw new Error('No Location selected. Please go to settings and select a Target Inventory Location.');
    }

    // 5. Fetch all products/variants to build barcode map
    let hasNextPage = true;
    let cursor = null;
    
    // product map: keep track of total projected inventory across all locations
    const productTotalInventoryData = new Map<string, { totalProjected: number }>();
    const variantDataByBarcode = new Map<string, {
        inventoryItemId: string;
        productId: string;
        currentWarehouseQty: number;
        isAtTargetLocation: boolean;
        sku: string;
        productTitle: string;
        variantTitle: string;
    }>();

    while (hasNextPage) {
        const productsResponse = await retryGraphql(shop,
        `#graphql
        query getVariants($cursor: String) {
            productVariants(first: 250, after: $cursor) {
            pageInfo {
                hasNextPage
                endCursor
            }
            edges {
                node {
                id
                sku
                title
                barcode
                product {
                    id
                    title
                }
                inventoryItem {
                    id
                    inventoryLevels(first: 10) {
                        edges {
                            node {
                                location {
                                    id
                                }
                                quantities(names: ["available"]) {
                                    name
                                    quantity
                                }
                            }
                        }
                    }
                }
                }
            }
            }
        }`,
        { variables: { cursor } }
        );
        
        const productsData = await productsResponse.json();
        const variantsList = productsData.data.productVariants;
        
        for (const edge of variantsList.edges) {
            const productId = edge.node.product.id;
            if (!productTotalInventoryData.has(productId)) {
                productTotalInventoryData.set(productId, { totalProjected: 0 });
            }

            const inventoryLevels = edge.node.inventoryItem?.inventoryLevels?.edges || [];
            let currentVariantTotal = 0;
            let currentVariantWarehouseQty = 0;
            let isAtTargetLocation = false;

            for (const level of inventoryLevels) {
                const qty = level.node.quantities?.find((q: any) => q.name === "available")?.quantity || 0;
                currentVariantTotal += qty;
                if (level.node.location.id === locationId) {
                    currentVariantWarehouseQty += qty;
                    isAtTargetLocation = true;
                }
            }
            
            productTotalInventoryData.get(productId)!.totalProjected += currentVariantTotal;

            if (edge.node.barcode) {
                variantDataByBarcode.set(edge.node.barcode, {
                    inventoryItemId: edge.node.inventoryItem.id,
                    productId,
                    currentWarehouseQty: currentVariantWarehouseQty,
                    isAtTargetLocation,
                    sku: edge.node.sku || "",
                    productTitle: edge.node.product.title || "",
                    variantTitle: edge.node.title || "",
                });
            }
        }
        
        hasNextPage = variantsList.pageInfo.hasNextPage;
        cursor = variantsList.pageInfo.endCursor;
    }

    // 6. Process items from Google Sheet
    const updateMutations = [];
    const variantsToActivate = [];
    let processedItems = 0;
    
    // Track unique product IDs that had inventory updated (for tagging)
    const updatedProductIds = new Set<string>();

    for (const row of sheetRows) {
        const rawBarcode = row['Barcode'] || row['Variant Barcode'];
        const qtyStr = row['Variant Inventory Qty'] || row['Variant Inventory Quantity'];
        const quantity = parseInt(qtyStr, 10) || 0;
        
        if (!rawBarcode) continue;
        const barcode = String(rawBarcode).trim();
        
        const variantData = variantDataByBarcode.get(barcode);
        if (variantData) {
            if (!variantData.isAtTargetLocation) {
                variantsToActivate.push(variantData.inventoryItemId);
                variantData.isAtTargetLocation = true; // prevent multi-adds if barcode duplicates
            }

            // Capture the original qty before we overwrite it
            const originalWarehouseQty = variantData.currentWarehouseQty;

            // Adjust the product's total projected inventory
            const productData = productTotalInventoryData.get(variantData.productId)!;
            productData.totalProjected = productData.totalProjected - variantData.currentWarehouseQty + quantity;
            
            // To prevent double subtraction if there are duplicate barcodes in sheet, we update currentWarehouseQty to new quantity
            // This ensures if the sheet has it twice, the second one just overrides normally.
            variantData.currentWarehouseQty = quantity;

            // Track this product for tagging
            updatedProductIds.add(variantData.productId);

            updateMutations.push({
                inventoryItemId: variantData.inventoryItemId,
                locationId,
                quantity,
            });

            reportRows.push([
                variantData.sku,
                variantData.productTitle,
                variantData.variantTitle,
                barcode,
                originalWarehouseQty.toString(),
                quantity.toString()
            ].map(s => `"${(s || "").replace(/"/g, '""')}"`).join(","));
        }
    }

    // Determine Archivals
    const productsToArchive = [];
    for (const [productId, data] of productTotalInventoryData.entries()) {
        if (data.totalProjected <= 0) {
            productsToArchive.push(productId);
        }
    }

    // 6.5 Safely Activate Missing Items First
    if (variantsToActivate.length > 0) {
        console.log(`Activating ${variantsToActivate.length} unassigned items at location...`);
        for (const itemId of variantsToActivate) {
            try {
                await retryGraphql(shop,
                    `#graphql
                    mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
                      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                        userErrors { field message }
                      }
                    }`,
                    { variables: { inventoryItemId: itemId, locationId } }
                );
            } catch (err: any) {
                console.error("Warning: Failed to activate item", itemId, err?.message);
            }
            // Throttle to replenish bucket points
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    // 7. Bulk Update Inventory for existing ones
    if (updateMutations.length > 0) {
        const chunkSize = 100;
        for (let i = 0; i < updateMutations.length; i += chunkSize) {
            const chunk = updateMutations.slice(i, i + chunkSize);
            const setQuantities = chunk.map((m) => ({
                inventoryItemId: m.inventoryItemId,
                locationId: m.locationId,
                quantity: m.quantity
            }));

            try {
                const response = await retryGraphql(shop,
                    `#graphql
                    mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
                      inventorySetQuantities(input: $input) {
                        userErrors { field message }
                      }
                    }`,
                    { variables: { input: { name: "available", reason: "correction", ignoreCompareQuantity: true, quantities: setQuantities } } }
                );

                const responseData = await response.json();
                if (responseData.errors) {
                    console.error("GraphQL system error updating inventory:", JSON.stringify(responseData.errors));
                }
                if (responseData.data?.inventorySetQuantities?.userErrors?.length > 0) {
                    const uErrors = responseData.data.inventorySetQuantities.userErrors;
                    console.error("GraphQL userErrors updating inventory:", JSON.stringify(uErrors));
                }
            } catch (err: any) {
                console.error("Exception updating inventory chunk:", err?.message);
            }

            processedItems += chunk.length;
            await prisma.syncRun.update({
                where: { id: syncRun.id },
                data: { processedItems }
            });

            // Avoid Shopify API rate limiting by waiting 2 seconds (100 points replenished)
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // 8. Put products to archive
    if (productsToArchive.length > 0) {
        console.log(`Archiving ${productsToArchive.length} products...`);
        for (const productId of productsToArchive) {
            try {
                const pResponse = await retryGraphql(shop,
                    `#graphql
                    mutation productUpdate($input: ProductInput!) {
                        productUpdate(input: $input) {
                            userErrors { field message}
                        }
                    }`,
                    { variables: { input: { id: productId, status: "ARCHIVED" } } }
                );

                const pData = await pResponse.json();
                if (pData.errors) {
                    console.error("GraphQL system error archiving product:", productId, JSON.stringify(pData.errors));
                }
                if (pData.data?.productUpdate?.userErrors?.length > 0) {
                    const pErrors = pData.data.productUpdate.userErrors;
                    console.error(`Skipping archive for product ${productId}:`, pErrors.map((e: any) => e.message).join(", "));
                }
            } catch (err: any) {
                console.error(`Warning: Failed to archive product ${productId}:`, err?.message);
            }

            // Avoid Shopify API rate limiting by waiting 250ms
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    // 9. Tag updated products with "Dropship Inventory Updated"
    if (updatedProductIds.size > 0) {
        console.log(`Tagging ${updatedProductIds.size} updated products...`);
        for (const productId of updatedProductIds) {
            try {
                // Fetch current tags for this product
                const tagResponse = await retryGraphql(shop,
                    `#graphql
                    query getProductTags($id: ID!) {
                        product(id: $id) {
                            tags
                        }
                    }`,
                    { variables: { id: productId } }
                );
                const tagData = await tagResponse.json();
                const currentTags: string[] = tagData.data?.product?.tags || [];

                // Only add the tag if it's not already present
                if (!currentTags.includes("Dropship Inventory Updated")) {
                    const newTags = [...currentTags, "Dropship Inventory Updated"];
                    await retryGraphql(shop,
                        `#graphql
                        mutation productUpdate($input: ProductInput!) {
                            productUpdate(input: $input) {
                                userErrors { field message }
                            }
                        }`,
                        { variables: { input: { id: productId, tags: newTags } } }
                    );
                }
            } catch (err: any) {
                console.error(`Warning: Failed to tag product ${productId}:`, err?.message);
            }
            // Throttle to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }

    // Finish
    const csvContent = reportRows.join("\n");
    await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
             status: "COMPLETED",
             completedAt: new Date(),
             processedItems: updateMutations.length,
             reportData: csvContent
        }
    });

    await prisma.settings.update({
        where: { shop },
        data: { lastSyncTime: new Date() }
    });

    console.log(`Sync completed for shop: ${shop}`);
  } catch (error: any) {
    console.error("Sync failed:", error);
    const csvContent = reportRows.join("\n");
    await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
            status: "ERROR",
            completedAt: new Date(),
            errorMessage: error.message,
            reportData: csvContent
        }
    });
  }
}

// Guard against overlapping price-sync runs for the same shop (the 15-min
// scheduler could otherwise fire again while a slow run is still in progress).
const priceSyncInFlight = new Set<string>();

/**
 * Lightweight, frequent price sync. For every variant matched by barcode in the
 * Google Sheet, set the Shopify selling price to the sheet's RRP (column G) and
 * clear any "compare at" (sale) price. Diff-based: only variants whose price
 * differs from the RRP (or that still have a compare-at price) are updated, so
 * routine runs only re-correct the few items Retail Edge recently discounted.
 */
export async function runPriceSyncForShop(shop: string, type: string = "PRICE_MANUAL") {
  if (priceSyncInFlight.has(shop)) {
    console.log(`Price sync already running for ${shop}; skipping this trigger.`);
    return;
  }
  priceSyncInFlight.add(shop);
  const startMs = Date.now();
  console.log(`Starting PRICE sync for shop: ${shop}`);

  const syncRun = await prisma.syncRun.create({
    data: { shop, type, status: "IN_PROGRESS", totalItems: 0, processedItems: 0 },
  });

  const reportRows: string[] = [];
  reportRows.push(["SKU", "Product Title", "Variant Title", "Barcode", "Price Before", "Price After (RRP)", "Compare-At Cleared"].map(s => `"${s}"`).join(","));

  try {
    const settings = await prisma.settings.findUnique({ where: { shop } });
    if (!settings || !settings.googleSheetId || !settings.googleServiceAccount) {
      throw new Error("Missing Google Sheet ID or Service Account JSON. Please save your settings first.");
    }

    const sheetRows = await fetchSheetData(settings.googleSheetId, settings.googleServiceAccount);

    // Build barcode -> RRP, skipping blank / zero values so we never zero a price.
    const rrpByBarcode = new Map<string, number>();
    for (const row of sheetRows) {
      const rawBarcode = row['Variant Barcode'] || row['Barcode'];
      if (!rawBarcode) continue;
      const rrpRaw = row['RRP'];
      if (rrpRaw === undefined || rrpRaw === null || String(rrpRaw).trim() === "") continue;
      const rrp = parseFloat(String(rrpRaw).replace(/[^0-9.]/g, ""));
      if (!rrp || rrp <= 0) continue;
      rrpByBarcode.set(String(rawBarcode).trim(), rrp);
    }

    // Offline access tokens can rotate mid-run (e.g. while the embedded app is
    // open and refreshing its token), invalidating a long-held admin client and
    // returning 401. This wrapper re-fetches the admin client on a 401 (picking
    // up the freshly stored token) and retries; it also backs off on throttling.
    let adminClient = (await unauthenticated.admin(shop)).admin;
    const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
    const isAuthError = (e: any) =>
      e?.response?.status === 401 || e?.response?.code === 401 || /unauthorized|401/i.test(String(e?.message || ""));
    const gql = async (query: string, variables: any): Promise<any> => {
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const r = await adminClient.graphql(query, { variables });
          const rd = await r.json();
          if (rd.errors?.some((e: any) => e?.extensions?.code === "THROTTLED") && attempt < 6) {
            await sleep(2000);
            continue;
          }
          return rd;
        } catch (e: any) {
          if (isAuthError(e) && attempt < 6) {
            adminClient = (await unauthenticated.admin(shop)).admin; // refresh rotated token
            await sleep(300);
            continue;
          }
          const code = e?.response?.code || e?.response?.status;
          if ((code === 500 || code === 502 || code === 503) && attempt < 6) {
            await sleep(attempt * 1000);
            continue;
          }
          if (attempt < 6) { await sleep(attempt * 800); continue; }
          throw e;
        }
      }
    };

    // Scan all variants; queue only those that actually need correcting.
    let hasNextPage = true;
    let cursor: string | null = null;
    const updatesByProduct = new Map<string, { id: string; price: string; compareAtPrice: null }[]>();
    let toUpdateCount = 0;

    while (hasNextPage) {
      const data = await gql(
        `#graphql
        query getVariantPrices($cursor: String) {
          productVariants(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                sku
                title
                barcode
                price
                compareAtPrice
                product { id title }
              }
            }
          }
        }`,
        { cursor }
      );
      const list = data.data.productVariants;

      for (const edge of list.edges) {
        const n = edge.node;
        if (!n.barcode) continue;
        const rrp = rrpByBarcode.get(String(n.barcode).trim());
        if (rrp === undefined) continue;

        const rrpStr = rrp.toFixed(2);
        const priceDiffers = parseFloat(n.price).toFixed(2) !== rrpStr;
        const hasCompareAt = n.compareAtPrice !== null && n.compareAtPrice !== undefined;

        if (priceDiffers || hasCompareAt) {
          const arr = updatesByProduct.get(n.product.id) || [];
          arr.push({ id: n.id, price: rrpStr, compareAtPrice: null });
          updatesByProduct.set(n.product.id, arr);
          toUpdateCount++;
          reportRows.push([
            n.sku || "", n.product.title || "", n.title || "", n.barcode, n.price, rrpStr, hasCompareAt ? "yes" : "no"
          ].map(s => `"${String(s ?? "").replace(/"/g, '""')}"`).join(","));
        }
      }

      hasNextPage = list.pageInfo.hasNextPage;
      cursor = list.pageInfo.endCursor;
    }

    await prisma.syncRun.update({ where: { id: syncRun.id }, data: { totalItems: toUpdateCount } });

    // Apply updates with limited concurrency (productVariantsBulkUpdate is
    // per-product). Parallelising keeps large first-time runs fast, while the
    // throttle-aware retry below stays within Shopify's API rate limit.
    const priceMutation = `#graphql
      mutation bulkPriceUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`;

    const applyOne = async (productId: string, variants: { id: string; price: string; compareAtPrice: null }[]) => {
      try {
        const rd = await gql(priceMutation, { productId, variants });
        if (rd.errors) console.error("Price GraphQL error:", productId, JSON.stringify(rd.errors));
        const ue = rd.data?.productVariantsBulkUpdate?.userErrors;
        if (ue?.length > 0) console.error("Price userErrors:", productId, JSON.stringify(ue));
      } catch (e: any) {
        console.error("Price update failed for product", productId, e?.message);
      }
    };

    const entries = Array.from(updatesByProduct.entries());
    let processed = 0;
    let nextIdx = 0;
    const CONCURRENCY = 6;
    const worker = async () => {
      while (true) {
        const i = nextIdx++;
        if (i >= entries.length) return;
        const [productId, variants] = entries[i];
        await applyOne(productId, variants);
        processed += variants.length;
        if (processed % 20 === 0) {
          await prisma.syncRun.update({ where: { id: syncRun.id }, data: { processedItems: processed } });
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const secs = ((Date.now() - startMs) / 1000).toFixed(1);
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "COMPLETED", completedAt: new Date(), processedItems: processed, reportData: reportRows.join("\n") },
    });
    await prisma.settings.update({ where: { shop }, data: { lastPriceSyncTime: new Date() } });
    console.log(`PRICE sync completed for ${shop}: ${processed} variants updated in ${secs}s`);
  } catch (error: any) {
    console.error("Price sync failed:", error);
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "ERROR", completedAt: new Date(), errorMessage: error.message, reportData: reportRows.join("\n") },
    });
  } finally {
    priceSyncInFlight.delete(shop);
  }
}
