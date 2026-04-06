import { execSync } from 'child_process';
import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { executeCleanup } from '../utils/r2CleanupJob.js';
import { listObjectsV2 } from '../utils/r2Storage.js';

// Utility to extract UID and IP
function getAdminAuditContext(req) {
  const uid = (req && req.user && req.user.uid) || 'unknown';
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  return { uid, ip };
}

// ✅ List R2 Files
export const listR2Files = async (req, res) => {
  try {
    const files = await listObjectsV2();
    res.json({ success: true, files });
  } catch (error) {
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ✅ List Logs
export const listLogs = (req, res) => {
  const logDir = path.join(process.cwd(), 'logs');

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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
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
    logger.error('Admin operation failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

// ✅ View Role Audit Log
export const viewRoleAudit = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT phone, old_role, new_role, changed_by_uid, changed_at
       FROM user_role_audit
       ORDER BY changed_at DESC
       LIMIT 100`
    );
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error('Failed to fetch audit log:', err.stack || err.toString());
    res.status(500).json({ success: false, message: 'Failed to fetch audit log' });
  }
};

// ✅ Push Test Notification to a Phone
export const sendTestNotification = async (req, res) => {
  const { phone, title, body } = req.body;

  if (!phone || !title || !body) {
    return res.status(400).json({ success: false, message: 'Phone, title and body are required.' });
  }

  try {
    const result = await prisma.$queryRawUnsafe('SELECT fcm_token FROM devices WHERE phone = $1', phone);

    if (result.length === 0) {
      return res.status(404).json({ success: false, message: 'Device not registered.' });
    }

    const token = result[0].fcm_token;

    const message = {
      token,
      notification: { title, body }
    };

    const response = await admin.messaging().send(message);

    return res.json({
      success: true,
      message: 'Notification sent.',
      firebase: response
    });
  } catch (err) {
    logger.error('Push notification error:', err.stack || err.toString());
    return res.status(500).json({ success: false, message: 'Failed to send push notification.' });
  }
};

// ✅ Audit Logs Viewer
export const getAuditLogs = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, action, phone, platform, timestamp
       FROM audit_logs
       ORDER BY timestamp DESC
       LIMIT 100`
    );
    res.json({ success: true, logs: result });
  } catch (err) {
    logger.error('Audit log fetch error:', err.stack || err.toString());
    res.status(500).json({ success: false, message: 'Unable to fetch audit logs.' });
  }
};
