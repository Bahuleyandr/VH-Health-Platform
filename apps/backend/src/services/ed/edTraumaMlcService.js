import { randomUUID } from 'node:crypto';

import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;

export const CANONICAL_TRIAGE_SCALES = ['esi', 'ats', 'ctas', 'manchester'];
export const TRAUMA_ACTIVATION_LEVELS = ['standby', 'partial', 'full', 'mass_casualty'];
export const TRAUMA_ACTIVATION_STATUSES = ['active', 'cancelled', 'completed', 'finalized'];
export const TRAUMA_SURVEY_KINDS = ['primary', 'secondary', 'reassessment'];
export const TRAUMA_TIMELINE_EVENT_TYPES = [
  'arrival', 'airway', 'breathing', 'circulation', 'disability', 'exposure',
  'fast', 'imaging', 'procedure', 'medication_reference', 'blood_product',
  'fluid', 'consult', 'transfer', 'reassessment', 'note',
];
export const ED_EVIDENCE_KINDS = ['vital_snapshot', 'device_observation'];

const POLICY_RETURNING = `tenant_id, canonical_triage_scale, active,
  alternative_scale_mappings, trauma_registry_participation,
  registry_export_enabled, evidence_owner_uid, clinical_governance_owner_uid,
  reviewer_uid, reviewed_at, activated_by, activated_at, policy_version,
  source_metadata, created_at, updated_at`;

const TRAUMA_ACTIVATION_RETURNING = `id, tenant_id, activation_number,
  emergency_visit_id, admission_id, patient_uid, activation_reason,
  activation_level, activated_at, activated_by_uid, team_leader_uid,
  expected_arrival_at, patient_arrived_at,
  blood_bank_alerted_at, blood_bank_alerted_by_uid,
  radiology_alerted_at, radiology_alerted_by_uid,
  ot_alerted_at, ot_alerted_by_uid,
  registry_participation, registry_reviewer_uid, registry_reviewed_at,
  registry_export_status, status, timeline_event_id, audit_event_id,
  source_metadata, created_at, updated_at`;

const TEAM_ROLE_RETURNING = `id, tenant_id, trauma_activation_id, role_code,
  role_label, staff_uid, assigned_at, arrived_at, accepted_at, status, notes,
  created_at, updated_at`;

const SURVEY_RETURNING = `id, tenant_id, trauma_activation_id, emergency_visit_id,
  patient_uid, survey_kind, assessed_at, assessed_by_uid,
  responsible_clinician_uid, airway, breathing, circulation, disability,
  exposure, fast_imaging, interventions, reassessment_due_at,
  source_citations, completion_status, missing_required_fields, completed_at,
  timeline_event_id, audit_event_id, created_at, updated_at`;

const TRAUMA_TIMELINE_RETURNING = `id, tenant_id, trauma_activation_id,
  emergency_visit_id, patient_uid, occurred_at, event_type, event_label,
  intervention_details, performed_by_uid, source_citations,
  timeline_event_id, audit_event_id, created_by_uid, created_at`;

const ED_EVIDENCE_RETURNING = `id, tenant_id, emergency_visit_id, patient_uid,
  evidence_kind, vitals_chart_id, device_vital_sample_observation_id,
  device_registry_id, observed_at, verified, linked_by_uid, linked_at, notes,
  metadata, timeline_event_id, audit_event_id`;

const MLC_COMPLETENESS_RETURNING = `id, tenant_id, mlc_record_id,
  emergency_visit_id, patient_uid, alleged_history, injury_description,
  injury_diagram_complete, police_notification_complete, certificate_signer_uid,
  chain_of_custody_complete, closure_requirements, assistant_prefill_output_id,
  assistant_prefill_metadata, missing_required_fields, completeness_status,
  reviewed_by_uid, reviewed_at, certification_blocked, timeline_event_id,
  audit_event_id, created_at, updated_at`;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
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

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  return value;
}

