// src/services/appointment/appointmentQueryService.js
// Appointment read paths — every list query uses typed Prisma `include`
// via the relations declared in migration 084 (appointments.doctor_id →
// users.id, appointments.patient_id → users.id). Column-rename drift
// on appointments / users / doctors surfaces at query-construction.

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { computeGestationalAge } from '../maternity/maternityService.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { istDateString } from '../../utils/dateUtils.js';

// Base set of appointment columns every list view returns.
const APPT_BASE_SELECT = {
  id: true,
  appointment_date: true,
  appointment_time: true,
  status: true,
  reason: true,
  notes: true,
  patient_id: true,
  doctor_id: true,
  phone: true,
  patient_name: true,
  doctor_name: true,
  department: true,
  token_number: true,
  triage_acuity: true,
  // Persisted human-readable visit_no (migration 217) so receptionists
  // can reprint the slip and downstream counters can match the printed
  // OPD-YYYYMMDD-NNN token in list responses.
  visit_no: true,
  // F-2 — surface admission-advice columns so the admission counter
  // queue can render advice timestamp + note + advising doctor without
  // a second round-trip. Finding:
  // 2026-05-10-inpatient-admission-receptionist-advice-queue-filter-ignored.
  advised_for_admission_at: true,
  advised_for_admission_by: true,
  advised_for_admission_note: true,
  created_at: true,
  updated_at: true,
};

// Doctor relation — appointments.doctor_id → users.id. The doctor's
// profile (specialty/department) lives in the `doctors` child table
// with FK doctors.user_id → users.id. `take: 1` limits to the first
// doctor profile since every doctor user has ≤1 row in practice.
const DOCTOR_INCLUDE = {
  select: {
    id: true,
    name: true,
    phone: true,
    email: true,
    doctors: {
      select: { specialty: true, department: true },
      take: 1,
    },
  },
};

// Patient relation — appointments.patient_id → users.id. `uid` is
// selected so the detail view can resolve the patient's ANC pregnancy
// (and the COMPLETED-visit clinical-summary join below) without a
// second round-trip.
const PATIENT_INCLUDE = {
  select: {
    id: true,
    uid: true,
    name: true,
    phone: true,
    guardian_phone: true,
    email: true,
    allergies: true,
  },
};

