import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { assertPrivilegeForGate, isGateEnabled } from '../staff/credentialingService.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SIGNOFF_PRIVILEGE_KEY = 'ctvs_perfusionist_signoff_owner_supplied';

const OVERLAY_RETURNING = `id, tenant_id, ot_schedule_id, patient_uid, anesthesia_record_id,
  procedure_category, bypass_expected, blood_product_readiness, implant_device_readiness,
  evidence_owner_uid, policy_source_label, policy_source_version, source_document_refs,
  attachment_refs, metadata, created_by, updated_by, created_at, updated_at`;

const RECORD_RETURNING = `id, tenant_id, ctvs_case_overlay_id, ot_schedule_id, patient_uid,
  anesthesia_record_id, perfusionist_uid, bypass_started_at, bypass_ended_at,
  bypass_time_minutes, cross_clamp_started_at, cross_clamp_ended_at,
  cross_clamp_time_minutes, act_baseline_seconds, act_peak_seconds, act_last_seconds,
  temperature_min_c, temperature_max_c, act_summary, temperature_summary,
  fluids_products_summary, complications, status, evidence_owner_uid,
  record_policy_source_label, record_policy_source_version, source_document_refs,
  attachment_refs, metadata, recorded_by, created_at, updated_at`;

const SIGNOFF_RETURNING = `id, tenant_id, perfusion_record_id, ot_schedule_id, patient_uid,
  perfusionist_signed_by, perfusionist_signed_at, surgeon_reviewed_by, surgeon_reviewed_at,
  anesthesia_reviewed_by, anesthesia_reviewed_at, status, finalized_by, finalized_at,
  evidence_owner_uid, signoff_policy_source_label, signoff_policy_source_version,
  source_document_refs, attachment_refs, metadata, created_at, updated_at`;

const DEVICE_LINK_RETURNING = `id, tenant_id, perfusion_record_id, device_patient_association_id,
  patient_uid, vendor_document_ref, vendor_source_label, vendor_source_version,
  summary_import_status, imported_summary, attachment_refs, metadata, created_by,
  created_at, updated_at`;

function tenantOr(value) {
  return requireTenantId(value);
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw AppError.badRequest(`${label} must be a positive integer`);
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

function cleanText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function requiredText(value, label, max = 255) {
  const text = cleanText(value, max);
  if (!text) throw AppError.badRequest(`${label} is required`);
  return text;
}

function normalizeBoolean(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw AppError.badRequest(`${label} must be a JSON object`);
  return value;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be a JSON array`);
  return value;
}

function normalizeNumeric(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be a number`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return Number(parsed.toFixed(2));
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), MAX_LIMIT);
}

function minutesBetween(start, end) {
  if (!start || !end) return null;
  return Number(((new Date(end).getTime() - new Date(start).getTime()) / 60000).toFixed(2));
}

function toWire(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toWire(entry)]));
  }
  return value;
}

function validatePerfusionTimes(times) {
  const bypassStart = normalizeTimestamp(times.bypassStartedAt, 'bypass_started_at');
  const bypassEnd = normalizeTimestamp(times.bypassEndedAt, 'bypass_ended_at');
  const clampStart = normalizeTimestamp(times.crossClampStartedAt, 'cross_clamp_started_at');
  const clampEnd = normalizeTimestamp(times.crossClampEndedAt, 'cross_clamp_ended_at');

  if (bypassEnd && !bypassStart) throw AppError.badRequest('bypass_started_at is required when bypass_ended_at is set');
  if (clampEnd && !clampStart) throw AppError.badRequest('cross_clamp_started_at is required when cross_clamp_ended_at is set');
  if (bypassStart && bypassEnd && new Date(bypassEnd) < new Date(bypassStart)) {
    throw AppError.badRequest('bypass_ended_at must be after bypass_started_at');
  }
  if (clampStart && clampEnd && new Date(clampEnd) < new Date(clampStart)) {
    throw AppError.badRequest('cross_clamp_ended_at must be after cross_clamp_started_at');
  }
  if (bypassStart && clampStart && new Date(clampStart) < new Date(bypassStart)) {
    throw AppError.badRequest('cross_clamp_started_at must be during bypass time');
  }
  if (bypassEnd && clampEnd && new Date(clampEnd) > new Date(bypassEnd)) {
    throw AppError.badRequest('cross_clamp_ended_at must be during bypass time');
  }

  return {
    bypassStart,
    bypassEnd,
    bypassMinutes: minutesBetween(bypassStart, bypassEnd),
    clampStart,
    clampEnd,
    clampMinutes: minutesBetween(clampStart, clampEnd),
  };
}

