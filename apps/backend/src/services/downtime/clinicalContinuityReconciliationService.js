import { createHash } from 'node:crypto';

import { CLINICAL_CONTINUITY_ACTIONS_BY_ID } from '../../config/clinicalContinuityActionCatalog.js';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask, transitionTask } from '../workflow/taskService.js';
import { loadActiveClinicalContinuityPolicyForFacilityTx } from './clinicalContinuityPolicyService.js';
import { hashCanonicalValue } from './continuityPackCanonical.js';
import {
  CLINICAL_CONTINUITY_PAPER_ACTIONS,
  normalizePaperIdentity,
} from '../../validators/clinicalContinuityPaperSchemas.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPEN_TASK_STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'overdue']);
const INCIDENT_ADMIN_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
  'QUALITY_OFFICER',
]);
const PAPER_ACTION_ROLES = Object.freeze({
  'mar.administration.backfill': new Set([
    'SUPER_ADMIN', 'ADMIN', 'DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT',
    'NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE', 'IP_INCHARGE',
  ]),
  'lab.specimen_collection.backfill': new Set([
    'SUPER_ADMIN', 'ADMIN', 'LAB_INCHARGE', 'PATHOLOGIST',
    'NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE',
  ]),
  'blood.transfusion_verification.backfill': new Set([
    'SUPER_ADMIN', 'ADMIN', 'BLOOD_BANK_TECHNICIAN', 'DOCTOR', 'DUTY_DOCTOR',
    'CONSULTANT', 'NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE',
  ]),
});
const TEMPORARY_IDENTITY_ROLES = new Set([
  'SUPER_ADMIN', 'ADMIN', 'MEDICAL_RECORDS', 'RECEPTIONIST',
  'RECEPTION_INCHARGE', 'ADMISSION_OFFICER',
]);
const WORKBENCH_AGGREGATE_ROLES = new Set([
  ...INCIDENT_ADMIN_ROLES,
  ...TEMPORARY_IDENTITY_ROLES,
]);
const WORKBENCH_STAFF_ROLES = new Set(
  Object.values(PAPER_ACTION_ROLES).flatMap(roles => [...roles]),
);
const WORKBENCH_ROLES = new Set([
  ...WORKBENCH_AGGREGATE_ROLES,
  ...WORKBENCH_STAFF_ROLES,
]);

function normalizeRole(value) {
  return String(value || '').trim().toUpperCase();
}

function uuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'CONTINUITY_IDENTIFIER_INVALID');
  }
  return normalized;
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const parsed = Number(value);
  const floor = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < floor) {
    throw AppError.badRequest(`${label} is invalid`, 'CONTINUITY_IDENTIFIER_INVALID');
  }
  return parsed;
}

function safeText(value, label, max, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max) {
    throw AppError.badRequest(`${label} is invalid`, 'CONTINUITY_VALUE_INVALID');
  }
  return normalized;
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a SHA-256 hex digest`, 'CONTINUITY_HASH_INVALID');
  }
  return normalized;
}

function iso(value, label, { futureAllowed = false } = {}) {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be an ISO timestamp`, 'CONTINUITY_TIMESTAMP_INVALID');
  }
  if (!futureAllowed && date.getTime() > Date.now() + 5 * 60_000) {
    throw AppError.badRequest(`${label} cannot be in the future`, 'CONTINUITY_TIMESTAMP_INVALID');
  }
  return date.toISOString();
}

function requireRole(actorRole, allowed, code = 'CONTINUITY_ROLE_DENIED') {
  const role = normalizeRole(actorRole);
  if (!allowed.has(role)) {
    throw AppError.forbidden('Clinical continuity command was denied', code, { safe: true });
  }
  return role;
}

function requirePaperItemRole(role, itemKind, actionId) {
  if (actionId) {
    requireRole(role, PAPER_ACTION_ROLES[actionId] || new Set(), 'CONTINUITY_PAPER_ACTION_ROLE_DENIED');
    return;
  }
  requireRole(
    role,
    itemKind === 'temporary_identity' ? TEMPORARY_IDENTITY_ROLES : INCIDENT_ADMIN_ROLES,
    'CONTINUITY_PAPER_ITEM_ROLE_DENIED',
  );
}

async function requireAuthorizedPaperPatient(patientAuthorizer, { patientUid, patientId }) {
  if (typeof patientAuthorizer !== 'function') {
    throw AppError.forbidden(
      'Clinical continuity paper back-entry was denied',
      'CONTINUITY_PAPER_PATIENT_ACCESS_DENIED',
      { safe: true },
    );
  }
  const patientAccess = await patientAuthorizer({ patientUid, patientId });
  if (patientAccess !== true && patientAccess?.allowed !== true) {
    throw AppError.forbidden(
      'Clinical continuity paper back-entry was denied',
      'CONTINUITY_PAPER_PATIENT_ACCESS_DENIED',
      { safe: true },
    );
  }
}

function stale(resource, expectedVersion, current) {
  throw AppError.conflict(
    `${resource} changed before this command was accepted`,
    'CONTINUITY_STALE_PROJECTION',
    { current, expected_version: expectedVersion, safe: true },
  );
}

function deterministicUuid(value) {
  const chars = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function paperNumber(paperItemId, expectedPrefix) {
  const escapedPrefix = expectedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escapedPrefix}[-/.]?(\\d+)$`, 'i').exec(paperItemId);
  if (!match) {
    throw AppError.conflict(
      'Paper identifier is outside the packet range',
      'CONTINUITY_PAPER_RANGE_INVALID',
      { safe: true },
    );
  }
  return positiveInteger(match[1], 'paper item number');
}

async function facilityTransaction(
  { tenantId, facilityId, isolationLevel = 'Serializable', readOnly = false },
  callback,
) {
  const tenant = requireTenantId(tenantId);
  const facility = positiveInteger(facilityId, 'facility_id');
  return setTenantTx(tenant, async tx => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_facility_id', $1, true)`,
      String(facility),
    );
    return callback(tx, { tenantId: tenant, facilityId: facility });
  }, { isolationLevel, readOnly });
}

async function requiredAudit(tx, input) {
  const row = await recordClinicalAuditEvent(input, { db: tx });
  if (!row) {
    throw AppError.internal('Clinical continuity audit evidence was not recorded', 'CONTINUITY_AUDIT_REQUIRED');
  }
  return row;
}

async function loadConfigTx(tx, tenantId, facilityId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, fallback_principal, clinical_safety_lead_uid::text,
            needs_review_owner_principal, identity_owner_principal,
            interface_owner_principal, version
       FROM clinical_continuity_reconciliation_config
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer
      LIMIT 1`,
    tenantId,
    facilityId,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Facility continuity reconciliation ownership is not configured',
      'CONTINUITY_RECONCILIATION_CONFIG_REQUIRED',
      { safe: true },
    );
  }
  return rows[0];
}

async function insertReconciliationItemTx(tx, {
  tenantId,
  facilityId,
  incidentId,
  queueType,
  reasonCode,
  paperItemRowId = null,
  temporaryIdentityId = null,
  interfaceOffsetId = null,
  patientUid = null,
  encounterId = null,
  safetyCritical = false,
  actorUid,
}) {
  const config = await loadConfigTx(tx, tenantId, facilityId);
  const ownerPrincipal = queueType === 'identity'
    ? config.identity_owner_principal
    : queueType === 'interface'
      ? config.interface_owner_principal
      : config.needs_review_owner_principal;
  const assignedToUid = ownerPrincipal === config.fallback_principal
    ? config.clinical_safety_lead_uid
    : null;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO clinical_continuity_reconciliation_items (
       tenant_id, facility_id, incident_id, queue_type, reason_code,
       paper_item_row_id, temporary_identity_id, interface_offset_id,
       patient_uid, encounter_id, safety_critical, owner_principal,
       assigned_to_uid, created_by, updated_by
     ) VALUES (
       $1::uuid, $2::integer, $3::uuid, $4, $5,
       $6::uuid, $7::uuid, $8::uuid,
       $9::uuid, $10::uuid, $11, $12,
       $13::uuid, $14::uuid, $14::uuid
     )
     ON CONFLICT (tenant_id, paper_item_row_id, queue_type)
       WHERE paper_item_row_id IS NOT NULL AND disposition IN ('open', 'in_progress')
     DO UPDATE SET reason_code = EXCLUDED.reason_code,
                   safety_critical = clinical_continuity_reconciliation_items.safety_critical
                                     OR EXCLUDED.safety_critical,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = clock_timestamp(),
                   version = clinical_continuity_reconciliation_items.version + 1
     RETURNING *`,
    tenantId,
    facilityId,
    incidentId,
    queueType,
    reasonCode,
    paperItemRowId,
    temporaryIdentityId,
    interfaceOffsetId,
    patientUid,
    encounterId,
    safetyCritical,
    ownerPrincipal,
    assignedToUid,
    actorUid,
  );
  const item = rows[0];
  if (!item.task_id) {
    const task = await createTask({
      tenantId,
      taskKind: 'review',
      title: `Clinical continuity ${queueType.replace('_', ' ')} review`,
      description: `Reason: ${reasonCode}`,
      patientUid,
      relatedResourceType: 'clinical_continuity_reconciliation_item',
      relatedResourceId: item.id,
      priority: safetyCritical ? 'critical' : 'high',
      assignedToUid,
      assignedToRole: ownerPrincipal.startsWith('role:')
        ? ownerPrincipal.slice('role:'.length).toUpperCase()
        : null,
      createdBy: actorUid,
      slaCompletionSemantics: 'none',
      metadata: {
        continuity_incident_id: incidentId,
        queue_type: queueType,
        reason_code: reasonCode,
        recorded_at_source: 'server',
      },
      onConflictResourceDoNothing: true,
      tx,
    });
    if (task) {
      const linked = await tx.$queryRawUnsafe(
        `UPDATE clinical_continuity_reconciliation_items
            SET task_id = $1::integer,
                updated_by = $2::uuid,
                updated_at = clock_timestamp(),
                version = version + 1
          WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid
          RETURNING *`,
        task.id,
        actorUid,
        tenantId,
        facilityId,
        item.id,
      );
      return linked[0];
    }
  }
  return item;
}

