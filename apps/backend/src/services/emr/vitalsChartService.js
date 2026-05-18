// src/services/emr/vitalsChartService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { checkVitalAnomalies } from '../../utils/clinical/vitalSignMonitor.js';
import { normaliseTemperatureRoute } from '../../utils/clinical/temperatureRoute.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { computeGrowthSnapshot } from '../clinical/growthPercentileService.js';
import * as news2Service from '../clinical/news2Service.js';


const VALID_VITAL_TYPES = [
  'heart_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2',
  'respiratory_rate', 'blood_glucose', 'pain_score', 'weight_kg',
  'height_cm', 'gcs_score', 'o2_flow_rate',
  'fhr', 'fundal_height_cm',
];

const VALID_IO_TYPES = ['intake', 'output'];
const VALID_IO_CATEGORIES = ['oral', 'iv', 'blood', 'urine', 'drain', 'vomit', 'stool', 'other'];
const VALID_CONSCIOUSNESS = ['A', 'C', 'V', 'P', 'U'];
const VITAL_CORRECTION_WINDOW_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const VITAL_CORRECTION_FIELDS = [
  'heart_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2',
  'respiratory_rate', 'blood_glucose', 'pain_score', 'weight_kg',
  'height_cm', 'gcs_score', 'supplemental_o2', 'o2_flow_rate',
  'consciousness', 'notes', 'fhr', 'fundal_height_cm',
];

// Parse an encounter id that may arrive as int (POST body) or string (GET query).
// Returns null for empty/undefined, throws 400 for non-numeric strings so the caller
// gets a clean validation error instead of a Prisma 500.
function toEncounterIdInt(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n)) {
    throw AppError.badRequest('encounterId must be an integer');
  }
  return n;
}

// Urine dipstick (migration 211). Five-step scale used on both the
// vitals_chart entry and the ANC visit composer. Stored as plain text
// so the strip-reader UI can round-trip the value without an enum
// migration when manufacturers ship slightly different labelling
// (`+/-` vs `trace`, etc.). Finding:
// 2026-05-08-obstetric-anc-nurse-no-ob-vitals-fields (dipstick portion).
const VALID_DIPSTICK_VALUES = ['negative', 'trace', '1+', '2+', '3+', '4+'];
function normaliseDipstick(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (!VALID_DIPSTICK_VALUES.includes(v)) {
    throw AppError.badRequest(
      `${field} must be one of: ${VALID_DIPSTICK_VALUES.join(', ')}`,
    );
  }
  return v;
}

function normaliseTriageAcuity(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim().toLowerCase();
  const labelled = text.match(/^(?:esi|ats)[_-]?([1-5])$/);
  const n = labelled ? Number(labelled[1]) : Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw AppError.badRequest('triage_acuity must be an integer from 1 to 5');
  }
  return n;
}

function parseOptionalPositiveInt(raw, field) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`);
  }
  return n;
}

async function resolvePatientForVitals(patientUid, patientId) {
  if (patientUid) {
    const user = await prisma.users.findUnique({
      where: { uid: patientUid },
      select: { id: true, uid: true, role: true },
    });
    if (!user) throw AppError.notFound('Patient not found');
    if (patientId !== undefined && patientId !== null && patientId !== '') {
      const patientIdInt = parseOptionalPositiveInt(patientId, 'patient_id');
      if (user.id !== patientIdInt) {
        throw AppError.badRequest('patient_id does not match patient_uid');
      }
    }
    return user;
  }

  const patientIdInt = parseOptionalPositiveInt(patientId, 'patient_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, role
       FROM users
      WHERE id = $1
      LIMIT 1`,
    patientIdInt,
  );
  const user = rows[0] ?? null;
  if (!user) throw AppError.notFound('Patient not found');
  if (user.role !== 'PATIENT') {
    throw AppError.badRequest('patient_id must reference a patient');
  }
  return { id: user.id, uid: String(user.uid), role: user.role };
}

