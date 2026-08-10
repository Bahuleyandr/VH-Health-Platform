import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { getHospitalNumberMap } from '../patient/patientIdentifierService.js';

const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 1000;

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), MAX_LIMIT);
}

// Some optional EMR tables/columns may not exist in older databases (the
// pre-ORM `optionalQuery` helper swallowed those errors). Mirror that
// behaviour for the typed Prisma calls — both raw `relation/column does
// not exist` strings and Prisma's `P2021`/`P2022` codes mean "skip me".
function isMissingSchemaError(err) {
  const message = String(err?.message || '');
  if (/does not exist|column .* does not exist|relation .* does not exist/i.test(message)) return true;
  const code = err?.code;
  return code === 'P2021' || code === 'P2022';
}

async function optionalFindMany(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isMissingSchemaError(err)) {
      logger.warn('Optional clinical timeline source skipped', { source: label, error: err.message });
      return [];
    }
    throw err;
  }
}

// Defense-in-depth tenant scoping for the timeline loaders. When a tenantId
// is threaded down from collectAdmissionClinicalContext, add it to the
// loader's where so a tenant-blind patient_uid can never surface another
// tenant's rows at the AI-context chokepoint. Each of these tables carries a
// tenant_id column. Omitting tenantId (legacy callers) keeps the prior
// patient_uid-only filter.
function withTenantScope(where, tenantId) {
  return tenantId ? { ...where, tenant_id: tenantId } : where;
}

// Translate a {dateFrom, dateTo} pair (ISO strings or Date instances) into
// a Prisma timestamp filter. Both bounds optional.
function buildDateFilter(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return undefined;
  const filter = {};
  if (dateFrom) filter.gte = dateFrom instanceof Date ? dateFrom : new Date(dateFrom);
  if (dateTo) filter.lte = dateTo instanceof Date ? dateTo : new Date(dateTo);
  return filter;
}

