// src/scripts/restore-db.js

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function restoreDatabase(envFile, label) {
  const envPath = path.resolve(__dirname, '..', envFile);
  if (!fs.existsSync(envPath)) {
    console.error(`❌ ${envFile} not found. Skipping ${label} restore.`);
    return;
  }

  dotenv.config({ path: envPath });
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error(`❌ DATABASE_URL not defined in ${envFile}. Skipping ${label} restore.`);
    return;
  }

  const backupFolder = path.resolve(__dirname, '..', 'backups', label);
  const latestBackup = fs
    .readdirSync(backupFolder)
    .filter(file => file.endsWith('.sql.gz'))
    .sort()
    .pop();

  if (!latestBackup) {
    console.error(`❌ No backup file found for ${label}.`);
    return;
  }

  const backupPath = path.join(backupFolder, latestBackup);
  const tempSqlPath = backupPath.replace(/\.gz$/, '');

  // Unzip
  console.log(`🗜️  Unzipping ${backupPath}...`);
  const unzip = zlib.createGunzip();
  const input = fs.createReadStream(backupPath);
  const output = fs.createWriteStream(tempSqlPath);
  input.pipe(unzip).pipe(output).on('finish', () => {
    console.log(`🔁 Restoring ${label} DB from ${tempSqlPath}...`);
    try {
      execSync(`psql "${dbUrl}" -f "${tempSqlPath}"`, { stdio: 'inherit' });
      console.log(`✅ ${label} database restore complete.`);
    } catch (err) {
      console.error(`❌ Failed to restore ${label}:`, err.message);
    } finally {
      fs.unlinkSync(tempSqlPath); // Clean up .sql file
    }
  });
}

// Run both local and render restores
restoreDatabase('.env.local', 'local');
restoreDatabase('.env.render', 'render');
