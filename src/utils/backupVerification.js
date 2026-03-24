// src/utils/backupVerification.js

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import logger from '../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Verify the latest backup file in the given backup folder.
 * Checks: file exists, size > 0, valid SQL content, table count.
 */
export async function verifyLatestBackup(label = 'local') {
  const backupFolder = path.resolve(__dirname, '../../backups', label);

  if (!fs.existsSync(backupFolder)) {
    logger.error(`Backup verification failed: folder not found — ${backupFolder}`);
    return false;
  }

  // Find the latest .sql.gz file
  const files = fs.readdirSync(backupFolder)
    .filter(f => f.endsWith('.sql.gz'))
    .sort()
    .reverse();

  if (files.length === 0) {
    logger.error('Backup verification failed: no .sql.gz files found');
    return false;
  }

  const latestFile = path.join(backupFolder, files[0]);
  const stats = fs.statSync(latestFile);

  // Check file size
  if (stats.size === 0) {
    logger.error(`Backup verification failed: ${files[0]} is empty (0 bytes)`);
    return false;
  }

  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

  try {
    // Decompress and validate content
    const compressed = fs.readFileSync(latestFile);
    const decompressed = zlib.gunzipSync(compressed).toString('utf-8');

    // Check for valid SQL header
    const trimmed = decompressed.trimStart();
    const hasValidHeader = trimmed.startsWith('--') || trimmed.startsWith('SET');

    if (!hasValidHeader) {
      logger.error(`Backup verification failed: ${files[0]} does not contain valid SQL header`);
      return false;
    }

    // Count tables
    const tableMatches = decompressed.match(/CREATE TABLE/gi);
    const tableCount = tableMatches ? tableMatches.length : 0;

    logger.info(`Backup verified: ${tableCount} tables, ${sizeMB} MB — ${files[0]}`);
    return true;
  } catch (err) {
    logger.error(`Backup verification failed: could not decompress ${files[0]} — ${err.message}`);
    return false;
  }
}
