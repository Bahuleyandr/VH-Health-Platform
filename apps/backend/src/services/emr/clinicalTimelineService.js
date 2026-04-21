import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1000;

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

function isMissingSchemaError(err) {
  const message = String(err?.message || '');
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(message);
}

async function optionalQuery(sql, ...params) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      logger.warn('Optional clinical timeline source skipped', { error: err.message });
      return [];
    }
    throw err;
  }
}

function addDateFilters({ column, params, conditions, dateFrom, dateTo }) {
  let idx = params.length + 1;
  if (dateFrom) {
    conditions.push(`${column} >= $${idx}`);
    params.push(dateFrom);
    idx++;
  }
  if (dateTo) {
    conditions.push(`${column} <= $${idx}`);
    params.push(dateTo);
  }
}

function stringifySummary(value, fallback = 'No details recorded') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const preferred = value.summary || value.assessment || value.plan || value.hospital_course || value.notes;
    if (preferred) return String(preferred);
    return JSON.stringify(value).slice(0, 240);
  }
  return String(value);
}

function normalizeTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function newestFirst(a, b) {
  return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
}

function oldestFirst(a, b) {
  return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
}

function makeCitation(event) {
  return {
    source_type: event.event_type,
    source_id: event.id ? String(event.id) : null,
    timestamp: event.timestamp,
    label: event.summary,
  };
}

async function getPatient(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, phone, name, gender, email, birthday, address
     FROM users
     WHERE uid = $1::uuid
     LIMIT 1`,
    patientUid
  );
  return rows[0] || null;
}

async function getAdmission(admissionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.encounter_id, a.patient_uid, a.status, a.priority,
            a.admission_type, a.reason, a.reason_for_admission, a.chief_complaint,
            a.admitting_diagnosis, a.admitting_doctor, a.attending_doctor,
            a.department, a.ward, a.bed_id, a.bed_number, a.code_status,
            a.expected_los_days, a.admitted_at, a.discharged_at,
            a.discharge_type, a.discharge_summary, a.created_at
     FROM admissions a
     WHERE a.id = $1
     LIMIT 1`,
    admissionId
  );
  return rows[0] || null;
}