async function propagateTriageAcuity({ patientId, patientUid, visitId, triageAcuity }) {
  if (triageAcuity == null) return null;

  const priority = `esi_${triageAcuity}`;
  const emergencyVisitId = parseOptionalPositiveInt(visitId, 'visit_id');
  let emergencyVisit = null;

  if (emergencyVisitId != null) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE emergency_visits
          SET triage_priority = $1,
              triage_started_at = COALESCE(triage_started_at, NOW()),
              status = CASE WHEN status = 'arriving' THEN 'triage' ELSE status END,
              updated_at = NOW()
        WHERE id = $2
          AND patient_uid = $3::uuid
        RETURNING id, visit_number`,
      priority,
      emergencyVisitId,
      patientUid,
    );
    emergencyVisit = rows[0] ?? null;
  } else {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE emergency_visits
          SET triage_priority = $1,
              triage_started_at = COALESCE(triage_started_at, NOW()),
              status = CASE WHEN status = 'arriving' THEN 'triage' ELSE status END,
              updated_at = NOW()
        WHERE id = (
          SELECT id
            FROM emergency_visits
           WHERE patient_uid = $2::uuid
             AND COALESCE(disposition, '') NOT IN ('discharged', 'lama', 'expired')
           ORDER BY arrival_at DESC
           LIMIT 1
        )
        RETURNING id, visit_number`,
      priority,
      patientUid,
    );
    emergencyVisit = rows[0] ?? null;
  }

  const appointmentRows = await prisma.$queryRawUnsafe(
    `UPDATE appointments
        SET triage_acuity = $1,
            updated_at = NOW()
      WHERE id = (
        SELECT a.id
          FROM appointments a
         WHERE a.patient_id = $2
           AND (
             ($3::text IS NOT NULL AND a.visit_no = $3::text)
             OR a.visit_type = 'EMERGENCY'
             OR a.department ILIKE '%emergency%'
           )
         ORDER BY a.appointment_date DESC, a.created_at DESC
         LIMIT 1
      )
      RETURNING id, triage_acuity`,
    triageAcuity,
    patientId,
    emergencyVisit?.visit_number ?? null,
  );

  return {
    triage_acuity: triageAcuity,
    triage_priority: priority,
    emergency_visit_id: emergencyVisit?.id ?? null,
    appointment_id: appointmentRows[0]?.id ?? null,
  };
}

const VITAL_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  encounter_uid: true,
  heart_rate: true,
  systolic_bp: true,
  diastolic_bp: true,
  temperature: true,
  temperature_route: true,
  spo2: true,
  respiratory_rate: true,
  blood_glucose: true,
  pain_score: true,
  weight_kg: true,
  height_cm: true,
  gcs_score: true,
  supplemental_o2: true,
  o2_flow_rate: true,
  consciousness: true,
  // OB-specific fields added in migration 169. See finding
  // 2026-05-08-obstetric-anc-nurse-no-fhr-fundal-fields.
  fhr: true,
  fundal_height_cm: true,
  // Urine dipstick (migration 211) — the third OB-vital surface the
  // ANC nurse fills at routine antenatal checks. Mirrors the column
  // names already used on maternity_anc_visits so the two compositions
  // stay consistent. Finding:
  // 2026-05-08-obstetric-anc-nurse-no-ob-vitals-fields (dipstick part).
  urine_albumin: true,
  urine_sugar: true,
  urine_ketones: true,
  notes: true,
  recorded_by: true,
  recorded_at: true,
};

const IO_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  encounter_uid: true,
  io_type: true,
  category: true,
  amount_ml: true,
  description: true,
  recorded_by: true,
  recorded_at: true,
};

// UUID validation — admissions.encounter_id is a UUID, so vitals must
// accept either the int legacy `encounter_id` or the UUID admission
// encounter and route them to the right column.
const ENCOUNTER_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

