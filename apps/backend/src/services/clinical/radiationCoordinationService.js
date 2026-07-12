// NL-13 P4 — nuclear-medicine & radiotherapy COORDINATION (integrate-only).
//
// This service COORDINATES: it stores EXTERNAL planning-system / delivery references,
// appointment/fraction STATUS, orders, administration records, owner-sourced safety
// evidence, and canonical timeline outputs. It NEVER calculates a treatment plan, NEVER
// computes dosimetry, and NEVER controls LINAC / scanner / delivery hardware — dose and
// activity values are owner-supplied summary fields only. Image/document deep links reuse
// the existing PACS/OHIF/DICOMweb plumbing (pacsService). Ships inert behind a per-tenant
// flag; administration is gated by an owner-sourced credentialing privilege that fails closed.

import prisma, { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
} from './canonicalClinicalPlatformService.js';
import {
  assertPrivilegeForGate,
  isGateEnabled,
  privilegeKey,
} from '../staff/credentialingService.js';
import { buildViewerUrl } from '../radiology/pacsService.js';

const REFRESH_INTERVAL_MS = 60 * 1000;
const enabledCache = new Map(); // tenant_id -> { value, fetchedAt }
const tenantOr = (tenantId) => requireTenantId(tenantId);

// ── enums + state machines ───────────────────────────────────────────────

export const REFERRAL_INTENTS = Object.freeze(['curative', 'adjuvant', 'neoadjuvant', 'palliative', 'other']);
export const REFERRAL_MODALITIES = Object.freeze(['external_beam', 'brachytherapy', 'systemic_radioisotope', 'nuclear_medicine_therapy', 'other']);
export const URGENCIES = Object.freeze(['routine', 'urgent', 'emergency']);
export const ORDER_KINDS = Object.freeze(['diagnostic', 'therapy']);
export const EVIDENCE_TYPES = Object.freeze(['equipment_licensing', 'equipment_qa', 'radiation_safety', 'radioisotope_handling', 'delivery_qa', 'other']);
export const EVIDENCE_STATUSES = Object.freeze(['pending', 'active', 'expired', 'superseded']);

export const REFERRAL_STATUSES = Object.freeze(['draft', 'submitted', 'accepted', 'planned', 'in_treatment', 'completed', 'cancelled', 'declined']);
export const REFERRAL_TRANSITIONS = Object.freeze({
  draft: ['submitted', 'cancelled'],
  submitted: ['accepted', 'declined', 'cancelled'],
  accepted: ['planned', 'cancelled'],
  planned: ['in_treatment', 'cancelled'],
  in_treatment: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  declined: [],
});
// States that require a clinical linkage (diagnosis/staging) or an external referral ref.
const REFERRAL_STATES_NEEDING_LINK = new Set(['accepted', 'planned', 'in_treatment', 'completed']);

export const PLAN_STATUSES = Object.freeze(['referenced', 'approved', 'superseded', 'cancelled']);
export const PLAN_TRANSITIONS = Object.freeze({
  referenced: ['approved', 'superseded', 'cancelled'],
  approved: ['superseded', 'cancelled'],
  superseded: [],
  cancelled: [],
});

export const FRACTION_STATUSES = Object.freeze(['planned', 'scheduled', 'delivered', 'held', 'cancelled', 'missed']);
export const FRACTION_TRANSITIONS = Object.freeze({
  planned: ['scheduled', 'held', 'cancelled'],
  scheduled: ['delivered', 'held', 'missed', 'cancelled'],
  held: ['scheduled', 'cancelled'],
  delivered: [],
  cancelled: [],
  missed: ['scheduled'],
});

export const NM_ORDER_STATUSES = Object.freeze(['draft', 'ordered', 'scheduled', 'prepared', 'administered', 'completed', 'cancelled']);
export const NM_ORDER_TRANSITIONS = Object.freeze({
  draft: ['ordered', 'cancelled'],
  ordered: ['scheduled', 'cancelled'],
  scheduled: ['prepared', 'cancelled'],
  prepared: ['administered', 'cancelled'],
  administered: ['completed'],
  completed: [],
  cancelled: [],
});
// NM order states past draft require an isotope/radiopharmaceutical external reference.
const NM_STATES_NEEDING_ISOTOPE = new Set(['ordered', 'scheduled', 'prepared', 'administered', 'completed']);

// ── primitive normalizers (mirrors cathLabService) ───────────────────────

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`, 'RADIATION_BAD_ID');
  }
  return parsed;
}

function maybeId(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeId(value, label);
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'RADIATION_BAD_UUID');
  }
  return text;
}

function normalizeJson(value, label, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'object') {
    throw AppError.badRequest(`${label} must be JSON`, 'RADIATION_BAD_JSON');
  }
  return value;
}

function optionalNumber(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw AppError.badRequest(`${label} must be a non-negative number`, 'RADIATION_BAD_NUMBER');
  }
  return number;
}

function optionalInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw AppError.badRequest(`${label} must be a non-negative integer`, 'RADIATION_BAD_INTEGER');
  }
  return parsed;
}

function optionalTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid timestamp`, 'RADIATION_BAD_TIMESTAMP');
  }
  return date.toISOString();
}

function optionalDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${label} must be a valid date`, 'RADIATION_BAD_DATE');
  }
  return date.toISOString().slice(0, 10);
}

function normalizeEnum(value, allowed, label) {
  const status = cleanText(value, 60);
  if (!status || !allowed.includes(status)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`, 'RADIATION_BAD_ENUM');
  }
  return status;
}

function normalizeDbValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeDbValue(item)]));
  }
  return value;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeDbValue) : normalizeDbValue(rows);
}

