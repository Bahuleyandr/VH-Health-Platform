// src/controllers/system/systemController.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as systemHealthService from '../../services/health/systemHealthService.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * Default settings, merged under whatever rows exist in the system_settings
 * table (created by migration 724 — platform-global key/value, JSON-encoded
 * text values). Shape matches what the admin portal settings page expects.
 */
const DEFAULT_SETTINGS = {
  appName: 'VHHealth',
  maintenanceMode: false,
  allowRegistration: true,
  maxAppointmentsPerDay: 50,
  appointmentSlotDurationMinutes: 30,
  defaultLanguage: 'en',
  timezone: 'Asia/Kolkata',
  notificationsEnabled: true,
  smsEnabled: true,
  emailEnabled: false,
  // Display fallback only. Enforcement uses tenant data_retention_policies;
  // migration 576 raises the searchable request/operational baseline to 365d.
  auditLogRetentionDays: 365,
  sessionTimeoutMinutes: 60,
  maxLoginAttempts: 5,
};

// The system_settings table is guaranteed by migration 724 (boot-time
// migrations block startup), so a query failure here is a REAL database
// fault and must surface as a 500 — the previous version swallowed it and
// answered 200 with a per-process in-memory object, which hid the missing
// relation from every smoke/monitor for months (pg logs carried
// `ERROR: relation "system_settings" does not exist` on every settings
// request) and silently dropped admin edits on pod restart.
async function readSettingsFromDb() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT key, value FROM system_settings ORDER BY key`
  );
  const dbSettings = {};
  for (const row of rows) {
    try {
      dbSettings[row.key] = JSON.parse(row.value);
    } catch {
      dbSettings[row.key] = row.value; // legacy/hand-written plain-text value
    }
  }
  return { ...DEFAULT_SETTINGS, ...dbSettings };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/system/settings
// ────────────────────────────────────────────────────────────────────────────
export async function getSettings(req, res) {
  try {
    success(res, await readSettingsFromDb(), 'System settings fetched');
  } catch (err) {
    logger.error('[system] getSettings error:', err.stack || err.message);
    error(res, 'Failed to fetch system settings', 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/system/settings
// ────────────────────────────────────────────────────────────────────────────
export async function updateSettings(req, res) {
  try {
    const updates = req.body || {};
    const allowedKeys = Object.keys(DEFAULT_SETTINGS);
    const filtered = {};

    for (const key of allowedKeys) {
      if (key in updates) {
        filtered[key] = updates[key];
      }
    }

    if (Object.keys(filtered).length === 0) {
      return error(res, 'No valid settings provided', 400);
    }

    // Persist to the system_settings table (migration 724). A failure here is
    // a real database fault and surfaces as a 500 — no in-memory fallback that
    // pretends the write stuck (it evaporated on pod restart and never
    // replicated across pods).
    for (const [key, value] of Object.entries(filtered)) {
      await prisma.$queryRawUnsafe(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        key, JSON.stringify(value)
      );
    }

    const uid = req.user?.uid || 'unknown';
    logger.info(`[system] Settings updated by ${uid}:`, filtered);

    success(res, await readSettingsFromDb(), 'System settings updated');
  } catch (err) {
    logger.error('[system] updateSettings error:', err.stack || err.message);
    error(res, 'Failed to update system settings', 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/system/status
// Proxies the existing systemHealthService.getSystemStatus() so the portal
// dashboard can call /api/v1/system/status instead of /api/v1/health/system/status
// ────────────────────────────────────────────────────────────────────────────
export async function getSystemStatus(req, res) {
  try {
    const status = systemHealthService.getSystemStatus();
    success(res, status, 'System status fetched');
  } catch (err) {
    logger.error('[system] getSystemStatus error:', err.stack || err.message);
    res.status(500).json({
      success: false,
      message: 'System status check failed',
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
    });
  }
}