// Normalize encounter input into the {encounter_id, encounter_uid} split.
// Migration 208 added `encounter_uid UUID` so admission encounters can be
// linked without a type mismatch. Returns:
//   - { encounter_id: int|null, encounter_uid: string|null }
// Accepts:
//   - undefined / null / ''    → both null (orphan vitals, deprecated path)
//   - integer / numeric string → encounter_id only (legacy HL7 visit_no path)
//   - UUID string              → encounter_uid only (admission encounter)
//   - anything else            → 400 with a helpful message
// See findings:
//   2026-05-08-inpatient-admission-nurse-vitals-encounter-id-int-vs-string
//   2026-05-08-pediatric-opd-nurse-encounter-id-type-mismatch
//   2026-05-08-inpatient-admission-nurse-vitals-encounter-id-type-mismatch
function normalizeEncounter(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { encounter_id: null, encounter_uid: null };
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return { encounter_id: raw, encounter_uid: null };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      return { encounter_id: parseInt(trimmed, 10), encounter_uid: null };
    }
    if (ENCOUNTER_UUID_RE.test(trimmed)) {
      return { encounter_id: null, encounter_uid: trimmed };
    }
    throw AppError.badRequest(
      `encounter_id must be an integer, numeric string, or UUID, got "${trimmed}".`,
    );
  }
  throw AppError.badRequest('encounter_id must be an integer or UUID');
}

// Kept for back-compat with callers that only want the int part.
function _normalizeEncounterIdLegacy(raw) {
  return normalizeEncounter(raw).encounter_id;
}

// Strip Postgres-incompatible NUL bytes (U+0000) from any free-text we
// store. The swarm hit this as a UTF8 22021 from somewhere in the
// sanitiser/body-parser chain when notes were combined with encounter_id;
// rather than chase the root cause, defensively strip here so no 500
// reaches the client. See finding
// 2026-05-08-emergency-walk-in-nurse-vitals-notes-utf8-nul.
function stripNul(s) {
  if (s == null || typeof s !== 'string') return s;
  return s.indexOf('\u0000') === -1 ? s : s.replaceAll('\u0000', '');
}

function auditValue(value) {
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    return value instanceof Date ? value.toISOString() : value.toString();
  }
  return value;
}

// Convert a temperature value to Celsius, given the unit hint. Default unit
// is `C` to match the threshold table; explicit `F` triggers conversion.
// See finding 2026-05-08-walk-in-opd-doctor-vitals-temp-ambiguity.
function toCelsius(value, unit) {
  if (value === undefined || value === null) return value;
  const u = String(unit ?? 'C').trim().toUpperCase();
  if (u === 'F' || u === 'FAHRENHEIT') return ((value - 32) * 5) / 9;
  return value;
}

function normalizeRecordedAt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw AppError.badRequest('recorded_at must be a valid ISO timestamp');
  }
  return d;
}

