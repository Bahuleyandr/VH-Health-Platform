import prisma from '../lib/prisma.js';
import { runInTenantContext, runWithSuperAdmin } from '../lib/tenantContext.js';
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

  // 2b. Governed laboratory-policy coverage. Every facility catalogue revision
  //     must have one effective, signed active bundle at that exact revision.
  //     Result ingestion now fails safe into an owned high-severity exception
  //     when this is not true; this fleet view catches coverage drift before a
  //     result has to discover it.
  //
  //     It is answered HERE, not there, on purpose: every caller of
  //     evaluateCriticalThreshold passes its open transaction, and a failed
  //     statement aborts that transaction — an observability probe on the
  //     clinical write path could stop a lab result being recorded. The
  //     canary runs on its own connection, so it cannot.
  //
  //     Provisioning is deliberately NOT automated: reference intervals and
  //     critical limits are facility-, analyzer-, and population-specific
  //     clinical content. See docs/ROADMAP.md.
  try {
    // `facilities` is fail-closed outside a real tenant context, and an empty
    // result here is reported as healthy coverage rather than as an error — so
    // ask each tenant inside its own context instead of reading the fleet from
    // a cross-tenant one. `tenants` is not tenant-scoped and stays readable.
    const activeTenants = await prisma.$queryRawUnsafe(
      `SELECT id::text AS id FROM tenants WHERE status = 'active' ORDER BY id`,
    );
    if (!activeTenants.length) {
      throw new Error('no active tenants discovered; coverage cannot be assessed');
    }
    const rows = [];
    for (const activeTenant of activeTenants) {
      const scoped = await runInTenantContext(activeTenant.id, () => prisma.$queryRawUnsafe(
      `SELECT tenant.id::text AS tenant_id,
              tenant.name AS tenant_name,
              facility.id AS facility_id,
              facility.display_name AS facility_name,
              catalog.current_revision
         FROM lab_threshold_catalog_states AS catalog
         JOIN tenants AS tenant
           ON tenant.id = catalog.tenant_id
         JOIN facilities AS facility
           ON facility.tenant_id = catalog.tenant_id
          AND facility.id = catalog.facility_id
        WHERE catalog.tenant_id = $1::uuid
          AND tenant.status = 'active'
          AND facility.status = 'active'
          AND NOT EXISTS (
            SELECT 1
              FROM lab_threshold_policy_bundles AS bundle
             WHERE bundle.tenant_id = catalog.tenant_id
               AND bundle.facility_id = catalog.facility_id
               AND bundle.catalog_revision = catalog.current_revision
               AND bundle.lifecycle_status = 'active'
               AND bundle.effective_from <= NOW()
               AND (bundle.effective_until IS NULL OR bundle.effective_until > NOW())
          )
        ORDER BY tenant.id, facility.id`,
        activeTenant.id,
      ));
      rows.push(...scoped);
    }
    results.lab_threshold_policy_coverage = rows.length
      ? {
        status: 'warn',
        uncovered_facilities: rows.length,
        facilities: rows.map((row) => ({
          tenant_id: row.tenant_id,
          facility_id: Number(row.facility_id),
          catalog_revision: Number(row.current_revision),
        })),
      }
      : { status: 'ok', uncovered_facilities: 0 };
    if (rows.length) {
      logger.warn(
        'canary: laboratory catalogue revisions lack an effective signed policy bundle',
        {
          facilities: rows.map((row) => ({
            tenantId: row.tenant_id,
            tenantName: row.tenant_name,
            facilityId: Number(row.facility_id),
            facilityName: row.facility_name,
            catalogRevision: Number(row.current_revision),
          })),
        },
      );
    }
  } catch (err) {
    // Never let the probe read as healthy coverage.
    results.lab_threshold_policy_coverage = { status: 'fail', error: err.message };
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
