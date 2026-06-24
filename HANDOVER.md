# Project Handover Guide: Dropship Inventory Sync App

This document provides a comprehensive overview of the **Dropship Inventory Sync App** to facilitate a smooth developer transition (e.g., to Claude).

---

## 1. Project Purpose & Core Value
The app is a custom **Shopify Embedded App** designed for Shopify merchants who dropship. It automatically synchronizes inventory levels from a vendor's Google Sheet into a designated inventory location in the merchant's Shopify store. 

### Key Features:
* **Google Sheets Integration**: Authenticates securely via a Google Service Account JSON key to parse the vendor's inventory.
* **Barcode Mapping**: Matches variants between the Google Sheet and Shopify using the `Barcode` field.
* **Automatic Activation**: Automatically activates variant inventory at the target Shopify location if they aren't already active there.
* **Automated & Manual Sync**: Supports manual trigger ("Force Sync Now") and background cron scheduling (hourly checks against configured sync intervals).
* **Tagging**: Tags updated products with `Dropship Inventory Updated`.
* **Zero-Inventory Archiving**: If the total projected inventory across all locations for a product drops to zero or below, the app automatically archives the product.
* **Detailed Reports**: Generates download-ready CSV reports detailing inventory levels *Before* and *After* for every variant processed.

---

## 2. Tech Stack & Architecture

