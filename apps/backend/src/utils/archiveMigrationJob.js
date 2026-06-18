// src/utils/archiveMigrationJob.js

import { spawn } from 'child_process';
import logger from '../logging/logger.js';

/**
 * Runs the archive migration script as a child process. Returns a promise that
 * resolves when the child exits, so callers (the scheduler's withJobLock
 * wrapper) hold the cross-process advisory lock for the FULL duration of the
 * migration rather than releasing it the instant the child is spawned.
 */
export function executeArchiveMigration() {
  logger.info('🚀 Starting Archive Migration...');
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/scripts/r2-migrate-archive.js']);

    child.stdout.on('data', data => logger.info(`[ArchiveMigration]: ${data.toString().trim()}`));
    child.stderr.on('data', data =>
      logger.error(`[ArchiveMigration Error]: ${data.toString().trim()}`)
    );

    child.on('error', err => {
      logger.error(`❌ Archive Migration failed to spawn: ${err.message}`);
      reject(err);
    });

    child.on('close', code => {
      if (code === 0) {
        logger.info('✅ Archive Migration completed successfully.');
        resolve(code);
      } else {
        logger.error(`❌ Archive Migration exited with code ${code}`);
        reject(new Error(`Archive migration exited with code ${code}`));
      }
    });
  });
}

/**
 * @deprecated Registration moved into src/utils/scheduler.js so the job runs
 * under withJobLock() (in-process Set + cross-replica Postgres advisory lock),
 * matching every other cron. Kept as a no-op shim only so any stray caller does
 * not double-register a bare, unlocked cron. The scheduler is the single
 * registration site — see the `archive-migration` registerCron there.
 */
export function scheduleArchiveMigrationJob() {
  logger.warn(
    'scheduleArchiveMigrationJob() is a deprecated no-op — the archive job is now ' +
    'registered under withJobLock() in scheduler.js. Ignoring this call.',
  );
}
