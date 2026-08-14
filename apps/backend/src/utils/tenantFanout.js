// src/utils/tenantFanout.js
//
// Per-tenant cron fan-out with durable, fail-closed run evidence. Discovery is
// authoritative: this helper never invents a default tenant when the tenants
// query fails or returns no active rows. One tenant failure does not prevent
// healthy tenants from running, but the aggregate rejects so the outer
// scheduler cannot report a successful tick.

import prisma, { setTenant } from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { runInTenantContext } from '../lib/tenantContext.js';

const DEFAULT_STALE_AFTER_MINUTES = 24 * 60;
const SCHEDULER_ADVISORY_LOCK_NAMESPACE = 0x5648;

function staleAfterMinutes() {
  const configured = Number.parseInt(process.env.SCHEDULER_RUN_STALE_AFTER_MINUTES || '', 10);
  if (!Number.isSafeInteger(configured) || configured < 5 || configured > 7 * 24 * 60) {
    return DEFAULT_STALE_AFTER_MINUTES;
  }
  return configured;
}

function normalizedLabel(label) {
  const value = String(label || '').trim();
  if (!value || value.length > 160) {
    throw new TypeError('Tenant fan-out label must contain 1 to 160 characters');
  }
  return value;
}

function normalizedFailureCode(err, fallback) {
  const candidate = String(err?.code || fallback || 'JOB_FAILED')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 80);
  return candidate || 'JOB_FAILED';
}

async function createRun(label, lockKey, scope = 'tenant_fanout') {
  const rows = await prisma.$queryRawUnsafe(
    `WITH pruned AS MATERIALIZED (
       SELECT public.prune_scheduled_job_run_evidence()
     ), inserted AS (
       INSERT INTO scheduled_job_runs (job_label, lock_key, scope)
       SELECT $1::text, $2::text, $3::text FROM pruned
       RETURNING id
     )
     SELECT id FROM inserted`,
    label,
    lockKey,
    scope,
  );
  if (!rows?.[0]?.id) throw new Error(`${label}: failed to create scheduler run receipt`);
  return rows[0].id;
}

