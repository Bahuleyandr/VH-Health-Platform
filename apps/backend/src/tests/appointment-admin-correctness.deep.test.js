// Value-asserting deep tests for the admin appointment-query CORRECTNESS bugs.
//
// Two confirmed root causes in src/routes/appointment/appointmentAdminRoutes.js:
//   1. Status is canonically UPPERCASE ('SCHEDULED'/'COMPLETED'/'CANCELLED'/
//      'NO_SHOW'/...). Many admin queries compare/write LOWERCASE status
//      literals → counts are always 0, filters never match, and two write paths
//      (bulk-update-status, resolve-conflict) corrupt rows with lowercase status.
//   2. `appointments.doctor_id` is a `users.id` (the canonical book path joins
//      `users d ON d.id = a.doctor_id`). The admin queries join
//      `doctors d ON a.doctor_id = d.id`, which matches the WRONG doctor row
//      (doctors.id is its own PK, NOT the user id). The correct key is
//      `doctors.user_id = a.doctor_id`.
//
// These tests seed PRECISE, KNOWN data and assert REAL values the broken code
// gets wrong (zero counts, empty result sets, wrong doctor name, lowercase
// stored status). They FAIL against the current code and PASS after the fix.
//
// Doctor-attribution proof: we deliberately give Doctor B a `doctors.id` equal
// to Doctor A's `user_id`. The broken join (`doctors.id = a.doctor_id`) then
// attributes Doctor A's appointments to Doctor B (wrong name); the correct join
// (`doctors.user_id = a.doctor_id`) attributes them to Doctor A.
//
// NOTE on /conflicts: the DB enforces a partial unique index
// (uniq_appointments_active_doctor_slot) that makes two ACTIVE appointments in
// the same (tenant, doctor, date, time) slot impossible, AND the handler's
// window predicate is computed on appointment_date (a DATE — the time-of-day
// lives in the separate appointment_time VARCHAR), so the self-join can never
// surface a same-day conflict regardless of status casing. That window logic is
// a pre-existing semantic defect OUTSIDE this task's two root causes (status
// casing + doctor join), so we do not rewrite it here. The /conflicts test below
// asserts the two in-scope fixes don't break the endpoint (still 200, correct
// shape) and documents the deeper bug as a finding.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PFX = '+9190000888'; // dedicated phone prefix for this suite
const ADMIN_UID = 'c9999999-9999-4999-8999-999999990b01';
const DOCTORA_UID = 'c9999999-9999-4999-8999-999999990b02';
const DOCTORB_UID = 'c9999999-9999-4999-8999-999999990b03';
const PATIENT1_UID = 'c9999999-9999-4999-8999-999999990b04';
const PATIENT2_UID = 'c9999999-9999-4999-8999-999999990b05';
const ALL_UIDS = [ADMIN_UID, DOCTORA_UID, DOCTORB_UID, PATIENT1_UID, PATIENT2_UID];

const ADMIN_PHONE = `${PFX}01`;
const DOCTORA_PHONE = `${PFX}02`;
const DOCTORB_PHONE = `${PFX}03`;
const PATIENT1_PHONE = `${PFX}04`;
const PATIENT2_PHONE = `${PFX}05`;
const ALL_PHONES = [ADMIN_PHONE, DOCTORA_PHONE, DOCTORB_PHONE, PATIENT1_PHONE, PATIENT2_PHONE];