export async function declareClinicalContinuityIncident({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  expectedVersion = 0,
  packetId,
  reservedIncidentId,
  signedCanonicalHash,
  signature,
  occurredAt,
  declarationSource = 'online',
  sourceDeviceId = null,
  sourceSessionId = null,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, INCIDENT_ADMIN_ROLES);
  const packet = uuid(packetId, 'packet_id');
  const incident = uuid(reservedIncidentId, 'reserved_incident_id');
  const evidenceHash = hash(signedCanonicalHash, 'signed_canonical_hash');
  const occurred = iso(occurredAt, 'occurred_at');
  const expected = positiveInteger(expectedVersion, 'expected_version', { allowZero: true });
  if (!['online', 'offline_import'].includes(declarationSource)) {
    throw AppError.badRequest('declaration_source is invalid', 'CONTINUITY_DECLARATION_INVALID');
  }

  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const packetRows = await tx.$queryRawUnsafe(
      `SELECT *
         FROM clinical_continuity_incident_packets
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      packet,
    );
    const packetRow = packetRows[0];
    if (!packetRow) {
      throw AppError.notFound('Incident packet not found', 'CONTINUITY_PACKET_NOT_FOUND');
    }
    if (
      String(packetRow.reserved_incident_id).toLowerCase() !== incident
      || packetRow.canonical_payload_hash !== evidenceHash
      || packetRow.signature !== signature
    ) {
      throw AppError.conflict('Incident packet evidence did not verify', 'CONTINUITY_PACKET_INVALID', { safe: true });
    }
    const now = Date.now();
    if (
      packetRow.status !== 'unused'
      || packetRow.revoked_at
      || Date.parse(packetRow.valid_from) > now
      || Date.parse(packetRow.valid_until) <= now
    ) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_incidents
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid`,
        scope.tenantId,
        scope.facilityId,
        incident,
      );
      if (packetRow.status === 'used' && existing[0]) {
        return { disposition: 'exact_duplicate', incident: existing[0] };
      }
      throw AppError.conflict('Incident packet is unavailable', 'CONTINUITY_PACKET_UNAVAILABLE', { safe: true });
    }
    const priorIncident = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incidents
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      incident,
    );
    if (priorIncident[0]) {
      if (Number(priorIncident[0].version) !== expected) stale('Incident', expected, priorIncident[0]);
      return { disposition: 'exact_duplicate', incident: priorIncident[0] };
    }
    if (expected !== 0) stale('Incident', expected, null);

    const canonicalRows = await tx.$queryRawUnsafe(
      `SELECT id::text
         FROM clinical_continuity_incidents
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND lifecycle_state <> 'closed' AND alias_disposition = 'canonical'
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
    );
    const canonicalIncidentId = canonicalRows[0]?.id || null;
    const aliasDisposition = canonicalIncidentId ? 'observed_alias' : 'canonical';
    const declarationDisposition = canonicalIncidentId ? 'split_brain' : 'accepted';

    const incidentRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_incidents (
         id, tenant_id, facility_id, packet_id, canonical_incident_id,
         alias_disposition, commander_uid, commander_role, lifecycle_state,
         declared_at, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
         $6, $7::uuid, $8, 'declared', $9::timestamptz, $7::uuid, $7::uuid
       ) RETURNING *`,
      incident,
      scope.tenantId,
      scope.facilityId,
      packet,
      canonicalIncidentId,
      aliasDisposition,
      actor,
      role,
      occurred,
    );
    const rangeRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_paper_ranges (
         tenant_id, facility_id, incident_id, packet_id, range_prefix,
         range_first, range_last, status, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5,
         $6::bigint, $7::bigint, 'in_use', $8::uuid, $8::uuid
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      incident,
      packet,
      packetRow.range_prefix,
      packetRow.range_first,
      packetRow.range_last,
      actor,
    );
    const declarationRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_incident_declarations (
         tenant_id, facility_id, incident_id, packet_id, paper_range_id,
         declaration_source, packet_key_id, packet_key_version,
         signed_canonical_hash, signer_uid, signer_role, verification_result,
         conflict_disposition, occurred_at, imported_by, source_device_id,
         source_session_id, request_id
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9, $10::uuid, $11, 'verified',
         $12, $13::timestamptz, $10::uuid, $14::uuid, $15::uuid, $16::uuid
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      incident,
      packet,
      rangeRows[0].id,
      declarationSource,
      packetRow.packet_key_id,
      packetRow.packet_key_version,
      evidenceHash,
      actor,
      role,
      declarationDisposition,
      occurred,
      sourceDeviceId,
      sourceSessionId,
      requestId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE clinical_continuity_incident_packets
          SET status = 'used', used_at = clock_timestamp(), used_by = $1::uuid
        WHERE tenant_id = $2::uuid AND facility_id = $3::integer AND id = $4::uuid`,
      actor,
      scope.tenantId,
      scope.facilityId,
      packet,
    );
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.incident.declared',
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_incident',
      resourceTable: 'clinical_continuity_incidents',
      resourceId: incident,
      requestId,
      afterState: {
        declaration_id: declarationRows[0].id,
        disposition: declarationDisposition,
        facility_id: scope.facilityId,
        packet_id: packet,
      },
      idempotencyKey: `cc-incident:${scope.tenantId}:${incident}:declared`,
      occurredAt: occurred,
    });
    return {
      disposition: declarationDisposition === 'accepted' ? 'declared' : 'split_brain_needs_review',
      incident: incidentRows[0],
      declaration: declarationRows[0],
      paper_range: rangeRows[0],
      audit_event_id: audit.id,
    };
  });
}

export async function registerClinicalContinuityPaperItem({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  paperItemId,
  expectedVersion = 1,
  itemKind,
  actionId = null,
  originalActorUid = null,
  originalActorRole = null,
  occurredAt = null,
  patientUid = null,
  temporaryIdentityId = null,
  encounterId = null,
  evidenceHash,
  patientAuthorizer = null,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = normalizeRole(actorRole);
  const identity = normalizePaperIdentity({ incidentId, paperItemId });
  const expected = positiveInteger(expectedVersion, 'expected_version');
  const allowedKinds = new Set([
    'temporary_identity', 'medication_administration', 'specimen_collection',
    'transfusion_verification', 'other',
  ]);
  if (!allowedKinds.has(itemKind)) {
    throw AppError.badRequest('item_kind is invalid', 'CONTINUITY_PAPER_ITEM_INVALID');
  }
  if (actionId && !CLINICAL_CONTINUITY_PAPER_ACTIONS[actionId]) {
    throw AppError.badRequest('Paper action is not approved', 'CONTINUITY_PAPER_ACTION_DENIED');
  }
  const expectedItemKind = actionId
    ? {
      'mar.administration.backfill': 'medication_administration',
      'lab.specimen_collection.backfill': 'specimen_collection',
      'blood.transfusion_verification.backfill': 'transfusion_verification',
    }[actionId]
    : null;
  if (expectedItemKind && expectedItemKind !== itemKind) {
    throw AppError.badRequest('Paper action does not match item_kind', 'CONTINUITY_PAPER_ITEM_INVALID');
  }
  requirePaperItemRole(role, itemKind, actionId);
  const paperEvidenceHash = hash(evidenceHash, 'evidence_hash');
  const normalizedPatientUid = patientUid ? uuid(patientUid, 'patient_uid') : null;
  const tempId = temporaryIdentityId ? uuid(temporaryIdentityId, 'temporary_identity_id') : null;
  const normalizedOriginalActor = originalActorUid ? uuid(originalActorUid, 'original_actor_uid') : null;
  const normalizedOriginalRole = originalActorRole
    ? safeText(originalActorRole, 'original_actor_role', 80)
    : null;
  const normalizedOccurredAt = occurredAt ? iso(occurredAt, 'occurred_at') : null;
  const normalizedEncounterId = encounterId ? uuid(encounterId, 'encounter_id') : null;
  if (normalizedPatientUid && tempId) {
    throw AppError.badRequest('Paper item cannot link both patient identity types', 'CONTINUITY_TEMP_IDENTITY_INVALID');
  }
  if (actionId && !normalizedPatientUid && !tempId) {
    throw AppError.badRequest('Paper action requires a patient or temporary identity', 'CONTINUITY_PAPER_IDENTITY_REQUIRED');
  }
  if (tempId && normalizedEncounterId) {
    throw AppError.badRequest('Temporary identity cannot carry a permanent encounter', 'CONTINUITY_TEMP_IDENTITY_INVALID');
  }
  if (itemKind === 'temporary_identity' && (normalizedPatientUid || tempId || actionId)) {
    throw AppError.badRequest('Temporary identity paper item has invalid links', 'CONTINUITY_TEMP_IDENTITY_INVALID');
  }
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT incident.*, range.id AS paper_range_id, range.range_prefix,
              range.range_first, range.range_last, range.status AS range_status
         FROM clinical_continuity_incidents AS incident
         JOIN clinical_continuity_paper_ranges AS range
           ON range.tenant_id = incident.tenant_id
          AND range.facility_id = incident.facility_id
          AND range.incident_id = incident.id
        WHERE incident.tenant_id = $1::uuid
          AND incident.facility_id = $2::integer
          AND incident.id = $3::uuid
        FOR UPDATE OF incident, range`,
      scope.tenantId,
      scope.facilityId,
      identity.incidentId,
    );
    const incident = rows[0];
    if (!incident) throw AppError.notFound('Incident not found', 'CONTINUITY_INCIDENT_NOT_FOUND');
    if (incident.lifecycle_state === 'closed') {
      throw AppError.conflict('Incident is closed', 'CONTINUITY_INCIDENT_CLOSED', { safe: true });
    }
    const number = paperNumber(identity.paperItemId, incident.range_prefix);
    if (number < Number(incident.range_first) || number > Number(incident.range_last)) {
      throw AppError.conflict('Paper identifier is outside the packet range', 'CONTINUITY_PAPER_RANGE_INVALID');
    }
    const existing = await tx.$queryRawUnsafe(
      `SELECT item.*, temp.matched_patient_uid::text
         FROM clinical_continuity_paper_items AS item
         LEFT JOIN clinical_continuity_temporary_identities AS temp
           ON temp.tenant_id = item.tenant_id
          AND temp.facility_id = item.facility_id
          AND temp.id = item.temporary_identity_id
        WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
          AND item.incident_id = $3::uuid AND item.paper_item_id = $4
        FOR UPDATE OF item, temp`,
      scope.tenantId,
      scope.facilityId,
      identity.incidentId,
      identity.paperItemId,
    );
    if (existing[0]) {
      requirePaperItemRole(role, existing[0].item_kind, existing[0].action_id);
      const existingPatientUid = existing[0].temporary_identity_id
        ? existing[0].matched_patient_uid
        : existing[0].patient_uid;
      if (existingPatientUid) {
        const existingPatientRows = await tx.$queryRawUnsafe(
          `SELECT id, uid::text FROM users
            WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT'
            LIMIT 1`,
          scope.tenantId,
          existingPatientUid,
        );
        if (!existingPatientRows[0]) throw AppError.notFound('Patient not found', 'CONTINUITY_PATIENT_NOT_FOUND');
        await requireAuthorizedPaperPatient(patientAuthorizer, {
          patientUid: existingPatientUid,
          patientId: existingPatientRows[0].id,
        });
      }
      const existingOccurredAt = existing[0].occurred_at
        ? new Date(existing[0].occurred_at).toISOString()
        : null;
      const exactRegistration = existing[0].evidence_hash === paperEvidenceHash
        && existing[0].item_kind === itemKind
        && existing[0].action_id === actionId
        && existing[0].original_actor_uid === normalizedOriginalActor
        && existing[0].original_actor_role === normalizedOriginalRole
        && existingOccurredAt === normalizedOccurredAt
        && existing[0].patient_uid === normalizedPatientUid
        && existing[0].encounter_id === normalizedEncounterId
        && (
          itemKind === 'temporary_identity'
          || existing[0].temporary_identity_id === tempId
        );
      if (exactRegistration) {
        return { disposition: 'exact_duplicate', paper_item: existing[0] };
      }
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: identity.incidentId,
        queueType: 'needs_review',
        reasonCode: 'CONTINUITY_PAPER_ITEM_IDENTITY_MISMATCH',
        paperItemRowId: existing[0].id,
        patientUid: existing[0].patient_uid,
        encounterId: existing[0].encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      return { disposition: 'needs_review', paper_item: existing[0], reconciliation_item: review };
    }
    if (expected !== 1) stale('Paper item', expected, null);
    const rangeBlocked = ['lost', 'revoked'].includes(incident.range_status);
    let patientId = null;
    if (normalizedPatientUid) {
      const patientRows = await tx.$queryRawUnsafe(
        `SELECT id, uid::text FROM users
          WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT'
          LIMIT 1`,
        scope.tenantId,
        normalizedPatientUid,
      );
      if (!patientRows[0]) throw AppError.notFound('Patient not found', 'CONTINUITY_PATIENT_NOT_FOUND');
      patientId = patientRows[0].id;
      await requireAuthorizedPaperPatient(patientAuthorizer, {
        patientUid: normalizedPatientUid,
        patientId,
      });
    }
    if (tempId) {
      const tempRows = await tx.$queryRawUnsafe(
        `SELECT id FROM clinical_continuity_temporary_identities
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND incident_id = $3::uuid AND id = $4::uuid
          LIMIT 1`,
        scope.tenantId,
        scope.facilityId,
        identity.incidentId,
        tempId,
      );
      if (!tempRows[0]) {
        throw AppError.notFound('Temporary identity not found', 'CONTINUITY_TEMP_IDENTITY_NOT_FOUND');
      }
    }
    const paperRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_paper_items (
         tenant_id, facility_id, incident_id, packet_id, paper_range_id,
         paper_item_id, paper_item_number, item_kind, action_id,
         original_actor_uid, original_actor_role, occurred_at,
         patient_id, patient_uid, temporary_identity_id, encounter_id,
         evidence_hash, reconciliation_disposition, created_by, updated_by
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::uuid,
         $6, $7::bigint, $8, $9,
         $10::uuid, $11, $12::timestamptz,
         $13::integer, $14::uuid, $15::uuid, $16::uuid,
         $17, $18, $19::uuid, $19::uuid
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      identity.incidentId,
      incident.packet_id,
      incident.paper_range_id,
      identity.paperItemId,
      number,
      itemKind,
      actionId,
      normalizedOriginalActor,
      normalizedOriginalRole,
      normalizedOccurredAt,
      patientId,
      normalizedPatientUid,
      tempId,
      normalizedEncounterId,
      paperEvidenceHash,
      rangeBlocked ? 'lost_revoked' : 'unentered',
      actor,
    );
    let temporaryIdentity = null;
    if (itemKind === 'temporary_identity') {
      const tempRows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_temporary_identities (
           tenant_id, facility_id, incident_id, packet_id, paper_range_id,
           paper_item_id, display_identifier, created_by, updated_by
         ) VALUES (
           $1::uuid, $2::integer, $3::uuid, $4::uuid, $5::uuid,
           $6, $6, $7::uuid, $7::uuid
         ) RETURNING *`,
        scope.tenantId,
        scope.facilityId,
        identity.incidentId,
        incident.packet_id,
        incident.paper_range_id,
        identity.paperItemId,
        actor,
      );
      temporaryIdentity = tempRows[0];
      await tx.$executeRawUnsafe(
        `UPDATE clinical_continuity_paper_items
            SET temporary_identity_id = $1::uuid,
                updated_by = $2::uuid,
                updated_at = clock_timestamp(),
                version = version + 1
          WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid`,
        temporaryIdentity.id,
        actor,
        scope.tenantId,
        scope.facilityId,
        paperRows[0].id,
      );
    }
    let review = null;
    if (rangeBlocked) {
      review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: identity.incidentId,
        queueType: itemKind === 'temporary_identity' ? 'identity' : 'needs_review',
        reasonCode: 'CONTINUITY_PAPER_RANGE_LOST_OR_REVOKED',
        paperItemRowId: paperRows[0].id,
        temporaryIdentityId: temporaryIdentity?.id,
        patientUid: normalizedPatientUid,
        encounterId: encounterId || null,
        safetyCritical: true,
        actorUid: actor,
      });
    }
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      patientUid: normalizedPatientUid,
      encounterId,
      action: 'clinical_continuity.paper_item.registered',
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_paper_item',
      resourceTable: 'clinical_continuity_paper_items',
      resourceId: paperRows[0].id,
      requestId,
      afterState: {
        incident_id: identity.incidentId,
        paper_item_id: identity.paperItemId,
        item_kind: itemKind,
        range_disposition: incident.range_status,
      },
      idempotencyKey: `cc-paper:${scope.tenantId}:${identity.incidentId}:${identity.paperItemId}:registered`,
    });
    return {
      disposition: rangeBlocked ? 'needs_review' : 'registered',
      paper_item: { ...paperRows[0], temporary_identity_id: temporaryIdentity?.id || null },
      temporary_identity: temporaryIdentity,
      reconciliation_item: review,
      audit_event_id: audit.id,
    };
  });
}

export async function listClinicalContinuityWorkbench({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  incidentId = null,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, WORKBENCH_ROLES, 'CONTINUITY_WORKBENCH_ROLE_DENIED');
  return facilityTransaction(
    { tenantId, facilityId, isolationLevel: 'RepeatableRead', readOnly: true },
    async (tx, scope) => {
      const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
      const aggregateView = WORKBENCH_AGGREGATE_ROLES.has(role)
        || config.clinical_safety_lead_uid === actor;
      const incidentFilter = incidentId ? uuid(incidentId, 'incident_id') : null;
      const incidents = await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_incidents
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND ($3::uuid IS NULL OR id = $3::uuid)
          ORDER BY declared_at DESC`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
      );
      const packets = aggregateView ? await tx.$queryRawUnsafe(
        `SELECT packet.*
           FROM clinical_continuity_incident_packets AS packet
           JOIN clinical_continuity_incidents AS incident
             ON incident.tenant_id = packet.tenant_id
            AND incident.facility_id = packet.facility_id
            AND incident.packet_id = packet.id
          WHERE packet.tenant_id = $1::uuid AND packet.facility_id = $2::integer
            AND ($3::uuid IS NULL OR incident.id = $3::uuid)
          ORDER BY packet.created_at DESC`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
      ) : [];
      const paperRanges = aggregateView ? await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_paper_ranges
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND ($3::uuid IS NULL OR incident_id = $3::uuid)
          ORDER BY created_at DESC`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
      ) : [];
      const paperItems = await tx.$queryRawUnsafe(
        `SELECT item.* FROM clinical_continuity_paper_items AS item
          WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
            AND ($3::uuid IS NULL OR item.incident_id = $3::uuid)
            AND (
              $4::boolean
              OR item.original_actor_uid = $5::uuid
              OR EXISTS (
                SELECT 1 FROM clinical_continuity_reconciliation_items AS assigned
                 WHERE assigned.tenant_id = item.tenant_id
                   AND assigned.facility_id = item.facility_id
                   AND assigned.paper_item_row_id = item.id
                   AND assigned.assigned_to_uid = $5::uuid
              )
            )
          ORDER BY item.created_at DESC LIMIT 500`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
        aggregateView,
        actor,
      );
      const reconciliationItems = await tx.$queryRawUnsafe(
        `SELECT item.*, task.status AS task_status, task.due_at AS task_due_at,
                task.sla_completion_semantics
           FROM clinical_continuity_reconciliation_items AS item
           LEFT JOIN tasks AS task ON task.id = item.task_id AND task.tenant_id = item.tenant_id
          WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
            AND ($3::uuid IS NULL OR item.incident_id = $3::uuid)
            AND ($4::boolean OR item.assigned_to_uid = $5::uuid)
          ORDER BY item.safety_critical DESC, item.created_at ASC LIMIT 500`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
        aggregateView,
        actor,
      );
      const temporaryIdentities = aggregateView ? await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_temporary_identities
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND ($3::uuid IS NULL OR incident_id = $3::uuid)
          ORDER BY created_at DESC LIMIT 500`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
      ) : [];
      const devices = aggregateView ? await tx.$queryRawUnsafe(
        `SELECT * FROM clinical_continuity_device_journal_offsets
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND ($3::uuid IS NULL OR incident_id = $3::uuid)
          ORDER BY updated_at DESC`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
      ) : [];
      const interfaces = aggregateView ? await tx.$queryRawUnsafe(
        `SELECT requirement.*, offset.generation AS observed_generation,
                offset.high_water_position AS observed_high_water_position,
                offset.high_water_token AS observed_high_water_token,
                offset.recovery_state AS observed_recovery_state
           FROM clinical_continuity_incident_interfaces AS requirement
           LEFT JOIN event_consumer_offsets AS offset
             ON offset.tenant_id = requirement.tenant_id
            AND offset.offset_id = requirement.offset_id
          WHERE requirement.tenant_id = $1::uuid
            AND requirement.facility_id = $2::integer
            AND ($3::uuid IS NULL OR requirement.incident_id = $3::uuid)
          ORDER BY requirement.updated_at DESC`,
        scope.tenantId,
        scope.facilityId,
        incidentFilter,
      ) : [];
      return {
        incidents,
        packets,
        paper_ranges: paperRanges,
        paper_items: paperItems,
        reconciliation_items: reconciliationItems,
        temporary_identities: temporaryIdentities,
        device_offsets: devices,
        interfaces,
      };
    },
  );
}