function normalizeStringArray(value, label, { max = 50 } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array of strings`);
  if (value.length > max) throw AppError.badRequest(`${label} max length is ${max}`);
  return value.map((v) => safeText(v, 160)).filter(Boolean);
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function scaleForPriority(priority) {
  const text = String(priority || '').toLowerCase();
  if (text.startsWith('esi_')) return 'esi';
  if (text.startsWith('ats_')) return 'ats';
  if (text.startsWith('ctas_')) return 'ctas';
  if (text.startsWith('manchester_')) return 'manchester';
  return null;
}

function scaleForAssessmentKind(kind) {
  const text = String(kind || '').toLowerCase();
  if (text === 'australian') return 'ats';
  if (CANONICAL_TRIAGE_SCALES.includes(text)) return text;
  return null;
}

function mlcRequiredFields(input = {}) {
  const missing = [];
  if (!safeText(input.allegedHistory)) missing.push('alleged_history');
  if (!safeText(input.injuryDescription)) missing.push('injury_description');
  if (!normalizeBoolean(input.injuryDiagramComplete, false)) missing.push('injury_diagram');
  if (!normalizeBoolean(input.policeNotificationComplete, false)) missing.push('police_notification');
  if (!maybeUuid(input.certificateSignerUid, 'certificate_signer_uid')) missing.push('certificate_signer');
  if (!normalizeBoolean(input.chainOfCustodyComplete, false)) missing.push('chain_of_custody');
  return missing;
}

function surveyRequiredFields(input = {}) {
  const missing = [];
  for (const field of ['airway', 'breathing', 'circulation', 'disability', 'exposure']) {
    if (!safeText(input[field])) missing.push(field);
  }
  if (!maybeUuid(input.responsibleClinicianUid, 'responsible_clinician_uid')) {
    missing.push('responsible_clinician_uid');
  }
  if (normalizeJsonArray(input.sourceCitations, 'source_citations').length === 0) {
    missing.push('source_citations');
  }
  return missing;
}

async function fetchVisitContext(tx, tenantId, emergencyVisitId) {
  if (!emergencyVisitId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, visit_number
       FROM emergency_visits
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(emergencyVisitId, 'emergency_visit_id'),
    tenantId,
  );
  return rows[0] || null;
}

async function insertClinicalTimelineEvent(tx, {
  tenantId,
  patientUid,
  encounterId = null,
  eventType,
  eventSubtype = null,
  eventStatus = 'completed',
  sourceTable,
  sourceId,
  actorUid = null,
  occurredAt = null,
  summary,
  payload = {},
  tags = [],
}) {
  if (!patientUid) return null;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, encounter_id, event_type, event_subtype,
        event_status, source_table, source_id, resource_type, resource_id,
        actor_uid, occurred_at, visible_to_patient, clinical_summary, payload,
        tags, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5,
       $6, $7, $8, $9, $10,
       $11::uuid, COALESCE($12::timestamptz, NOW()), false, $13, $14::jsonb,
       $15::text[], $16)
     RETURNING id`,
    tenantId,
    patientUid,
    maybeUuid(encounterId, 'encounter_id'),
    safeText(eventType, 80),
    safeText(eventSubtype, 80),
    safeText(eventStatus, 40),
    safeText(sourceTable, 100),
    String(sourceId),
    safeText(sourceTable, 80),
    String(sourceId),
    maybeUuid(actorUid, 'actor_uid'),
    normalizeTimestamp(occurredAt, 'occurred_at'),
    safeText(summary),
    JSON.stringify(normalizeJsonObject(payload, 'payload')),
    normalizeStringArray(tags, 'tags'),
    `${sourceTable}:${sourceId}:${eventType}:${randomUUID()}`,
  );
  return rows[0]?.id || null;
}

