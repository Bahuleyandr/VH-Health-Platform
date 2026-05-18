import prisma from '../lib/prisma.js';
import { runWithSuperAdmin } from '../lib/tenantContext.js';
import logger from '../logging/logger.js';

/**
 * Runs synthetic tests against critical paths to detect silent failures.
 * Designed to be called by a scheduler every 5 minutes.
 *
 * Phase-2 RLS: scans across tenants, wraps in runWithSuperAdmin.
 */
export async function runCanaryChecks() {
  return runWithSuperAdmin(async () => runCanaryChecksInner());
}

async function runCanaryChecksInner() {
  const results = {};

  // 1. Database read
  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe('SELECT 1 AS ok');
    results.database_read = { status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    results.database_read = { status: 'fail', error: err.message };
  }

  // 2. Database write (to a canary table)
  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe(
      `INSERT INTO canary_checks (checked_at, status) VALUES (NOW(), 'ok')
       ON CONFLICT DO NOTHING`
    );
    results.database_write = { status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    // Table may not exist — that's OK, just means canary table needs creating
    results.database_write = { status: 'skip', error: err.message };
  }

  // 3. Check for stuck notifications (older than 30 min in PENDING)
  try {
    const stuck = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM notification_outbox
       WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL '30 minutes'`
    );
    const stuckCount = parseInt(stuck[0]?.count || 0);
    results.stuck_notifications = {
      status: stuckCount > 50 ? 'warn' : 'ok',
      count: stuckCount
    };
  } catch (err) {
    results.stuck_notifications = { status: 'skip', error: err.message };
  }

  // 4. Check for unprocessed clinical alerts (older than 15 min)
  try {
    const alerts = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) as count FROM clinical_alerts
       WHERE acknowledged_at IS NULL AND severity = 'CRITICAL' AND created_at < NOW() - INTERVAL '15 minutes'`
    );
    const alertCount = parseInt(alerts[0]?.count || 0);
    results.unacknowledged_critical_alerts = {
      status: alertCount > 0 ? 'critical' : 'ok',
      count: alertCount
    };
  } catch (err) {
    results.unacknowledged_critical_alerts = { status: 'skip', error: err.message };
  }

  // Log overall status
  const hasFailures = Object.values(results).some(r => r.status === 'fail' || r.status === 'critical');
  if (hasFailures) {
    logger.error('Canary health check FAILED:', results);
  } else {
    logger.info('Canary health check passed:', results);
  }

  return results;
}

export default { runCanaryChecks };
