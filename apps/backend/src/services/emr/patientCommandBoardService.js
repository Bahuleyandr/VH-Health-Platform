import prisma from '../../lib/prisma.js';
import { getHospitalNumberMap } from '../patient/patientIdentifierService.js';
import { normalizeRole as normalizePlatformRole } from '../../utils/roles.js';
import {
  ACTIVE_ADMISSION_STATUSES,
  applyInpatientAdmissionScope,
  FULL_INPATIENT_SCOPE_ROLES,
  MINIMIZED_INPATIENT_PAYLOAD_ROLES,
  resolveInpatientAdmissionScope,
} from './inpatientScopeService.js';

const CLOSED_ORDER_STATUSES = ['completed', 'cancelled', 'canceled', 'discontinued', 'stopped'];

const DOCTOR_BOARD_ROLES = new Set([
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
]);

const FULL_BOARD_ROLES = FULL_INPATIENT_SCOPE_ROLES;

const MEDICAL_BOARD_ACTION_ROLES = new Set([
  ...DOCTOR_BOARD_ROLES,
  'CMO',
  'MEDICAL_SUPERINTENDENT',
]);

const NURSING_BOARD_ACTION_ROLES = new Set([
  'CNO',
  'ICU_INCHARGE',
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'OP_STAFF_NURSE',
]);

const PHARMACY_BOARD_ACTION_ROLES = new Set([
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
]);

