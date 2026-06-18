// src/utils/r2CleanupJob.js

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
 * @deprecated Registration moved into src/utils/scheduler.js so the job runs
 * under withJobLock() (in-process Set + cross-replica Postgres advisory lock),
 * matching every other cron. Without the lock, every worker×replica (up to 6
 * processes) ran a concurrent R2 sweep, racing deletes against the same bucket.
 * Kept as a no-op shim so any stray caller does not double-register a bare,
 * unlocked cron. The scheduler is the single registration site — see the
 * `r2-cleanup` registerCron there.
 */
export function scheduleCleanupJob() {
  logger.warn(
    'scheduleCleanupJob() is a deprecated no-op — the R2 cleanup job is now ' +
    'registered under withJobLock() in scheduler.js. Ignoring this call.',
  );
}