async function getTimelineAdmissions(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'admitted_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, encounter_id, status, priority, admission_type, department, ward,
            bed_number, chief_complaint, admitting_diagnosis, admitted_at,
            discharged_at, discharge_type
     FROM admissions
     WHERE ${conditions.join(' AND ')}
     ORDER BY admitted_at DESC NULLS LAST`,
    ...params
  );

  return rows.flatMap((row) => {
    const admitted = {
      event_type: 'admission',
      sub_type: row.admission_type || row.priority || 'inpatient',
      id: row.id,
      encounter_id: row.encounter_id,
      summary: `Admitted${row.ward ? ` to ${row.ward}` : ''}: ${row.chief_complaint || row.admitting_diagnosis || 'reason not documented'}`,
      timestamp: normalizeTime(row.admitted_at || row.created_at),
      payload: row,
    };
    if (!row.discharged_at) return [admitted];
    return [
      admitted,
      {
        event_type: 'discharge',
        sub_type: row.discharge_type || row.status,
        id: row.id,
        encounter_id: row.encounter_id,
        summary: `Discharged: ${row.discharge_type || row.status || 'type not documented'}`,
        timestamp: normalizeTime(row.discharged_at),
        payload: row,
      },
    ];
  });
}

async function getTimelineNotes(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'created_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, encounter_id, note_type, title, content, author_uid, author_role,
            is_addendum, is_signed, signed_at, created_at
     FROM clinical_notes
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'clinical_note',
    sub_type: row.note_type,
    id: row.id,
    encounter_id: row.encounter_id,
    summary: `${String(row.note_type || 'note').toUpperCase()}: ${stringifySummary(row.content, row.title || 'Clinical note')}`,
    timestamp: normalizeTime(row.created_at),
    payload: row,
  }));
}

async function getTimelineDiagnoses(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'created_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, encounter_id, icd10_code, icd10_description, description,
            diagnosis_type, status, severity, diagnosed_by, onset_date, resolved_date,
            created_at
     FROM diagnoses
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'diagnosis',
    sub_type: row.diagnosis_type || row.status,
    id: row.id,
    encounter_id: row.encounter_id,
    summary: `${row.icd10_code ? `${row.icd10_code} ` : ''}${row.description || row.icd10_description || 'Diagnosis'} (${row.status || 'status unknown'})`,
    timestamp: normalizeTime(row.created_at || row.onset_date),
    payload: row,
  }));
}

async function getTimelineNews2(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'recorded_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, respiration_rate, spo2, temperature, systolic_bp, heart_rate,
            consciousness, total_score, clinical_risk, escalation_action,
            recorded_by, recorded_at
     FROM news2_scores
     WHERE ${conditions.join(' AND ')}
     ORDER BY recorded_at DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'vitals',
    sub_type: 'news2',
    id: row.id,
    summary: `NEWS2 ${row.total_score} (${row.clinical_risk || 'risk unknown'})`,
    timestamp: normalizeTime(row.recorded_at),
    payload: row,
  }));
}

async function getTimelineVitals(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'recorded_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, encounter_id, heart_rate, systolic_bp, diastolic_bp, temperature,
            spo2, respiratory_rate, blood_glucose, pain_score, gcs_score,
            consciousness, recorded_by, recorded_at
     FROM vitals_chart
     WHERE ${conditions.join(' AND ')}
     ORDER BY recorded_at DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'vitals',
    sub_type: 'chart',
    id: row.id,
    encounter_id: row.encounter_id,
    summary: `Vitals HR ${row.heart_rate ?? '-'}, BP ${row.systolic_bp ?? '-'}/${row.diastolic_bp ?? '-'}, SpO2 ${row.spo2 ?? '-'}%`,
    timestamp: normalizeTime(row.recorded_at),
    payload: row,
  }));
}

async function getTimelineMedicationAdministrations(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({
    column: 'COALESCE(administered_at, scheduled_time, created_at)',
    params,
    conditions,
    dateFrom,
    dateTo,
  });

  const rows = await optionalQuery(
    `SELECT id, prescription_id, medication_name, dose, dosage, route,
            scheduled_time, administered_at, administered_by, status, notes,
            hold_reason, refusal_reason, created_at
     FROM medication_administrations
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(administered_at, scheduled_time, created_at) DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'medication',
    sub_type: row.status,
    id: row.id,
    summary: `${row.medication_name} ${row.dose || row.dosage || ''} ${row.route || ''} - ${row.status}`,
    timestamp: normalizeTime(row.administered_at || row.scheduled_time || row.created_at),
    payload: row,
  }));
}

async function getTimelineInvestigations(patientUid, dateFrom, dateTo) {
  const conditions = ['(patient_uid = $1::uuid OR uid = $1::uuid)'];
  const params = [patientUid];
  addDateFilters({ column: 'created_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, uid, phone, test_name, test_type, investigation_type, status,
            priority, results, result_summary, interpretation, conclusion,
            requested_by, requested_at, completed_at, created_at
     FROM investigations
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(completed_at, requested_at, created_at) DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'investigation',
    sub_type: row.status,
    id: row.id,
    summary: `${row.test_name || row.test_type || row.investigation_type || 'Investigation'} - ${row.status || 'status unknown'}`,
    timestamp: normalizeTime(row.completed_at || row.requested_at || row.created_at),
    payload: row,
  }));
}

async function getTimelineOrders(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'created_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, order_number, encounter_id, order_type, priority, details, status,
            ordered_by, verified_by, verified_at, start_date, end_date, notes,
            created_at
     FROM clinical_orders
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'clinical_order',
    sub_type: row.order_type,
    id: row.id,
    encounter_id: row.encounter_id,
    summary: `${row.priority || 'routine'} ${row.order_type} order ${row.order_number || ''} - ${row.status}`,
    timestamp: normalizeTime(row.created_at),
    payload: row,
  }));
}