async function discoverActiveTenants() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM tenants
      WHERE status = 'active'
      ORDER BY id`,
  );
  const tenantIds = [...new Set(
    (Array.isArray(rows) ? rows : []).map(row => row.id).filter(Boolean),
  )];
  if (tenantIds.length === 0) {
    const err = new Error('Tenant discovery returned no active tenants');
    err.code = 'TENANT_DISCOVERY_EMPTY';
    throw err;
  }
  return tenantIds;
}

async function reconcileStaleRuns(currentRunId) {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRawUnsafe(
      `SELECT id, lock_key
         FROM scheduled_job_runs
        WHERE aggregate_status = 'running'
          AND id <> $1::bigint
          AND started_at < NOW() - ($2::integer * INTERVAL '1 minute')
        ORDER BY id
        LIMIT 100`,
      currentRunId,
      staleAfterMinutes(),
    );
    const candidateIds = (Array.isArray(candidates) ? candidates : [])
      .map(row => row.id)
      .filter(id => id != null);
    if (candidateIds.length === 0) return 0;

    const unlockedKeys = new Set();
    const candidateKeys = [...new Set(candidates.map(row => row.lock_key).filter(Boolean))].sort();
    for (const lockKey of candidateKeys) {
      const [lock] = await tx.$queryRawUnsafe(
        `SELECT pg_catalog.pg_try_advisory_xact_lock(
           $1::integer,
           pg_catalog.hashtext($2::text)
         ) AS locked`,
        SCHEDULER_ADVISORY_LOCK_NAMESPACE,
        lockKey,
      );
      if (lock?.locked === true) unlockedKeys.add(lockKey);
    }
    const reapedRunIds = candidates
      .filter(row => unlockedKeys.has(row.lock_key))
      .map(row => row.id);
    if (reapedRunIds.length === 0) return 0;

    const staleRows = await tx.$queryRawUnsafe(
      `SELECT id, discovery_status, tenants_discovered
         FROM scheduled_job_runs
        WHERE id = ANY($1::bigint[])
          AND aggregate_status = 'running'
          AND started_at < NOW() - ($2::integer * INTERVAL '1 minute')
        ORDER BY id
        FOR UPDATE`,
      reapedRunIds,
      staleAfterMinutes(),
    );
    const staleRunIds = staleRows.map(row => row.id);
    if (staleRunIds.length === 0) return 0;

    const outcomesByRun = new Map(staleRows.map(row => [String(row.id), {
      succeeded: 0,
      failed: 0,
    }]));
    const tenantRows = await tx.$queryRawUnsafe('SELECT id FROM tenants ORDER BY id');
    for (const { id: tenantId } of tenantRows) {
      await tx.$queryRawUnsafe(
        `SELECT pg_catalog.set_config('app.current_tenant_id', $1::text, true)`,
        tenantId,
      );
      await tx.$queryRawUnsafe(
        `UPDATE scheduled_job_tenant_runs AS tenant_run
            SET status = 'indeterminate',
                failure_code = 'STALE_RUN_ABANDONED',
                finished_at = NOW()
          WHERE tenant_run.tenant_id = $1::uuid
            AND tenant_run.run_id = ANY($2::bigint[])
            AND tenant_run.status = 'running'`,
        tenantId,
        staleRunIds,
      );
      const tenantOutcomes = await tx.$queryRawUnsafe(
        `SELECT run_id, status
           FROM scheduled_job_tenant_runs
          WHERE tenant_id = $1::uuid
            AND run_id = ANY($2::bigint[])`,
        tenantId,
        staleRunIds,
      );
      for (const outcome of tenantOutcomes) {
        const counts = outcomesByRun.get(String(outcome.run_id));
        if (outcome.status === 'succeeded') counts.succeeded += 1;
        if (outcome.status === 'failed') counts.failed += 1;
      }
    }

    for (const staleRun of staleRows) {
      const counts = outcomesByRun.get(String(staleRun.id));
      const unresolved = staleRun.discovery_status === 'succeeded'
        ? staleRun.tenants_discovered - counts.succeeded - counts.failed
        : 0;
      const rows = await tx.$queryRawUnsafe(
        `UPDATE scheduled_job_runs
            SET aggregate_status = 'abandoned',
                tenants_succeeded = $2::integer,
                tenants_failed = $3::integer,
                tenants_unresolved = $4::integer,
                failure_code = 'STALE_RUN_ABANDONED',
                finished_at = NOW()
          WHERE id = $1::bigint
            AND aggregate_status = 'running'
        RETURNING id`,
        staleRun.id,
        counts.succeeded,
        counts.failed,
        unresolved,
      );
      if (rows.length !== 1) throw new Error('A stale scheduler run receipt was not reconciled');
    }
    return staleRows.length;
  }, { maxWait: 5000, timeout: 120000 });
}

async function recordDiscoverySucceeded(runId, tenantCount) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE scheduled_job_runs
          SET discovery_status = 'succeeded',
              tenants_discovered = $2::integer
         WHERE id = $1::bigint
          AND discovery_status = 'pending'
          AND aggregate_status = 'running'
        RETURNING id
     )
     SELECT id FROM updated
     UNION ALL
     SELECT existing.id
       FROM scheduled_job_runs existing
      WHERE existing.id = $1::bigint
        AND existing.discovery_status = 'succeeded'
        AND existing.aggregate_status = 'running'
        AND existing.tenants_discovered = $2::integer
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    runId,
    tenantCount,
  );
  if (!rows?.length) throw new Error('Scheduler run receipt was not writable during discovery');
}

async function recordReconciliationFailed(runId, failureCode) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE scheduled_job_runs
          SET aggregate_status = 'reconciliation_failed',
              failure_code = $2::text,
              finished_at = NOW()
         WHERE id = $1::bigint
           AND discovery_status = 'pending'
           AND aggregate_status = 'running'
        RETURNING id
     )
     SELECT id FROM updated
     UNION ALL
     SELECT existing.id
       FROM scheduled_job_runs existing
      WHERE existing.id = $1::bigint
        AND existing.discovery_status = 'pending'
        AND existing.aggregate_status = 'reconciliation_failed'
        AND existing.failure_code = $2::text
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    runId,
    failureCode,
  );
  if (!rows?.length) throw new Error('Scheduler reconciliation failure receipt was not persisted');
}

async function recordDiscoveryFailed(runId, failureCode) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE scheduled_job_runs
          SET discovery_status = 'failed',
              aggregate_status = 'discovery_failed',
              failure_code = $2::text,
              finished_at = NOW()
         WHERE id = $1::bigint
          AND discovery_status = 'pending'
          AND aggregate_status = 'running'
        RETURNING id
     )
     SELECT id FROM updated
     UNION ALL
     SELECT existing.id
       FROM scheduled_job_runs existing
      WHERE existing.id = $1::bigint
        AND existing.discovery_status = 'failed'
        AND existing.aggregate_status = 'discovery_failed'
        AND existing.failure_code = $2::text
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    runId,
    failureCode,
  );
  if (!rows?.length) throw new Error('Scheduler discovery failure receipt was not persisted');
}

async function recordTenantStarted(runId, tenantId) {
  return setTenant(tenantId, tx => tx.$queryRawUnsafe(
    `INSERT INTO scheduled_job_tenant_runs (run_id, tenant_id)
     VALUES ($1::bigint, $2::uuid)
     RETURNING run_id`,
    runId,
    tenantId,
  ));
}

async function recordTenantFinished(runId, tenantId, { status, failureCode = null }) {
  const rows = await setTenant(tenantId, tx => tx.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE scheduled_job_tenant_runs
          SET status = $3::text,
              failure_code = $4::text,
              finished_at = NOW()
         WHERE run_id = $1::bigint
          AND tenant_id = $2::uuid
          AND status = 'running'
        RETURNING run_id
     )
     SELECT run_id FROM updated
     UNION ALL
     SELECT existing.run_id
       FROM scheduled_job_tenant_runs existing
      WHERE existing.run_id = $1::bigint
        AND existing.tenant_id = $2::uuid
        AND existing.status = $3::text
        AND existing.failure_code IS NOT DISTINCT FROM $4::text
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    runId,
    tenantId,
    status,
    failureCode,
  ));
  if (!rows?.length) throw new Error('Tenant scheduler outcome receipt was not persisted');
}

async function recordTenantFallback(runId, tenantId, { status, failureCode = null }) {
  const rows = await setTenant(tenantId, tx => tx.$queryRawUnsafe(
    `WITH upserted AS (
       INSERT INTO scheduled_job_tenant_runs
         (run_id, tenant_id, status, failure_code, finished_at)
       VALUES ($1::bigint, $2::uuid, $3::text, $4::text, NOW())
       ON CONFLICT (run_id, tenant_id) DO UPDATE
         SET status = EXCLUDED.status,
             failure_code = EXCLUDED.failure_code,
             finished_at = EXCLUDED.finished_at
       WHERE scheduled_job_tenant_runs.status = 'running'
       RETURNING run_id
     )
     SELECT run_id FROM upserted
     UNION ALL
     SELECT existing.run_id
       FROM scheduled_job_tenant_runs existing
      WHERE existing.run_id = $1::bigint
        AND existing.tenant_id = $2::uuid
        AND existing.status = $3::text
        AND existing.failure_code IS NOT DISTINCT FROM $4::text
        AND NOT EXISTS (SELECT 1 FROM upserted)
      LIMIT 1`,
    runId,
    tenantId,
    status,
    failureCode,
  ));
  if (!rows?.length) throw new Error('Tenant scheduler fallback outcome was not persisted');
}

async function persistTenantOutcome(runId, tenantId, outcome) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await recordTenantFinished(runId, tenantId, outcome);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function persistTenantFallback(runId, tenantId, outcome) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await recordTenantFallback(runId, tenantId, outcome);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function recordAggregateFinished(runId, { succeeded, failed, unresolved }) {
  const status = unresolved > 0
    ? 'evidence_failure'
    : (failed > 0 ? 'partial_failure' : 'succeeded');
  const failureCode = unresolved > 0
    ? 'TENANT_OUTCOME_UNRESOLVED'
    : (failed > 0 ? 'TENANT_RUN_FAILURE' : null);
  const rows = await prisma.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE scheduled_job_runs
          SET aggregate_status = $2::text,
              tenants_succeeded = $3::integer,
              tenants_failed = $4::integer,
              tenants_unresolved = $5::integer,
              failure_code = $6::text,
              finished_at = NOW()
         WHERE id = $1::bigint
          AND aggregate_status = 'running'
        RETURNING id
     )
     SELECT id FROM updated
     UNION ALL
     SELECT existing.id
       FROM scheduled_job_runs existing
      WHERE existing.id = $1::bigint
        AND existing.aggregate_status = $2::text
        AND existing.tenants_succeeded = $3::integer
        AND existing.tenants_failed = $4::integer
        AND existing.tenants_unresolved = $5::integer
        AND existing.failure_code IS NOT DISTINCT FROM $6::text
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    runId,
    status,
    succeeded,
    failed,
    unresolved,
    failureCode,
  );
  if (!rows?.length) throw new Error('Scheduler aggregate outcome receipt was not persisted');
}

async function persistReceipt(writeReceipt) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeReceipt();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function fanoutError(label, runId, failures, message, result) {
  const aggregate = new AggregateError(failures, message);
  aggregate.name = 'TenantFanoutAggregateError';
  aggregate.runId = String(runId);
  aggregate.result = result;
  aggregate.jobLabel = label;
  return aggregate;
}

/**
 * Run `perTenantFn(tenantId)` once for every active tenant.
 *
 * Discovery and every tenant outcome are recorded before the returned promise
 * resolves. A failed tenant does not stop later tenants, but any discovery,
 * execution, or receipt failure rejects the aggregate run.
 *
 * @param {string} label job label for durable receipts and logs
 * @param {(tenantId: string) => Promise<unknown>} perTenantFn
 * @param {Object} [options]
 * @param {string} [options.lockKey=label] fleet advisory-lock key protecting the job
 * @returns {Promise<{runId: string, tenantsDiscovered: number, tenantsRun: number, errors: number}>}
 */
export async function runForEachTenant(label, perTenantFn, { lockKey = label } = {}) {
  const jobLabel = normalizedLabel(label);
  const jobLockKey = normalizedLabel(lockKey);
  if (typeof perTenantFn !== 'function') {
    throw new TypeError(`${jobLabel}: perTenantFn must be a function`);
  }

  const runId = await createRun(jobLabel, jobLockKey);
  let tenantIds;
  try {
    await reconcileStaleRuns(runId);
  } catch (err) {
    const failureCode = normalizedFailureCode(err, 'STALE_RECONCILIATION_FAILED');
    try {
      await persistReceipt(() => recordReconciliationFailed(runId, failureCode));
    } catch (receiptErr) {
      throw fanoutError(
        jobLabel,
        runId,
        [err, receiptErr],
        `${jobLabel}: stale-run reconciliation and its failure receipt both failed`,
        { runId: String(runId), tenantsDiscovered: 0, tenantsRun: 0, errors: 1 },
      );
    }
    throw fanoutError(
      jobLabel,
      runId,
      [err],
      `${jobLabel}: stale-run reconciliation failed`,
      { runId: String(runId), tenantsDiscovered: 0, tenantsRun: 0, errors: 1 },
    );
  }
  try {
    tenantIds = await discoverActiveTenants();
    await persistReceipt(() => recordDiscoverySucceeded(runId, tenantIds.length));
  } catch (err) {
    const failureCode = normalizedFailureCode(err, 'TENANT_DISCOVERY_FAILED');
    try {
      await persistReceipt(() => recordDiscoveryFailed(runId, failureCode));
    } catch (receiptErr) {
      throw fanoutError(
        jobLabel,
        runId,
        [err, receiptErr],
        `${jobLabel}: tenant discovery and its failure receipt both failed`,
        { runId: String(runId), tenantsDiscovered: 0, tenantsRun: 0, errors: 1 },
      );
    }
    throw fanoutError(
      jobLabel,
      runId,
      [err],
      `${jobLabel}: tenant discovery failed`,
      { runId: String(runId), tenantsDiscovered: 0, tenantsRun: 0, errors: 1 },
    );
  }

  let succeeded = 0;
  let failed = 0;
  let unresolved = 0;
  const failures = [];
  for (const tenantId of tenantIds) {
    try {
      const started = await recordTenantStarted(runId, tenantId);
      if (!started?.length) throw new Error('Tenant scheduler start receipt was not persisted');
    } catch (err) {
      const failureCode = normalizedFailureCode(err, 'TENANT_START_RECEIPT_FAILED');
      try {
        await persistTenantFallback(runId, tenantId, { status: 'failed', failureCode });
        failed += 1;
      } catch (receiptErr) {
        unresolved += 1;
        failures.push(receiptErr);
        logger.error(`${jobLabel}: failed to persist start failure for tenant ${tenantId}`, receiptErr);
      }
      failures.push(err);
      logger.error(`${jobLabel}: could not record start for tenant ${tenantId}`, err);
      continue;
    }

    let executionError = null;
    try {
      await runInTenantContext(tenantId, () => perTenantFn(tenantId));
    } catch (err) {
      executionError = err;
    }

    if (executionError) {
      const failureCode = normalizedFailureCode(executionError, 'TENANT_JOB_FAILED');
      try {
        await persistTenantOutcome(runId, tenantId, { status: 'failed', failureCode });
        failed += 1;
      } catch (receiptErr) {
        try {
          await persistTenantFallback(runId, tenantId, { status: 'failed', failureCode });
          failed += 1;
        } catch (fallbackErr) {
          unresolved += 1;
          failures.push(receiptErr, fallbackErr);
          logger.error(`${jobLabel}: failed to persist outcome for tenant ${tenantId}`, fallbackErr);
        }
      }
      failures.push(executionError);
      logger.error(`${jobLabel}: failed for tenant ${tenantId}`, executionError);
      continue;
    }

    try {
      await persistTenantOutcome(runId, tenantId, { status: 'succeeded' });
      succeeded += 1;
    } catch (receiptErr) {
      try {
        await persistTenantFallback(runId, tenantId, { status: 'succeeded' });
        succeeded += 1;
        logger.warn(`${jobLabel}: recovered the success receipt for tenant ${tenantId}`);
      } catch (fallbackErr) {
        unresolved += 1;
        failures.push(receiptErr, fallbackErr);
        logger.error(
          `${jobLabel}: succeeded but its outcome is unresolved for tenant ${tenantId}`,
          fallbackErr,
        );
      }
    }
  }

  const result = {
    runId: String(runId),
    tenantsDiscovered: tenantIds.length,
    tenantsRun: succeeded,
    errors: failed + unresolved,
  };
  try {
    await persistReceipt(() => recordAggregateFinished(runId, { succeeded, failed, unresolved }));
  } catch (receiptErr) {
    failures.push(receiptErr);
    throw fanoutError(
      jobLabel,
      runId,
      failures,
      `${jobLabel}: aggregate outcome receipt failed`,
      { ...result, errors: result.errors + 1 },
    );
  }
  if (failed > 0 || unresolved > 0) {
    throw fanoutError(
      jobLabel,
      runId,
      failures,
      unresolved > 0
        ? `${jobLabel}: ${failed} tenant run(s) failed; ${unresolved} outcome(s) unresolved`
        : `${jobLabel}: ${failed} tenant run(s) failed`,
      result,
    );
  }
  return result;
}

async function recordFleetFinished(runId, { status, failureCode = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `WITH updated AS (
       UPDATE scheduled_job_runs
          SET aggregate_status = $2::text,
              failure_code = $3::text,
              finished_at = NOW()
         WHERE id = $1::bigint
           AND scope = 'fleet'
           AND aggregate_status = 'running'
        RETURNING id
     )
     SELECT id FROM updated
     UNION ALL
     SELECT existing.id
       FROM scheduled_job_runs existing
      WHERE existing.id = $1::bigint
        AND existing.scope = 'fleet'
        AND existing.aggregate_status = $2::text
        AND existing.failure_code IS NOT DISTINCT FROM $3::text
        AND NOT EXISTS (SELECT 1 FROM updated)
      LIMIT 1`,
    runId,
    status,
    failureCode,
  );
  if (!rows?.length) throw new Error('Fleet scheduler outcome receipt was not persisted');
}

/**
 * Run a single-pass fleet job under the same durable receipt and failure
 * boundary `runForEachTenant` gives a per-tenant fan-out.
 *
 * Fleet jobs (audit-chain verification, results-inbox escalation) sweep every
 * tenant in one body rather than being fanned out, so they have no discovery
 * step and no per-tenant children. Migration 671 gives them their own row
 * shape in `scheduled_job_runs`: `scope='fleet'`, discovery permanently
 * 'pending', all tenant counters 0.
 *
 * The receipt is the point. `withJobLock` logs and swallows whatever this
 * throws, so before 671 a tick that failed and a tick that never fired left
 * exactly the same trace. Now the run row says which one happened, and a
 * success is never reported without its own persisted evidence.
 *
 * @param {string} label job label for the durable receipt and logs
 * @param {() => Promise<T>} fleetFn
 * @param {Object} [options]
 * @param {string} [options.lockKey=label] fleet advisory-lock key
 * @returns {Promise<{runId: string, result: T}>}
 */
export async function runFleetJob(label, fleetFn, { lockKey = label } = {}) {
  const jobLabel = normalizedLabel(label);
  const jobLockKey = normalizedLabel(lockKey);
  if (typeof fleetFn !== 'function') {
    throw new TypeError(`${jobLabel}: fleetFn must be a function`);
  }

  const runId = await createRun(jobLabel, jobLockKey, 'fleet');
  const failWith = async (err, status, fallbackCode, message) => {
    const failureCode = normalizedFailureCode(err, fallbackCode);
    try {
      await persistReceipt(() => recordFleetFinished(runId, { status, failureCode }));
    } catch (receiptErr) {
      throw fanoutError(
        jobLabel,
        runId,
        [err, receiptErr],
        `${message}, and its failure receipt also failed`,
        { runId: String(runId), scope: 'fleet' },
      );
    }
    throw fanoutError(jobLabel, runId, [err], message, { runId: String(runId), scope: 'fleet' });
  };

  try {
    await reconcileStaleRuns(runId);
  } catch (err) {
    await failWith(
      err,
      'reconciliation_failed',
      'STALE_RECONCILIATION_FAILED',
      `${jobLabel}: stale-run reconciliation failed`,
    );
  }

  let result;
  try {
    result = await fleetFn();
  } catch (err) {
    await failWith(err, 'job_failed', 'FLEET_JOB_FAILED', `${jobLabel}: fleet job failed`);
  }

  try {
    await persistReceipt(() => recordFleetFinished(runId, { status: 'succeeded' }));
  } catch (receiptErr) {
    throw fanoutError(
      jobLabel,
      runId,
      [receiptErr],
      `${jobLabel}: fleet job completed but its outcome receipt failed`,
      { runId: String(runId), scope: 'fleet' },
    );
  }
  return { runId: String(runId), result };
}

export default { runForEachTenant, runFleetJob };