function paperFingerprint({ tenantId, facilityId, parsed }) {
  const normalized = { ...parsed.normalized };
  delete normalized.expected_version;
  return hashCanonicalValue({
    action_id: parsed.actionId,
    clinical_payload: normalized,
    evidence_hash: parsed.normalized.evidence_hash,
    facility_id: facilityId,
    incident_id: parsed.identity.incidentId,
    original_actor_role: parsed.normalized.original_actor_role,
    original_actor_uid: parsed.normalized.original_actor_uid,
    paper_item_id: parsed.identity.paperItemId,
    patient_uid: parsed.normalized.patient_uid,
    schema_id: parsed.definition.id,
    schema_version: parsed.definition.version,
    tenant_id: tenantId,
  });
}

function paperClientEventId({ tenantId, facilityId, incidentId, paperItemId }) {
  return deterministicUuid(`paper:${tenantId}:${facilityId}:${incidentId}:${paperItemId}`);
}

function paperIdempotencyIdentity({ incidentId, paperItemId }) {
  return `paper:${incidentId}:${paperItemId}`;
}

async function appendPaperAttemptTx(tx, {
  tenantId,
  clientEventId,
  receiptLinked = false,
  actorUid,
  actorRole,
  facilityContext,
  requestId,
  attemptClass,
  reasonCode,
  result,
  idempotencyKey,
}) {
  const safeRequestId = UUID_PATTERN.test(String(requestId || '')) ? String(requestId).toLowerCase() : null;
  await tx.$executeRawUnsafe(
    `INSERT INTO clinical_continuity_replay_attempts (
       tenant_id, client_event_id, receipt_client_event_id,
       replay_actor_uid, replay_role, facility_context_id,
       facility_context_revision, request_id, attempt_class,
       reason_code, result, idempotency_key_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid,
       $4::uuid, $5, $6::uuid,
       $7::bigint, $8::uuid, $9,
       $10, $11, $12
     )`,
    tenantId,
    clientEventId,
    receiptLinked ? clientEventId : null,
    actorUid,
    actorRole,
    facilityContext.contextId,
    facilityContext.contextRevision,
    safeRequestId,
    attemptClass,
    reasonCode,
    result,
    createHash('sha256').update(idempotencyKey, 'utf8').digest('hex'),
  );
}