async function insertClinicalAuditEvent(tx, {
  tenantId,
  patientUid = null,
  encounterId = null,
  action,
  actorUid = null,
  resourceType,
  resourceTable,
  resourceId,
  afterState = {},
  metadata = {},
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, encounter_id, action, action_status,
        actor_uid, resource_type, resource_table, resource_id,
        after_state, metadata, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'success',
       $5::uuid, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
     RETURNING id`,
    tenantId,
    maybeUuid(patientUid, 'patient_uid'),
    maybeUuid(encounterId, 'encounter_id'),
    safeText(action, 100),
    maybeUuid(actorUid, 'actor_uid'),
    safeText(resourceType, 80),
    safeText(resourceTable, 100),
    String(resourceId),
    JSON.stringify(normalizeJsonObject(afterState, 'after_state')),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    `${resourceTable}:${resourceId}:${action}:${randomUUID()}`,
  );
  return rows[0]?.id || null;
}

export async function getTenantEdPolicy({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT ${POLICY_RETURNING}
         FROM tenant_ed_policies
        WHERE tenant_id = $1::uuid
        LIMIT 1`,
      tid,
    ));
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function upsertTenantEdPolicy({
  tenantId = null,
  canonicalTriageScale = null,
  active = false,
  alternativeScaleMappings = null,
  traumaRegistryParticipation = null,
  registryExportEnabled = false,
  evidenceOwnerUid = null,
  clinicalGovernanceOwnerUid = null,
  reviewerUid = null,
  reviewedAt = null,
  activatedBy = null,
  activatedAt = null,
  policyVersion = null,
  sourceMetadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanScale = normalizeEnum(canonicalTriageScale, CANONICAL_TRIAGE_SCALES, 'canonical_triage_scale');
  const cleanActive = normalizeBoolean(active, false);
  const reviewer = maybeUuid(reviewerUid, 'reviewer_uid');
  const reviewed = normalizeTimestamp(reviewedAt, 'reviewed_at');
  const activated = normalizeTimestamp(activatedAt, 'activated_at') || (cleanActive ? new Date().toISOString() : null);
  if (cleanActive && (!cleanScale || !reviewer || !reviewed)) {
    throw AppError.badRequest('Active ED policy requires canonical scale, reviewer, and reviewed_at');
  }

  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO tenant_ed_policies
       (tenant_id, canonical_triage_scale, active, alternative_scale_mappings,
        trauma_registry_participation, registry_export_enabled,
        evidence_owner_uid, clinical_governance_owner_uid, reviewer_uid,
        reviewed_at, activated_by, activated_at, policy_version, source_metadata,
        updated_at)
     VALUES ($1::uuid, $2, $3, $4::jsonb,
       $5, $6, $7::uuid, $8::uuid, $9::uuid,
       $10::timestamptz, $11::uuid, $12::timestamptz, $13, $14::jsonb,
       NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET
       canonical_triage_scale = EXCLUDED.canonical_triage_scale,
       active = EXCLUDED.active,
       alternative_scale_mappings = EXCLUDED.alternative_scale_mappings,
       trauma_registry_participation = EXCLUDED.trauma_registry_participation,
       registry_export_enabled = EXCLUDED.registry_export_enabled,
       evidence_owner_uid = EXCLUDED.evidence_owner_uid,
       clinical_governance_owner_uid = EXCLUDED.clinical_governance_owner_uid,
       reviewer_uid = EXCLUDED.reviewer_uid,
       reviewed_at = EXCLUDED.reviewed_at,
       activated_by = EXCLUDED.activated_by,
       activated_at = EXCLUDED.activated_at,
       policy_version = EXCLUDED.policy_version,
       source_metadata = EXCLUDED.source_metadata,
       updated_at = NOW()
     RETURNING ${POLICY_RETURNING}`,
    tid,
    cleanScale,
    cleanActive,
    JSON.stringify(normalizeJsonObject(alternativeScaleMappings, 'alternative_scale_mappings')),
    normalizeEnum(traumaRegistryParticipation, ['internal_only', 'state_partner', 'registry_ready'], 'trauma_registry_participation'),
    normalizeBoolean(registryExportEnabled, false),
    maybeUuid(evidenceOwnerUid, 'evidence_owner_uid'),
    maybeUuid(clinicalGovernanceOwnerUid, 'clinical_governance_owner_uid'),
    reviewer,
    reviewed,
    maybeUuid(activatedBy, 'activated_by'),
    activated,
    safeText(policyVersion, 80),
    JSON.stringify(normalizeJsonObject(sourceMetadata, 'source_metadata')),
  ));
  return rows[0];
}

export async function assertActiveTriageScale({
  tenantId = null,
  triagePriority = null,
  assessmentKind = null,
  client = prisma,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  let rows = [];
  try {
    rows = await client.$queryRawUnsafe(
      `SELECT canonical_triage_scale
         FROM tenant_ed_policies
        WHERE tenant_id = $1::uuid
          AND active = TRUE
          AND canonical_triage_scale IS NOT NULL
        LIMIT 1`,
      tid,
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
  }
  const scale = rows[0]?.canonical_triage_scale || null;
  if (!scale) {
    throw AppError.badRequest(
      'Active tenant ED triage policy is required before triage scale can be used',
      'ED_TRIAGE_POLICY_REQUIRED',
    );
  }
  const incomingScale = scaleForPriority(triagePriority) || scaleForAssessmentKind(assessmentKind);
  if (incomingScale && incomingScale !== scale) {
    throw AppError.badRequest(
      `Triage scale ${incomingScale} does not match active tenant ED policy (${scale})`,
      'ED_TRIAGE_SCALE_MISMATCH',
    );
  }
  return scale;
}

export async function createTraumaActivation({
  tenantId = null,
  activationNumber,
  emergencyVisitId = null,
  admissionId = null,
  patientUid = null,
  activationReason,
  activationLevel,
  activatedAt = null,
  activatedByUid = null,
  teamLeaderUid = null,
  expectedArrivalAt = null,
  patientArrivedAt = null,
  bloodBankAlertedAt = null,
  bloodBankAlertedByUid = null,
  radiologyAlertedAt = null,
  radiologyAlertedByUid = null,
  otAlertedAt = null,
  otAlertedByUid = null,
  registryParticipation = null,
  registryReviewerUid = null,
  registryReviewedAt = null,
  registryExportStatus = 'not_configured',
  teamRoles = null,
  sourceMetadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNumber = safeText(activationNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('activation_number is required');
  const reason = safeText(activationReason);
  if (!reason) throw AppError.badRequest('activation_reason is required');
  const level = normalizeEnum(activationLevel, TRAUMA_ACTIVATION_LEVELS, 'activation_level', { required: true });
  const activated = normalizeTimestamp(activatedAt, 'activated_at') || new Date().toISOString();
  const arrived = normalizeTimestamp(patientArrivedAt, 'patient_arrived_at');
  if (arrived && new Date(arrived).getTime() < new Date(activated).getTime()) {
    throw AppError.badRequest('patient_arrived_at cannot be before activated_at');
  }

  try {
    return await setTenantTx(tid, async (tx) => {
      const visit = await fetchVisitContext(tx, tid, emergencyVisitId);
      const finalPatientUid = maybeUuid(patientUid, 'patient_uid') || visit?.patient_uid || null;
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO trauma_activations
           (tenant_id, activation_number, emergency_visit_id, admission_id,
            patient_uid, activation_reason, activation_level, activated_at,
            activated_by_uid, team_leader_uid, expected_arrival_at,
            patient_arrived_at, blood_bank_alerted_at, blood_bank_alerted_by_uid,
            radiology_alerted_at, radiology_alerted_by_uid, ot_alerted_at,
            ot_alerted_by_uid, registry_participation, registry_reviewer_uid,
            registry_reviewed_at, registry_export_status, source_metadata)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::timestamptz,
           $9::uuid, $10::uuid, $11::timestamptz, $12::timestamptz,
           $13::timestamptz, $14::uuid, $15::timestamptz, $16::uuid,
           $17::timestamptz, $18::uuid, $19, $20::uuid, $21::timestamptz,
           $22, $23::jsonb)
         RETURNING ${TRAUMA_ACTIVATION_RETURNING}`,
        tid,
        cleanNumber,
        emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null,
        admissionId ? normalizeId(admissionId, 'admission_id') : null,
        finalPatientUid,
        reason,
        level,
        activated,
        maybeUuid(activatedByUid, 'activated_by_uid'),
        maybeUuid(teamLeaderUid, 'team_leader_uid'),
        normalizeTimestamp(expectedArrivalAt, 'expected_arrival_at'),
        arrived,
        normalizeTimestamp(bloodBankAlertedAt, 'blood_bank_alerted_at'),
        maybeUuid(bloodBankAlertedByUid, 'blood_bank_alerted_by_uid'),
        normalizeTimestamp(radiologyAlertedAt, 'radiology_alerted_at'),
        maybeUuid(radiologyAlertedByUid, 'radiology_alerted_by_uid'),
        normalizeTimestamp(otAlertedAt, 'ot_alerted_at'),
        maybeUuid(otAlertedByUid, 'ot_alerted_by_uid'),
        normalizeEnum(registryParticipation, ['internal_only', 'state_partner', 'registry_ready'], 'registry_participation'),
        maybeUuid(registryReviewerUid, 'registry_reviewer_uid'),
        normalizeTimestamp(registryReviewedAt, 'registry_reviewed_at'),
        normalizeEnum(registryExportStatus, ['not_configured', 'blocked_pending_review', 'ready', 'exported'], 'registry_export_status') || 'not_configured',
        JSON.stringify(normalizeJsonObject(sourceMetadata, 'source_metadata')),
      );
      const activation = rows[0];

      const roleRows = [];
      for (const role of normalizeJsonArray(teamRoles, 'team_roles')) {
        const roleCode = safeText(role.role_code || role.roleCode, 60);
        if (!roleCode) throw AppError.badRequest('team_roles.role_code is required');
        const inserted = await tx.$queryRawUnsafe(
          `INSERT INTO trauma_activation_team_roles
             (tenant_id, trauma_activation_id, role_code, role_label, staff_uid,
              assigned_at, arrived_at, accepted_at, status, notes)
           VALUES ($1::uuid, $2, $3, $4, $5::uuid,
             COALESCE($6::timestamptz, NOW()), $7::timestamptz, $8::timestamptz,
             $9, $10)
           RETURNING ${TEAM_ROLE_RETURNING}`,
          tid,
          activation.id,
          roleCode,
          safeText(role.role_label || role.roleLabel, 160),
          maybeUuid(role.staff_uid || role.staffUid, 'staff_uid'),
          normalizeTimestamp(role.assigned_at || role.assignedAt, 'assigned_at'),
          normalizeTimestamp(role.arrived_at || role.arrivedAt, 'arrived_at'),
          normalizeTimestamp(role.accepted_at || role.acceptedAt, 'accepted_at'),
          normalizeEnum(role.status, ['assigned', 'accepted', 'arrived', 'released', 'replaced'], 'team_roles.status') || 'assigned',
          safeText(role.notes),
        );
        roleRows.push(inserted[0]);
      }

      const timelineId = await insertClinicalTimelineEvent(tx, {
        tenantId: tid,
        patientUid: activation.patient_uid,
        encounterId: visit?.encounter_id,
        eventType: 'trauma_activation',
        eventSubtype: activation.activation_level,
        sourceTable: 'trauma_activations',
        sourceId: activation.id,
        actorUid: activation.activated_by_uid,
        occurredAt: activation.activated_at,
        summary: `Trauma activation ${activation.activation_level}: ${activation.activation_reason}`,
        payload: { activation_number: activation.activation_number, team_roles: roleRows.length },
        tags: ['nl14', 'ed', 'trauma'],
      });
      const auditId = await insertClinicalAuditEvent(tx, {
        tenantId: tid,
        patientUid: activation.patient_uid,
        encounterId: visit?.encounter_id,
        action: 'TRAUMA_ACTIVATION_CREATED',
        actorUid: activation.activated_by_uid,
        resourceType: 'TRAUMA_ACTIVATION',
        resourceTable: 'trauma_activations',
        resourceId: activation.id,
        afterState: activation,
        metadata: { team_roles: roleRows.length },
      });
      const updated = await tx.$queryRawUnsafe(
        `UPDATE trauma_activations
            SET timeline_event_id = $1::uuid, audit_event_id = $2::uuid
          WHERE id = $3 AND tenant_id = $4::uuid
          RETURNING ${TRAUMA_ACTIVATION_RETURNING}`,
        timelineId,
        auditId,
        activation.id,
        tid,
      );
      return { ...updated[0], team_roles: roleRows };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('activation_number already exists');
    throw err;
  }
}