// Resolve the ANC pregnancy context for a patient (ongoing pregnancy
// only). Returns null when the patient has no active pregnancy — the
// common case for non-ANC appointments. Best-effort: a lookup failure
// must never break the appointment read. Finding:
// 2026-05-09-obstetric-anc-receptionist-walkin-response-missing-ga.
async function resolvePregnancyContext(patientUid) {
  if (!patientUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, lmp_date, edd_date, gravida, parity, high_risk
         FROM maternity_pregnancies
        WHERE patient_uid = $1::uuid AND status = 'ongoing'
        ORDER BY created_at DESC
        LIMIT 1`,
      String(patientUid),
    );
    if (!rows.length) return null;
    const p = rows[0];
    return {
      pregnancy_id: p.id,
      lmp_date: p.lmp_date,
      edd_date: p.edd_date,
      gravida: p.gravida,
      parity: p.parity,
      high_risk: p.high_risk,
      gestational_age: computeGestationalAge(p.lmp_date),
    };
  } catch (e) {
    logger.warn('Pregnancy context lookup failed:', e?.message);
    return null;
  }
}

async function resolveFollowUpContext({ patientUid, appointmentId, parentAppointmentId = null, anchorTs = null }) {
  if (!patientUid) return null;
  try {
    const params = [String(patientUid), Number(appointmentId)];
    let parentWhere = '';
    if (parentAppointmentId) {
      params.push(Number(parentAppointmentId));
      parentWhere = `OR a.id = $${params.length}::int`;
    }
    const [parentRows, prescriptions, diagnoses, notes] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT a.id, a.appointment_date, a.appointment_time, a.status,
                a.reason, a.notes, a.visit_type, a.department,
                a.doctor_name
           FROM appointments a
           JOIN users p ON p.id = a.patient_id
          WHERE p.uid = $1::uuid
            AND a.id <> $2::int
            AND (
              ${parentAppointmentId ? 'FALSE ' : 'TRUE '}
              ${parentWhere}
            )
          ORDER BY
            CASE WHEN a.id = ${parentAppointmentId ? `$${params.length}::int` : 'NULL'} THEN 0 ELSE 1 END,
            a.appointment_date DESC NULLS LAST,
            a.created_at DESC NULLS LAST
          LIMIT 1`,
        ...params,
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, appointment_id, prescription_number, diagnosis, medications,
                follow_up_date, follow_up_notes, created_at
           FROM e_prescriptions
          WHERE patient_uid = $1::uuid
            AND (appointment_id IS NULL OR appointment_id <> $2::int)
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 3`,
        String(patientUid), Number(appointmentId),
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, icd10_code, icd10_description, description,
                diagnosis_type, severity, onset_date, created_at
           FROM diagnoses
          WHERE patient_uid = $1::uuid
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 3`,
        String(patientUid),
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, note_type, content, author_role, is_signed,
                signed_at, created_at
           FROM clinical_notes
          WHERE patient_uid = $1::uuid
            AND (
              NOT (content ? 'appointment_id')
              OR (content->>'appointment_id')::int <> $2::int
            )
          ORDER BY created_at DESC NULLS LAST, id DESC
          LIMIT 3`,
        String(patientUid), Number(appointmentId),
      ),
    ]);
    return {
      parent_appointment: parentRows[0] ?? null,
      latest_prescriptions: prescriptions,
      latest_diagnoses: diagnoses,
      latest_notes: notes,
      anchor_at: anchorTs ?? null,
      empty: parentRows.length === 0 &&
        prescriptions.length === 0 &&
        diagnoses.length === 0 &&
        notes.length === 0,
    };
  } catch (e) {
    logger.warn('Follow-up context lookup failed:', e?.message);
    return null;
  }
}

function allergiesFromProfileText(value) {
  if (!value) return [];
  return String(value)
    .split(/[,;\n]+/)
    .map((allergy) => allergy.trim())
    .filter(Boolean)
    .map((allergy_name) => ({ allergy_name, severity: null, reaction: null, source: 'profile' }));
}

function dedupeAllergies(allergies = []) {
  const byName = new Map();
  for (const allergy of allergies) {
    const allergyName = String(allergy?.allergy_name || allergy?.allergen || allergy?.name || '').trim();
    if (!allergyName) continue;
    const key = allergyName.toLowerCase();
    const next = {
      allergy_name: allergyName,
      severity: allergy.severity ?? null,
      reaction: allergy.reaction ?? null,
      source: allergy.source ?? 'structured',
    };
    const existing = byName.get(key);
    if (!existing || (!existing.severity && next.severity) || (!existing.reaction && next.reaction)) {
      byName.set(key, { ...existing, ...next });
    }
  }
  return [...byName.values()].sort((a, b) => a.allergy_name.localeCompare(b.allergy_name));
}

async function loadAllergiesForPatients(patients = []) {
  const refs = patients
    .filter((patient) => patient?.id != null)
    .map((patient) => ({
      id: Number(patient.id),
      uid: patient.uid ? String(patient.uid).toLowerCase() : null,
      allergies: patient.allergies,
    }));
  const byPatientId = new Map(refs.map((patient) => [
    patient.id,
    allergiesFromProfileText(patient.allergies),
  ]));
  if (refs.length === 0) return byPatientId;

  const ids = [...new Set(refs.map((patient) => patient.id).filter((id) => Number.isInteger(id)))];
  const uids = [...new Set(refs.map((patient) => patient.uid).filter(Boolean))];
  const uidToIds = new Map();
  for (const ref of refs) {
    if (!ref.uid) continue;
    const arr = uidToIds.get(ref.uid) ?? [];
    arr.push(ref.id);
    uidToIds.set(ref.uid, arr);
  }

  try {
    const structuredRows = await prisma.$queryRawUnsafe(
      `SELECT patient_id, patient_uid, allergy_name, severity, reaction
         FROM patient_allergies
        WHERE COALESCE(is_active, TRUE) = TRUE
          AND (
            (patient_id IS NOT NULL AND patient_id = ANY($1::int[]))
            OR (patient_uid IS NOT NULL AND patient_uid = ANY($2::uuid[]))
          )
        ORDER BY allergy_name`,
      ids,
      uids,
    );
    for (const row of structuredRows) {
      const targetIds = new Set();
      if (row.patient_id != null) targetIds.add(Number(row.patient_id));
      const rowUid = row.patient_uid ? String(row.patient_uid).toLowerCase() : null;
      for (const id of uidToIds.get(rowUid) ?? []) targetIds.add(id);

      for (const id of targetIds) {
        if (!byPatientId.has(id)) continue;
        const current = byPatientId.get(id) ?? [];
        current.push({
          allergy_name: row.allergy_name,
          severity: row.severity ?? null,
          reaction: row.reaction ?? null,
          source: 'structured',
        });
        byPatientId.set(id, current);
      }
    }
  } catch (e) {
    logger.warn('Appointment allergy lookup failed:', e?.message);
  }

  for (const [id, allergies] of byPatientId.entries()) {
    byPatientId.set(id, dedupeAllergies(allergies));
  }
  return byPatientId;
}

function attachPatientAllergies(flat, patient, allergyMap) {
  const patientId = Number(patient?.id ?? flat.patient_id);
  const allergies = Number.isInteger(patientId)
    ? (allergyMap?.get(patientId) ?? [])
    : [];
  flat.has_allergies = allergies.length > 0;
  flat.allergy_flag = allergies.length > 0;
  flat.allergies = allergies;
  return flat;
}

// Format a date range filter for `DATE(appointment_date) = $d` — Prisma's
// Date equality on an appointment_date Date column needs the whole day
// covered.
//
// Accepts either an ISO date string ("2026-05-02") OR a relative keyword
// ("today" / "tomorrow" / "yesterday"). The validator's customSanitizer
// would normally rewrite these before hitting the controller, but Express 5
// made `req.query` immutable — sanitizer return values don't persist into
// `req.query.date`. Resolve here as the authoritative second line of defense
// so /appointments/list?date=today renders 200 instead of bombing through
// `new Date("today")` → Invalid Date → Prisma validation error → 500.
function addDaysToDateString(dateString, days) {
  const d = new Date(`${dateString}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function resolveDateInput(date) {
  if (typeof date !== 'string') return date;
  const v = date.trim().toLowerCase();
  const today = istDateString();
  if (v === 'today') return today;
  if (v === 'tomorrow') return addDaysToDateString(today, 1);
  if (v === 'yesterday') return addDaysToDateString(today, -1);
  return date;
}

function dateRangeFilter(date) {
  const resolved = resolveDateInput(date);
  const start = new Date(resolved);
  const end = new Date(resolved);
  end.setDate(end.getDate() + 1);
  return { gte: start, lt: end };
}

// Relation field names (auto-generated by Prisma from the two FKs to
// users). Constants so the six list queries + flattener stay in sync.
const REL_PATIENT = 'users_appointments_patient_idTousers';
const REL_DOCTOR = 'users_appointments_doctor_idTousers';

// Flatten the nested relation payload back into the flat-alias response
// shape that the old SQL returned.
function flattenListRow(row, allergyMap = null) {
  const patient = row[REL_PATIENT] ?? null;
  const doctor = row[REL_DOCTOR] ?? null;
  const profile = doctor?.doctors?.[0] ?? null;
  const flat = { ...row };
  delete flat[REL_PATIENT];
  delete flat[REL_DOCTOR];
  flat.patient_name = patient?.name ?? row.patient_name ?? null;
  flat.patient_phone = patient?.phone ?? row.phone ?? null;
  flat.patient_guardian_phone = patient?.guardian_phone ?? null;
  flat.patient_email = patient?.email ?? null;
  flat.doctor_name = doctor?.name ?? row.doctor_name ?? null;
  flat.doctor_phone = doctor?.phone ?? null;
  flat.doctor_email = doctor?.email ?? null;
  // Legacy aliases used by different callers.
  flat.doctor_specialization = profile?.specialty ?? null;
  flat.specialty = profile?.specialty ?? null;
  flat.doctor_department = profile?.department ?? null;
  flat.consultant_department = profile?.department ?? null;
  flat.appointment_department = row.department ?? null;
  flat.department = row.department ?? profile?.department ?? null;
  return attachPatientAllergies(flat, patient, allergyMap);
}

function appointmentOrderBy(sortBy, sortOrder) {
  const direction = sortOrder.toLowerCase();
  switch (sortBy) {
    case 'appointment_time':
      return [{ appointment_time: direction }, { appointment_date: direction }];
    case 'created_at':
      return [{ created_at: direction }];
    case 'status':
      return [{ status: direction }, { appointment_date: 'asc' }, { appointment_time: 'asc' }];
    case 'patient':
      return [{ patient_name: direction }, { appointment_date: 'asc' }, { appointment_time: 'asc' }];
    case 'doctor':
      return [{ doctor_name: direction }, { appointment_date: 'asc' }, { appointment_time: 'asc' }];
    case 'phone':
      return [{ phone: direction }, { appointment_date: 'asc' }, { appointment_time: 'asc' }];
    case 'department':
      return [{ department: direction }, { appointment_date: 'asc' }, { appointment_time: 'asc' }];
    case 'token':
      return [{ token_number: direction }, { appointment_date: 'asc' }, { appointment_time: 'asc' }];
    case 'appointment_date':
    default:
      return [{ appointment_date: direction }, { appointment_time: direction }];
  }
}

export class AppointmentQueryService {
  async getAppointments(filters = {}, pagination = {}, userRole = null, userId = null) {
    try {
      const listQuery = parseListQuery({ ...filters, ...pagination }, {
        defaultPage: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.PAGE,
        defaultLimit: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.LIMIT,
        maxLimit: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.MAX_LIMIT || 100,
        defaultSortBy: 'appointment_date',
        defaultSortOrder: 'ASC',
        allowedSortFields: [
          'appointment_date',
          'appointment_time',
          'created_at',
          'status',
          'patient',
          'doctor',
          'phone',
          'department',
          'token',
        ],
      });

      const where = {};
      if (userRole === 'DOCTOR') where.doctor_id = parseInt(userId);
      if (filters.status) where.status = filters.status.toUpperCase();
      if (filters.doctor_id) where.doctor_id = parseInt(filters.doctor_id);
      if (filters.patient_id) where.patient_id = parseInt(filters.patient_id);
      if (filters.date) where.appointment_date = dateRangeFilter(filters.date);
      // F-2 — admission-counter worklist. Accept the boolean flag in
      // truthy ('true' / '1' / true) form and filter to rows where the
      // advice timestamp is set (= advised for admission). Finding:
      // 2026-05-09-inpatient-admission-receptionist-no-admission-queue-endpoint.
      if (filters.advised_for_admission !== undefined && filters.advised_for_admission !== '') {
        const truthy = filters.advised_for_admission === true
          || filters.advised_for_admission === 'true'
          || filters.advised_for_admission === '1'
          || filters.advised_for_admission === 1;
        where.advised_for_admission_at = truthy ? { not: null } : null;
      }
      if (listQuery.search) {
        where.OR = [
          { patient_name: { contains: listQuery.search, mode: 'insensitive' } },
          { doctor_name: { contains: listQuery.search, mode: 'insensitive' } },
          { phone: { contains: listQuery.search, mode: 'insensitive' } },
          {
            users_appointments_patient_idTousers: {
              is: { guardian_phone: { contains: listQuery.search, mode: 'insensitive' } },
            },
          },
          { reason: { contains: listQuery.search, mode: 'insensitive' } },
          // Walk-ins persist visit_no (migration 217) so reception can
          // reprint the slip and downstream counters can find the appointment
          // by the printed `OPD-YYYYMMDD-NNN` token.
          { visit_no: { contains: listQuery.search, mode: 'insensitive' } },
        ];
      }

      const [total, rows] = await Promise.all([
        prisma.appointments.count({ where }),
        prisma.appointments.findMany({
          where,
          select: {
            ...APPT_BASE_SELECT,
            users_appointments_patient_idTousers: PATIENT_INCLUDE,
            users_appointments_doctor_idTousers: DOCTOR_INCLUDE,
          },
          orderBy: appointmentOrderBy(listQuery.sortBy, listQuery.sortOrder),
          take: listQuery.limit,
          skip: listQuery.offset,
        }),
      ]);

      const allergyMap = await loadAllergiesForPatients(rows.map((row) => row[REL_PATIENT]));

      return {
        appointments: rows.map((row) => flattenListRow(row, allergyMap)),
        pagination: buildPagination(total, listQuery.page, listQuery.limit),
        filters: {
          ...filters,
          search: listQuery.search || null,
          sortBy: listQuery.sortBy,
          sortOrder: listQuery.sortOrder,
        },
      };
    } catch (error) {
      logger.error('Error getting appointments:', error);
      throw error;
    }
  }

  async getDoctorAppointments(doctorId, filters = {}) {
    try {
      // Don't default-filter by status — a doctor's worklist should surface
      // SCHEDULED + CONFIRMED + COMPLETED (and anything else not cancelled).
      // The prior default of SCHEDULED-only hid CONFIRMED walk-ins, so this
      // endpoint returned empty while /queue/today/mine returned the same
      // rows. Finding:
      // 2026-05-09-dynamic-acute-abdomen-doctor-worklist-doctor-endpoint-returns-empty.
      const where = { doctor_id: parseInt(doctorId) };
      if (filters.status) {
        where.status = filters.status.toUpperCase();
      } else {
        where.status = { notIn: ['CANCELLED', 'NO_SHOW'] };
      }
      if (filters.date) where.appointment_date = dateRangeFilter(filters.date);

      const rows = await prisma.appointments.findMany({
        where,
        select: {
          id: true,
          appointment_date: true,
          appointment_time: true,
          status: true,
          reason: true,
          notes: true,
          patient_id: true,
          token_number: true,
          triage_acuity: true,
          visit_no: true,
          visit_type: true,
          department: true,
          users_appointments_patient_idTousers: PATIENT_INCLUDE,
        },
        orderBy: [{ appointment_date: 'asc' }, { appointment_time: 'asc' }],
      });

      const allergyMap = await loadAllergiesForPatients(rows.map((row) => row[REL_PATIENT]));

      // This view only needs patient_* fields, no doctor aliases.
      return rows.map((r) => {
        const p = r[REL_PATIENT] ?? null;
        const flat = { ...r };
        delete flat[REL_PATIENT];
        flat.patient_name = p?.name ?? null;
        flat.patient_phone = p?.phone ?? null;
        flat.patient_email = p?.email ?? null;
        return attachPatientAllergies(flat, p, allergyMap);
      });
    } catch (error) {
      logger.error('Error getting doctor appointments:', error);
      throw error;
    }
  }

  async getPatientAppointments(patientId, filters = {}) {
    try {
      const where = { patient_id: parseInt(patientId) };
      if (filters.status) where.status = filters.status.toUpperCase();

      const rows = await prisma.appointments.findMany({
        where,
        select: {
          id: true,
          appointment_date: true,
          appointment_time: true,
          status: true,
          reason: true,
          notes: true,
          doctor_id: true,
          // Surface the human-readable visit identifiers the patient app
          // needs to match the in-hand paper/SMS slip. Without these the
          // patient sees a generic "Walk-in" card with no token number,
          // visit_no, or department. Finding:
          // 2026-05-10-walk-in-opd-patient-visit-identifiers-missing.
          token_number: true,
          visit_no: true,
          visit_type: true,
          department: true,
          created_at: true,
          updated_at: true,
          users_appointments_patient_idTousers: PATIENT_INCLUDE,
          users_appointments_doctor_idTousers: DOCTOR_INCLUDE,
        },
        orderBy: [{ appointment_date: 'desc' }, { appointment_time: 'desc' }],
      });

      const allergyMap = await loadAllergiesForPatients(rows.map((row) => row[REL_PATIENT]));

      // Only doctor_* + specialty/department aliases needed — no patient_*
      // (this view is scoped to one patient). Prefer the appointment's own
      // `department` column; fall back to the doctor's profile department
      // for legacy rows where department was never written on the row.
      return rows.map((r) => {
        const d = r[REL_DOCTOR] ?? null;
        const p = r[REL_PATIENT] ?? null;
        const profile = d?.doctors?.[0] ?? null;
        const flat = { ...r };
        delete flat[REL_PATIENT];
        delete flat[REL_DOCTOR];
        flat.doctor_name = d?.name ?? null;
        flat.doctor_phone = d?.phone ?? null;
        flat.specialty = profile?.specialty ?? null;
        flat.department = r.department ?? profile?.department ?? null;
        return attachPatientAllergies(flat, p, allergyMap);
      });
    } catch (error) {
      logger.error('Error getting patient appointments:', error);
      throw error;
    }
  }

  async getTodayAppointments(userRole = null, userId = null) {
    try {
      const todayStr = istDateString();
      const where = { appointment_date: dateRangeFilter(todayStr) };
      if (userRole === 'DOCTOR') where.doctor_id = parseInt(userId);

      const rows = await prisma.appointments.findMany({
        where,
        select: {
          id: true,
          appointment_time: true,
          status: true,
          reason: true,
          patient_id: true,
          doctor_id: true,
          [REL_PATIENT]: PATIENT_INCLUDE,
          [REL_DOCTOR]: {
            select: {
              name: true,
              doctors: {
                select: { specialty: true, department: true },
                take: 1,
              },
            },
          },
        },
        orderBy: { appointment_time: 'asc' },
      });

      const allergyMap = await loadAllergiesForPatients(rows.map((row) => row[REL_PATIENT]));
      const appointments = rows.map((r) => {
        const p = r[REL_PATIENT] ?? null;
        const d = r[REL_DOCTOR] ?? null;
        const profile = d?.doctors?.[0] ?? null;
        const flat = { ...r };
        delete flat[REL_PATIENT];
        delete flat[REL_DOCTOR];
        flat.patient_name = p?.name ?? null;
        flat.patient_phone = p?.phone ?? null;
        flat.doctor_name = d?.name ?? null;
        flat.department = profile?.department ?? null;
        flat.specialty = profile?.specialty ?? null;
        return attachPatientAllergies(flat, p, allergyMap);
      });

      return { appointments, date: todayStr };
    } catch (error) {
      logger.error('Error getting today appointments:', error);
      throw error;
    }
  }

  async getAppointmentById(id) {
    try {
      const row = await prisma.appointments.findUnique({
        where: { id: parseInt(id) },
        select: {
          id: true,
          uid: true,
          phone: true,
          patient_id: true,
          doctor_id: true,
          doctor_name: true,
          patient_name: true,
          appointment_date: true,
          appointment_time: true,
          status: true,
          reason: true,
          notes: true,
          // Surface the appointment's own department and walk-in identifiers
          // on the detail view — receptionists/admins use this endpoint to
          // route ANC vs OPD, and patients use it to match the printed slip.
          // Without department in the SELECT, the flatten step always fell
          // back to the doctor's profile department, which is wrong for
          // doctors who cover multiple departments. Finding:
          // 2026-05-09-obstetric-anc-receptionist-appt-detail-strips-department.
          department: true,
          token_number: true,
          visit_no: true,
          visit_type: true,
          parent_appointment_id: true,
          confirmed_at: true,
          created_at: true,
          updated_at: true,
          users_appointments_patient_idTousers: PATIENT_INCLUDE,
          users_appointments_doctor_idTousers: DOCTOR_INCLUDE,
        },
      });
      if (!row) return null;

      const patient = row[REL_PATIENT] ?? null;
      const doctor = row[REL_DOCTOR] ?? null;
      const profile = doctor?.doctors?.[0] ?? null;
      const flat = { ...row };
      delete flat[REL_PATIENT];
      delete flat[REL_DOCTOR];
      flat.patient_name = patient?.name ?? row.patient_name ?? null;
      flat.patient_phone = patient?.phone ?? row.phone ?? null;
      flat.patient_email = patient?.email ?? null;
      // Old raw SQL used `d.name AS doctor_name_detail` — kept for callers
      // that already branch on that alias. The top-level doctor_name
      // (from the appointments row) stays whatever it was.
      flat.doctor_name = doctor?.name ?? row.doctor_name ?? null;
      flat.doctor_name_detail = doctor?.name ?? row.doctor_name ?? null;
      flat.doctor_phone = doctor?.phone ?? null;
      flat.doctor_email = doctor?.email ?? null;
      flat.specialty = profile?.specialty ?? null;
      // Prefer the row's own department over the doctor's profile so
      // ANC appointments don't get re-routed to the doctor's home
      // department.
      flat.department = row.department ?? profile?.department ?? null;
      const allergyMap = await loadAllergiesForPatients(patient ? [patient] : []);
      attachPatientAllergies(flat, patient, allergyMap);

      // ANC context — when the patient has an ongoing pregnancy, surface
      // gestational age + pregnancy id inline so the receptionist can
      // confirm GA from the appointment screen instead of stitching a
      // separate /maternity/pregnancies/active call. Null for the
      // common non-ANC case. Finding:
      // 2026-05-09-obstetric-anc-receptionist-walkin-response-missing-ga.
      flat.pregnancy_context = await resolvePregnancyContext(patient?.uid);

      if (String(flat.visit_type || '').toUpperCase() === 'FOLLOW_UP' && patient?.uid) {
        flat.follow_up_context = await resolveFollowUpContext({
          patientUid: patient.uid,
          appointmentId: flat.id,
          parentAppointmentId: flat.parent_appointment_id,
          anchorTs: flat.appointment_date || flat.created_at,
        });
      }

      // E-10 — completed-visit clinical summary. Patient app calling
      // GET /appointments/:id on a COMPLETED visit previously got an
      // empty shell with no notes / prescriptions / diagnoses to read.
      // Join them inline so the response is self-contained. Findings:
      //   2026-05-08-follow-up-opd-patient-completed-visit-empty-shell
      //   2026-05-11-follow-up-opd-patient-bb4300c3 (progress note not visible)
      //   2026-05-11-follow-up-opd-patient-8cd46bfe (completed FU omits note)
      //
      // The notes join now prefers `content->>'appointment_id'` over
      // a 6h time window. The window-only approach missed any note
      // written more than 6h after the appointment was BOOKED (not
      // when the visit happened — appointment_date can be days/weeks
      // out from created_at for follow-ups), which is the common
      // case for follow-up OPDs. We fall back to a wider 24h window
      // around appointment_date for legacy notes that don't carry the
      // attribute. Status comparison is case-insensitive — some
      // routes still return lowercase 'completed'.
      if (String(flat.status || '').toUpperCase() === 'COMPLETED' && patient?.uid) {
        try {
          const anchorTs = flat.appointment_date || flat.created_at;
          const apptIdInt = Number(flat.id);
          const [notes, prescriptions, diagnoses] = await Promise.all([
            prisma.$queryRawUnsafe(
              `SELECT id, note_type, content, author_role, is_signed,
                      signed_at, created_at
                 FROM clinical_notes
                WHERE patient_uid = $1::uuid
                  AND (
                    (content ? 'appointment_id'
                     AND (content->>'appointment_id')::int = $3::int)
                    OR
                    (NOT (content ? 'appointment_id')
                     AND created_at >= ($2::timestamp - INTERVAL '24 hours')
                     AND created_at <= ($2::timestamp + INTERVAL '7 days'))
                  )
                ORDER BY created_at ASC`,
              patient.uid, anchorTs, apptIdInt,
            ),
            prisma.$queryRawUnsafe(
              `SELECT id, prescription_number, diagnosis, medications, follow_up_date,
                      follow_up_notes, pdf_key, created_at
                 FROM e_prescriptions
                WHERE patient_uid = $1::uuid
                  AND (
                    appointment_id = $3::int
                    OR (
                      appointment_id IS NULL
                      AND created_at >= ($2::timestamp - INTERVAL '24 hours')
                      AND created_at <= ($2::timestamp + INTERVAL '7 days')
                    )
                  )
                ORDER BY created_at ASC
                LIMIT 5`,
              patient.uid, anchorTs, apptIdInt,
            ),
            prisma.$queryRawUnsafe(
              `SELECT id, icd10_code, icd10_description, description, diagnosis_type,
                      severity, onset_date, created_at
                 FROM diagnoses
                WHERE patient_uid = $1::uuid
                  AND created_at >= ($2::timestamp - INTERVAL '24 hours')
                  AND created_at <= ($2::timestamp + INTERVAL '7 days')
                ORDER BY created_at ASC`,
              patient.uid, anchorTs,
            ),
          ]);
          flat.clinical_summary = {
            notes,
            prescriptions,
            diagnoses,
            empty: notes.length === 0 && prescriptions.length === 0 && diagnoses.length === 0,
          };
        } catch (e) {
          logger.warn('Clinical summary join failed:', e?.message);
          flat.clinical_summary = null;
        }
      }

      return flat;
    } catch (error) {
      logger.error('Error getting appointment by ID:', error);
      throw error;
    }
  }
}

export default new AppointmentQueryService();
