// src/services/emr/vitalsChartService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { checkVitalAnomalies } from '../../utils/clinical/vitalSignMonitor.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import * as news2Service from '../clinical/news2Service.js';


const VALID_VITAL_TYPES = [
  'heart_rate', 'systolic_bp', 'diastolic_bp', 'temperature', 'spo2',
  'respiratory_rate', 'blood_glucose', 'pain_score', 'weight_kg',
  'height_cm', 'gcs_score', 'o2_flow_rate',
];

const VALID_IO_TYPES = ['intake', 'output'];
const VALID_IO_CATEGORIES = ['oral', 'iv', 'blood', 'urine', 'drain', 'vomit', 'stool', 'other'];
const VALID_CONSCIOUSNESS = ['A', 'C', 'V', 'P', 'U'];

const VITAL_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  heart_rate: true,
  systolic_bp: true,
  diastolic_bp: true,
  temperature: true,
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
  notes: true,
  recorded_by: true,
  recorded_at: true,
};

const IO_SELECT = {
  id: true,
  patient_uid: true,
  encounter_id: true,
  io_type: true,
  category: true,
  amount_ml: true,
  description: true,
  recorded_by: true,
  recorded_at: true,
};

// Normalize encounter_id to the schema's `Int?` shape. Accepts:
//   - undefined / null    → null (orphan vitals — see route-level orphan note)
//   - integer             → as-is
//   - numeric string `"2"`→ parseInt
//   - anything else       → 400 with a helpful message (callers were
//     previously silently 500ing on `"ENC-…"` strings via Prisma).
// See finding 2026-05-08-inpatient-admission-nurse-vitals-encounter-id-int-vs-string
// and 2026-05-08-pediatric-opd-nurse-encounter-id-type-mismatch.
function normalizeEncounterId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    throw AppError.badRequest(
      `encounter_id must be an integer or numeric string, got "${trimmed}". Resolve the platform visit_no/token to its integer id before posting vitals.`,
    );
  }
  throw AppError.badRequest('encounter_id must be an integer or numeric string');
}

// Strip Postgres-incompatible NUL bytes (U+0000) from any free-text we
// store. The swarm hit this as a UTF8 22021 from somewhere in the
// sanitiser/body-parser chain when notes were combined with encounter_id;
// rather than chase the root cause, defensively strip here so no 500
// reaches the client. See finding
// 2026-05-08-emergency-walk-in-nurse-vitals-notes-utf8-nul.
function stripNul(s) {
  if (s == null || typeof s !== 'string') return s;
  return s.indexOf('\u0000') === -1 ? s : s.replace(/\u0000/g, '');
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

export async function recordVitals(data) {
  const {
    patient_uid, encounter_id, heart_rate, systolic_bp, diastolic_bp, temperature,
    temperature_unit, spo2, respiratory_rate, blood_glucose, pain_score, weight_kg,
    height_cm, gcs_score, supplemental_o2, o2_flow_rate, consciousness, notes,
    recorded_by,
  } = data;

  if (!patient_uid || !recorded_by) {
    throw AppError.badRequest('patient_uid and recorded_by are required');
  }

  const normalizedEncounterId = normalizeEncounterId(encounter_id);
  const normalizedTemperature = toCelsius(temperature, temperature_unit);

  const vitalValues = [heart_rate, systolic_bp, diastolic_bp, normalizedTemperature, spo2,
    respiratory_rate, blood_glucose, pain_score, weight_kg, height_cm, gcs_score];
  if (vitalValues.every((v) => v === undefined || v === null)) {
    throw AppError.badRequest('At least one vital sign measurement is required');
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
      patient_uid,
      encounter_id: normalizedEncounterId,
      heart_rate: heart_rate ?? null,
      systolic_bp: systolic_bp ?? null,
      diastolic_bp: diastolic_bp ?? null,
      temperature: normalizedTemperature ?? null,
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
      notes: stripNul(notes ?? null),
      recorded_by,
    },
    select: VITAL_SELECT,
  });

  let alerts = [];
  let news2Result = null;

  if (respiratory_rate != null && spo2 != null && temperature != null &&
      systolic_bp != null && heart_rate != null && consciousness) {
    try {
      news2Result = await news2Service.recordNEWS2(patient_uid, {
        respiration_rate: respiratory_rate,
        spo2, temperature, systolic_bp, heart_rate, consciousness,
        supplemental_o2: supplemental_o2 || false,
      }, recorded_by);
    } catch (err) {
      logger.warn(`NEWS2 auto-calculation failed for patient=${patient_uid}: ${err.message}`);
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

    if (Object.keys(vitalsForCheck).length > 0) {
      // clinical_alerts.patient_id is an INT FK to users(id) — resolve uuid→int.
      // recorded_by is uuid; clinical_alerts.created_by is int FK — same resolution.
      const [patientUser, recorderUser] = await Promise.all([
        prisma.users.findUnique({ where: { uid: patient_uid }, select: { id: true } }),
        prisma.users.findUnique({ where: { uid: recorded_by }, select: { id: true } }),
      ]);

      if (patientUser?.id) {
        alerts = await checkVitalAnomalies(patientUser.id, vitalsForCheck, {
          recordedBy: recorderUser?.id ?? null,
        });
      }
    }
  } catch (err) {
    logger.warn(`Vital anomaly check failed for patient=${patient_uid}: ${err.message}`);
  }

  logger.info(`Vitals recorded: id=${record.id}, patient=${patient_uid}, by=${recorded_by}`);

  return { vitals: record, news2: news2Result, alerts: alerts || [] };
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

export async function getLatestVitals(patientUid) {
  return prisma.vitals_chart.findFirst({
    where: { patient_uid: patientUid },
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
  if (encounterId) where.encounter_id = encounterId;

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

export async function recordIntakeOutput(data) {
  const { patient_uid, encounter_id, io_type, category, amount_ml, description, recorded_by } = data;

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

  const created = await prisma.intake_output.create({
    data: {
      patient_uid,
      encounter_id: encounter_id ?? null,
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
  if (encounterId) where.encounter_id = encounterId;

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
  if (encounterId) where.encounter_id = encounterId;
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
  recordIntakeOutput,
  getIOBalance,
  getIOChart,
};
