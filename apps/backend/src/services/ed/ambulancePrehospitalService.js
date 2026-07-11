import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

const HANDOVER_STATUSES = ['draft', 'ready_for_acceptance', 'accepted', 'cancelled', 'void'];
const HANDOVER_SOURCE_TYPES = ['manual', 'partner_payload', 'device_observation'];
const EVENT_TYPES = ['observation', 'intervention', 'vital', 'eta_change', 'medication', 'allergy', 'note', 'device_observation'];
const ACCEPTANCE_ROLES = ['receiving_nurse', 'receiving_doctor'];
const SIGNATURE_METHODS = ['typed', 'manual', 'e_signature', 'witnessed'];
const PARTNER_SCOPES = ['manual_first', 'internal_fleet', 'named_partner', 'api_device'];
const PARTNER_INTEGRATION_MODES = ['manual_only', 'api_device', 'device_link'];
const PARTNER_STATUSES = ['inert', 'draft', 'active', 'suspended', 'retired'];

const HANDOVER_RETURNING = `id, tenant_id, handover_number, ambulance_request_id,
  emergency_visit_id, partner_config_id, patient_uid, status, manual_entry,
  source_type, pickup_context, scene_observations, allergies_reported,
  medications_reported, eta_first_at, eta_latest_at, eta_change_reason,
  presenting_complaint, sbar, metadata, created_by, updated_by,
  created_at, updated_at`;
const HANDOVER_JOIN_RETURNING = HANDOVER_RETURNING
  .split(',')
  .map((column) => `ph.${column.trim()}`)
  .join(', ');

const EVENT_RETURNING = `id, tenant_id, handover_id, event_type, event_at,
  recorded_by, source_type, summary, observation, intervention, vital_signs,
  external_reference, metadata, created_at`;

const ACCEPTANCE_RETURNING = `id, tenant_id, handover_id, accepted_by_uid,
  accepted_by_role, acceptance_role, accepted_at, signature_method,
  signature_text, handover_signed_at, clinical_attestation, metadata, created_at`;

const DEVICE_LINK_RETURNING = `id, tenant_id, handover_id, ambulance_request_id,
  patient_uid, device_patient_association_id, device_registry_id, link_status,
  verification_status, source_system, verified_by_uid, verified_at, notes,
  metadata, created_by, created_at, updated_at`;

