import prisma from '../lib/prisma.js';
import { runWithSuperAdmin } from '../lib/tenantContext.js';
import logger from '../logging/logger.js';
import {
  AUTO_REPLAYABLE_RECONCILIATION_REASONS,
  NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS,
  OPERATOR_REPLAY_SUPERSEDED_REASON,
} from './notifications/terminalRejectionCodes.js';

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

  // 2b. Critical-lab-threshold coverage (re-audit 2026-08-23). A tenant with
  //     no active lab_critical_thresholds rows can never raise a critical lab
  //     alert — the lookup simply matches nothing and returns quietly. That
  //     is the tenancy defect the re-audit found, and it is invisible from
  //     the result-recording path itself.
  //
  //     It is answered HERE, not there, on purpose: every caller of
  //     evaluateCriticalThreshold passes its open transaction, and a failed
  //     statement aborts that transaction — an observability probe on the
  //     clinical write path could stop a lab result being recorded. The
  //     canary runs on its own connection, so it cannot.
  //
  //     Provisioning is deliberately NOT automated: thresholds must agree
  //     with lab_reference_ranges and units, which is clinical sign-off, not
  //     a copy. See docs/ROADMAP.md.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name
         FROM tenants t
        WHERE t.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM lab_critical_thresholds th
             WHERE th.tenant_id = t.id AND th.is_active = true
          )
        ORDER BY t.id`,
    );
    results.lab_critical_threshold_coverage = rows.length
      ? {
        status: 'warn',
        unconfigured_tenants: rows.length,
        tenants: rows.map((r) => r.tenant_id),
      }
      : { status: 'ok', unconfigured_tenants: 0 };
    if (rows.length) {
      logger.warn(
        'canary: tenants hold no active lab_critical_thresholds — no lab result can raise a critical alert for them',
        { tenants: rows.map((r) => ({ id: r.tenant_id, name: r.tenant_name })) },
      );
    }
  } catch (err) {
    // Never let the probe read as healthy coverage.
    results.lab_critical_threshold_coverage = { status: 'fail', error: err.message };
  }

  // 2c. Escalation-rule coverage (re-audit 2026-08-23). A tenant with no
  //     active task-scope escalation rules never fires the critical-result,
  //     cold-chain or mortuary tiers. The rules ARE operator-configurable
  //     (PUT /api/v1/admin/workflow/escalation-rules), so this is reported
  //     rather than auto-provisioned: copying the default tenant's rules
  //     cannot be keyed safely and pages real recipients. See
  //     services/tenant/tenantProvisioningRegistry.js.
  //
  //     The sweep itself no longer depends on this: it discovers tenants from
  //     `tenants`, so the open->overdue pass and the orphan-SLA backstop run
  //     for a rule-less tenant too.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name
         FROM tenants t
        WHERE t.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM escalation_rules r
             WHERE r.tenant_id = t.id AND r.is_active = TRUE AND r.scope = 'task'
          )
        ORDER BY t.id`,
    );
    results.escalation_rule_coverage = rows.length
      ? {
        status: 'warn',
        unconfigured_tenants: rows.length,
        tenants: rows.map((r) => r.tenant_id),
      }
      : { status: 'ok', unconfigured_tenants: 0 };
    if (rows.length) {
      logger.warn(
        'canary: tenants hold no active task-scope escalation_rules — their critical-result, cold-chain and mortuary tiers never fire',
        { tenants: rows.map((r) => ({ id: r.tenant_id, name: r.tenant_name })) },
      );
    }
  } catch (err) {
    results.escalation_rule_coverage = { status: 'fail', error: err.message };
  }

  // 3. Notification outbox health (F7/F11, audit 2026-08-10): stuck PENDING
  //    rows AND the dead-letter states. FAILED rows with retry_count >= 3 are
  //    never re-claimed by the drain. RECONCILIATION_REQUIRED rows are split
  //    since the bounded auto-replay sweep (mig-690): rows the sweep can still
  //    requeue as new intents stay in the aggregate 'warn' bucket, while
  //    terminal rows — past the generation/age bound or outside the
  //    auto-replayable reason allowlist, plus terminal provider rejections —
  //    have no automatic path left and go 'critical' (operator-only).
  //    notification_dead_letters keeps its original aggregate shape;
  //    notification_dead_letters_terminal is additive (contract tests and
  //    dashboards pin the existing keys).
  try {
    const [outbox] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (
           WHERE status = 'PENDING' AND created_at < NOW() - INTERVAL '30 minutes'
         ) AS stuck_pending,
         COUNT(*) FILTER (WHERE status = 'FAILED' AND retry_count >= 3) AS failed_dead_letters,
         COUNT(*) FILTER (WHERE status = 'RECONCILIATION_REQUIRED') AS reconciliation_required,
         COUNT(*) FILTER (
           WHERE (status = 'FAILED' AND retry_count >= 3
                  AND failure_reason = 'provider_terminal_rejection')
              OR (status = 'RECONCILIATION_REQUIRED'
                  AND COALESCE(failure_reason, '') <> $1::text
                  AND (replay_generation >= $2::smallint
                       OR created_at <= NOW() - INTERVAL '24 hours'
                       OR COALESCE(failure_reason, '') <> ALL($3::text[])))
         ) AS terminal_dead_letters
       FROM notification_outbox`,
      OPERATOR_REPLAY_SUPERSEDED_REASON,
      NOTIFICATION_AUTO_REPLAY_MAX_GENERATIONS,
      AUTO_REPLAYABLE_RECONCILIATION_REASONS,
    );
    const stuckCount = parseInt(outbox?.stuck_pending || 0);
    const failedDeadLetters = parseInt(outbox?.failed_dead_letters || 0);
    const reconciliationRequired = parseInt(outbox?.reconciliation_required || 0);
    const terminalDeadLetters = parseInt(outbox?.terminal_dead_letters || 0);
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
    results.notification_dead_letters_terminal = {
      status: terminalDeadLetters > 0 ? 'critical' : 'ok',
      count: terminalDeadLetters
    };
  } catch (err) {
    results.stuck_notifications = { status: 'skip', error: err.message };
    results.notification_dead_letters = { status: 'skip', error: err.message };
    results.notification_dead_letters_terminal = { status: 'skip', error: err.message };
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
