// src/services/billing/revenueCycleTrackerService.js
//
// Revenue-cycle standing-queue tracker (Forward #3 core).
// READ-MODEL ONLY — derives current_stage from existing PA + appeal artifacts.
// Never submits, never generates AI drafts, never auto-advances.
//
// DEFERRED: per-stage auto-generation triggers (coding→denial→PA threshold
// logic that creates the next draft) require human-in-loop design and are
// explicitly NOT built here. See docs/REVENUE_CYCLE_ROADMAP.md when ready.

import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const TERMINAL_APPEAL_STATUSES = new Set(['approved', 'denied', 'withdrawn']);
const RESOLVED_PA_STATUSES = new Set(['approved', 'withdrawn']);
const LIMIT_CAP = 500;

function resolveTenantId(t) {
  return t || DEFAULT_TENANT_ID;
}

/**
 * Derive current_stage + status from a prior-auth row + optional appeal row.
 * Pure function — no DB calls.
 */
export function deriveStage(pa, appeal) {
  if (appeal) {
    if (TERMINAL_APPEAL_STATUSES.has(appeal.appeal_status)) {
      return { current_stage: 'resolved', status: 'resolved' };
    }
    return { current_stage: 'appeal', status: 'open' };
  }
  if (pa.status === 'denied') {
    return { current_stage: 'appeal', status: 'open' }; // denied PA awaiting appeal
  }
  if (RESOLVED_PA_STATUSES.has(pa.status)) {
    return { current_stage: 'resolved', status: 'resolved' };
  }
  return { current_stage: 'prior_auth', status: 'open' };
}

/**
 * Load all prior-auth rows for a tenant.
 */
async function loadPriorAuths(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid::text AS patient_uid, procedure_code, payer_name, status
       FROM clinical_ai_prior_auth_requests
      WHERE tenant_id = $1::uuid
      ORDER BY id ASC`,
    tenantId,
  );
  return rows;
}

/**
 * Load appeal for a given prior_auth_id (at most one per uq_appeal_prior_auth
 * partial unique index on migration 313).
 */
async function loadAppeal(tenantId, priorAuthId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, appeal_status
       FROM clinical_ai_appeal_letters
      WHERE tenant_id = $1::uuid AND prior_auth_id = $2
      LIMIT 1`,
    tenantId,
    priorAuthId,
  );
  return rows[0] || null;
}

/**
 * Load the existing revenue_cycle_runs row for a case_key (to detect stage changes).
 */
