import cron from 'node-cron';
import prisma from '../db.server';
import { runSyncForShop } from './syncLogic.server';

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
}
