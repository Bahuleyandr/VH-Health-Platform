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

  // 3. Notification outbox health (F7/F11, audit 2026-08-10): stuck PENDING
  //    rows AND the dead-letter states. FAILED rows with retry_count >= 3 are
  //    never re-claimed by the drain, and RECONCILIATION_REQUIRED rows are
  //    never auto-retried at all (mig-609 contract) — both are undelivered
  //    notifications no automatic path will ever send, so the canary must
  //    surface them instead of counting only PENDING.
  try {
    const [outbox] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (
           WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL '30 minutes'
         ) AS stuck_pending,
         COUNT(*) FILTER (WHERE status = 'FAILED' AND retry_count >= 3) AS failed_dead_letters,
         COUNT(*) FILTER (WHERE status = 'RECONCILIATION_REQUIRED') AS reconciliation_required
       FROM notification_outbox`
    );
    const stuckCount = parseInt(outbox?.stuck_pending || 0);
    const failedDeadLetters = parseInt(outbox?.failed_dead_letters || 0);
    const reconciliationRequired = parseInt(outbox?.reconciliation_required || 0);
    results.stuck_notifications = {
      status: stuckCount > 50 ? 'warn' : 'ok',
      count: stuckCount
    };
    results.notification_dead_letters = {
      status: (failedDeadLetters + reconciliationRequired) > 0 ? 'warn' : 'ok',
      count: failedDeadLetters + reconciliationRequired,
      failed: failedDeadLetters,
      reconciliation_required: reconciliationRequired
    };
  } catch (err) {
    results.stuck_notifications = { status: 'skip', error: err.message };
    results.notification_dead_letters = { status: 'skip', error: err.message };
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

  // Log overall status. 'warn' participates in failure handling (F11 fix —
  // it used to be silently excluded, so a warn-level canary result produced
  // only an info log that nothing watched).
  const hasFailures = Object.values(results).some(
    r => r.status === 'fail' || r.status === 'critical' || r.status === 'warn'
  );
  if (hasFailures) {
    logger.error('Canary health check FAILED:', results);
  } else {
    logger.info('Canary health check passed:', results);
  }

  return results;
}

export default { runCanaryChecks };
