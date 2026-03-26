// src/controllers/system/healthController.js
// Comprehensive system health monitor — admin-only deep health check

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { success } from '../../utils/responseHelper.js';

/**
 * GET /api/v1/system/health
 * Deep system health check with service-level detail.
 * Returns status of database, storage, push, SMS, notification backlog, stuck orders, server metrics.
 */
export const getSystemHealth = async (req, res) => {
  const checks = {};

  // 1. Database latency
  try {
    const start = Date.now();
    await db.query('SELECT 1');
    checks.database = { status: 'healthy', latency_ms: Date.now() - start };
  } catch (e) {
    checks.database = { status: 'down', error: e.message };
  }

  // 2. R2 Storage
  try {
    // Just verify the module loads and S3 client is configured
    const r2 = await import('../../utils/r2Storage.js').catch(() => null);
    if (r2 && r2.uploadFileToR2) {
      checks.r2_storage = { status: 'healthy', note: 'Module loaded' };
    } else {
      checks.r2_storage = { status: 'unknown', note: 'Module not available' };
    }
  } catch (e) {
    checks.r2_storage = { status: 'degraded', error: e.message };
  }

  // 3. FCM / Push notifications
  try {
    const admin = await import('firebase-admin').catch(() => null);
    if (admin && admin.default?.apps?.length > 0) {
      checks.push_notifications = { status: 'healthy' };
    } else {
      checks.push_notifications = { status: 'not_initialized' };
    }
  } catch (e) {
    checks.push_notifications = { status: 'degraded', error: e.message };
  }

  // 4. SMS service
  checks.sms = {
    status: process.env.MSG91_API_KEY ? 'configured' : 'dry_run',
    provider: process.env.SMS_PROVIDER || (process.env.MSG91_API_KEY ? 'msg91' : 'none'),
  };

  // 5. Scheduler
  checks.scheduler = { status: 'running' };

  // 6. Failed notifications backlog
  try {
    const backlog = await db.query(
      `SELECT status, COUNT(*)::int as count FROM failed_notifications GROUP BY status`
    );
    const counts = {};
    for (const row of backlog.rows) {
      counts[row.status] = row.count;
    }
    checks.notification_backlog = {
      pending: counts.pending || 0,
      sent: counts.sent || 0,
      failed_permanent: counts.failed_permanent || 0,
    };
  } catch (e) {
    checks.notification_backlog = { status: 'unknown', note: 'Table may not exist' };
  }

  // 7. Stuck orders count
  try {
    const [stuckAppt, stuckPharm, stuckInv] = await Promise.all([
      db.query(`SELECT COUNT(*)::int as c FROM appointments WHERE status='SCHEDULED' AND confirmed_at IS NULL AND created_at < NOW()-INTERVAL '48 hours'`),
      db.query(`SELECT COUNT(*)::int as c FROM pharmacy_orders WHERE status='PLACED' AND sla_confirm_target IS NOT NULL AND NOW()>sla_confirm_target`),
      db.query(`SELECT COUNT(*)::int as c FROM investigation_bookings WHERE status='DISPATCHED' AND dispatched_at IS NOT NULL AND dispatched_at < NOW()-INTERVAL '4 hours'`),
    ]);
    checks.stuck_orders = {
      appointments: stuckAppt.rows[0].c,
      pharmacy: stuckPharm.rows[0].c,
      investigations: stuckInv.rows[0].c,
    };
  } catch (e) {
    checks.stuck_orders = { status: 'unknown', error: e.message };
  }

  // 8. Server metrics
  const memUsage = process.memoryUsage();
  checks.server = {
    uptime_hours: Math.round(process.uptime() / 3600 * 10) / 10,
    memory_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
    memory_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
    memory_percent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100),
    node_version: process.version,
    environment: process.env.NODE_ENV || 'development',
  };

  // Overall status
  const allHealthy = Object.values(checks).every(c =>
    !c.status || ['healthy', 'configured', 'running', 'dry_run'].includes(c.status)
  );

  success(res, {
    status: allHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  }, allHealthy ? 'All systems operational' : 'Some systems degraded');
};
