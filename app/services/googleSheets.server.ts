import { google } from 'googleapis';

export async function fetchSheetData(sheetId: string, serviceAccountJson: string) {
  try {
    const credentials = JSON.parse(serviceAccountJson);
    
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A:Z', // Assuming data is on the first sheet and we get all columns
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return [];
    }

    // First row is headers
    // Columns: Title, Vendor, Variant SKU, Variant Barcode, Variant Inventory Quantity, Variant Cost, RRP
    const headers = rows[0] as string[];
    
    const data = rows.slice(1).map((row) => {
      const item: Record<string, string> = {};
      headers.forEach((header, index) => {
        item[header] = row[index] || '';
      });
      return item;
    });

    return data;
  } catch (error: any) {
    console.error("Error reading Google Sheet:", error);
    throw new Error('Google Sheet Error: ' + error.message);
  }
}
