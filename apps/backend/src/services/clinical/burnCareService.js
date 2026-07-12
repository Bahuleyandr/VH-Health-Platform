import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const PROTOCOL_UNAVAILABLE_MESSAGE = 'protocol unavailable';
export const PROTOCOL_UNAVAILABLE_CODE = 'BURN_PROTOCOL_UNAVAILABLE';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const BURN_CHART_RETURNING = `id, tenant_id, patient_uid, emergency_visit_id,
  admission_id, mlc_record_id, encounter_id, mechanism, injury_at,
  presentation_at, first_aid, inhalation_risk, circumferential_burns,
  comorbid_risks, wound_summary, status, recorded_by, recorded_at,
  reviewed_by, reviewed_at, governance_owner_uid, governance_owner_role,
  reviewer_signoff_uid, reviewer_signoff_at, metadata, created_at, updated_at`;

const protocolUnavailable = () =>
  AppError.badRequest(PROTOCOL_UNAVAILABLE_MESSAGE, PROTOCOL_UNAVAILABLE_CODE);

function tid(value) {
  return requireTenantId(value);
}

function text(value, max = TEXT_MAX) {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  if (!out) return null;
  return out.slice(0, max);
}

function uuid(value, label, { required = false } = {}) {
  const out = text(value, 80);
  if (!out) {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  if (!UUID_RE.test(out)) throw AppError.badRequest(`${label} must be a UUID`);
  return out;
}

function intId(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function intValue(value, label, { min = null, max = null, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function decimal(value, label, { min = null, max = null, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const raw = String(value).trim().toLowerCase();
  if (['true', 'yes', 'y'].includes(raw)) return true;
  if (['false', 'no', 'n'].includes(raw)) return false;
  return Boolean(value);
}

function timestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function jsonObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function jsonArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`);
  return value;
}

function stringArray(value, label) {
  return jsonArray(value, label)
    .map((item) => text(item, 120))
    .filter(Boolean);
}

function enumValue(value, allowed, label, { required = false } = {}) {
  const out = text(value, SHORT_MAX);
  if (!out) {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  if (!allowed.includes(out)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return out;
}

function asJson(value) {
  return JSON.stringify(normalizeDbValue(value ?? {}));
}

function normalizeDbValue(value) {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
    return value.toNumber();
  }
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeDbValue(v)]));
  }
  return value;
}

function one(rows, message = 'Record not found') {
  if (!rows.length) throw AppError.notFound(message);
  return rows[0];
}

function actor(input = {}) {
  return {
    actorUid: uuid(input.actorUid || input.actor_uid || input.recordedBy || input.recorded_by, 'actor_uid'),
    actorRole: text(input.actorRole || input.actor_role, 80),
    requestId: text(input.requestId || input.request_id, 120),
    ipAddress: text(input.ipAddress || input.ip_address, 80),
    userAgent: text(input.userAgent || input.user_agent, 512),
  };
}

async function getChart(tx, tenantId, burnChartId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${BURN_CHART_RETURNING}
       FROM burn_charts
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    intId(burnChartId, 'burn_chart_id', { required: true }),
  );
  return one(rows, 'Burn chart not found');
}

async function assertPatientInTenant(tx, tenantId, patientUid) {
  const uid = uuid(patientUid, 'patient_uid', { required: true });
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    uid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
  return uid;
}

async function loadEmergencyVisit(tx, tenantId, emergencyVisitId) {
  if (!emergencyVisitId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id
       FROM emergency_visits
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    emergencyVisitId,
  );
  return one(rows, 'Emergency visit not found');
}

async function loadAdmission(tx, tenantId, admissionId) {
  if (!admissionId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id
       FROM admissions
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    admissionId,
  );
  return one(rows, 'Admission not found');
}

async function loadMlcRecord(tx, tenantId, mlcRecordId) {
  if (!mlcRecordId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, emergency_visit_id, patient_uid, mlc_kind, mlc_number
       FROM mlc_records
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantId,
    mlcRecordId,
  );
  const mlc = one(rows, 'MLC record not found');
  if (mlc.mlc_kind !== 'burn') {
    throw AppError.badRequest('MLC record must be burn kind', 'BURN_MLC_KIND_REQUIRED');
  }
  return mlc;
}

function reconcilePatient(contexts, explicitPatientUid) {
  const candidates = [
    explicitPatientUid,
    ...contexts.map((item) => item?.patient_uid).filter(Boolean),
  ].filter(Boolean);
  const unique = [...new Set(candidates.map(String))];
  if (unique.length > 1) {
    throw AppError.badRequest('Linked burn contexts must belong to the same patient', 'BURN_CONTEXT_PATIENT_MISMATCH');
  }
  if (!unique.length) throw AppError.badRequest('patient_uid is required');
  return unique[0];
}

function reconcileEncounter(contexts) {
  return contexts.map((item) => item?.encounter_id).find(Boolean) || null;
}

async function emitClinicalEvent(tx, {
  tenantId,
  patientUid,
  encounterId,
  eventType,
  eventStatus = 'active',
  sourceTable,
  sourceId,
  resourceType,
  resourceId,
  summary,
  payload,
  tags = ['burn_care'],
  actorInfo,
}) {
  await recordCanonicalClinicalEvent({
    tenantId,
    patientUid,
    encounterId,
    eventType,
    eventStatus,
    sourceTable,
    sourceId: sourceId == null ? null : String(sourceId),
    resourceType,
    resourceId: resourceId == null ? null : String(resourceId),
    actorUid: actorInfo.actorUid,
    actorRole: actorInfo.actorRole,
    requestId: actorInfo.requestId,
    ipAddress: actorInfo.ipAddress,
    userAgent: actorInfo.userAgent,
    summary,
    payload: normalizeDbValue(payload),
    tags,
  }, { db: tx });
}

async function loadApprovedContent(tx, tenantId, contentOrderSetId) {
  const id = intId(contentOrderSetId, 'content_order_set_id', { required: true });
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, family_key, version, title, status, active
       FROM clinical_order_sets
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status = 'approved'
        AND active = true
      LIMIT 1`,
    tenantId,
    id,
  );
  if (!rows.length) throw protocolUnavailable();
  return rows[0];
}

async function loadTbsaReference(tx, tenantId, input = {}) {
  const referenceId = intId(input.referenceId || input.reference_id, 'reference_id');
  const referenceKey = text(input.referenceKey || input.reference_key, 120);
  let rows = [];
  if (referenceId) {
    rows = await tx.$queryRawUnsafe(
      `SELECT id, reference_key, title, version, age_template_key, status, active
         FROM burn_tbsa_references
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'approved'
          AND active = true
        LIMIT 1`,
      tenantId,
      referenceId,
    );
  } else if (referenceKey) {
    rows = await tx.$queryRawUnsafe(
      `SELECT id, reference_key, title, version, age_template_key, status, active
         FROM burn_tbsa_references
        WHERE tenant_id = $1::uuid
          AND reference_key = $2
          AND status = 'approved'
          AND active = true
        ORDER BY version DESC
        LIMIT 1`,
      tenantId,
      referenceKey,
    );
  }
  if (!rows.length) throw protocolUnavailable();
  return rows[0];
}

async function loadFluidReference(tx, tenantId, input = {}) {
  const referenceId = intId(input.protocolReferenceId || input.protocol_reference_id, 'protocol_reference_id');
  const referenceKey = text(input.referenceKey || input.reference_key, 120);
  let rows = [];
  if (referenceId) {
    rows = await tx.$queryRawUnsafe(
      `SELECT id, reference_key, title, version, content_order_set_id, status, active
         FROM burn_fluid_references
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'approved'
          AND active = true
        LIMIT 1`,
      tenantId,
      referenceId,
    );
  } else if (referenceKey) {
    rows = await tx.$queryRawUnsafe(
      `SELECT id, reference_key, title, version, content_order_set_id, status, active
         FROM burn_fluid_references
        WHERE tenant_id = $1::uuid
          AND reference_key = $2
          AND status = 'approved'
          AND active = true
        ORDER BY version DESC
        LIMIT 1`,
      tenantId,
      referenceKey,
    );
  }
  if (!rows.length) throw protocolUnavailable();
  return rows[0];
}

export function computeTbsaTotal(regions = []) {
  return Number(regions.reduce((sum, region) => {
    const chosen = region.clinician_override_percent ?? region.clinicianOverridePercent ?? region.area_percent;
    return sum + Number(chosen || 0);
  }, 0).toFixed(2));
}

export async function createBurnChart(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const emergencyVisitId = intId(input.emergencyVisitId || input.emergency_visit_id, 'emergency_visit_id');
  const admissionId = intId(input.admissionId || input.admission_id, 'admission_id');
  const mlcRecordId = intId(input.mlcRecordId || input.mlc_record_id, 'mlc_record_id');
  if (!emergencyVisitId && !admissionId && !mlcRecordId) {
    throw AppError.badRequest('A burn chart must link to an emergency visit, admission, or burn MLC record');
  }
  const mechanism = text(input.mechanism, 120);
  if (!mechanism) throw AppError.badRequest('mechanism is required');
  const actorInfo = actor(input);

  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    const mlc = await loadMlcRecord(tx, tenantId, mlcRecordId);
    const visit = await loadEmergencyVisit(tx, tenantId, emergencyVisitId || mlc?.emergency_visit_id);
    const admission = await loadAdmission(tx, tenantId, admissionId);
    const patientUid = reconcilePatient([mlc, visit, admission], uuid(input.patientUid || input.patient_uid, 'patient_uid'));
    await assertPatientInTenant(tx, tenantId, patientUid);
    const encounterId = uuid(input.encounterId || input.encounter_id, 'encounter_id')
      || reconcileEncounter([visit, admission]);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO burn_charts
         (tenant_id, patient_uid, emergency_visit_id, admission_id, mlc_record_id,
          encounter_id, mechanism, injury_at, presentation_at, first_aid,
          inhalation_risk, circumferential_burns, comorbid_risks, wound_summary,
          status, recorded_by, governance_owner_uid, governance_owner_role,
          reviewer_signoff_uid, reviewer_signoff_at, metadata)
       VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5::int,
          $6::uuid, $7, $8::timestamptz, $9::timestamptz, $10,
          $11, $12, $13::text[], $14::jsonb,
          $15, $16::uuid, $17::uuid, $18,
          $19::uuid, $20::timestamptz, $21::jsonb)
       RETURNING ${BURN_CHART_RETURNING}`,
      tenantId,
      patientUid,
      visit?.id || null,
      admission?.id || null,
      mlc?.id || null,
      encounterId,
      mechanism,
      timestamp(input.injuryAt || input.injury_at, 'injury_at'),
      timestamp(input.presentationAt || input.presentation_at, 'presentation_at'),
      text(input.firstAid || input.first_aid),
      bool(input.inhalationRisk ?? input.inhalation_risk, false),
      bool(input.circumferentialBurns ?? input.circumferential_burns, false),
      stringArray(input.comorbidRisks || input.comorbid_risks, 'comorbid_risks'),
      asJson(jsonArray(input.woundSummary || input.wound_summary, 'wound_summary')),
      // Sol Ultra LD-RRB-05: a chart is CREATED as a draft/active record — it
      // must not be born already 'reviewed'/'closed' with a caller-supplied
      // reviewer signoff attributed to another clinician. Terminal/review states
      // and the signoff are separate, actor-bound transitions.
      enumValue(input.status, ['draft', 'active'], 'status') || 'active',
      actorInfo.actorUid,
      uuid(input.governanceOwnerUid || input.governance_owner_uid, 'governance_owner_uid'),
      text(input.governanceOwnerRole || input.governance_owner_role, 80),
      null,
      null,
      asJson(jsonObject(input.metadata, 'metadata')),
    );
    const chart = rows[0];
    await emitClinicalEvent(tx, {
      tenantId,
      patientUid,
      encounterId,
      eventType: 'burn.chart.created',
      eventStatus: chart.status,
      sourceTable: 'burn_charts',
      sourceId: chart.id,
      resourceType: 'burn_chart',
      resourceId: chart.id,
      summary: `Burn chart opened: ${mechanism}`,
      payload: {
        emergency_visit_id: visit?.id || null,
        admission_id: admission?.id || null,
        mlc_record_id: mlc?.id || null,
        mechanism,
        inhalation_risk: chart.inhalation_risk,
        circumferential_burns: chart.circumferential_burns,
      },
      actorInfo,
    });
    return chart;
  }));
}

export async function getBurnChart(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  return normalizeDbValue(await setTenantTx(tenantId, async (tx) =>
    getChart(tx, tenantId, input.id || input.burnChartId || input.burn_chart_id), { readOnly: true }));
}

export async function listBurnCharts(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const patientUid = uuid(input.patientUid || input.patient_uid, 'patient_uid');
  const emergencyVisitId = intId(input.emergencyVisitId || input.emergency_visit_id, 'emergency_visit_id');
  const mlcRecordId = intId(input.mlcRecordId || input.mlc_record_id, 'mlc_record_id');
  const admissionId = intId(input.admissionId || input.admission_id, 'admission_id');
  const limit = Math.min(Number.parseInt(input.limit, 10) || 50, 200);
  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    const params = [tenantId];
    const where = ['tenant_id = $1::uuid'];
    let idx = 2;
    if (patientUid) {
      where.push(`patient_uid = $${idx++}::uuid`);
      params.push(patientUid);
    }
    if (emergencyVisitId) {
      where.push(`emergency_visit_id = $${idx++}::int`);
      params.push(emergencyVisitId);
    }
    if (mlcRecordId) {
      where.push(`mlc_record_id = $${idx++}::int`);
      params.push(mlcRecordId);
    }
    if (admissionId) {
      where.push(`admission_id = $${idx++}::int`);
      params.push(admissionId);
    }
    params.push(limit);
    return tx.$queryRawUnsafe(
      `SELECT ${BURN_CHART_RETURNING}
         FROM burn_charts
        WHERE ${where.join(' AND ')}
        ORDER BY recorded_at DESC
        LIMIT $${idx}::int`,
      ...params,
    );
  }, { readOnly: true }));
}

export async function recordTbsaRegions(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const burnChartId = intId(input.burnChartId || input.burn_chart_id || input.chartId, 'burn_chart_id', { required: true });
  const regions = jsonArray(input.regions, 'regions');
  if (!regions.length) throw AppError.badRequest('regions are required');
  const actorInfo = actor(input);

  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    const chart = await getChart(tx, tenantId, burnChartId);
    const reference = await loadTbsaReference(tx, tenantId, input);
    const inserted = [];
    for (const region of regions) {
      const areaPercent = decimal(region.areaPercent ?? region.area_percent, 'area_percent', {
        min: 0,
        max: 100,
        required: true,
      });
      const overridePercent = decimal(
        region.clinicianOverridePercent ?? region.clinician_override_percent,
        'clinician_override_percent',
        { min: 0, max: 100 },
      );
      const overrideReason = text(region.overrideReason || region.override_reason);
      if (overridePercent !== null && !overrideReason) {
        throw AppError.badRequest('override_reason is required when clinician_override_percent is supplied');
      }
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO burn_wound_regions
           (tenant_id, burn_chart_id, patient_uid, body_region_code, body_region_label,
            side, surface, depth, area_percent, reference_id, reference_key,
            reference_version, age_template_key, clinician_override_percent,
            override_reason, override_by, override_at, decision_support_payload,
            recorded_by, metadata)
         VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5,
            $6, $7, $8, $9::numeric, $10::bigint, $11,
            $12::int, $13, $14::numeric,
            $15, $16::uuid, CASE WHEN $14::numeric IS NULL THEN NULL ELSE NOW() END, $17::jsonb,
            $18::uuid, $19::jsonb)
         RETURNING *`,
        tenantId,
        burnChartId,
        chart.patient_uid,
        text(region.bodyRegionCode || region.body_region_code, 80) || 'unspecified',
        text(region.bodyRegionLabel || region.body_region_label, 160) || 'Unspecified',
        enumValue(region.side, ['left', 'right', 'midline', 'bilateral', 'not_applicable'], 'side'),
        text(region.surface, 40),
        enumValue(
          region.depth,
          ['superficial', 'partial_thickness', 'deep_partial', 'full_thickness', 'mixed', 'unknown'],
          'depth',
          { required: true },
        ),
        areaPercent,
        reference.id,
        reference.reference_key,
        reference.version,
        reference.age_template_key,
        overridePercent,
        overrideReason,
        actorInfo.actorUid,
        asJson({
          reference_id: reference.id,
          reference_key: reference.reference_key,
          reference_version: reference.version,
          age_template_key: reference.age_template_key,
          selected_percent: overridePercent ?? areaPercent,
        }),
        actorInfo.actorUid,
        asJson(jsonObject(region.metadata, 'region.metadata')),
      );
      inserted.push(rows[0]);
    }
    const total = computeTbsaTotal(inserted);
    await emitClinicalEvent(tx, {
      tenantId,
      patientUid: chart.patient_uid,
      encounterId: chart.encounter_id,
      eventType: 'burn.tbsa.recorded',
      eventStatus: 'recorded',
      sourceTable: 'burn_wound_regions',
      sourceId: inserted[0]?.id,
      resourceType: 'burn_chart',
      resourceId: chart.id,
      summary: `Burn TBSA recorded: ${total}%`,
      payload: {
        burn_chart_id: chart.id,
        tbsa_percent: total,
        region_count: inserted.length,
        reference_id: reference.id,
        reference_key: reference.reference_key,
        reference_version: reference.version,
      },
      actorInfo,
    });
    return { burn_chart_id: chart.id, tbsa_percent: total, regions: inserted };
  }));
}