async function loadPaperReceiptTx(tx, tenantId, facilityId, incidentId, paperItemId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT receipt.*, effect.retrospective_fact_id::text,
            effect.paper_item_row_id::text, effect.fact_resource_type,
            effect.fact_resource_id, effect.clinical_timeline_event_id::text,
            effect.clinical_audit_event_id::text,
            effect.retrospective_event_outbox_id::text
       FROM clinical_continuity_replay_receipts AS receipt
       LEFT JOIN clinical_continuity_replay_effect_evidence AS effect
         ON effect.tenant_id = receipt.tenant_id
        AND effect.client_event_id = receipt.client_event_id
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.facility_id = $2::integer
        AND receipt.incident_id = $3::uuid
        AND receipt.paper_item_id = $4
      LIMIT 1`,
    tenantId,
    facilityId,
    incidentId,
    paperItemId,
  );
  return rows[0] || null;
}

function receiptOutcome(row, replayed) {
  return {
    client_event_id: row.client_event_id,
    disposition: row.disposition === 'applied' ? 'applied' : 'needs_review',
    outcome_code: row.outcome_code,
    replayed,
    receipt_fingerprint: row.receipt_fingerprint,
    fact: row.retrospective_fact_id ? {
      id: row.retrospective_fact_id,
      resource_type: row.fact_resource_type,
      resource_id: row.fact_resource_id,
      timeline_event_id: row.clinical_timeline_event_id,
      audit_event_id: row.clinical_audit_event_id,
      event_outbox_id: row.retrospective_event_outbox_id,
    } : null,
  };
}

async function inspectRetrospectiveTargetTx(tx, { tenantId, actionId, normalized }) {
  if (actionId === 'mar.administration.backfill') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid::text, status, administered_at, administered_by::text
         FROM medication_administrations
        WHERE tenant_id = $1::uuid AND id = $2::integer
        FOR UPDATE`,
      tenantId,
      normalized.medication_administration_id,
    );
    const row = rows[0];
    if (!row || row.patient_uid !== normalized.patient_uid) return { disposition: 'conflict', code: 'CONTINUITY_MAR_TARGET_MISMATCH' };
    if (String(row.status || '').toLowerCase() === 'administered') {
      const exact = row.administered_by === normalized.original_actor_uid
        && new Date(row.administered_at).toISOString() === normalized.occurred_at;
      return exact
        ? { disposition: 'exact_projection', row }
        : { disposition: 'conflict', code: 'CONTINUITY_MAR_STATE_CONFLICT' };
    }
    if (!['scheduled', 'due', 'pending'].includes(String(row.status || '').toLowerCase())) {
      return { disposition: 'conflict', code: 'CONTINUITY_MAR_STATE_CONFLICT' };
    }
    return { disposition: 'apply', row };
  }
  if (actionId === 'lab.specimen_collection.backfill') {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, COALESCE(patient_uid, uid)::text AS patient_uid, status,
              collected_at, collected_by::text, sample_barcode
         FROM investigations
        WHERE tenant_id = $1::uuid AND id = $2::integer
        FOR UPDATE`,
      tenantId,
      normalized.investigation_id,
    );
    const row = rows[0];
    if (!row || row.patient_uid !== normalized.patient_uid) return { disposition: 'conflict', code: 'CONTINUITY_LAB_TARGET_MISMATCH' };
    if (String(row.status || '').toUpperCase() === 'COLLECTED') {
      const exact = row.collected_by === normalized.original_actor_uid
        && new Date(row.collected_at).toISOString() === normalized.occurred_at
        && row.sample_barcode === normalized.specimen_barcode;
      return exact
        ? { disposition: 'exact_projection', row }
        : { disposition: 'conflict', code: 'CONTINUITY_LAB_STATE_CONFLICT' };
    }
    if (!['REQUESTED', 'BOOKED', 'SCHEDULED', 'PENDING'].includes(String(row.status || '').toUpperCase())) {
      return { disposition: 'conflict', code: 'CONTINUITY_LAB_STATE_CONFLICT' };
    }
    return { disposition: 'apply', row };
  }
  const requests = await tx.$queryRawUnsafe(
    `SELECT request.id, request.patient_uid::text, request.status,
            request.crossmatched_unit_id, unit.id AS unit_id, unit.unit_number
       FROM blood_requests AS request
       JOIN blood_units AS unit
         ON unit.tenant_id = request.tenant_id AND unit.id = $3::integer
      WHERE request.tenant_id = $1::uuid AND request.id = $2::integer
      FOR UPDATE OF request, unit`,
    tenantId,
    normalized.blood_request_id,
    normalized.blood_unit_id,
  );
  const request = requests[0];
  if (
    !request
    || request.patient_uid !== normalized.patient_uid
    || Number(request.unit_id) !== normalized.blood_unit_id
    || request.unit_number !== normalized.scanned_unit_number
    || (request.crossmatched_unit_id && Number(request.crossmatched_unit_id) !== normalized.blood_unit_id)
  ) {
    return { disposition: 'conflict', code: 'CONTINUITY_TRANSFUSION_TARGET_MISMATCH' };
  }
  const verifications = await tx.$queryRawUnsafe(
    `SELECT verifier_role, verified_by::text, scanned_unit_number,
            scanned_patient_uid::text, unit_match, patient_match,
            group_compatible, expiry_ok, verified_at
       FROM transfusion_verifications
      WHERE tenant_id = $1::uuid AND request_id = $2::integer
      ORDER BY verifier_role
      FOR UPDATE`,
    tenantId,
    normalized.blood_request_id,
  );
  if (verifications.length === 0) return { disposition: 'apply', row: request };
  if (verifications.length !== 2) {
    return { disposition: 'conflict', code: 'CONTINUITY_TRANSFUSION_STATE_CONFLICT' };
  }
  const byRole = Object.fromEntries(verifications.map(row => [row.verifier_role, row]));
  const exact = byRole.first?.verified_by === normalized.first_verifier_uid
    && byRole.second?.verified_by === normalized.second_verifier_uid
    && byRole.first?.scanned_unit_number === normalized.scanned_unit_number
    && byRole.second?.scanned_unit_number === normalized.scanned_unit_number
    && byRole.first?.scanned_patient_uid === normalized.patient_uid
    && byRole.second?.scanned_patient_uid === normalized.patient_uid
    && new Date(byRole.first?.verified_at).toISOString() === normalized.occurred_at
    && new Date(byRole.second?.verified_at).toISOString() === normalized.occurred_at;
  return exact
    ? { disposition: 'exact_projection', row: request }
    : { disposition: 'conflict', code: 'CONTINUITY_TRANSFUSION_STATE_CONFLICT' };
}

async function applyRetrospectiveProjectionTx(tx, { tenantId, actionId, normalized, inspection }) {
  if (inspection.disposition === 'exact_projection') return 'projection_reconciled';
  if (actionId === 'mar.administration.backfill') {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE medication_administrations
          SET status = 'administered', administered_at = $1::timestamptz,
              administered_by = $2::uuid, notes = COALESCE($3, notes),
              updated_at = clock_timestamp()
        WHERE tenant_id = $4::uuid AND id = $5::integer
          AND lower(status) IN ('scheduled', 'due', 'pending')
        RETURNING id`,
      normalized.occurred_at,
      normalized.original_actor_uid,
      normalized.notes,
      tenantId,
      normalized.medication_administration_id,
    );
    if (updated.length !== 1) throw AppError.conflict('Medication state changed', 'CONTINUITY_MAR_STATE_CONFLICT');
  } else if (actionId === 'lab.specimen_collection.backfill') {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE investigations
          SET status = 'COLLECTED', collected_at = $1::timestamptz,
              collected_by = $2::uuid, sample_barcode = $3,
              collected_notes = COALESCE($4, collected_notes),
              updated_at = clock_timestamp()
        WHERE tenant_id = $5::uuid AND id = $6::integer
          AND upper(status) IN ('REQUESTED', 'BOOKED', 'SCHEDULED', 'PENDING')
        RETURNING id`,
      normalized.occurred_at,
      normalized.original_actor_uid,
      normalized.specimen_barcode,
      normalized.collection_notes,
      tenantId,
      normalized.investigation_id,
    );
    if (updated.length !== 1) throw AppError.conflict('Investigation state changed', 'CONTINUITY_LAB_STATE_CONFLICT');
  }
  return 'recorded';
}

function typedFactReferences(actionId, normalized) {
  return {
    medication_administration_id: actionId === 'mar.administration.backfill'
      ? normalized.medication_administration_id : null,
    investigation_id: actionId === 'lab.specimen_collection.backfill'
      ? normalized.investigation_id : null,
    transfusion_request_id: actionId === 'blood.transfusion_verification.backfill'
      ? normalized.blood_request_id : null,
    blood_unit_id: actionId === 'blood.transfusion_verification.backfill'
      ? normalized.blood_unit_id : null,
    first_verifier_uid: actionId === 'blood.transfusion_verification.backfill'
      ? normalized.first_verifier_uid : null,
    second_verifier_uid: actionId === 'blood.transfusion_verification.backfill'
      ? normalized.second_verifier_uid : null,
  };
}

function buildPaperReceipt({
  tenantId,
  facilityId,
  parsed,
  paperItem,
  patientId,
  actorUid,
  actorRole,
  facilityContext,
  policy,
  fingerprint,
  clientEventId,
  receivedAt,
  appVersion,
  devicePosture,
}) {
  const capturedAt = parsed.normalized.occurred_at;
  const payloadHash = hashCanonicalValue(parsed.normalized);
  const actionChecksum = hashCanonicalValue(CLINICAL_CONTINUITY_ACTIONS_BY_ID[parsed.actionId]);
  const idempotencyIdentity = paperIdempotencyIdentity(parsed.identity);
  const expiresAt = new Date(Date.parse(capturedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  if (!policy.effectiveUntil) {
    throw AppError.conflict('Continuity policy requires a finite effective window', 'CONTINUITY_POLICY_NOT_EFFECTIVE');
  }
  return {
    tenant_id: tenantId,
    client_event_id: clientEventId,
    source_kind: 'paper_back_entry',
    facility_id: facilityId,
    incident_id: parsed.identity.incidentId,
    paper_item_id: parsed.identity.paperItemId,
    original_idempotency_key: idempotencyIdentity,
    action_id: parsed.actionId,
    binding_id: `${parsed.actionId}/v1`,
    http_method: 'POST',
    schema_id: parsed.definition.id,
    schema_version: parsed.definition.version,
    schema_checksum: parsed.definition.checksum,
    client_command_fingerprint: fingerprint,
    receipt_fingerprint: fingerprint,
    payload_hash: payloadHash,
    capture_actor_uid: actorUid,
    capture_role: actorRole,
    patient_id: patientId,
    patient_uid: parsed.normalized.patient_uid,
    appointment_id: null,
    encounter_id: parsed.normalized.encounter_id,
    admission_id: null,
    unit_id: null,
    device_id: facilityContext.deviceId,
    device_posture: String(devicePosture || 'managed').slice(0, 32),
    capture_session_id: facilityContext.contextId,
    occurred_at: parsed.normalized.occurred_at,
    captured_at: capturedAt,
    queued_at: capturedAt,
    expires_at: expiresAt,
    clock_evidence_hash: hashCanonicalValue({
      occurred_at: parsed.normalized.occurred_at,
      recorded_at: receivedAt,
      source: 'paper',
    }),
    cached_sources_hash: hashCanonicalValue({
      incident_id: parsed.identity.incidentId,
      packet_id: paperItem.packet_id,
      paper_range_id: paperItem.paper_range_id,
    }),
    source_cache_version: `incident:${paperItem.incident_version || 1}`,
    app_version: String(appVersion || 'paper-workbench/v1').slice(0, 80),
    envelope_schema_version: 1,
    queue_schema_version: 1,
    action_version: CLINICAL_CONTINUITY_ACTIONS_BY_ID[parsed.actionId].actionVersion,
    action_checksum: actionChecksum,
    policy_id: policy.id,
    policy_version: policy.policyVersion,
    policy_checksum: policy.policyChecksum,
    policy_signing_key_id: policy.policySigningKeyId,
    policy_effective_from: policy.effectiveFrom,
    policy_effective_until: policy.effectiveUntil,
    policy_supersedes_id: policy.supersedesPolicyId,
    policy_revocation_epoch: policy.revocationEpoch,
    registry_version: policy.actionRegistryVersion,
    registry_checksum: policy.actionRegistryChecksum,
    minimum_app_version: String(policy.policyDocument?.minimumAppVersion || 'paper-workbench/v1'),
    base_revision: paperItem.version,
    base_etag: null,
    ordering_key: `${tenantId}:${facilityId}:${parsed.identity.incidentId}:${parsed.identity.paperItemId}`,
    ordering_key_digest: hashCanonicalValue({
      tenant_id: tenantId,
      facility_id: facilityId,
      incident_id: parsed.identity.incidentId,
      paper_item_id: parsed.identity.paperItemId,
    }),
    sequence_no: 1,
    predecessor_client_event_id: null,
    supersession_generation: 0,
    human_review_required: false,
    received_at: receivedAt,
    recorded_at: null,
    disposition: 'claimed',
    outcome_code: null,
    retention_policy_id: 'C-D10-2026-07-31',
    detailed_evidence_until: new Date(Date.parse(receivedAt) + 365 * 24 * 60 * 60 * 1000).toISOString(),
    replay_eligibility_until: expiresAt,
    tombstone_until: new Date(Date.parse(receivedAt) + 2555 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export async function applyClinicalContinuityPaperBackEntry({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  facilityContext,
  requestId = null,
  appVersion = null,
  devicePosture = 'managed',
  idempotencyKey = null,
  parsed,
  patientAuthorizer = null,
  policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, PAPER_ACTION_ROLES[parsed?.actionId] || new Set(), 'CONTINUITY_PAPER_ACTION_ROLE_DENIED');
  const facility = positiveInteger(facilityId, 'facility_id');
  if (
    !facilityContext
    || uuid(facilityContext.actorUid, 'facility context actor') !== actor
    || positiveInteger(facilityContext.facilityId, 'facility context facility') !== facility
    || requireTenantId(facilityContext.tenantId) !== requireTenantId(tenantId)
  ) {
    throw AppError.forbidden('Facility context did not authorize paper back-entry', 'CONTINUITY_FACILITY_CONTEXT_DENIED');
  }
  const fingerprint = paperFingerprint({ tenantId: requireTenantId(tenantId), facilityId: facility, parsed });
  const clientEventId = paperClientEventId({
    tenantId: requireTenantId(tenantId),
    facilityId: facility,
    incidentId: parsed.identity.incidentId,
    paperItemId: parsed.identity.paperItemId,
  });
  const serverIdempotencyIdentity = paperIdempotencyIdentity(parsed.identity);

  return facilityTransaction({ tenantId, facilityId: facility }, async (tx, scope) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.external_recovery_effect_disposition', 'late_pending_only', true)`,
    );
    const itemRows = await tx.$queryRawUnsafe(
      `SELECT item.*, incident.version AS incident_version,
              incident.lifecycle_state, range.status AS range_status,
              temp.identity_status, temp.matched_patient_uid::text
         FROM clinical_continuity_paper_items AS item
         JOIN clinical_continuity_incidents AS incident
           ON incident.tenant_id = item.tenant_id
          AND incident.facility_id = item.facility_id
          AND incident.id = item.incident_id
         JOIN clinical_continuity_paper_ranges AS range
           ON range.tenant_id = item.tenant_id
          AND range.facility_id = item.facility_id
          AND range.id = item.paper_range_id
         LEFT JOIN clinical_continuity_temporary_identities AS temp
           ON temp.tenant_id = item.tenant_id
          AND temp.facility_id = item.facility_id
          AND temp.id = item.temporary_identity_id
        WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
          AND item.incident_id = $3::uuid AND item.paper_item_id = $4
        FOR UPDATE OF item, incident, range, temp`,
      scope.tenantId,
      scope.facilityId,
      parsed.identity.incidentId,
      parsed.identity.paperItemId,
    );
    const item = itemRows[0];
    if (!item) throw AppError.notFound('Paper item not found', 'CONTINUITY_PAPER_ITEM_NOT_FOUND');
    const effectivePatientUid = item.temporary_identity_id
      ? item.matched_patient_uid
      : item.patient_uid;
    if (!effectivePatientUid) {
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: parsed.identity.incidentId,
        queueType: 'identity',
        reasonCode: 'CONTINUITY_IDENTITY_UNRESOLVED',
        paperItemRowId: item.id,
        temporaryIdentityId: item.temporary_identity_id,
        patientUid: null,
        encounterId: item.encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      return { disposition: 'needs_review', code: 'CONTINUITY_IDENTITY_UNRESOLVED', reconciliation_item: review };
    }
    const patientRows = await tx.$queryRawUnsafe(
      `SELECT id, uid::text FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT'
        LIMIT 1`,
      scope.tenantId,
      effectivePatientUid,
    );
    if (!patientRows[0]) throw AppError.notFound('Patient not found', 'CONTINUITY_PATIENT_NOT_FOUND');
    await requireAuthorizedPaperPatient(patientAuthorizer, {
      patientUid: effectivePatientUid,
      patientId: patientRows[0].id,
    });
    const policy = await policyLoader({
      tx,
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      minimumPolicyVersion: facilityContext.policyVersion,
      minimumRevocationEpoch: facilityContext.revocationEpoch,
    });
    if (
      policy.id !== facilityContext.policyId
      || String(policy.policyVersion) !== String(facilityContext.policyVersion)
      || policy.policyChecksum !== facilityContext.policyChecksum
      || policy.policySigningKeyId !== facilityContext.policySigningKeyId
    ) {
      throw AppError.forbidden('Continuity policy context changed', 'CONTINUITY_POLICY_CONTEXT_MISMATCH');
    }
    const existing = await loadPaperReceiptTx(
      tx,
      scope.tenantId,
      scope.facilityId,
      parsed.identity.incidentId,
      parsed.identity.paperItemId,
    );
    if (existing) {
      if (existing.action_id === parsed.actionId && existing.receipt_fingerprint === fingerprint) {
        await appendPaperAttemptTx(tx, {
          tenantId: scope.tenantId,
          clientEventId,
          receiptLinked: true,
          actorUid: actor,
          actorRole: role,
          facilityContext,
          requestId,
          attemptClass: 'exact_duplicate',
          reasonCode: 'CONTINUITY_PAPER_EXACT_DUPLICATE',
          result: 'duplicate',
          idempotencyKey: idempotencyKey || serverIdempotencyIdentity,
        });
        return receiptOutcome(existing, true);
      }
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: parsed.identity.incidentId,
        queueType: 'needs_review',
        reasonCode: 'CONTINUITY_PAPER_FINGERPRINT_MISMATCH',
        paperItemRowId: item.id,
        patientUid: item.patient_uid || parsed.normalized.patient_uid,
        encounterId: item.encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      await appendPaperAttemptTx(tx, {
        tenantId: scope.tenantId,
        clientEventId: existing.client_event_id,
        receiptLinked: true,
        actorUid: actor,
        actorRole: role,
        facilityContext,
        requestId,
        attemptClass: 'fingerprint_mismatch',
        reasonCode: 'CONTINUITY_PAPER_FINGERPRINT_MISMATCH',
        result: 'needs_review',
        idempotencyKey: idempotencyKey || serverIdempotencyIdentity,
      });
      return { disposition: 'needs_review', code: 'CONTINUITY_PAPER_FINGERPRINT_MISMATCH', reconciliation_item: review };
    }
    if (Number(item.version) !== parsed.normalized.expected_version) {
      stale('Paper item', parsed.normalized.expected_version, item);
    }
    if (
      item.lifecycle_state === 'closed'
      || ['lost', 'revoked'].includes(item.range_status)
      || item.action_id !== parsed.actionId
      || item.evidence_hash !== parsed.normalized.evidence_hash
      || item.original_actor_uid !== parsed.normalized.original_actor_uid
      || item.original_actor_role !== parsed.normalized.original_actor_role
      || new Date(item.occurred_at).toISOString() !== parsed.normalized.occurred_at
    ) {
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: parsed.identity.incidentId,
        queueType: 'needs_review',
        reasonCode: 'CONTINUITY_PAPER_STATE_INVALID',
        paperItemRowId: item.id,
        patientUid: item.patient_uid || parsed.normalized.patient_uid,
        encounterId: item.encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      await appendPaperAttemptTx(tx, {
        tenantId: scope.tenantId,
        clientEventId,
        actorUid: actor,
        actorRole: role,
        facilityContext,
        requestId,
        attemptClass: 'paper_state_invalid',
        reasonCode: 'CONTINUITY_PAPER_STATE_INVALID',
        result: 'needs_review',
        idempotencyKey: idempotencyKey || serverIdempotencyIdentity,
      });
      return { disposition: 'needs_review', code: 'CONTINUITY_PAPER_STATE_INVALID', reconciliation_item: review };
    }
    if (effectivePatientUid !== parsed.normalized.patient_uid) {
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: parsed.identity.incidentId,
        queueType: 'identity',
        reasonCode: 'CONTINUITY_IDENTITY_UNRESOLVED',
        paperItemRowId: item.id,
        temporaryIdentityId: item.temporary_identity_id,
        patientUid: null,
        encounterId: item.encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      return { disposition: 'needs_review', code: 'CONTINUITY_IDENTITY_UNRESOLVED', reconciliation_item: review };
    }
    const inspection = await inspectRetrospectiveTargetTx(tx, {
      tenantId: scope.tenantId,
      actionId: parsed.actionId,
      normalized: parsed.normalized,
    });
    if (inspection.disposition === 'conflict') {
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: parsed.identity.incidentId,
        queueType: 'needs_review',
        reasonCode: inspection.code,
        paperItemRowId: item.id,
        patientUid: effectivePatientUid,
        encounterId: item.encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      await appendPaperAttemptTx(tx, {
        tenantId: scope.tenantId,
        clientEventId,
        actorUid: actor,
        actorRole: role,
        facilityContext,
        requestId,
        attemptClass: 'domain_state_conflict',
        reasonCode: inspection.code,
        result: 'needs_review',
        idempotencyKey: idempotencyKey || serverIdempotencyIdentity,
      });
      return { disposition: 'needs_review', code: inspection.code, reconciliation_item: review };
    }
    const receivedAt = policy.trustedNow;
    const captureTime = Date.parse(parsed.normalized.occurred_at);
    const receivedTime = Date.parse(receivedAt);
    const policyEffectiveFrom = Date.parse(policy.effectiveFrom);
    const policyEffectiveUntil = Date.parse(policy.effectiveUntil);
    const acceptanceExpired = receivedTime >= captureTime + 7 * 24 * 60 * 60 * 1000;
    const policyInvalidAtCapture = captureTime < policyEffectiveFrom || captureTime >= policyEffectiveUntil;
    if (acceptanceExpired || policyInvalidAtCapture) {
      const reasonCode = acceptanceExpired
        ? 'CONTINUITY_PAPER_ACCEPTANCE_EXPIRED'
        : 'CONTINUITY_PAPER_CAPTURE_POLICY_INVALID';
      const review = await insertReconciliationItemTx(tx, {
        tenantId: scope.tenantId,
        facilityId: scope.facilityId,
        incidentId: parsed.identity.incidentId,
        queueType: 'needs_review',
        reasonCode,
        paperItemRowId: item.id,
        patientUid: effectivePatientUid,
        encounterId: item.encounter_id,
        safetyCritical: true,
        actorUid: actor,
      });
      await appendPaperAttemptTx(tx, {
        tenantId: scope.tenantId,
        clientEventId,
        actorUid: actor,
        actorRole: role,
        facilityContext,
        requestId,
        attemptClass: 'paper_acceptance_blocked',
        reasonCode,
        result: 'needs_review',
        idempotencyKey: idempotencyKey || serverIdempotencyIdentity,
      });
      return { disposition: 'needs_review', code: reasonCode, reconciliation_item: review };
    }
    const receipt = buildPaperReceipt({
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      parsed,
      paperItem: item,
      patientId: patientRows[0].id,
      actorUid: actor,
      actorRole: role,
      facilityContext,
      policy,
      fingerprint,
      clientEventId,
      receivedAt,
      appVersion,
      devicePosture,
    });
    const claimed = await tx.$queryRawUnsafe(
      `SELECT clinical_continuity_paper_receipt_claim($1::uuid, $2::integer, $3::jsonb) AS claimed`,
      scope.tenantId,
      scope.facilityId,
      JSON.stringify(receipt),
    );
    if (claimed[0]?.claimed !== true) {
      throw AppError.conflict('Paper receipt was concurrently claimed', 'CONTINUITY_RECEIPT_RACE');
    }
    const domainDisposition = await applyRetrospectiveProjectionTx(tx, {
      tenantId: scope.tenantId,
      actionId: parsed.actionId,
      normalized: parsed.normalized,
      inspection,
    });
    const refs = typedFactReferences(parsed.actionId, parsed.normalized);
    const normalizedPayload = { ...parsed.normalized };
    delete normalizedPayload.expected_version;
    const factRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_retrospective_facts (
         tenant_id, facility_id, incident_id, paper_item_row_id,
         receipt_client_event_id, action_id, patient_uid, encounter_id,
         original_actor_uid, original_actor_role,
         medication_administration_id, investigation_id, transfusion_request_id,
         blood_unit_id, first_verifier_uid, second_verifier_uid,
         normalized_payload, payload_fingerprint, evidence_hash, occurred_at,
         effect_disposition, domain_disposition, created_by
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid,
         $5::uuid, $6, $7::uuid, $8::uuid,
         $9::uuid, $10,
         $11::integer, $12::integer, $13::integer,
         $14::integer, $15::uuid, $16::uuid,
         $17::jsonb, $18, $19, $20::timestamptz,
         'late_pending_only', $21, $22::uuid
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      parsed.identity.incidentId,
      item.id,
      clientEventId,
      parsed.actionId,
      effectivePatientUid,
      parsed.normalized.encounter_id,
      parsed.normalized.original_actor_uid,
      parsed.normalized.original_actor_role,
      refs.medication_administration_id,
      refs.investigation_id,
      refs.transfusion_request_id,
      refs.blood_unit_id,
      refs.first_verifier_uid,
      refs.second_verifier_uid,
      JSON.stringify(normalizedPayload),
      fingerprint,
      parsed.normalized.evidence_hash,
      parsed.normalized.occurred_at,
      domainDisposition,
      actor,
    );
    const fact = factRows[0];
    const canonical = await recordCanonicalClinicalEvent({
      tenantId: scope.tenantId,
      patientUid: effectivePatientUid,
      encounterId: parsed.normalized.encounter_id,
      eventType: 'continuity.paper_fact.recorded',
      eventSubtype: parsed.actionId,
      eventStatus: domainDisposition,
      sourceTable: 'clinical_continuity_retrospective_facts',
      sourceId: fact.id,
      resourceType: 'clinical_continuity_retrospective_fact',
      resourceTable: 'clinical_continuity_retrospective_facts',
      resourceId: fact.id,
      actorUid: actor,
      actorRole: role,
      occurredAt: parsed.normalized.occurred_at,
      visibleToPatient: true,
      clinicalSummary: 'Retrospective paper downtime fact recorded',
      payload: {
        action_id: parsed.actionId,
        incident_id: parsed.identity.incidentId,
        paper_item_id: parsed.identity.paperItemId,
        occurred_at: parsed.normalized.occurred_at,
        recorded_at: fact.recorded_at,
        reviewed_at: null,
        decided_at: null,
        effect_disposition: 'late_pending_only',
        retrospective: true,
      },
      timelineIdempotencyKey: `cc-fact:${fact.id}:timeline`,
      auditIdempotencyKey: `cc-fact:${fact.id}:audit`,
      requestId,
    }, { db: tx, strict: true });
    const outbox = await publishEvent({
      eventType: 'clinical_continuity.paper_fact.recorded',
      aggregateType: 'clinical_continuity_retrospective_fact',
      aggregateId: fact.id,
      patientUid: effectivePatientUid,
      tenantId: scope.tenantId,
      occurredAt: parsed.normalized.occurred_at,
      payload: {
        action_id: parsed.actionId,
        incident_id: parsed.identity.incidentId,
        paper_item_id: parsed.identity.paperItemId,
        fact_id: fact.id,
        occurred_at: parsed.normalized.occurred_at,
        recorded_at: fact.recorded_at,
        event_time_source: 'physical_occurrence',
        effect_disposition: 'late_pending_only',
        suppress_sla_breach_alarm: true,
        suppress_care_pathway_transition: true,
        suppress_patient_notification: true,
      },
      tx,
    });
    if (!outbox) throw AppError.internal('Retrospective event was not recorded', 'CONTINUITY_OUTBOX_REQUIRED');
    const outcomeCode = domainDisposition === 'projection_reconciled'
      ? 'paper_fact_projection_reconciled'
      : 'paper_fact_recorded';
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_replay_effect_evidence (
         tenant_id, client_event_id, outcome_code, retrospective_fact_id,
         paper_item_row_id, fact_resource_type, fact_resource_id,
         occurred_at, recorded_at, clinical_timeline_event_id,
         clinical_audit_event_id, retrospective_event_outbox_id,
         effect_disposition
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid,
         $5::uuid, 'clinical_continuity_retrospective_fact', $4::uuid::text,
         $6::timestamptz, $7::timestamptz, $8::uuid,
         $9::uuid, $10::bigint, 'late_pending_only'
       )`,
      scope.tenantId,
      clientEventId,
      outcomeCode,
      fact.id,
      item.id,
      parsed.normalized.occurred_at,
      fact.recorded_at,
      canonical.timeline.id,
      canonical.audit.id,
      outbox.id,
    );
    const updatedPaper = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_paper_items
          SET back_entry_actor_uid = $1::uuid,
              recorded_at = $2::timestamptz,
              payload_fingerprint = $3,
              receipt_client_event_id = $4::uuid,
              fact_id = $5::uuid,
              timeline_event_id = $6::uuid,
              audit_event_id = $7::uuid,
              reconciliation_disposition = 'applied',
              updated_by = $1::uuid,
              updated_at = clock_timestamp(),
              version = version + 1
        WHERE tenant_id = $8::uuid AND facility_id = $9::integer AND id = $10::uuid
          AND version = $11::integer
        RETURNING *`,
      actor,
      fact.recorded_at,
      fingerprint,
      clientEventId,
      fact.id,
      canonical.timeline.id,
      canonical.audit.id,
      scope.tenantId,
      scope.facilityId,
      item.id,
      parsed.normalized.expected_version,
    );
    if (updatedPaper.length !== 1) throw AppError.conflict('Paper item changed', 'CONTINUITY_RECEIPT_RACE');
    const finalized = await tx.$queryRawUnsafe(
      `SELECT clinical_continuity_replay_receipt_finalize($1::uuid, $2::uuid, 'applied', $3) AS finalized`,
      scope.tenantId,
      clientEventId,
      outcomeCode,
    );
    if (finalized[0]?.finalized !== true) {
      throw AppError.internal('Paper receipt was not sealed', 'CONTINUITY_RECEIPT_FINALIZE_REQUIRED');
    }
    await appendPaperAttemptTx(tx, {
      tenantId: scope.tenantId,
      clientEventId,
      receiptLinked: true,
      actorUid: actor,
      actorRole: role,
      facilityContext,
      requestId,
      attemptClass: 'paper_back_entry',
      reasonCode: outcomeCode,
      result: 'applied',
      idempotencyKey: idempotencyKey || serverIdempotencyIdentity,
    });
    return {
      client_event_id: clientEventId,
      disposition: 'applied',
      outcome_code: outcomeCode,
      replayed: false,
      receipt_fingerprint: fingerprint,
      paper_item: updatedPaper[0],
      fact: {
        id: fact.id,
        action_id: parsed.actionId,
        occurred_at: parsed.normalized.occurred_at,
        recorded_at: fact.recorded_at,
        reviewed_at: null,
        decided_at: null,
        effect_disposition: 'late_pending_only',
        timeline_event_id: canonical.timeline.id,
        audit_event_id: canonical.audit.id,
        event_outbox_id: outbox.id,
      },
    };
  });
}