async function resolveTheatreCase(tenantId, otScheduleId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT os.id, os.patient_uid, ar.id AS anesthesia_record_id
       FROM ot_schedules os
       LEFT JOIN anesthesia_records ar
         ON ar.ot_schedule_id = os.id
        AND ar.tenant_id = os.tenant_id
      WHERE os.id = $1
        AND os.tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(otScheduleId, 'ot_schedule_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Theatre case not found');
  if (!rows[0].patient_uid) throw AppError.badRequest('Theatre case is missing patient_uid');
  return rows[0];
}

async function resolveRecord(tenantId, perfusionRecordId, db = prisma) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, tenant_id, ot_schedule_id, patient_uid, anesthesia_record_id, perfusionist_uid, status
       FROM perfusion_records
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(perfusionRecordId, 'perfusion_record_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Perfusion record not found');
  return rows[0];
}

async function assertCanonical(events, label) {
  if (!events?.timeline || !events?.audit) {
    throw AppError.internal(`${label} canonical timeline/audit event could not be recorded`, 'CANONICAL_EVENT_REQUIRED');
  }
}

async function assertActiveDeviceAssociation({ tenantId, associationId, patientUid }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT dpa.id
       FROM device_patient_associations dpa
      WHERE dpa.id = $1
        AND dpa.tenant_id = $2::uuid
        AND dpa.patient_uid = $3::uuid
        AND dpa.ended_at IS NULL
      LIMIT 1`,
    normalizeId(associationId, 'device_patient_association_id'),
    tenantId,
    patientUid,
  );
  if (!rows[0]) {
    throw AppError.badRequest(
      'Perfusion device links require an active NL-7 device-patient association for the same patient',
      'ACTIVE_DEVICE_ASSOCIATION_REQUIRED',
    );
  }
}

function signoffStatus({ perfusionistSignedBy, surgeonReviewedBy, anesthesiaReviewedBy }) {
  if (perfusionistSignedBy && surgeonReviewedBy && anesthesiaReviewedBy) return 'ready_for_finalize';
  if (anesthesiaReviewedBy) return 'anesthesia_reviewed';
  if (surgeonReviewedBy) return 'surgeon_reviewed';
  if (perfusionistSignedBy) return 'perfusionist_signed';
  return 'draft';
}

export async function upsertCtvsCaseOverlay({
  tenantId = null,
  otScheduleId,
  procedureCategory,
  bypassExpected = false,
  bloodProductReadiness = {},
  implantDeviceReadiness = {},
  evidenceOwnerUid = null,
  policySourceLabel = null,
  policySourceVersion = null,
  sourceDocumentRefs = [],
  attachmentRefs = [],
  metadata = {},
  actorUid = null,
} = {}) {
  const tenant = tenantOr(tenantId);
  const schedule = await resolveTheatreCase(tenant, otScheduleId);
  const row = await setTenantTx(tenant, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO ctvs_case_overlays
         (tenant_id, ot_schedule_id, patient_uid, anesthesia_record_id, procedure_category,
          bypass_expected, blood_product_readiness, implant_device_readiness, evidence_owner_uid,
          policy_source_label, policy_source_version, source_document_refs, attachment_refs,
          metadata, created_by, updated_by)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid,
               $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::uuid, $15::uuid)
       ON CONFLICT (tenant_id, ot_schedule_id) DO UPDATE SET
          anesthesia_record_id = EXCLUDED.anesthesia_record_id,
          procedure_category = EXCLUDED.procedure_category,
          bypass_expected = EXCLUDED.bypass_expected,
          blood_product_readiness = EXCLUDED.blood_product_readiness,
          implant_device_readiness = EXCLUDED.implant_device_readiness,
          evidence_owner_uid = EXCLUDED.evidence_owner_uid,
          policy_source_label = EXCLUDED.policy_source_label,
          policy_source_version = EXCLUDED.policy_source_version,
          source_document_refs = EXCLUDED.source_document_refs,
          attachment_refs = EXCLUDED.attachment_refs,
          metadata = EXCLUDED.metadata,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
       RETURNING ${OVERLAY_RETURNING}`,
      tenant,
      schedule.id,
      schedule.patient_uid,
      schedule.anesthesia_record_id || null,
      requiredText(procedureCategory, 'procedure_category', 80),
      normalizeBoolean(bypassExpected),
      JSON.stringify(normalizeJsonObject(bloodProductReadiness, 'blood_product_readiness')),
      JSON.stringify(normalizeJsonObject(implantDeviceReadiness, 'implant_device_readiness')),
      maybeUuid(evidenceOwnerUid, 'evidence_owner_uid'),
      cleanText(policySourceLabel, 180),
      cleanText(policySourceVersion, 80),
      JSON.stringify(normalizeJsonArray(sourceDocumentRefs, 'source_document_refs')),
      JSON.stringify(normalizeJsonArray(attachmentRefs, 'attachment_refs')),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(actorUid, 'actor_uid'),
    );
    return rows[0];
  });
  return toWire(row);
}

