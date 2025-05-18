const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const dotenv = require('dotenv');

function compressFile(filePath) {
  const gzip = zlib.createGzip();
  const source = fs.createReadStream(filePath);
  const destination = fs.createWriteStream(`${filePath}.gz`);

  source.pipe(gzip).pipe(destination).on('finish', () => {
    console.log(`🗜️  Compressed to ${filePath}.gz`);
    fs.unlinkSync(filePath); // Optional: Remove uncompressed .sql
  });
}

function backupDatabase(envFile, label) {
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
    execSync(`pg_dump "${dbUrl}" > "${backupFile}"`, { stdio: 'inherit' });
    console.log(`✅ ${label} backup completed: ${backupFile}`);
    compressFile(backupFile); // Compress after success
  } catch (err) {
    console.error(`❌ ${label} backup failed: ${err.message}`);
  }
}

// Backup local and render databases
backupDatabase('.env.local', 'local');
backupDatabase('.env.render', 'render');