export async function recordVitals(data) {
  const {
    patient_uid, patient_id, visit_id, encounter_id, encounter_uid, heart_rate, systolic_bp, diastolic_bp, temperature,
    triage_acuity, acuity, triage_priority,
    temperature_unit, temperature_route, spo2, respiratory_rate, blood_glucose, pain_score, weight_kg,
    height_cm, gcs_score, supplemental_o2, o2_flow_rate, consciousness, notes,
    recorded_at, observed_at,
    fhr, fundal_height_cm,
    urine_albumin, urine_sugar, urine_ketones,
    recorded_by,
  } = data;

  if ((!patient_uid && !patient_id) || !recorded_by) {
    throw AppError.badRequest('patient_uid or patient_id and recorded_by are required');
  }

  const patientUser = await resolvePatientForVitals(patient_uid, patient_id);
  const resolvedPatientUid = patientUser.uid;

  // Wave-4B-1 (migration 208) — split encounter input across int + uuid.
  // Caller can pass either `encounter_id` (legacy int / numeric / UUID) or
  // explicit `encounter_uid`. The admission flow always emits UUIDs.
  const normalizedEncounter = normalizeEncounter(encounter_id ?? encounter_uid ?? null);
  const normalizedEncounterId = normalizedEncounter.encounter_id;
  const normalizedEncounterUid = normalizedEncounter.encounter_uid;
  const normalizedTemperature = toCelsius(temperature, temperature_unit);

  // Temperature route (axillary/oral/rectal/tympanic) — clinically
  // load-bearing in paediatrics. Finding:
  // 2026-05-09-pediatric-opd-nurse-no-temperature-route-field.
  const routeResult = normaliseTemperatureRoute(temperature_route);
  if (routeResult.error) throw AppError.badRequest(routeResult.error);
  const normalizedTemperatureRoute = routeResult.value;

  const normalizedAlbumin = normaliseDipstick(urine_albumin, 'urine_albumin');
  const normalizedSugar = normaliseDipstick(urine_sugar, 'urine_sugar');
  const normalizedKetones = normaliseDipstick(urine_ketones, 'urine_ketones');
  const normalizedAcuity = normaliseTriageAcuity(triage_acuity ?? acuity ?? triage_priority);
  const normalizedRecordedAt = normalizeRecordedAt(recorded_at ?? observed_at);

  const vitalValues = [heart_rate, systolic_bp, diastolic_bp, normalizedTemperature, spo2,
    respiratory_rate, blood_glucose, pain_score, weight_kg, height_cm, gcs_score,
    fhr, fundal_height_cm, normalizedAcuity,
    normalizedAlbumin, normalizedSugar, normalizedKetones];
  if (vitalValues.every((v) => v === undefined || v === null)) {
    throw AppError.badRequest('At least one vital sign measurement is required');
  }

  if (fhr !== undefined && fhr !== null && (Number(fhr) < 60 || Number(fhr) > 220)) {
    throw AppError.badRequest('fhr (fetal heart rate) must be between 60 and 220 bpm');
  }
  if (fundal_height_cm !== undefined && fundal_height_cm !== null && (Number(fundal_height_cm) < 0 || Number(fundal_height_cm) > 50)) {
    throw AppError.badRequest('fundal_height_cm must be between 0 and 50 cm');
  }

  if (pain_score !== undefined && pain_score !== null && (pain_score < 0 || pain_score > 10)) {
    throw AppError.badRequest('pain_score must be between 0 and 10');
  }
  if (gcs_score !== undefined && gcs_score !== null && (gcs_score < 3 || gcs_score > 15)) {
    throw AppError.badRequest('gcs_score must be between 3 and 15');
  }
  if (consciousness && !VALID_CONSCIOUSNESS.includes(consciousness)) {
    throw AppError.badRequest(`consciousness must be one of: ${VALID_CONSCIOUSNESS.join(', ')}`);
  }

  const record = await prisma.vitals_chart.create({
    data: {
      patient_uid: resolvedPatientUid,
      encounter_id: normalizedEncounterId,
      encounter_uid: normalizedEncounterUid,
      heart_rate: heart_rate ?? null,
      systolic_bp: systolic_bp ?? null,
      diastolic_bp: diastolic_bp ?? null,
      temperature: normalizedTemperature ?? null,
      temperature_route: normalizedTemperatureRoute,
      spo2: spo2 ?? null,
      respiratory_rate: respiratory_rate ?? null,
      blood_glucose: blood_glucose ?? null,
      pain_score: pain_score ?? null,
      weight_kg: weight_kg ?? null,
      height_cm: height_cm ?? null,
      gcs_score: gcs_score ?? null,
      supplemental_o2: supplemental_o2 ?? false,
      o2_flow_rate: o2_flow_rate ?? null,
      consciousness: consciousness ?? null,
      // OB-specific fields. See finding
      // 2026-05-08-obstetric-anc-nurse-no-fhr-fundal-fields.
      fhr: fhr ?? null,
      fundal_height_cm: fundal_height_cm ?? null,
      // Urine dipstick (migration 211).
      urine_albumin: normalizedAlbumin,
      urine_sugar: normalizedSugar,
      urine_ketones: normalizedKetones,
      notes: stripNul(notes ?? null),
      recorded_by,
      ...(normalizedRecordedAt ? { recorded_at: normalizedRecordedAt } : {}),
    },
    select: VITAL_SELECT,
  });

  if (normalizedAcuity != null) {
    await prisma.$executeRawUnsafe(
      `UPDATE vitals_chart SET triage_acuity = $1 WHERE id = $2`,
      normalizedAcuity,
      record.id,
    );
    record.triage_acuity = normalizedAcuity;
  }

  let triage = null;
  if (normalizedAcuity != null) {
    triage = await propagateTriageAcuity({
      patientId: patientUser.id,
      patientUid: resolvedPatientUid,
      visitId: visit_id,
      triageAcuity: normalizedAcuity,
    });
  }

  let alerts = [];
  let news2Result = null;

  if (respiratory_rate != null && spo2 != null && systolic_bp != null && heart_rate != null) {
    try {
      news2Result = await news2Service.recordNEWS2(resolvedPatientUid, {
        respiration_rate: respiratory_rate,
        spo2,
        temperature: normalizedTemperature ?? 37,
        systolic_bp,
        heart_rate,
        consciousness: consciousness || 'A',
        supplemental_o2: supplemental_o2 || false,
      }, recorded_by);
    } catch (err) {
      logger.warn(`NEWS2 auto-calculation failed for patient=${resolvedPatientUid}: ${err.message}`);
    }
  }

  try {
    const vitalsForCheck = {};
    if (heart_rate != null) vitalsForCheck.heart_rate = heart_rate;
    if (systolic_bp != null) vitalsForCheck.systolic_bp = systolic_bp;
    if (diastolic_bp != null) vitalsForCheck.diastolic_bp = diastolic_bp;
    if (temperature != null) vitalsForCheck.temperature = temperature;
    if (spo2 != null) vitalsForCheck.oxygen_saturation = spo2;
    if (respiratory_rate != null) vitalsForCheck.respiratory_rate = respiratory_rate;
    if (normalizedAlbumin != null) vitalsForCheck.urine_albumin = normalizedAlbumin;

    if (Object.keys(vitalsForCheck).length > 0) {
      // clinical_alerts.patient_id is an INT FK to users(id) — resolve uuid→int.
      // recorded_by is uuid; clinical_alerts.created_by is int FK — same resolution.
      const recorderUser = await prisma.users.findUnique({
        where: { uid: recorded_by },
        select: { id: true },
      });

      if (patientUser?.id) {
        alerts = await checkVitalAnomalies(patientUser.id, vitalsForCheck, {
          recordedBy: recorderUser?.id ?? null,
        });
      }
    }
  } catch (err) {
    logger.warn(`Vital anomaly check failed for patient=${resolvedPatientUid}: ${err.message}`);
  }

  // Paediatric growth percentile — when weight/height is recorded for a
  // child who has a DOB + sex on file, auto-compute the WHO percentile
  // so the nurse doesn't need a separate POST /clinical/assessments/growth
  // call. Best-effort: a patient with no DOB/sex, or an age outside the
  // WHO 0-5 table, simply yields growth: null. Findings:
  //   2026-05-09-pediatric-opd-nurse-growth-chart-not-linked-to-vitals
  //   2026-05-11-pediatric-opd-nurse-4354eb08
  let growth = null;
  if (weight_kg != null || height_cm != null) {
    try {
      const patient = await prisma.users.findUnique({
        where: { uid: resolvedPatientUid },
        select: { birthday: true, gender: true },
      });
      if (patient) {
        growth = computeGrowthSnapshot({
          gender: patient.gender,
          birthday: patient.birthday,
          weightKg: weight_kg,
          heightCm: height_cm,
        });
      }
    } catch (err) {
      logger.warn(`Growth percentile computation failed for patient=${resolvedPatientUid}: ${err.message}`);
    }
  }

  logger.info(`Vitals recorded: id=${record.id}, patient=${resolvedPatientUid}, by=${recorded_by}`);

  return { vitals: record, news2: news2Result, alerts: alerts || [], growth, triage };
}

