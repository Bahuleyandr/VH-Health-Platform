// src/utils/scheduler.js

import cron from 'node-cron';
import path from 'path';
import logger from '../logging/logger.js';
import purgeLogs from '../scripts/cleanup-logs.js';
import purgeArchives from '../../admin/purge-archives.js';
import backupDb from '../../admin/backup-db.js';
import { cleanupOldBackups as cleanupBackups } from '../../admin/cleanup-backups.js';
import loadSwaggerDocument from './swaggerLoader.js';

// R2 Maintenance Jobs
import {
  scheduleCleanupJob as scheduleR2CleanupJob,
  executeCleanup,
} from './r2CleanupJob.js';
import { scheduleArchiveMigrationJob } from './archiveMigrationJob.js';

// 🗓️ Daily at 00:00 - Purge old logs
cron.schedule('0 0 * * *', () => {
  logger.info('Scheduled Task: Purging old logs...');
  try {
    purgeLogs();
  } catch (err) {
    logger.error('Error during purgeLogs task:', err);
  }
});

// 🗓️ Daily at 00:00 - Swagger validation
cron.schedule('0 0 * * *', () => {
  logger.info('Scheduled Task: Validating Swagger...');
  try {
    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) throw new Error('Swagger document not loaded');
    logger.info('✅ Swagger documentation validated.');
  } catch (err) {
    logger.error('Swagger validation failed:', err.message || err);
  }
});

// 🗓️ Daily at 02:00 - Backup database
cron.schedule('0 2 * * *', () => {
  logger.info('Scheduled Task: Backing up database...');
  try {
    backupDb();
  } catch (err) {
    logger.error('Error during backupDb task:', err);
  }
});

// 🗓️ Monthly archive migration on the 1st at 02:00
scheduleArchiveMigrationJob();

// 🗓️ Daily at 03:00 - Perform R2 cleanup (via integrated logic)
scheduleR2CleanupJob();

// 🗓️ Weekly on Sunday at 03:00 - Purge archived logs
cron.schedule('0 3 * * 0', () => {
  logger.info('Scheduled Task: Purging .gz archived logs...');
  try {
    purgeArchives();
  } catch (err) {
    logger.error('Error during purgeArchives task:', err);
  }
});

// 🗓️ Weekly on Sunday at 04:00 - Clean old backup folders
cron.schedule('0 4 * * 0', () => {
  logger.info('Scheduled Task: Cleaning up old backups...');
  try {
    cleanupBackups(path.resolve('backups', 'local'));
    cleanupBackups(path.resolve('backups', 'render'));
  } catch (err) {
    logger.error('Error during cleanupBackups task:', err);
  }
});

// ✅ Manual Trigger
export async function runAllScheduledTasksNow() {
  logger.info('Running all scheduled tasks manually...');
  try {
    purgeLogs();
    purgeArchives();

    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) throw new Error('Swagger document not loaded');
    logger.info('✅ Swagger documentation validated.');

    backupDb();
    await executeCleanup();

    cleanupBackups(path.resolve('backups', 'local'));
    cleanupBackups(path.resolve('backups', 'render'));

    logger.info('✅ All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}