const PARTNER_CONFIG_RETURNING = `id, tenant_id, partner_code, partner_name,
  fleet_scope, integration_mode, status, consent_boundary, evidence_owner_uid,
  evidence_owner_role, evidence_source_metadata, reviewer_uid, reviewer_role,
  reviewed_at, reviewer_signoff_note, version, effective_from, effective_to,
  metadata, created_by, created_at, updated_at`;

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || '')) || err?.code === '23505';
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || '')) || err?.code === '23503';
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function requireText(value, label, max = TEXT_MAX) {
  const text = safeText(value, max);
  if (!text) throw AppError.badRequest(`${label} is required`);
  return text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeId(value, label = 'id') {
  if (value === null || value === undefined || value === '') return null;
  return normalizeId(value, label);
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function requireUuid(value, label = 'uid') {
  const clean = maybeUuid(value, label);
  if (!clean) throw AppError.badRequest(`${label} is required`);
  return clean;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeBoolean(value, fallback = false) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), MAX_LIMIT);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return fallback;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function canonicalSummaryForHandover(row) {
  return [
    'Pre-hospital handover captured',
    row.presenting_complaint ? `for ${row.presenting_complaint}` : null,
    row.ambulance_request_id ? `(ambulance request #${row.ambulance_request_id})` : null,
  ].filter(Boolean).join(' ');
}

async function requireCanonical(result, action) {
  if (!result?.timeline || !result?.audit) {
    throw AppError.internal(`Canonical ${action} write failed`, 'CANONICAL_WRITE_FAILED');
  }
  return result;
}

async function fetchAmbulanceRequest(tenantId, ambulanceRequestId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, request_number, patient_uid, patient_name,
            presenting_complaint, destination, destination_facility_id,
            status, priority, requested_at, dispatched_at, on_scene_at,
            arrived_at, ambulance_unit_id, driver_name, attendant_name
       FROM ambulance_requests
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(ambulanceRequestId, 'ambulance_request_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Ambulance request not found');
  return rows[0];
}

async function fetchEmergencyVisit(tenantId, emergencyVisitId, db = prisma) {
  if (!emergencyVisitId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, ambulance_request_id, visit_number,
            status, encounter_id
       FROM emergency_visits
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(emergencyVisitId, 'emergency_visit_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Emergency visit not found');
  return rows[0];
}

async function fetchHandover(tenantId, handoverId, db = prisma, { forUpdate = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${HANDOVER_RETURNING}
       FROM prehospital_handovers
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    normalizeId(handoverId, 'handover_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Pre-hospital handover not found');
  return rows[0];
}

function handoverNumberFor(ambulanceRequest, override = null) {
  const supplied = safeText(override, 100);
  if (supplied) return supplied;
  return `PH-${ambulanceRequest.request_number || ambulanceRequest.id}`;
}

function edVisitNumberFor(ambulanceRequest) {
  return `ED-AMB-${ambulanceRequest.request_number || ambulanceRequest.id}`;
}

async function createEmergencyVisitFromHandover(tx, tenantId, ambulanceRequest, data) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO emergency_visits
       (tenant_id, visit_number, patient_uid, arrival_mode, ambulance_request_id,
        chief_complaint, status, metadata, created_by)
     VALUES ($1::uuid, $2, $3::uuid, 'ambulance', $4,
             $5, 'arriving', $6::jsonb, $7::uuid)
     ON CONFLICT (tenant_id, visit_number)
     DO UPDATE SET
       patient_uid = COALESCE(emergency_visits.patient_uid, EXCLUDED.patient_uid),
       ambulance_request_id = COALESCE(emergency_visits.ambulance_request_id, EXCLUDED.ambulance_request_id),
       updated_at = NOW()
     RETURNING id, tenant_id, patient_uid, ambulance_request_id, visit_number,
               status, encounter_id`,
    tenantId,
    edVisitNumberFor(ambulanceRequest),
    data.patientUid,
    ambulanceRequest.id,
    safeText(data.presentingComplaint || ambulanceRequest.presenting_complaint),
    JSON.stringify({
      source: 'prehospital_handover',
      ambulance_request_id: ambulanceRequest.id,
      manual_first: true,
    }),
    maybeUuid(data.createdBy, 'created_by'),
  );
  return rows[0];
}

export async function upsertPartnerFleetConfig({
  tenantId = null,
  partnerCode,
  partnerName,
  fleetScope = 'manual_first',
  integrationMode = 'manual_only',
  status = 'inert',
  consentBoundary = null,
  evidenceOwnerUid = null,
  evidenceOwnerRole = null,
  evidenceSourceMetadata = null,
  reviewerUid = null,
  reviewerRole = null,
  reviewedAt = null,
  reviewerSignoffNote = null,
  version = 1,
  effectiveFrom = null,
  effectiveTo = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const code = requireText(partnerCode, 'partner_code', 80);
  const name = requireText(partnerName, 'partner_name', SHORT_MAX);
  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO ambulance_partner_fleet_configs
       (tenant_id, partner_code, partner_name, fleet_scope, integration_mode,
        status, consent_boundary, evidence_owner_uid, evidence_owner_role,
        evidence_source_metadata, reviewer_uid, reviewer_role, reviewed_at,
        reviewer_signoff_note, version, effective_from, effective_to,
        metadata, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid, $9,
             $10::jsonb, $11::uuid, $12, $13::timestamptz, $14,
             $15, $16::timestamptz, $17::timestamptz, $18::jsonb, $19::uuid)
     ON CONFLICT (tenant_id, partner_code)
     DO UPDATE SET
       partner_name = EXCLUDED.partner_name,
       fleet_scope = EXCLUDED.fleet_scope,
       integration_mode = EXCLUDED.integration_mode,
       status = EXCLUDED.status,
       consent_boundary = EXCLUDED.consent_boundary,
       evidence_owner_uid = EXCLUDED.evidence_owner_uid,
       evidence_owner_role = EXCLUDED.evidence_owner_role,
       evidence_source_metadata = EXCLUDED.evidence_source_metadata,
       reviewer_uid = EXCLUDED.reviewer_uid,
       reviewer_role = EXCLUDED.reviewer_role,
       reviewed_at = EXCLUDED.reviewed_at,
       reviewer_signoff_note = EXCLUDED.reviewer_signoff_note,
       version = EXCLUDED.version,
       effective_from = EXCLUDED.effective_from,
       effective_to = EXCLUDED.effective_to,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING ${PARTNER_CONFIG_RETURNING}`,
    tid,
    code,
    name,
    normalizeEnum(fleetScope, PARTNER_SCOPES, 'fleet_scope') || 'manual_first',
    normalizeEnum(integrationMode, PARTNER_INTEGRATION_MODES, 'integration_mode') || 'manual_only',
    normalizeEnum(status, PARTNER_STATUSES, 'status') || 'inert',
    JSON.stringify(normalizeJsonObject(consentBoundary, 'consent_boundary')),
    maybeUuid(evidenceOwnerUid, 'evidence_owner_uid'),
    safeText(evidenceOwnerRole, 80),
    JSON.stringify(normalizeJsonObject(evidenceSourceMetadata, 'evidence_source_metadata')),
    maybeUuid(reviewerUid, 'reviewer_uid'),
    safeText(reviewerRole, 80),
    normalizeTimestamp(reviewedAt, 'reviewed_at'),
    safeText(reviewerSignoffNote),
    Number.parseInt(version, 10) || 1,
    normalizeTimestamp(effectiveFrom, 'effective_from'),
    normalizeTimestamp(effectiveTo, 'effective_to'),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    maybeUuid(createdBy, 'created_by'),
  ));
  return rows[0];
}

