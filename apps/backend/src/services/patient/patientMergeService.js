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
 * Execution scope (v2, Phase-3 deep-review rework):
 *   - Retarget all active patient_identifiers of the secondary to the
 *     survivor via patientIdentifierService.reassignIdentifiersForMerge
 *     (rows keep their original patient_uid for un-merge provenance and
 *     stay resolvable through lookupByIdentifier).
 *   - Sweep every patient_uid / patient_id column in the live schema,
 *     discovered from the catalog at execution time (see
 *     discoverMergeSweepTargets) — not a hand-picked table list. The
 *     sweep runs under SET CONSTRAINTS ALL DEFERRED (migration 634 made
 *     the composite patient_uid FKs deferrable) so parent+child rows
 *     re-point consistently at COMMIT. Each row count is recorded in
 *     execution_summary so an admin can audit which rows moved.
 *   - Deactivate the secondary patient record (is_active=false,
 *     status='merged', merged_into_uid=survivor) in the same
 *     transaction, and post-commit revoke its live JWTs.
 *   - Emit one clinical_timeline_events row + one clinical_audit_events
 *     row for the survivor in the same transaction (canonical clinical
 *     timeline invariant).
 *   - Mark the originating patient_duplicate_candidates row as
 *     status='merged' if a candidate_id was supplied.
 *
 * Deliberately not swept (see MERGE_SWEEP_EXCLUDED_*):
 *   - Append-only tables (audit trails + canonical timeline): history
 *     stays recorded under the uid it happened to, with the merge
 *     timeline/audit pair as the cross-reference. Timeline reads that
 *     union merged-away uids are reader-side follow-up work.
 *   - clinical_continuity_* tables: continuity identities merge through
 *     the alias-based executeContinuityMerge flow above, and the tables
 *     sit behind facility-scoped fail-closed RLS. If continuity rows
 *     still reference the secondary through a composite FK, the merge
 *     fails closed at COMMIT rather than splitting the chart.
 *
 * Decision-support only: nothing here auto-publishes or auto-deletes;
 * every state change is audited and reversible by an admin until the
 * 'executed' status, which is intentionally one-way.
 */

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { revokeAllUserTokens } from '../../utils/tokenBlacklist.js';
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
 * Tables the merge FK sweep must NOT touch even though they carry a
 * patient_uid / patient_id column.
 *
 *   - users: the survivor row is untouched and the secondary row is
 *     deactivated explicitly (uid itself never changes).
 *   - patient_identifiers: dedicated provenance-preserving handler
 *     (reassignIdentifiersForMerge).
 *   - patient_merge_requests / patient_duplicate_candidates: merge
 *     bookkeeping — their uid columns record which records were merged.
 */
const MERGE_SWEEP_EXCLUDED_TABLES = new Set([
  'users',
  'patient_identifiers',
  'patient_merge_requests',
  'patient_duplicate_candidates',
]);

/**
 * clinical_continuity_*: continuity temporary identities merge through the
 * alias-based continuity workflow (executeContinuityMerge), never by row
 * rewrite, and the tables sit behind facility-scoped fail-closed RLS the
 * merge transaction does not carry.
 */
const MERGE_SWEEP_EXCLUDED_PREFIXES = ['clinical_continuity_'];

/**
 * Discover every (table, column) the merge must re-point, from the live
 * catalog rather than a hand-picked list: all public patient_uid uuid
 * columns and patient_id int columns (both name-conventions are the
 * patient FK contract in this codebase — readers key on them, e.g.
 * investigations is queried by patient_id/patient_uid). Also covers raw-SQL
 * tables that exist outside the Prisma schema, and skips anything under an
 * append-only guard (audit trails + canonical timeline, migrations
 * 324/599): those guards only fire for the non-superuser prod role, so the
 * skip must be by catalog inspection, not by trying the UPDATE.
 */