export async function recordTraumaSurvey({
  tenantId = null,
  traumaActivationId = null,
  emergencyVisitId = null,
  patientUid = null,
  surveyKind,
  assessedAt = null,
  assessedByUid = null,
  responsibleClinicianUid,
  airway = null,
  breathing = null,
  circulation = null,
  disability = null,
  exposure = null,
  fastImaging = null,
  interventions = null,
  reassessmentDueAt = null,
  sourceCitations = null,
  completionStatus = 'draft',
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const status = normalizeEnum(completionStatus, ['draft', 'complete', 'amended', 'cancelled'], 'completion_status') || 'draft';
  const missing = status === 'complete'
    ? surveyRequiredFields({ airway, breathing, circulation, disability, exposure, responsibleClinicianUid, sourceCitations })
    : [];
  if (missing.length) {
    throw AppError.badRequest('Trauma survey is missing required completion fields', 'TRAUMA_SURVEY_INCOMPLETE', { missing });
  }

  return setTenantTx(tid, async (tx) => {
    const visit = await fetchVisitContext(tx, tid, emergencyVisitId);
    const finalPatientUid = maybeUuid(patientUid, 'patient_uid') || visit?.patient_uid || null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO trauma_survey_records
         (tenant_id, trauma_activation_id, emergency_visit_id, patient_uid,
          survey_kind, assessed_at, assessed_by_uid, responsible_clinician_uid,
          airway, breathing, circulation, disability, exposure,
          fast_imaging, interventions, reassessment_due_at, source_citations,
          completion_status, missing_required_fields, completed_at)
       VALUES ($1::uuid, $2, $3, $4::uuid,
         $5, COALESCE($6::timestamptz, NOW()), $7::uuid, $8::uuid,
         $9, $10, $11, $12, $13,
         $14::jsonb, $15::jsonb, $16::timestamptz, $17::jsonb,
         $18, $19::text[], CASE WHEN $18 = 'complete' THEN NOW() ELSE NULL END)
       RETURNING ${SURVEY_RETURNING}`,
      tid,
      traumaActivationId ? normalizeId(traumaActivationId, 'trauma_activation_id') : null,
      emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null,
      finalPatientUid,
      normalizeEnum(surveyKind, TRAUMA_SURVEY_KINDS, 'survey_kind', { required: true }),
      normalizeTimestamp(assessedAt, 'assessed_at'),
      maybeUuid(assessedByUid, 'assessed_by_uid'),
      maybeUuid(responsibleClinicianUid, 'responsible_clinician_uid'),
      safeText(airway),
      safeText(breathing),
      safeText(circulation),
      safeText(disability),
      safeText(exposure),
      JSON.stringify(normalizeJsonObject(fastImaging, 'fast_imaging')),
      JSON.stringify(normalizeJsonArray(interventions, 'interventions')),
      normalizeTimestamp(reassessmentDueAt, 'reassessment_due_at'),
      JSON.stringify(normalizeJsonArray(sourceCitations, 'source_citations')),
      status,
      missing,
    );
    const survey = rows[0];
    const timelineId = await insertClinicalTimelineEvent(tx, {
      tenantId: tid,
      patientUid: survey.patient_uid,
      encounterId: visit?.encounter_id,
      eventType: 'trauma_survey',
      eventSubtype: survey.survey_kind,
      eventStatus: survey.completion_status,
      sourceTable: 'trauma_survey_records',
      sourceId: survey.id,
      actorUid: survey.assessed_by_uid || survey.responsible_clinician_uid,
      occurredAt: survey.assessed_at,
      summary: `${survey.survey_kind} trauma survey ${survey.completion_status}`,
      payload: { completion_status: survey.completion_status, missing_required_fields: survey.missing_required_fields },
      tags: ['nl14', 'ed', 'trauma', 'survey'],
    });
    const auditId = await insertClinicalAuditEvent(tx, {
      tenantId: tid,
      patientUid: survey.patient_uid,
      encounterId: visit?.encounter_id,
      action: 'TRAUMA_SURVEY_RECORDED',
      actorUid: survey.assessed_by_uid || survey.responsible_clinician_uid,
      resourceType: 'TRAUMA_SURVEY',
      resourceTable: 'trauma_survey_records',
      resourceId: survey.id,
      afterState: survey,
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE trauma_survey_records
          SET timeline_event_id = $1::uuid, audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid
        RETURNING ${SURVEY_RETURNING}`,
      timelineId,
      auditId,
      survey.id,
      tid,
    );
    return updated[0];
  });
}

