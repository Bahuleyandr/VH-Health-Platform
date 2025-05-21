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

  console.log(`Scanning ${logsDir} for old .gz log files older than ${daysThreshold} days...`);

  fs.readdir(logsDir, (err, files) => {
    if (err) {
      console.error('Failed to read logs directory:', err);
      return;
    }

    const oldFiles = files.filter(file => file.endsWith('.gz'));
    let deletedCount = 0;

    oldFiles.forEach(file => {
      const filePath = path.join(logsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error(`Error accessing ${file}:`, err);
          return;
        }

        const fileAgeInDays = (now - stats.mtimeMs) / msInDay;
        if (fileAgeInDays > daysThreshold) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error(`Failed to delete ${file}:`, err);
            } else {
              console.log(`Deleted: ${file}`);
              deletedCount++;
            }
          });
        }
      });
    });

    if (oldFiles.length === 0) {
      console.log('No .gz archived logs found.');
    } else {
      console.log(`Deletion task completed. ${deletedCount} files scheduled for removal.`);
    }
  });
}