function unwrap(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

// ── pure state-transition validators (unit-tested) ───────────────────────

function validateTransition(from, to, table, label) {
  const target = normalizeEnum(to, Object.keys(table).concat(...Object.values(table)).filter((v, i, a) => a.indexOf(v) === i), label);
  const allowed = table[from] || [];
  if (!allowed.includes(target)) {
    throw AppError.invalidTransition(from, target, allowed);
  }
  return target;
}

export function validateReferralTransition(from, to) {
  return validateTransition(from, to, REFERRAL_TRANSITIONS, 'status');
}
export function validatePlanTransition(from, to) {
  return validateTransition(from, to, PLAN_TRANSITIONS, 'plan_status');
}
export function validateFractionTransition(from, to) {
  return validateTransition(from, to, FRACTION_TRANSITIONS, 'status');
}
export function validateNuclearOrderTransition(from, to) {
  return validateTransition(from, to, NM_ORDER_TRANSITIONS, 'status');
}

// Required-external-reference guardrails (integration guardrail — FAILS CLOSED).
export function assertReferralLinkForState(referral, targetStatus) {
  if (!REFERRAL_STATES_NEEDING_LINK.has(targetStatus)) return;
  const hasLink = Boolean(referral.diagnosis_id)
    || Boolean(referral.staging_record_id)
    || Boolean(cleanText(referral.external_reference_id));
  if (!hasLink) {
    throw AppError.badRequest(
      'Referral cannot advance without a diagnosis/staging link or an external referral reference',
      'RADIATION_REFERRAL_LINK_REQUIRED',
    );
  }
}

export function assertPlanReferenceForApproval(planRef, targetStatus) {
  if (targetStatus !== 'approved') return;
  if (!cleanText(planRef.external_plan_system) || !cleanText(planRef.external_plan_id)) {
    throw AppError.badRequest(
      'Radiotherapy plan cannot be approved without an external planning-system reference (system + id)',
      'RADIOTHERAPY_PLAN_REFERENCE_REQUIRED',
    );
  }
}

export function assertTreatmentRefForDelivery(fraction, targetStatus) {
  if (targetStatus !== 'delivered') return;
  if (!cleanText(fraction.external_treatment_ref)) {
    throw AppError.badRequest(
      'Fraction cannot be marked delivered without an external treatment reference from the delivery system',
      'RADIOTHERAPY_FRACTION_TREATMENT_REF_REQUIRED',
    );
  }
}

export function assertIsotopeRefForOrderState(order, targetStatus) {
  if (!NM_STATES_NEEDING_ISOTOPE.has(targetStatus)) return;
  if (!cleanText(order.radiopharmaceutical_ref) && !cleanText(order.isotope_ref)) {
    throw AppError.badRequest(
      'Nuclear-medicine order cannot advance without an isotope / radiopharmaceutical reference',
      'NUCLEAR_MEDICINE_ISOTOPE_REF_REQUIRED',
    );
  }
}

// ── privilege gate (owner-sourced, inert until enabled) ──────────────────

export function radiationPrivilegeGateConfig() {
  const key = privilegeKey(
    process.env.RADIATION_ONCOLOGY_PRIVILEGE_KEY || 'radiation_oncology_owner_supplied_privilege',
  );
  return {
    key,
    enabled: isGateEnabled('RADIATION_ONCOLOGY_PRIVILEGE_GATE_ENABLED'),
  };
}

// ── per-tenant feature flag (fail-closed cache) ──────────────────────────

async function getSettingRow(tenantId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT tenant_id, enabled, enabled_at, enabled_by, aerb_evidence_owner,
            owner_source_policy_ref, planning_system_vendor_ref, acceptance_snapshot,
            created_at, updated_at
       FROM radiation_coordination_settings
      WHERE tenant_id = $1::uuid`,
    tenantOr(tenantId),
  );
  return rows[0] || {
    tenant_id: tenantOr(tenantId),
    enabled: false,
    enabled_at: null,
    enabled_by: null,
    aerb_evidence_owner: null,
    owner_source_policy_ref: null,
    planning_system_vendor_ref: null,
    acceptance_snapshot: null,
    created_at: null,
    updated_at: null,
  };
}

export async function getRadiationCoordinationSettings({ tenantId } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => getSettingRow(tenantId, tx));
}

export async function isRadiationCoordinationEnabled(tenantId) {
  if (!tenantId) return false;
  const key = String(tenantId);
  const cached = enabledCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= REFRESH_INTERVAL_MS) return cached.value;
  try {
    const row = await getRadiationCoordinationSettings({ tenantId });
    const value = row.enabled === true;
    enabledCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    logger.warn(`isRadiationCoordinationEnabled failed for tenant ${tenantId}: ${err.message}`);
    return false; // fail closed, do NOT cache
  }
}

async function assertCoordinationEnabled(tenantId) {
  if (!(await isRadiationCoordinationEnabled(tenantId))) {
    throw AppError.forbidden('Radiation coordination suite is disabled for this tenant', 'RADIATION_COORDINATION_DISABLED');
  }
}

export async function setRadiationCoordinationSettings({
  tenantId,
  enabled,
  aerbEvidenceOwner = null,
  ownerSourcePolicyRef = null,
  planningSystemVendorRef = null,
  acceptanceSnapshot = null,
}, { actorUid = null, actorRole = null } = {}) {
  const enabledBool = enabled === true;
  const row = await setTenantTx(tenantOr(tenantId), async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO radiation_coordination_settings
         (tenant_id, enabled, enabled_at, enabled_by, aerb_evidence_owner,
          owner_source_policy_ref, planning_system_vendor_ref, acceptance_snapshot, updated_at)
       VALUES (
         $1::uuid, $2,
         CASE WHEN $2 THEN NOW() ELSE NULL END,
         CASE WHEN $2 THEN $3::uuid ELSE NULL END,
         $4, $5, $6, $7::jsonb, NOW()
       )
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = $2,
         enabled_at = CASE WHEN $2 THEN NOW() ELSE radiation_coordination_settings.enabled_at END,
         enabled_by = CASE WHEN $2 THEN $3::uuid ELSE radiation_coordination_settings.enabled_by END,
         aerb_evidence_owner = COALESCE($4, radiation_coordination_settings.aerb_evidence_owner),
         owner_source_policy_ref = COALESCE($5, radiation_coordination_settings.owner_source_policy_ref),
         planning_system_vendor_ref = COALESCE($6, radiation_coordination_settings.planning_system_vendor_ref),
         acceptance_snapshot = CASE WHEN $2 THEN $7::jsonb ELSE radiation_coordination_settings.acceptance_snapshot END,
         updated_at = NOW()
       RETURNING tenant_id, enabled, enabled_at, enabled_by, aerb_evidence_owner,
                 owner_source_policy_ref, planning_system_vendor_ref, acceptance_snapshot,
                 created_at, updated_at`,
      tenantOr(tenantId),
      enabledBool,
      maybeUuid(actorUid, 'actorUid'),
      cleanText(aerbEvidenceOwner, 160),
      cleanText(ownerSourcePolicyRef),
      cleanText(planningSystemVendorRef),
      JSON.stringify(acceptanceSnapshot ?? null),
    );
    await recordClinicalAuditEvent({
      tenantId: tenantOr(tenantId),
      action: enabledBool ? 'radiation_coordination.enabled' : 'radiation_coordination.disabled',
      actorUid,
      actorRole,
      resourceType: 'radiation_coordination_settings',
      resourceTable: 'radiation_coordination_settings',
      resourceId: tenantOr(tenantId),
      metadata: {
        aerb_evidence_owner: aerbEvidenceOwner,
        owner_source_policy_ref: ownerSourcePolicyRef,
        planning_system_vendor_ref: planningSystemVendorRef,
      },
      idempotencyKey: `radiation_coordination_settings:${tenantOr(tenantId)}:${enabledBool}:${Date.now()}`,
    }, { db: tx });
    return rows[0];
  });
  enabledCache.set(String(tenantId), { value: enabledBool, fetchedAt: Date.now() });
  return normalizeDbValue(row);
}

