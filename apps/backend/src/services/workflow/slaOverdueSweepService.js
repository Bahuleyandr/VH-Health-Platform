// Generic overdue sweep for workflow_sla_instances (SLA-halves audit finding).
//
// The escalation engine (escalationEngineService.runEscalationSweep) is
// task-centric: its candidate SQL joins `tasks`, treats active-past-due as a
// breach *signal*, and never flips instance status. Instances with no linked
// task (beds, housekeeping, referrals, SOS pre-escalation, stroke, discharge
// consults, drug chart, cath-lab) therefore never left 'active' unless their
// own domain sweep ran (porter, SOS) or a late completion arrived.
//
// This sweep is the generic closer: it flips active past-due instances to
// 'breached' with breached_at = due_at (detection is late; the breach moment
// is not). It deliberately does NOT escalate and does NOT notify —
// 'escalated' stays the property of the SOS sweep and escalation-rule
// actions, and notification remains escalationEngineService's job. Flipping
// status feeds that engine: its breach signal matches s.status = 'breached'.
//
// Never touches 'escalated'/'completed'/'cancelled' rows, so it cannot race
// the terminal guard in completeWorkflowSla (a breached row stays completable
// — house convention — and a late completion stamps completed_at with the
// breached status preserved).
//
// due_at IS NOT NULL naturally skips STEMI clocks created with pending
// door-time/targets (NULL due_at). Idempotent with the porter sweep (both
// COALESCE breached_at); porter's own sweep additionally fans out recipients,
// so it stays.

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_SWEEP_LIMIT = 200;
const MAX_SWEEP_LIMIT = 1000;

function clampLimit(value, fallback = DEFAULT_SWEEP_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_SWEEP_LIMIT);
}

/**
 * Flip this tenant's active, past-due workflow SLA instances to 'breached'.
 *
 * One statement per tenant (uses idx_workflow_sla_instances_due); the
 * FOR UPDATE SKIP LOCKED claim keeps concurrent sweeps and in-flight
 * completions from colliding — a row locked by a completing transaction is
 * simply skipped and re-examined on the next 5-minute tick.
 *
 * @param {Object} options
 * @param {string} options.tenantId tenant to sweep (required)
 * @param {Date}   [options.now] breach-detection clock
 * @param {number} [options.limit=200] per-tenant cap per tick
 * @param {Object} [options.db] existing tenant-scoped client/transaction; when
 *   omitted the sweep opens its own setTenantTx so the tenant GUC is always set
 * @returns {{ breached: number, byRule: Record<string, number> }}
 */
export async function runWorkflowSlaOverdueSweep({
  tenantId,
  now = new Date(),
  limit = DEFAULT_SWEEP_LIMIT,
  db = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const clock = now instanceof Date ? now : new Date(now);
  const cap = clampLimit(limit);

  const sweep = (tx) => tx.$queryRawUnsafe(
    `WITH candidates AS (
       SELECT id
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND completed_at IS NULL
          AND due_at IS NOT NULL
          AND due_at < $2::timestamptz
        ORDER BY due_at ASC
        LIMIT $3::int
        FOR UPDATE SKIP LOCKED
     )
     UPDATE workflow_sla_instances i
        SET status = 'breached',
            breached_at = COALESCE(i.breached_at, i.due_at),
            metadata = COALESCE(i.metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'breached_by', 'workflow-sla-overdue-sweep',
                   'breach_detected_at', $2::timestamptz
                 ),
            updated_at = NOW()
       FROM candidates
      WHERE i.id = candidates.id
      RETURNING i.id, i.rule_code, i.source_table, i.source_id, i.priority`,
    tid,
    clock.toISOString(),
    cap,
  );

  let rows;
  try {
    rows = db ? await sweep(db) : await setTenantTx(tid, sweep);
  } catch (err) {
    logger.error('workflow SLA overdue sweep failed', {
      tenantId: tid,
      error: err?.message,
    });
    return { breached: 0, byRule: {} };
  }

  const breachedRows = Array.isArray(rows) ? rows : [];
  const byRule = {};
  for (const row of breachedRows) {
    const rule = row.rule_code || 'unknown';
    byRule[rule] = (byRule[rule] || 0) + 1;
  }

  if (breachedRows.length) {
    logger.info(
      `Workflow SLA overdue sweep marked ${breachedRows.length} instance(s) breached`,
      { tenantId: tid, byRule },
    );
  }

  return { breached: breachedRows.length, byRule };
}

export default { runWorkflowSlaOverdueSweep };