export async function getVitalsTrend(patientUid, vitalType, dateFrom, dateTo) {
  if (!VALID_VITAL_TYPES.includes(vitalType)) {
    throw AppError.badRequest(`Invalid vital type: ${vitalType}. Must be one of: ${VALID_VITAL_TYPES.join(', ')}`);
  }

  const where = {
    patient_uid: patientUid,
    [vitalType]: { not: null },
  };
  if (dateFrom || dateTo) {
    where.recorded_at = {};
    if (dateFrom) where.recorded_at.gte = new Date(dateFrom);
    if (dateTo) where.recorded_at.lte = new Date(dateTo);
  }

  // The vitalType column is whitelist-validated above, so it's safe to
  // dynamically select it. Project to { timestamp, value } shape that the
  // pre-ORM raw SQL aliased.
  const rows = await prisma.vitals_chart.findMany({
    where,
    select: { recorded_at: true, [vitalType]: true },
    orderBy: { recorded_at: 'asc' },
  });

  return rows.map((row) => ({
    timestamp: row.recorded_at,
    value: row[vitalType],
  }));
}

async function resolvePatientUidForRead(patientIdentifier) {
  if (!patientIdentifier) return null;
  const raw = String(patientIdentifier).trim();
  if (UUID_RE.test(raw)) return raw;
  const patientId = parseOptionalPositiveInt(raw, 'patient_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, role FROM users WHERE id = $1::int LIMIT 1`,
    patientId,
  );
  const user = rows[0] ?? null;
  if (!user) return null;
  if (user.role !== 'PATIENT') {
    throw AppError.badRequest('patient_id must reference a patient');
  }
  return String(user.uid);
}

