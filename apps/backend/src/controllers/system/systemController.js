// src/controllers/system/systemController.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as systemHealthService from '../../services/health/systemHealthService.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * In-memory settings store (use DB table if persistent settings are required).
 * Shape matches what the admin portal settings page expects.
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
  auditLogRetentionDays: 90,
  sessionTimeoutMinutes: 60,
  maxLoginAttempts: 5,
};

const currentSettings = { ...DEFAULT_SETTINGS };

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/system/settings
// ────────────────────────────────────────────────────────────────────────────
export async function getSettings(req, res) {
  try {
    // Try to load settings from DB if a settings table exists
    try {
      const result = await prisma.$queryRawUnsafe(
        `SELECT key, value FROM system_settings ORDER BY key`
      );
      if (result.length > 0) {
        const dbSettings = {};
        for (const row of result) {
          try {
            dbSettings[row.key] = JSON.parse(row.value);
          } catch {
            dbSettings[row.key] = row.value;
          }
        }
        return success(res, { ...DEFAULT_SETTINGS, ...dbSettings }, 'System settings fetched');
      }
    } catch {
      // Table doesn't exist — return in-memory defaults, no crash
    }

    success(res, currentSettings, 'System settings fetched');
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

    // Try to persist to DB if table exists
    try {
      for (const [key, value] of Object.entries(filtered)) {
        await prisma.$queryRawUnsafe(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          key, JSON.stringify(value)
        );
      }
    } catch {
      // Table doesn't exist — just update in-memory store
      Object.assign(currentSettings, filtered);
    }

    // Always update in-memory store so subsequent GETs reflect the change
    Object.assign(currentSettings, filtered);

    const uid = req.user?.uid || 'unknown';
    logger.info(`[system] Settings updated by ${uid}:`, filtered);

    success(res, currentSettings, 'System settings updated');
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
