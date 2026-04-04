// src/admin/backup-db.js

import { execSync } from 'child_process';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function compressFile(filePath) {
  const gzip = zlib.createGzip();
  const source = fs.createReadStream(filePath);
  const destination = fs.createWriteStream(`${filePath}.gz`);

  source.pipe(gzip).pipe(destination).on('finish', () => {
    console.log(`🗜️  Compressed to ${filePath}.gz`);
    fs.unlinkSync(filePath); // Optional: Remove uncompressed .sql
  });
}

export default function backupDb(envFile, label) {
  const envPath = path.resolve(__dirname, '..', envFile);
  if (!fs.existsSync(envPath)) {
    console.error(`❌ ${envFile} not found. Skipping ${label} backup.`);
    return;
  }

  dotenv.config({ path: envPath });
  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    console.error(`❌ DATABASE_URL not defined in ${envFile}. Skipping ${label} backup.`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFolder = path.join(__dirname, '..', 'backups', label);
  const backupFile = path.join(backupFolder, `backup-${timestamp}.sql`);

  if (!fs.existsSync(backupFolder)) {
    fs.mkdirSync(backupFolder, { recursive: true });
  }

  console.log(`🚀 Starting ${label} backup to ${backupFile}...`);
  try {
    // Check pg_dump is available before attempting
    try { execSync('which pg_dump', { stdio: 'pipe' }); } catch {
      console.warn(`⚠️  pg_dump not found on this system — skipping ${label} backup. Use Supabase dashboard or docs/DB-REBUILD-GUIDE.md for backups.`);
      return;
    }
    execSync(`pg_dump "${dbUrl}" > "${backupFile}"`, { stdio: 'inherit' });
    console.log(`✅ ${label} backup completed: ${backupFile}`);
    compressFile(backupFile);
  } catch (err) {
    console.error(`❌ Failed to backup ${label}:`, err.message);
  }
}

// Optional: if run directly as CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  backupDb('.env.local', 'local');
  backupDb('.env.render', 'render');
}
