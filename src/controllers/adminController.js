import { executeCleanup } from '../utils/r2CleanupJob.js';
import { listObjectsV2 } from '../utils/r2Storage.js';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger from '../logging/logger.js';

// ESM __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Utility to extract UID and IP
function getAdminAuditContext(req) {
  const uid = req?.user?.uid || 'unknown';
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  return { uid, ip };
}

// ✅ List R2 Files
export const listR2Files = async (req, res) => {
  try {
    const files = await listObjectsV2();
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Cleanup R2 Files
export const cleanupR2Files = async (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    await executeCleanup();
    logger.info(`[ADMIN] R2 cleanup triggered by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'R2 cleanup executed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Migrate R2 Archive
export const migrateR2Archive = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run r2:migrate-archive', { stdio: 'inherit' });
    logger.info(`[ADMIN] R2 archive migration initiated by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'R2 archive migration triggered.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Backup Database
export const backupDatabase = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run db:backup', { stdio: 'inherit' });
    logger.info(`[ADMIN] DB backup started by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'Database backup triggered.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Restore Database
export const restoreDatabase = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run db:restore', { stdio: 'inherit' });
    logger.info(`[ADMIN] DB restore initiated by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'Database restore triggered.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ List Logs
export const listLogs = (req, res) => {
  const logDir = path.join(__dirname, '../logs');

  if (!fs.existsSync(logDir)) {
    return res.json({ success: true, logs: [] });
  }

  const files = fs.readdirSync(logDir);
  res.json({ success: true, logs: files });
};

// ✅ Cleanup Logs
export const cleanupLogs = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run logs:cleanup', { stdio: 'inherit' });
    logger.info(`[ADMIN] Log cleanup run by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'Logs cleanup executed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Purge Logs
export const purgeLogs = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run logs:purge', { stdio: 'inherit' });
    logger.info(`[ADMIN] Log purge run by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'Logs purged.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Fix Permissions
export const fixPermissions = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run fix:permissions', { stdio: 'inherit' });
    logger.info(`[ADMIN] Permissions fix run by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'Permissions fixed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Validate Swagger
export const validateSwagger = (req, res) => {
  const { uid, ip } = getAdminAuditContext(req);
  try {
    execSync('npm run swagger:validate', { stdio: 'inherit' });
    logger.info(`[ADMIN] Swagger validation run by ${uid} from IP ${ip}`);
    res.json({ success: true, message: 'Swagger validation completed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