export async function listPartnerFleetConfigs({
  tenantId = null,
  status = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, PARTNER_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  params.push(normalizeLimit(limit));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${PARTNER_CONFIG_RETURNING}
       FROM ambulance_partner_fleet_configs
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT $${params.length}`,
    ...params,
  );
  return { configs: rows, count: rows.length };
}

export async function createPrehospitalHandover({
  tenantId = null,
  ambulanceRequestId,
  emergencyVisitId = null,
  createEmergencyVisit = false,
  handoverNumber = null,
  patientUid = null,
  pickupContext = null,
  sceneObservations = null,
  allergiesReported = null,
  medicationsReported = null,
  etaFirstAt = null,
  etaLatestAt = null,
  etaChangeReason = null,
  presentingComplaint = null,
  sbar = null,
  partnerConfigId = null,
  status = 'ready_for_acceptance',
  manualEntry = true,
  sourceType = 'manual',
  metadata = null,
  createdBy = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const ambulance = await fetchAmbulanceRequest(tid, ambulanceRequestId);
  const resolvedPatientUid = requireUuid(patientUid || ambulance.patient_uid, 'patient_uid');
  const existingVisit = emergencyVisitId ? await fetchEmergencyVisit(tid, emergencyVisitId) : null;
  if (existingVisit?.patient_uid && existingVisit.patient_uid !== resolvedPatientUid) {
    throw AppError.badRequest('emergency_visit_id belongs to a different patient');
  }
  if (partnerConfigId) {
    const partner = await prisma.$queryRawUnsafe(
      `SELECT id, status FROM ambulance_partner_fleet_configs
        WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      normalizeId(partnerConfigId, 'partner_config_id'),
      tid,
    );
    if (!partner[0]) throw AppError.notFound('Ambulance partner config not found');
  }

  try {
    return await setTenantTx(tid, async (tx) => {
      const visit = existingVisit || (createEmergencyVisit
        ? await createEmergencyVisitFromHandover(tx, tid, ambulance, {
          patientUid: resolvedPatientUid,
          presentingComplaint,
          createdBy,
        })
        : null);

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO prehospital_handovers
           (tenant_id, handover_number, ambulance_request_id, emergency_visit_id,
            partner_config_id, patient_uid, status, manual_entry, source_type,
            pickup_context, scene_observations, allergies_reported,
            medications_reported, eta_first_at, eta_latest_at, eta_change_reason,
            presenting_complaint, sbar, metadata, created_by, updated_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8, $9,
                 $10, $11, $12, $13, $14::timestamptz, $15::timestamptz,
                 $16, $17, $18::jsonb, $19::jsonb, $20::uuid, $20::uuid)
         RETURNING ${HANDOVER_RETURNING}`,
        tid,
        handoverNumberFor(ambulance, handoverNumber),
        ambulance.id,
        visit?.id || maybeId(emergencyVisitId, 'emergency_visit_id'),
        maybeId(partnerConfigId, 'partner_config_id'),
        resolvedPatientUid,
        normalizeEnum(status, HANDOVER_STATUSES, 'status') || 'ready_for_acceptance',
        normalizeBoolean(manualEntry, true),
        normalizeEnum(sourceType, HANDOVER_SOURCE_TYPES, 'source_type') || 'manual',
        safeText(pickupContext),
        safeText(sceneObservations),
        safeText(allergiesReported),
        safeText(medicationsReported),
        normalizeTimestamp(etaFirstAt, 'eta_first_at'),
        normalizeTimestamp(etaLatestAt, 'eta_latest_at'),
        safeText(etaChangeReason),
        safeText(presentingComplaint || ambulance.presenting_complaint),
        JSON.stringify(normalizeJsonObject(sbar, 'sbar')),
        JSON.stringify({
          ...normalizeJsonObject(metadata, 'metadata'),
          manual_first: true,
          partner_integration_enabled: false,
        }),
        maybeUuid(createdBy, 'created_by'),
      );
      const handover = rows[0];
      await requireCanonical(await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: resolvedPatientUid,
        eventType: 'prehospital_handover.created',
        eventStatus: handover.status,
        sourceTable: 'prehospital_handovers',
        sourceId: handover.id,
        resourceType: 'prehospital_handover',
        resourceId: handover.id,
        actorUid: maybeUuid(createdBy, 'created_by'),
        actorRole,
        summary: canonicalSummaryForHandover(handover),
        payload: {
          ambulance_request_id: ambulance.id,
          emergency_visit_id: handover.emergency_visit_id,
          pickup_context: handover.pickup_context,
          scene_observations: handover.scene_observations,
          allergies_reported: handover.allergies_reported,
          medications_reported: handover.medications_reported,
          sbar: handover.sbar,
        },
        afterState: handover,
        timelineIdempotencyKey: `prehospital_handovers:${handover.id}:created`,
        auditIdempotencyKey: `prehospital_handovers:${handover.id}:audit:created`,
      }, { db: tx }), 'handover created');

      await publishEvent({
        eventType: 'clinical.prehospital_handover.created',
        aggregateType: 'prehospital_handover',
        aggregateId: handover.id,
        patientUid: resolvedPatientUid,
        payload: {
          ambulance_request_id: ambulance.id,
          emergency_visit_id: handover.emergency_visit_id,
          manual_first: true,
        },
        tx,
        tenantId: tid,
      });

      logger.info('Pre-hospital handover created', {
        handoverId: handover.id,
        ambulanceRequestId: ambulance.id,
      });
      return handover;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('Pre-hospital handover already exists for this ambulance request');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid pre-hospital handover reference');
    throw err;
  }
}

export async function appendPrehospitalTimelineEvent({
  tenantId = null,
  handoverId,
  eventType,
  eventAt = null,
  recordedBy = null,
  sourceType = 'manual',
  summary,
  observation = null,
  intervention = null,
  vitalSigns = null,
  externalReference = null,
  metadata = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanType = normalizeEnum(eventType, EVENT_TYPES, 'event_type', { required: true });
  const cleanSummary = requireText(summary, 'summary');

  return setTenantTx(tid, async (tx) => {
    const handover = await fetchHandover(tid, handoverId, tx, { forUpdate: true });
    if (['cancelled', 'void'].includes(handover.status)) {
      throw AppError.conflict('Cannot append to a cancelled or void pre-hospital handover');
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO prehospital_handover_events
         (tenant_id, handover_id, event_type, event_at, recorded_by, source_type,
          summary, observation, intervention, vital_signs, external_reference,
          metadata)
       VALUES ($1::uuid, $2, $3, COALESCE($4::timestamptz, NOW()), $5::uuid, $6,
               $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12::jsonb)
       RETURNING ${EVENT_RETURNING}`,
      tid,
      handover.id,
      cleanType,
      normalizeTimestamp(eventAt, 'event_at'),
      maybeUuid(recordedBy, 'recorded_by'),
      normalizeEnum(sourceType, HANDOVER_SOURCE_TYPES, 'source_type') || 'manual',
      cleanSummary,
      JSON.stringify(normalizeJsonObject(observation, 'observation')),
      JSON.stringify(normalizeJsonObject(intervention, 'intervention')),
      JSON.stringify(normalizeJsonObject(vitalSigns, 'vital_signs')),
      safeText(externalReference, 160),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    const event = rows[0];
    await requireCanonical(await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: handover.patient_uid,
      eventType: `prehospital_handover.${cleanType}`,
      eventStatus: 'recorded',
      sourceTable: 'prehospital_handover_events',
      sourceId: event.id,
      resourceType: 'prehospital_handover_event',
      resourceId: event.id,
      actorUid: maybeUuid(recordedBy, 'recorded_by'),
      actorRole,
      summary: cleanSummary,
      payload: {
        handover_id: handover.id,
        ambulance_request_id: handover.ambulance_request_id,
        emergency_visit_id: handover.emergency_visit_id,
        event_type: cleanType,
        observation: event.observation,
        intervention: event.intervention,
        vital_signs: event.vital_signs,
      },
      afterState: event,
      timelineIdempotencyKey: `prehospital_handover_events:${event.id}:recorded`,
      auditIdempotencyKey: `prehospital_handover_events:${event.id}:audit:recorded`,
    }, { db: tx }), 'handover timeline');
    return event;
  });
}