export async function addTraumaTimelineEvent({
  tenantId = null,
  traumaActivationId,
  emergencyVisitId = null,
  patientUid = null,
  occurredAt = null,
  eventType,
  eventLabel = null,
  interventionDetails = null,
  performedByUid = null,
  sourceCitations = null,
  createdByUid = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  return setTenantTx(tid, async (tx) => {
    const visit = await fetchVisitContext(tx, tid, emergencyVisitId);
    const finalPatientUid = maybeUuid(patientUid, 'patient_uid') || visit?.patient_uid || null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO trauma_timeline_events
         (tenant_id, trauma_activation_id, emergency_visit_id, patient_uid,
          occurred_at, event_type, event_label, intervention_details,
          performed_by_uid, source_citations, created_by_uid)
       VALUES ($1::uuid, $2, $3, $4::uuid,
         COALESCE($5::timestamptz, NOW()), $6, $7, $8::jsonb,
         $9::uuid, $10::jsonb, $11::uuid)
       RETURNING ${TRAUMA_TIMELINE_RETURNING}`,
      tid,
      normalizeId(traumaActivationId, 'trauma_activation_id'),
      emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null,
      finalPatientUid,
      normalizeTimestamp(occurredAt, 'occurred_at'),
      normalizeEnum(eventType, TRAUMA_TIMELINE_EVENT_TYPES, 'event_type', { required: true }),
      safeText(eventLabel, 180),
      JSON.stringify(normalizeJsonObject(interventionDetails, 'intervention_details')),
      maybeUuid(performedByUid, 'performed_by_uid'),
      JSON.stringify(normalizeJsonArray(sourceCitations, 'source_citations')),
      maybeUuid(createdByUid, 'created_by_uid'),
    );
    const event = rows[0];
    const timelineId = await insertClinicalTimelineEvent(tx, {
      tenantId: tid,
      patientUid: event.patient_uid,
      encounterId: visit?.encounter_id,
      eventType: 'trauma_timeline_event',
      eventSubtype: event.event_type,
      sourceTable: 'trauma_timeline_events',
      sourceId: event.id,
      actorUid: event.performed_by_uid || event.created_by_uid,
      occurredAt: event.occurred_at,
      summary: event.event_label || event.event_type,
      payload: event.intervention_details,
      tags: ['nl14', 'ed', 'trauma', 'timeline'],
    });
    const auditId = await insertClinicalAuditEvent(tx, {
      tenantId: tid,
      patientUid: event.patient_uid,
      encounterId: visit?.encounter_id,
      action: 'TRAUMA_TIMELINE_EVENT_APPENDED',
      actorUid: event.performed_by_uid || event.created_by_uid,
      resourceType: 'TRAUMA_TIMELINE_EVENT',
      resourceTable: 'trauma_timeline_events',
      resourceId: event.id,
      afterState: event,
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE trauma_timeline_events
          SET timeline_event_id = $1::uuid, audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid
        RETURNING ${TRAUMA_TIMELINE_RETURNING}`,
      timelineId,
      auditId,
      event.id,
      tid,
    );
    return updated[0];
  });
}

