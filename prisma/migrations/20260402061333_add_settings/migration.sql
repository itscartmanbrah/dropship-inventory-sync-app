-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "googleSheetId" TEXT,
    "googleServiceAccount" TEXT,
    "syncIntervalHours" INTEGER DEFAULT 24,
    "lastSyncTime" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "Settings_shop_key" ON "Settings"("shop");
