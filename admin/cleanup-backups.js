// src/admin/cleanup-backups.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKUP_ROOT = path.resolve(__dirname, '..', 'backups');
const RETENTION_DAYS = 90;
const MILLISECONDS_IN_A_DAY = 24 * 60 * 60 * 1000;

export function cleanupOldBackups(folderPath) {
  if (!fs.existsSync(folderPath)) {
    console.log(`Skipping missing folder: ${folderPath}`);
    return;
  }

  const files = fs.readdirSync(folderPath);
  const now = Date.now();
  let deletedCount = 0;

  files.forEach(file => {
    const filePath = path.join(folderPath, file);
    const stats = fs.statSync(filePath);
    const ageInDays = (now - stats.mtimeMs) / MILLISECONDS_IN_A_DAY;

    if (ageInDays > RETENTION_DAYS) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  Deleted: ${filePath}`);
      deletedCount++;
    }
  });

  console.log(`✅ Cleanup complete for ${folderPath}. Deleted ${deletedCount} old files.`);
}

// Clean both local and render backups
['local', 'render'].forEach(env => {
  const folderPath = path.join(BACKUP_ROOT, env);
  cleanupOldBackups(folderPath);
});