export async function acceptPrehospitalHandover({
  tenantId = null,
  handoverId,
  acceptedByUid,
  acceptedByRole = null,
  acceptanceRole = 'receiving_nurse',
  signatureMethod = 'typed',
  signatureText = null,
  handoverSignedAt = null,
  clinicalAttestation = null,
  metadata = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const actorUid = requireUuid(acceptedByUid, 'accepted_by_uid');
  return setTenantTx(tid, async (tx) => {
    const handover = await fetchHandover(tid, handoverId, tx, { forUpdate: true });
    if (handover.status === 'accepted') throw AppError.conflict('Pre-hospital handover already accepted');
    if (['cancelled', 'void'].includes(handover.status)) {
      throw AppError.conflict('Cannot accept a cancelled or void pre-hospital handover');
    }
    const acceptanceRows = await tx.$queryRawUnsafe(
      `INSERT INTO prehospital_handover_acceptances
         (tenant_id, handover_id, accepted_by_uid, accepted_by_role,
          acceptance_role, signature_method, signature_text,
          handover_signed_at, clinical_attestation, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7,
               COALESCE($8::timestamptz, NOW()), $9, $10::jsonb)
       RETURNING ${ACCEPTANCE_RETURNING}`,
      tid,
      handover.id,
      actorUid,
      safeText(acceptedByRole, 80),
      normalizeEnum(acceptanceRole, ACCEPTANCE_ROLES, 'acceptance_role') || 'receiving_nurse',
      normalizeEnum(signatureMethod, SIGNATURE_METHODS, 'signature_method') || 'typed',
      safeText(signatureText),
      normalizeTimestamp(handoverSignedAt, 'handover_signed_at'),
      safeText(clinicalAttestation),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE prehospital_handovers
          SET status = 'accepted',
              updated_by = $3::uuid,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2::uuid
        RETURNING ${HANDOVER_RETURNING}`,
      handover.id,
      tid,
      actorUid,
    );
    const updated = updatedRows[0];
    const acceptance = acceptanceRows[0];
    await requireCanonical(await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: updated.patient_uid,
      eventType: 'prehospital_handover.accepted',
      eventStatus: 'accepted',
      sourceTable: 'prehospital_handover_acceptances',
      sourceId: acceptance.id,
      resourceType: 'prehospital_handover',
      resourceId: updated.id,
      actorUid,
      actorRole: acceptedByRole,
      summary: 'Pre-hospital handover accepted by receiving clinician',
      payload: {
        handover_id: updated.id,
        ambulance_request_id: updated.ambulance_request_id,
        emergency_visit_id: updated.emergency_visit_id,
        acceptance_role: acceptance.acceptance_role,
        signature_method: acceptance.signature_method,
      },
      beforeState: { status: handover.status },
      afterState: { status: updated.status, acceptance },
      timelineIdempotencyKey: `prehospital_handover_acceptances:${acceptance.id}:accepted`,
      auditIdempotencyKey: `prehospital_handover_acceptances:${acceptance.id}:audit:accepted`,
    }, { db: tx }), 'handover acceptance');

    await publishEvent({
      eventType: 'clinical.prehospital_handover.accepted',
      aggregateType: 'prehospital_handover',
      aggregateId: updated.id,
      patientUid: updated.patient_uid,
      payload: {
        accepted_by_uid: actorUid,
        acceptance_role: acceptance.acceptance_role,
      },
      tx,
      tenantId: tid,
    });
    return { handover: updated, acceptance };
  });
}

export async function linkPrehospitalDevice({
  tenantId = null,
  handoverId,
  devicePatientAssociationId = null,
  deviceRegistryId = null,
  linkStatus = 'unverified',
  verificationStatus = 'unverified',
  sourceSystem = 'nl7',
  verifiedByUid = null,
  verifiedAt = null,
  notes = null,
  metadata = null,
  createdBy = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const handover = await fetchHandover(tid, handoverId, tx, { forUpdate: true });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO prehospital_device_links
         (tenant_id, handover_id, ambulance_request_id, patient_uid,
          device_patient_association_id, device_registry_id, link_status,
          verification_status, source_system, verified_by_uid, verified_at,
          notes, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9,
               $10::uuid, $11::timestamptz, $12, $13::jsonb, $14::uuid)
       RETURNING ${DEVICE_LINK_RETURNING}`,
      tid,
      handover.id,
      handover.ambulance_request_id,
      handover.patient_uid,
      maybeId(devicePatientAssociationId, 'device_patient_association_id'),
      maybeId(deviceRegistryId, 'device_registry_id'),
      normalizeEnum(linkStatus, ['unverified', 'active', 'ended', 'rejected'], 'link_status') || 'unverified',
      normalizeEnum(verificationStatus, ['unverified', 'verified', 'rejected'], 'verification_status') || 'unverified',
      safeText(sourceSystem, 80) || 'nl7',
      maybeUuid(verifiedByUid, 'verified_by_uid'),
      normalizeTimestamp(verifiedAt, 'verified_at'),
      safeText(notes),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    const link = rows[0];
    await requireCanonical(await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: handover.patient_uid,
      eventType: 'prehospital_handover.device_linked',
      eventStatus: link.verification_status,
      sourceTable: 'prehospital_device_links',
      sourceId: link.id,
      resourceType: 'prehospital_device_link',
      resourceId: link.id,
      actorUid: maybeUuid(createdBy || verifiedByUid, 'actor_uid'),
      actorRole,
      summary: 'Pre-hospital device link recorded',
      payload: {
        handover_id: handover.id,
        device_patient_association_id: link.device_patient_association_id,
        device_registry_id: link.device_registry_id,
        verification_status: link.verification_status,
        source_system: link.source_system,
      },
      afterState: link,
      timelineIdempotencyKey: `prehospital_device_links:${link.id}:linked`,
      auditIdempotencyKey: `prehospital_device_links:${link.id}:audit:linked`,
    }, { db: tx }), 'handover device link');
    return link;
  });
}

