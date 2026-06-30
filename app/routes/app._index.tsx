import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useActionData, useNavigation, Form, useSubmit } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  TextField,
  Checkbox,
  Banner,
  Select,
  Box,
  Text,
  ProgressBar,
  IndexTable,
  Badge,
  InlineStack
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runSyncForShop } from "../services/syncLogic.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  let settings = await prisma.settings.findUnique({ where: { shop } });
  if (!settings) {
    settings = await prisma.settings.create({ data: { shop } });
  }

  // Fetch shop locations
  const locationsResponse = await admin.graphql(
    `#graphql
    query {
      locations(first: 50) {
        edges {
          node {
            id
            name
          }
        }
      }
    }`
  );
  const locationsData = await locationsResponse.json();
  const locations = locationsData.data.locations.edges.map((e: any) => ({
    label: e.node.name,
    value: e.node.id,
  }));

  // Fetch 10 most recent sync runs
  const syncRuns = await prisma.syncRun.findMany({
      where: { shop },
      orderBy: { startedAt: 'desc' },
      take: 10,
  });

  return json({ settings, locations, syncRuns });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "syncNow") {
    try {
      // Run in background (fire-and-forget) to bypass UI timeouts
      runSyncForShop(shop, "MANUAL").catch((err) => console.error("Background sync error:", err));
      return json({ success: true, message: "Sync started quietly in the background! Check the progress bar below." });
    } catch (error: any) {
      return json({ success: false, message: error.message || "Failed to trigger sync" });
    }
  } else if (intent === "saveSettings") {
    const googleSheetId = formData.get("googleSheetId") as string;
    const googleServiceAccount = formData.get("googleServiceAccount") as string;
    const isActive = formData.get("isActive") === "true";
    const syncIntervalHours = parseInt(formData.get("syncIntervalHours") as string, 10) || 24;
    const locationId = formData.get("locationId") as string;

    await prisma.settings.update({
      where: { shop },
      data: {
        googleSheetId,
        googleServiceAccount,
        isActive,
        syncIntervalHours,
        locationId,
      },
    });

    return json({ success: true, message: "Settings saved" });
  }

  return json({ success: false, message: "Unknown intent" });
};