const ROLE_VIEW = {
  DOCTOR: {
    label: 'Doctor ward round',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  CONSULTANT: {
    label: 'Consultant ward round',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  DUTY_DOCTOR: {
    label: 'Duty doctor ward round',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  NURSING_STAFF: {
    label: 'Nursing board',
    visible_sections: ['summary', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  NURSING_INCHARGE: {
    label: 'Nursing command',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  CNO: {
    label: 'Nursing superintendent command',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  MEDICAL_SUPERINTENDENT: {
    label: 'Medical superintendent command',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  },
  PHARMACY_STAFF: {
    label: 'Pharmacy IP board',
    visible_sections: ['summary', 'allergies', 'tasks', 'discharge', 'actions'],
  },
  PHARMACY_INCHARGE: {
    label: 'Pharmacy command',
    visible_sections: ['summary', 'allergies', 'tasks', 'discharge', 'actions'],
  },
  HOUSEKEEPING_STAFF: {
    label: 'Housekeeping floor board',
    visible_sections: ['summary', 'location', 'discharge'],
  },
  HOUSEKEEPING_INCHARGE: {
    label: 'Housekeeping command',
    visible_sections: ['summary', 'location', 'discharge'],
  },
  RECEPTIONIST: {
    label: 'Admission desk board',
    visible_sections: ['summary', 'location', 'discharge'],
  },
};

function normalizeRole(role) {
  return normalizePlatformRole(role) || '';
}

function shouldMinimizePayload(role) {
  return MINIMIZED_INPATIENT_PAYLOAD_ROLES.has(normalizeRole(role));
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minutesBetween(start, end = new Date()) {
  const started = asDate(start);
  if (!started) return null;
  return Math.max(0, Math.floor((end.getTime() - started.getTime()) / 60000));
}

function losDays(admittedAt, dischargedAt = null) {
  const started = asDate(admittedAt);
  if (!started) return null;
  const ended = asDate(dischargedAt) || new Date();
  return Math.max(1, Math.ceil((ended.getTime() - started.getTime()) / 86400000));
}

function ageBand(minutes) {
  if (minutes == null) return { band: 'unknown', label: 'No timestamp', color: 'grey' };
  if (minutes < 60) return { band: 'new', label: '<1h', color: 'blue' };
  if (minutes < 240) return { band: 'watch', label: '1-4h', color: 'green' };
  if (minutes < 720) return { band: 'delayed', label: '4-12h', color: 'orange' };
  return { band: 'overdue', label: '>12h', color: 'red' };
}

function priorityMeta(priority, dischargeInitiated = false) {
  const normalized = String(priority || '').toLowerCase();
  if (dischargeInitiated) {
    return {
      value: normalized || 'routine',
      label: 'Discharge initiated',
      band: 'discharge',
      color: 'orange',
      sort_weight: 2,
    };
  }
  if (['emergent', 'emergency', 'resus', 'critical'].includes(normalized)) {
    return { value: normalized, label: 'Emergency', band: 'critical', color: 'red', sort_weight: 0 };
  }
  if (['urgent', 'high'].includes(normalized)) {
    return { value: normalized, label: 'Urgent', band: 'urgent', color: 'orange', sort_weight: 1 };
  }
  return { value: normalized || 'routine', label: 'Routine', band: 'routine', color: 'green', sort_weight: 3 };
}

function compactText(value) {
  return String(value || '').trim();
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function allergyName(row) {
  return compactText(row?.allergy || row?.allergy_name || row?.allergen || row?.name);
}

function buildAllergies({ admission, patient, fhirAllergies, lookupAllergies }) {
  const entries = [];
  for (const allergy of admission.allergies || []) {
    const name = compactText(allergy);
    if (name) entries.push({ name, severity: null, reaction: null, source: 'admission' });
  }
  const profileAllergies = compactText(patient?.allergies);
  if (profileAllergies) {
    for (const name of profileAllergies.split(',').map((part) => part.trim()).filter(Boolean)) {
      entries.push({ name, severity: null, reaction: null, source: 'patient_profile' });
    }
  }
  for (const row of fhirAllergies || []) {
    const name = allergyName(row);
    if (name) {
      entries.push({
        name,
        severity: row.severity || null,
        reaction: row.reaction || null,
        source: 'allergies',
      });
    }
  }
  for (const row of lookupAllergies || []) {
    const name = allergyName(row);
    if (name) {
      entries.push({
        name,
        severity: row.severity || null,
        reaction: row.reaction || null,
        source: 'patient_allergies',
      });
    }
  }
  return uniqueByKey(entries, (item) => item.name.toLowerCase()).slice(0, 8);
}

function displayDiagnosis(admission, diagnoses = []) {
  const active = diagnoses.find((d) => String(d.status || '').toLowerCase() === 'active') || diagnoses[0];
  const admissionDx = compactText(admission.admitting_diagnosis);
  const diagnosis = active?.description || active?.icd10_description || admissionDx || null;
  const status = active?.status || (diagnosis ? 'working' : 'missing');
  const type = active?.diagnosis_type || (admissionDx ? 'working' : null);
  return {
    text: diagnosis,
    status,
    type,
    code: active?.icd10_code || null,
    source: active ? 'diagnosis_table' : admissionDx ? 'admission' : 'none',
    chief_complaint: compactText(admission.chief_complaint) || null,
  };
}

function orderTaskTitle(order) {
  const details = order.details && typeof order.details === 'object' ? order.details : {};
  return compactText(
    details.medication_name
      || details.drug_name
      || details.test_name
      || details.name
      || details.text
      || order.notes
      || order.order_type,
  );
}

function buildTaskOverlay(orders = [], dischargeConsults = []) {
  const openOrders = orders.filter((order) =>
    !CLOSED_ORDER_STATUSES.includes(String(order.status || '').toLowerCase()));
  const pendingConsults = dischargeConsults.filter((item) => !item.completed_at);
  const items = [
    ...openOrders.slice(0, 4).map((order) => ({
      id: `order:${order.id}`,
      kind: order.order_type || 'order',
      label: orderTaskTitle(order),
      status: order.status || 'ordered',
      priority: order.priority || 'routine',
      created_at: order.created_at,
      route: order.order_type === 'medication' ? 'drug_chart' : 'orders',
    })),
    ...pendingConsults.slice(0, 4).map((item) => ({
      id: `discharge:${item.id}`,
      kind: 'discharge_work_item',
      label: String(item.consult_type || '').replace(/_/g, ' '),
      status: 'pending',
      priority: 'routine',
      created_at: item.requested_at,
      route: 'discharge_hub',
    })),
  ].slice(0, 6);

  return {
    open_count: openOrders.length + pendingConsults.length,
    open_order_count: openOrders.length,
    discharge_work_item_count: pendingConsults.length,
    items,
  };
}

function buildDischargeOverlay(admission, summary, dischargeConsults = []) {
  const initiated = Boolean(admission.discharge_initiated_at);
  const signed = Boolean(admission.summary_signed_at || summary?.is_signed);
  const pendingItems = dischargeConsults.filter((item) => !item.completed_at).length;
  const totalItems = dischargeConsults.length;
  return {
    initiated,
    initiated_at: admission.discharge_initiated_at || null,
    summary_signed: signed,
    summary_signed_at: admission.summary_signed_at || summary?.signed_at || null,
    pending_work_items: pendingItems,
    total_work_items: totalItems,
    checklist_state: !initiated
      ? 'not_started'
      : signed && pendingItems === 0
        ? 'ready'
        : 'pending',
    signed_summary_route: `/emr/discharge/${admission.id}`,
    discharge_hub_route: `/emr/discharge-hub/${admission.id}`,
  };
}

function actionsForRole(role, admission) {
  const patient = admission.patient_uid;
  const id = admission.id;
  const base = [];
  if (!patient) return base;

  if (MEDICAL_BOARD_ACTION_ROLES.has(role)) {
    base.push(
      { key: 'notes', label: 'Progress notes', route: `/emr/notes/${patient}` },
      { key: 'orders', label: 'Orders', route: `/emr/orders/${patient}` },
      { key: 'drug_chart', label: 'Drug chart', route: `/drug-chart/${id}` },
      { key: 'case_sheet', label: 'Case sheet', route: `/emr/case-sheet/${id}` },
      { key: 'discharge', label: 'Discharge', route: `/emr/discharge-hub/${id}` },
    );
  } else if (NURSING_BOARD_ACTION_ROLES.has(role)) {
    base.push(
      { key: 'vitals', label: 'Vitals', route: `/emr/vitals/${patient}` },
      { key: 'notes', label: 'Nursing notes', route: `/nursing-notes?patient_uid=${patient}` },
      { key: 'drug_chart', label: 'Drug chart', route: `/drug-chart/${id}` },
      { key: 'handover', label: 'Handover', route: '/handover' },
      { key: 'discharge', label: 'Discharge', route: `/emr/discharge-hub/${id}` },
    );
  } else if (PHARMACY_BOARD_ACTION_ROLES.has(role)) {
    base.push(
      { key: 'drug_chart', label: 'Drug chart', route: `/drug-chart/${id}` },
      { key: 'discharge', label: 'Discharge meds', route: `/emr/discharge-hub/${id}` },
    );
  } else if (FULL_BOARD_ROLES.has(role)) {
    base.push(
      { key: 'case_sheet', label: 'Case sheet', route: `/emr/case-sheet/${id}` },
      { key: 'discharge', label: 'Discharge', route: `/emr/discharge-hub/${id}` },
    );
  } else {
    base.push(
      { key: 'case_sheet', label: 'Case sheet', route: `/emr/case-sheet/${id}` },
      { key: 'discharge', label: 'Discharge', route: `/emr/discharge-hub/${id}` },
    );
  }
  return base;
}

function rowSort(a, b) {
  if (a.priority.sort_weight !== b.priority.sort_weight) {
    return a.priority.sort_weight - b.priority.sort_weight;
  }
  const aTime = asDate(a.timers.admitted_at)?.getTime() || 0;
  const bTime = asDate(b.timers.admitted_at)?.getTime() || 0;
  return aTime - bTime;
}

async function getPatientCommandBoard(filters = {}, actor = {}) {
  const role = normalizeRole(actor.role);
  const tenantId = actor.tenantId || filters.tenantId || null;
  const limit = Math.min(Math.max(Number.parseInt(filters.limit, 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(filters.offset, 10) || 0, 0);
  const ward = compactText(filters.ward);
  const status = compactText(filters.status);
  const mine = filters.mine === true || filters.mine === 'true' || filters.mine === '1';

  const normalizedStatus = String(status || '').toLowerCase();
  const baseWhere = {
    status: normalizedStatus && normalizedStatus !== 'all' && normalizedStatus !== 'active'
      ? status
      : { in: ACTIVE_ADMISSION_STATUSES },
  };
  if (tenantId) baseWhere.tenant_id = tenantId;
  if (ward) baseWhere.ward = ward;
  const inpatientScope = await resolveInpatientAdmissionScope({
    actor: { ...actor, role, tenantId },
    filters: { ...filters, tenantId, mine },
  });
  const where = applyInpatientAdmissionScope(baseWhere, inpatientScope.where);

  const [totalAdmissions, admissions] = await Promise.all([
    prisma.admissions.count({ where }),
    prisma.admissions.findMany({
      where,
      orderBy: [{ admitted_at: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit,
    }),
  ]);

  const patientUids = [...new Set(admissions.map((row) => row.patient_uid).filter(Boolean))];
  const doctorUids = [
    ...new Set(admissions.flatMap((row) => [row.admitting_doctor, row.attending_doctor]).filter(Boolean)),
  ];
  const bedIds = [...new Set(admissions.map((row) => row.bed_id).filter((id) => id != null))];
  const encounterIds = [...new Set(admissions.map((row) => row.encounter_id).filter(Boolean))];
  const admissionIds = admissions.map((row) => row.id);

  const [
    patients,
    doctors,
    beds,
    hospitalNumbers,
    allergyRows,
    patientAllergyRows,
    diagnoses,
    orders,
    alerts,
    dischargeConsults,
    dischargeSummaries,
    recentNotes,
  ] = await Promise.all([
    patientUids.length
      ? prisma.users.findMany({
          where: { uid: { in: patientUids } },
          select: { uid: true, id: true, name: true, phone: true, gender: true, birthday: true, blood_group: true, allergies: true },
        })
      : [],
    doctorUids.length
      ? prisma.users.findMany({
          where: { uid: { in: doctorUids } },
          select: { uid: true, name: true, role: true },
        })
      : [],
    bedIds.length
      ? prisma.beds.findMany({
          where: { id: { in: bedIds } },
          select: { id: true, status: true, bed_number: true, bed_type: true, ward_name: true, wards: { select: { id: true, name: true, floor: true } } },
        })
      : [],
    getHospitalNumberMap({ tenantId, patientUids }),
    patientUids.length
      ? prisma.allergies.findMany({
          where: {
            patient_uid: { in: patientUids },
            ...(tenantId ? { tenant_id: tenantId } : {}),
            OR: [{ status: null }, { status: { notIn: ['inactive', 'resolved', 'entered-in-error', 'cancelled'] } }],
          },
          select: { patient_uid: true, allergen: true, name: true, severity: true, reaction: true, status: true },
        })
      : [],
    patientUids.length
      ? prisma.patient_allergies.findMany({
          where: {
            ...(tenantId ? { tenant_id: tenantId } : {}),
            OR: [{ patient_uid: { in: patientUids } }],
            is_active: { not: false },
          },
          select: { patient_uid: true, allergy_name: true, severity: true, reaction: true },
        })
      : [],
    patientUids.length
      ? prisma.diagnoses.findMany({
          where: {
            patient_uid: { in: patientUids },
            ...(tenantId ? { tenant_id: tenantId } : {}),
            OR: encounterIds.length
              ? [{ encounter_id: { in: encounterIds } }, { status: 'active' }]
              : [{ status: 'active' }],
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: 300,
        })
      : [],
    patientUids.length
      ? prisma.clinical_orders.findMany({
          where: {
            patient_uid: { in: patientUids },
            ...(tenantId ? { tenant_id: tenantId } : {}),
            status: { notIn: CLOSED_ORDER_STATUSES },
            ...(encounterIds.length ? { OR: [{ encounter_id: { in: encounterIds } }, { encounter_id: null }] } : {}),
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: 500,
        })
      : [],
    patientUids.length
      ? prisma.cds_alerts.findMany({
          where: {
            patient_uid: { in: patientUids },
            ...(tenantId ? { tenant_id: tenantId } : {}),
            OR: [{ acknowledged: false }, { acknowledged: null }],
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: 300,
        })
      : [],
    admissionIds.length
      ? prisma.discharge_consults.findMany({
          where: {
            admission_id: { in: admissionIds },
            ...(tenantId ? { tenant_id: tenantId } : {}),
          },
          orderBy: [{ requested_at: 'asc' }, { id: 'asc' }],
        })
      : [],
    admissionIds.length
      ? prisma.discharge_summaries.findMany({
          where: {
            admission_id: { in: admissionIds },
            ...(tenantId ? { tenant_id: tenantId } : {}),
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: admissionIds.length * 3,
        })
      : [],
    patientUids.length
      ? prisma.clinical_notes.findMany({
          where: {
            patient_uid: { in: patientUids },
            ...(tenantId ? { tenant_id: tenantId } : {}),
            ...(encounterIds.length ? { encounter_id: { in: encounterIds } } : {}),
          },
          select: { patient_uid: true, encounter_id: true, note_type: true, title: true, created_at: true, is_signed: true },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: 200,
        })
      : [],
  ]);

  const byUid = (rows, key = 'patient_uid') => rows.reduce((acc, row) => {
    const value = row[key];
    if (!value) return acc;
    if (!acc.has(value)) acc.set(value, []);
    acc.get(value).push(row);
    return acc;
  }, new Map());

  const patientByUid = new Map(patients.map((row) => [row.uid, row]));
  const doctorByUid = new Map(doctors.map((row) => [row.uid, row]));
  const bedById = new Map(beds.map((row) => [row.id, row]));
  const allergyByUid = byUid(allergyRows);
  const lookupAllergyByUid = byUid(patientAllergyRows);
  const diagnosisByEncounter = byUid(diagnoses.filter((row) => row.encounter_id), 'encounter_id');
  const diagnosisByPatient = byUid(diagnoses);
  const ordersByEncounter = byUid(orders.filter((row) => row.encounter_id), 'encounter_id');
  const ordersByPatient = byUid(orders);
  const alertsByPatient = byUid(alerts);
  const consultsByAdmission = byUid(dischargeConsults, 'admission_id');
  const notesByEncounter = byUid(recentNotes.filter((row) => row.encounter_id), 'encounter_id');

  const latestSummaryByAdmission = new Map();
  for (const summary of dischargeSummaries) {
    if (!latestSummaryByAdmission.has(summary.admission_id)) {
      latestSummaryByAdmission.set(summary.admission_id, summary);
    }
  }

  const now = new Date();
  const minimizePayload = shouldMinimizePayload(role);
  const rows = admissions.map((admission) => {
    const patient = patientByUid.get(admission.patient_uid) || null;
    const bed = admission.bed_id != null ? bedById.get(admission.bed_id) : null;
    const diagnosisRows = [
      ...(admission.encounter_id ? diagnosisByEncounter.get(admission.encounter_id) || [] : []),
      ...(diagnosisByPatient.get(admission.patient_uid) || []),
    ];
    const orderRows = [
      ...(admission.encounter_id ? ordersByEncounter.get(admission.encounter_id) || [] : []),
      ...(ordersByPatient.get(admission.patient_uid) || []),
    ];
    const uniqueOrders = uniqueByKey(orderRows, (item) => String(item.id));
    const consultRows = consultsByAdmission.get(admission.id) || [];
    const admissionMinutes = minutesBetween(admission.admitted_at, now);
    const discharge = buildDischargeOverlay(
      admission,
      latestSummaryByAdmission.get(admission.id),
      consultRows,
    );
    const priority = priorityMeta(admission.priority, discharge.initiated);
    const allergies = buildAllergies({
      admission,
      patient,
      fhirAllergies: allergyByUid.get(admission.patient_uid) || [],
      lookupAllergies: lookupAllergyByUid.get(admission.patient_uid) || [],
    });
    const alertRows = alertsByPatient.get(admission.patient_uid) || [];
    const noteRows = admission.encounter_id ? notesByEncounter.get(admission.encounter_id) || [] : [];

    const row = {
      admission_id: admission.id,
      encounter_id: admission.encounter_id,
      tenant_id: admission.tenant_id,
      patient_uid: minimizePayload ? null : admission.patient_uid,
      patient: {
        uid: minimizePayload ? null : admission.patient_uid,
        name: minimizePayload ? 'Occupied' : patient?.name || 'Patient',
        phone: minimizePayload ? null : patient?.phone || null,
        gender: minimizePayload ? null : patient?.gender || null,
        birthday: minimizePayload ? null : patient?.birthday || null,
        blood_group: minimizePayload ? null : patient?.blood_group || null,
        hospital_number: minimizePayload ? null : hospitalNumbers.get(admission.patient_uid) || null,
      },
      location: {
        ward: admission.ward || bed?.wards?.name || bed?.ward_name || null,
        ward_id: bed?.wards?.id || null,
        floor: bed?.wards?.floor || null,
        bed_id: admission.bed_id,
        bed_number: admission.bed_number || bed?.bed_number || null,
        bed_status: bed?.status || null,
        bed_type: bed?.bed_type || admission.room_category || null,
      },
      admission: {
        status: admission.status,
        type: admission.admission_type,
        code_status: admission.code_status,
        room_category: admission.room_category,
        next_review_at: admission.next_review_at,
      },
      assigned_staff: {
        admitting_doctor_uid: minimizePayload ? null : admission.admitting_doctor,
        admitting_doctor_name: minimizePayload ? null : doctorByUid.get(admission.admitting_doctor)?.name || null,
        attending_doctor_uid: minimizePayload ? null : admission.attending_doctor,
        attending_doctor_name: minimizePayload ? null : doctorByUid.get(admission.attending_doctor)?.name || null,
      },
      priority,
      timers: {
        admitted_at: admission.admitted_at,
        minutes_since_admission: admissionMinutes,
        los_days: losDays(admission.admitted_at),
        age: ageBand(admissionMinutes),
      },
      diagnosis: minimizePayload
        ? { text: null, status: 'hidden', type: null, code: null, source: 'minimized', chief_complaint: null }
        : displayDiagnosis(admission, uniqueByKey(diagnosisRows, (item) => String(item.id))),
      allergies: {
        count: minimizePayload ? 0 : allergies.length,
        items: minimizePayload ? [] : allergies,
      },
      alerts: {
        count: minimizePayload ? 0 : alertRows.length,
        critical_count: minimizePayload ? 0 : alertRows.filter((item) => String(item.severity || '').toLowerCase() === 'critical').length,
        items: minimizePayload ? [] : alertRows.slice(0, 6).map((item) => ({
          id: item.id,
          type: item.alert_type,
          severity: item.severity,
          title: item.title,
          description: item.description,
          created_at: item.created_at,
        })),
      },
      tasks: minimizePayload
        ? { open_count: 0, open_order_count: 0, discharge_work_item_count: 0, items: [] }
        : buildTaskOverlay(uniqueOrders, consultRows),
      notes: {
        recent_count: minimizePayload ? 0 : noteRows.length,
        latest: minimizePayload ? null : noteRows[0] || null,
      },
      discharge: minimizePayload
        ? {
            initiated: discharge.initiated,
            initiated_at: discharge.initiated_at,
            summary_signed: null,
            summary_signed_at: null,
            pending_work_items: 0,
            total_work_items: 0,
            checklist_state: discharge.initiated ? 'in_progress' : 'not_started',
            signed_summary_route: null,
            discharge_hub_route: null,
          }
        : discharge,
      actions: minimizePayload ? [] : actionsForRole(role, admission),
    };
    return row;
  }).sort(rowSort);

  const loadedCounts = rows.reduce((acc, row) => {
    acc.loaded += 1;
    acc.discharge_initiated += row.discharge.initiated ? 1 : 0;
    acc.alerted += row.alerts.count > 0 ? 1 : 0;
    acc.with_open_tasks += row.tasks.open_count > 0 ? 1 : 0;
    acc.emergency += row.priority.band === 'critical' ? 1 : 0;
    return acc;
  }, {
    loaded: 0,
    discharge_initiated: 0,
    alerted: 0,
    with_open_tasks: 0,
    emergency: 0,
  });
  const counts = {
    total: totalAdmissions,
    returned: loadedCounts.loaded,
    loaded: offset + loadedCounts.loaded,
    limit,
    offset,
    has_more: offset + loadedCounts.loaded < totalAdmissions,
    discharge_initiated: loadedCounts.discharge_initiated,
    alerted: loadedCounts.alerted,
    with_open_tasks: loadedCounts.with_open_tasks,
    emergency: loadedCounts.emergency,
  };

  const view = ROLE_VIEW[role] || {
    label: FULL_BOARD_ROLES.has(role) ? 'Hospital command board' : 'Patient command board',
    visible_sections: ['summary', 'diagnosis', 'alerts', 'tasks', 'discharge', 'actions'],
  };

  return {
    board: {
      kind: 'patient_command_board',
      generated_at: now.toISOString(),
      tenant_id: tenantId,
      scope: {
        ward: ward || null,
        status: status || 'active',
        mine: inpatientScope.scope?.type === 'own_patients',
        role_scope: inpatientScope.scope,
      },
      actor: {
        uid: actor.uid || null,
        role,
        view_label: view.label,
        visible_sections: view.visible_sections,
      },
      governance: {
        ai_state: 'fallback',
        label: 'Rules-generated board - no autonomous AI action',
        source_count: 8,
        human_review_required_for_actions: true,
      },
      counts,
    },
    rows,
  };
}

export default {
  getPatientCommandBoard,
};