// ── canonical event helper (detail row + timeline + audit in one tx) ─────

async function emitAndLink(tx, tableName, row, event) {
  const result = await recordCanonicalClinicalEvent({ tags: ['radiation_oncology', 'nl13_p4'], ...event }, { db: tx });
  const timelineId = result?.timeline?.id || null;
  if (timelineId) {
    await tx.$queryRawUnsafe(
      `UPDATE ${tableName}
          SET canonical_timeline_event_id = $1::uuid,
              updated_at = NOW()
        WHERE id = $2::bigint
          AND tenant_id = $3::uuid`,
      timelineId,
      row.id,
      event.tenantId,
    );
  }
  return { ...row, canonical_timeline_event_id: timelineId || row.canonical_timeline_event_id || null };
}

// ── loaders ──────────────────────────────────────────────────────────────

async function assertPatientInTenant(db, tenantId, patientUid) {
  const uid = maybeUuid(patientUid, 'patient_uid');
  if (!uid) throw AppError.badRequest('patient_uid is required', 'RADIATION_PATIENT_REQUIRED');
  const rows = await db.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    uid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'RADIATION_PATIENT_NOT_FOUND');
  return uid;
}

async function assertDiagnosisLink(db, tenantId, diagnosisId, patientUid) {
  if (!diagnosisId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, patient_uid FROM oncology_diagnoses
      WHERE id = $1::bigint AND tenant_id = $2::uuid LIMIT 1`,
    normalizeId(diagnosisId, 'diagnosis_id'),
    tenantOr(tenantId),
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Oncology diagnosis not found', 'RADIATION_DIAGNOSIS_NOT_FOUND');
  if (patientUid && String(row.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Diagnosis does not belong to this patient', 'RADIATION_DIAGNOSIS_PATIENT_MISMATCH');
  }
  return row.id;
}

async function assertStagingLink(db, tenantId, stagingRecordId, patientUid) {
  if (!stagingRecordId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, patient_uid FROM oncology_staging_records
      WHERE id = $1::bigint AND tenant_id = $2::uuid LIMIT 1`,
    normalizeId(stagingRecordId, 'staging_record_id'),
    tenantOr(tenantId),
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Oncology staging record not found', 'RADIATION_STAGING_NOT_FOUND');
  if (patientUid && String(row.patient_uid) !== String(patientUid)) {
    throw AppError.badRequest('Staging record does not belong to this patient', 'RADIATION_STAGING_PATIENT_MISMATCH');
  }
  return row.id;
}

async function referralById(db, tenantId, referralId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT * FROM radiation_oncology_referrals
      WHERE id = $1::bigint AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''} LIMIT 1`,
    normalizeId(referralId, 'referral_id'),
    tenantOr(tenantId),
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Radiation-oncology referral not found', 'RADIATION_REFERRAL_NOT_FOUND');
  return row;
}

async function planRefById(db, tenantId, planRefId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT * FROM radiotherapy_plan_refs
      WHERE id = $1::bigint AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''} LIMIT 1`,
    normalizeId(planRefId, 'plan_ref_id'),
    tenantOr(tenantId),
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Radiotherapy plan reference not found', 'RADIOTHERAPY_PLAN_NOT_FOUND');
  return row;
}

async function fractionById(db, tenantId, fractionId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT * FROM radiotherapy_fraction_schedules
      WHERE id = $1::bigint AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''} LIMIT 1`,
    normalizeId(fractionId, 'fraction_id'),
    tenantOr(tenantId),
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Radiotherapy fraction not found', 'RADIOTHERAPY_FRACTION_NOT_FOUND');
  return row;
}

async function nuclearOrderById(db, tenantId, orderId, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT * FROM nuclear_medicine_orders
      WHERE id = $1::bigint AND tenant_id = $2::uuid
      ${lock ? 'FOR UPDATE' : ''} LIMIT 1`,
    normalizeId(orderId, 'order_id'),
    tenantOr(tenantId),
  );
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('Nuclear-medicine order not found', 'NUCLEAR_MEDICINE_ORDER_NOT_FOUND');
  return row;
}

function withViewerUrl(row) {
  if (!row) return row;
  const uid = row.image_study_instance_uid;
  if (uid) {
    return { ...row, viewer_url: buildViewerUrl(uid) };
  }
  return row;
}

// ── referrals ─────────────────────────────────────────────────────────────

