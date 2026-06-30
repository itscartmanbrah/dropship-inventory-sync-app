import cron from 'node-cron';
import prisma from '../db.server';
import { runSyncForShop, runPriceSyncForShop } from './syncLogic.server';

// Keep track if we already started the scheduler to avoid double-starting in dev mode
let started = false;

export function startScheduler() {
  if (started) return;
  started = true;
  
  console.log("Starting background cron scheduler...");

  // Run at the top of every hour
  cron.schedule('0 * * * *', async () => {
    console.log("Running scheduled sync check...");
    
    try {
      // Find all active settings
      const allActiveSettings = await prisma.settings.findMany({
        where: { isActive: true }
      });

      for (const settings of allActiveSettings) {
        // Check if enough time has passed based on syncIntervalHours
        const lastSync = settings.lastSyncTime;
        const intervalHours = settings.syncIntervalHours || 24;
        
        let shouldSync = false;
        
        if (!lastSync) {
          shouldSync = true;
        } else {
          const hoursSinceLastSync = (new Date().getTime() - new Date(lastSync).getTime()) / (1000 * 60 * 60);
          if (hoursSinceLastSync >= intervalHours) {
            shouldSync = true;
          }
        }

        if (shouldSync) {
          try {
            await runSyncForShop(settings.shop, "AUTO");
          } catch (e) {
            console.error(`Failed scheduled sync for shop ${settings.shop}`, e);
          }
        }
      }
    } catch (err) {
      console.error("Error in cron scheduler:", err);
    }
  });

  // Price sync: every 15 minutes, re-apply the Google Sheet RRP for shops that
  // have price sync enabled. Kept separate from the (heavier) inventory sync so
  // it can run frequently and quickly correct prices overwritten by Retail Edge.
  cron.schedule('*/15 * * * *', async () => {
    console.log("Running scheduled PRICE sync check...");

    try {
      const shops = await prisma.settings.findMany({
        where: { priceSyncEnabled: true }
      });

      for (const settings of shops) {
        try {
          await runPriceSyncForShop(settings.shop, "PRICE_AUTO");
        } catch (e) {
          console.error(`Failed scheduled price sync for shop ${settings.shop}`, e);
        }
      }
    } catch (err) {
      console.error("Error in price cron scheduler:", err);
    }
  });
}