export async function linkEdEncounterEvidence({
  tenantId = null,
  emergencyVisitId,
  patientUid = null,
  evidenceKind,
  vitalsChartId = null,
  deviceVitalSampleObservationId = null,
  deviceRegistryId = null,
  observedAt = null,
  verified = null,
  linkedByUid = null,
  notes = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const kind = normalizeEnum(evidenceKind, ED_EVIDENCE_KINDS, 'evidence_kind', { required: true });
  if (kind === 'vital_snapshot' && !vitalsChartId) {
    throw AppError.badRequest('vitals_chart_id is required for vital_snapshot evidence');
  }
  if (kind === 'device_observation' && !deviceVitalSampleObservationId) {
    throw AppError.badRequest('device_vital_sample_observation_id is required for device_observation evidence');
  }

  return setTenantTx(tid, async (tx) => {
    const visit = await fetchVisitContext(tx, tid, emergencyVisitId);
    const finalPatientUid = maybeUuid(patientUid, 'patient_uid') || visit?.patient_uid || null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO ed_encounter_evidence
         (tenant_id, emergency_visit_id, patient_uid, evidence_kind,
          vitals_chart_id, device_vital_sample_observation_id, device_registry_id,
          observed_at, verified, linked_by_uid, notes, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4,
         $5, $6, $7, $8::timestamptz, $9, $10::uuid, $11, $12::jsonb)
       RETURNING ${ED_EVIDENCE_RETURNING}`,
      tid,
      normalizeId(emergencyVisitId, 'emergency_visit_id'),
      finalPatientUid,
      kind,
      vitalsChartId ? normalizeId(vitalsChartId, 'vitals_chart_id') : null,
      deviceVitalSampleObservationId ? normalizeId(deviceVitalSampleObservationId, 'device_vital_sample_observation_id') : null,
      deviceRegistryId ? normalizeId(deviceRegistryId, 'device_registry_id') : null,
      normalizeTimestamp(observedAt, 'observed_at'),
      normalizeBoolean(verified),
      maybeUuid(linkedByUid, 'linked_by_uid'),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    const evidence = rows[0];
    const timelineId = await insertClinicalTimelineEvent(tx, {
      tenantId: tid,
      patientUid: evidence.patient_uid,
      encounterId: visit?.encounter_id,
      eventType: 'ed_encounter_evidence',
      eventSubtype: evidence.evidence_kind,
      sourceTable: 'ed_encounter_evidence',
      sourceId: evidence.id,
      actorUid: evidence.linked_by_uid,
      occurredAt: evidence.observed_at || evidence.linked_at,
      summary: `ED evidence linked: ${evidence.evidence_kind}`,
      payload: { verified: evidence.verified, vitals_chart_id: evidence.vitals_chart_id },
      tags: ['nl14', 'ed', 'device-evidence'],
    });
    const auditId = await insertClinicalAuditEvent(tx, {
      tenantId: tid,
      patientUid: evidence.patient_uid,
      encounterId: visit?.encounter_id,
      action: 'ED_ENCOUNTER_EVIDENCE_LINKED',
      actorUid: evidence.linked_by_uid,
      resourceType: 'ED_ENCOUNTER_EVIDENCE',
      resourceTable: 'ed_encounter_evidence',
      resourceId: evidence.id,
      afterState: evidence,
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE ed_encounter_evidence
          SET timeline_event_id = $1::uuid, audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid
        RETURNING ${ED_EVIDENCE_RETURNING}`,
      timelineId,
      auditId,
      evidence.id,
      tid,
    );
    return updated[0];
  });
}