export async function createReferral(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const patientUid = await assertPatientInTenant(tx, tenantId, input.patient_uid || input.patientUid);
    const diagnosisId = await assertDiagnosisLink(tx, tenantId, maybeId(input.diagnosis_id || input.diagnosisId, 'diagnosis_id'), patientUid);
    const stagingRecordId = await assertStagingLink(tx, tenantId, maybeId(input.staging_record_id || input.stagingRecordId, 'staging_record_id'), patientUid);
    const intent = input.intent ? normalizeEnum(input.intent, REFERRAL_INTENTS, 'intent') : 'curative';
    const modality = input.modality ? normalizeEnum(input.modality, REFERRAL_MODALITIES, 'modality') : 'external_beam';
    const urgency = input.urgency ? normalizeEnum(input.urgency, URGENCIES, 'urgency') : 'routine';
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO radiation_oncology_referrals
         (tenant_id, patient_uid, encounter_id, diagnosis_id, staging_record_id, intent, modality,
          urgency, referring_clinician_uid, referring_clinician_name, reason,
          external_reference_system, external_reference_id, status, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint, $6, $7,
               $8, $9::uuid, $10, $11, $12, $13, 'draft', $14::uuid, $14::uuid, $15::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      maybeUuid(input.encounter_id || input.encounterId, 'encounter_id'),
      diagnosisId,
      stagingRecordId,
      intent,
      modality,
      urgency,
      maybeUuid(input.referring_clinician_uid || input.referringClinicianUid || context.actorUid, 'referring_clinician_uid'),
      cleanText(input.referring_clinician_name || input.referringClinicianName, 160),
      cleanText(input.reason),
      cleanText(input.external_reference_system || input.externalReferenceSystem, 160),
      cleanText(input.external_reference_id || input.externalReferenceId, 160),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {})),
    );
    const referral = unwrap(rows);
    const linked = await emitAndLink(tx, 'radiation_oncology_referrals', referral, {
      tenantId,
      patientUid,
      encounterId: referral.encounter_id,
      eventType: 'radiotherapy.referral_created',
      eventStatus: referral.status,
      sourceTable: 'radiation_oncology_referrals',
      sourceId: referral.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Radiation-oncology referral created (${modality}, ${intent})`,
      payload: { intent, modality, urgency, diagnosis_id: diagnosisId, staging_record_id: stagingRecordId },
      afterState: referral,
      timelineIdempotencyKey: `radiation_oncology_referrals:${referral.id}:created`,
      auditIdempotencyKey: `radiation_oncology_referrals:${referral.id}:audit:created`,
    });
    return normalizeDbValue(linked);
  });
}

export async function transitionReferralStatus(referralId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const referral = await referralById(tx, tenantId, referralId, { lock: true });
    const target = validateReferralTransition(referral.status, input.status);
    assertReferralLinkForState(referral, target);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE radiation_oncology_referrals
          SET status = $3, updated_by = $4::uuid, updated_at = NOW()
        WHERE id = $1::bigint AND tenant_id = $2::uuid
        RETURNING *`,
      referral.id,
      tenantId,
      target,
      maybeUuid(context.actorUid, 'actorUid'),
    );
    const updated = unwrap(rows);
    const linked = await emitAndLink(tx, 'radiation_oncology_referrals', updated, {
      tenantId,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `radiotherapy.referral_${target}`,
      eventStatus: target,
      sourceTable: 'radiation_oncology_referrals',
      sourceId: updated.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Radiation-oncology referral ${target}`,
      payload: { from: referral.status, to: target, reason: cleanText(input.reason) },
      beforeState: { status: referral.status },
      afterState: { status: target },
      timelineIdempotencyKey: `radiation_oncology_referrals:${updated.id}:status:${target}`,
      auditIdempotencyKey: `radiation_oncology_referrals:${updated.id}:audit:status:${target}`,
    });
    return normalizeDbValue(linked);
  });
}

export async function listReferrals({ tenantId, patientUid = null, status = null, limit = 100 } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => {
    const params = [tenantOr(tenantId)];
    const where = ['r.tenant_id = $1::uuid'];
    let idx = 2;
    if (patientUid) {
      where.push(`r.patient_uid = $${idx++}::uuid`);
      params.push(maybeUuid(patientUid, 'patient_uid'));
    }
    if (status) {
      where.push(`r.status = $${idx++}`);
      params.push(normalizeEnum(status, REFERRAL_STATUSES, 'status'));
    }
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
    params.push(safeLimit);
    return tx.$queryRawUnsafe(
      `SELECT r.*, u.name AS patient_name,
              (SELECT COUNT(*)::int FROM radiotherapy_plan_refs p WHERE p.tenant_id = r.tenant_id AND p.referral_id = r.id) AS plan_ref_count,
              (SELECT COUNT(*)::int FROM nuclear_medicine_orders o WHERE o.tenant_id = r.tenant_id AND o.referral_id = r.id) AS nuclear_order_count
         FROM radiation_oncology_referrals r
         LEFT JOIN users u ON u.uid = r.patient_uid AND u.tenant_id = r.tenant_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${idx}::int`,
      ...params,
    ).then(normalizeRows);
  });
}

export async function getReferralDetail(referralId, { tenantId } = {}) {
  return setTenant(tenantOr(tenantId), async (tx) => {
    const referral = await referralById(tx, tenantId, referralId);
    const planRefs = await tx.$queryRawUnsafe(
      `SELECT * FROM radiotherapy_plan_refs WHERE tenant_id = $1::uuid AND referral_id = $2::bigint ORDER BY created_at DESC`,
      tenantOr(tenantId), referral.id,
    );
    const fractions = await tx.$queryRawUnsafe(
      `SELECT * FROM radiotherapy_fraction_schedules WHERE tenant_id = $1::uuid AND referral_id = $2::bigint ORDER BY fraction_number ASC`,
      tenantOr(tenantId), referral.id,
    );
    const nuclearOrders = await tx.$queryRawUnsafe(
      `SELECT * FROM nuclear_medicine_orders WHERE tenant_id = $1::uuid AND referral_id = $2::bigint ORDER BY created_at DESC`,
      tenantOr(tenantId), referral.id,
    );
    return normalizeDbValue({
      ...referral,
      plan_refs: (planRefs || []).map(withViewerUrl),
      fraction_schedules: fractions || [],
      nuclear_medicine_orders: (nuclearOrders || []).map(withViewerUrl),
    });
  });
}

// ── radiotherapy plan references ─────────────────────────────────────────

export async function createPlanRef(referralId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const referral = await referralById(tx, tenantId, referralId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO radiotherapy_plan_refs
         (tenant_id, referral_id, patient_uid, encounter_id, external_plan_system, external_plan_id,
          plan_status, approving_radiation_oncologist_uid, approving_radiation_oncologist_name,
          technique, planned_fraction_count, total_dose_gy_summary, document_ref, document_storage_key,
          image_study_instance_uid, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5, $6,
               'referenced', $7::uuid, $8, $9, $10::int, $11::numeric, $12, $13, $14, $15::uuid, $15::uuid, $16::jsonb)
       RETURNING *`,
      tenantId,
      referral.id,
      referral.patient_uid,
      referral.encounter_id,
      cleanText(input.external_plan_system || input.externalPlanSystem, 160),
      cleanText(input.external_plan_id || input.externalPlanId, 160),
      maybeUuid(input.approving_radiation_oncologist_uid || input.approvingRadiationOncologistUid, 'approving_radiation_oncologist_uid'),
      cleanText(input.approving_radiation_oncologist_name || input.approvingRadiationOncologistName, 160),
      cleanText(input.technique, 120),
      optionalInteger(input.planned_fraction_count || input.plannedFractionCount, 'planned_fraction_count'),
      optionalNumber(input.total_dose_gy_summary || input.totalDoseGySummary, 'total_dose_gy_summary'),
      cleanText(input.document_ref || input.documentRef),
      cleanText(input.document_storage_key || input.documentStorageKey),
      cleanText(input.image_study_instance_uid || input.imageStudyInstanceUid, 200),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {})),
    );
    const planRef = unwrap(rows);
    const linked = await emitAndLink(tx, 'radiotherapy_plan_refs', planRef, {
      tenantId,
      patientUid: planRef.patient_uid,
      encounterId: planRef.encounter_id,
      eventType: 'radiotherapy.plan_referenced',
      eventStatus: planRef.plan_status,
      sourceTable: 'radiotherapy_plan_refs',
      sourceId: planRef.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: 'Radiotherapy external plan reference recorded',
      payload: {
        referral_id: referral.id,
        external_plan_system: planRef.external_plan_system,
        external_plan_id: planRef.external_plan_id,
      },
      afterState: planRef,
      timelineIdempotencyKey: `radiotherapy_plan_refs:${planRef.id}:referenced`,
      auditIdempotencyKey: `radiotherapy_plan_refs:${planRef.id}:audit:referenced`,
    });
    return normalizeDbValue(withViewerUrl(linked));
  });
}

