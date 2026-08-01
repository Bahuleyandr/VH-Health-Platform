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

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { reassignIdentifiersForMerge } from './patientIdentifierService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const MERGE_STATUSES = ['requested', 'approved', 'executed', 'rejected', 'cancelled'];
const CONTINUITY_PROPOSER_ROLES = new Set([
  'SUPER_ADMIN', 'ADMIN', 'MEDICAL_RECORDS', 'RECEPTIONIST',
  'RECEPTION_INCHARGE', 'ADMISSION_OFFICER',
]);
const CONTINUITY_DOCTOR_APPROVER_ROLES = new Set([
  'DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT',
  'MEDICAL_SUPERINTENDENT', 'CMO',
]);

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
  return requireTenantId(options.tenantId);
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

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

async function setContinuityFacilityTx(tx, facilityId) {
  const facility = normalizeId(facilityId, 'facility_id');
  await tx.$executeRawUnsafe(
    `SELECT set_config('app.current_facility_id', $1, true)`,
    String(facility),
  );
  return facility;
}

function requireContinuityRole(role, allowed, code) {
  const normalized = normalizeRole(role);
  if (!allowed.has(normalized)) {
    throw AppError.forbidden('Continuity identity merge was denied', code, { safe: true });
  }
  return normalized;
}

async function requiredContinuityMergeAudit(tx, input) {
  const { recordClinicalAuditEvent } = await import('../clinical/canonicalClinicalPlatformService.js');
  const audit = await recordClinicalAuditEvent(input, { db: tx });
  if (!audit) {
    throw AppError.internal('Continuity merge audit was not recorded', 'CONTINUITY_MERGE_AUDIT_REQUIRED');
  }
  return audit;
}