export async function transitionClinicalContinuityIncident({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  expectedVersion,
  nextState,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, INCIDENT_ADMIN_ROLES);
  const incident = uuid(incidentId, 'incident_id');
  const expected = positiveInteger(expectedVersion, 'expected_version');
  const transitions = Object.freeze({
    declared: new Set(['restored']),
    restored: new Set(['reconciling']),
    reconciling: new Set(),
    closed: new Set(),
  });
  if (!['restored', 'reconciling'].includes(nextState)) {
    throw AppError.badRequest('next_state is invalid', 'CONTINUITY_INCIDENT_TRANSITION_INVALID');
  }
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incidents
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      incident,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Incident not found', 'CONTINUITY_INCIDENT_NOT_FOUND');
    if (Number(current.version) !== expected) stale('Incident', expected, current);
    if (!transitions[current.lifecycle_state]?.has(nextState)) {
      throw AppError.conflict('Incident transition is not allowed', 'CONTINUITY_INCIDENT_TRANSITION_INVALID');
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_incidents
          SET lifecycle_state = $1,
              restored_at = CASE WHEN $1 = 'restored' THEN clock_timestamp() ELSE restored_at END,
              reconciliation_started_at = CASE WHEN $1 = 'reconciling' THEN clock_timestamp() ELSE reconciliation_started_at END,
              updated_by = $2::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid
          AND version = $6::integer
        RETURNING *`,
      nextState,
      actor,
      scope.tenantId,
      scope.facilityId,
      incident,
      expected,
    );
    if (!updated[0]) stale('Incident', expected, current);
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: `clinical_continuity.incident.${nextState}`,
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_incident',
      resourceTable: 'clinical_continuity_incidents',
      resourceId: incident,
      requestId,
      beforeState: { lifecycle_state: current.lifecycle_state, version: current.version },
      afterState: { lifecycle_state: nextState, version: updated[0].version },
      idempotencyKey: `cc-incident:${incident}:state:${updated[0].version}`,
    });
    return { incident: updated[0], audit_event_id: audit.id };
  });
}

export async function recordClinicalContinuityRangeDisposition({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  expectedVersion,
  disposition,
  reasonCode,
  lastAccountedNumber = null,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, INCIDENT_ADMIN_ROLES);
  const incident = uuid(incidentId, 'incident_id');
  const expected = positiveInteger(expectedVersion, 'expected_version');
  const allowed = new Set(['lost', 'revoked', 'accounted', 'exhausted']);
  if (!allowed.has(disposition)) {
    throw AppError.badRequest('range disposition is invalid', 'CONTINUITY_PAPER_RANGE_INVALID');
  }
  const reason = safeText(reasonCode, 'reason_code', 120);
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_paper_ranges
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND incident_id = $3::uuid
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      incident,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Paper range not found', 'CONTINUITY_PAPER_RANGE_NOT_FOUND');
    if (Number(current.version) !== expected) stale('Paper range', expected, current);
    if (['lost', 'revoked', 'accounted', 'exhausted'].includes(current.status)) {
      throw AppError.conflict('Paper range already has a terminal disposition', 'CONTINUITY_PAPER_RANGE_TERMINAL');
    }
    const accounted = lastAccountedNumber == null
      ? current.last_accounted_number
      : positiveInteger(lastAccountedNumber, 'last_accounted_number');
    const updated = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_paper_ranges
          SET status = $1,
              last_accounted_number = $2::bigint,
              loss_reported_at = CASE WHEN $1 = 'lost' THEN clock_timestamp() ELSE loss_reported_at END,
              revoked_at = CASE WHEN $1 = 'revoked' THEN clock_timestamp() ELSE revoked_at END,
              reason = $3,
              updated_by = $4::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $5::uuid AND facility_id = $6::integer AND id = $7::uuid
          AND version = $8::integer
        RETURNING *`,
      disposition,
      accounted,
      reason,
      actor,
      scope.tenantId,
      scope.facilityId,
      current.id,
      expected,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO clinical_continuity_paper_range_decisions (
         tenant_id, facility_id, paper_range_id, decision, reason_code,
         actor_uid, actor_role
       ) VALUES ($1::uuid, $2::integer, $3::uuid, $4, $5, $6::uuid, $7)`,
      scope.tenantId,
      scope.facilityId,
      current.id,
      disposition === 'lost' ? 'loss_reported' : disposition,
      reason,
      actor,
      role,
    );
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: `clinical_continuity.paper_range.${disposition}`,
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_paper_range',
      resourceTable: 'clinical_continuity_paper_ranges',
      resourceId: current.id,
      requestId,
      beforeState: { status: current.status, version: current.version },
      afterState: { status: disposition, version: updated[0].version, reason_code: reason },
      idempotencyKey: `cc-range:${current.id}:decision:${updated[0].version}`,
    });
    return { paper_range: updated[0], audit_event_id: audit.id };
  });
}

export async function appendClinicalContinuityIncidentAlias({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  observedIncidentId,
  canonicalIncidentId,
  expectedVersion,
  reasonCode,
  supersedesAliasId = null,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, INCIDENT_ADMIN_ROLES);
  const observed = uuid(observedIncidentId, 'observed_incident_id');
  const canonical = uuid(canonicalIncidentId, 'canonical_incident_id');
  const expected = positiveInteger(expectedVersion, 'expected_version');
  const reason = safeText(reasonCode, 'reason_code', 120);
  if (observed === canonical) {
    throw AppError.badRequest('Incident alias endpoints must differ', 'CONTINUITY_INCIDENT_ALIAS_INVALID');
  }
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incidents
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND id IN ($3::uuid, $4::uuid)
        ORDER BY id FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      observed,
      canonical,
    );
    if (rows.length !== 2) throw AppError.notFound('Incident not found', 'CONTINUITY_INCIDENT_NOT_FOUND');
    const observedRow = rows.find(row => row.id === observed);
    if (Number(observedRow.version) !== expected) stale('Incident', expected, observedRow);
    const supersedes = supersedesAliasId ? uuid(supersedesAliasId, 'supersedes_alias_id') : null;
    if (supersedes) {
      const supersededRows = await tx.$queryRawUnsafe(
        `SELECT id FROM clinical_continuity_incident_aliases
          WHERE tenant_id = $1::uuid AND facility_id = $2::integer
            AND observed_incident_id = $3::uuid AND id = $4::uuid
          FOR SHARE`,
        scope.tenantId,
        scope.facilityId,
        observed,
        supersedes,
      );
      if (!supersededRows[0]) {
        throw AppError.notFound('Superseded incident alias not found', 'CONTINUITY_INCIDENT_ALIAS_NOT_FOUND');
      }
    }
    const aliasRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_incident_aliases (
         tenant_id, facility_id, observed_incident_id, canonical_incident_id,
         disposition, supersedes_alias_id, reason_code, decided_by, decided_role
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid,
         $5, $6::uuid, $7, $8::uuid, $9
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      observed,
      canonical,
      supersedes ? 'corrective' : 'active',
      supersedes,
      reason,
      actor,
      role,
    );
    const updated = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_incidents
          SET canonical_incident_id = $1::uuid,
              alias_disposition = 'observed_alias',
              updated_by = $2::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid
          AND version = $6::integer
        RETURNING *`,
      canonical,
      actor,
      scope.tenantId,
      scope.facilityId,
      observed,
      expected,
    );
    if (!updated[0]) stale('Incident', expected, observedRow);
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.incident.alias_appended',
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_incident_alias',
      resourceTable: 'clinical_continuity_incident_aliases',
      resourceId: aliasRows[0].id,
      requestId,
      afterState: {
        observed_incident_id: observed,
        canonical_incident_id: canonical,
        disposition: aliasRows[0].disposition,
        supersedes_alias_id: supersedes,
      },
      idempotencyKey: `cc-alias:${aliasRows[0].id}`,
    });
    return { alias: aliasRows[0], incident: updated[0], audit_event_id: audit.id };
  });
}