### Core Technologies
* **Framework**: [Remix](https://remix.run) (merged with React Router) configured with Vite (`vite.config.ts`).
* **Frontend Design System**: [Shopify Polaris v12](https://polaris.shopify.com/) for a native Shopify merchant interface experience.
* **ORM & Database**: [Prisma](https://www.prisma.io/) v6 connected to a local SQLite database (`dev.sqlite`).
* **Shopify integration**: Powered by the official `@shopify/shopify-app-remix` package.
* **OAuth Strategy**: Embedded App Auth strategy enabled by default.

### Key File Directory Structure
```
├── .github/workflows/
│   ├── close-waiting-for-response-issues.yml  # Daily stale issue auto-closer (uses github-script)
│   ├── remove-labels-on-activity.yml
│   └── ci.yml
├── app/
│   ├── services/
│   │   ├── googleSheets.server.ts   # Google Sheets API client configuration & fetching
│   │   ├── syncLogic.server.ts      # Core inventory synchronization algorithm
│   │   └── scheduler.server.ts     # node-cron background scheduling logic
│   ├── routes/
│   │   ├── _index/
│   │   ├── app._index.tsx           # Main Merchant Dashboard & Settings panel
│   │   ├── app.guide.tsx            # Instructions and configuration user guide
│   │   ├── app.api.syncRun.tsx      # Polling API for fetching running sync progress
│   │   └── app.api.syncReport.$id.tsx # CSV download API endpoint for sync reports
│   ├── db.server.ts                 # Database client setup & single-instance scheduler startup
│   ├── shopify.server.ts            # Shopify Remix App API configuration (scopes, API version, keys)
│   └── root.tsx
├── prisma/
│   └── schema.prisma                # Database schema (SQLite)
├── push-to-live.ps1                 # PowerShell script for building & deploying to DigitalOcean VPS
├── shopify.app.toml                 # Shopify application configuration (App name, scopes, URLs)
└── package.json
```

---

## 3. Database Schema

Managed via Prisma in [prisma/schema.prisma](file:///c:/Users/charl/Desktop/dropship-inventory-sync/prisma/schema.prisma):

* **`Session`**: Used by `@shopify/shopify-app-session-storage-prisma` to manage merchant sessions and access tokens.
* **`Settings`**: Holds configurations per store:
  * `googleSheetId` (Google Spreadsheet ID)
  * `googleServiceAccount` (Secret Service Account JSON)
  * `syncIntervalHours` (1, 6, 12, or 24 hours)
  * `isActive` (Enables automated cron synchronizer)
  * `locationId` (The target Shopify location ID for inventory updates)
  * `lastSyncTime` (Timestamp of the last completed run)
* **`SyncRun`**: Log record of runs:
  * `type` (`MANUAL` or `AUTO`)
  * `status` (`IN_PROGRESS`, `COMPLETED`, `ERROR`)
  * `totalItems` & `processedItems` (For UI progress tracking)
  * `errorMessage` (Logged on failure)
  * `reportData` (Holds the generated CSV log content as a text string)

---

## 4. Key Workflows & Algorithms

### The Synchronization Flow (`syncLogic.server.ts`)
1. **Initialization**: Creates a `SyncRun` record with status `IN_PROGRESS` and starts a CSV buffer.
2. **Sheet Fetching**: Calls `fetchSheetData` using the saved service account credentials. Standard columns expected are: `Barcode` (or `Variant Barcode`) and `Variant Inventory Qty` (or `Variant Inventory Quantity`).
3. **Variant Inventory Audit**: Iterates through store variants (retrieved in batches of 250 using Shopify's Admin GraphQL API) to map barcodes, query their quantities, and identify if they are active at the target `locationId`.
4. **Activation**: Activates inventory tracking at the target location for any variants in the Google Sheet that are not yet active there.
5. **Bulk Update**: Batches variant inventory set mutations (`inventorySetQuantities` Shopify GraphQL mutation) in chunks of 100. Restricts calls using a 2-second rate-limiting delay between chunks to safely stay under Shopify API bucket leak rates.
6. **Archiving**: Identifies products whose total projected stock across all locations has dropped to zero or below, and updates their Shopify status to `ARCHIVED`.
7. **Tagging**: Appends the tag `Dropship Inventory Updated` to all updated products.
8. **Finalizing**: Writes the CSV string representation into `SyncRun.reportData`, stores completion times, and sets state to `COMPLETED`.

### Background Cron Scheduler (`scheduler.server.ts`)
* Configured using `node-cron` to execute a check at `0 * * * *` (top of every hour).
* Iterates through active shops (`Settings.isActive === true`), computes hours since `lastSyncTime`, and fires `runSyncForShop` with type `AUTO` if the interval is exceeded.
* **Initialization**: The scheduler is imported and called inside [app/db.server.ts](file:///c:/Users/charl/Desktop/dropship-inventory-sync/app/db.server.ts), ensuring it starts exactly once when the database is loaded.

---

## 5. Hosting & Deployment

The app is currently deployed on a **DigitalOcean Virtual Private Server (VPS)** at IP `159.223.96.29`, mapped to the domain **`https://159-223-96-29.nip.io`**. 

### Automated Deployment (`push-to-live.ps1`)
To deploy, run the PowerShell script locally:
```powershell
.\push-to-live.ps1
```
The script performs the following actions:
1. Builds the production Remix assets locally (`npm run build`).
2. Bundles the codebase into a gzip archive (`app.tar.gz`), excluding `node_modules` and `.git`.
3. Securely copies (`scp`) the archive to the `/tmp` directory of the server using SSH key file `~/.ssh/id_do_new`.
4. Executes a command via `ssh` to:
   * Stop application processes running on the server under **PM2**.
   * Extract the fresh codebase into the `/app` path.
   * Clean install production dependencies (`npm ci --omit=dev`).
   * Generate updated Prisma clients (`npx prisma generate`) and push migrations/schema updates (`npx prisma db push`).
   * Start/Restart the process under PM2 (`pm2 restart dropship-sync`).

---

## 6. Recent Maintenance Work (June 2026)

1. **GitHub Workflow Security Fix**: 
   * **Issue**: The `.github/workflows/close-waiting-for-response-issues.yml` failed because it utilized `actions-cool/issues-helper`, which was compromised and deleted by GitHub.
   * **Fix**: Replaced the compromised third-party action with a secure, standard script using official `actions/github-script@v7` and declared explicit `issues: write` permissions.
2. **Robust Sync Updates**:
   * Wrapped the archiving loop inside `app/services/syncLogic.server.ts` in `try-catch` blocks.
   * Now, if one product update or archive fails due to a rate-limiting exception or standard API validation issue, the rest of the sync run continues smoothly instead of failing the entire process.
