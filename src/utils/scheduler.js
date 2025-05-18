// src/utils/scheduler.js

const cron = require('node-cron');
const logger = require('../logging/logger');

// Importing tasks
const purgeLogs = require('../scripts/cleanup-logs.js');
const purgeArchives = require('../../admin/purge-archives.js');
const backupDb = require('../../admin/backup-db.js');
const { scheduleR2CleanupJob, executeCleanup } = require('./r2CleanupJob');
const cleanupBackups = require('../../admin/cleanup-backups.js');

// 🗓️ Every Sunday at 00:00 - Purge old logs
cron.schedule('0 0 * * 0', () => {
  logger.info('Scheduled Task: Purging old logs...');
  try {
    purgeLogs();
  } catch (err) {
    logger.error('Error during purgeLogs task:', err);
  }
});

// 🗓️ Every Sunday at 03:00 - Purge archived .gz logs older than 14 days
cron.schedule('0 3 * * 0', () => {
  logger.info('Scheduled Task: Purging archived log files...');
  try {
    purgeArchives();
  } catch (err) {
    logger.error('Error during purgeArchives task:', err);
  }
});

// 🗓️ Every day at 00:00 - Validate Swagger
cron.schedule('0 0 * * *', () => {
  logger.info('Scheduled Task: Validating Swagger...');
  const loadSwaggerDocument = require('./swaggerLoader');

try {
  const swaggerDocument = loadSwaggerDocument();
  if (!swaggerDocument) {
    throw new Error('Swagger validation failed: Document could not be loaded.');
  }
  logger.info('✅ Swagger documentation validated and loaded.');
} catch (err) {
  logger.error('Error during Swagger validation task:', err.message || err);
}

});

// 🗓️ Every day at 02:00 - Backup database
cron.schedule('0 2 * * *', () => {
  logger.info('Scheduled Task: Backing up database...');
  try {
    backupDb();
  } catch (err) {
    logger.error('Error during backupDb task:', err);
  }
});

// Import Archive Migration Job
const { scheduleArchiveMigrationJob } = require('./archiveMigrationJob');

// 🗓️ Schedule Archive Migration Monthly on the 1st at 02:00 AM
scheduleArchiveMigrationJob();

// 🗓️ Every day at 03:00 - R2 Cleanup
scheduleR2CleanupJob();

// 🗓️ Every Sunday at 04:00 - Cleanup Old Backups
cron.schedule('0 4 * * 0', () => {
  logger.info('Scheduled Task: Cleaning up old backups...');
  try {
    cleanupBackups();
  } catch (err) {
    logger.error('Error during backup cleanup task:', err);
  }
});

// ✅ Manual Trigger Function (Optional)
async function runAllScheduledTasksNow() {
  logger.info('Running all scheduled tasks manually...');
  try {
    purgeLogs();
    purgeArchives();

    // ✅ Swagger Validation
    const loadSwaggerDocument = require('./swaggerLoader');
    const swaggerDocument = loadSwaggerDocument();
    if (!swaggerDocument) {
      throw new Error('Swagger validation failed: Document could not be loaded.');
    }
    logger.info('✅ Swagger documentation validated and loaded.');

    backupDb();
    await executeCleanup();
    logger.info('All manual tasks completed.');
  } catch (err) {
    logger.error('Error running manual tasks:', err.message || err);
  }
}

// Export manual runner if needed elsewhere
module.exports = { runAllScheduledTasksNow };
