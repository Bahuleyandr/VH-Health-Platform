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
import { scheduleCleanupJob as scheduleR2CleanupJob, executeCleanup } from './r2CleanupJob.js';
import { scheduleArchiveMigrationJob } from './archiveMigrationJob.js';

// Notifications
import { sendAppointmentReminders } from './notifications/appointmentReminderJob.js';
// import { sendInvestigationNotifications } from './notifications/investigationNotificationJob.js'; // 🔕 Disabled for now

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

/*
// 🔕 Daily at 09:00 - Send in-app investigation report notifications (currently disabled)
// cron.schedule('0 9 * * *', async () => {
//   logger.info('Scheduled Task: Sending investigation report notifications...');
//   try {
//     await sendInvestigationNotifications();
//   } catch (err) {
//     logger.error('Error sending investigation notifications:', err);
//   }
// });
*/

// ✅ Manual Trigger for all tasks
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

    await sendAppointmentReminders();
    // await sendInvestigationNotifications(); // 🔕 Temporarily skipped

    logger.info('✅ All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}