export async function getLatestVitals(patientUid) {
  const resolvedPatientUid = await resolvePatientUidForRead(patientUid);
  if (!resolvedPatientUid) return null;
  return prisma.vitals_chart.findFirst({
    where: { patient_uid: resolvedPatientUid },
    select: VITAL_SELECT,
    orderBy: { recorded_at: 'desc' },
  });
}

export async function getVitalsChart(patientUid, encounterId, pagination = {}) {
  const listQuery = parseListQuery(pagination, {
    defaultLimit: 50,
    maxLimit: 100,
    defaultSortBy: 'recorded_at'
  });

  const where = { patient_uid: patientUid };
  // Wave-4B-1 (migration 208) — split the encounter filter so callers
  // passing the admission UUID find the rows recorded with `encounter_uid`
  // and the legacy HL7 visit_no int path keeps working.
  if (encounterId !== undefined && encounterId !== null && encounterId !== '') {
    const split = normalizeEncounter(encounterId);
    if (split.encounter_uid) where.encounter_uid = split.encounter_uid;
    else if (split.encounter_id != null) where.encounter_id = split.encounter_id;
  }

  const [vitals, total] = await Promise.all([
    prisma.vitals_chart.findMany({
      where,
      select: VITAL_SELECT,
      orderBy: { recorded_at: 'desc' },
      take: listQuery.limit,
      skip: listQuery.offset,
    }),
    prisma.vitals_chart.count({ where }),
  ]);
  const meta = buildPagination(total, listQuery.page, listQuery.limit);

  return {
    vitals,
    pagination: meta,
  };
}

