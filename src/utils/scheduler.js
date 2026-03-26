// src/utils/scheduler.js

import cron from 'node-cron';
import path from 'path';
import backupDb from '../../admin/backup-db.js';
import { cleanupOldBackups as cleanupBackups } from '../../admin/cleanup-backups.js';
import purgeArchives from '../../admin/purge-archives.js';
import logger from '../logging/logger.js';
import purgeLogs from '../scripts/cleanup-logs.js';

// R2 Maintenance Jobs
import { scheduleArchiveMigrationJob } from './archiveMigrationJob.js';

// Notifications
import { sendAppointmentReminders } from './notifications/appointmentReminderJob.js';
import { sendInvestigationNotifications } from './notifications/InvestigationNotificationJob.js';
import { scheduleCleanupJob as scheduleR2CleanupJob, executeCleanup } from './r2CleanupJob.js';
import { purgeHousekeepingPhotos } from './housekeepingPurgeJob.js';
import loadSwaggerDocument from './swaggerLoader.js';
import { verifyLatestBackup } from './backupVerification.js';

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
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');
  } catch (err) {
    logger.error('Swagger validation failed:', err.message || err);
  }
});

// 🗓️ Daily at 02:00 - Backup database + verification
cron.schedule('0 2 * * *', () => {
  logger.info('Scheduled Task: Backing up database...');
  try {
    backupDb('.env', 'local');
    // After a small delay, verify the latest backup
    setTimeout(() => verifyLatestBackup(), 30000);
  } catch (err) {
    logger.error('Error during backupDb task:', err);
  }
});

// 🗓️ Monthly on 1st at 02:00 - Archive migration
scheduleArchiveMigrationJob();

// 🗓️ Daily at 03:00 - R2 Cleanup
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

// 🗓️ Weekly on Sunday at 04:00 - Cleanup old backups
cron.schedule('0 4 * * 0', () => {
  logger.info('Scheduled Task: Cleaning up old backups...');
  try {
    cleanupBackups(path.resolve('backups', 'local'));
    cleanupBackups(path.resolve('backups', 'render'));
  } catch (err) {
    logger.error('Error during cleanupBackups task:', err);
  }
});

// 🕗 Daily at 08:00 - Send appointment reminders
cron.schedule('0 8 * * *', async () => {
  logger.info('Scheduled Task: Sending appointment reminders...');
  try {
    await sendAppointmentReminders();
  } catch (err) {
    logger.error('Error sending appointment reminders:', err);
  }
});

// 🗓️ Daily at 09:00 - Send in-app investigation report notifications
cron.schedule('0 9 * * *', async () => {
  logger.info('Scheduled Task: Sending investigation report notifications...');
  try {
    await sendInvestigationNotifications();
  } catch (err) {
    logger.error('Error sending investigation notifications:', err);
  }
});

// 🗓️ Daily at 03:30 - Purge audit logs older than 90 days
cron.schedule('30 3 * * *', async () => {
  logger.info('Scheduled Task: Purging audit logs older than 90 days...');
  try {
    const { default: db } = await import('../config/database.js');
    const result = await db.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    logger.info(`✅ Audit log cleanup: ${result.rowCount} rows deleted`);
  } catch (err) {
    logger.error('Error during audit log cleanup:', err);
  }
});

// 🗓️ Daily at 03:45 - Purge housekeeping photos past retention window
cron.schedule('45 3 * * *', async () => {
  try {
    await purgeHousekeepingPhotos();
  } catch (err) {
    logger.error('Error during housekeeping photo purge:', err);
  }
});

// ✅ Manual Trigger for all tasks
export async function runAllScheduledTasksNow() {
  logger.info('Running all scheduled tasks manually...');
  try {
    purgeLogs();
    purgeArchives();

    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {throw new Error('Swagger document not loaded');}
    logger.info('✅ Swagger documentation validated.');

    backupDb('.env', 'local');
    await executeCleanup();

    cleanupBackups(path.resolve('backups', 'local'));
    cleanupBackups(path.resolve('backups', 'render'));

    await sendAppointmentReminders();
    await sendInvestigationNotifications();

    logger.info('✅ All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}