export async function decideClinicalContinuityReconciliationItem({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  itemId,
  expectedVersion,
  decision,
  reasonCode,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = normalizeRole(actorRole);
  const item = uuid(itemId, 'reconciliation_item_id');
  const expected = positiveInteger(expectedVersion, 'expected_version');
  const allowed = new Set(['accept', 'exclude', 'assign', 'handoff', 'reopen', 'supersede']);
  if (!allowed.has(decision)) {
    throw AppError.badRequest('decision is invalid', 'CONTINUITY_RECONCILIATION_DECISION_INVALID');
  }
  const reason = safeText(reasonCode, 'reason_code', 120);
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_reconciliation_items
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      item,
    );
    const current = rows[0];
    if (!current) throw AppError.notFound('Reconciliation item not found', 'CONTINUITY_RECONCILIATION_ITEM_NOT_FOUND');
    if (Number(current.version) !== expected) stale('Reconciliation item', expected, current);
    const isConfiguredSafetyLead = config.clinical_safety_lead_uid === actor;
    if (!INCIDENT_ADMIN_ROLES.has(role) && !isConfiguredSafetyLead && current.assigned_to_uid !== actor) {
      throw AppError.forbidden('Reconciliation decision was denied', 'CONTINUITY_RECONCILIATION_ROLE_DENIED');
    }
    const resolved = ['accept', 'exclude', 'supersede'].includes(decision);
    const nextDisposition = decision === 'exclude'
      ? 'excluded'
      : decision === 'supersede'
        ? 'superseded'
        : resolved
          ? 'resolved'
          : decision === 'reopen'
            ? 'open'
            : 'in_progress';
    const assignee = decision === 'assign'
      ? config.clinical_safety_lead_uid
      : current.assigned_to_uid;
    if (decision === 'assign' && !assignee) {
      throw AppError.conflict('No named configured assignee exists', 'CONTINUITY_RECONCILIATION_ASSIGNEE_REQUIRED');
    }
    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_reconciliation_items
          SET disposition = $1,
              assigned_to_uid = $2::uuid,
              handoff_actor_uid = CASE WHEN $3 = 'handoff' THEN $4::uuid ELSE handoff_actor_uid END,
              handoff_attested_at = CASE WHEN $3 = 'handoff' THEN clock_timestamp() ELSE handoff_attested_at END,
              resolved_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
              updated_by = $4::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $6::uuid AND facility_id = $7::integer AND id = $8::uuid
          AND version = $9::integer
        RETURNING *`,
      nextDisposition,
      assignee,
      decision,
      actor,
      resolved,
      scope.tenantId,
      scope.facilityId,
      item,
      expected,
    );
    const updated = updatedRows[0];
    if (!updated) stale('Reconciliation item', expected, current);
    const decisionRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_reconciliation_decisions (
         tenant_id, facility_id, reconciliation_item_id, decision,
         reason_code, actor_uid, actor_role, prior_version, resulting_version
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4,
         $5, $6::uuid, $7, $8::integer, $9::integer
       ) RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      item,
      decision,
      reason,
      actor,
      role,
      expected,
      updated.version,
    );
    if (resolved && current.task_id) {
      await transitionTask({
        tenantId: scope.tenantId,
        id: current.task_id,
        nextStatus: decision === 'supersede' ? 'cancelled' : 'completed',
        cancellationReason: decision === 'supersede' ? reason : null,
        actorUid: actor,
        tx,
      });
    }
    if (current.paper_item_row_id && ['accept', 'exclude'].includes(decision)) {
      await tx.$executeRawUnsafe(
        `UPDATE clinical_continuity_paper_items
            SET reviewer_uid = $1::uuid, reviewed_at = clock_timestamp(),
                reconciliation_disposition = CASE WHEN $2 = 'exclude' THEN 'excluded' ELSE reconciliation_disposition END,
                updated_by = $1::uuid, updated_at = clock_timestamp(), version = version + 1
          WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid`,
        actor,
        decision,
        scope.tenantId,
        scope.facilityId,
        current.paper_item_row_id,
      );
    }
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      patientUid: current.patient_uid,
      encounterId: current.encounter_id,
      action: `clinical_continuity.reconciliation.${decision}`,
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_reconciliation_item',
      resourceTable: 'clinical_continuity_reconciliation_items',
      resourceId: item,
      requestId,
      beforeState: { disposition: current.disposition, version: current.version },
      afterState: { disposition: updated.disposition, version: updated.version, reason_code: reason },
      idempotencyKey: `cc-reconciliation:${item}:decision:${updated.version}`,
    });
    return { item: updated, decision: decisionRows[0], audit_event_id: audit.id };
  });
}

export async function recordClinicalContinuityDeviceOffset({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  deviceId,
  requiredHighWaterMark,
  observedHighWaterMark = null,
  disposition = 'pending',
  expectedVersion = 0,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, INCIDENT_ADMIN_ROLES);
  const incident = uuid(incidentId, 'incident_id');
  const device = uuid(deviceId, 'device_id');
  const required = positiveInteger(requiredHighWaterMark, 'required_high_water_mark', { allowZero: true });
  const observed = observedHighWaterMark == null
    ? null
    : positiveInteger(observedHighWaterMark, 'observed_high_water_mark', { allowZero: true });
  const expected = positiveInteger(expectedVersion, 'expected_version', { allowZero: true });
  if (!['pending', 'reconciled', 'lost_assigned', 'not_applicable'].includes(disposition)) {
    throw AppError.badRequest('device disposition is invalid', 'CONTINUITY_DEVICE_OFFSET_INVALID');
  }
  if (disposition === 'reconciled' && (observed == null || observed < required)) {
    throw AppError.conflict('Device high-water mark is incomplete', 'CONTINUITY_DEVICE_HWM_INCOMPLETE');
  }
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const owner = config.needs_review_owner_principal;
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_device_journal_offsets
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND incident_id = $3::uuid AND device_id = $4::uuid
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      incident,
      device,
    );
    if (!rows[0]) {
      if (expected !== 0) stale('Device offset', expected, null);
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_device_journal_offsets (
           tenant_id, facility_id, incident_id, device_id,
           required_high_water_mark, observed_high_water_mark, disposition,
           owner_principal, updated_by
         ) VALUES (
           $1::uuid, $2::integer, $3::uuid, $4::uuid,
           $5::bigint, $6::bigint, $7, $8, $9::uuid
         ) RETURNING *`,
        scope.tenantId,
        scope.facilityId,
        incident,
        device,
        required,
        observed,
        disposition,
        owner,
        actor,
      );
      await requiredAudit(tx, {
        tenantId: scope.tenantId,
        action: 'clinical_continuity.device_offset.recorded',
        actorUid: actor,
        actorRole: role,
        resourceType: 'clinical_continuity_device_journal_offset',
        resourceTable: 'clinical_continuity_device_journal_offsets',
        resourceId: inserted[0].id,
        requestId,
        afterState: {
          incident_id: incident,
          device_id: device,
          disposition: inserted[0].disposition,
          version: inserted[0].version,
        },
        idempotencyKey: `cc-device-offset:${inserted[0].id}:${inserted[0].version}`,
      });
      return inserted[0];
    }
    if (Number(rows[0].version) !== expected) stale('Device offset', expected, rows[0]);
    const updated = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_device_journal_offsets
          SET required_high_water_mark = $1::bigint,
              observed_high_water_mark = $2::bigint,
              disposition = $3, owner_principal = $4,
              updated_by = $5::uuid, updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $6::uuid AND facility_id = $7::integer AND id = $8::uuid
          AND version = $9::integer
        RETURNING *`,
      required,
      observed,
      disposition,
      owner,
      actor,
      scope.tenantId,
      scope.facilityId,
      rows[0].id,
      expected,
    );
    await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.device_offset.recorded',
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_device_journal_offset',
      resourceTable: 'clinical_continuity_device_journal_offsets',
      resourceId: updated[0].id,
      requestId,
      beforeState: {
        disposition: rows[0].disposition,
        version: rows[0].version,
      },
      afterState: {
        disposition: updated[0].disposition,
        version: updated[0].version,
      },
      idempotencyKey: `cc-device-offset:${updated[0].id}:${updated[0].version}`,
    });
    return updated[0];
  });
}

export async function recordClinicalContinuityInterfaceRequirement({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  offsetId = null,
  interfaceFamily,
  direction,
  sourcePartition,
  requiredGeneration = null,
  requiredHighWaterPosition = null,
  requiredHighWaterToken = null,
  disposition = 'pending',
  expectedVersion = 0,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = requireRole(actorRole, INCIDENT_ADMIN_ROLES);
  const incident = uuid(incidentId, 'incident_id');
  const offset = offsetId ? uuid(offsetId, 'offset_id') : null;
  const family = safeText(interfaceFamily, 'interface_family', 8);
  const interfaceDirection = safeText(direction, 'direction', 16);
  const partition = safeText(sourcePartition, 'source_partition', 160);
  const expected = positiveInteger(expectedVersion, 'expected_version', { allowZero: true });
  if (!['pending', 'reconciled', 'not_applicable', 'assigned_gap'].includes(disposition)) {
    throw AppError.badRequest('interface disposition is invalid', 'CONTINUITY_INTERFACE_INVALID');
  }
  if ((disposition === 'not_applicable') !== (offset === null)) {
    throw AppError.badRequest('interface offset shape is invalid', 'CONTINUITY_INTERFACE_INVALID');
  }
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const owner = config.interface_owner_principal;
    if (offset) {
      const live = await tx.$queryRawUnsafe(
        `SELECT offset_id::text, generation, high_water_position, high_water_token
           FROM event_consumer_offsets
          WHERE tenant_id = $1::uuid AND offset_id = $2::uuid
            AND scope_kind = 'external_interface'
          FOR SHARE`,
        scope.tenantId,
        offset,
      );
      if (!live[0]) throw AppError.notFound('Interface offset not found', 'CONTINUITY_INTERFACE_OFFSET_NOT_FOUND');
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incident_interfaces
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND incident_id = $3::uuid AND interface_family = $4
          AND direction = $5 AND source_partition = $6
        FOR UPDATE`,
      scope.tenantId,
      scope.facilityId,
      incident,
      family,
      interfaceDirection,
      partition,
    );
    if (!rows[0]) {
      if (expected !== 0) stale('Interface requirement', expected, null);
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_continuity_incident_interfaces (
           tenant_id, facility_id, incident_id, offset_id, interface_family,
           direction, source_partition, required_generation,
           required_high_water_position, required_high_water_token,
           disposition, owner_principal, updated_by
         ) VALUES (
           $1::uuid, $2::integer, $3::uuid, $4::uuid, $5,
           $6, $7, $8::integer, $9::bigint, $10,
           $11, $12, $13::uuid
         ) RETURNING *`,
        scope.tenantId,
        scope.facilityId,
        incident,
        offset,
        family,
        interfaceDirection,
        partition,
        requiredGeneration,
        requiredHighWaterPosition,
        requiredHighWaterToken,
        disposition,
        owner,
        actor,
      );
      await requiredAudit(tx, {
        tenantId: scope.tenantId,
        action: 'clinical_continuity.interface_requirement.recorded',
        actorUid: actor,
        actorRole: role,
        resourceType: 'clinical_continuity_incident_interface',
        resourceTable: 'clinical_continuity_incident_interfaces',
        resourceId: inserted[0].id,
        requestId,
        afterState: {
          incident_id: incident,
          offset_id: offset,
          disposition: inserted[0].disposition,
          version: inserted[0].version,
        },
        idempotencyKey: `cc-interface:${inserted[0].id}:${inserted[0].version}`,
      });
      return inserted[0];
    }
    if (Number(rows[0].version) !== expected) stale('Interface requirement', expected, rows[0]);
    const updated = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_incident_interfaces
          SET offset_id = $1::uuid, required_generation = $2::integer,
              required_high_water_position = $3::bigint,
              required_high_water_token = $4, disposition = $5,
              owner_principal = $6, updated_by = $7::uuid,
              updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $8::uuid AND facility_id = $9::integer AND id = $10::uuid
          AND version = $11::integer
        RETURNING *`,
      offset,
      requiredGeneration,
      requiredHighWaterPosition,
      requiredHighWaterToken,
      disposition,
      owner,
      actor,
      scope.tenantId,
      scope.facilityId,
      rows[0].id,
      expected,
    );
    await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.interface_requirement.recorded',
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_incident_interface',
      resourceTable: 'clinical_continuity_incident_interfaces',
      resourceId: updated[0].id,
      requestId,
      beforeState: {
        disposition: rows[0].disposition,
        version: rows[0].version,
      },
      afterState: {
        disposition: updated[0].disposition,
        version: updated[0].version,
      },
      idempotencyKey: `cc-interface:${updated[0].id}:${updated[0].version}`,
    });
    return updated[0];
  });
}