export async function listCtvsCaseOverlays({ tenantId = null, otScheduleId = null, patientUid = null, limit = DEFAULT_LIMIT } = {}) {
  const tenant = tenantOr(tenantId);
  const params = [tenant];
  const filters = ['tenant_id = $1::uuid'];
  if (otScheduleId) {
    params.push(normalizeId(otScheduleId, 'ot_schedule_id'));
    filters.push(`ot_schedule_id = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${OVERLAY_RETURNING}
       FROM ctvs_case_overlays
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC
      LIMIT $${params.length + 1}`,
    ...params,
    safeLimit,
  );
  return { overlays: toWire(rows), count: rows.length };
}

export async function createPerfusionRecord({
  tenantId = null,
  otScheduleId,
  perfusionistUid = null,
  bypassStartedAt = null,
  bypassEndedAt = null,
  crossClampStartedAt = null,
  crossClampEndedAt = null,
  actBaselineSeconds = null,
  actPeakSeconds = null,
  actLastSeconds = null,
  temperatureMinC = null,
  temperatureMaxC = null,
  actSummary = {},
  temperatureSummary = {},
  fluidsProductsSummary = {},
  complications = null,
  status = 'recorded',
  evidenceOwnerUid = null,
  recordPolicySourceLabel = null,
  recordPolicySourceVersion = null,
  sourceDocumentRefs = [],
  attachmentRefs = [],
  metadata = {},
  actorUid = null,
  actorRole = null,
} = {}) {
  const tenant = tenantOr(tenantId);
  const schedule = await resolveTheatreCase(tenant, otScheduleId);
  const times = validatePerfusionTimes({ bypassStartedAt, bypassEndedAt, crossClampStartedAt, crossClampEndedAt });
  const row = await setTenantTx(tenant, async (tx) => {
    const overlayRows = await tx.$queryRawUnsafe(
      `SELECT id FROM ctvs_case_overlays WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 LIMIT 1`,
      tenant,
      schedule.id,
    );
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO perfusion_records
         (tenant_id, ctvs_case_overlay_id, ot_schedule_id, patient_uid, anesthesia_record_id,
          perfusionist_uid, bypass_started_at, bypass_ended_at, bypass_time_minutes,
          cross_clamp_started_at, cross_clamp_ended_at, cross_clamp_time_minutes,
          act_baseline_seconds, act_peak_seconds, act_last_seconds, temperature_min_c,
          temperature_max_c, act_summary, temperature_summary, fluids_products_summary,
          complications, status, evidence_owner_uid, record_policy_source_label,
          record_policy_source_version, source_document_refs, attachment_refs, metadata, recorded_by)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid, $7::timestamptz, $8::timestamptz, $9,
               $10::timestamptz, $11::timestamptz, $12, $13, $14, $15, $16, $17,
               $18::jsonb, $19::jsonb, $20::jsonb, $21, $22, $23::uuid, $24, $25,
               $26::jsonb, $27::jsonb, $28::jsonb, $29::uuid)
       RETURNING ${RECORD_RETURNING}`,
      tenant,
      overlayRows[0]?.id || null,
      schedule.id,
      schedule.patient_uid,
      schedule.anesthesia_record_id || null,
      maybeUuid(perfusionistUid, 'perfusionist_uid'),
      times.bypassStart,
      times.bypassEnd,
      times.bypassMinutes,
      times.clampStart,
      times.clampEnd,
      times.clampMinutes,
      normalizeNumeric(actBaselineSeconds, 'act_baseline_seconds', { min: 0 }),
      normalizeNumeric(actPeakSeconds, 'act_peak_seconds', { min: 0 }),
      normalizeNumeric(actLastSeconds, 'act_last_seconds', { min: 0 }),
      normalizeNumeric(temperatureMinC, 'temperature_min_c', { min: 0, max: 45 }),
      normalizeNumeric(temperatureMaxC, 'temperature_max_c', { min: 0, max: 45 }),
      JSON.stringify(normalizeJsonObject(actSummary, 'act_summary')),
      JSON.stringify(normalizeJsonObject(temperatureSummary, 'temperature_summary')),
      JSON.stringify(normalizeJsonObject(fluidsProductsSummary, 'fluids_products_summary')),
      cleanText(complications),
      cleanText(status, 24) || 'recorded',
      maybeUuid(evidenceOwnerUid, 'evidence_owner_uid'),
      cleanText(recordPolicySourceLabel, 180),
      cleanText(recordPolicySourceVersion, 80),
      JSON.stringify(normalizeJsonArray(sourceDocumentRefs, 'source_document_refs')),
      JSON.stringify(normalizeJsonArray(attachmentRefs, 'attachment_refs')),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(actorUid || perfusionistUid, 'actor_uid'),
    );
    const record = rows[0];
    await assertCanonical(await recordCanonicalClinicalEvent({
      tenantId: tenant,
      patientUid: record.patient_uid,
      eventType: 'perfusion.recorded',
      eventStatus: record.status,
      sourceTable: 'perfusion_records',
      sourceId: record.id,
      resourceType: 'perfusion_record',
      resourceId: String(record.id),
      actorUid: actorUid || perfusionistUid || null,
      actorRole,
      summary: 'Perfusion record captured for theatre case',
      payload: {
        ot_schedule_id: record.ot_schedule_id,
        anesthesia_record_id: record.anesthesia_record_id,
        bypass_time_minutes: toWire(record.bypass_time_minutes),
        cross_clamp_time_minutes: toWire(record.cross_clamp_time_minutes),
        owner_sourced_policy: {
          label: record.record_policy_source_label,
          version: record.record_policy_source_version,
        },
      },
    }, { db: tx }), 'Perfusion record');
    return record;
  });
  return toWire(row);
}

export async function listPerfusionRecords({ tenantId = null, otScheduleId = null, patientUid = null, limit = DEFAULT_LIMIT } = {}) {
  const tenant = tenantOr(tenantId);
  const params = [tenant];
  const filters = ['tenant_id = $1::uuid'];
  if (otScheduleId) {
    params.push(normalizeId(otScheduleId, 'ot_schedule_id'));
    filters.push(`ot_schedule_id = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  const safeLimit = normalizeLimit(limit);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${RECORD_RETURNING}
       FROM perfusion_records
      WHERE ${filters.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1}`,
    ...params,
    safeLimit,
  );
  return { records: toWire(rows), count: rows.length };
}

export async function upsertPerfusionSignoff({
  tenantId = null,
  perfusionRecordId,
  perfusionistSignedBy = null,
  perfusionistSignedAt = null,
  surgeonReviewedBy = null,
  surgeonReviewedAt = null,
  anesthesiaReviewedBy = null,
  anesthesiaReviewedAt = null,
  evidenceOwnerUid = null,
  signoffPolicySourceLabel = null,
  signoffPolicySourceVersion = null,
  sourceDocumentRefs = [],
  attachmentRefs = [],
  metadata = {},
} = {}) {
  const tenant = tenantOr(tenantId);
  const record = await resolveRecord(tenant, perfusionRecordId);
  const perfusionist = maybeUuid(perfusionistSignedBy || record.perfusionist_uid, 'perfusionist_signed_by');
  if (perfusionist) {
    await assertPrivilegeForGate({
      staffUid: perfusionist,
      privilegeName: SIGNOFF_PRIVILEGE_KEY,
      tenantId: tenant,
      gate: 'ctvs_perfusionist_signoff',
      enabled: isGateEnabled('CTVS_ENFORCE_PERFUSIONIST_SIGNOFF_PRIVILEGE'),
    });
  }
  const surgeon = maybeUuid(surgeonReviewedBy, 'surgeon_reviewed_by');
  const anesthesia = maybeUuid(anesthesiaReviewedBy, 'anesthesia_reviewed_by');
  const status = signoffStatus({
    perfusionistSignedBy: perfusionist,
    surgeonReviewedBy: surgeon,
    anesthesiaReviewedBy: anesthesia,
  });
  const row = await setTenantTx(tenant, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO perfusion_signoffs
         (tenant_id, perfusion_record_id, ot_schedule_id, patient_uid, perfusionist_signed_by,
          perfusionist_signed_at, surgeon_reviewed_by, surgeon_reviewed_at, anesthesia_reviewed_by,
          anesthesia_reviewed_at, status, evidence_owner_uid, signoff_policy_source_label,
          signoff_policy_source_version, source_document_refs, attachment_refs, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, COALESCE($6::timestamptz, CASE WHEN $5::uuid IS NULL THEN NULL ELSE NOW() END),
               $7::uuid, COALESCE($8::timestamptz, CASE WHEN $7::uuid IS NULL THEN NULL ELSE NOW() END),
               $9::uuid, COALESCE($10::timestamptz, CASE WHEN $9::uuid IS NULL THEN NULL ELSE NOW() END),
               $11, $12::uuid, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb)
       ON CONFLICT (tenant_id, perfusion_record_id) DO UPDATE SET
          perfusionist_signed_by = COALESCE(EXCLUDED.perfusionist_signed_by, perfusion_signoffs.perfusionist_signed_by),
          perfusionist_signed_at = COALESCE(EXCLUDED.perfusionist_signed_at, perfusion_signoffs.perfusionist_signed_at),
          surgeon_reviewed_by = COALESCE(EXCLUDED.surgeon_reviewed_by, perfusion_signoffs.surgeon_reviewed_by),
          surgeon_reviewed_at = COALESCE(EXCLUDED.surgeon_reviewed_at, perfusion_signoffs.surgeon_reviewed_at),
          anesthesia_reviewed_by = COALESCE(EXCLUDED.anesthesia_reviewed_by, perfusion_signoffs.anesthesia_reviewed_by),
          anesthesia_reviewed_at = COALESCE(EXCLUDED.anesthesia_reviewed_at, perfusion_signoffs.anesthesia_reviewed_at),
          status = CASE
            WHEN perfusion_signoffs.finalized_at IS NOT NULL THEN 'finalized'
            WHEN COALESCE(EXCLUDED.perfusionist_signed_by, perfusion_signoffs.perfusionist_signed_by) IS NOT NULL
             AND COALESCE(EXCLUDED.surgeon_reviewed_by, perfusion_signoffs.surgeon_reviewed_by) IS NOT NULL
             AND COALESCE(EXCLUDED.anesthesia_reviewed_by, perfusion_signoffs.anesthesia_reviewed_by) IS NOT NULL
            THEN 'ready_for_finalize'
            ELSE EXCLUDED.status
          END,
          evidence_owner_uid = COALESCE(EXCLUDED.evidence_owner_uid, perfusion_signoffs.evidence_owner_uid),
          signoff_policy_source_label = COALESCE(EXCLUDED.signoff_policy_source_label, perfusion_signoffs.signoff_policy_source_label),
          signoff_policy_source_version = COALESCE(EXCLUDED.signoff_policy_source_version, perfusion_signoffs.signoff_policy_source_version),
          source_document_refs = CASE WHEN EXCLUDED.source_document_refs <> '[]'::jsonb THEN EXCLUDED.source_document_refs ELSE perfusion_signoffs.source_document_refs END,
          attachment_refs = CASE WHEN EXCLUDED.attachment_refs <> '[]'::jsonb THEN EXCLUDED.attachment_refs ELSE perfusion_signoffs.attachment_refs END,
          metadata = perfusion_signoffs.metadata || EXCLUDED.metadata,
          updated_at = NOW()
       RETURNING ${SIGNOFF_RETURNING}`,
      tenant,
      record.id,
      record.ot_schedule_id,
      record.patient_uid,
      perfusionist,
      normalizeTimestamp(perfusionistSignedAt, 'perfusionist_signed_at'),
      surgeon,
      normalizeTimestamp(surgeonReviewedAt, 'surgeon_reviewed_at'),
      anesthesia,
      normalizeTimestamp(anesthesiaReviewedAt, 'anesthesia_reviewed_at'),
      status,
      maybeUuid(evidenceOwnerUid, 'evidence_owner_uid'),
      cleanText(signoffPolicySourceLabel, 180),
      cleanText(signoffPolicySourceVersion, 80),
      JSON.stringify(normalizeJsonArray(sourceDocumentRefs, 'source_document_refs')),
      JSON.stringify(normalizeJsonArray(attachmentRefs, 'attachment_refs')),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  });
  return toWire(row);
}