export async function recordReassessment(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const burnChartId = intId(input.burnChartId || input.burn_chart_id || input.chartId, 'burn_chart_id', { required: true });
  const actorInfo = actor(input);

  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    const chart = await getChart(tx, tenantId, burnChartId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO burn_reassessments
         (tenant_id, burn_chart_id, patient_uid, reassessed_at, reassessed_by,
          wound_status, pain_score, infection_concern, perfusion_concern,
          procedure_notes, serial_assessment, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, COALESCE($4::timestamptz, NOW()), $5::uuid,
          $6, $7::int, $8, $9,
          $10, $11::jsonb, $12::jsonb)
       RETURNING *`,
      tenantId,
      burnChartId,
      chart.patient_uid,
      timestamp(input.reassessedAt || input.reassessed_at, 'reassessed_at'),
      uuid(input.reassessedBy || input.reassessed_by, 'reassessed_by') || actorInfo.actorUid,
      text(input.woundStatus || input.wound_status, 80),
      intValue(input.painScore ?? input.pain_score, 'pain_score', { min: 0, max: 10 }),
      bool(input.infectionConcern ?? input.infection_concern, false),
      bool(input.perfusionConcern ?? input.perfusion_concern, false),
      text(input.procedureNotes || input.procedure_notes),
      asJson(jsonObject(input.serialAssessment || input.serial_assessment, 'serial_assessment')),
      asJson(jsonObject(input.metadata, 'metadata')),
    );
    const reassessment = rows[0];
    const media = [];
    for (const item of jsonArray(input.media, 'media')) {
      const key = text(item.mediaStorageKey || item.media_storage_key);
      if (!key) throw AppError.badRequest('media_storage_key is required');
      const mediaRows = await tx.$queryRawUnsafe(
        `INSERT INTO burn_reassessment_media
           (tenant_id, reassessment_id, burn_chart_id, patient_uid,
            media_storage_key, media_sha256_hash, mime_type, file_size_bytes,
            captured_at, captured_by, consent_confirmed, media_kind, metadata)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4::uuid,
            $5, $6, $7, $8::bigint,
            $9::timestamptz, $10::uuid, $11, $12, $13::jsonb)
         RETURNING *`,
        tenantId,
        reassessment.id,
        burnChartId,
        chart.patient_uid,
        key,
        text(item.mediaSha256Hash || item.media_sha256_hash, 64),
        text(item.mimeType || item.mime_type, 120),
        intValue(item.fileSizeBytes ?? item.file_size_bytes, 'file_size_bytes', { min: 0 }),
        timestamp(item.capturedAt || item.captured_at, 'captured_at'),
        uuid(item.capturedBy || item.captured_by, 'captured_by') || actorInfo.actorUid,
        bool(item.consentConfirmed ?? item.consent_confirmed, false),
        enumValue(item.mediaKind || item.media_kind, ['photo', 'document', 'diagram'], 'media_kind') || 'photo',
        asJson(jsonObject(item.metadata, 'media.metadata')),
      );
      media.push(mediaRows[0]);
    }
    await emitClinicalEvent(tx, {
      tenantId,
      patientUid: chart.patient_uid,
      encounterId: chart.encounter_id,
      eventType: 'burn.reassessment.recorded',
      eventStatus: 'recorded',
      sourceTable: 'burn_reassessments',
      sourceId: reassessment.id,
      resourceType: 'burn_chart',
      resourceId: chart.id,
      summary: text(input.woundStatus || input.wound_status, 80) || 'Burn reassessment recorded',
      payload: {
        burn_chart_id: chart.id,
        reassessment_id: reassessment.id,
        media_count: media.length,
        infection_concern: reassessment.infection_concern,
        perfusion_concern: reassessment.perfusion_concern,
      },
      actorInfo,
    });
    return { ...reassessment, media };
  }));
}

export async function recordFluidWorksheet(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const burnChartId = intId(input.burnChartId || input.burn_chart_id || input.chartId, 'burn_chart_id', { required: true });
  const decisions = jsonObject(input.clinicianDecisions || input.clinician_decisions, 'clinician_decisions');
  if (!Object.keys(decisions).length) throw AppError.badRequest('clinician_decisions are required');
  const actorInfo = actor(input);

  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    const chart = await getChart(tx, tenantId, burnChartId);
    const reference = await loadFluidReference(tx, tenantId, input);
    const contentId = intId(input.contentOrderSetId || input.content_order_set_id, 'content_order_set_id')
      || reference.content_order_set_id;
    const content = await loadApprovedContent(tx, tenantId, contentId);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO burn_fluid_worksheets
         (tenant_id, burn_chart_id, patient_uid, weight_kg, tbsa_percent,
          protocol_reference_id, content_order_set_id, worksheet_inputs,
          clinician_decisions, decision_summary, protocol_unavailable,
          recorded_by, reviewed_by, reviewed_at, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4::numeric, $5::numeric,
          $6::bigint, $7::int, $8::jsonb,
          $9::jsonb, $10, false,
          $11::uuid, $12::uuid, $13::timestamptz, $14::jsonb)
       RETURNING *`,
      tenantId,
      burnChartId,
      chart.patient_uid,
      decimal(input.weightKg ?? input.weight_kg, 'weight_kg', { min: 0.01, max: 500 }),
      decimal(input.tbsaPercent ?? input.tbsa_percent, 'tbsa_percent', { min: 0, max: 100 }),
      reference.id,
      content.id,
      asJson(jsonObject(input.worksheetInputs || input.worksheet_inputs, 'worksheet_inputs')),
      asJson(decisions),
      text(input.decisionSummary || input.decision_summary),
      actorInfo.actorUid,
      uuid(input.reviewedBy || input.reviewed_by, 'reviewed_by'),
      timestamp(input.reviewedAt || input.reviewed_at, 'reviewed_at'),
      asJson(jsonObject(input.metadata, 'metadata')),
    );
    const worksheet = rows[0];
    await emitClinicalEvent(tx, {
      tenantId,
      patientUid: chart.patient_uid,
      encounterId: chart.encounter_id,
      eventType: 'burn.fluid_worksheet.recorded',
      eventStatus: 'recorded',
      sourceTable: 'burn_fluid_worksheets',
      sourceId: worksheet.id,
      resourceType: 'burn_chart',
      resourceId: chart.id,
      summary: 'Burn fluid worksheet recorded from approved content',
      payload: {
        burn_chart_id: chart.id,
        worksheet_id: worksheet.id,
        protocol_reference_id: reference.id,
        reference_key: reference.reference_key,
        reference_version: reference.version,
        content_order_set_id: content.id,
        family_key: content.family_key,
        content_version: content.version,
      },
      actorInfo,
    });
    return worksheet;
  }));
}