export async function transitionPlanStatus(planRefId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const planRef = await planRefById(tx, tenantId, planRefId, { lock: true });
    const target = validatePlanTransition(planRef.plan_status, input.plan_status || input.planStatus || input.status);
    assertPlanReferenceForApproval(planRef, target);
    // Sol Ultra LD-RRB-07: a plan approval attests the approving radiation
    // oncologist's OWN decision — bind it to the authenticated actor rather than
    // a caller-supplied uid (which let one doctor record another as the approver).
    const approverUid = target === 'approved'
      ? maybeUuid(context.actorUid, 'approving_radiation_oncologist_uid')
      : null;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE radiotherapy_plan_refs
          SET plan_status = $3,
              approving_radiation_oncologist_uid = COALESCE($4::uuid, approving_radiation_oncologist_uid),
              updated_by = $5::uuid, updated_at = NOW()
        WHERE id = $1::bigint AND tenant_id = $2::uuid
        RETURNING *`,
      planRef.id,
      tenantId,
      target,
      approverUid,
      maybeUuid(context.actorUid, 'actorUid'),
    );
    const updated = unwrap(rows);
    const linked = await emitAndLink(tx, 'radiotherapy_plan_refs', updated, {
      tenantId,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `radiotherapy.plan_${target}`,
      eventStatus: target,
      sourceTable: 'radiotherapy_plan_refs',
      sourceId: updated.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Radiotherapy plan ${target}`,
      payload: { from: planRef.plan_status, to: target, external_plan_id: updated.external_plan_id },
      beforeState: { plan_status: planRef.plan_status },
      afterState: { plan_status: target },
      timelineIdempotencyKey: `radiotherapy_plan_refs:${updated.id}:status:${target}`,
      auditIdempotencyKey: `radiotherapy_plan_refs:${updated.id}:audit:status:${target}`,
    });
    return normalizeDbValue(withViewerUrl(linked));
  });
}

// ── radiotherapy fraction schedules ──────────────────────────────────────