const DEPT_A_NAME = 'AdminCorrectness Dept A';
const DEPT_B_NAME = 'AdminCorrectness Dept B';
const DOCTOR_A_NAME = 'Dr. Correctness Alpha';
const DOCTOR_B_NAME = 'Dr. Correctness Beta';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId, phone) {
  const token = generateTestToken(role, { uid, id: intId, phone });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

// Far-future, deterministic window date so /analytics + /no-shows include the
// rows and no real fixture collides. We also use a recent-PAST date to exercise
// the overdue flag (appointment_date < NOW(), still inside the analytics window
// which is measured on created_at = NOW()).
function futureDateISO(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function pastDateISO(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointment_archive WHERE original_id IN (
       SELECT id FROM appointments WHERE phone = ANY($1))`,
    ALL_PHONES,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointment_status_history WHERE appointment_id IN (
       SELECT id FROM appointments WHERE phone = ANY($1))`,
    ALL_PHONES,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE phone = ANY($1)`, ALL_PHONES,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid = ANY($1::uuid[]))`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`, ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM departments WHERE name IN ($1, $2)`, DEPT_A_NAME, DEPT_B_NAME,
  ).catch(() => {});
}

describe('Appointment admin-query correctness (status casing + doctor join) — value deep', () => {
  let adminIntId, doctorAUserId, doctorBUserId, patient1IntId, patient2IntId;
  let deptAId, deptBId;
  let admin;
  // In-window FUTURE date used for the bulk of the seeded appointments.
  const apptDate = futureDateISO(120);
  // A recent-PAST scheduled appt for the overdue flag.
  const overdueDate = pastDateISO(3);
  // A separate past date for Patient 2's 2nd no-show (kept off apptDate so the
  // active-slot unique index is never challenged — NO_SHOW is exempt anyway).
  const noShowPastDate = pastDateISO(5);
  let bulkApptId, cancelApptId, overdueApptId;

  beforeAll(async () => {
    await cleanup();

    // --- Departments ---------------------------------------------------------
    const dA = await prisma.$queryRawUnsafe(
      `INSERT INTO departments (name, is_active, updated_at) VALUES ($1, true, NOW()) RETURNING id`,
      DEPT_A_NAME);
    deptAId = Number(dA[0].id);
    const dB = await prisma.$queryRawUnsafe(
      `INSERT INTO departments (name, is_active, updated_at) VALUES ($1, true, NOW()) RETURNING id`,
      DEPT_B_NAME);
    deptBId = Number(dB[0].id);

    // --- Users (admin + 2 doctors + 2 patients) ------------------------------
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'AdminCorrectness Admin', 'ADMIN', true, NOW()) RETURNING id`,
      ADMIN_UID, ADMIN_PHONE);
    adminIntId = Number(a[0].id);

    const da = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'DOCTOR', true, NOW()) RETURNING id`,
      DOCTORA_UID, DOCTORA_PHONE, DOCTOR_A_NAME);
    doctorAUserId = Number(da[0].id);

    const db = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'DOCTOR', true, NOW()) RETURNING id`,
      DOCTORB_UID, DOCTORB_PHONE, DOCTOR_B_NAME);
    doctorBUserId = Number(db[0].id);

    const p1 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'AdminCorrectness Patient One', 'PATIENT', true, NOW()) RETURNING id`,
      PATIENT1_UID, PATIENT1_PHONE);
    patient1IntId = Number(p1[0].id);

    const p2 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'AdminCorrectness Patient Two', 'PATIENT', true, NOW()) RETURNING id`,
      PATIENT2_UID, PATIENT2_PHONE);
    patient2IntId = Number(p2[0].id);

    // --- Doctor profiles -----------------------------------------------------
    // Doctor A: doctors.id = high seed; doctors.user_id = doctorAUserId.
    // Doctor B: doctors.id = doctorAUserId (DELIBERATE COLLISION) so the BROKEN
    //   join `doctors.id = a.doctor_id` matches Doctor B for appointments that
    //   are really Doctor A's. The CORRECT join `doctors.user_id = a.doctor_id`
    //   matches Doctor A. This is the doctor-attribution proof.
    const seed = await prisma.$queryRawUnsafe(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(id) FROM users), 0),
         COALESCE((SELECT MAX(id) FROM doctors), 0)
       )::int + 71000 AS id`);
    const doctorAProfileId = Number(seed[0].id);

    await prisma.$queryRawUnsafe(
      `INSERT INTO doctors (id, user_id, name, department, department_id, specialty,
         is_active, is_available, max_appointments_per_day, available_days, updated_at)
       VALUES ($1::int, $2::int, $3, $4, $5::int, 'Cardiologist',
         true, true, 20, ARRAY['Mon','Tue'], NOW())`,
      doctorAProfileId, doctorAUserId, DOCTOR_A_NAME, DEPT_A_NAME, deptAId);

    // Doctor B's doctors.id == doctorAUserId (the collision). user_id =
    // doctorBUserId, department B. doctorAUserId is far below doctorAProfileId
    // (SERIAL), so the PK is free.
    await prisma.$queryRawUnsafe(
      `INSERT INTO doctors (id, user_id, name, department, department_id, specialty,
         is_active, is_available, max_appointments_per_day, available_days, updated_at)
       VALUES ($1::int, $2::int, $3, $4, $5::int, 'Neurologist',
         true, true, 20, ARRAY['Mon','Tue'], NOW())`,
      doctorAUserId, doctorBUserId, DOCTOR_B_NAME, DEPT_B_NAME, deptBId);

    // --- Appointments --------------------------------------------------------
    // All for Doctor A (doctor_id = doctorAUserId, a users.id). Distinct
    // appointment_time per active row (the active-slot unique index forbids two
    // ACTIVE appts in the same doctor/date/time slot; NO_SHOW/CANCELLED are
    // exempt). On apptDate Doctor A has 7 rows:
    //   3 SCHEDULED + 2 COMPLETED + 1 SCHEDULED(→cancel later) + 1 NO_SHOW.
    // Analytics in-window (timeframe=90d, doctor_id=A) before any write test:
    //   scheduled = 3(apptDate) + 1(cancel seed, still SCHEDULED) + 1(overdue) = 5
    //   completed = 2 ; cancelled = 0 ; no_shows = 2 (apptDate 15:00 + noShowPastDate).
    let uidCounter = 0;
    const mkAppt = ({ patientId, patientName, date, time, status }) => {
      uidCounter += 1;
      const suffix = String(uidCounter).padStart(2, '0');
      const phone = patientId === patient1IntId ? PATIENT1_PHONE : PATIENT2_PHONE;
      return prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (uid, phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time, status, reason, department,
            admin_override, reminder_sent, created_at, updated_at)
         VALUES ($1::uuid, $2, $3::int, $4, $5::int, $6,
            $7::date, $8, $9, 'Correctness seed', $10,
            false, false, NOW(), NOW())
         RETURNING id`,
        `c9999999-9999-4999-8999-9999999920${suffix}`,
        phone, patientId, patientName, doctorAUserId, DOCTOR_A_NAME,
        date, time, status, DEPT_A_NAME);
    };

    // SCHEDULED x3 on apptDate (distinct times)
    await mkAppt({ patientId: patient1IntId, patientName: 'AdminCorrectness Patient One', date: apptDate, time: '10:00', status: 'SCHEDULED' });
    await mkAppt({ patientId: patient2IntId, patientName: 'AdminCorrectness Patient Two', date: apptDate, time: '10:30', status: 'SCHEDULED' });
    const s3 = await mkAppt({ patientId: patient1IntId, patientName: 'AdminCorrectness Patient One', date: apptDate, time: '12:00', status: 'SCHEDULED' });
    bulkApptId = Number(s3[0].id); // target of bulk-update-status

    // COMPLETED x2 on apptDate
    await mkAppt({ patientId: patient1IntId, patientName: 'AdminCorrectness Patient One', date: apptDate, time: '13:00', status: 'COMPLETED' });
    await mkAppt({ patientId: patient2IntId, patientName: 'AdminCorrectness Patient Two', date: apptDate, time: '13:30', status: 'COMPLETED' });

    // SCHEDULED on apptDate → resolve-conflict will cancel this one (write test)
    const c1 = await mkAppt({ patientId: patient1IntId, patientName: 'AdminCorrectness Patient One', date: apptDate, time: '14:00', status: 'SCHEDULED' });
    cancelApptId = Number(c1[0].id);

    // NO_SHOW x2 for Patient 2 (one on apptDate, one on a separate past date)
    await mkAppt({ patientId: patient2IntId, patientName: 'AdminCorrectness Patient Two', date: apptDate, time: '15:00', status: 'NO_SHOW' });
    await mkAppt({ patientId: patient2IntId, patientName: 'AdminCorrectness Patient Two', date: noShowPastDate, time: '09:00', status: 'NO_SHOW' });

    // Overdue: a recent-PAST-dated SCHEDULED appt (appointment_date < NOW()).
    const od = await mkAppt({ patientId: patient1IntId, patientName: 'AdminCorrectness Patient One', date: overdueDate, time: '08:00', status: 'SCHEDULED' });
    overdueApptId = Number(od[0].id);

    admin = mkClient('ADMIN', ADMIN_UID, adminIntId, ADMIN_PHONE);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── 1. ANALYTICS: overall counts + rates ─────────────────────────────────
  // Current broken code compares lowercase status → all counts 0.
  it('GET /analytics → overall counts reflect UPPERCASE statuses (not all zero)', async () => {
    const res = await admin.get(`/api/v1/appointments/admin/analytics?timeframe=90d&doctor_id=${doctorAUserId}`);
    expect(res.statusCode).toBe(200);
    const overall = res.body.data.overall;
    expect(Number(overall.scheduled)).toBe(5);
    expect(Number(overall.completed)).toBe(2);
    expect(Number(overall.no_shows)).toBe(2);
    // Rates are derived from those counts → must be > 0 (broken code → 0/null).
    expect(Number(overall.completion_rate)).toBeGreaterThan(0);
    expect(Number(overall.no_show_rate)).toBeGreaterThan(0);
  });

  // The doctor_id analytics filter joins doctors → proves the doctor join too:
  // with the broken `doctors.id = a.doctor_id`, filtering by Doctor A's user id
  // returns rows only via doctor_id equality (no join needed), but the
  // departmentBreakdown JOIN drops them. Assert departmentBreakdown attributes
  // Doctor A's appointments to Department A (not B).
  it('GET /analytics → departmentBreakdown attributes appts to Doctor A\'s department', async () => {
    const res = await admin.get(`/api/v1/appointments/admin/analytics?timeframe=90d&doctor_id=${doctorAUserId}`);
    expect(res.statusCode).toBe(200);
    const depts = res.body.data.departmentBreakdown;
    const deptA = depts.find((d) => d.department === DEPT_A_NAME);
    expect(deptA).toBeDefined();
    expect(Number(deptA.appointments)).toBeGreaterThan(0);
    // Must NOT be attributed to Department B (Doctor B's department).
    expect(depts.find((d) => d.department === DEPT_B_NAME)).toBeUndefined();
  });

  // ── 2. NO-SHOWS report ───────────────────────────────────────────────────
  // Current broken code: COUNT(status='no_show') is 0 → HAVING >= threshold
  // excludes everyone → empty.
  it('GET /no-shows → patient with >=2 NO_SHOW appears with no_show_count>=2', async () => {
    const res = await admin.get('/api/v1/appointments/admin/no-shows?timeframe=90d&threshold=2');
    expect(res.statusCode).toBe(200);
    const list = res.body.data.noShowPatients;
    const p2 = list.find((r) => Number(r.id) === patient2IntId);
    expect(p2).toBeDefined();
    expect(Number(p2.no_show_count)).toBeGreaterThanOrEqual(2);
  });

  // ── 3. CAPACITY + doctor attribution ─────────────────────────────────────
  // Current broken join `doctors.id = a.doctor_id`: Doctor A's appointments
  // attach to Doctor B's row (collision) → Doctor A shows 0 booked; Doctor B
  // shows the bookings under the WRONG name.
  it('GET /capacity → Doctor A (correct name) carries the booked appointments', async () => {
    const res = await admin.get(`/api/v1/appointments/admin/capacity?date=${apptDate}`);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.doctorCapacity;
    const docA = rows.find((r) => r.doctor_name === DOCTOR_A_NAME);
    expect(docA).toBeDefined();
    // On apptDate Doctor A has 7 rows (3 SCHEDULED + 2 COMPLETED + 1 SCHEDULED
    // + 1 NO_SHOW) — capacity counts ALL rows on the date (no status filter).
    expect(Number(docA.booked_appointments)).toBe(7);
    // The booked appointments must NOT be attributed to Doctor B.
    const docB = rows.find((r) => r.doctor_name === DOCTOR_B_NAME);
    if (docB) {
      expect(Number(docB.booked_appointments)).toBe(0);
    }
  });

  // ── 4. SEARCH / overdue flag ─────────────────────────────────────────────
  // A past-dated SCHEDULED appt must carry effective_status 'overdue'. Current
  // broken code: `a.status = 'scheduled'` (lowercase) never matches → never
  // overdue. (search also JOINs doctors → exercises the doctor join.)
  it('GET /search → past-dated SCHEDULED appt is flagged overdue', async () => {
    const res = await admin.get('/api/v1/appointments/admin/search?limit=200&include_cancelled=true&patient_phone=' + encodeURIComponent(PATIENT1_PHONE));
    expect(res.statusCode).toBe(200);
    const appts = res.body.data.appointments;
    const overdue = appts.find((a) => Number(a.id) === overdueApptId);
    expect(overdue).toBeDefined();
    expect(overdue.effective_status).toBe('overdue');
    // Doctor join proof: the row must carry Doctor A's name.
    expect(overdue.doctor_name).toBe(DOCTOR_A_NAME);
  });

  // ── 5. CONFLICTS (shape only — see file header) ──────────────────────────
  // The window predicate is computed on appointment_date (a DATE) so the
  // self-join can't surface same-day conflicts, and the DB's active-slot unique
  // index forbids two active same-slot rows. We only assert the two in-scope
  // fixes (status casing + doctor join) keep the endpoint returning 200 with the
  // right envelope shape; the deeper time-window semantics are a separate bug.
  it('GET /conflicts → returns 200 with the conflicts envelope (status casing + doctor join applied)', async () => {
    const res = await admin.get(`/api/v1/appointments/admin/conflicts?date=${apptDate}&doctor_id=${doctorAUserId}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data.conflicts)).toBe(true);
    expect(typeof res.body.data.totalConflicts).toBe('number');
  });

  // ── 6. BULK-UPDATE-STATUS (write) ────────────────────────────────────────
  // Client sends lowercase 'completed'; the DB row must end up canonical
  // UPPERCASE 'COMPLETED'. Current broken code writes 'completed'.
  it('POST /bulk-update-status → stores canonical UPPERCASE status', async () => {
    const res = await admin.post('/api/v1/appointments/admin/bulk-update-status').send({
      appointment_ids: [bulkApptId],
      status: 'completed',
      reason: 'AdminCorrectness bulk update',
    });
    expect([200, 201]).toContain(res.statusCode);
    const row = await prisma.$queryRawUnsafe(
      `SELECT status FROM appointments WHERE id = $1`, bulkApptId);
    expect(row[0].status).toBe('COMPLETED');
  });

  // ── 7. RESOLVE-CONFLICT (write) ──────────────────────────────────────────
  // Cancelling via resolve-conflict must store canonical UPPERCASE 'CANCELLED'.
  // Current broken code writes 'cancelled'. cancel_second cancels
  // conflict_appointments[1]; we pass cancelApptId 2nd.
  it('POST /resolve-conflict → cancelled row stores canonical UPPERCASE status', async () => {
    const res = await admin.post('/api/v1/appointments/admin/resolve-conflict').send({
      conflict_appointments: [bulkApptId, cancelApptId],
      resolution_action: 'cancel_second',
    });
    expect([200, 201]).toContain(res.statusCode);
    const row = await prisma.$queryRawUnsafe(
      `SELECT status FROM appointments WHERE id = $1`, cancelApptId);
    expect(row[0].status).toBe('CANCELLED');
  });
});
