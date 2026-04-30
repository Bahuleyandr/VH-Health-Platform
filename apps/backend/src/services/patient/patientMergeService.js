/**
 * Patient merge workflow (Phase A2 PR2).
 *
 * Two-person workflow for executing a duplicate-record merge:
 *
 *   requested  ── approve ──▶  approved  ── execute ──▶  executed
 *        │                          │
 *        ├── cancel ─▶ cancelled   ├── reject ─▶ rejected
 *
 * The two-person rule (requester != approver) is enforced at the
 * service layer; the SQL CHECK only enforces "approved status implies
 * approver_uid is set". An admin who requested a merge cannot approve
 * their own merge.
 *
 * Execution scope (v1):
 *   - Reassign all active patient_identifiers from secondary → primary
 *     via patientIdentifierService.reassignIdentifiersForMerge.
 *   - Update FK columns on the most-referenced patient tables
 *     (configurable below). Each row count is recorded in
 *     execution_summary so an admin can audit which rows moved.
 *   - Mark the originating patient_duplicate_candidates row as
 *     status='merged' if a candidate_id was supplied.
 *
 * Out of scope for v1 (deferred):
 *   - Merging the users.uid row itself (the secondary user record stays
 *     in place for audit; new clinical data flows to the primary).
 *   - Sweeping every patient_uid FK in the schema. The configurable
 *     FK_TABLES list is intentionally small at first; extending it is
 *     adding entries, not changing this service. Tables referenced
 *     here are the ones a hospital actually queries day-to-day.
 *
 * Decision-support only: nothing here auto-publishes or auto-deletes;
 * every state change is audited and reversible by an admin until the
 * 'executed' status, which is intentionally one-way.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { reassignIdentifiersForMerge } from './patientIdentifierService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const MERGE_STATUSES = ['requested', 'approved', 'executed', 'rejected', 'cancelled'];

/**
 * The patient FK tables we sweep on a merge. (table, fk_column) pairs.
 * Add to this list as more tables onboard real patient_uid references —
 * each new entry adds one more row count to execution_summary without
 * any other code change.
 *
 * Skipped intentionally:
 *   - users itself (we do NOT delete the secondary user row in v1).
 *   - clinical_ai_* tables — these are advisory drafts; merging the
 *     underlying clinical FKs propagates them automatically.
 *   - tables without a tenant_id column — those need their own
 *     review for tenant-bleed risk before sweeping.
 */
const FK_TABLES = [
  ['appointments', 'patient_uid'],
  ['prescriptions', 'patient_uid'],
  ['investigations', 'uid'],
  ['consultations', 'patient_uid'],
  ['admissions', 'patient_uid'],
  ['diagnoses', 'patient_uid'],
  ['medical_records', 'patient_uid'],
  ['health_records', 'patient_uid'],
  ['patient_consents', 'patient_uid'],
  ['family_members', 'patient_uid'],
  ['patient_vitals', 'patient_uid'],
  ['payment_transactions', 'patient_uid'],
  ['invoices', 'patient_uid'],
];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isMissingColumnError(err) {
  return /column .* does not exist/i.test(String(err?.message || ''));
}

