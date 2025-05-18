// src/utils/archiveMigrationJob.js

const cron = require('node-cron');
const { spawn } = require('child_process');
const logger = require('../logging/logger');

/**
 * Runs the archive migration script as a child process.
 */
function executeArchiveMigration() {
  logger.info('🚀 Starting Archive Migration...');
  const process = spawn('node', ['src/scripts/r2-migrate-archive.js']);

  process.stdout.on('data', (data) => logger.info(`[ArchiveMigration]: ${data.toString().trim()}`));
  process.stderr.on('data', (data) => logger.error(`[ArchiveMigration Error]: ${data.toString().trim()}`));

  process.on('close', (code) => {
    if (code === 0) {
      logger.info('✅ Archive Migration completed successfully.');
    } else {
      logger.error(`❌ Archive Migration exited with code ${code}`);
    }
  });
}

/**
 * Schedule Archive Migration to run monthly on the 1st at 02:00 AM.
 */
function scheduleArchiveMigrationJob() {
  cron.schedule('0 2 1 * *', () => {
    executeArchiveMigration();
  });
  logger.info('⏰ Archive Migration job scheduled to run monthly on the 1st at 02:00 AM.');
}

module.exports = {
  scheduleArchiveMigrationJob,
  executeArchiveMigration,
};