export async function scheduleFraction(planRefId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  const fractionNumber = normalizeId(input.fraction_number || input.fractionNumber, 'fraction_number');
  return setTenantTx(tenantId, async (tx) => {
    const planRef = await planRefById(tx, tenantId, planRefId);
    const status = input.status ? normalizeEnum(input.status, ['planned', 'scheduled'], 'status') : 'planned';
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO radiotherapy_fraction_schedules
         (tenant_id, plan_ref_id, referral_id, patient_uid, encounter_id, appointment_id,
          fraction_number, planned_fraction_count, external_treatment_ref, scheduled_at,
          status, recorded_by, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid, $5::uuid, $6::int,
               $7::int, $8::int, $9, $10::timestamptz, $11, $12::uuid, $12::uuid, $12::uuid, $13::jsonb)
       RETURNING *`,
      tenantId,
      planRef.id,
      planRef.referral_id,
      planRef.patient_uid,
      planRef.encounter_id,
      maybeId(input.appointment_id || input.appointmentId, 'appointment_id'),
      fractionNumber,
      optionalInteger(input.planned_fraction_count || input.plannedFractionCount, 'planned_fraction_count') ?? planRef.planned_fraction_count ?? null,
      cleanText(input.external_treatment_ref || input.externalTreatmentRef, 160),
      optionalTimestamp(input.scheduled_at || input.scheduledAt, 'scheduled_at'),
      status,
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {})),
    );
    const fraction = unwrap(rows);
    const linked = await emitAndLink(tx, 'radiotherapy_fraction_schedules', fraction, {
      tenantId,
      patientUid: fraction.patient_uid,
      encounterId: fraction.encounter_id,
      eventType: 'radiotherapy.fraction_scheduled',
      eventStatus: fraction.status,
      sourceTable: 'radiotherapy_fraction_schedules',
      sourceId: fraction.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Radiotherapy fraction ${fraction.fraction_number} ${fraction.status}`,
      payload: { plan_ref_id: planRef.id, fraction_number: fraction.fraction_number, status: fraction.status },
      afterState: fraction,
      timelineIdempotencyKey: `radiotherapy_fraction_schedules:${fraction.id}:scheduled`,
      auditIdempotencyKey: `radiotherapy_fraction_schedules:${fraction.id}:audit:scheduled`,
    });
    return normalizeDbValue(linked);
  });
}

export async function transitionFractionStatus(fractionId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const fraction = await fractionById(tx, tenantId, fractionId, { lock: true });
    const target = validateFractionTransition(fraction.status, input.status);
    if (target === 'held' && !cleanText(input.hold_reason || input.holdReason)) {
      throw AppError.badRequest('hold_reason is required to hold a fraction', 'RADIOTHERAPY_FRACTION_HOLD_REASON_REQUIRED');
    }
    if (target === 'cancelled' && !cleanText(input.cancel_reason || input.cancelReason)) {
      throw AppError.badRequest('cancel_reason is required to cancel a fraction', 'RADIOTHERAPY_FRACTION_CANCEL_REASON_REQUIRED');
    }
    const externalTreatmentRef = cleanText(input.external_treatment_ref || input.externalTreatmentRef, 160);
    const candidate = { ...fraction, external_treatment_ref: externalTreatmentRef || fraction.external_treatment_ref };
    assertTreatmentRefForDelivery(candidate, target);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE radiotherapy_fraction_schedules
          SET status = $3::text,
              external_treatment_ref = COALESCE($4, external_treatment_ref),
              delivered_at = CASE WHEN $3::text = 'delivered' THEN COALESCE($5::timestamptz, delivered_at, NOW()) ELSE delivered_at END,
              hold_reason = CASE WHEN $3::text = 'held' THEN $6 ELSE hold_reason END,
              cancel_reason = CASE WHEN $3::text = 'cancelled' THEN $7 ELSE cancel_reason END,
              recorded_by = $8::uuid, updated_by = $8::uuid, updated_at = NOW()
        WHERE id = $1::bigint AND tenant_id = $2::uuid
        RETURNING *`,
      fraction.id,
      tenantId,
      target,
      externalTreatmentRef,
      optionalTimestamp(input.delivered_at || input.deliveredAt, 'delivered_at'),
      cleanText(input.hold_reason || input.holdReason),
      cleanText(input.cancel_reason || input.cancelReason),
      maybeUuid(context.actorUid, 'actorUid'),
    );
    const updated = unwrap(rows);
    const linked = await emitAndLink(tx, 'radiotherapy_fraction_schedules', updated, {
      tenantId,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `radiotherapy.fraction_${target}`,
      eventStatus: target,
      sourceTable: 'radiotherapy_fraction_schedules',
      sourceId: updated.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Radiotherapy fraction ${updated.fraction_number} ${target}`,
      payload: { from: fraction.status, to: target, external_treatment_ref: updated.external_treatment_ref },
      beforeState: { status: fraction.status },
      afterState: { status: target },
      timelineIdempotencyKey: `radiotherapy_fraction_schedules:${updated.id}:status:${target}`,
      auditIdempotencyKey: `radiotherapy_fraction_schedules:${updated.id}:audit:status:${target}`,
    });
    return normalizeDbValue(linked);
  });
}

// ── nuclear-medicine orders ───────────────────────────────────────────────