export async function correctVitals(vitalsId, data) {
  const id = Number(vitalsId);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('vitals id must be a positive integer');
  }

  const { temperature_unit, corrected_by, ip_address, ...changes } = data;
  if (!corrected_by) {
    throw AppError.badRequest('corrected_by is required');
  }

  if (changes.consciousness && !VALID_CONSCIOUSNESS.includes(changes.consciousness)) {
    throw AppError.badRequest(`consciousness must be one of: ${VALID_CONSCIOUSNESS.join(', ')}`);
  }
  if (changes.pain_score !== undefined && changes.pain_score !== null && (changes.pain_score < 0 || changes.pain_score > 10)) {
    throw AppError.badRequest('pain_score must be between 0 and 10');
  }
  if (changes.gcs_score !== undefined && changes.gcs_score !== null && (changes.gcs_score < 3 || changes.gcs_score > 15)) {
    throw AppError.badRequest('gcs_score must be between 3 and 15');
  }
  if (changes.fhr !== undefined && changes.fhr !== null && (Number(changes.fhr) < 60 || Number(changes.fhr) > 220)) {
    throw AppError.badRequest('fhr (fetal heart rate) must be between 60 and 220 bpm');
  }
  if (changes.fundal_height_cm !== undefined && changes.fundal_height_cm !== null && (Number(changes.fundal_height_cm) < 0 || Number(changes.fundal_height_cm) > 50)) {
    throw AppError.badRequest('fundal_height_cm must be between 0 and 50 cm');
  }

  const updateData = {};
  for (const field of VITAL_CORRECTION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes, field)) {
      updateData[field] = field === 'temperature'
        ? toCelsius(changes[field], temperature_unit)
        : changes[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(updateData, 'notes')) {
    updateData.notes = stripNul(updateData.notes);
  }

  if (Object.keys(updateData).length === 0) {
    throw AppError.badRequest('At least one vitals field is required for correction');
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.vitals_chart.findUnique({
      where: { id },
      select: { ...VITAL_SELECT, created_at: true },
    });

    if (!existing) {
      throw AppError.notFound('Vitals record not found');
    }

    const recordedAt = existing.recorded_at ?? existing.created_at;
    if (!recordedAt) {
      throw AppError.conflict('Vitals record cannot be corrected without a recorded timestamp');
    }
    if (Date.now() - new Date(recordedAt).getTime() > VITAL_CORRECTION_WINDOW_MS) {
      throw AppError.conflict('Vitals correction window has expired');
    }

    const updated = await tx.vitals_chart.update({
      where: { id },
      data: updateData,
      select: VITAL_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: corrected_by,
        action: 'CORRECT_VITALS',
        resource: 'vitals_chart',
        resource_id: String(id),
        metadata: {
          patient_uid: existing.patient_uid,
          encounter_id: existing.encounter_id,
          corrected_fields: Object.keys(updateData),
          before: Object.fromEntries(Object.keys(updateData).map((field) => [field, auditValue(existing[field])])),
          after: Object.fromEntries(Object.keys(updateData).map((field) => [field, auditValue(updated[field])])),
        },
        ip_address,
      },
    });

    logger.info(`Vitals corrected: id=${updated.id}, patient=${updated.patient_uid}, by=${corrected_by}`);
    return updated;
  });
}

export async function recordIntakeOutput(data) {
  const { patient_uid, encounter_id, encounter_uid, io_type, category, amount_ml, description, recorded_by } = data;

  if (!patient_uid || !io_type || !category || amount_ml === undefined || !recorded_by) {
    throw AppError.badRequest('patient_uid, io_type, category, amount_ml, and recorded_by are required');
  }
  if (!VALID_IO_TYPES.includes(io_type)) {
    throw AppError.badRequest(`Invalid io_type: ${io_type}. Must be one of: ${VALID_IO_TYPES.join(', ')}`);
  }
  if (!VALID_IO_CATEGORIES.includes(category)) {
    throw AppError.badRequest(`Invalid category: ${category}. Must be one of: ${VALID_IO_CATEGORIES.join(', ')}`);
  }
  if (typeof amount_ml !== 'number' || amount_ml < 0) {
    throw AppError.badRequest('amount_ml must be a non-negative number');
  }

  // Wave-4B-2 (migration 223) — admission encounter_id is a UUID; the
  // pre-admission HL7 visit_no path is int. Split the input across both
  // columns so a nurse copying the admission's encounter UUID into the
  // I/O chart doesn't hit a Prisma 500. Mirrors the vitals/encounter_uid
  // split from migration 208. Finding:
  // 2026-05-09-inpatient-admission-nurse-io-encounter-uuid-500.
  const normalizedEncounter = normalizeEncounter(encounter_id ?? encounter_uid ?? null);

  const created = await prisma.intake_output.create({
    data: {
      patient_uid,
      encounter_id: normalizedEncounter.encounter_id,
      encounter_uid: normalizedEncounter.encounter_uid,
      io_type,
      category,
      amount_ml,
      description: description ?? null,
      recorded_by,
    },
    select: IO_SELECT,
  });

  logger.info(`I/O recorded: id=${created.id}, type=${io_type}, category=${category}, amount=${amount_ml}ml, patient=${patient_uid}`);
  return created;
}

