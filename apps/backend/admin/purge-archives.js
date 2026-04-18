import logger from '../src/logging/logger.js';
// src/admin/purge-archives.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function purgeArchives() {
  const logsDir = path.join(__dirname, '../src/logs');
  const daysThreshold = 14;
  const now = Date.now();
  const msInDay = 24 * 60 * 60 * 1000;

  logger.info(`Scanning ${logsDir} for old .gz log files older than ${daysThreshold} days...`);

  fs.readdir(logsDir, (err, files) => {
    if (err) {
      logger.error('Failed to read logs directory:', err);
      return;
    }

    const oldFiles = files.filter(file => file.endsWith('.gz'));
    let deletedCount = 0;

    oldFiles.forEach(file => {
      const filePath = path.join(logsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          logger.error(`Error accessing ${file}:`, err);
          return;
        }

        const fileAgeInDays = (now - stats.mtimeMs) / msInDay;
        if (fileAgeInDays > daysThreshold) {
          fs.unlink(filePath, (err) => {
            if (err) {
              logger.error(`Failed to delete ${file}:`, err);
            } else {
              logger.info(`Deleted: ${file}`);
              deletedCount++;
            }
          });
        }
      });
    });

    if (oldFiles.length === 0) {
      logger.info('No .gz archived logs found.');
    } else {
      logger.info(`Deletion task completed. ${deletedCount} files scheduled for removal.`);
    }
  });
}