export async function createNuclearOrder(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  const studyType = cleanText(input.study_type || input.studyType, 160);
  if (!studyType) throw AppError.badRequest('study_type is required', 'NUCLEAR_MEDICINE_STUDY_TYPE_REQUIRED');
  return setTenantTx(tenantId, async (tx) => {
    const patientUid = await assertPatientInTenant(tx, tenantId, input.patient_uid || input.patientUid);
    const referralId = maybeId(input.referral_id || input.referralId, 'referral_id');
    if (referralId) {
      const referral = await referralById(tx, tenantId, referralId);
      // Sol Ultra LD-RRB-06: a referral must belong to the SAME patient as the
      // order, not merely exist in the tenant (mirrors assertDiagnosisLink /
      // assertStagingLink, which already patient-bind their references).
      if (referral?.patient_uid && String(referral.patient_uid) !== String(patientUid)) {
        throw AppError.forbidden(
          'referral_id belongs to a different patient',
          'RADIATION_REFERRAL_PATIENT_MISMATCH',
        );
      }
    }
    const orderKind = input.order_kind ? normalizeEnum(input.order_kind || input.orderKind, ORDER_KINDS, 'order_kind') : 'diagnostic';
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nuclear_medicine_orders
         (tenant_id, patient_uid, encounter_id, referral_id, appointment_id, order_kind, study_type,
          radiopharmaceutical_ref, isotope_ref, external_order_system, external_order_id,
          preparation_instructions, scheduled_at, status, image_study_instance_uid, document_ref,
          document_storage_key, ordered_by, created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::int, $6, $7,
               $8, $9, $10, $11, $12, $13::timestamptz, 'draft', $14, $15, $16, $17::uuid, $17::uuid, $17::uuid, $18::jsonb)
       RETURNING *`,
      tenantId,
      patientUid,
      maybeUuid(input.encounter_id || input.encounterId, 'encounter_id'),
      referralId,
      maybeId(input.appointment_id || input.appointmentId, 'appointment_id'),
      orderKind,
      studyType,
      cleanText(input.radiopharmaceutical_ref || input.radiopharmaceuticalRef, 160),
      cleanText(input.isotope_ref || input.isotopeRef, 120),
      cleanText(input.external_order_system || input.externalOrderSystem, 160),
      cleanText(input.external_order_id || input.externalOrderId, 160),
      cleanText(input.preparation_instructions || input.preparationInstructions),
      optionalTimestamp(input.scheduled_at || input.scheduledAt, 'scheduled_at'),
      cleanText(input.image_study_instance_uid || input.imageStudyInstanceUid, 200),
      cleanText(input.document_ref || input.documentRef),
      cleanText(input.document_storage_key || input.documentStorageKey),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {})),
    );
    const order = unwrap(rows);
    const linked = await emitAndLink(tx, 'nuclear_medicine_orders', order, {
      tenantId,
      patientUid,
      encounterId: order.encounter_id,
      eventType: 'nuclear_medicine.order_created',
      eventStatus: order.status,
      sourceTable: 'nuclear_medicine_orders',
      sourceId: order.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Nuclear-medicine ${orderKind} order created: ${studyType}`,
      payload: { study_type: studyType, order_kind: orderKind, referral_id: referralId },
      afterState: order,
      timelineIdempotencyKey: `nuclear_medicine_orders:${order.id}:created`,
      auditIdempotencyKey: `nuclear_medicine_orders:${order.id}:audit:created`,
    });
    return normalizeDbValue(withViewerUrl(linked));
  });
}

export async function transitionNuclearOrderStatus(orderId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const order = await nuclearOrderById(tx, tenantId, orderId, { lock: true });
    const target = validateNuclearOrderTransition(order.status, input.status);
    assertIsotopeRefForOrderState(order, target);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE nuclear_medicine_orders
          SET status = $3, updated_by = $4::uuid, updated_at = NOW()
        WHERE id = $1::bigint AND tenant_id = $2::uuid
        RETURNING *`,
      order.id,
      tenantId,
      target,
      maybeUuid(context.actorUid, 'actorUid'),
    );
    const updated = unwrap(rows);
    const linked = await emitAndLink(tx, 'nuclear_medicine_orders', updated, {
      tenantId,
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_id,
      eventType: `nuclear_medicine.order_${target}`,
      eventStatus: target,
      sourceTable: 'nuclear_medicine_orders',
      sourceId: updated.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: `Nuclear-medicine order ${target}`,
      payload: { from: order.status, to: target },
      beforeState: { status: order.status },
      afterState: { status: target },
      timelineIdempotencyKey: `nuclear_medicine_orders:${updated.id}:status:${target}`,
      auditIdempotencyKey: `nuclear_medicine_orders:${updated.id}:audit:status:${target}`,
    });
    return normalizeDbValue(withViewerUrl(linked));
  });
}

export async function recordRadioisotopeAdministration(orderId, input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  const gate = radiationPrivilegeGateConfig();
  await assertPrivilegeForGate({
    staffUid: context.actorUid,
    privilegeName: gate.key,
    tenantId,
    gate: 'radioisotope_administration',
    enabled: gate.enabled,
  });
  return setTenantTx(tenantId, async (tx) => {
    const order = await nuclearOrderById(tx, tenantId, orderId, { lock: true });
    if (!cleanText(order.radiopharmaceutical_ref) && !cleanText(order.isotope_ref) && !cleanText(input.radiopharmaceutical_ref || input.radiopharmaceuticalRef)) {
      throw AppError.badRequest(
        'Radioisotope administration requires an isotope / radiopharmaceutical reference',
        'NUCLEAR_MEDICINE_ISOTOPE_REF_REQUIRED',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO radioisotope_administration_records
         (tenant_id, order_id, patient_uid, encounter_id, radiopharmaceutical_ref,
          administered_activity_summary, administered_activity_mbq, route, administered_by,
          administered_at, safety_checklist, aerb_evidence_owner, aerb_source_name,
          aerb_source_version, aerb_evidence_attachment_ref, document_ref, document_storage_key,
          created_by, updated_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::uuid, $5,
               $6, $7::numeric, $8, $9::uuid,
               COALESCE($10::timestamptz, NOW()), $11::jsonb, $12, $13,
               $14, $15, $16, $17, $18::uuid, $18::uuid, $19::jsonb)
       RETURNING *`,
      tenantId,
      order.id,
      order.patient_uid,
      order.encounter_id,
      cleanText(input.radiopharmaceutical_ref || input.radiopharmaceuticalRef, 160) || order.radiopharmaceutical_ref,
      cleanText(input.administered_activity_summary || input.administeredActivitySummary, 200),
      optionalNumber(input.administered_activity_mbq || input.administeredActivityMbq, 'administered_activity_mbq'),
      cleanText(input.route, 80),
      // Sol Ultra LD-RRB-07: the administering clinician is the authenticated
      // actor, not a caller-supplied administered_by.
      maybeUuid(context.actorUid, 'administered_by'),
      optionalTimestamp(input.administered_at || input.administeredAt, 'administered_at'),
      JSON.stringify(normalizeJson(input.safety_checklist || input.safetyChecklist, 'safety_checklist', {})),
      cleanText(input.aerb_evidence_owner || input.aerbEvidenceOwner, 160),
      cleanText(input.aerb_source_name || input.aerbSourceName, 160),
      cleanText(input.aerb_source_version || input.aerbSourceVersion, 80),
      cleanText(input.aerb_evidence_attachment_ref || input.aerbEvidenceAttachmentRef),
      cleanText(input.document_ref || input.documentRef),
      cleanText(input.document_storage_key || input.documentStorageKey),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {})),
    );
    const administration = unwrap(rows);
    // Advance the order to 'administered' if it is prepared/scheduled.
    await tx.$queryRawUnsafe(
      `UPDATE nuclear_medicine_orders
          SET status = CASE WHEN status IN ('scheduled', 'prepared') THEN 'administered' ELSE status END,
              updated_by = $3::uuid, updated_at = NOW()
        WHERE id = $1::bigint AND tenant_id = $2::uuid`,
      order.id,
      tenantId,
      maybeUuid(context.actorUid, 'actorUid'),
    );
    const linked = await emitAndLink(tx, 'radioisotope_administration_records', administration, {
      tenantId,
      patientUid: administration.patient_uid,
      encounterId: administration.encounter_id,
      eventType: 'nuclear_medicine.radioisotope_administered',
      sourceTable: 'radioisotope_administration_records',
      sourceId: administration.id,
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      summary: 'Radioisotope administration recorded',
      payload: {
        order_id: order.id,
        radiopharmaceutical_ref: administration.radiopharmaceutical_ref,
        route: administration.route,
        privilege_gate: { key: gate.key, enforced: gate.enabled },
      },
      afterState: administration,
      timelineIdempotencyKey: `radioisotope_administration_records:${administration.id}:administered`,
      auditIdempotencyKey: `radioisotope_administration_records:${administration.id}:audit:administered`,
    });
    return normalizeDbValue(linked);
  });
}

