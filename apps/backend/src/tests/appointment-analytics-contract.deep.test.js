// OpenAPI Phase 5 (T4) — Appointment ADMIN ANALYTICS / OPERATIONS contract.
// The existing appointment-deep.test.js does NOT exercise the /admin/* cluster,
// so this suite seeds an admin + doctor + two patients + >=2 appointments, then
// drives every typed admin endpoint over HTTP as ADMIN and validates the real
// response against the canonical spec via assertResponse (the live return is the
// source of truth — schemas were authored from the raw handler payloads).
import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { assertResponse } from './helpers/assertSchema.js';

const ADMIN_UID = 'b8888888-8888-4888-8888-888888880a01';
const DOCTOR_UID = 'b8888888-8888-4888-8888-888888880a02';
const PATIENT1_UID = 'b8888888-8888-4888-8888-888888880a03';
const PATIENT2_UID = 'b8888888-8888-4888-8888-888888880a04';
const ADMIN_PHONE = '+919000080001';
const DOCTOR_PHONE = '+919000080002';
const PATIENT1_PHONE = '+919000080003';
const PATIENT2_PHONE = '+919000080004';
const DEPT_NAME = 'P5T4 Analytics Dept';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId, phone) {
  const token = generateTestToken(role, { uid, id: intId, phone });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

// Far-future, weekday-safe date so we never collide with real fixtures.
function futureDateISO(offsetDays = 95) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('Appointment admin analytics / operations — contract deep', () => {
  let adminIntId, doctorIntId, doctorProfileId, departmentId;
  let patient1IntId, patient2IntId;
  let admin;
  let appt1Id, appt2Id;
  const apptDate = futureDateISO(95);

  beforeAll(async () => {
    // --- Clean any prior run -------------------------------------------------
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history WHERE appointment_id IN (
         SELECT id FROM appointments WHERE phone IN ($1,$2,$3,$4))`,
      ADMIN_PHONE, DOCTOR_PHONE, PATIENT1_PHONE, PATIENT2_PHONE,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1,$2,$3,$4)`,
      ADMIN_PHONE, DOCTOR_PHONE, PATIENT1_PHONE, PATIENT2_PHONE,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid))`,
      ADMIN_UID, DOCTOR_UID, PATIENT1_UID, PATIENT2_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
      ADMIN_UID, DOCTOR_UID, PATIENT1_UID, PATIENT2_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM departments WHERE name = $1`, DEPT_NAME).catch(() => {});

    // --- Department ----------------------------------------------------------
    const dept = await prisma.$queryRawUnsafe(
      `INSERT INTO departments (name, is_active, updated_at)
       VALUES ($1, true, NOW()) RETURNING id`, DEPT_NAME);
    departmentId = Number(dept[0].id);

    // --- Users ---------------------------------------------------------------
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'P5T4 Admin', 'ADMIN', true, NOW()) RETURNING id`,
      ADMIN_UID, ADMIN_PHONE);
    adminIntId = Number(a[0].id);

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Dr. P5T4 Analytics', 'DOCTOR', true, NOW()) RETURNING id`,
      DOCTOR_UID, DOCTOR_PHONE);
    doctorIntId = Number(d[0].id);

    const p1 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'P5T4 Patient One', 'PATIENT', true, NOW()) RETURNING id`,
      PATIENT1_UID, PATIENT1_PHONE);
    patient1IntId = Number(p1[0].id);

    const p2 = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'P5T4 Patient Two', 'PATIENT', true, NOW()) RETURNING id`,
      PATIENT2_UID, PATIENT2_PHONE);
    patient2IntId = Number(p2[0].id);

    // --- Doctor profile (links the user to a departments row so the admin
    //     JOINs that need `doctors`/`departments` can resolve) ----------------
    const profileSeed = await prisma.$queryRawUnsafe(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(id) FROM users), 0),
         COALESCE((SELECT MAX(id) FROM doctors), 0)
       )::int + 58000 AS id`);
    const profileSeedId = Number(profileSeed[0].id);
    const dp = await prisma.$queryRawUnsafe(
      `INSERT INTO doctors (id, user_id, name, department, department_id, specialty,
         is_active, is_available, max_appointments_per_day, available_days, updated_at)
       VALUES ($1::int, $2::int, 'Dr. P5T4 Analytics', $3, $4::int, 'Cardiologist',
         true, true, 20, ARRAY['Mon','Tue'], NOW())
       RETURNING id`,
      profileSeedId, doctorIntId, DEPT_NAME, departmentId);
    doctorProfileId = Number(dp[0].id);

    // --- Appointments (>=2, scheduled, on the future date) -------------------
    // appointment.doctor_id = the doctor's USER id (matches the book path +
    // the sla-dashboard / audit-trail joins). uid/phone/doctor_name/admin_override/
    // reminder_sent/status are all NOT NULL.
    const mkAppt = (uidSuffix, patientId, patientName, time, status) => prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (uid, phone, patient_id, patient_name, doctor_id, doctor_name,
          appointment_date, appointment_time, status, reason, department,
          admin_override, reminder_sent, sla_target_at, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::int, $4, $5::int, 'Dr. P5T4 Analytics',
          $6::date, $7, $8, 'Analytics seed', $9,
          false, false, NOW() + INTERVAL '1 hour', NOW(), NOW())
       RETURNING id`,
      `b8888888-8888-4888-8888-8888888810${uidSuffix}`,
      patientId === patient1IntId ? PATIENT1_PHONE : PATIENT2_PHONE,
      patientId, patientName, doctorIntId, apptDate, time, status, DEPT_NAME);

    const r1 = await mkAppt('01', patient1IntId, 'P5T4 Patient One', '10:00', 'SCHEDULED');
    appt1Id = Number(r1[0].id);
    const r2 = await mkAppt('02', patient2IntId, 'P5T4 Patient Two', '10:15', 'COMPLETED');
    appt2Id = Number(r2[0].id);

    // A status-history row so /admin/audit-trail returns at least one entry.
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointment_status_history
         (appointment_id, from_status, to_status, changed_by, changed_by_role, reason, created_at)
       VALUES ($1::int, 'SCHEDULED', 'COMPLETED', $2::int, 'ADMIN', 'Analytics seed', NOW())`,
      appt2Id, adminIntId,
    ).catch(() => {});

    admin = mkClient('ADMIN', ADMIN_UID, adminIntId, ADMIN_PHONE);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history WHERE appointment_id IN (
         SELECT id FROM appointments WHERE phone IN ($1,$2,$3,$4))`,
      ADMIN_PHONE, DOCTOR_PHONE, PATIENT1_PHONE, PATIENT2_PHONE,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1,$2,$3,$4)`,
      ADMIN_PHONE, DOCTOR_PHONE, PATIENT1_PHONE, PATIENT2_PHONE,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid))`,
      ADMIN_UID, DOCTOR_UID, PATIENT1_UID, PATIENT2_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
      ADMIN_UID, DOCTOR_UID, PATIENT1_UID, PATIENT2_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM departments WHERE name = $1`, DEPT_NAME).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  // ========================================================================
  // LIVE-ASSERTED endpoints (return 200 against the real schema; the typed
  // response shape is validated against the actual payload via assertResponse).
  // ========================================================================
  it('GET /admin/search → AppointmentSearchResponse', async () => {
    const res = await admin.get('/api/v1/appointments/admin/search?limit=20&include_cancelled=true');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/search', res.body);
  });

  it('GET /admin/conflicts → AppointmentConflictsResponse', async () => {
    const res = await admin.get(`/api/v1/appointments/admin/conflicts?date=${apptDate}`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/conflicts', res.body);
  });

  it('GET /admin/no-shows → NoShowReportResponse', async () => {
    // threshold=0 so any patient appears regardless of no-show count.
    const res = await admin.get('/api/v1/appointments/admin/no-shows?timeframe=90d&threshold=0');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/no-shows', res.body);
  });

  it('GET /admin/export (JSON branch) → AppointmentExportResponse', async () => {
    const res = await admin.get('/api/v1/appointments/admin/export');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/export', res.body);
  });

  it('GET /admin/sla-dashboard → SlaDashboardResponse', async () => {
    const res = await admin.get('/api/v1/appointments/admin/sla-dashboard');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/sla-dashboard', res.body);
  });

  it('GET /admin/audit-trail → AppointmentAuditTrailResponse', async () => {
    const res = await admin.get('/api/v1/appointments/admin/audit-trail?limit=50');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/audit-trail', res.body);
  });

  it('GET /admin/documents → AppointmentDocumentsResponse', async () => {
    const res = await admin.get('/api/v1/appointments/admin/documents?limit=50');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/documents', res.body);
  });

  it('POST /admin/send-reminders → SendRemindersResponse', async () => {
    const res = await admin.post('/api/v1/appointments/admin/send-reminders').send({
      hours_before: 24,
      exclude_cancelled: true,
    });
    expect([200, 201]).toContain(res.statusCode);
    assertResponse('POST', '/api/v1/appointments/admin/send-reminders', res.body);
  });

  // ========================================================================
  // FORMERLY-500 endpoints — now LIVE-ASSERTED.
  // Each of these five admin handlers carried a pre-existing bug in its raw
  // SQL that made it return 500 against the real schema. The bugs (and fixes,
  // in appointmentAdminRoutes.js) are:
  //   * /analytics     — peakHours SELECT referenced a non-existent column
  //                      `consultation_duration_minutes` (42703). Fixed: model
  //                      avg_duration as NULL::integer, mirroring /export.
  //   * /capacity      — `${whereClause}` was interpolated in the MIDDLE of the
  //                      JOIN chain → `... ON ... WHERE ... LEFT JOIN ...`
  //                      syntax error (42601). Fixed: the date filter moves into
  //                      the `LEFT JOIN appointments a ON ... AND DATE(...)=$1`
  //                      condition; the optional dept filter is a trailing WHERE.
  //   * /bulk-update-status — placeholder offset bug: the id IN-list started at
  //                      `$3`, colliding with `updated_by = $3` (uuid), so an id
  //                      slot bound the uuid → uuid-vs-int (42804). Fixed: ids
  //                      start at `$4`.
  //   * /override-book — INSERT omitted the NOT NULL columns phone/appointment_
  //                      time/updated_at (+ uid/doctor_name) (23502). Fixed:
  //                      resolve phone/doctor_name from the patient/doctor, derive
  //                      appointment_time from appointment_date, gen_random_uuid()
  //                      for uid, NOW() for updated_at.
  //   * /resolve-conflict — UPDATE ... RETURNING referenced a non-existent
  //                      `date` column (42703). Fixed: RETURNING appointment_date.
  // ========================================================================
  it('GET /admin/analytics → AppointmentAnalyticsResponse', async () => {
    const res = await admin.get('/api/v1/appointments/admin/analytics?timeframe=90d');
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/analytics', res.body);
  });

  it('GET /admin/capacity → CapacityAnalysisResponse', async () => {
    const res = await admin.get(`/api/v1/appointments/admin/capacity?date=${apptDate}`);
    expect(res.statusCode).toBe(200);
    assertResponse('GET', '/api/v1/appointments/admin/capacity', res.body);
  });

  it('POST /admin/bulk-update-status → BulkUpdateStatusResponse', async () => {
    const res = await admin.post('/api/v1/appointments/admin/bulk-update-status').send({
      appointment_ids: [appt1Id, appt2Id],
      status: 'completed',
      reason: 'P5T4 bulk update',
    });
    expect([200, 201]).toContain(res.statusCode);
    assertResponse('POST', '/api/v1/appointments/admin/bulk-update-status', res.body);
  });

  it('POST /admin/override-book → OverrideBookResponse', async () => {
    const res = await admin.post('/api/v1/appointments/admin/override-book').send({
      patient_id: patient1IntId,
      doctor_id: doctorIntId,
      appointment_date: `${apptDate} 14:30:00`,
      reason: 'P5T4 override',
      override_reason: 'analytics contract test',
      ignore_conflicts: true,
    });
    expect([200, 201]).toContain(res.statusCode);
    assertResponse('POST', '/api/v1/appointments/admin/override-book', res.body);
  });

  it('POST /admin/resolve-conflict → ResolveConflictResponse', async () => {
    const res = await admin.post('/api/v1/appointments/admin/resolve-conflict').send({
      conflict_appointments: [appt1Id, appt2Id],
      resolution_action: 'cancel_second',
    });
    expect([200, 201]).toContain(res.statusCode);
    assertResponse('POST', '/api/v1/appointments/admin/resolve-conflict', res.body);
  });
});
