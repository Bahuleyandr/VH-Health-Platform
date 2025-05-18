// src/scripts/cleanup-logs.js

const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../logs'); // Adjust path if your logs are elsewhere
const retentionDays = 90;

function deleteOldLogs() {
  fs.readdir(logsDir, (err, files) => {
    if (err) {
      console.error('Error reading logs directory:', err);
      return;
    }
    const now = Date.now();

    files.forEach(file => {
      const filePath = path.join(logsDir, file);

      // Only target files ending with .log or .gz (rotated/compressed logs)
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
          fs.unlink(filePath, err => {
            if (err) {
              console.error('Failed to delete log file:', filePath, err);
            } else {
              console.log('Deleted old log file:', filePath);
            }
          });
        }
      });
    });
  });
}

deleteOldLogs();
