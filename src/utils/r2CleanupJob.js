// src/utils/r2CleanupJob.js

import cron from 'node-cron';
import logger from '../logging/logger.js';
import { listObjectsV2, deleteObject } from './r2Storage.js';

// Configuration: Cleanup files older than 2 years (730 days)
const MAX_FILE_AGE_DAYS = 730;

/**
 * Converts ISO timestamp to number of days difference from today.
 * @param {string} isoDate - ISO date string.
 * @returns {number} - Age in days.
 */
function getFileAgeInDays(isoDate) {
  const fileDate = new Date(isoDate);
  const now = new Date();
  const diffTime = Math.abs(now - fileDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Executes the R2 cleanup job.
 */
export async function executeCleanup() {
  logger.info('🔄 Starting R2 cleanup job...');

  try {
    let continuationToken = undefined;
    let totalFilesChecked = 0;
    let totalFilesDeleted = 0;

    do {
      const pageResult = await listObjectsV2(continuationToken);
      const files = pageResult.Contents || [];

      if (files.length === 0 && !continuationToken) {
        logger.info('No files found in R2 bucket.');
        return;
      }

      for (const file of files) {
        totalFilesChecked++;
        const ageDays = getFileAgeInDays(file.LastModified);

        if (ageDays > MAX_FILE_AGE_DAYS) {
          try {
            await deleteObject(file.Key);
            totalFilesDeleted++;
            logger.info(`🗑️ Deleted ${file.Key} (Age: ${ageDays} days)`);
          } catch (deleteErr) {
            logger.error(`❌ Failed to delete ${file.Key}: ${deleteErr}`);
          }
        }
      }

      continuationToken = pageResult.NextContinuationToken;
    } while (continuationToken);

    logger.info(
      `✅ R2 cleanup completed. Checked: ${totalFilesChecked}, Deleted: ${totalFilesDeleted}`
    );
  } catch (err) {
    logger.error('❌ R2 cleanup job failed:', err);
  }
}

/**
 * Schedules the R2 cleanup job to run monthly.
 */
export function scheduleCleanupJob() {
  cron.schedule('0 3 1 * *', () => {
    executeCleanup();
  });
  logger.info('⏰ R2 Cleanup job scheduled to run monthly on the 1st at 03:00 AM.');
}