async function loadExistingRun(tenantId, caseKey) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, current_stage, status, stage_history
       FROM revenue_cycle_runs
      WHERE tenant_id = $1::uuid AND case_key = $2
      LIMIT 1`,
    tenantId,
    caseKey,
  );
  return rows[0] || null;
}

/**
 * Build an updated stage_history array: append an entry only when the stage
 * has changed from the previous value. Returns updated array.
 */
function buildStageHistory(existingRow, newStage) {
  let history = [];
  if (existingRow) {
    const raw = existingRow.stage_history;
    history = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
  }
  const prevStage = existingRow?.current_stage;
  if (prevStage && prevStage !== newStage) {
    history = [...history, { stage: newStage, transitioned_at: new Date().toISOString() }];
  } else if (!existingRow) {
    // First time seen — record the initial stage.
    history = [{ stage: newStage, transitioned_at: new Date().toISOString() }];
  }
  return history;
}

/**
 * UPSERT one revenue_cycle_runs row.
 * ON CONFLICT (tenant_id, case_key) updates in place — no duplicates.
 * Uses two SQL variants (resolved vs open) to avoid template literals in SQL.
 */
async function upsertRun(tenantId, pa, appeal, existing, derived) {
  const caseKey = `prior_auth:${pa.id}`;
  const stageHistory = buildStageHistory(existing, derived.current_stage);
  const historyJson = JSON.stringify(stageHistory);
  const isResolved = derived.status === 'resolved';

  if (isResolved) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO revenue_cycle_runs
         (tenant_id, case_key, patient_uid, current_stage, status, payer_name,
          prior_auth_id, appeal_id,
          stage_history, last_evaluated_at, resolved_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6,
               $7, $8,
               $9::jsonb, NOW(), NOW(), NOW())
       ON CONFLICT (tenant_id, case_key) DO UPDATE SET
         current_stage        = EXCLUDED.current_stage,
         status               = EXCLUDED.status,
         payer_name           = EXCLUDED.payer_name,
         prior_auth_id        = EXCLUDED.prior_auth_id,
         appeal_id            = EXCLUDED.appeal_id,
         patient_uid          = EXCLUDED.patient_uid,
         stage_history        = EXCLUDED.stage_history,
         last_evaluated_at    = NOW(),
         resolved_at          = NOW(),
         updated_at           = NOW()`,
      tenantId,
      caseKey,
      pa.patient_uid,
      derived.current_stage,
      derived.status,
      pa.payer_name || null,
      pa.id,
      appeal ? appeal.id : null,
      historyJson,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO revenue_cycle_runs
         (tenant_id, case_key, patient_uid, current_stage, status, payer_name,
          prior_auth_id, appeal_id,
          stage_history, last_evaluated_at, resolved_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6,
               $7, $8,
               $9::jsonb, NOW(), NULL, NOW())
       ON CONFLICT (tenant_id, case_key) DO UPDATE SET
         current_stage        = EXCLUDED.current_stage,
         status               = EXCLUDED.status,
         payer_name           = EXCLUDED.payer_name,
         prior_auth_id        = EXCLUDED.prior_auth_id,
         appeal_id            = EXCLUDED.appeal_id,
         patient_uid          = EXCLUDED.patient_uid,
         stage_history        = EXCLUDED.stage_history,
         last_evaluated_at    = NOW(),
         resolved_at          = NULL,
         updated_at           = NOW()`,
      tenantId,
      caseKey,
      pa.patient_uid,
      derived.current_stage,
      derived.status,
      pa.payer_name || null,
      pa.id,
      appeal ? appeal.id : null,
      historyJson,
    );
  }
}

/**
 * Run the full revenue-cycle sweep for a tenant.
 * Scans all clinical_ai_prior_auth_requests, looks up appeals, derives stage,
 * and UPSERTs revenue_cycle_runs. Advisory tracker only — never acts.
 *
 * @param {{ tenantId?: string }} options
 * @returns {{ processed: number, errors: number }}
 */
export async function runRevenueCycleSweep({ tenantId } = {}) {
  const tid = resolveTenantId(tenantId);
  let processed = 0;
  let errors = 0;

  try {
    const priorAuths = await loadPriorAuths(tid);
    if (!priorAuths.length) {
      logger.info('revenue-cycle-tracker-sweep: no prior-auth rows', { tenantId: tid });
      return { processed: 0, errors: 0 };
    }

    for (const pa of priorAuths) {
      const caseKey = `prior_auth:${pa.id}`;
      try {
        const appeal = await loadAppeal(tid, pa.id);
        const existing = await loadExistingRun(tid, caseKey);
        const derived = deriveStage(pa, appeal);

        await setTenant(tid, async () => {
          await upsertRun(tid, pa, appeal, existing, derived);
        });

        processed++;
      } catch (err) {
        errors++;
        logger.error('revenue-cycle-tracker-sweep: upsert error', { caseKey, err: err.message });
      }
    }

    logger.info('revenue-cycle-tracker-sweep complete', { tenantId: tid, processed, errors });
  } catch (err) {
    logger.error('revenue-cycle-tracker-sweep: fatal error', { tenantId: tid, err: err.message });
    errors++;
  }

  return { processed, errors };
}

/**
 * List revenue_cycle_runs for a tenant, optionally filtered by status/stage.
 * Ordered by last_evaluated_at DESC (most recently swept first).
 *
 * @param {{ tenantId?: string, status?: string, stage?: string, limit?: number }}
 * @returns {{ runs: object[], count: number }}
 */
export async function listRevenueCycleRuns({ tenantId, status, stage, limit } = {}) {
  const tid = resolveTenantId(tenantId);
  const cap = Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 50, LIMIT_CAP);

  let sql = `SELECT id, tenant_id::text, case_key, patient_uid::text, current_stage,
                    status, payer_name, claim_id, coding_generation_id,
                    denial_risk_generation_id, prior_auth_id, appeal_id,
                    stage_history, metadata,
                    first_seen_at, last_evaluated_at, resolved_at, created_at, updated_at
               FROM revenue_cycle_runs
              WHERE tenant_id = $1::uuid`;
  const params = [tid];

  if (status) {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  if (stage) {
    params.push(stage);
    sql += ` AND current_stage = $${params.length}`;
  }

  params.push(cap);
  sql += ` ORDER BY last_evaluated_at DESC, id DESC LIMIT $${params.length}`;

  const runs = await prisma.$queryRawUnsafe(sql, ...params);
  return { runs, count: runs.length };
}

/**
 * Get a single revenue_cycle_runs row by numeric id OR by case_key.
 * Exactly one of `id` or `caseKey` must be provided.
 *
 * @param {{ tenantId?: string, id?: number, caseKey?: string }}
 * @returns {object|null}
 */
export async function getRevenueCycleRun({ tenantId, id, caseKey } = {}) {
  const tid = resolveTenantId(tenantId);

  if (id != null) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text, case_key, patient_uid::text, current_stage,
              status, payer_name, claim_id, coding_generation_id,
              denial_risk_generation_id, prior_auth_id, appeal_id,
              stage_history, metadata,
              first_seen_at, last_evaluated_at, resolved_at, created_at, updated_at
         FROM revenue_cycle_runs
        WHERE tenant_id = $1::uuid AND id = $2
        LIMIT 1`,
      tid,
      Number(id),
    );
    return rows[0] || null;
  }

  if (caseKey != null) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text, case_key, patient_uid::text, current_stage,
              status, payer_name, claim_id, coding_generation_id,
              denial_risk_generation_id, prior_auth_id, appeal_id,
              stage_history, metadata,
              first_seen_at, last_evaluated_at, resolved_at, created_at, updated_at
         FROM revenue_cycle_runs
        WHERE tenant_id = $1::uuid AND case_key = $2
        LIMIT 1`,
      tid,
      caseKey,
    );
    return rows[0] || null;
  }

  return null;
}