export async function recordPartnerSuppliedPayload({
  tenantId = null,
  handoverId,
  deviceLinkId = null,
  payload = null,
  receivedBy = null,
  actorRole = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const handover = await fetchHandover(tid, handoverId);
  if (handover.status !== 'accepted') {
    throw AppError.forbidden(
      'Partner payloads cannot write the patient chart until the handover is accepted',
      'PREHOSPITAL_HANDOVER_NOT_ACCEPTED',
    );
  }

  const cleanDeviceLinkId = maybeId(deviceLinkId, 'device_link_id');
  if (!cleanDeviceLinkId) {
    throw AppError.forbidden(
      'Partner payloads require an active verified NL-7 device association',
      'PREHOSPITAL_DEVICE_LINK_REQUIRED',
    );
  }

  const linkRows = await prisma.$queryRawUnsafe(
    `SELECT id, verification_status, link_status
       FROM prehospital_device_links
      WHERE id = $1 AND tenant_id = $2::uuid AND handover_id = $3
      LIMIT 1`,
    cleanDeviceLinkId,
    tid,
    handover.id,
  );
  const link = linkRows[0];
  if (!link || link.verification_status !== 'verified' || link.link_status !== 'active') {
    throw AppError.forbidden(
      'Partner payloads require an active verified NL-7 device association',
      'PREHOSPITAL_DEVICE_LINK_REQUIRED',
    );
  }

  if (!handover.partner_config_id) {
    throw AppError.forbidden(
      'Partner payload ingestion is inert until an operator-reviewed partner policy is active',
      'PREHOSPITAL_PARTNER_POLICY_INERT',
    );
  }
  const configRows = await prisma.$queryRawUnsafe(
    `SELECT id, status
       FROM ambulance_partner_fleet_configs
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    handover.partner_config_id,
    tid,
  );
  if (configRows[0]?.status !== 'active') {
    throw AppError.forbidden(
      'Partner payload ingestion is inert until an operator-reviewed partner policy is active',
      'PREHOSPITAL_PARTNER_POLICY_INERT',
    );
  }

  const body = normalizeJsonObject(payload, 'payload');
  return appendPrehospitalTimelineEvent({
    tenantId: tid,
    handoverId: handover.id,
    eventType: body.event_type || 'device_observation',
    sourceType: 'partner_payload',
    recordedBy: receivedBy,
    actorRole,
    summary: safeText(body.summary) || 'Partner-supplied pre-hospital observation',
    observation: body.observation || {},
    intervention: body.intervention || {},
    vitalSigns: body.vital_signs || {},
    externalReference: body.external_reference || `device_link:${link.id}`,
    metadata: {
      device_link_id: link.id,
      partner_payload: true,
    },
  });
}

export async function listPrehospitalHandovers({
  tenantId = null,
  status = null,
  openOnly = false,
  ambulanceRequestId = null,
  emergencyVisitId = null,
  patientUid = null,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['ph.tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, HANDOVER_STATUSES, 'status'));
    filters.push(`ph.status = $${params.length}`);
  }
  if (openOnly) {
    filters.push(`ph.status IN ('draft', 'ready_for_acceptance')`);
  }
  if (ambulanceRequestId) {
    params.push(normalizeId(ambulanceRequestId, 'ambulance_request_id'));
    filters.push(`ph.ambulance_request_id = $${params.length}`);
  }
  if (emergencyVisitId) {
    params.push(normalizeId(emergencyVisitId, 'emergency_visit_id'));
    filters.push(`ph.emergency_visit_id = $${params.length}`);
  }
  if (patientUid) {
    params.push(requireUuid(patientUid, 'patient_uid'));
    filters.push(`ph.patient_uid = $${params.length}::uuid`);
  }
  params.push(normalizeLimit(limit));
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${HANDOVER_JOIN_RETURNING},
              ar.request_number AS ambulance_request_number,
              ar.status AS ambulance_status,
              ev.visit_number AS emergency_visit_number,
              ev.status AS emergency_visit_status,
              acc.accepted_at AS latest_accepted_at,
              acc.accepted_by_uid AS latest_accepted_by_uid
         FROM prehospital_handovers ph
    LEFT JOIN ambulance_requests ar
           ON ar.id = ph.ambulance_request_id AND ar.tenant_id = ph.tenant_id
    LEFT JOIN emergency_visits ev
           ON ev.id = ph.emergency_visit_id AND ev.tenant_id = ph.tenant_id
    LEFT JOIN LATERAL (
           SELECT accepted_at, accepted_by_uid
             FROM prehospital_handover_acceptances
            WHERE tenant_id = ph.tenant_id AND handover_id = ph.id
            ORDER BY accepted_at DESC
            LIMIT 1
         ) acc ON TRUE
        WHERE ${filters.join(' AND ')}
        ORDER BY ph.created_at DESC
        LIMIT $${params.length}`,
      ...params,
    );
    return { handovers: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { handovers: [], count: 0 };
    throw err;
  }
}

export async function getPrehospitalHandover({
  tenantId = null,
  handoverId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const handover = await fetchHandover(tid, handoverId);
  const [events, acceptances, deviceLinks] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT ${EVENT_RETURNING}
         FROM prehospital_handover_events
        WHERE tenant_id = $1::uuid AND handover_id = $2
        ORDER BY event_at ASC, id ASC`,
      tid,
      handover.id,
    ),
    prisma.$queryRawUnsafe(
      `SELECT ${ACCEPTANCE_RETURNING}
         FROM prehospital_handover_acceptances
        WHERE tenant_id = $1::uuid AND handover_id = $2
        ORDER BY accepted_at DESC, id DESC`,
      tid,
      handover.id,
    ),
    prisma.$queryRawUnsafe(
      `SELECT ${DEVICE_LINK_RETURNING}
         FROM prehospital_device_links
        WHERE tenant_id = $1::uuid AND handover_id = $2
        ORDER BY created_at DESC, id DESC`,
      tid,
      handover.id,
    ),
  ]);
  return { handover, events, acceptances, device_links: deviceLinks };
}

export const __testing__ = {
  HANDOVER_STATUSES,
  EVENT_TYPES,
  ACCEPTANCE_ROLES,
  PARTNER_STATUSES,
  handoverNumberFor,
  edVisitNumberFor,
};

export default {
  upsertPartnerFleetConfig,
  listPartnerFleetConfigs,
  createPrehospitalHandover,
  appendPrehospitalTimelineEvent,
  acceptPrehospitalHandover,
  linkPrehospitalDevice,
  recordPartnerSuppliedPayload,
  listPrehospitalHandovers,
  getPrehospitalHandover,
};