async function discoverMergeSweepTargets(tx) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT c.relname AS table_name,
            a.attname AS column_name,
            (a.atttypid = 'uuid'::regtype) AS is_uuid,
            EXISTS (
              SELECT 1 FROM pg_attribute t
              WHERE t.attrelid = c.oid AND t.attname = 'tenant_id' AND NOT t.attisdropped
            ) AS has_tenant_id,
            EXISTS (
              SELECT 1 FROM pg_trigger g
              WHERE g.tgrelid = c.oid AND NOT g.tgisinternal
                AND g.tgfoid = COALESCE(to_regproc('audit_append_only_guard'), 0)
            ) AS append_only
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     JOIN pg_attribute a ON a.attrelid = c.oid AND NOT a.attisdropped
     WHERE c.relkind IN ('r', 'p')
       AND (
         (a.attname = 'patient_uid' AND a.atttypid = 'uuid'::regtype)
         OR (a.attname = 'patient_id' AND a.atttypid IN ('int4'::regtype, 'int8'::regtype))
       )
     ORDER BY c.relname, a.attname`,
  );
  return rows.filter((row) => {
    if (MERGE_SWEEP_EXCLUDED_TABLES.has(row.table_name)) return false;
    return !MERGE_SWEEP_EXCLUDED_PREFIXES.some((prefix) => row.table_name.startsWith(prefix));
  });
}

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolationError(err) {
  return /duplicate key value violates unique constraint/i.test(String(err?.message || ''));
}

function isForeignKeyViolationError(err) {
  return /violates foreign key constraint/i.test(String(err?.message || ''));
}

/**
 * Load + validate the two patient rows a merge points at. Used at request
 * time (fail fast on garbage input) and again inside the execute
 * transaction (with FOR UPDATE) so the check is authoritative at commit.
 */
async function loadMergePatients(db, { tenantId, primaryUid, secondaryUid, forUpdate = false }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, uid::text AS uid, role, is_active, status,
            merged_into_uid::text AS merged_into_uid,
            COALESCE(is_deleted, false) AS is_deleted
     FROM users
     WHERE tenant_id = $1::uuid AND uid IN ($2::uuid, $3::uuid)
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    tenantId, primaryUid, secondaryUid,
  );
  const primary = rows.find((row) => row.uid === primaryUid);
  const secondary = rows.find((row) => row.uid === secondaryUid);
  if (!primary || !secondary) {
    throw AppError.notFound('Both merge patients must exist in this tenant');
  }
  for (const [label, user] of [['primary', primary], ['secondary', secondary]]) {
    if (String(user.role || '').toUpperCase() !== 'PATIENT') {
      throw AppError.badRequest(`${label}_uid must reference a PATIENT record`);
    }
    if (user.merged_into_uid) {
      throw AppError.conflict(
        `The ${label} patient was already merged into another record`,
        'PATIENT_MERGE_ALREADY_MERGED',
      );
    }
    if (user.is_deleted || String(user.status || '').toLowerCase() === 'deleted') {
      throw AppError.conflict(
        `The ${label} patient record is deleted`,
        'PATIENT_MERGE_TARGET_DELETED',
      );
    }
  }
  return { primary, secondary };
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

  // Phase 0: both ends must be live PATIENT records in this tenant —
  // otherwise a typo'd uid produces an approvable merge that re-points
  // nothing (or the wrong thing) at execution time.
  await loadMergePatients(prisma, { tenantId: tid, primaryUid: primary, secondaryUid: secondary });

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
 * Execute an approved merge. One transaction covers identifier
 * retargeting, the catalog-discovered FK sweep, secondary-record
 * deactivation, and the canonical timeline/audit pair. If any step fails,
 * the whole transaction rolls back and the merge stays in 'approved'
 * status so the admin can retry after fixing the error.
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

  let updated;
  let secondaryUidForRevocation = null;
  try {
    updated = await setTenantTx(requireTenantId(tid), async (tx) => {
      const existingRows = await tx.$queryRawUnsafe(
        `SELECT id, status, candidate_id, primary_uid, secondary_uid, approver_uid
         FROM patient_merge_requests
         WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1
         FOR UPDATE`,
        mid, tid,
      );
      const existing = existingRows[0];
      if (!existing) throw AppError.notFound('Merge request not found');
      if (existing.status !== 'approved') {
        throw AppError.badRequest(`Merge request must be in 'approved' status to execute (was '${existing.status}')`);
      }
      const primary = existing.primary_uid;
      const secondary = existing.secondary_uid;

      // Lock both patient rows and re-validate under the lock: both must
      // still be live PATIENT records and neither already merged away.
      const patients = await loadMergePatients(tx, {
        tenantId: tid, primaryUid: primary, secondaryUid: secondary, forUpdate: true,
      });

      // The composite (tenant_id, <id>, patient_uid) FKs (migration 634 made
      // them deferrable) can only stay satisfied mid-sweep if their checks
      // move to COMMIT — parent and child tables re-point in separate
      // statements.
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');

      // Identifier retargeting first — rows keep their original
      // patient_uid for provenance and resolve to the survivor via
      // merged_into_uid.
      const identifierResult = await reassignIdentifiersForMerge(tx, {
        tenantId: tid,
        primaryUid: primary,
        secondaryUid: secondary,
        mergeRequestId: mid,
      });

      // Catalog-discovered sweep: every patient_uid / patient_id column in
      // the live schema, excluding append-only + bookkeeping + continuity
      // tables. Discovery only returns columns that exist, so there is no
      // "skip missing schema" catch here — any error aborts (and rolls
      // back) the merge.
      const targets = await discoverMergeSweepTargets(tx);
      const tableSummary = {};
      const appendOnlySkipped = [];
      let totalRowsMoved = identifierResult.count;
      for (const target of targets) {
        const { table_name: table, column_name: column } = target;
        if (target.append_only) {
          appendOnlySkipped.push(`${table}.${column}`);
          continue;
        }
        const cast = target.is_uuid ? 'uuid' : 'int';
        const fromValue = target.is_uuid ? secondary : patients.secondary.id;
        const toValue = target.is_uuid ? primary : patients.primary.id;
        const tenantClause = target.has_tenant_id ? ' AND tenant_id = $3::uuid' : '';
        const params = target.has_tenant_id ? [toValue, fromValue, tid] : [toValue, fromValue];
        const moved = await tx.$executeRawUnsafe(
          `UPDATE ${table}
           SET ${column} = $1::${cast}
           WHERE ${column} = $2::${cast}${tenantClause}`,
          ...params,
        );
        if (moved > 0 || tableSummary[table]) {
          tableSummary[table] = tableSummary[table] || { rows_moved: 0, fk_columns: [] };
          tableSummary[table].rows_moved += moved;
          tableSummary[table].fk_columns.push(column);
        }
        totalRowsMoved += moved;
      }

      // Deactivate the merged-away record in the same transaction: it must
      // not keep accepting logins or accruing new clinical rows, and the
      // survivor pointer is the durable provenance an un-merge needs.
      const deactivated = await tx.$executeRawUnsafe(
        `UPDATE users
         SET is_active = false,
             status = 'merged',
             status_reason = 'merged via patient_merge_requests id=' || $1::text,
             status_updated_at = NOW(),
             status_updated_by = $2::uuid,
             merged_into_uid = $3::uuid,
             merged_at = NOW(),
             updated_at = NOW()
         WHERE tenant_id = $4::uuid AND uid = $5::uuid AND merged_into_uid IS NULL`,
        String(mid), executor, primary, tid, secondary,
      );
      if (deactivated !== 1) {
        throw AppError.conflict('Secondary patient could not be deactivated', 'PATIENT_MERGE_DEACTIVATION_FAILED');
      }

      const summary = {
        identifiers_retargeted: identifierResult.count,
        total_rows_moved: totalRowsMoved,
        table_summary: tableSummary,
        append_only_skipped: appendOnlySkipped,
        secondary_deactivated: true,
        secondary_user_id: patients.secondary.id,
        primary_user_id: patients.primary.id,
      };

      // Canonical clinical timeline invariant: the merge is a
      // patient-facing clinical write, so the survivor gets exactly one
      // timeline row + one audit row in this same transaction. The helpers
      // swallow their own errors and return null — treat that as fatal so
      // the detail writes can never outlive a failed canonical emit.
      // Insert-once keys: 'executed' is one-way and guarded by the
      // status='approved' UPDATE below, so this emit runs at most once per
      // merge request.
      const {
        recordTimelineEvent,
        recordClinicalAuditEvent,
      } = await import('../clinical/canonicalClinicalPlatformService.js');
      const timelineEvent = await recordTimelineEvent({
        tenantId: tid,
        patientUid: primary,
        eventType: 'patient.merge.executed',
        eventStatus: 'completed',
        sourceTable: 'patient_merge_requests',
        sourceId: String(mid),
        resourceType: 'patient_merge_request',
        resourceId: String(mid),
        actorUid: executor,
        summary: 'Duplicate patient record merged into this chart',
        payload: {
          merged_from_uid: secondary,
          identifiers_retargeted: identifierResult.count,
          total_rows_moved: totalRowsMoved,
        },
        idempotencyKey: `patient_merge_requests:${mid}:executed`,
      }, { db: tx });
      if (!timelineEvent) {
        throw AppError.internal('Merge timeline event was not recorded', 'PATIENT_MERGE_TIMELINE_REQUIRED');
      }
      const auditEvent = await recordClinicalAuditEvent({
        tenantId: tid,
        patientUid: primary,
        action: 'patient.merge.executed',
        actorUid: executor,
        resourceType: 'patient_merge_request',
        resourceTable: 'patient_merge_requests',
        resourceId: String(mid),
        beforeState: { secondary_uid: secondary, secondary_status: patients.secondary.status },
        afterState: summary,
        idempotencyKey: `patient_merge_requests:${mid}:executed`,
      }, { db: tx });
      if (!auditEvent) {
        throw AppError.internal('Merge audit event was not recorded', 'PATIENT_MERGE_AUDIT_REQUIRED');
      }

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
      const executedRow = rows[0];
      if (!executedRow) throw AppError.conflict('Merge request status changed mid-execution');

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

      secondaryUidForRevocation = secondary;
      return executedRow;
    });
  } catch (err) {
    // COMMIT-time constraint failures (deferred FKs, per-patient unique
    // rows like abha_profiles on both records) mean the two records still
    // hold conflicting data — the merge rolled back completely; surface a
    // reviewable conflict rather than a generic 500.
    if (isUniqueViolationError(err) || isForeignKeyViolationError(err)) {
      logger.error('patient merge aborted on data conflict', { mergeRequestId: mid, error: err.message });
      throw AppError.conflict(
        'Merge aborted: the two records hold conflicting rows that need manual review before merging',
        'PATIENT_MERGE_DATA_CONFLICT',
      );
    }
    throw err;
  }

  // Phase 1.5 (post-commit, best-effort): the merged-away record must not
  // keep using JWTs issued before the merge. Failure is logged, never
  // blocks the committed merge.
  if (secondaryUidForRevocation) {
    try {
      await revokeAllUserTokens(secondaryUidForRevocation);
    } catch (err) {
      logger.warn('patient merge token revocation failed', {
        mergeRequestId: mid, error: err.message,
      });
    }
  }

  return updated;
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
  MERGE_STATUSES,
  MERGE_SWEEP_EXCLUDED_TABLES,
  MERGE_SWEEP_EXCLUDED_PREFIXES,
  CONTINUITY_PROPOSER_ROLES,
  CONTINUITY_DOCTOR_APPROVER_ROLES,
  discoverMergeSweepTargets,
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
