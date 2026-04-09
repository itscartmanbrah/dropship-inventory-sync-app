import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  List,
  CalloutCard,
} from "@shopify/polaris";

export default function Guide() {
  return (
    <Page title="How to Use Inventory Sync">
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  Welcome to Dropship Inventory Sync!
                </Text>
                <Text as="p">
                  This app will keep your target Shopify location (selected in the settings) completely synced with the "Variant Inventory Qty" from your Drop Shipper's Google Sheet, matched by "Barcode".
                </Text>
              </BlockStack>
            </Card>

            <div style={{ marginTop: '1rem' }}>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    Step 1: Get the Google Sheet ID
                  </Text>
                  <Text as="p">
                    The source of truth for the inventory levels is your Google Sheet. Look at the URL of the Google Sheet your Drop Shipper shared with you.
                  </Text>
                  <List type="number">
                    <List.Item>
                      Open your Google Sheet. It should have a column exactly named <strong>Barcode</strong> and another exactly named <strong>Variant Inventory Qty</strong>.
                    </List.Item>
                    <List.Item>
                      Look at the URL in your browser: <code>https://docs.google.com/spreadsheets/d/<u>1BxiMVs0X_xyzqwerty</u>/edit</code>
                    </List.Item>
                    <List.Item>
                      Copy the long string highlighted above. That is your <strong>Google Sheet ID</strong>. Paste it into the Settings page.
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>
            </div>

            <div style={{ marginTop: '1rem' }}>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    Step 2: Add Google Service Account JSON
                  </Text>
                  <Text as="p">
                    For the app to securely read the Sheet, it needs a "Service Account".
                  </Text>
                  <List type="number">
                    <List.Item>Go to the Google Cloud Console and create a Service Account.</List.Item>
                    <List.Item>Under "Keys", generate a new JSON key.</List.Item>
                    <List.Item>Open the downloaded <code>.json</code> file in a text editor like Notepad, copy the entire contents, and paste it into the Settings page field.</List.Item>
                    <List.Item><strong>Crucial:</strong> Copy the "client_email" from that JSON file, and share your Google Sheet with that exact email address (give it Viewer permissions).</List.Item>
                  </List>
                </BlockStack>
              </Card>
            </div>

            <div style={{ marginTop: '1rem' }}>
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">
                    Step 3: Setup Sync Frequency
                  </Text>
                  <Text as="p">
                    Decide how frequently the app should check the Google Sheet for updates.
                  </Text>
                  <List type="bullet">
                    <List.Item>It's generally safe to run it every 1 Hour or 6 Hours depending on how often your Drop Shipper updates their inventory.</List.Item>
                    <List.Item>Turn ON "Enable Automatic Sync" to let the app do the work silently in the background.</List.Item>
                    <List.Item>If you want an immediate update, you can always click the <strong>Force Sync Now</strong> button on the Settings page.</List.Item>
                  </List>
                </BlockStack>
              </Card>
            </div>

          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