async function closureSnapshotTx(tx, { tenantId, facilityId, incidentId }) {
  const incidentRows = await tx.$queryRawUnsafe(
    `SELECT * FROM clinical_continuity_incidents
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid
      FOR UPDATE`,
    tenantId,
    facilityId,
    incidentId,
  );
  const incident = incidentRows[0];
  if (!incident) throw AppError.notFound('Incident not found', 'CONTINUITY_INCIDENT_NOT_FOUND');
  const ranges = await tx.$queryRawUnsafe(
    `SELECT * FROM clinical_continuity_paper_ranges
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND incident_id = $3::uuid
      ORDER BY id FOR UPDATE`,
    tenantId,
    facilityId,
    incidentId,
  );
  const paperItems = await tx.$queryRawUnsafe(
    `SELECT item.id::text, item.paper_item_id, item.reconciliation_disposition,
            item.version, item.receipt_client_event_id::text, item.fact_id::text
       FROM clinical_continuity_paper_items AS item
      WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
        AND item.incident_id = $3::uuid
      ORDER BY item.id FOR UPDATE`,
    tenantId,
    facilityId,
    incidentId,
  );
  const temporaryIdentities = await tx.$queryRawUnsafe(
    `SELECT * FROM clinical_continuity_temporary_identities
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND incident_id = $3::uuid
      ORDER BY id FOR UPDATE`,
    tenantId,
    facilityId,
    incidentId,
  );
  const devices = await tx.$queryRawUnsafe(
    `SELECT * FROM clinical_continuity_device_journal_offsets
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND incident_id = $3::uuid
      ORDER BY id FOR UPDATE`,
    tenantId,
    facilityId,
    incidentId,
  );
  const interfaces = await tx.$queryRawUnsafe(
    `SELECT * FROM clinical_continuity_incident_interfaces
      WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND incident_id = $3::uuid
      ORDER BY id FOR UPDATE`,
    tenantId,
    facilityId,
    incidentId,
  );
  const offsetIds = interfaces.map(row => row.offset_id).filter(Boolean);
  const offsets = offsetIds.length === 0 ? [] : await tx.$queryRawUnsafe(
    `SELECT offset_id::text, generation, high_water_position, high_water_token,
            recovery_state, updated_at
       FROM event_consumer_offsets
      WHERE tenant_id = $1::uuid AND offset_id = ANY($2::uuid[])
      ORDER BY offset_id FOR UPDATE`,
    tenantId,
    offsetIds,
  );
  const reconciliationItems = await tx.$queryRawUnsafe(
    `SELECT item.*, task.status AS task_status
       FROM clinical_continuity_reconciliation_items AS item
       LEFT JOIN tasks AS task ON task.tenant_id = item.tenant_id AND task.id = item.task_id
      WHERE item.tenant_id = $1::uuid AND item.facility_id = $2::integer
        AND item.incident_id = $3::uuid
      ORDER BY item.id FOR UPDATE OF item`,
    tenantId,
    facilityId,
    incidentId,
  );
  const taskIds = reconciliationItems.map(row => row.task_id).filter(Boolean);
  if (taskIds.length > 0) {
    await tx.$queryRawUnsafe(
      `SELECT id FROM tasks WHERE tenant_id = $1::uuid AND id = ANY($2::integer[]) ORDER BY id FOR UPDATE`,
      tenantId,
      taskIds,
    );
  }
  const offsetById = new Map(offsets.map(row => [row.offset_id, row]));
  const blockers = [];
  for (const range of ranges) {
    const terminal = ['accounted', 'lost', 'revoked', 'exhausted'].includes(range.status);
    const fullyCounted = ['lost', 'revoked'].includes(range.status)
      || Number(range.last_accounted_number) === Number(range.range_last);
    if (!terminal || !fullyCounted) blockers.push({ code: 'CONTINUITY_CLOSURE_PAPER_RANGE_UNACCOUNTED', id: range.id });
  }
  for (const item of paperItems) {
    const governed = ['applied', 'excluded', 'voided', 'lost_revoked'].includes(item.reconciliation_disposition);
    const appliedComplete = item.reconciliation_disposition !== 'applied'
      || (item.receipt_client_event_id && item.fact_id);
    if (!governed || !appliedComplete) blockers.push({ code: 'CONTINUITY_CLOSURE_PAPER_ITEM_UNRESOLVED', id: item.id });
  }
  for (const identity of temporaryIdentities) {
    if (identity.safety_critical && identity.identity_status === 'unresolved') {
      blockers.push({ code: 'CONTINUITY_CLOSURE_IDENTITY_SAFETY_BLOCKER', id: identity.id });
    }
  }
  for (const device of devices) {
    const complete = ['lost_assigned', 'not_applicable'].includes(device.disposition)
      || (device.disposition === 'reconciled'
        && device.observed_high_water_mark != null
        && BigInt(device.observed_high_water_mark) >= BigInt(device.required_high_water_mark));
    if (!complete) blockers.push({ code: 'CONTINUITY_CLOSURE_DEVICE_HWM_BLOCKER', id: device.id });
  }
  for (const requirement of interfaces) {
    if (requirement.disposition === 'not_applicable') continue;
    const offset = offsetById.get(String(requirement.offset_id));
    const complete = Boolean(offset)
      && requirement.disposition === 'reconciled'
      && (requirement.required_generation == null || Number(offset.generation) === Number(requirement.required_generation))
      && (requirement.required_high_water_position == null
        || (offset.high_water_position != null
          && BigInt(offset.high_water_position) >= BigInt(requirement.required_high_water_position)))
      && (requirement.required_high_water_token == null
        || offset.high_water_token === requirement.required_high_water_token);
    if (!complete) blockers.push({ code: 'CONTINUITY_CLOSURE_INTERFACE_HWM_BLOCKER', id: requirement.id });
  }
  for (const item of reconciliationItems) {
    const unresolved = ['open', 'in_progress'].includes(item.disposition);
    const taskOpen = item.task_status && OPEN_TASK_STATUSES.includes(item.task_status);
    if (item.safety_critical && (unresolved || taskOpen)) {
      blockers.push({ code: 'CONTINUITY_CLOSURE_SAFETY_ITEM_BLOCKER', id: item.id });
    } else if (unresolved && (!item.owner_principal || !item.assigned_to_uid || !item.handoff_attested_at)) {
      blockers.push({ code: 'CONTINUITY_CLOSURE_UNOWNED_ITEM_BLOCKER', id: item.id });
    }
  }
  const snapshotEvidence = {
    incident_id: incident.id,
    incident_version: Number(incident.version),
    range_versions: ranges.map(row => [row.id, Number(row.version), row.status, String(row.last_accounted_number)]),
    paper_versions: paperItems.map(row => [row.id, Number(row.version), row.reconciliation_disposition]),
    identity_versions: temporaryIdentities.map(row => [row.id, Number(row.version), row.identity_status]),
    device_versions: devices.map(row => [row.id, Number(row.version), row.disposition, String(row.observed_high_water_mark)]),
    interface_versions: interfaces.map(row => [
      row.id,
      Number(row.version),
      row.disposition,
      (() => {
        const offset = offsetById.get(String(row.offset_id));
        return offset ? {
          offset_id: String(offset.offset_id),
          generation: Number(offset.generation),
          high_water_position: offset.high_water_position == null
            ? null
            : String(offset.high_water_position),
          high_water_token: offset.high_water_token ?? null,
          recovery_state: offset.recovery_state ?? null,
          updated_at: offset.updated_at instanceof Date
            ? offset.updated_at.toISOString()
            : (offset.updated_at ?? null),
        } : null;
      })(),
    ]),
    reconciliation_versions: reconciliationItems.map(row => [row.id, Number(row.version), row.disposition, row.task_status]),
    blocker_codes: blockers.map(blocker => `${blocker.code}:${blocker.id}`).sort(),
  };
  return {
    incident,
    blockers,
    predicate_snapshot_hash: hashCanonicalValue(snapshotEvidence),
    evidence: snapshotEvidence,
  };
}