export async function linkProtocolContent(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const burnChartId = intId(input.burnChartId || input.burn_chart_id || input.chartId, 'burn_chart_id', { required: true });
  const protocolKind = enumValue(
    input.protocolKind || input.protocol_kind,
    ['fluid', 'analgesia', 'tetanus', 'wound_care', 'transfer', 'follow_up'],
    'protocol_kind',
    { required: true },
  );
  const actorInfo = actor(input);

  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    const chart = await getChart(tx, tenantId, burnChartId);
    const content = await loadApprovedContent(tx, tenantId, input.contentOrderSetId || input.content_order_set_id);
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO burn_protocol_content_links
         (tenant_id, burn_chart_id, patient_uid, protocol_kind, content_order_set_id,
          family_key, content_version, link_status, evidence_owner_uid,
          governance_owner_uid, reviewer_signoff_uid, reviewer_signoff_at,
          linked_by, metadata)
       VALUES ($1::uuid, $2::bigint, $3::uuid, $4, $5::int,
          $6, $7::int, 'available', $8::uuid,
          $9::uuid, $10::uuid, $11::timestamptz,
          $12::uuid, $13::jsonb)
       ON CONFLICT (tenant_id, burn_chart_id, protocol_kind) WHERE link_status = 'available'
       DO UPDATE SET
          content_order_set_id = EXCLUDED.content_order_set_id,
          family_key = EXCLUDED.family_key,
          content_version = EXCLUDED.content_version,
          evidence_owner_uid = EXCLUDED.evidence_owner_uid,
          governance_owner_uid = EXCLUDED.governance_owner_uid,
          reviewer_signoff_uid = EXCLUDED.reviewer_signoff_uid,
          reviewer_signoff_at = EXCLUDED.reviewer_signoff_at,
          linked_by = EXCLUDED.linked_by,
          linked_at = NOW(),
          metadata = burn_protocol_content_links.metadata || EXCLUDED.metadata,
          updated_at = NOW()
       RETURNING *`,
      tenantId,
      burnChartId,
      chart.patient_uid,
      protocolKind,
      content.id,
      content.family_key,
      content.version,
      uuid(input.evidenceOwnerUid || input.evidence_owner_uid, 'evidence_owner_uid'),
      uuid(input.governanceOwnerUid || input.governance_owner_uid, 'governance_owner_uid'),
      uuid(input.reviewerSignoffUid || input.reviewer_signoff_uid, 'reviewer_signoff_uid'),
      timestamp(input.reviewerSignoffAt || input.reviewer_signoff_at, 'reviewer_signoff_at'),
      actorInfo.actorUid,
      asJson(jsonObject(input.metadata, 'metadata')),
    );
    const link = rows[0];
    await emitClinicalEvent(tx, {
      tenantId,
      patientUid: chart.patient_uid,
      encounterId: chart.encounter_id,
      eventType: 'burn.protocol_content.linked',
      eventStatus: 'active',
      sourceTable: 'burn_protocol_content_links',
      sourceId: link.id,
      resourceType: 'burn_chart',
      resourceId: chart.id,
      summary: `Burn ${protocolKind.replace('_', ' ')} content linked`,
      payload: {
        burn_chart_id: chart.id,
        protocol_kind: protocolKind,
        content_order_set_id: content.id,
        family_key: content.family_key,
        content_version: content.version,
      },
      actorInfo,
    });
    return link;
  }));
}

export async function listProtocolContentLinks(input = {}) {
  const tenantId = tid(input.tenantId || input.tenant_id);
  const burnChartId = intId(input.burnChartId || input.burn_chart_id || input.chartId, 'burn_chart_id', { required: true });
  return normalizeDbValue(await setTenantTx(tenantId, async (tx) => {
    await getChart(tx, tenantId, burnChartId);
    return tx.$queryRawUnsafe(
      `SELECT *
         FROM burn_protocol_content_links
        WHERE tenant_id = $1::uuid
          AND burn_chart_id = $2::bigint
        ORDER BY protocol_kind, linked_at DESC`,
      tenantId,
      burnChartId,
    );
  }, { readOnly: true }));
}

export default {
  createBurnChart,
  getBurnChart,
  listBurnCharts,
  recordTbsaRegions,
  recordReassessment,
  recordFluidWorksheet,
  linkProtocolContent,
  listProtocolContentLinks,
};