export async function finalizePerfusionSignoff({
  tenantId = null,
  id,
  finalizedBy,
  actorRole = null,
} = {}) {
  const tenant = tenantOr(tenantId);
  const signoffId = normalizeId(id, 'signoff_id');
  const actor = maybeUuid(finalizedBy, 'finalized_by');
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT ${SIGNOFF_RETURNING}
       FROM perfusion_signoffs
      WHERE id = $1
        AND tenant_id = $2::uuid
      LIMIT 1`,
    signoffId,
    tenant,
  );
  const existing = existingRows[0];
  if (!existing) throw AppError.notFound('Perfusion sign-off not found');
  if (!existing.perfusionist_signed_by || !existing.surgeon_reviewed_by || !existing.anesthesia_reviewed_by) {
    throw AppError.badRequest('Perfusionist sign-off, surgeon review, and anesthesia review are required before finalize', 'PERFUSION_SIGNOFF_REVIEWS_REQUIRED');
  }
  await assertPrivilegeForGate({
    staffUid: existing.perfusionist_signed_by,
    privilegeName: SIGNOFF_PRIVILEGE_KEY,
    tenantId: tenant,
    gate: 'ctvs_perfusionist_signoff',
    enabled: isGateEnabled('CTVS_ENFORCE_PERFUSIONIST_SIGNOFF_PRIVILEGE'),
  });
  const row = await setTenantTx(tenant, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE perfusion_signoffs
          SET status = 'finalized',
              finalized_by = COALESCE(finalized_by, $1::uuid),
              finalized_at = COALESCE(finalized_at, NOW()),
              updated_at = NOW()
        WHERE id = $2
          AND tenant_id = $3::uuid
        RETURNING ${SIGNOFF_RETURNING}`,
      actor,
      signoffId,
      tenant,
    );
    const signoff = rows[0];
    await assertCanonical(await recordCanonicalClinicalEvent({
      tenantId: tenant,
      patientUid: signoff.patient_uid,
      eventType: 'perfusion.signoff_finalized',
      eventStatus: 'finalized',
      sourceTable: 'perfusion_signoffs',
      sourceId: signoff.id,
      resourceType: 'perfusion_signoff',
      resourceId: String(signoff.id),
      actorUid: actor,
      actorRole,
      summary: 'Perfusion record sign-off finalized',
      payload: {
        perfusion_record_id: signoff.perfusion_record_id,
        ot_schedule_id: signoff.ot_schedule_id,
        perfusionist_signed_by: signoff.perfusionist_signed_by,
        surgeon_reviewed_by: signoff.surgeon_reviewed_by,
        anesthesia_reviewed_by: signoff.anesthesia_reviewed_by,
        owner_sourced_policy: {
          label: signoff.signoff_policy_source_label,
          version: signoff.signoff_policy_source_version,
        },
      },
    }, { db: tx }), 'Perfusion sign-off');
    return signoff;
  });
  return toWire(row);
}