export async function checkClinicalContinuityClosure({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  incidentId,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = normalizeRole(actorRole);
  const incident = uuid(incidentId, 'incident_id');
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const snapshot = await closureSnapshotTx(tx, {
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      incidentId: incident,
    });
    const resourceAuthorized = INCIDENT_ADMIN_ROLES.has(role)
      || config.clinical_safety_lead_uid === actor
      || snapshot.incident.commander_uid === actor;
    if (!resourceAuthorized) {
      throw AppError.forbidden('Incident closure access was denied', 'CONTINUITY_CLOSURE_ROLE_DENIED');
    }
    const attestations = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incident_attestations
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND incident_id = $3::uuid AND incident_version = $4::integer
          AND predicate_snapshot_hash = $5
        ORDER BY attestation_kind`,
      scope.tenantId,
      scope.facilityId,
      incident,
      snapshot.incident.version,
      snapshot.predicate_snapshot_hash,
    );
    const operational = attestations.find(row => row.attestation_kind === 'operational');
    const clinical = attestations.find(row => row.attestation_kind === 'clinical');
    const attestationBlockers = [];
    if (!operational) attestationBlockers.push({ code: 'CONTINUITY_CLOSURE_COMMANDER_ATTESTATION_REQUIRED' });
    if (!clinical) attestationBlockers.push({ code: 'CONTINUITY_CLOSURE_CLINICAL_ATTESTATION_REQUIRED' });
    if (operational && clinical && operational.actor_uid === clinical.actor_uid) {
      attestationBlockers.push({ code: 'CONTINUITY_CLOSURE_ACTOR_SEPARATION_REQUIRED' });
    }
    return {
      eligible: snapshot.blockers.length === 0 && attestationBlockers.length === 0,
      incident: snapshot.incident,
      predicate_snapshot_hash: snapshot.predicate_snapshot_hash,
      blockers: [...snapshot.blockers, ...attestationBlockers],
      attestations,
    };
  });
}

export async function attestClinicalContinuityClosure({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  expectedVersion,
  attestationKind,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = normalizeRole(actorRole);
  const incident = uuid(incidentId, 'incident_id');
  const expected = positiveInteger(expectedVersion, 'expected_version');
  if (!['operational', 'clinical'].includes(attestationKind)) {
    throw AppError.badRequest('attestation_kind is invalid', 'CONTINUITY_CLOSURE_ATTESTATION_INVALID');
  }
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const snapshot = await closureSnapshotTx(tx, {
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      incidentId: incident,
    });
    if (Number(snapshot.incident.version) !== expected) stale('Incident', expected, snapshot.incident);
    if (snapshot.blockers.length > 0) {
      throw AppError.conflict('Incident closure predicate is blocked', 'CONTINUITY_CLOSURE_BLOCKED', {
        blockers: snapshot.blockers,
        safe: true,
      });
    }
    if (attestationKind === 'operational') {
      if (snapshot.incident.commander_uid !== actor) {
        throw AppError.forbidden('Only the incident commander may attest operational closure', 'CONTINUITY_COMMANDER_ATTESTATION_DENIED');
      }
    } else if (!config.clinical_safety_lead_uid || config.clinical_safety_lead_uid !== actor) {
      throw AppError.forbidden('Only the configured clinical safety lead may attest clinical closure', 'CONTINUITY_CLINICAL_ATTESTATION_DENIED');
    }
    if (attestationKind === 'clinical' && snapshot.incident.commander_uid === actor) {
      throw AppError.conflict('Closure actors must be distinct', 'CONTINUITY_CLOSURE_ACTOR_SEPARATION_REQUIRED');
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_incident_attestations (
         tenant_id, facility_id, incident_id, attestation_kind,
         actor_uid, actor_role, incident_version, predicate_snapshot_hash
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4,
         $5::uuid, $6, $7::integer, $8
       )
       ON CONFLICT (tenant_id, facility_id, incident_id, incident_version, attestation_kind)
       DO NOTHING
       RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      incident,
      attestationKind,
      actor,
      role,
      expected,
      snapshot.predicate_snapshot_hash,
    );
    const attestation = rows[0] || (await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incident_attestations
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND incident_id = $3::uuid AND incident_version = $4::integer
          AND attestation_kind = $5`,
      scope.tenantId,
      scope.facilityId,
      incident,
      expected,
      attestationKind,
    ))[0];
    if (
      attestation.actor_uid !== actor
      || attestation.predicate_snapshot_hash !== snapshot.predicate_snapshot_hash
    ) {
      throw AppError.conflict('Closure attestation changed', 'CONTINUITY_CLOSURE_ATTESTATION_CONFLICT');
    }
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: `clinical_continuity.incident.closure_${attestationKind}_attested`,
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_incident_attestation',
      resourceTable: 'clinical_continuity_incident_attestations',
      resourceId: attestation.id,
      requestId,
      afterState: {
        incident_id: incident,
        incident_version: expected,
        attestation_kind: attestationKind,
        predicate_snapshot_hash: snapshot.predicate_snapshot_hash,
      },
      idempotencyKey: `cc-closure:${incident}:${expected}:${attestationKind}`,
    });
    return { attestation, predicate_snapshot_hash: snapshot.predicate_snapshot_hash, audit_event_id: audit.id };
  });
}

export async function closeClinicalContinuityIncident({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  requestId = null,
  incidentId,
  expectedVersion,
}) {
  const actor = uuid(actorUid, 'actor_uid');
  const role = normalizeRole(actorRole);
  const incident = uuid(incidentId, 'incident_id');
  const expected = positiveInteger(expectedVersion, 'expected_version');
  return facilityTransaction({ tenantId, facilityId }, async (tx, scope) => {
    const config = await loadConfigTx(tx, scope.tenantId, scope.facilityId);
    const snapshot = await closureSnapshotTx(tx, {
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      incidentId: incident,
    });
    if (Number(snapshot.incident.version) !== expected) stale('Incident', expected, snapshot.incident);
    if (snapshot.incident.lifecycle_state !== 'reconciling') {
      throw AppError.conflict('Incident is not in reconciliation', 'CONTINUITY_CLOSURE_STATE_INVALID');
    }
    if (snapshot.blockers.length > 0) {
      throw AppError.conflict('Incident closure predicate is blocked', 'CONTINUITY_CLOSURE_BLOCKED', {
        blockers: snapshot.blockers,
        safe: true,
      });
    }
    if (!config.clinical_safety_lead_uid || config.clinical_safety_lead_uid !== actor) {
      throw AppError.forbidden('The configured clinical safety lead must close the incident', 'CONTINUITY_CLINICAL_ATTESTATION_DENIED');
    }
    if (snapshot.incident.commander_uid === actor) {
      throw AppError.conflict('Closure actors must be distinct', 'CONTINUITY_CLOSURE_ACTOR_SEPARATION_REQUIRED');
    }
    const operationalRows = await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incident_attestations
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND incident_id = $3::uuid AND incident_version = $4::integer
          AND attestation_kind = 'operational'
          AND predicate_snapshot_hash = $5
        FOR SHARE`,
      scope.tenantId,
      scope.facilityId,
      incident,
      expected,
      snapshot.predicate_snapshot_hash,
    );
    if (!operationalRows[0] || operationalRows[0].actor_uid !== snapshot.incident.commander_uid) {
      throw AppError.conflict('Commander attestation is required', 'CONTINUITY_CLOSURE_COMMANDER_ATTESTATION_REQUIRED');
    }
    const clinicalRows = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_continuity_incident_attestations (
         tenant_id, facility_id, incident_id, attestation_kind,
         actor_uid, actor_role, incident_version, predicate_snapshot_hash
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, 'clinical',
         $4::uuid, $5, $6::integer, $7
       )
       ON CONFLICT (tenant_id, facility_id, incident_id, incident_version, attestation_kind)
       DO NOTHING
       RETURNING *`,
      scope.tenantId,
      scope.facilityId,
      incident,
      actor,
      role,
      expected,
      snapshot.predicate_snapshot_hash,
    );
    const clinical = clinicalRows[0] || (await tx.$queryRawUnsafe(
      `SELECT * FROM clinical_continuity_incident_attestations
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer
          AND incident_id = $3::uuid AND incident_version = $4::integer
          AND attestation_kind = 'clinical'`,
      scope.tenantId,
      scope.facilityId,
      incident,
      expected,
    ))[0];
    if (clinical.actor_uid !== actor || clinical.predicate_snapshot_hash !== snapshot.predicate_snapshot_hash) {
      throw AppError.conflict('Clinical attestation changed', 'CONTINUITY_CLOSURE_ATTESTATION_CONFLICT');
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE clinical_continuity_incidents
          SET lifecycle_state = 'closed', closed_at = clock_timestamp(),
              closure_snapshot_hash = $1, updated_by = $2::uuid,
              updated_at = clock_timestamp(), version = version + 1
        WHERE tenant_id = $3::uuid AND facility_id = $4::integer AND id = $5::uuid
          AND version = $6::integer AND lifecycle_state = 'reconciling'
        RETURNING *`,
      snapshot.predicate_snapshot_hash,
      actor,
      scope.tenantId,
      scope.facilityId,
      incident,
      expected,
    );
    if (!updated[0]) stale('Incident', expected, snapshot.incident);
    const audit = await requiredAudit(tx, {
      tenantId: scope.tenantId,
      action: 'clinical_continuity.incident.closed',
      actorUid: actor,
      actorRole: role,
      resourceType: 'clinical_continuity_incident',
      resourceTable: 'clinical_continuity_incidents',
      resourceId: incident,
      requestId,
      beforeState: { lifecycle_state: snapshot.incident.lifecycle_state, version: expected },
      afterState: {
        lifecycle_state: 'closed',
        version: updated[0].version,
        predicate_snapshot_hash: snapshot.predicate_snapshot_hash,
        operational_attestation_id: operationalRows[0].id,
        clinical_attestation_id: clinical.id,
      },
      idempotencyKey: `cc-closure:${incident}:${expected}:closed`,
    });
    return {
      incident: updated[0],
      predicate_snapshot_hash: snapshot.predicate_snapshot_hash,
      operational_attestation: operationalRows[0],
      clinical_attestation: clinical,
      audit_event_id: audit.id,
    };
  });
}