export default function Index() {
  const { settings, locations, syncRuns } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();

  const isSaving = navigation.state === "submitting" && navigation.formData?.get("intent") === "saveSettings";
  const isSyncing = navigation.state === "submitting" && navigation.formData?.get("intent") === "syncNow";

  const [sheetId, setSheetId] = useState(settings?.googleSheetId || "");
  const [serviceJson, setServiceJson] = useState(settings?.googleServiceAccount || "");
  const [intervalOption, setIntervalOption] = useState((settings?.syncIntervalHours || 24).toString());
  const [locationId, setLocationId] = useState(settings?.locationId || (locations[0]?.value ?? ""));
  const [isActive, setIsActive] = useState(settings?.isActive || false);
  const [isEditingServiceAccount, setIsEditingServiceAccount] = useState(!settings?.googleServiceAccount);

  const [activeRun, setActiveRun] = useState<any>(syncRuns[0] || null);

  useEffect(() => {
      // Setup polling for the active sync run progress
      let interval = setInterval(async () => {
           try {
               const res = await fetch('/app/api/syncRun');
               const data = await res.json();
               if (data.latestRun) {
                   setActiveRun(data.latestRun);
               }
           } catch (e) {
               // ignore errors in polling
           }
      }, 3000);
      return () => clearInterval(interval);
  }, []);

  // After a successful settings save, collapse the service-account editor
  // back to the masked view so the secret JSON isn't left on screen.
  useEffect(() => {
    if (actionData?.success && serviceJson) {
      setIsEditingServiceAccount(false);
    }
  }, [actionData]);

  const handleSyncNow = () => {
    const formData = new FormData();
    formData.append("intent", "syncNow");
    submit(formData, { method: "post" });
  };

  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleDownloadCsv = async (id: string) => {
    try {
      setDownloadingId(id);
      const response = await fetch(`/app/api/syncReport/${id}`);
      if (!response.ok) throw new Error("Failed to download report");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = `sync_report_${id}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
    } finally {
      setDownloadingId(null);
    }
  };

  const rowMarkup = syncRuns.map(
      ({ id, type, status, startedAt, processedItems }: any, index: number) => (
          <IndexTable.Row id={id} key={id} position={index}>
             <IndexTable.Cell>{new Date(startedAt).toLocaleString()}</IndexTable.Cell>
             <IndexTable.Cell>{type}</IndexTable.Cell>
             <IndexTable.Cell>
                 <Badge tone={status === "COMPLETED" ? "success" : status === "ERROR" ? "critical" : "info"}>
                     {status}
                 </Badge>
             </IndexTable.Cell>
             <IndexTable.Cell>{processedItems}</IndexTable.Cell>
             <IndexTable.Cell>
                 {(status === "COMPLETED" || status === "ERROR") && (
                     <Button 
                        size="micro" 
                        loading={downloadingId === id} 
                        onClick={() => handleDownloadCsv(id)}
                     >
                         Download CSV
                     </Button>
                 )}
             </IndexTable.Cell>
          </IndexTable.Row>
      )
  );

  return (
    <Page title="Settings">
      <BlockStack gap="500">
        <InlineStack gap="300" blockAlign="center">
          <img
            src="/logo.png"
            alt="Burrows Jewellers"
            width={48}
            height={48}
            style={{ display: "block" }}
          />
          <Text as="h1" variant="headingLg">Burrows Jewellers</Text>
        </InlineStack>
        <Layout>
          <Layout.Section>
            {actionData?.message && (
              <Box paddingBlockEnd="400">
                <Banner tone={actionData.success ? "success" : "critical"}>
                  <p>{actionData.message}</p>
                </Banner>
              </Box>
            )}
            
            <Card>
              <Form method="post">
                <input type="hidden" name="intent" value="saveSettings" />
                <input type="hidden" name="isActive" value={isActive ? "true" : "false"} />
                <BlockStack gap="400">
                  <TextField
                    label="Google Sheet ID"
                    name="googleSheetId"
                    value={sheetId}
                    onChange={setSheetId}
                    autoComplete="off"
                    helpText="The long ID in your Google Sheet URL (after /d/ and before /edit)"
                  />

                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Google Service Account JSON</Text>
                    {serviceJson && !isEditingServiceAccount ? (
                      <BlockStack gap="200" align="start">
                        <Banner tone="success">Service Account JSON is securely configured.</Banner>
                        <Button onClick={() => setIsEditingServiceAccount(true)}>Edit Service Account JSON</Button>
                        <input type="hidden" name="googleServiceAccount" value={serviceJson} />
                      </BlockStack>
                    ) : (
                      <BlockStack gap="200" align="start">
                        <TextField
                          label="JSON Content"
                          labelHidden
                          name="googleServiceAccount"
                          value={serviceJson}
                          onChange={setServiceJson}
                          multiline={6}
                          autoComplete="off"
                          helpText="Paste the entire contents of the JSON file you downloaded."
                        />
                        {serviceJson && (
                          <Button onClick={() => setIsEditingServiceAccount(false)}>Cancel Edit</Button>
                        )}
                      </BlockStack>
                    )}
                  </BlockStack>
                  
                  <Select
                    label="Target Inventory Location"
                    name="locationId"
                    options={locations}
                    value={locationId}
                    onChange={setLocationId}
                    helpText="Select the Shopify location where inventory levels will be applied"
                  />

                  <Select
                    label="Sync Frequency"
                    name="syncIntervalHours"
                    options={[
                      { label: "Every 1 Hour", value: "1" },
                      { label: "Every 6 Hours", value: "6" },
                      { label: "Every 12 Hours", value: "12" },
                      { label: "Daily (24 hours)", value: "24" },
                    ]}
                    value={intervalOption}
                    onChange={setIntervalOption}
                  />

                  <Checkbox
                    label="Enable Automatic Sync"
                    checked={isActive}
                    onChange={setIsActive}
                  />

                  <Button submit variant="primary" loading={isSaving}>
                    Save Settings
                  </Button>
                </BlockStack>
              </Form>
            </Card>

            <Box paddingBlockStart="500">
                <Card padding="0">
                  <Box padding="400">
                      <Text as="h2" variant="headingMd">Sync History</Text>
                  </Box>
                  <IndexTable
                      resourceName={{ singular: 'run', plural: 'runs' }}
                      itemCount={syncRuns.length}
                      headings={[
                          { title: 'Date' },
                          { title: 'Type' },
                          { title: 'Status' },
                          { title: 'Items Processed' },
                          { title: 'Actions' },
                      ]}
                      selectable={false}
                  >
                      {rowMarkup}
                  </IndexTable>
                </Card>
            </Box>

          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
                <Card>
                <BlockStack gap="400">
                    <Button onClick={handleSyncNow} loading={isSyncing} fullWidth>
                    Force Sync Now
                    </Button>
                    {settings?.lastSyncTime && (
                    <p style={{ marginTop: '1rem', color: 'gray' }}>
                        Last Sync: {new Date(settings.lastSyncTime).toLocaleString()}
                    </p>
                    )}
                </BlockStack>
                </Card>

                {activeRun && activeRun.status === "IN_PROGRESS" && (
                    <Card>
                        <BlockStack gap="400">
                            <Text as="h3" variant="headingMd">Sync in Progress</Text>
                            <ProgressBar progress={(activeRun.processedItems / Math.max(activeRun.totalItems, 1)) * 100} />
                            <Text as="p" tone="subdued">Processed {activeRun.processedItems} of {activeRun.totalItems} items...</Text>
                        </BlockStack>
                    </Card>
                )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
