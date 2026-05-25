/**
 * ED operational entities service (Phase D4).
 *
 * Manages the four tables added in migration 126:
 *   - emergency_visits      (ED visit lifecycle)
 *   - triage_assessments    (ESI / Manchester / CTAS triage results)
 *   - ambulance_requests    (dispatch + en-route status)
 *   - mlc_records           (medico-legal case records)
 *
 * Decision-support only: nothing here auto-triages or auto-disposes.
 * AI triage predictions (clinical_ai_ed_triage_predictions) link in
 * via triage_assessments.ai_prediction_id; the human triage row is
 * always the authoritative one.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const ARRIVAL_MODES = [
  'walk_in', 'ambulance', 'air_ambulance', 'self_transport', 'transfer_in', 'police', 'other',
];
export const VISIT_STATUSES = [
  'arriving', 'in_triage', 'awaiting_treatment', 'in_treatment',
  'awaiting_disposition', 'admitted', 'discharged', 'transferred',
  'left_against_advice', 'lwbs', 'expired', 'archived',
];
export const TRIAGE_PRIORITIES = [
  'esi_1', 'esi_2', 'esi_3', 'esi_4', 'esi_5',
  'manchester_red', 'manchester_orange', 'manchester_yellow', 'manchester_green', 'manchester_blue',
  'ctas_1', 'ctas_2', 'ctas_3', 'ctas_4', 'ctas_5',
  // ATS (Australian Triage Scale): added 2026-05-13 so nurses who chart an
  // `assessment_kind: 'australian'` can set the corresponding visit
  // priority without falling back to a CTAS approximation. Finding:
  // 2026-05-09-emergency-walk-in-nurse-triage-priority-no-queue-effect.
  'ats_1', 'ats_2', 'ats_3', 'ats_4', 'ats_5',
  'unassigned',
];
export const DISPOSITIONS = [
  'discharged_home', 'admitted_ward', 'admitted_icu', 'admitted_hdu',
  'transferred_out', 'left_against_medical_advice', 'lwbs',
  'expired', 'observation', 'opd_followup', 'other',
];
export const TRIAGE_KINDS = ['esi', 'manchester', 'ctas', 'pat', 'australian', 'other'];
export const AMBULANCE_KINDS = ['pickup', 'transfer_out', 'inter_facility', 'home_to_hospital', 'air_evac', 'other'];
export const AMBULANCE_PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const AMBULANCE_STATUSES = [
  'requested', 'dispatched', 'en_route', 'on_scene',
  'returning', 'arrived', 'cancelled', 'completed', 'failed',
];
export const MLC_KINDS = [
  'rta', 'assault', 'sexual_assault', 'poisoning', 'self_harm', 'attempted_suicide',
  'burn', 'electric_shock', 'drowning', 'animal_bite', 'snake_bite',
  'industrial_accident', 'firearm_injury', 'sharp_weapon_injury',
  'unknown_unconscious', 'pregnancy_related', 'other',
];
export const MLC_STATUSES = ['open', 'pending_certification', 'certified', 'closed', 'cancelled'];

const VISIT_TRANSITIONS = {
  arriving: ['in_triage', 'awaiting_treatment', 'lwbs'],
  in_triage: ['awaiting_treatment', 'in_treatment', 'lwbs', 'left_against_advice'],
  awaiting_treatment: ['in_treatment', 'lwbs', 'left_against_advice'],
  in_treatment: ['awaiting_disposition', 'admitted', 'discharged', 'transferred', 'left_against_advice', 'expired'],
  awaiting_disposition: ['admitted', 'discharged', 'transferred', 'left_against_advice', 'expired'],
  admitted: ['archived'],
  discharged: ['archived'],
  transferred: ['archived'],
  left_against_advice: ['archived'],
  lwbs: ['archived'],
  expired: ['archived'],
  archived: [],
};

const AMBULANCE_TRANSITIONS = {
  requested: ['dispatched', 'cancelled', 'failed'],
  dispatched: ['en_route', 'cancelled', 'failed'],
  en_route: ['on_scene', 'cancelled', 'failed'],
  on_scene: ['returning', 'arrived', 'cancelled', 'failed'],
  returning: ['arrived', 'failed'],
  arrived: ['completed'],
  completed: [],
  cancelled: [],
  failed: [],
};

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
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

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
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
  return value.map((v) => safeText(v, 120)).filter(Boolean);
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

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeNumber(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function assessmentKindForPriority(priority) {
  const text = String(priority || '').toLowerCase();
  if (text.startsWith('ats_')) return 'australian';
  if (text.startsWith('esi_')) return 'esi';
  if (text.startsWith('ctas_')) return 'ctas';
  if (text.startsWith('manchester_')) return 'manchester';
  return 'other';
}

function levelLabelForPriority(priority, fallbackAcuity = null) {
  const text = String(priority || '').toLowerCase();
  const match = text.match(/^(ats|esi|ctas)[_-]?([1-5])$/);
  if (match) return `${match[1].toUpperCase()}-${match[2]}`;
  if (text.startsWith('manchester_')) return text.replace('_', '-');
  return fallbackAcuity != null ? `ESI-${fallbackAcuity}` : null;
}

// ---------------------------------------------------------------------------
// Emergency visits
// ---------------------------------------------------------------------------

const VISIT_RETURNING = `id, tenant_id, facility_id, visit_number, patient_uid,
  arrival_at, arrival_mode, ambulance_request_id, chief_complaint,
  attending_doctor_uid, triage_priority, status, bed_assigned_id,
  disposition, triage_started_at, treatment_started_at,
  disposition_at, departure_at, is_mlc, metadata,
  created_by, created_at, updated_at, encounter_id`;

export async function createEmergencyVisit({
  tenantId = null,
  facilityId = null,
  visitNumber,
  patientUid = null,
  arrivalAt = null,
  arrivalMode = 'walk_in',
  ambulanceRequestId = null,
  chiefComplaint = null,
  attendingDoctorUid = null,
  isMlc = false,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNumber = safeText(visitNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('visit_number is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO emergency_visits
         (tenant_id, facility_id, visit_number, patient_uid,
          arrival_at, arrival_mode, ambulance_request_id, chief_complaint,
          attending_doctor_uid, status, is_mlc, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4::uuid,
         COALESCE($5::timestamptz, NOW()), $6, $7, $8,
         $9::uuid, 'arriving', $10, $11::jsonb, $12::uuid)
       RETURNING ${VISIT_RETURNING}`,
      tid,
      facilityId ? normalizeId(facilityId, 'facility_id') : null,
      cleanNumber, maybeUuid(patientUid, 'patient_uid'),
      normalizeTimestamp(arrivalAt, 'arrival_at'),
      normalizeEnum(arrivalMode, ARRIVAL_MODES, 'arrival_mode') || 'walk_in',
      ambulanceRequestId ? normalizeId(ambulanceRequestId, 'ambulance_request_id') : null,
      safeText(chiefComplaint),
      maybeUuid(attendingDoctorUid, 'attending_doctor_uid'),
      normalizeBoolean(isMlc, false),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('visit_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function transitionEmergencyVisit({
  tenantId = null, id, nextStatus, disposition = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const visitId = normalizeId(id, 'emergency_visit id');
  const cleanStatus = normalizeEnum(nextStatus, VISIT_STATUSES, 'next_status', { required: true });

  const current = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM emergency_visits
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    visitId, tid,
  );
  if (!current[0]) throw AppError.notFound('Emergency visit not found');
  const allowed = VISIT_TRANSITIONS[current[0].status] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(current[0].status, cleanStatus, allowed);
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'in_triage') {
    params.push(new Date().toISOString());
    updates.push(`triage_started_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'in_treatment') {
    params.push(new Date().toISOString());
    updates.push(`treatment_started_at = $${params.length}::timestamptz`);
  }
  if (['admitted', 'discharged', 'transferred', 'left_against_advice', 'lwbs', 'expired'].includes(cleanStatus)) {
    params.push(new Date().toISOString());
    updates.push(`disposition_at = $${params.length}::timestamptz`);
    if (disposition) {
      params.push(normalizeEnum(disposition, DISPOSITIONS, 'disposition'));
      updates.push(`disposition = $${params.length}`);
    }
    if (cleanStatus !== 'admitted') {
      params.push(new Date().toISOString());
      updates.push(`departure_at = $${params.length}::timestamptz`);
    }
  }
  params.push(visitId);
  params.push(tid);

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE emergency_visits SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${VISIT_RETURNING}`,
    ...params,
  );
  return rows[0];
}

export async function setVisitTriagePriority({
  tenantId = null, id, triagePriority,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const visitId = normalizeId(id, 'emergency_visit id');
  const cleanPriority = normalizeEnum(triagePriority, TRIAGE_PRIORITIES, 'triage_priority', { required: true });
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE emergency_visits
     SET triage_priority = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid
     RETURNING ${VISIT_RETURNING}`,
    cleanPriority, visitId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Emergency visit not found');
  return rows[0];
}

export async function listEmergencyVisits({
  tenantId = null, status = null, openOnly = false,
  triagePriority = null, isMlc = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, VISIT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (openOnly) {
    filters.push(`status NOT IN ('discharged', 'transferred', 'left_against_advice', 'lwbs', 'expired', 'archived')`);
  }
  if (triagePriority) {
    params.push(normalizeEnum(triagePriority, TRIAGE_PRIORITIES, 'triage_priority'));
    filters.push(`triage_priority = $${params.length}`);
  }
  if (isMlc !== null) {
    params.push(normalizeBoolean(isMlc));
    filters.push(`is_mlc = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  // Order: untriaged arrivals (NULL triage_priority) FIRST so the
  // triage nurse sees them at the top of the queue and can assign an
  // ESI/CTAS/ATS level. Within the untriaged bucket, oldest-arrival
  // first — the patient who's been waiting longest needs triage most
  // urgently. Then triaged visits by clinical urgency (rank 1 =
  // ATS-1 / CTAS-1 / ESI-1 / Manchester-red) and arrival_at DESC so
  // a critical patient who walked in 10 minutes ago beats a CTAS-4
  // patient who arrived two minutes ago. Previously NULL priority
  // was pushed to the BOTTOM (rank 9) so with the default 50-row
  // limit a busy ED's untriaged arrivals were invisibly paginated
  // off — the triage nurse refreshed the screen and the patient who
  // walked in 30 seconds ago wasn't on it. Findings:
  //   2026-05-09-emergency-walk-in-nurse-triage-priority-no-queue-effect
  //   2026-05-22-emergency-walk-in-receptionist-ff98a21a (this fix).
  const PRIORITY_RANK_SQL = `CASE triage_priority
    WHEN 'esi_1' THEN 2 WHEN 'manchester_red' THEN 2 WHEN 'ctas_1' THEN 2 WHEN 'ats_1' THEN 2
    WHEN 'esi_2' THEN 3 WHEN 'manchester_orange' THEN 3 WHEN 'ctas_2' THEN 3 WHEN 'ats_2' THEN 3
    WHEN 'esi_3' THEN 4 WHEN 'manchester_yellow' THEN 4 WHEN 'ctas_3' THEN 4 WHEN 'ats_3' THEN 4
    WHEN 'esi_4' THEN 5 WHEN 'manchester_green' THEN 5 WHEN 'ctas_4' THEN 5 WHEN 'ats_4' THEN 5
    WHEN 'esi_5' THEN 6 WHEN 'manchester_blue' THEN 6 WHEN 'ctas_5' THEN 6 WHEN 'ats_5' THEN 6
    ELSE 9 END`;
  // Bucket 1 = NOT yet triaged (urgent to surface to the triage nurse);
  // bucket > 1 = already-triaged in clinical urgency order. The
  // `triage_priority IS NULL` check is a separate ORDER BY term so a
  // never-triaged visit doesn't get tucked under a freshly-arrived
  // ESI-1 simply because it has the same rank in the CASE.
  const UNTRIAGED_BUCKET_SQL = `CASE WHEN triage_priority IS NULL THEN 1 ELSE 2 END`;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${VISIT_RETURNING} FROM emergency_visits
       WHERE ${filters.join(' AND ')}
       ORDER BY ${UNTRIAGED_BUCKET_SQL} ASC,
                ${PRIORITY_RANK_SQL} ASC,
                CASE WHEN triage_priority IS NULL THEN arrival_at END ASC NULLS LAST,
                arrival_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { visits: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { visits: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Triage assessments
// ---------------------------------------------------------------------------

const TRIAGE_RETURNING = `id, tenant_id, emergency_visit_id, patient_uid,
  assessment_kind, assessed_at, assessed_by_uid, level,
  presenting_complaint, vitals, pain_score,
  airway_concern, breathing_concern, circulation_concern,
  red_flags, ai_predicted_level, ai_prediction_id,
  reassessment_due_at, metadata, created_at`;

export async function recordTriageAssessment({
  tenantId = null,
  emergencyVisitId = null,
  patientUid = null,
  assessmentKind = 'esi',
  assessedAt = null,
  assessedByUid = null,
  level,
  presentingComplaint = null,
  vitals = null,
  painScore = null,
  airwayConcern = false,
  breathingConcern = false,
  circulationConcern = false,
  redFlags = null,
  aiPredictedLevel = null,
  aiPredictionId = null,
  reassessmentDueAt = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanLevel = safeText(level, 40);
  if (!cleanLevel) throw AppError.badRequest('level is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO triage_assessments
         (tenant_id, emergency_visit_id, patient_uid, assessment_kind,
          assessed_at, assessed_by_uid, level,
          presenting_complaint, vitals, pain_score,
          airway_concern, breathing_concern, circulation_concern,
          red_flags, ai_predicted_level, ai_prediction_id,
          reassessment_due_at, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4,
         COALESCE($5::timestamptz, NOW()), $6::uuid, $7,
         $8, $9::jsonb, $10,
         $11, $12, $13,
         $14::text[], $15, $16, $17::timestamptz, $18::jsonb)
       RETURNING ${TRIAGE_RETURNING}`,
      tid,
      emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      normalizeEnum(assessmentKind, TRIAGE_KINDS, 'assessment_kind') || 'esi',
      normalizeTimestamp(assessedAt, 'assessed_at'),
      maybeUuid(assessedByUid, 'assessed_by_uid'),
      cleanLevel,
      safeText(presentingComplaint),
      JSON.stringify(normalizeJsonObject(vitals, 'vitals')),
      normalizeInt(painScore, 'pain_score', { min: 0, max: 10 }),
      normalizeBoolean(airwayConcern, false),
      normalizeBoolean(breathingConcern, false),
      normalizeBoolean(circulationConcern, false),
      normalizeStringArray(redFlags, 'red_flags'),
      safeText(aiPredictedLevel, 40),
      aiPredictionId ? normalizeId(aiPredictionId, 'ai_prediction_id') : null,
      normalizeTimestamp(reassessmentDueAt, 'reassessment_due_at'),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid emergency_visit_id');
    throw err;
  }
}

export async function listTriageAssessments({
  tenantId = null, emergencyVisitId = null, assessmentKind = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanAssessmentKind = assessmentKind
    ? normalizeEnum(assessmentKind, TRIAGE_KINDS, 'assessment_kind')
    : null;
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (emergencyVisitId) {
    params.push(normalizeId(emergencyVisitId, 'emergency_visit_id'));
    filters.push(`emergency_visit_id = $${params.length}`);
  }
  if (cleanAssessmentKind) {
    params.push(cleanAssessmentKind);
    filters.push(`assessment_kind = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TRIAGE_RETURNING} FROM triage_assessments
       WHERE ${filters.join(' AND ')}
       ORDER BY assessed_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    if (rows.length === 0 && emergencyVisitId) {
      const fallbackRows = await prisma.$queryRawUnsafe(
        `SELECT ev.id AS emergency_visit_id,
                ev.tenant_id,
                ev.patient_uid,
                ev.chief_complaint,
                ev.triage_priority,
                ev.triage_started_at,
                vc.id AS vitals_id,
                vc.triage_acuity,
                vc.recorded_at,
                vc.recorded_by,
                vc.heart_rate,
                vc.systolic_bp,
                vc.diastolic_bp,
                vc.temperature,
                vc.spo2,
                vc.respiratory_rate,
                vc.pain_score,
                vc.gcs_score
           FROM emergency_visits ev
      LEFT JOIN LATERAL (
             SELECT id, triage_acuity, recorded_at, recorded_by,
                    heart_rate, systolic_bp, diastolic_bp, temperature,
                    spo2, respiratory_rate, pain_score, gcs_score
               FROM vitals_chart
              WHERE patient_uid = ev.patient_uid
                AND triage_acuity IS NOT NULL
              ORDER BY recorded_at DESC
              LIMIT 1
           ) vc ON TRUE
          WHERE ev.id = $1
            AND ev.tenant_id = $2::uuid
          LIMIT 1`,
        normalizeId(emergencyVisitId, 'emergency_visit_id'),
        tid,
      );
      const fallback = fallbackRows[0] ?? null;
      const fallbackLevel = levelLabelForPriority(fallback?.triage_priority, fallback?.triage_acuity);
      const fallbackKind = assessmentKindForPriority(fallback?.triage_priority);
      if (fallback && fallbackLevel && (!cleanAssessmentKind || fallbackKind === cleanAssessmentKind)) {
        const synthesized = {
          id: null,
          tenant_id: fallback.tenant_id,
          emergency_visit_id: fallback.emergency_visit_id,
          patient_uid: fallback.patient_uid,
          assessment_kind: fallbackKind,
          assessed_at: fallback.recorded_at ?? fallback.triage_started_at,
          assessed_by_uid: fallback.recorded_by ?? null,
          level: fallbackLevel,
          presenting_complaint: fallback.chief_complaint ?? null,
          vitals: {
            heart_rate: fallback.heart_rate ?? null,
            systolic_bp: fallback.systolic_bp ?? null,
            diastolic_bp: fallback.diastolic_bp ?? null,
            temperature: fallback.temperature ?? null,
            spo2: fallback.spo2 ?? null,
            respiratory_rate: fallback.respiratory_rate ?? null,
            gcs_score: fallback.gcs_score ?? null,
          },
          pain_score: fallback.pain_score ?? null,
          airway_concern: false,
          breathing_concern: false,
          circulation_concern: false,
          red_flags: [],
          ai_predicted_level: null,
          ai_prediction_id: null,
          reassessment_due_at: null,
          metadata: {
            source: 'vitals_chart',
            vitals_id: fallback.vitals_id,
            triage_priority: fallback.triage_priority,
          },
          created_at: fallback.recorded_at ?? fallback.triage_started_at,
        };
        return { assessments: [synthesized], count: 1 };
      }
    }
    return { assessments: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { assessments: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Ambulance requests
// ---------------------------------------------------------------------------

const AMBULANCE_RETURNING = `id, tenant_id, facility_id, request_number, request_kind,
  priority, caller_name, caller_phone, patient_uid, patient_name,
  pickup_address, pickup_geo_lat, pickup_geo_lng,
  destination, destination_facility_id,
  ambulance_unit_id, driver_name, attendant_name, status,
  requested_at, dispatched_at, on_scene_at, arrived_at,
  cancelled_reason, presenting_complaint,
  metadata, created_by, created_at, updated_at`;

export async function createAmbulanceRequest({
  tenantId = null, facilityId = null,
  requestNumber, requestKind = 'pickup', priority = 'medium',
  callerName = null, callerPhone = null,
  patientUid = null, patientName = null,
  pickupAddress = null, pickupGeoLat = null, pickupGeoLng = null,
  destination = null, destinationFacilityId = null,
  presentingComplaint = null,
  metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNumber = safeText(requestNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('request_number is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO ambulance_requests
         (tenant_id, facility_id, request_number, request_kind, priority,
          caller_name, caller_phone, patient_uid, patient_name,
          pickup_address, pickup_geo_lat, pickup_geo_lng,
          destination, destination_facility_id,
          status, presenting_complaint, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5,
         $6, $7, $8::uuid, $9,
         $10, $11, $12,
         $13, $14, 'requested', $15, $16::jsonb, $17::uuid)
       RETURNING ${AMBULANCE_RETURNING}`,
      tid,
      facilityId ? normalizeId(facilityId, 'facility_id') : null,
      cleanNumber,
      normalizeEnum(requestKind, AMBULANCE_KINDS, 'request_kind') || 'pickup',
      normalizeEnum(priority, AMBULANCE_PRIORITIES, 'priority') || 'medium',
      safeText(callerName, SHORT_MAX), safeText(callerPhone, 40),
      maybeUuid(patientUid, 'patient_uid'), safeText(patientName, SHORT_MAX),
      safeText(pickupAddress),
      normalizeNumber(pickupGeoLat, 'pickup_geo_lat', { min: -90, max: 90 }),
      normalizeNumber(pickupGeoLng, 'pickup_geo_lng', { min: -180, max: 180 }),
      safeText(destination, SHORT_MAX),
      destinationFacilityId ? normalizeId(destinationFacilityId, 'destination_facility_id') : null,
      safeText(presentingComplaint),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('request_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid facility_id');
    throw err;
  }
}

export async function transitionAmbulanceRequest({
  tenantId = null, id, nextStatus, cancelledReason = null,
  ambulanceUnitId = null, driverName = null, attendantName = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const reqId = normalizeId(id, 'ambulance_request id');
  const cleanStatus = normalizeEnum(nextStatus, AMBULANCE_STATUSES, 'next_status', { required: true });

  const current = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM ambulance_requests
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    reqId, tid,
  );
  if (!current[0]) throw AppError.notFound('Ambulance request not found');
  const allowed = AMBULANCE_TRANSITIONS[current[0].status] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(current[0].status, cleanStatus, allowed);
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'dispatched') {
    params.push(new Date().toISOString());
    updates.push(`dispatched_at = $${params.length}::timestamptz`);
    if (ambulanceUnitId) {
      params.push(safeText(ambulanceUnitId, 80));
      updates.push(`ambulance_unit_id = $${params.length}`);
    }
    if (driverName) {
      params.push(safeText(driverName, SHORT_MAX));
      updates.push(`driver_name = $${params.length}`);
    }
    if (attendantName) {
      params.push(safeText(attendantName, SHORT_MAX));
      updates.push(`attendant_name = $${params.length}`);
    }
  }
  if (cleanStatus === 'on_scene') {
    params.push(new Date().toISOString());
    updates.push(`on_scene_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'arrived') {
    params.push(new Date().toISOString());
    updates.push(`arrived_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'cancelled' && cancelledReason) {
    params.push(safeText(cancelledReason));
    updates.push(`cancelled_reason = $${params.length}`);
  }
  params.push(reqId);
  params.push(tid);

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE ambulance_requests SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${AMBULANCE_RETURNING}`,
    ...params,
  );
  return rows[0];
}

export async function listAmbulanceRequests({
  tenantId = null, status = null, openOnly = false, priority = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, AMBULANCE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (openOnly) {
    filters.push(`status IN ('requested', 'dispatched', 'en_route', 'on_scene', 'returning')`);
  }
  if (priority) {
    params.push(normalizeEnum(priority, AMBULANCE_PRIORITIES, 'priority'));
    filters.push(`priority = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${AMBULANCE_RETURNING} FROM ambulance_requests
       WHERE ${filters.join(' AND ')}
       ORDER BY requested_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { requests: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { requests: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MLC records
// ---------------------------------------------------------------------------

const MLC_RETURNING = `id, tenant_id, emergency_visit_id, patient_uid,
  mlc_number, mlc_kind, reported_to_police_at, police_station, police_report_number,
  ipc_sections, brought_by_relation, brought_by_name, brought_by_phone,
  incident_at, incident_address, history_summary, examination_summary, injuries,
  consent_for_examination, consent_for_disclosure,
  certified_by_uid, certified_at, status, metadata,
  created_by, created_at, updated_at`;

export async function createMlcRecord({
  tenantId = null,
  emergencyVisitId = null,
  patientUid = null,
  mlcNumber,
  mlcKind,
  broughtByRelation = null, broughtByName = null, broughtByPhone = null,
  incidentAt = null, incidentAddress = null,
  historySummary = null, examinationSummary = null, injuries = null,
  consentForExamination = false, consentForDisclosure = false,
  metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNumber = safeText(mlcNumber, 80);
  if (!cleanNumber) throw AppError.badRequest('mlc_number is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO mlc_records
         (tenant_id, emergency_visit_id, patient_uid,
          mlc_number, mlc_kind,
          brought_by_relation, brought_by_name, brought_by_phone,
          incident_at, incident_address,
          history_summary, examination_summary, injuries,
          consent_for_examination, consent_for_disclosure,
          status, metadata, created_by)
       VALUES ($1::uuid, $2, $3::uuid,
         $4, $5,
         $6, $7, $8,
         $9::timestamptz, $10,
         $11, $12, $13::jsonb,
         $14, $15,
         'open', $16::jsonb, $17::uuid)
       RETURNING ${MLC_RETURNING}`,
      tid,
      emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      cleanNumber,
      normalizeEnum(mlcKind, MLC_KINDS, 'mlc_kind', { required: true }),
      safeText(broughtByRelation, 80),
      safeText(broughtByName, SHORT_MAX),
      safeText(broughtByPhone, 40),
      normalizeTimestamp(incidentAt, 'incident_at'),
      safeText(incidentAddress),
      safeText(historySummary), safeText(examinationSummary),
      JSON.stringify(injuries ? normalizeJsonArray(injuries, 'injuries') : []),
      normalizeBoolean(consentForExamination, false),
      normalizeBoolean(consentForDisclosure, false),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    // Mirror the is_mlc=true flag on the parent emergency visit if linked.
    if (emergencyVisitId) {
      try {
        await prisma.$queryRawUnsafe(
          `UPDATE emergency_visits
           SET is_mlc = true, updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2::uuid`,
          normalizeId(emergencyVisitId, 'emergency_visit_id'), tid,
        );
      } catch (err) {
        if (!isMissingSchemaError(err)) throw err;
      }
    }
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('mlc_number already exists');
    if (isFkViolation(err)) throw AppError.badRequest('Invalid emergency_visit_id');
    throw err;
  }
}

export async function recordPoliceReport({
  tenantId = null, id,
  reportedAt = null, policeStation = null, policeReportNumber = null,
  ipcSections = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mlcId = normalizeId(id, 'mlc_record id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE mlc_records
     SET reported_to_police_at = COALESCE($1::timestamptz, NOW()),
         police_station = $2,
         police_report_number = $3,
         ipc_sections = COALESCE($4::text[], ipc_sections),
         updated_at = NOW()
     WHERE id = $5 AND tenant_id = $6::uuid AND status NOT IN ('cancelled', 'closed')
     RETURNING ${MLC_RETURNING}`,
    normalizeTimestamp(reportedAt, 'reported_at'),
    safeText(policeStation, SHORT_MAX),
    safeText(policeReportNumber, 120),
    ipcSections ? normalizeStringArray(ipcSections, 'ipc_sections') : null,
    mlcId, tid,
  );
  if (!rows[0]) throw AppError.notFound('MLC record not found or already closed');
  return rows[0];
}

export async function certifyMlcRecord({
  tenantId = null, id, certifiedByUid,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const mlcId = normalizeId(id, 'mlc_record id');
  const certifiedBy = maybeUuid(certifiedByUid, 'certified_by_uid');
  if (!certifiedBy) throw AppError.badRequest('certified_by_uid is required');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE mlc_records
     SET status = 'certified', certified_by_uid = $1::uuid, certified_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status IN ('open', 'pending_certification')
     RETURNING ${MLC_RETURNING}`,
    certifiedBy, mlcId, tid,
  );
  if (!rows[0]) throw AppError.notFound('MLC record not found or already certified/closed');
  return rows[0];
}

export async function listMlcRecords({
  tenantId = null, status = null, mlcKind = null,
  unreportedOnly = false, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, MLC_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (mlcKind) {
    params.push(normalizeEnum(mlcKind, MLC_KINDS, 'mlc_kind'));
    filters.push(`mlc_kind = $${params.length}`);
  }
  if (unreportedOnly) {
    filters.push(`reported_to_police_at IS NULL AND status NOT IN ('cancelled', 'closed')`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${MLC_RETURNING} FROM mlc_records
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { records: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { records: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  VISIT_TRANSITIONS,
  AMBULANCE_TRANSITIONS,
  TRIAGE_PRIORITIES,
  MLC_KINDS,
};

export default {
  createEmergencyVisit,
  transitionEmergencyVisit,
  setVisitTriagePriority,
  listEmergencyVisits,
  recordTriageAssessment,
  listTriageAssessments,
  createAmbulanceRequest,
  transitionAmbulanceRequest,
  listAmbulanceRequests,
  createMlcRecord,
  recordPoliceReport,
  certifyMlcRecord,
  listMlcRecords,
};
