import { unauthenticated } from '../shopify.server';
import prisma from '../db.server';
import { fetchSheetData } from './googleSheets.server';

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

    // 3. Authenticate with Shopify API Offline
    const { admin } = await unauthenticated.admin(shop);

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
    }>();

    while (hasNextPage) {
        const productsResponse = await admin.graphql(
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
                barcode
                product {
                    id
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

            for (const level of inventoryLevels) {
                const qty = level.node.quantities?.find((q: any) => q.name === "available")?.quantity || 0;
                currentVariantTotal += qty;
                if (level.node.location.id === locationId) {
                    currentVariantWarehouseQty += qty;
                }
            }
            
            productTotalInventoryData.get(productId)!.totalProjected += currentVariantTotal;

            if (edge.node.barcode) {
                variantDataByBarcode.set(edge.node.barcode, {
                    inventoryItemId: edge.node.inventoryItem.id,
                    productId,
                    currentWarehouseQty: currentVariantWarehouseQty
                });
            }
        }
        
        hasNextPage = variantsList.pageInfo.hasNextPage;
        cursor = variantsList.pageInfo.endCursor;
    }

    // 6. Process items from Google Sheet
    const updateMutations = [];
    let processedItems = 0;
    
    for (const row of sheetRows) {
        const barcode = row['Barcode'] || row['Variant Barcode'];
        const qtyStr = row['Variant Inventory Qty'] || row['Variant Inventory Quantity'];
        const quantity = parseInt(qtyStr, 10) || 0;
        
        if (!barcode) continue;
        
        const variantData = variantDataByBarcode.get(barcode);
        if (variantData) {
            // Adjust the product's total projected inventory
            const productData = productTotalInventoryData.get(variantData.productId)!;
            productData.totalProjected = productData.totalProjected - variantData.currentWarehouseQty + quantity;
            
            // To prevent double subtraction if there are duplicate barcodes in sheet, we update currentWarehouseQty to new quantity
            // This ensures if the sheet has it twice, the second one just overrides normally.
            variantData.currentWarehouseQty = quantity;

            updateMutations.push({
                inventoryItemId: variantData.inventoryItemId,
                locationId,
                quantity,
            });
        }
    }

    // Determine Archivals
    const productsToArchive = [];
    for (const [productId, data] of productTotalInventoryData.entries()) {
        if (data.totalProjected <= 0) {
            productsToArchive.push(productId);
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

            await admin.graphql(
                `#graphql
                mutation inventorySetOnHandQuantities($input: InventorySetOnHandQuantitiesInput!) {
                inventorySetOnHandQuantities(input: $input) {
                    userErrors { field message }
                }
                }`,
                { variables: { input: { reason: "correction", setQuantities } } }
            );

            processedItems += chunk.length;
            await prisma.syncRun.update({
                where: { id: syncRun.id },
                data: { processedItems }
            });
        }
    } else {
        await prisma.syncRun.update({
            where: { id: syncRun.id },
            data: { processedItems: sheetRows.length }
        });
    }

    // 8. Put products to archive
    if (productsToArchive.length > 0) {
        console.log(`Archiving ${productsToArchive.length} products...`);
        for (const productId of productsToArchive) {
            await admin.graphql(
                `#graphql
                mutation productUpdate($input: ProductInput!) {
                    productUpdate(input: $input) {
                        userErrors { field message}
                    }
                }`,
                { variables: { input: { id: productId, status: "ARCHIVED" } } }
            );
        }
    }

    // Finish
    await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
             status: "COMPLETED",
             completedAt: new Date(),
             processedItems: sheetRows.length // Final set
        }
    });

    await prisma.settings.update({
        where: { shop },
        data: { lastSyncTime: new Date() }
    });

    console.log(`Sync completed for shop: ${shop}`);
  } catch (error: any) {
    console.error("Sync failed:", error);
    await prisma.syncRun.update({
        where: { id: syncRun.id },
        data: {
            status: "ERROR",
            completedAt: new Date(),
            errorMessage: error.message
        }
    });
  }
}