function safeText(value, max = 2000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

export async function requestMerge({
  tenantId = null,
  candidateId = null,
  primaryUid,
  secondaryUid,
  requestedBy = null,
  requesterNote = null,
  metadata = {},
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const primary = maybeUuid(primaryUid, 'primary_uid');
  const secondary = maybeUuid(secondaryUid, 'secondary_uid');
  if (!primary || !secondary) {
    throw AppError.badRequest('primary_uid and secondary_uid are required');
  }
  if (primary === secondary) {
    throw AppError.badRequest('primary_uid and secondary_uid must differ');
  }
  const cid = candidateId ? normalizeId(candidateId, 'candidate_id') : null;
  const cleanNote = safeText(requesterNote);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_merge_requests
       (tenant_id, candidate_id, primary_uid, secondary_uid, status,
        requested_by, requester_note, metadata)
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'requested', $5::uuid, $6, $7::jsonb)
     RETURNING id, tenant_id, candidate_id, primary_uid, secondary_uid,
               status, requested_by, requested_at, requester_note,
               metadata, created_at, updated_at`,
    tid, cid, primary, secondary, requestedBy, cleanNote,
    JSON.stringify(metadata || {}),
  );
  return rows[0];
}

export async function approveMerge({
  tenantId = null,
  id,
  approverUid = null,
  approverNote = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mid = normalizeId(id, 'merge_request id');
  const approver = maybeUuid(approverUid, 'approver_uid');
  if (!approver) throw AppError.badRequest('approver_uid is required');

  return await prisma.$transaction(async (tx) => {
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT id, status, requested_by FROM patient_merge_requests
       WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      mid, tid,
    );
    const existing = existingRows[0];
    if (!existing) throw AppError.notFound('Merge request not found');
    if (existing.status !== 'requested') {
      throw AppError.badRequest(`Merge request must be in 'requested' status to approve (was '${existing.status}')`);
    }
    if (existing.requested_by && String(existing.requested_by) === approver) {
      throw AppError.forbidden('Two-person rule: the requester cannot approve their own merge');
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE patient_merge_requests
       SET status = 'approved',
           approver_uid = $1::uuid,
           approved_at = NOW(),
           approver_note = $2,
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4::uuid AND status = 'requested'
       RETURNING id, tenant_id, candidate_id, primary_uid, secondary_uid,
                 status, requested_by, requested_at, requester_note,
                 approver_uid, approved_at, approver_note,
                 metadata, created_at, updated_at`,
      approver, safeText(approverNote), mid, tid,
    );
    return rows[0];
  });
}

export async function rejectMerge({
  tenantId = null,
  id,
  approverUid = null,
  rejectionReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mid = normalizeId(id, 'merge_request id');
  const approver = maybeUuid(approverUid, 'approver_uid');
  if (!approver) throw AppError.badRequest('approver_uid is required');

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE patient_merge_requests
     SET status = 'rejected',
         approver_uid = $1::uuid,
         approved_at = NOW(),
         rejection_reason = $2,
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid AND status = 'requested'
     RETURNING id, primary_uid, secondary_uid, status, rejection_reason,
               approver_uid, approved_at`,
    approver, safeText(rejectionReason), mid, tid,
  );
  if (!rows[0]) throw AppError.notFound('Merge request in requested status not found');
  return rows[0];
}

export async function cancelMerge({
  tenantId = null,
  id,
  cancelledBy = null,
  reason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mid = normalizeId(id, 'merge_request id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE patient_merge_requests
     SET status = 'cancelled',
         updated_at = NOW(),
         metadata = jsonb_set(
           metadata,
           '{cancelled_by}',
           to_jsonb(COALESCE($1::text, '')::text),
           true
         ),
         rejection_reason = COALESCE($2, rejection_reason)
     WHERE id = $3 AND tenant_id = $4::uuid AND status IN ('requested', 'approved')
     RETURNING id, primary_uid, secondary_uid, status, rejection_reason,
               metadata, updated_at`,
    cancelledBy ? String(cancelledBy) : null,
    safeText(reason),
    mid, tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Merge request must be in requested or approved status to cancel');
  }
  return rows[0];
}

/**
 * Execute an approved merge. Runs identifier reassignment + FK sweeps
 * across `FK_TABLES` in a single transaction. If any step fails, the
 * whole transaction rolls back and the merge stays in 'approved' status
 * so the admin can retry after fixing the error.
 */
