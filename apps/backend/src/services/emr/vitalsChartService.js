// src/services/emr/vitalsChartService.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { checkVitalAnomalies } from '../../utils/clinical/vitalSignMonitor.js';
import { assertVitalPlausibility, assertRecordedAtPlausibility } from '../../utils/clinical/vitalPlausibility.js';
import { normaliseTemperatureRoute } from '../../utils/clinical/temperatureRoute.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { computeGrowthSnapshot } from '../clinical/growthPercentileService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import * as news2Service from '../clinical/news2Service.js';
import { requireTenantId } from '../tenant/tenantService.js';


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

export function assertLateRecoveryVitalsBoundary({
  interfaceFamily,
  source,
  deviceVerified,
  triageAcuity,
} = {}) {
  const validSource = interfaceFamily === 'I09'
    ? source === 'device' && deviceVerified === false
    : interfaceFamily === 'I15' && source === 'fhir' && deviceVerified === null;
  if (!validSource || triageAcuity !== null) {
    throw new TypeError('Late recovered vitals must remain observation-only pending review');
  }
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
  const labelled = text.match(/^(esi|ats)[_-]?([1-5])$/);
  const n = labelled ? Number(labelled[2]) : Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw AppError.badRequest('triage_acuity must be an integer from 1 to 5');
  }
  return {
    level: n,
    priority: `${labelled?.[1] || 'esi'}_${n}`,
  };
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
      select: { id: true, uid: true, role: true, tenant_id: true },
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
    `SELECT id, uid, role, tenant_id
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

async function propagateTriageAcuity({ patientId, patientUid, visitId, triageAcuity, triagePriority = null }) {
  if (triageAcuity == null) return null;

  const priority = triagePriority || `esi_${triageAcuity}`;
  const visitNumericId = visitId !== undefined && visitId !== null && visitId !== ''
    ? parseOptionalPositiveInt(visitId, 'visit_id')
    : null;
  let emergencyVisit = null;
  let appointment = null;

  if (visitNumericId != null) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE emergency_visits
          SET triage_priority = $1,
              triage_started_at = COALESCE(triage_started_at, NOW()),
              status = CASE WHEN status = 'arriving' THEN 'in_triage' ELSE status END,
              updated_at = NOW()
        WHERE id = $2
          AND patient_uid = $3::uuid
        RETURNING id, visit_number`,
      priority,
      visitNumericId,
      patientUid,
    );
    emergencyVisit = rows[0] ?? null;
  } else {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE emergency_visits
          SET triage_priority = $1,
              triage_started_at = COALESCE(triage_started_at, NOW()),
              status = CASE WHEN status = 'arriving' THEN 'in_triage' ELSE status END,
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

  if (!emergencyVisit && visitNumericId != null) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE appointments
          SET triage_acuity = $1,
              updated_at = NOW()
        WHERE id = $2
          AND patient_id = $3
        RETURNING id, triage_acuity`,
      triageAcuity,
      visitNumericId,
      patientId,
    );
    appointment = rows[0] ?? null;
  }

  if (!appointment) {
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
    appointment = appointmentRows[0] ?? null;
  }

  return {
    triage_acuity: triageAcuity,
    triage_priority: priority,
    emergency_visit_id: emergencyVisit?.id ?? null,
    appointment_id: appointment?.id ?? null,
  };
}

const VITAL_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  encounter_uid: true,
  source: true,
  source_device: true,
  device_verified: true,
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
  // POST writes triage_acuity (via `propagateTriageAcuity`'s sibling
  // UPDATE at line 498) so getLatestVitals / getVitalsChart must echo it
  // back — otherwise the next clinician sees the acuity as null on the
  // vitals row even though the in-memory POST response showed it set,
  // producing a dangerous split-brain (nurse charts ATS-2 acuity for
  // chest pain; later doctor reads vitals and sees no acuity).
  // Finding: 2026-05-22-emergency-walk-in-nurse-009ad565.
  triage_acuity: true,
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

function normalizeTenantId(value) {
  const text = String(value || '').trim().toLowerCase();
  return UUID_RE.test(text) ? text : null;
}

function auditValue(value) {
  if (value && typeof value === 'object' && typeof value.toString === 'function') {
    return value instanceof Date ? value.toISOString() : value.toString();
  }
  return value;
}

// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// a successful vitals / I-O write must persist the detail row + one
// clinical_timeline_events row + one clinical_audit_events row in the SAME
// transaction. The canonical write therefore runs on the transaction client
// (`tx`) and is NOT swallowed — a failure aborts the transaction so the
// detail row rolls back rather than leaving the timeline/audit layer out of
// sync. recordCanonicalClinicalEvent still tolerates a genuinely-absent
// canonical table (SQLSTATE 42P01); every other error propagates.
function recordCanonicalVitalsEvent(input, tx) {
  return recordCanonicalClinicalEvent(input, { db: tx });
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

// Paediatric growth percentiles are derived data — a pure function of the
// stored weight/height + the patient's DOB/sex — so we never persist them
// to a column. Instead the read path recomputes them on demand. This keeps
// the percentile durable (a doctor opening the chart hours later sees the
// same WHO context the nurse saw at triage) without a migration, and avoids
// the "compute-once-in-POST-then-vanish" gap from finding
// 2026-05-22-pediatric-opd-nurse-d9b616dc.
//
// Anchoring on the row's `recorded_at` (not wall-clock now) makes the
// recompute deterministic: the same row always yields the same percentile,
// and a backdated entry uses the child's age at the time of measurement.

// Compute the growth snapshot for a single vitals row, given the patient's
// DOB + sex already resolved. Returns null when there's no weight/height on
// the row or the cohort can't be resolved (no DOB/sex, age outside WHO 0-5).
async function growthSnapshotForRow(row, patient) {
  if (!row || !patient) return null;
  if (row.weight_kg == null && row.height_cm == null) return null;
  return computeGrowthSnapshot({
    gender: patient.gender,
    birthday: patient.birthday,
    weightKg: row.weight_kg,
    heightCm: row.height_cm,
    asOf: row.recorded_at ? new Date(row.recorded_at) : new Date(),
  });
}

// Resolve the patient's DOB/sex once and compute the snapshot for a freshly
// written row (used by recordVitals so the POST response matches read-back).
async function computeGrowthForVitalsRow(row) {
  if (!row || (row.weight_kg == null && row.height_cm == null)) return null;
  try {
    const patient = await prisma.users.findUnique({
      where: { uid: row.patient_uid },
      select: { birthday: true, gender: true },
    });
    return await growthSnapshotForRow(row, patient);
  } catch (err) {
    logger.warn(`Growth percentile computation failed for patient=${row.patient_uid}: ${err.message}`);
    return null;
  }
}

// Attach a recomputed `growth` block to vitals rows on the read path. The
// patient is shared across all rows (same patientUid), so one DOB/sex lookup
// covers the whole page. Mutates and returns each row; rows with no
// weight/height (or an unresolvable cohort) simply carry growth: null.
async function attachGrowthToVitalsRows(rows, patientUid) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  // Only pay for the lookup if at least one row carries a measurement.
  const hasMeasurement = rows.some((r) => r && (r.weight_kg != null || r.height_cm != null));
  if (!hasMeasurement) return rows;
  let patient = null;
  try {
    patient = await prisma.users.findUnique({
      where: { uid: patientUid },
      select: { birthday: true, gender: true },
    });
  } catch (err) {
    logger.warn(`Growth percentile read-back lookup failed for patient=${patientUid}: ${err.message}`);
    return rows;
  }
  for (const row of rows) {
    if (!row) continue;
    row.growth = await growthSnapshotForRow(row, patient);
  }
  return rows;
}

export async function recordVitals(data, { beforeWrite = null, beforeCommit = null } = {}) {
  const {
    tenant_id, tenantId,
    patient_uid, patient_id, visit_id, encounter_id, encounter_uid, heart_rate, systolic_bp, diastolic_bp, temperature,
    triage_acuity, acuity, triage_priority,
    temperature_unit, temperature_route, spo2, respiratory_rate, blood_glucose, pain_score, weight_kg,
    height_cm, gcs_score, supplemental_o2, o2_flow_rate, consciousness, notes,
    recorded_at, observed_at,
    fhr, fundal_height_cm,
    urine_albumin, urine_sugar, urine_ketones,
    recorded_by,
    // Roadmap C5 — provenance labelling: 'staff' (default), 'device'
    // (ICU monitor ORU; unverified until clinician review), 'fhir',
    // 'patient_app'.
    source, source_device, alertOptions = null,
  } = data;

  const normalizedSource = ['staff', 'device', 'fhir', 'patient_app'].includes(source) ? source : 'staff';

  if ((!patient_uid && !patient_id) || !recorded_by) {
    throw AppError.badRequest('patient_uid or patient_id and recorded_by are required');
  }

  const patientUser = await resolvePatientForVitals(patient_uid, patient_id);
  const resolvedPatientUid = patientUser.uid;
  const rawRequestedTenantId = tenant_id || tenantId || null;
  const requestedTenantId = normalizeTenantId(rawRequestedTenantId);
  const patientTenantId = normalizeTenantId(patientUser.tenant_id);
  if (rawRequestedTenantId && !requestedTenantId) {
    throw AppError.badRequest('tenant_id must be a valid UUID');
  }
  if (requestedTenantId && patientTenantId && requestedTenantId !== patientTenantId) {
    throw AppError.notFound('Patient not found');
  }
  const resolvedTenantId = requireTenantId(patientTenantId || requestedTenantId);

  // Wave-4B-1 (migration 208) — split encounter input across int + uuid.
  // Caller can pass either `encounter_id` (legacy int / numeric / UUID),
  // explicit `encounter_uid`, or `visit_id` (the field name the nurse-facing
  // form + swarm drivers use for the appointment/encounter pointer). The
  // admission flow always emits UUIDs.
  //
  // Without the visit_id fallback the vitals row's encounter_id stayed null
  // even when the caller explicitly supplied visit_id — the doctor's screen
  // then couldn't tell which vitals belonged to today's consult. Finding:
  // 2026-05-17-obstetric-anc-nurse-6fe6f592.
  const normalizedEncounter = normalizeEncounter(encounter_id ?? encounter_uid ?? visit_id ?? null);
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
  const normalizedAcuitySignal = normaliseTriageAcuity(triage_acuity ?? acuity ?? triage_priority);
  const normalizedAcuity = normalizedAcuitySignal?.level ?? null;
  const normalizedTriagePriority = normalizedAcuitySignal?.priority ?? null;
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

  // C-M4 — hard plausibility bounds on the core vitals (the fields above only
  // covered fhr/fundal/pain/gcs). Values outside human-possible ranges are
  // data-entry or sensor errors: reject with a 400 rather than persist them
  // into NEWS2 + the alert engine. Temperature is validated AFTER Celsius
  // normalization so a Fahrenheit reading isn't rejected against °C bounds.
  assertVitalPlausibility({
    heart_rate,
    systolic_bp,
    diastolic_bp,
    temperature: normalizedTemperature,
    spo2,
    respiratory_rate,
    blood_glucose,
    o2_flow_rate,
  });
  // recorded_at sanity window: never in the future beyond clock skew; human
  // entry paths bounded to 72h of backdating (device/fhir ingest is exempt —
  // spool replays carry legitimately old observation timestamps).
  assertRecordedAtPlausibility(normalizedRecordedAt, { source: normalizedSource });

  // Atomic clinical write (canonical timeline invariant): the vitals detail
  // row, its in-row triage_acuity stamp, and the canonical timeline/audit
  // events all persist together or not at all. The downstream enrichment
  // (NEWS2, anomaly alerts, growth percentile, triage propagation to the
  // ER/appointment rows) is best-effort and stays OUTSIDE the transaction —
  // it writes other tables / calls other services and must never roll back
  // the recorded vitals. The canonical timeline event therefore carries the
  // vitals row + provenance labelling (the load-bearing clinical record);
  // the enrichment is attached to the service response only.
  //
  // EXCEPTION (audit 2026-06-18 §4): NEWS2 persistence is now part of the atomic
  // clinical write — persistNews2 runs on `tx` so the news2_scores row commits
  // or rolls back WITH the vitals row. Captured here so the post-commit
  // escalation (alert + CDS surfacing) can run after the tx closes.
  let news2Persisted = null;
  let beforeWriteResult = null;
  const record = await setTenantTx(requireTenantId(resolvedTenantId), async (tx) => {
    if (beforeWrite) {
      beforeWriteResult = await beforeWrite({ tx });
    }

    const row = await tx.vitals_chart.create({
      data: {
        patient_uid: resolvedPatientUid,
        tenant_id: resolvedTenantId,
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
        source: normalizedSource,
        source_device: source_device ? String(source_device).slice(0, 120) : null,
        device_verified: normalizedSource === 'device' ? false : null,
        ...(normalizedRecordedAt ? { recorded_at: normalizedRecordedAt } : {}),
      },
      select: VITAL_SELECT,
    });

    if (normalizedAcuity != null) {
      await tx.$executeRawUnsafe(
        `UPDATE vitals_chart SET triage_acuity = $1 WHERE id = $2 AND tenant_id = $3::uuid`,
        normalizedAcuity,
        row.id,
        resolvedTenantId,
      );
      row.triage_acuity = normalizedAcuity;
    }

    await recordCanonicalVitalsEvent({
      patientUid: row.patient_uid,
      tenantId: resolvedTenantId,
      encounterId: row.encounter_uid || null,
      eventType: 'vitals.recorded',
      eventStatus: row.source === 'device' ? 'unverified' : 'recorded',
      sourceTable: 'vitals_chart',
      sourceId: row.id,
      resourceType: 'vitals',
      resourceId: row.id,
      actorUid: row.recorded_by,
      summary: row.source === 'device'
        ? `Device vitals received (${row.source_device || 'monitor'}) — unverified`
        : 'Vitals recorded',
      payload: {
        vitals: row,
        source_kind: row.source,
        verification_status: row.source === 'device' ? 'unverified' : 'verified',
      },
      afterState: row,
      // Canonical timeline convention (docs/CANONICAL_CLINICAL_TIMELINE.md):
      // device-synced observations are labelled unverified until reviewed.
      tags: row.source === 'device' ? ['vitals', 'device-synced', 'unverified'] : ['vitals'],
    }, tx);

    // NEWS2 persistence is now ATOMIC with the vitals write (audit 2026-06-18
    // §4): the news2_scores row is written ON THE SAME tx so it rolls back with
    // the vitals row instead of being a post-commit best-effort that could be
    // lost. Partial scoring (persistNews2 → calculateNEWS2) means a partial
    // vitals set still records a score; pass the ACTUAL values (no fabricated
    // normal temp/consciousness) so absent params are omitted, not scored as 0.
    // Escalation (alert + CDS) runs POST-COMMIT below — it touches other
    // tables / the CDS module and must not be inside the clinical write tx.
    // C-M7 — the SpO2 scoring scale is a patient-level clinical property
    // (Scale 2 for hypercapnic respiratory failure, target 88-92%), not a
    // per-call default: resolve it from the patient's flag
    // (users.news2_spo2_scale) instead of the previous implicit
    // always-Scale-1. Resolution is fail-safe to Scale 1 and runs on the tx
    // client; the resolved scale is passed as options.spo2Scale, the channel
    // that wins over any caller-supplied per-reading value.
    const spo2Scale = await news2Service.resolveSpo2ScaleForPatient(resolvedPatientUid, { db: tx });
    news2Persisted = await news2Service.persistNews2(resolvedPatientUid, {
      respiration_rate: respiratory_rate,
      spo2,
      temperature: normalizedTemperature,
      systolic_bp,
      heart_rate,
      consciousness,
      supplemental_o2: supplemental_o2 || false,
    }, recorded_by, { db: tx, spo2Scale });

    if (beforeCommit) {
      await beforeCommit({
        tx,
        vitals: row,
        news2: news2Persisted?.record ?? null,
        beforeWriteResult,
      });
    }

    return row;
  });

  // NEWS2 escalation — POST-COMMIT. A high-NEWS2 (>=5) escalation failure is
  // LOUD (escalateNews2 throws); a low-score CDS hiccup stays best-effort.
  let news2Result = null;
  if (news2Persisted) {
    news2Result = news2Persisted.record;
    await news2Service.escalateNews2(
      resolvedPatientUid, news2Persisted.record, news2Persisted.computed,
      { tenantId: resolvedTenantId },
    );
  }

  let triage = null;
  if (normalizedAcuity != null) {
    triage = await propagateTriageAcuity({
      patientId: patientUser.id,
      patientUid: resolvedPatientUid,
      visitId: visit_id,
      triageAcuity: normalizedAcuity,
      triagePriority: normalizedTriagePriority,
    });
  }

  let alerts = [];
  const alertOptionsForCheck = beforeWriteResult?.alertOptions ?? alertOptions;

  try {
    const vitalsForCheck = {};
    if (heart_rate != null) vitalsForCheck.heart_rate = heart_rate;
    if (systolic_bp != null) vitalsForCheck.systolic_bp = systolic_bp;
    if (diastolic_bp != null) vitalsForCheck.diastolic_bp = diastolic_bp;
    // Pass the Celsius-normalized temperature (same value stored to the row),
    // NOT the raw caller value — the alert engine's thresholds are Celsius, so
    // a raw Fahrenheit reading would trip a false CRITICAL hyperthermia alert.
    // Finding 2026-05-21-walk-in-opd-doctor-126619d3.
    if (normalizedTemperature != null) vitalsForCheck.temperature = normalizedTemperature;
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
          ...(alertOptionsForCheck && typeof alertOptionsForCheck === 'object'
            ? alertOptionsForCheck
            : {}),
          source: normalizedSource,
          // C-M2 — the tenant is already resolved here; pass it through so
          // EVERY alert severity persists under the patient's tenant (the
          // monitor's own users lookup previously ran only for CRITICALs,
          // default-stamping warning-only batches).
          tenantId: resolvedTenantId,
        });
      }
    }
  } catch (err) {
    // checkVitalAnomalies persists the clinical_alerts fan-out atomically and
    // re-throws on a persistence failure (it never throws for a benign
    // no-alert path). A CRITICAL vital sign alert must NEVER be silently lost
    // behind a warn + 200 — so when the alert persistence fails we escalate to
    // a high-severity error and PROPAGATE, surfacing the failure to the caller
    // (and the global error handler / Sentry) instead of swallowing it.
    // Non-persistence anomaly-check hiccups (e.g. a realtime emit) don't reach
    // here because the post-commit fan-out is individually best-effort.
    if (err instanceof AppError) throw err;
    logger.error(
      `Vital anomaly alert persistence failed for patient=${resolvedPatientUid}: ${err?.message}`,
    );
    throw AppError.internal(
      'Vitals were recorded but a clinical alert could not be persisted — escalate to the responsible clinician.',
      'CLINICAL_ALERT_PERSIST_FAILED',
    );
  }

  // Paediatric growth percentile — when weight/height is recorded for a
  // child who has a DOB + sex on file, auto-compute the WHO percentile
  // so the nurse doesn't need a separate POST /clinical/assessments/growth
  // call. Best-effort: a patient with no DOB/sex, or an age outside the
  // WHO 0-5 table, simply yields growth: null. Findings:
  //   2026-05-09-pediatric-opd-nurse-growth-chart-not-linked-to-vitals
  //   2026-05-11-pediatric-opd-nurse-4354eb08
  //
  // The percentile is NOT stored on its own column — it is a pure function
  // of the row's stored weight/height + the patient's DOB/sex, so the read
  // path (`getLatestVitals` / `getVitalsChart`) recomputes it on demand
  // (see `attachGrowthToVitalsRows`). To guarantee the read-back value
  // matches what we return here, anchor the snapshot to the row's own
  // `recorded_at` rather than wall-clock `now` — a backdated entry then
  // yields the same age (and percentile) on both POST and GET. Finding:
  //   2026-05-22-pediatric-opd-nurse-d9b616dc (transient percentile).
  const growth = await computeGrowthForVitalsRow(record);

  // The canonical timeline + audit events were already written atomically
  // with the vitals row inside the transaction above (canonical timeline
  // invariant). NEWS2 / alerts / growth / triage computed here are best-effort
  // enrichment returned to the caller, not part of the canonical write.

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
  const row = await prisma.vitals_chart.findFirst({
    where: { patient_uid: resolvedPatientUid },
    select: VITAL_SELECT,
    orderBy: { recorded_at: 'desc' },
  });
  if (!row) return null;
  // Recompute the paediatric growth percentile from the stored
  // weight/height + the patient's age/sex so it survives the round-trip
  // (finding 2026-05-22-pediatric-opd-nurse-d9b616dc). Non-paediatric or
  // measurement-less rows get growth: null.
  await attachGrowthToVitalsRows([row], resolvedPatientUid);
  return row;
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
  // Recompute the paediatric growth percentile per row from stored
  // weight/height + the patient's age/sex (one DOB/sex lookup for the page),
  // so the chart shows the same WHO context the nurse saw at entry instead
  // of dropping it (finding 2026-05-22-pediatric-opd-nurse-d9b616dc).
  await attachGrowthToVitalsRows(vitals, patientUid);
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

  const { temperature_unit, corrected_by, actor_role, ip_address, tenantId, ...changes } = data;
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

  // C-M4 — corrections re-validate the core vitals against the same hard
  // plausibility bounds as recordVitals (updateData.temperature is already
  // Celsius-normalized above). Previously only pain/gcs/fhr/fundal were
  // re-checked, so a correction could smuggle in an impossible value.
  assertVitalPlausibility(updateData);

  return setTenantTx(requireTenantId(tenantId), async (tx) => {
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

    const correctedFields = Object.keys(updateData);
    await recordCanonicalClinicalEvent({
      tenantId: requireTenantId(tenantId),
      patientUid: updated.patient_uid,
      encounterId: updated.encounter_uid || null,
      eventType: 'vitals.corrected',
      eventStatus: 'corrected',
      sourceTable: 'vitals_chart',
      sourceId: updated.id,
      resourceType: 'vitals',
      resourceId: updated.id,
      actorUid: corrected_by,
      actorRole: actor_role || null,
      summary: 'Vitals entry corrected',
      payload: { corrected_fields: correctedFields },
      beforeState: {
        corrected_fields: Object.fromEntries(correctedFields.map((field) => [field, auditValue(existing[field])])),
      },
      afterState: {
        corrected_fields: Object.fromEntries(correctedFields.map((field) => [field, auditValue(updated[field])])),
      },
      timelineIdempotencyKey: `vitals_chart:${updated.id}:corrected:${updated.updated_at?.toISOString?.() || Date.now()}`,
      auditIdempotencyKey: `vitals_chart:${updated.id}:audit:corrected:${updated.updated_at?.toISOString?.() || Date.now()}`,
    }, { db: tx, strict: true });

    logger.info(`Vitals corrected: id=${updated.id}, patient=${updated.patient_uid}, by=${corrected_by}`);
    return updated;
  });
}

export async function recordIntakeOutput(data) {
  const { tenant_id, tenantId, patient_uid, encounter_id, encounter_uid, io_type, category, amount_ml, description, recorded_by } = data;

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

  // Resolve the tenant the same way recordVitals does: prefer the patient's
  // own tenant_id, fall back to a (validated) caller-supplied tenant, else the
  // default tenant. This stamps tenant_id on the intake_output row so the
  // migration 075/304 tenant_isolation policy can scope it (the column existed
  // but was never populated by this write — a cross-tenant RLS gap).
  const patientForTenant = await prisma.users.findUnique({
    where: { uid: patient_uid },
    select: { tenant_id: true },
  });
  const rawRequestedTenantId = tenant_id || tenantId || null;
  const requestedTenantId = normalizeTenantId(rawRequestedTenantId);
  const patientTenantId = normalizeTenantId(patientForTenant?.tenant_id);
  if (rawRequestedTenantId && !requestedTenantId) {
    throw AppError.badRequest('tenant_id must be a valid UUID');
  }
  if (requestedTenantId && patientTenantId && requestedTenantId !== patientTenantId) {
    throw AppError.notFound('Patient not found');
  }
  const resolvedTenantId = requireTenantId(patientTenantId || requestedTenantId);

  // Wave-4B-2 (migration 223) — admission encounter_id is a UUID; the
  // pre-admission HL7 visit_no path is int. Split the input across both
  // columns so a nurse copying the admission's encounter UUID into the
  // I/O chart doesn't hit a Prisma 500. Mirrors the vitals/encounter_uid
  // split from migration 208. Finding:
  // 2026-05-09-inpatient-admission-nurse-io-encounter-uuid-500.
  const normalizedEncounter = normalizeEncounter(encounter_id ?? encounter_uid ?? null);

  // Atomic clinical write (canonical timeline invariant): the I/O detail row
  // + its canonical timeline/audit events persist together or not at all.
  const created = await setTenantTx(requireTenantId(resolvedTenantId), async (tx) => {
    const row = await tx.intake_output.create({
      data: {
        patient_uid,
        tenant_id: resolvedTenantId,
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

    await recordCanonicalVitalsEvent({
      patientUid: row.patient_uid,
      encounterId: row.encounter_uid || null,
      eventType: 'io.recorded',
      eventSubtype: row.io_type,
      eventStatus: 'recorded',
      sourceTable: 'intake_output',
      sourceId: row.id,
      resourceType: 'intake_output',
      resourceId: row.id,
      actorUid: row.recorded_by,
      summary: `${row.io_type} ${row.amount_ml} mL recorded`,
      payload: row,
      afterState: row,
    }, tx);

    return row;
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
  // The WRITE side (`recordIntakeOutput`) uses `normalizeEncounter` and
  // routes UUID admission encounters to `encounter_uid` (migration 208/223
  // added the column). The READ side previously hard-rejected anything
  // non-integer with "encounterId must be an integer", so an ICU nurse
  // who charted I/O against the admission encounter UUID at bedside
  // could never read the balance for the same encounter — the API
  // contract was inconsistent (writes accepted, reads rejected).
  // Use the same normaliser here and filter on the matching column so a
  // UUID encounter and an int encounter both query their own row set.
  // Finding: 2026-05-23-emergency-walk-in-nurse-d94bba9f.
  const enc = normalizeEncounter(encounterId);
  if (enc.encounter_id != null) where.encounter_id = enc.encounter_id;
  if (enc.encounter_uid != null) where.encounter_uid = enc.encounter_uid;

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
  // Same write/read contract symmetry as `getIOBalance` — see comment there.
  // Finding: 2026-05-23-emergency-walk-in-nurse-d94bba9f.
  const enc = normalizeEncounter(encounterId);
  if (enc.encounter_id != null) where.encounter_id = enc.encounter_id;
  if (enc.encounter_uid != null) where.encounter_uid = enc.encounter_uid;
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
