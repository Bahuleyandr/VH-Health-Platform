// src/scripts/cleanup-logs.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logsDir = path.join(__dirname, '../logs');
const retentionDays = 90;

/**
 * Deletes log and .gz files older than 90 days in logs directory.
 */
export default function cleanupLogs() {
  fs.readdir(logsDir, (err, files) => {
    if (err) {
      console.error('Error reading logs directory:', err);
      return;
    }

    const now = Date.now();

    files.forEach((file) => {
      const filePath = path.join(logsDir, file);

      if (!file.match(/\.(log|gz)$/)) {
        return;
      }

      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error('Error getting stats for file:', filePath, err);
          return;
        }

        const ageInDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
        if (ageInDays > retentionDays) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error('Failed to delete log file:', filePath, err);
            } else {
              console.log('🧹 Deleted old log file:', filePath);
            }
          });
        }
      });
    });
  });
}

// Optional CLI usage
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cleanupLogs();
}