export async function getIOBalance(patientUid, encounterId, date) {
  if (!date) throw AppError.badRequest('date is required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw AppError.badRequest('date must be in YYYY-MM-DD format');
  }

  // Keep this aligned to the DB calendar day used by `current_date` in tests
  // and production UTC Postgres. Parsing YYYY-MM-DD with local setHours can
  // shift late-night records out of the requested DB day on non-UTC hosts.
  const [year, month, day] = String(date).split('-').map(Number);
  const dayStart = new Date(Date.UTC(year, month - 1, day));
  const dayEnd = new Date(Date.UTC(year, month - 1, day + 1));

  const where = {
    patient_uid: patientUid,
    recorded_at: { gte: dayStart, lt: dayEnd },
  };
  // encounterId arrives from the query string as a string; intake_output.encounter_id
  // is Int? in Prisma, so passing the raw string trips a validation error and a 500.
  const encounterIdInt = toEncounterIdInt(encounterId);
  if (encounterIdInt != null) where.encounter_id = encounterIdInt;

  // Aggregate intake/output sums via groupBy + JS reduction (one query).
  const [groups, entries] = await Promise.all([
    prisma.intake_output.groupBy({
      by: ['io_type'],
      where,
      _sum: { amount_ml: true },
    }),
    prisma.intake_output.findMany({
      where,
      select: {
        id: true,
        io_type: true,
        category: true,
        amount_ml: true,
        description: true,
        recorded_by: true,
        recorded_at: true,
      },
      orderBy: { recorded_at: 'asc' },
    }),
  ]);

  let totalIntake = 0;
  let totalOutput = 0;
  for (const group of groups) {
    const total = Number(group._sum.amount_ml ?? 0);
    if (group.io_type === 'intake') totalIntake = total;
    else if (group.io_type === 'output') totalOutput = total;
  }

  return {
    date,
    total_intake: totalIntake,
    total_output: totalOutput,
    balance: totalIntake - totalOutput,
    entries,
  };
}

export async function getIOChart(patientUid, encounterId, dateFrom, dateTo) {
  const where = { patient_uid: patientUid };
  const encounterIdInt = toEncounterIdInt(encounterId);
  if (encounterIdInt != null) where.encounter_id = encounterIdInt;
  if (dateFrom || dateTo) {
    where.recorded_at = {};
    if (dateFrom) where.recorded_at.gte = new Date(dateFrom);
    if (dateTo) where.recorded_at.lte = new Date(dateTo);
  }

  return prisma.intake_output.findMany({
    where,
    select: {
      id: true,
      io_type: true,
      category: true,
      amount_ml: true,
      description: true,
      recorded_by: true,
      recorded_at: true,
    },
    orderBy: { recorded_at: 'asc' },
  });
}

export default {
  recordVitals,
  getVitalsTrend,
  getLatestVitals,
  getVitalsChart,
  correctVitals,
  recordIntakeOutput,
  getIOBalance,
  getIOChart,
};