export async function requestContinuityMerge({
  tenantId = null,
  facilityId,
  incidentId,
  packetId,
  paperItemRowId,
  temporaryIdentityId,
  targetPatientUid,
  requestedBy,
  requesterRole,
  requesterNote = null,
  requestId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const requester = maybeUuid(requestedBy, 'requested_by');
  const role = requireContinuityRole(
    requesterRole,
    CONTINUITY_PROPOSER_ROLES,
    'CONTINUITY_MERGE_PROPOSER_ROLE_DENIED',
  );
  const incident = maybeUuid(incidentId, 'incident_id');
  const packet = maybeUuid(packetId, 'packet_id');
  const paperItem = maybeUuid(paperItemRowId, 'paper_item_row_id');
  const temporaryIdentity = maybeUuid(temporaryIdentityId, 'temporary_identity_id');
  const target = maybeUuid(targetPatientUid, 'target_patient_uid');
  if (!requester || !incident || !packet || !paperItem || !temporaryIdentity || !target) {
    throw AppError.badRequest('Continuity merge identity is incomplete');
  }
  return setTenantTx(tid, async tx => {
    const facility = await setContinuityFacilityTx(tx, facilityId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT temp.*, incident.lifecycle_state, paper.id AS linked_paper_item_id,
              patient.uid::text AS target_patient_uid
         FROM clinical_continuity_temporary_identities AS temp
         JOIN clinical_continuity_incidents AS incident
           ON incident.tenant_id = temp.tenant_id
          AND incident.facility_id = temp.facility_id
          AND incident.id = temp.incident_id
         JOIN clinical_continuity_paper_items AS paper
           ON paper.tenant_id = temp.tenant_id
          AND paper.facility_id = temp.facility_id
          AND paper.incident_id = temp.incident_id
          AND paper.paper_item_id = temp.paper_item_id
         JOIN users AS patient
           ON patient.tenant_id = temp.tenant_id
          AND patient.uid = $7::uuid
          AND patient.role = 'PATIENT'
        WHERE temp.tenant_id = $1::uuid AND temp.facility_id = $2::integer
          AND temp.incident_id = $3::uuid AND temp.packet_id = $4::uuid
          AND paper.id = $5::uuid AND temp.id = $6::uuid
        FOR UPDATE OF temp, incident, paper`,
      tid,
      facility,
      incident,
      packet,
      paperItem,
      temporaryIdentity,
      target,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Continuity temporary identity was not found');
    if (!['restored', 'reconciling'].includes(current.lifecycle_state)) {
      throw AppError.conflict('Service must be restored before identity matching', 'CONTINUITY_MERGE_RESTORATION_REQUIRED');
    }
    if (current.identity_status !== 'unresolved') {
      throw AppError.conflict('Temporary identity is already in a merge workflow', 'CONTINUITY_MERGE_ALREADY_REQUESTED');
    }
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO patient_merge_requests (
         tenant_id, primary_uid, secondary_uid, status, requested_by,
         requester_note, metadata, continuity_facility_id,
         continuity_incident_id, continuity_packet_id,
         continuity_paper_item_row_id, continuity_temporary_identity_id,
         requester_role, continuity_disposition
       ) VALUES (
         $1::uuid, $2::uuid, NULL, 'requested', $3::uuid,
         $4, $5::jsonb, $6::integer,
         $7::uuid, $8::uuid, $9::uuid, $10::uuid,
         $11, 'proposed'
       ) RETURNING *`,
      tid,
      target,
      requester,
      safeText(requesterNote),
      JSON.stringify({ source: 'clinical_continuity_temporary_identity', append_only_alias: true }),
      facility,
      incident,
      packet,
      paperItem,
      temporaryIdentity,
      role,
    );
    const request = inserted[0];
    await tx.$executeRawUnsafe(
      `UPDATE clinical_continuity_temporary_identities
          SET identity_status = 'proposed', merge_request_id = $1::integer,
              updated_by = $2::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid`,
      request.id,
      requester,
      tid,
      facility,
      temporaryIdentity,
    );
    const decisions = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_patient_merge_decisions (
         tenant_id, facility_id, incident_id, merge_request_id,
         temporary_identity_id, decision, actor_uid, actor_role,
         target_patient_uid
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::integer,
         $5::uuid, 'proposed', $6::uuid, $7, $8::uuid
       ) RETURNING *`,
      tid,
      facility,
      incident,
      request.id,
      temporaryIdentity,
      requester,
      role,
      target,
    );
    const audit = await requiredContinuityMergeAudit(tx, {
      tenantId: tid,
      action: 'clinical_continuity.identity_merge.proposed',
      actorUid: requester,
      actorRole: role,
      resourceType: 'patient_merge_request',
      resourceTable: 'patient_merge_requests',
      resourceId: request.id,
      requestId,
      afterState: {
        incident_id: incident,
        temporary_identity_id: temporaryIdentity,
        target_patient_uid: target,
        requester_role: role,
      },
      idempotencyKey: `cc-merge:${request.id}:proposed`,
    });
    return { merge_request: request, decision: decisions[0], audit_event_id: audit.id };
  }, { isolationLevel: 'Serializable' });
}

export async function approveContinuityMerge({
  tenantId = null,
  facilityId,
  id,
  approvedBy,
  approverRole,
  approverNote = null,
  requestId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mergeId = normalizeId(id, 'merge_request id');
  const approver = maybeUuid(approvedBy, 'approved_by');
  const role = normalizeRole(approverRole);
  return setTenantTx(tid, async tx => {
    const facility = await setContinuityFacilityTx(tx, facilityId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT request.*, incident.lifecycle_state, config.clinical_safety_lead_uid::text
         FROM patient_merge_requests AS request
         JOIN clinical_continuity_incidents AS incident
           ON incident.tenant_id = request.tenant_id
          AND incident.facility_id = request.continuity_facility_id
          AND incident.id = request.continuity_incident_id
         JOIN clinical_continuity_reconciliation_config AS config
           ON config.tenant_id = request.tenant_id
          AND config.facility_id = request.continuity_facility_id
        WHERE request.tenant_id = $1::uuid AND request.id = $2::integer
          AND request.continuity_facility_id = $3::integer
        FOR UPDATE OF request, incident, config`,
      tid,
      mergeId,
      facility,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Continuity merge request not found');
    if (current.status !== 'requested' || current.continuity_disposition !== 'proposed') {
      throw AppError.conflict('Continuity merge is not awaiting approval', 'CONTINUITY_MERGE_STATUS_INVALID');
    }
    if (!['restored', 'reconciling'].includes(current.lifecycle_state)) {
      throw AppError.conflict('Service must remain restored during identity approval', 'CONTINUITY_MERGE_RESTORATION_REQUIRED');
    }
    if (!approver || current.requested_by === approver) {
      throw AppError.conflict('Requester and approver must be distinct', 'CONTINUITY_MERGE_ACTOR_SEPARATION_REQUIRED');
    }
    const safetyLead = current.clinical_safety_lead_uid === approver;
    if (!CONTINUITY_DOCTOR_APPROVER_ROLES.has(role) && !safetyLead) {
      throw AppError.forbidden('Continuity merge approver role was denied', 'CONTINUITY_MERGE_APPROVER_ROLE_DENIED');
    }
    if (!safetyLead) {
      const relationship = await tx.$queryRawUnsafe(
        `SELECT EXISTS (
           SELECT 1
             FROM care_team_members AS member
             JOIN care_teams AS team
               ON team.tenant_id = member.tenant_id
              AND team.id = member.care_team_id
              AND team.patient_uid = member.patient_uid
            WHERE member.tenant_id = $1::uuid
              AND member.patient_uid = $2::uuid
              AND member.staff_uid = $3::uuid
              AND member.status = 'active'
              AND member.active_from <= clock_timestamp()
              AND (member.active_until IS NULL OR member.active_until > clock_timestamp())
              AND team.status = 'active'
           UNION ALL
           SELECT 1
             FROM patient_encounters AS encounter
            WHERE encounter.tenant_id = $1::uuid
              AND encounter.patient_uid = $2::uuid
              AND encounter.status IN ('open', 'active')
              AND (
                encounter.primary_doctor_uid = $3::uuid
                OR $3::uuid = ANY(encounter.care_team_uids)
              )
         ) AS treating_doctor`,
        tid,
        current.primary_uid,
        approver,
      );
      if (relationship[0]?.treating_doctor !== true) {
        throw AppError.forbidden(
          'Continuity merge requires the treating doctor or configured clinical safety lead',
          'CONTINUITY_MERGE_TREATING_DOCTOR_REQUIRED',
          { safe: true },
        );
      }
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE patient_merge_requests
          SET status = 'approved', approver_uid = $1::uuid,
              approver_role = $2, approver_note = $3,
              approved_at = clock_timestamp(), continuity_disposition = 'approved',
              updated_at = clock_timestamp()
        WHERE tenant_id = $4::uuid AND id = $5::integer AND status = 'requested'
        RETURNING *`,
      approver,
      safetyLead ? 'role:clinical_safety_lead' : role,
      safeText(approverNote),
      tid,
      mergeId,
    );
    const decisions = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_patient_merge_decisions (
         tenant_id, facility_id, incident_id, merge_request_id,
         temporary_identity_id, decision, actor_uid, actor_role,
         target_patient_uid
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::integer,
         $5::uuid, 'approved', $6::uuid, $7, $8::uuid
       ) RETURNING *`,
      tid,
      facility,
      current.continuity_incident_id,
      mergeId,
      current.continuity_temporary_identity_id,
      approver,
      safetyLead ? 'role:clinical_safety_lead' : role,
      current.primary_uid,
    );
    const audit = await requiredContinuityMergeAudit(tx, {
      tenantId: tid,
      action: 'clinical_continuity.identity_merge.approved',
      actorUid: approver,
      actorRole: safetyLead ? 'role:clinical_safety_lead' : role,
      resourceType: 'patient_merge_request',
      resourceTable: 'patient_merge_requests',
      resourceId: mergeId,
      requestId,
      afterState: { continuity_disposition: 'approved', approver_role: updated[0].approver_role },
      idempotencyKey: `cc-merge:${mergeId}:approved`,
    });
    return { merge_request: updated[0], decision: decisions[0], audit_event_id: audit.id };
  }, { isolationLevel: 'Serializable' });
}

export async function executeContinuityMerge({
  tenantId = null,
  facilityId,
  id,
  executedBy,
  executorRole,
  requestId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mergeId = normalizeId(id, 'merge_request id');
  const executor = maybeUuid(executedBy, 'executed_by');
  const role = requireContinuityRole(
    executorRole,
    CONTINUITY_PROPOSER_ROLES,
    'CONTINUITY_MERGE_EXECUTOR_ROLE_DENIED',
  );
  return setTenantTx(tid, async tx => {
    const facility = await setContinuityFacilityTx(tx, facilityId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT request.*, temp.identity_status, temp.matched_patient_uid::text,
              incident.lifecycle_state, patient.uid::text AS target_patient_uid
         FROM patient_merge_requests AS request
         JOIN clinical_continuity_temporary_identities AS temp
           ON temp.tenant_id = request.tenant_id
          AND temp.facility_id = request.continuity_facility_id
          AND temp.id = request.continuity_temporary_identity_id
         JOIN clinical_continuity_incidents AS incident
           ON incident.tenant_id = request.tenant_id
          AND incident.facility_id = request.continuity_facility_id
          AND incident.id = request.continuity_incident_id
         JOIN users AS patient
           ON patient.tenant_id = request.tenant_id
          AND patient.uid = request.primary_uid
          AND patient.role = 'PATIENT'
        WHERE request.tenant_id = $1::uuid AND request.id = $2::integer
          AND request.continuity_facility_id = $3::integer
        FOR UPDATE OF request, temp, incident`,
      tid,
      mergeId,
      facility,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Continuity merge request not found');
    if (
      current.status !== 'approved'
      || current.continuity_disposition !== 'approved'
      || current.identity_status !== 'proposed'
      || !current.approver_uid
      || current.requested_by === current.approver_uid
      || !['restored', 'reconciling'].includes(current.lifecycle_state)
    ) {
      throw AppError.conflict('Continuity merge failed its fresh conflict check', 'CONTINUITY_MERGE_CONFLICT');
    }
    await tx.$executeRawUnsafe(
      `UPDATE clinical_continuity_temporary_identities
          SET identity_status = 'matched', matched_patient_uid = $1::uuid,
              updated_by = $2::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid
          AND identity_status = 'proposed'`,
      current.primary_uid,
      executor,
      tid,
      facility,
      current.continuity_temporary_identity_id,
    );
    const summary = {
      continuity_identity_alias: true,
      historical_rows_rewritten: 0,
      target_patient_uid: current.primary_uid,
      temporary_identity_id: current.continuity_temporary_identity_id,
    };
    const updated = await tx.$queryRawUnsafe(
      `UPDATE patient_merge_requests
          SET status = 'executed', executor_uid = $1::uuid,
              executed_at = clock_timestamp(), execution_summary = $2::jsonb,
              continuity_disposition = 'executed', updated_at = clock_timestamp()
        WHERE tenant_id = $3::uuid AND id = $4::integer AND status = 'approved'
        RETURNING *`,
      executor,
      JSON.stringify(summary),
      tid,
      mergeId,
    );
    const decisions = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_patient_merge_decisions (
         tenant_id, facility_id, incident_id, merge_request_id,
         temporary_identity_id, decision, actor_uid, actor_role,
         target_patient_uid
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::integer,
         $5::uuid, 'executed', $6::uuid, $7, $8::uuid
       ) RETURNING *`,
      tid,
      facility,
      current.continuity_incident_id,
      mergeId,
      current.continuity_temporary_identity_id,
      executor,
      role,
      current.primary_uid,
    );
    const audit = await requiredContinuityMergeAudit(tx, {
      tenantId: tid,
      patientUid: current.primary_uid,
      action: 'clinical_continuity.identity_merge.executed',
      actorUid: executor,
      actorRole: role,
      resourceType: 'patient_merge_request',
      resourceTable: 'patient_merge_requests',
      resourceId: mergeId,
      requestId,
      afterState: summary,
      idempotencyKey: `cc-merge:${mergeId}:executed`,
    });
    return { merge_request: updated[0], decision: decisions[0], audit_event_id: audit.id };
  }, { isolationLevel: 'Serializable' });
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

  return await setTenantTx(requireTenantId(tid), async (tx) => {
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

  return await setTenantTx(requireTenantId(tid), async (tx) => {
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
  CONTINUITY_PROPOSER_ROLES,
  CONTINUITY_DOCTOR_APPROVER_ROLES,
};

export default {
  approveMerge,
  approveContinuityMerge,
  cancelMerge,
  executeMerge,
  executeContinuityMerge,
  getMergeRequest,
  listMergeRequests,
  rejectMerge,
  requestMerge,
  requestContinuityMerge,
};