export async function executeMerge({
  tenantId = null,
  id,
  executorUid = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mid = normalizeId(id, 'merge_request id');
  const executor = maybeUuid(executorUid, 'executor_uid');
  if (!executor) throw AppError.badRequest('executor_uid is required');

  return await prisma.$transaction(async (tx) => {
    const existingRows = await tx.$queryRawUnsafe(
      `SELECT id, status, candidate_id, primary_uid, secondary_uid, approver_uid
       FROM patient_merge_requests
       WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      mid, tid,
    );
    const existing = existingRows[0];
    if (!existing) throw AppError.notFound('Merge request not found');
    if (existing.status !== 'approved') {
      throw AppError.badRequest(`Merge request must be in 'approved' status to execute (was '${existing.status}')`);
    }
    const primary = existing.primary_uid;
    const secondary = existing.secondary_uid;

    // Identifier reassignment first — that's where the unique-active
    // constraint is enforced; conflicts there mean a manual review is
    // needed before the row sweep.
    const identifierResult = await reassignIdentifiersForMerge(tx, {
      tenantId: tid,
      primaryUid: primary,
      secondaryUid: secondary,
    });

    // Then sweep the FK tables. Skip tables that don't exist or that
    // don't have the expected FK column — onboarding hospitals run on
    // schemas that may not yet have every table.
    const tableSummary = {};
    let totalRowsMoved = identifierResult.count;
    for (const [table, column] of FK_TABLES) {
      try {
        const rows = await tx.$queryRawUnsafe(
          `UPDATE ${table}
           SET ${column} = $1::uuid
           WHERE ${column} = $2::uuid
           RETURNING 1`,
          primary, secondary,
        );
        const moved = rows.length;
        tableSummary[table] = { rows_moved: moved, fk_column: column };
        totalRowsMoved += moved;
      } catch (err) {
        if (isMissingSchemaError(err) || isMissingColumnError(err)) {
          tableSummary[table] = { rows_moved: 0, fk_column: column, skipped: 'schema_unavailable' };
          continue;
        }
        // Anything else aborts the merge — the transaction will roll back.
        logger.error('patient merge FK sweep failed', { table, column, error: err.message });
        throw err;
      }
    }

    const summary = {
      identifiers_reassigned: identifierResult.count,
      total_rows_moved: totalRowsMoved,
      table_summary: tableSummary,
    };

    const rows = await tx.$queryRawUnsafe(
      `UPDATE patient_merge_requests
       SET status = 'executed',
           executor_uid = $1::uuid,
           executed_at = NOW(),
           execution_summary = $2::jsonb,
           updated_at = NOW()
       WHERE id = $3 AND tenant_id = $4::uuid AND status = 'approved'
       RETURNING id, candidate_id, primary_uid, secondary_uid, status,
                 approver_uid, approved_at, executor_uid, executed_at,
                 execution_summary, requested_by, requested_at,
                 created_at, updated_at`,
      executor, JSON.stringify(summary), mid, tid,
    );
    const updated = rows[0];
    if (!updated) throw AppError.conflict('Merge request status changed mid-execution');

    // Close the originating candidate (if any) so it disappears from the
    // open queue.
    if (existing.candidate_id) {
      await tx.$queryRawUnsafe(
        `UPDATE patient_duplicate_candidates
         SET status = 'merged',
             decided_by = $1::uuid,
             decided_at = NOW(),
             decision_note = COALESCE(decision_note, 'merged via merge_request id=' || $2::text),
             updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4::uuid AND status = 'open'`,
        executor, String(mid), existing.candidate_id, tid,
      );
    }

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export async function listMergeRequests({
  tenantId = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    if (!MERGE_STATUSES.includes(String(status))) {
      throw AppError.badRequest(`status must be one of: ${MERGE_STATUSES.join(', ')}`);
    }
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, candidate_id, primary_uid, secondary_uid,
              status, requested_by, requested_at, requester_note,
              approver_uid, approved_at, approver_note,
              executor_uid, executed_at, execution_summary,
              rejection_reason, metadata, created_at, updated_at
       FROM patient_merge_requests
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { merge_requests: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { merge_requests: [], count: 0 };
    throw err;
  }
}

export async function getMergeRequest({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const mid = normalizeId(id, 'merge_request id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, candidate_id, primary_uid, secondary_uid,
            status, requested_by, requested_at, requester_note,
            approver_uid, approved_at, approver_note,
            executor_uid, executed_at, execution_summary,
            rejection_reason, metadata, created_at, updated_at
     FROM patient_merge_requests
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    mid, tid,
  );
  if (!rows[0]) throw AppError.notFound('Merge request not found');
  return rows[0];
}

export const __testing__ = {
  FK_TABLES,
  MERGE_STATUSES,
};

export default {
  approveMerge,
  cancelMerge,
  executeMerge,
  getMergeRequest,
  listMergeRequests,
  rejectMerge,
  requestMerge,
};