export async function upsertMlcCompletenessReview({
  tenantId = null,
  mlcRecordId,
  emergencyVisitId = null,
  patientUid = null,
  allegedHistory = null,
  injuryDescription = null,
  injuryDiagramComplete = false,
  policeNotificationComplete = false,
  certificateSignerUid = null,
  chainOfCustodyComplete = false,
  closureRequirements = null,
  assistantPrefillOutputId = null,
  assistantPrefillMetadata = null,
  reviewedByUid = null,
  reviewedAt = null,
  completenessStatus = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const missing = mlcRequiredFields({
    allegedHistory,
    injuryDescription,
    injuryDiagramComplete,
    policeNotificationComplete,
    certificateSignerUid,
    chainOfCustodyComplete,
  });
  const requestedStatus = completenessStatus
    ? normalizeEnum(completenessStatus, ['incomplete', 'complete', 'certified', 'closed'], 'completeness_status')
    : (missing.length === 0 ? 'complete' : 'incomplete');
  const reviewer = maybeUuid(reviewedByUid, 'reviewed_by_uid');
  if (requestedStatus === 'complete' && (!reviewer || missing.length > 0)) {
    throw AppError.badRequest(
      'MLC completeness cannot be completed without human review and all required fields',
      'MLC_COMPLETENESS_INCOMPLETE',
      { missing },
    );
  }

  return setTenantTx(tid, async (tx) => {
    const visit = await fetchVisitContext(tx, tid, emergencyVisitId);
    const finalPatientUid = maybeUuid(patientUid, 'patient_uid') || visit?.patient_uid || null;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO mlc_completeness_reviews
         (tenant_id, mlc_record_id, emergency_visit_id, patient_uid,
          alleged_history, injury_description, injury_diagram_complete,
          police_notification_complete, certificate_signer_uid,
          chain_of_custody_complete, closure_requirements,
          assistant_prefill_output_id, assistant_prefill_metadata,
          missing_required_fields, completeness_status, reviewed_by_uid,
          reviewed_at, certification_blocked)
       VALUES ($1::uuid, $2, $3, $4::uuid,
         $5, $6, $7, $8, $9::uuid, $10, $11::jsonb,
         $12, $13::jsonb, $14::text[], $15, $16::uuid,
         $17::timestamptz, $18)
       ON CONFLICT (tenant_id, mlc_record_id) DO UPDATE SET
         emergency_visit_id = EXCLUDED.emergency_visit_id,
         patient_uid = EXCLUDED.patient_uid,
         alleged_history = EXCLUDED.alleged_history,
         injury_description = EXCLUDED.injury_description,
         injury_diagram_complete = EXCLUDED.injury_diagram_complete,
         police_notification_complete = EXCLUDED.police_notification_complete,
         certificate_signer_uid = EXCLUDED.certificate_signer_uid,
         chain_of_custody_complete = EXCLUDED.chain_of_custody_complete,
         closure_requirements = EXCLUDED.closure_requirements,
         assistant_prefill_output_id = EXCLUDED.assistant_prefill_output_id,
         assistant_prefill_metadata = EXCLUDED.assistant_prefill_metadata,
         missing_required_fields = EXCLUDED.missing_required_fields,
         completeness_status = EXCLUDED.completeness_status,
         reviewed_by_uid = EXCLUDED.reviewed_by_uid,
         reviewed_at = EXCLUDED.reviewed_at,
         certification_blocked = EXCLUDED.certification_blocked,
         updated_at = NOW()
       RETURNING ${MLC_COMPLETENESS_RETURNING}`,
      tid,
      normalizeId(mlcRecordId, 'mlc_record_id'),
      emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null,
      finalPatientUid,
      safeText(allegedHistory),
      safeText(injuryDescription),
      normalizeBoolean(injuryDiagramComplete, false),
      normalizeBoolean(policeNotificationComplete, false),
      maybeUuid(certificateSignerUid, 'certificate_signer_uid'),
      normalizeBoolean(chainOfCustodyComplete, false),
      JSON.stringify(normalizeJsonObject(closureRequirements, 'closure_requirements')),
      assistantPrefillOutputId ? normalizeId(assistantPrefillOutputId, 'assistant_prefill_output_id') : null,
      JSON.stringify(normalizeJsonObject(assistantPrefillMetadata, 'assistant_prefill_metadata')),
      missing,
      requestedStatus,
      reviewer,
      normalizeTimestamp(reviewedAt, 'reviewed_at') || (requestedStatus === 'complete' ? new Date().toISOString() : null),
      requestedStatus !== 'complete',
    );
    const review = rows[0];
    await tx.$queryRawUnsafe(
      `INSERT INTO mlc_completeness_audit_events
         (tenant_id, mlc_completeness_review_id, mlc_record_id, patient_uid,
          action, actor_uid, after_state, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid, $7::jsonb, $8::jsonb)`,
      tid,
      review.id,
      review.mlc_record_id,
      review.patient_uid,
      review.completeness_status === 'complete' ? 'completed' : (assistantPrefillOutputId ? 'prefilled' : 'reviewed'),
      review.reviewed_by_uid,
      JSON.stringify(review),
      JSON.stringify({ missing_required_fields: review.missing_required_fields }),
    );
    const timelineId = await insertClinicalTimelineEvent(tx, {
      tenantId: tid,
      patientUid: review.patient_uid,
      encounterId: visit?.encounter_id,
      eventType: 'mlc_completeness_review',
      eventSubtype: review.completeness_status,
      eventStatus: review.certification_blocked ? 'blocked' : 'complete',
      sourceTable: 'mlc_completeness_reviews',
      sourceId: review.id,
      actorUid: review.reviewed_by_uid,
      summary: review.certification_blocked ? 'MLC certification blocked by incomplete fields' : 'MLC completeness reviewed',
      payload: { missing_required_fields: review.missing_required_fields, assistant_prefill_output_id: review.assistant_prefill_output_id },
      tags: ['nl14', 'ed', 'mlc'],
    });
    const auditId = await insertClinicalAuditEvent(tx, {
      tenantId: tid,
      patientUid: review.patient_uid,
      encounterId: visit?.encounter_id,
      action: 'MLC_COMPLETENESS_REVIEWED',
      actorUid: review.reviewed_by_uid,
      resourceType: 'MLC_COMPLETENESS_REVIEW',
      resourceTable: 'mlc_completeness_reviews',
      resourceId: review.id,
      afterState: review,
      metadata: { certification_blocked: review.certification_blocked },
    });
    const updated = await tx.$queryRawUnsafe(
      `UPDATE mlc_completeness_reviews
          SET timeline_event_id = $1::uuid, audit_event_id = $2::uuid
        WHERE id = $3 AND tenant_id = $4::uuid
        RETURNING ${MLC_COMPLETENESS_RETURNING}`,
      timelineId,
      auditId,
      review.id,
      tid,
    );
    return updated[0];
  });
}

export async function getMlcCompletenessReview({ tenantId = null, mlcRecordId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT ${MLC_COMPLETENESS_RETURNING}
       FROM mlc_completeness_reviews
      WHERE tenant_id = $1::uuid AND mlc_record_id = $2
      LIMIT 1`,
    tid,
    normalizeId(mlcRecordId, 'mlc_record_id'),
  ));
  return rows[0] || null;
}

export async function assertMlcReadyForCertification({
  tenantId = null,
  mlcRecordId,
  client = prisma,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await client.$queryRawUnsafe(
    `SELECT id, completeness_status, certification_blocked,
            missing_required_fields, certificate_signer_uid, reviewed_by_uid
       FROM mlc_completeness_reviews
      WHERE tenant_id = $1::uuid AND mlc_record_id = $2
      LIMIT 1`,
    tid,
    normalizeId(mlcRecordId, 'mlc_record_id'),
  );
  const review = rows[0];
  if (!review || review.completeness_status !== 'complete' || review.certification_blocked) {
    throw AppError.badRequest(
      'MLC cannot be certified until completeness review is complete and human-reviewed',
      'MLC_CERTIFICATION_BLOCKED',
      { missing: review?.missing_required_fields || ['mlc_completeness_review'] },
    );
  }
  return review;
}

export async function listTraumaActivations({
  tenantId = null,
  status = null,
  emergencyVisitId = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, TRAUMA_ACTIVATION_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (emergencyVisitId) {
    params.push(normalizeId(emergencyVisitId, 'emergency_visit_id'));
    filters.push(`emergency_visit_id = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await setTenant(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT ${TRAUMA_ACTIVATION_RETURNING}
         FROM trauma_activations
        WHERE ${filters.join(' AND ')}
        ORDER BY activated_at DESC
        LIMIT $${params.length + 1}`,
      ...params,
      safeLimit,
    ));
    return { activations: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { activations: [], count: 0 };
    throw err;
  }
}

export default {
  getTenantEdPolicy,
  upsertTenantEdPolicy,
  assertActiveTriageScale,
  createTraumaActivation,
  recordTraumaSurvey,
  addTraumaTimelineEvent,
  linkEdEncounterEvidence,
  upsertMlcCompletenessReview,
  getMlcCompletenessReview,
  assertMlcReadyForCertification,
  listTraumaActivations,
};