// ── radiation safety evidence (register/audit ONLY — never patient timeline) ─

export async function recordSafetyEvidence(input = {}, context = {}) {
  const tenantId = tenantOr(input.tenantId);
  await assertCoordinationEnabled(tenantId);
  const evidenceType = input.evidence_type ? normalizeEnum(input.evidence_type || input.evidenceType, EVIDENCE_TYPES, 'evidence_type') : 'equipment_qa';
  const status = input.status ? normalizeEnum(input.status, EVIDENCE_STATUSES, 'status') : 'pending';
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO radiation_safety_evidence
         (tenant_id, evidence_type, title, equipment_ref, evidence_owner, source_name, source_version,
          attachment_ref, equipment_qa_reference, reference_period_start, reference_period_end, status,
          related_referral_id, related_plan_ref_id, related_nuclear_order_id, recorded_by,
          created_by, updated_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7,
               $8, $9, $10::date, $11::date, $12,
               $13::bigint, $14::bigint, $15::bigint, $16::uuid, $16::uuid, $16::uuid, $17::jsonb)
       RETURNING *`,
      tenantId,
      evidenceType,
      cleanText(input.title, 200),
      cleanText(input.equipment_ref || input.equipmentRef, 160),
      cleanText(input.evidence_owner || input.evidenceOwner, 160),
      cleanText(input.source_name || input.sourceName, 160),
      cleanText(input.source_version || input.sourceVersion, 80),
      cleanText(input.attachment_ref || input.attachmentRef),
      cleanText(input.equipment_qa_reference || input.equipmentQaReference),
      optionalDate(input.reference_period_start || input.referencePeriodStart, 'reference_period_start'),
      optionalDate(input.reference_period_end || input.referencePeriodEnd, 'reference_period_end'),
      status,
      maybeId(input.related_referral_id || input.relatedReferralId, 'related_referral_id'),
      maybeId(input.related_plan_ref_id || input.relatedPlanRefId, 'related_plan_ref_id'),
      maybeId(input.related_nuclear_order_id || input.relatedNuclearOrderId, 'related_nuclear_order_id'),
      maybeUuid(context.actorUid, 'actorUid'),
      JSON.stringify(normalizeJson(input.metadata, 'metadata', {})),
    );
    const evidence = unwrap(rows);
    // Register/audit trail ONLY — equipment/QA is NOT a patient timeline event.
    const audit = await recordClinicalAuditEvent({
      tenantId,
      action: 'radiation_safety.evidence_recorded',
      actorUid: context.actorUid,
      actorRole: context.actorRole,
      resourceType: 'radiation_safety_evidence',
      resourceTable: 'radiation_safety_evidence',
      resourceId: evidence.id,
      metadata: { evidence_type: evidenceType, status, equipment_ref: evidence.equipment_ref },
      idempotencyKey: `radiation_safety_evidence:${evidence.id}:audit:recorded`,
    }, { db: tx });
    if (audit?.id) {
      await tx.$queryRawUnsafe(
        `UPDATE radiation_safety_evidence
            SET clinical_audit_event_id = $3::uuid, updated_at = NOW()
          WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        evidence.id,
        tenantId,
        audit.id,
      );
      evidence.clinical_audit_event_id = audit.id;
    }
    return normalizeDbValue(evidence);
  });
}

export async function listSafetyEvidence({ tenantId, evidenceType = null, status = null, limit = 100 } = {}) {
  return setTenant(tenantOr(tenantId), (tx) => {
    const params = [tenantOr(tenantId)];
    const where = ['e.tenant_id = $1::uuid'];
    let idx = 2;
    if (evidenceType) {
      where.push(`e.evidence_type = $${idx++}`);
      params.push(normalizeEnum(evidenceType, EVIDENCE_TYPES, 'evidence_type'));
    }
    if (status) {
      where.push(`e.status = $${idx++}`);
      params.push(normalizeEnum(status, EVIDENCE_STATUSES, 'status'));
    }
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
    params.push(safeLimit);
    return tx.$queryRawUnsafe(
      `SELECT e.* FROM radiation_safety_evidence e
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${idx}::int`,
      ...params,
    ).then(normalizeRows);
  });
}

export const __testing__ = { normalizeDbValue, withViewerUrl };

export default {
  getRadiationCoordinationSettings,
  isRadiationCoordinationEnabled,
  setRadiationCoordinationSettings,
  createReferral,
  listReferrals,
  getReferralDetail,
  transitionReferralStatus,
  createPlanRef,
  transitionPlanStatus,
  scheduleFraction,
  transitionFractionStatus,
  createNuclearOrder,
  transitionNuclearOrderStatus,
  recordRadioisotopeAdministration,
  recordSafetyEvidence,
  listSafetyEvidence,
};