export async function createPerfusionDeviceLink({
  tenantId = null,
  perfusionRecordId,
  devicePatientAssociationId,
  vendorDocumentRef = null,
  vendorSourceLabel = null,
  vendorSourceVersion = null,
  summaryImportStatus = 'pending',
  importedSummary = {},
  attachmentRefs = [],
  metadata = {},
  actorUid = null,
} = {}) {
  const tenant = tenantOr(tenantId);
  const record = await resolveRecord(tenant, perfusionRecordId);
  await assertActiveDeviceAssociation({
    tenantId: tenant,
    associationId: devicePatientAssociationId,
    patientUid: record.patient_uid,
  });
  const row = await setTenantTx(tenant, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO perfusion_device_links
         (tenant_id, perfusion_record_id, device_patient_association_id, patient_uid,
          vendor_document_ref, vendor_source_label, vendor_source_version, summary_import_status,
          imported_summary, attachment_refs, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::uuid)
       RETURNING ${DEVICE_LINK_RETURNING}`,
      tenant,
      record.id,
      normalizeId(devicePatientAssociationId, 'device_patient_association_id'),
      record.patient_uid,
      cleanText(vendorDocumentRef),
      cleanText(vendorSourceLabel, 180),
      cleanText(vendorSourceVersion, 80),
      cleanText(summaryImportStatus, 32) || 'pending',
      JSON.stringify(normalizeJsonObject(importedSummary, 'imported_summary')),
      JSON.stringify(normalizeJsonArray(attachmentRefs, 'attachment_refs')),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(actorUid, 'actor_uid'),
    );
    return rows[0];
  });
  return toWire(row);
}

export async function listPerfusionDeviceLinks({ tenantId = null, perfusionRecordId, limit = DEFAULT_LIMIT } = {}) {
  const tenant = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${DEVICE_LINK_RETURNING}
       FROM perfusion_device_links
      WHERE tenant_id = $1::uuid
        AND perfusion_record_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    tenant,
    normalizeId(perfusionRecordId, 'perfusion_record_id'),
    normalizeLimit(limit),
  );
  return { links: toWire(rows), count: rows.length };
}

export default {
  upsertCtvsCaseOverlay,
  listCtvsCaseOverlays,
  createPerfusionRecord,
  listPerfusionRecords,
  upsertPerfusionSignoff,
  finalizePerfusionSignoff,
  createPerfusionDeviceLink,
  listPerfusionDeviceLinks,
};
