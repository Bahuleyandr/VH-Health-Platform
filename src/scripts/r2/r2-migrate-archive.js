// src/scripts/r2-migrate-archive.js

import {
  listObjectsV2,
  copyObject,
  deleteObject,
} from '../../utils/r2Storage.js';
import logger from '../../logging/logger.js';

const TWO_YEARS_DAYS = 730;
const FIVE_YEARS_DAYS = 1825;
const SEVEN_YEARS_DAYS = 2555;

function getFileAgeInDays(isoDate) {
  const fileDate = new Date(isoDate);
  const now = new Date();
  const diffTime = Math.abs(now - fileDate);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

async function migrateFile(key, targetFolder) {
  const targetKey = `${targetFolder}/${key}`;
  await copyObject(key, targetKey);
  await deleteObject(key);
  logger.info(`🔄 Migrated ${key} to ${targetFolder}/`);
}

async function migrateR2Storage() {
  logger.info('🚀 Starting R2 Archive Migration Job...');
  const filesPage = await listObjectsV2();

  const files = filesPage.Contents || [];
  if (files.length === 0) {
    logger.info('No files found in R2 bucket.');
    return;
  }

  for (const file of files) {
    const ageDays = getFileAgeInDays(file.LastModified);

    if (ageDays > SEVEN_YEARS_DAYS) {
      await deleteObject(file.Key);
      logger.info(`🗑️ Deleted ${file.Key} (Age: ${ageDays} days)`);
    } else if (
      ageDays > FIVE_YEARS_DAYS &&
      !file.Key.startsWith('deep-archive/')
    ) {
      await migrateFile(file.Key, 'deep-archive');
    } else if (ageDays > TWO_YEARS_DAYS && !file.Key.startsWith('archive/')) {
      await migrateFile(file.Key, 'archive');
    }
  }

  logger.info('✅ R2 Archive Migration Job Completed.');
}

migrateR2Storage().catch((err) => {
  logger.error('❌ Migration failed:', err);
  process.exit(1);
});