async function getTimelineHandovers(patientUid, dateFrom, dateTo) {
  const conditions = ['patient_uid = $1::uuid'];
  const params = [patientUid];
  addDateFilters({ column: 'created_at', params, conditions, dateFrom, dateTo });

  const rows = await optionalQuery(
    `SELECT id, ward, bed_number, outgoing_nurse, incoming_nurse, shift,
            patient_summary, active_issues, pending_tasks, medications_due,
            special_instructions, acknowledged, acknowledged_at, created_at
     FROM nurse_handovers
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    ...params
  );

  return rows.map((row) => ({
    event_type: 'handover',
    sub_type: row.shift,
    id: row.id,
    summary: `Handover ${row.shift || ''}: ${row.patient_summary || 'summary not documented'}`,
    timestamp: normalizeTime(row.created_at),
    payload: row,
  }));
}

export async function getPatientTimeline(patientUid, {
  dateFrom = null,
  dateTo = null,
  limit = DEFAULT_LIMIT,
  sort = 'desc',
} = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');

  const [
    admissions,
    notes,
    diagnoses,
    news2,
    vitals,
    medications,
    investigations,
    orders,
    handovers,
  ] = await Promise.all([
    getTimelineAdmissions(patientUid, dateFrom, dateTo),
    getTimelineNotes(patientUid, dateFrom, dateTo),
    getTimelineDiagnoses(patientUid, dateFrom, dateTo),
    getTimelineNews2(patientUid, dateFrom, dateTo),
    getTimelineVitals(patientUid, dateFrom, dateTo),
    getTimelineMedicationAdministrations(patientUid, dateFrom, dateTo),
    getTimelineInvestigations(patientUid, dateFrom, dateTo),
    getTimelineOrders(patientUid, dateFrom, dateTo),
    getTimelineHandovers(patientUid, dateFrom, dateTo),
  ]);

  const sorter = sort === 'asc' ? oldestFirst : newestFirst;
  return [
    ...admissions,
    ...notes,
    ...diagnoses,
    ...news2,
    ...vitals,
    ...medications,
    ...investigations,
    ...orders,
    ...handovers,
  ]
    .filter((event) => event.timestamp)
    .sort(sorter)
    .slice(0, clampLimit(limit));
}

export async function collectAdmissionClinicalContext(admissionId) {
  const admission = await getAdmission(admissionId);
  if (!admission) throw AppError.notFound('Admission not found');

  const patient = await getPatient(admission.patient_uid);
  const dateFrom = admission.admitted_at || admission.created_at || null;
  const dateTo = admission.discharged_at || null;
  const timeline = await getPatientTimeline(admission.patient_uid, {
    dateFrom,
    dateTo,
    sort: 'asc',
    limit: MAX_LIMIT,
  });

  const byType = (type) => timeline.filter((event) => event.event_type === type);
  const allergies = await optionalQuery(
    `SELECT id, allergen, name, NULL AS allergy_name, severity, reaction, status, created_at
     FROM allergies
     WHERE patient_uid = $1::uuid
     UNION ALL
     SELECT id, NULL AS allergen, NULL AS name, allergy_name, severity, reaction,
            CASE WHEN is_active THEN 'active' ELSE 'inactive' END AS status, created_at
     FROM patient_allergies
     WHERE patient_uid = $1::uuid
     ORDER BY created_at DESC`,
    admission.patient_uid
  );

  return {
    patient,
    admission,
    allergies,
    timeline,
    notes: byType('clinical_note'),
    diagnoses: byType('diagnosis'),
    vitals: byType('vitals'),
    medications: byType('medication'),
    investigations: byType('investigation'),
    orders: byType('clinical_order'),
    handovers: byType('handover'),
    citations: timeline.map(makeCitation),
  };
}

export async function createDowntimeSnapshot(patientUid, generatedBy, { scope = 'patient_chart', hoursToLive = 12 } = {}) {
  const patient = await getPatient(patientUid);
  if (!patient) throw AppError.notFound('Patient not found');

  const timeline = await getPatientTimeline(patientUid, {
    limit: 300,
    sort: 'desc',
  });
  const expiresAt = new Date(Date.now() + Math.max(1, hoursToLive) * 60 * 60 * 1000).toISOString();
  const payload = {
    generated_at: new Date().toISOString(),
    patient,
    timeline,
  };

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO downtime_snapshots
       (patient_uid, scope, generated_by, payload, expires_at, created_at)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5::timestamptz, NOW())
     RETURNING id, patient_uid, scope, payload, expires_at, created_at`,
    patientUid,
    scope,
    generatedBy || null,
    JSON.stringify(payload),
    expiresAt
  );

  return rows[0];
}

export default {
  getPatientTimeline,
  collectAdmissionClinicalContext,
  createDowntimeSnapshot,
};