function stringifySummary(value, fallback = 'No details recorded') {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const preferred = value.summary
      || value.chief_complaint
      || value.diagnosis
      || value.assessment
      || value.plan
      || value.hospital_course
      || value.notes;
    if (preferred) return String(preferred);
    return JSON.stringify(value).slice(0, 240);
  }
  return String(value);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function medicationSummaryFromOrder(row) {
  const details = parseJsonObject(row.details);
  const name = details.medication_name || details.name || details.medication || details.drug_name || 'Medication';
  const dose = details.dose || details.dosage || '';
  const route = details.route || row.route || '';
  const frequency = details.frequency || details.dosage_frequency || details.freq || '';
  return [name, dose, route, frequency]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
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

export function makeCitation(event) {
  return {
    source_type: event.event_type,
    source_id: event.id ? String(event.id) : null,
    timestamp: event.timestamp,
    label: event.summary,
  };
}

async function getPatient(patientUid) {
  return prisma.users.findUnique({
    where: { uid: patientUid },
    select: {
      uid: true,
      phone: true,
      name: true,
      gender: true,
      email: true,
      birthday: true,
      address: true,
      // Wave-4B-1 (migration 209) — chronic meds surface for discharge
      // reconciliation. Defaulted to '[]'::jsonb on insert so patients
      // without entries still serialise cleanly.
      chronic_medications: true,
      chronic_medications_updated_at: true,
    },
  });
}

async function getAdmission(admissionId, tenantId = null) {
  // Defense-in-depth tenant scoping at the chokepoint. When tenantId is
  // supplied, require the admission to belong to it (findFirst with a
  // composite where), so a tenant-blind id can never resolve another tenant's
  // admission. Legacy callers that omit tenantId keep the unscoped lookup.
  return prisma.admissions.findFirst({
    where: tenantId ? { id: admissionId, tenant_id: tenantId } : { id: admissionId },
    select: {
      id: true,
      tenant_id: true,
      encounter_id: true,
      from_er_visit_id: true,
      er_arrival_at: true,
      patient_uid: true,
      status: true,
      priority: true,
      admission_type: true,
      reason: true,
      reason_for_admission: true,
      chief_complaint: true,
      admitting_diagnosis: true,
      admitting_doctor: true,
      attending_doctor: true,
      department: true,
      ward: true,
      bed_id: true,
      bed_number: true,
      code_status: true,
      expected_los_days: true,
      admitted_at: true,
      discharged_at: true,
      discharge_type: true,
      discharge_summary: true,
      created_at: true,
    },
  });
}

async function getTimelineAdmissions(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.admitted_at = dateFilter;

  const rows = await optionalFindMany('admissions', () => prisma.admissions.findMany({
    where,
    select: {
      id: true,
      encounter_id: true,
      status: true,
      priority: true,
      admission_type: true,
      department: true,
      ward: true,
      bed_number: true,
      chief_complaint: true,
      admitting_diagnosis: true,
      admitted_at: true,
      discharged_at: true,
      discharge_type: true,
      created_at: true,
    },
    // Mirror SQL ORDER BY admitted_at DESC NULLS LAST.
    orderBy: { admitted_at: { sort: 'desc', nulls: 'last' } },
  }));

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

async function getTimelineNotes(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('clinical_notes', () => prisma.clinical_notes.findMany({
    where,
    select: {
      id: true,
      encounter_id: true,
      appointment_id: true,
      note_type: true,
      title: true,
      content: true,
      author_uid: true,
      author_role: true,
      is_addendum: true,
      is_signed: true,
      signed_at: true,
      created_at: true,
    },
    orderBy: { created_at: 'desc' },
  }));

  return rows.map((row) => ({
    event_type: 'clinical_note',
    sub_type: row.note_type,
    id: row.id,
    encounter_id: row.encounter_id,
    appointment_id: row.appointment_id,
    summary: `${String(row.note_type || 'note').toUpperCase()}: ${stringifySummary(row.content, row.title || 'Clinical note')}`,
    timestamp: normalizeTime(row.created_at),
    payload: row,
  }));
}

async function getTimelineDiagnoses(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('diagnoses', () => prisma.diagnoses.findMany({
    where,
    select: {
      id: true,
      encounter_id: true,
      icd10_code: true,
      icd10_description: true,
      description: true,
      diagnosis_type: true,
      status: true,
      severity: true,
      diagnosed_by: true,
      onset_date: true,
      resolved_date: true,
      created_at: true,
    },
    orderBy: { created_at: 'desc' },
  }));

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

async function getTimelineNews2(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid, superseded_at: null }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.recorded_at = dateFilter;

  const rows = await optionalFindMany('news2_scores', () => prisma.news2_scores.findMany({
    where,
    select: {
      id: true,
      respiration_rate: true,
      spo2: true,
      temperature: true,
      systolic_bp: true,
      heart_rate: true,
      consciousness: true,
      total_score: true,
      clinical_risk: true,
      escalation_action: true,
      recorded_by: true,
      recorded_at: true,
    },
    orderBy: { recorded_at: 'desc' },
  }));

  return rows.map((row) => ({
    event_type: 'vitals',
    sub_type: 'news2',
    id: row.id,
    summary: `NEWS2 ${row.total_score} (${row.clinical_risk || 'risk unknown'})`,
    timestamp: normalizeTime(row.recorded_at),
    payload: row,
  }));
}

async function getTimelineVitals(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.recorded_at = dateFilter;

  const rows = await optionalFindMany('vitals_chart', () => prisma.vitals_chart.findMany({
    where,
    select: {
      id: true,
      encounter_id: true,
      heart_rate: true,
      systolic_bp: true,
      diastolic_bp: true,
      temperature: true,
      spo2: true,
      respiratory_rate: true,
      blood_glucose: true,
      pain_score: true,
      gcs_score: true,
      consciousness: true,
      recorded_by: true,
      recorded_at: true,
    },
    orderBy: { recorded_at: 'desc' },
  }));

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

async function getTimelineMedicationAdministrations(patientUid, dateFrom, dateTo, tenantId = null) {
  // Pre-ORM SQL filtered + ordered on COALESCE(administered_at,
  // scheduled_time, created_at). Prisma can't express that aggregate in
  // a where-clause, so fetch the row's three timestamps and apply the
  // coalesce + range filter + sort in JS. Date bounds are usually loose
  // (caller-supplied) so the post-filter still scales fine for an
  // individual patient's medication history.
  const rows = await optionalFindMany('medication_administrations', () => prisma.medication_administrations.findMany({
    where: withTenantScope({ patient_uid: patientUid }, tenantId),
    select: {
      id: true,
      prescription_id: true,
      medication_name: true,
      dose: true,
      dosage: true,
      route: true,
      scheduled_time: true,
      administered_at: true,
      administered_by: true,
      status: true,
      notes: true,
      hold_reason: true,
      refusal_reason: true,
      created_at: true,
    },
  }));

  const fromMs = dateFrom ? new Date(dateFrom).getTime() : null;
  const toMs = dateTo ? new Date(dateTo).getTime() : null;

  return rows
    .map((row) => {
      const ts = row.administered_at || row.scheduled_time || row.created_at;
      return { row, ts, tsMs: ts ? new Date(ts).getTime() : null };
    })
    .filter(({ tsMs }) => {
      if (tsMs == null) return false;
      if (fromMs != null && tsMs < fromMs) return false;
      if (toMs != null && tsMs > toMs) return false;
      return true;
    })
    .sort((a, b) => b.tsMs - a.tsMs)
    .map(({ row, ts }) => ({
      event_type: 'medication',
      sub_type: row.status,
      id: row.id,
      summary: `${row.medication_name} ${row.dose || row.dosage || ''} ${row.route || ''} - ${row.status}`,
      timestamp: normalizeTime(ts),
      payload: row,
    }));
}

async function getTimelinePrescriptions(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('e_prescriptions', () => prisma.e_prescriptions.findMany({
    where,
    select: {
      id: true,
      appointment_id: true,
      admission_id: true,
      visit_type: true,
      prescription_number: true,
      diagnosis: true,
      clinical_notes: true,
      medications: true,
      status: true,
      lifecycle_status: true,
      revision: true,
      signed_at: true,
      locked_at: true,
      created_at: true,
      updated_at: true,
    },
    orderBy: { created_at: 'desc' },
  }));

  return rows.map((row) => {
    const meds = Array.isArray(row.medications) ? row.medications : [];
    const medNames = meds
      .slice(0, 3)
      .map((med) => med?.display_name || med?.medication_name || med?.name)
      .filter(Boolean)
      .join(', ');
    return {
      event_type: 'prescription',
      sub_type: row.lifecycle_status || row.status || row.visit_type || 'e_prescription',
      id: row.id,
      appointment_id: row.appointment_id,
      admission_id: row.admission_id,
      summary: `${row.prescription_number || 'Prescription'}${row.diagnosis ? `: ${row.diagnosis}` : ''}${medNames ? ` — ${medNames}` : ''}`,
      timestamp: normalizeTime(row.updated_at || row.created_at),
      payload: row,
    };
  });
}

async function getTimelineInvestigations(patientUid, dateFrom, dateTo, tenantId = null) {
  // Pre-ORM SQL: WHERE (patient_uid = $1::uuid OR uid = $1::uuid) — both
  // columns hold the patient uuid in different row-vintages. Mirror with
  // Prisma `OR`. tenant_id (when supplied) ANDs with the OR.
  const where = withTenantScope({
    OR: [{ patient_uid: patientUid }, { uid: patientUid }],
  }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('investigations', () => prisma.investigations.findMany({
    where,
    select: {
      id: true,
      appointment_id: true,
      uid: true,
      phone: true,
      test_name: true,
      test_type: true,
      investigation_type: true,
      status: true,
      priority: true,
      results: true,
      result_summary: true,
      interpretation: true,
      conclusion: true,
      requested_by: true,
      requested_at: true,
      completed_at: true,
      created_at: true,
    },
  }));

  // Original ORDER BY COALESCE(completed_at, requested_at, created_at) DESC.
  return rows
    .map((row) => ({
      row,
      ts: row.completed_at || row.requested_at || row.created_at,
    }))
    .sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0))
    .map(({ row, ts }) => ({
      event_type: 'investigation',
      sub_type: row.status,
      id: row.id,
      appointment_id: row.appointment_id,
      summary: `${row.test_name || row.test_type || row.investigation_type || 'Investigation'} - ${row.status || 'status unknown'}`,
      timestamp: normalizeTime(ts),
      payload: row,
    }));
}

async function getTimelineOrders(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('clinical_orders', () => prisma.clinical_orders.findMany({
    where,
    select: {
      id: true,
      order_number: true,
      encounter_id: true,
      order_type: true,
      priority: true,
      details: true,
      status: true,
      ordered_by: true,
      verified_by: true,
      verified_at: true,
      start_date: true,
      end_date: true,
      notes: true,
      created_at: true,
    },
    orderBy: { created_at: 'desc' },
  }));

  return rows.map((row) => ({
    event_type: row.order_type === 'medication' ? 'drug_chart' : 'clinical_order',
    sub_type: row.order_type,
    id: row.id,
    encounter_id: row.encounter_id,
    summary: row.order_type === 'medication'
      ? `Drug chart: ${medicationSummaryFromOrder(row)} - ${row.status}`
      : `${row.priority || 'routine'} ${row.order_type} order ${row.order_number || ''} - ${row.status}`,
    timestamp: normalizeTime(row.created_at),
    payload: row,
  }));
}

async function getTimelineHandovers(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('nurse_handovers', () => prisma.nurse_handovers.findMany({
    where,
    select: {
      id: true,
      ward: true,
      bed_number: true,
      outgoing_nurse: true,
      incoming_nurse: true,
      shift: true,
      patient_summary: true,
      active_issues: true,
      pending_tasks: true,
      medications_due: true,
      special_instructions: true,
      acknowledged: true,
      acknowledged_at: true,
      created_at: true,
    },
    orderBy: { created_at: 'desc' },
  }));

  return rows.map((row) => ({
    event_type: 'handover',
    sub_type: row.shift,
    id: row.id,
    summary: `Handover ${row.shift || ''}: ${row.patient_summary || 'summary not documented'}`,
    timestamp: normalizeTime(row.created_at),
    payload: row,
  }));
}

async function getTimelineReferrals(patientUid, dateFrom, dateTo, tenantId = null) {
  const where = withTenantScope({ patient_uid: patientUid }, tenantId);
  const dateFilter = buildDateFilter(dateFrom, dateTo);
  if (dateFilter) where.created_at = dateFilter;

  const rows = await optionalFindMany('referrals', () => prisma.referrals.findMany({
    where,
    select: {
      id: true,
      referral_number: true,
      patient_uid: true,
      encounter_id: true,
      referring_doctor: true,
      referred_to_doctor: true,
      referred_to_department: true,
      referral_type: true,
      reason: true,
      urgency: true,
      clinical_summary: true,
      status: true,
      accepted_by: true,
      accepted_at: true,
      completed_at: true,
      response_notes: true,
      first_seen_at: true,
      first_seen_by: true,
      request_context: true,
      source: true,
      created_at: true,
      updated_at: true,
    },
    orderBy: { created_at: 'desc' },
  }));

  return rows.map((row) => {
    const requestContext = parseJsonObject(row.request_context);
    const appointmentId = Number.parseInt(requestContext.appointment_id || requestContext.appointmentId, 10);
    const timestamp = row.completed_at || row.accepted_at || row.first_seen_at || row.created_at;
    const toLabel = row.referred_to_department || row.referred_to_doctor || 'specialist';
    return {
      event_type: 'referral',
      sub_type: row.status || row.urgency || row.referral_type,
      id: row.id,
      encounter_id: row.encounter_id,
      appointment_id: Number.isInteger(appointmentId) ? appointmentId : null,
      summary: `Referral to ${toLabel}: ${row.reason || row.clinical_summary || row.status || 'reason not documented'}`,
      timestamp: normalizeTime(timestamp),
      payload: row,
    };
  });
}

// Pre-ORM admission-context allergy lookup did `allergies UNION ALL
// patient_allergies` to merge the two co-existing allergy tables (legacy
// + newer patient-facing one) into one shape. Replicate with two parallel
// findMany calls + JS merge that preserves the same column shape /
// ordering as the union.
async function getCombinedAllergies(patientUid) {
  const [allergyRows, patientAllergyRows] = await Promise.all([
    optionalFindMany('allergies', () => prisma.allergies.findMany({
      where: { patient_uid: patientUid },
      select: {
        id: true,
        allergen: true,
        name: true,
        severity: true,
        reaction: true,
        status: true,
        created_at: true,
      },
    })),
    optionalFindMany('patient_allergies', () => prisma.patient_allergies.findMany({
      where: { patient_uid: patientUid },
      select: {
        id: true,
        allergy_name: true,
        severity: true,
        reaction: true,
        is_active: true,
        created_at: true,
      },
    })),
  ]);

  const merged = [
    ...allergyRows.map((row) => ({
      id: row.id,
      allergen: row.allergen,
      name: row.name,
      allergy_name: null,
      severity: row.severity,
      reaction: row.reaction,
      status: row.status,
      created_at: row.created_at,
    })),
    ...patientAllergyRows.map((row) => ({
      id: row.id,
      allergen: null,
      name: null,
      allergy_name: row.allergy_name,
      severity: row.severity,
      reaction: row.reaction,
      // Pre-ORM: CASE WHEN is_active THEN 'active' ELSE 'inactive' END.
      status: row.is_active ? 'active' : 'inactive',
      created_at: row.created_at,
    })),
  ];

  // ORDER BY created_at DESC, NULLS last to mirror Postgres default.
  return merged.sort((a, b) => {
    const aTs = a.created_at ? new Date(a.created_at).getTime() : null;
    const bTs = b.created_at ? new Date(b.created_at).getTime() : null;
    if (aTs == null && bTs == null) return 0;
    if (aTs == null) return 1;
    if (bTs == null) return -1;
    return bTs - aTs;
  });
}

async function getAdmissionDoctors(admission, timeline) {
  const noteDoctorRoles = new Set(['DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']);
  const doctorUids = Array.from(new Set([
    admission.admitting_doctor,
    admission.attending_doctor,
    ...timeline
      .filter((event) => event.event_type === 'clinical_note')
      .filter((event) => noteDoctorRoles.has(String(event.payload?.author_role || '').toUpperCase()))
      .map((event) => event.payload?.author_uid),
  ].filter(Boolean)));

  if (!doctorUids.length) return [];

  const users = await optionalFindMany('users.doctors', () => prisma.users.findMany({
    where: { uid: { in: doctorUids } },
    select: { id: true, uid: true, name: true, role: true },
  }));
  const usersByUid = new Map(users.map((user) => [user.uid, user]));
  const userIds = users.map((user) => user.id).filter((id) => id != null);

  const [doctorProfiles, staffProfiles] = await Promise.all([
    userIds.length
      ? optionalFindMany('doctors', () => prisma.doctors.findMany({
          where: { user_id: { in: userIds } },
          select: {
            user_id: true,
            name: true,
            specialty: true,
            qualifications: true,
            department: true,
          },
        }))
      : [],
    optionalFindMany('staff.doctors', () => prisma.staff.findMany({
      where: { user_id: { in: doctorUids } },
      select: {
        user_id: true,
        name: true,
        designation: true,
        position: true,
        department: true,
      },
    })),
  ]);

  const doctorProfileByUserId = new Map(doctorProfiles.map((profile) => [profile.user_id, profile]));
  const staffProfileByUid = new Map(staffProfiles.map((profile) => [profile.user_id, profile]));

  return doctorUids.map((uid) => {
    const user = usersByUid.get(uid);
    const doctorProfile = user?.id != null ? doctorProfileByUserId.get(user.id) : null;
    const staffProfile = staffProfileByUid.get(uid);
    const name = user?.name || doctorProfile?.name || staffProfile?.name || uid;
    const designation = [
      doctorProfile?.qualifications,
      doctorProfile?.specialty || staffProfile?.designation || staffProfile?.position,
      doctorProfile?.department || staffProfile?.department,
    ].filter(Boolean).join(', ');

    return {
      uid,
      name,
      designation: designation || user?.role || 'Doctor',
      role: uid === admission.admitting_doctor
        ? 'primary_consultant'
        : uid === admission.attending_doctor
          ? 'attending_doctor'
          : 'rounding_doctor',
    };
  });
}

export async function getPatientTimeline(patientUid, {
  dateFrom = null,
  dateTo = null,
  limit = DEFAULT_LIMIT,
  sort = 'desc',
  tenantId = null,
} = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');

  const [
    admissions,
    notes,
    diagnoses,
    news2,
    vitals,
    medications,
    prescriptions,
    investigations,
    orders,
    handovers,
    referrals,
  ] = await Promise.all([
    getTimelineAdmissions(patientUid, dateFrom, dateTo, tenantId),
    getTimelineNotes(patientUid, dateFrom, dateTo, tenantId),
    getTimelineDiagnoses(patientUid, dateFrom, dateTo, tenantId),
    getTimelineNews2(patientUid, dateFrom, dateTo, tenantId),
    getTimelineVitals(patientUid, dateFrom, dateTo, tenantId),
    getTimelineMedicationAdministrations(patientUid, dateFrom, dateTo, tenantId),
    getTimelinePrescriptions(patientUid, dateFrom, dateTo, tenantId),
    getTimelineInvestigations(patientUid, dateFrom, dateTo, tenantId),
    getTimelineOrders(patientUid, dateFrom, dateTo, tenantId),
    getTimelineHandovers(patientUid, dateFrom, dateTo, tenantId),
    getTimelineReferrals(patientUid, dateFrom, dateTo, tenantId),
  ]);

  const sorter = sort === 'asc' ? oldestFirst : newestFirst;
  return [
    ...admissions,
    ...notes,
    ...diagnoses,
    ...news2,
    ...vitals,
    ...medications,
    ...prescriptions,
    ...investigations,
    ...orders,
    ...handovers,
    ...referrals,
  ]
    .filter((event) => event.timestamp)
    .sort(sorter)
    .slice(0, clampLimit(limit));
}

export async function collectAdmissionClinicalContext(admissionId, tenantId = null) {
  // Defense-in-depth tenant scoping at the AI-context chokepoint (~15 AI
  // services consume this). When the caller threads its tenantId, the
  // admission lookup is tenant-scoped (a foreign-tenant id → 404) and the
  // same tenantId flows into every downstream timeline loader + the
  // radiology pull. We then prefer the explicit param but fall back to the
  // resolved admission's own tenant_id so the timeline loaders stay scoped
  // even for legacy callers that only pass the admissionId.
  const admission = await getAdmission(admissionId, tenantId);
  if (!admission) throw AppError.notFound('Admission not found');

  const scopeTenantId = tenantId || admission.tenant_id || null;

  const patient = await getPatient(admission.patient_uid);
  if (patient?.uid) {
    const hospitalNumbers = await getHospitalNumberMap({
      tenantId: admission.tenant_id,
      patientUids: [patient.uid],
    });
    const hospitalNumber = hospitalNumbers.get(patient.uid);
    if (hospitalNumber) {
      patient.hospital_number = hospitalNumber;
      patient.mrn = hospitalNumber;
    }
  }
  const dateFrom = admission.from_er_visit_id && admission.er_arrival_at
    ? admission.er_arrival_at
    : admission.admitted_at || admission.created_at || null;
  const dateTo = admission.discharged_at || null;
  const timeline = await getPatientTimeline(admission.patient_uid, {
    dateFrom,
    dateTo,
    sort: 'asc',
    limit: MAX_LIMIT,
    tenantId: scopeTenantId,
  });

  const byType = (type) => timeline.filter((event) => event.event_type === type);
  const allergies = await getCombinedAllergies(admission.patient_uid);

  // Wave-4B-1 — pull radiology orders for the discharge readiness gate
  // and the discharge-summary PENDING_RADIOLOGY safety flag. `radiology_orders`
  // lives in a sibling table to `investigations`, so it's invisible to the
  // existing timeline collectors. Findings:
  //   2026-05-10-inpatient-admission-discharge-pending-radiology-not-in-readiness
  //   2026-05-10-inpatient-admission-discharge-drug-reconciliation-drops-chronic-meds
  const radiology_orders = await optionalFindMany('radiology_orders', () =>
    prisma.radiology_orders.findMany({
      where: withTenantScope({
        patient_uid: admission.patient_uid,
        created_at: dateFrom ? { gte: dateFrom } : undefined,
      }, scopeTenantId),
      select: {
        id: true, modality: true, body_part: true, status: true,
        ordered_by: true, created_at: true, report_completed_at: true,
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    }),
  );

  // Normalise chronic_medications JSON into a plain array (the Prisma Json
  // type returns the object directly; in the unlikely case it's a string,
  // parse defensively).
  let chronic_medications = patient?.chronic_medications;
  if (typeof chronic_medications === 'string') {
    try { chronic_medications = JSON.parse(chronic_medications); }
    catch { chronic_medications = []; }
  }
  if (!Array.isArray(chronic_medications)) chronic_medications = [];

  const attending_doctors = await getAdmissionDoctors(admission, timeline);

  return {
    patient,
    admission,
    attending_doctors,
    allergies,
    timeline,
    notes: byType('clinical_note'),
    diagnoses: byType('diagnosis'),
    vitals: byType('vitals'),
    medications: byType('medication'),
    investigations: byType('investigation'),
    orders: byType('clinical_order'),
    handovers: byType('handover'),
    radiology_orders,
    chronic_medications,
    context_window_from: dateFrom,
    citations: timeline.map(makeCitation),
  };
}

export async function createDowntimeSnapshot(
  patientUid,
  generatedBy,
  { scope = 'patient_chart', hoursToLive = 12, tenantId = null } = {},
) {
  // Stamp the snapshot with the patient's own tenant. Model-delegate calls
  // like the create below never set the app.current_tenant_id GUC (the
  // prisma proxy only wraps the raw-SQL methods), so the GUC-aware column
  // default on downtime_snapshots.tenant_id would otherwise fall through to
  // the constant default tenant for a non-default-tenant patient.
  // getPatient's shared projection is deliberately left untouched — its
  // result is embedded verbatim in API/snapshot payloads
  // (collectAdmissionClinicalContext's `patient` and this snapshot's
  // `payload.patient`) — so tenant_id is read via a separate narrow lookup.
  const tenantRow = await prisma.users.findFirst({
    where: {
      uid: patientUid,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    select: { tenant_id: true },
  });
  if (!tenantRow) throw AppError.notFound('Patient not found');
  const snapshotTenantId = tenantRow.tenant_id ?? undefined;
  const patient = await getPatient(patientUid);
  if (!patient) throw AppError.notFound('Patient not found');

  const timeline = await getPatientTimeline(patientUid, {
    limit: 300,
    sort: 'desc',
    tenantId: snapshotTenantId,
  });
  const expiresAt = new Date(Date.now() + Math.max(1, hoursToLive) * 60 * 60 * 1000);
  const payload = {
    generated_at: new Date().toISOString(),
    patient,
    timeline,
  };

  return prisma.downtime_snapshots.create({
    data: {
      // undefined (not null) preserves the DB column default as the fallback
      // when the patient row carries no tenant_id.
      tenant_id: snapshotTenantId,
      patient_uid: patientUid,
      scope,
      generated_by: generatedBy || null,
      payload,
      expires_at: expiresAt,
    },
    select: {
      id: true,
      patient_uid: true,
      scope: true,
      payload: true,
      expires_at: true,
      created_at: true,
    },
  });
}

export default {
  getPatientTimeline,
  collectAdmissionClinicalContext,
  createDowntimeSnapshot,
  makeCitation,
};
