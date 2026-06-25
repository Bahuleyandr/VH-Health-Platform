// Deep integration tests for appointment booking + status lifecycle.
// Exercises: book → reschedule → status transitions (SCHEDULED → IN_PROGRESS → COMPLETED)
// and SCHEDULED → CANCELLED. Verifies double-booking conflict, IDOR enforcement, and
// side-effects (phone + patient_name + doctor_name populated in the row).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { istDateString } from '../utils/dateUtils.js';
import { assertResponse } from './helpers/assertSchema.js';

const PATIENT_UID = 'a7777777-7777-4777-8777-777777777a01';
const OTHER_PATIENT_UID = 'a7777777-7777-4777-8777-777777777a02';
const DOCTOR_UID = 'a7777777-7777-4777-8777-777777777a03';
const ADMIN_UID = 'a7777777-7777-4777-8777-777777777a04';
const COLLISION_DIRECT_DOCTOR_UID = 'a7777777-7777-4777-8777-777777777a05';
const COLLISION_PROFILE_DOCTOR_UID = 'a7777777-7777-4777-8777-777777777a06';
const RECEPTIONIST_UID = 'a7777777-7777-4777-8777-777777777a07';
const RECEPTION_INCHARGE_UID = 'a7777777-7777-4777-8777-777777777a08';
const PATIENT_PHONE = '+919000070001';
const OTHER_PHONE = '+919000070002';
const API_KEY = process.env.API_KEY || 'test-api-key';

function mkClient(role, uid, intId, phone) {
  const token = generateTestToken(role, { uid, id: intId, phone });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

// A date far enough in the future that no real fixtures sit on it + not on a weekend
// boundary that might trigger business-hours checks. 90 days out is safe.
function futureDateISO(offsetDays = 90) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('Appointment booking + lifecycle — deep integration', () => {
  let patientIntId, otherPatientIntId, doctorIntId, doctorProfileId, adminIntId;
  let receptionistIntId, receptionInchargeIntId;
  let patient, otherPatient, doctor, admin, receptionist, receptionIncharge;
  const apptDate = futureDateISO(90);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions
        WHERE patient_id IN (SELECT id FROM users WHERE uid IN ($1::uuid, $2::uuid))
           OR doctor_id IN (SELECT id FROM users WHERE uid = $3::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM diagnoses WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1, $2)`, PATIENT_PHONE, OTHER_PHONE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid))`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID, ADMIN_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID, ADMIN_UID, RECEPTIONIST_UID, RECEPTION_INCHARGE_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Appointment Test Patient', 'PATIENT', true, NOW())
       RETURNING id`, PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    const op = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Other Appt Patient', 'PATIENT', true, NOW())
       RETURNING id`, OTHER_PATIENT_UID, OTHER_PHONE);
    otherPatientIntId = op[0].id;

    const d = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '+919000070003', 'Dr. Appointment Tester', 'DOCTOR', true, NOW())
       RETURNING id`, DOCTOR_UID);
    doctorIntId = d[0].id;
    const profileIdRows = await prisma.$queryRawUnsafe(
      `SELECT GREATEST(
         COALESCE((SELECT MAX(id) FROM users), 0),
         COALESCE((SELECT MAX(id) FROM doctors), 0)
       )::int + 49000 AS id`,
    );
    doctorProfileId = Number(profileIdRows[0].id);
    const dp = await prisma.$queryRawUnsafe(
      `INSERT INTO doctors (id, user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
       VALUES ($1::int, $2::int, 'Dr. Appointment Tester', 'Cardiology', 'Cardiologist', true, true, ARRAY['Mon','Tue'], NOW())
       RETURNING id`,
      doctorProfileId,
      doctorIntId,
    );
    doctorProfileId = dp[0].id;

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '+919000070004', 'Appointment Admin', 'ADMIN', true, NOW())
       RETURNING id`, ADMIN_UID);
    adminIntId = a[0].id;

    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '+919000070007', 'Appointment Receptionist', 'RECEPTIONIST', true, NOW())
       RETURNING id`, RECEPTIONIST_UID);
    receptionistIntId = r[0].id;

    const ri = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '+919000070008', 'Appointment Reception Incharge', 'RECEPTION_INCHARGE', true, NOW())
       RETURNING id`, RECEPTION_INCHARGE_UID);
    receptionInchargeIntId = ri[0].id;

    patient = mkClient('PATIENT', PATIENT_UID, patientIntId, PATIENT_PHONE);
    otherPatient = mkClient('PATIENT', OTHER_PATIENT_UID, otherPatientIntId, OTHER_PHONE);
    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId, '+919000070003');
    admin = mkClient('ADMIN', ADMIN_UID, adminIntId, '+919000070004');
    receptionist = mkClient('RECEPTIONIST', RECEPTIONIST_UID, receptionistIntId, '+919000070007');
    receptionIncharge = mkClient('RECEPTION_INCHARGE', RECEPTION_INCHARGE_UID, receptionInchargeIntId, '+919000070008');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE patient_id IN ($1, $2) OR doctor_id = $3`,
      patientIntId, otherPatientIntId, doctorIntId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM diagnoses WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1, $2)`, PATIENT_PHONE, OTHER_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM emergency_visits WHERE patient_uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id = $1`, doctorIntId).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID, ADMIN_UID, RECEPTIONIST_UID, RECEPTION_INCHARGE_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 60000); // Cleanup cascades through prescriptions/notes/diagnoses/appointments — needs more than the 5s default on populated DBs.

  describe('createAppointment (POST /book)', () => {
    it('rejects booking without required fields', async () => {
      const res = await patient.post('/api/v1/appointments/book').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects an appointment date in the past', async () => {
      const past = new Date();
      past.setDate(past.getDate() - 5);
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorIntId,
        appointment_date: past.toISOString().slice(0, 10),
        appointment_time: '10:00',
        reason: 'General checkup',
      });
      expect(res.statusCode).toBe(400);
    });

    it('blocks a PATIENT from booking for another patient (IDOR)', async () => {
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: otherPatientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '10:00',
        reason: 'Trying to book for someone else',
      });
      expect(res.statusCode).toBe(400);
      expect(String(res.body.message || '')).toMatch(/only book appointments for yourself/i);
    });

    it('books an appointment, populates phone + doctor_name, writes SCHEDULED', async () => {
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '10:00',
        reason: 'Annual checkup',
      });
      expect(res.statusCode).toBe(201);
      assertResponse('POST', '/api/v1/appointments/book', res.body);
      const a = res.body.data.appointment;
      expect(a.id).toBeDefined();
      expect(a.status).toBe('SCHEDULED');
      expect(a.phone).toBe(PATIENT_PHONE);
      expect(a.doctor_name).toBe('Dr. Appointment Tester');
      expect(a.patient_name).toBe('Appointment Test Patient');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, phone, doctor_id, patient_id, appointment_time FROM appointments WHERE id = $1`, a.id);
      expect(row[0].status).toBe('SCHEDULED');
      expect(row[0].phone).toBe(PATIENT_PHONE);
      expect(row[0].doctor_id).toBe(doctorIntId);
      expect(row[0].patient_id).toBe(patientIntId);
      expect(row[0].appointment_time).toBe('10:00');
    });

    it('routes modern POST /appointments payloads through the booking controller', async () => {
      const res = await admin.post('/api/v1/appointments').send({
        phone: PATIENT_PHONE,
        doctor_id: doctorIntId,
        date: futureDateISO(91),
        time: '09:15',
        reason: 'Receptionist phone-booked follow-up',
        visit_type: 'FOLLOW_UP',
        department: 'Cardiology',
      });

      expect(res.statusCode).toBe(201);
      const a = res.body.data.appointment;
      expect(a.id).toBeDefined();
      expect(a.phone).toBe(PATIENT_PHONE);
      expect(a.appointment_time).toBe('09:15');

      const row = await prisma.$queryRawUnsafe(
        `SELECT visit_type, department, status FROM appointments WHERE id = $1`,
        a.id,
      );
      expect(row[0]).toMatchObject({
        visit_type: 'FOLLOW_UP',
        department: 'Cardiology',
        status: 'SCHEDULED',
      });
    });

    it('normalizes doctors.id picker values to users.id before writing appointment.doctor_id', async () => {
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorProfileId,
        appointment_date: apptDate, appointment_time: '10:30',
        reason: 'Doctor picker id normalization',
        // Same patient already has a SCHEDULED appointment with this
        // doctor today (from the preceding "books an appointment" test);
        // appointmentCrudController's duplicate-same-day guard
        // (finding 2026-05-08-follow-up-opd-receptionist-duplicate-appt-no-warning)
        // requires explicit opt-in. The tests are deliberately stacking
        // time-distinct slots for the same patient.
        confirm_duplicate: true,
      });
      expect(res.statusCode).toBe(201);
      const a = res.body.data.appointment;
      expect(a.doctor_id).toBe(doctorIntId);
      expect(a.doctor_name).toBe('Dr. Appointment Tester');

      const row = await prisma.$queryRawUnsafe(
        `SELECT doctor_id FROM appointments WHERE id = $1`, a.id);
      expect(row[0].doctor_id).toBe(doctorIntId);
    });

    it('accepts doctor_uid from the staff picker to avoid numeric id collisions', async () => {
      const res = await receptionist.post('/api/v1/appointments/book').send({
        patient_id: patientIntId,
        doctor_id: 999999,
        doctor_uid: DOCTOR_UID,
        appointment_date: apptDate,
        appointment_time: '10:40',
        reason: 'Doctor UUID picker booking',
        confirm_duplicate: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.appointment.doctor_id).toBe(doctorIntId);
    });

    it('prefers canonical users.id when it collides with a different doctors.id', async () => {
      let collisionId;
      let profileDoctorUserId;

      try {
        await prisma.$executeRawUnsafe(
          `DELETE FROM appointments WHERE reason = 'Ambiguous doctor ref smoke'`,
        ).catch(() => {});
        await prisma.$executeRawUnsafe(
          `DELETE FROM doctors
            WHERE user_id IN (SELECT id FROM users WHERE uid IN ($1::uuid, $2::uuid))`,
          COLLISION_DIRECT_DOCTOR_UID,
          COLLISION_PROFILE_DOCTOR_UID,
        ).catch(() => {});
        await prisma.$executeRawUnsafe(
          `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
          COLLISION_DIRECT_DOCTOR_UID,
          COLLISION_PROFILE_DOCTOR_UID,
        ).catch(() => {});

        const idRows = await prisma.$queryRawUnsafe(
          `SELECT GREATEST(
             COALESCE((SELECT MAX(id) FROM users), 0),
             COALESCE((SELECT MAX(id) FROM doctors), 0)
           )::int + 50000 AS id`,
        );
        collisionId = Number(idRows[0].id);

        await prisma.$executeRawUnsafe(
          `INSERT INTO users (id, uid, phone, name, role, is_active, updated_at)
           VALUES ($1::int, $2::uuid, '+919000070005', 'Dr. Direct Collision', 'DOCTOR', true, NOW())`,
          collisionId,
          COLLISION_DIRECT_DOCTOR_UID,
        );
        const profileRows = await prisma.$queryRawUnsafe(
          `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
           VALUES ($1::uuid, '+919000070006', 'Dr. Profile Collision', 'DOCTOR', true, NOW())
           RETURNING id`,
          COLLISION_PROFILE_DOCTOR_UID,
        );
        profileDoctorUserId = profileRows[0].id;
        await prisma.$executeRawUnsafe(
          `INSERT INTO doctors
             (id, user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
           VALUES ($1::int, $2::int, 'Dr. Profile Collision', 'Cardiology', 'Cardiologist',
                   true, true, ARRAY['Mon','Tue'], NOW())`,
          collisionId,
          profileDoctorUserId,
        );

        const res = await patient.post('/api/v1/appointments/book').send({
          patient_id: patientIntId,
          doctor_id: collisionId,
          appointment_date: apptDate,
          appointment_time: '10:45',
          reason: 'Ambiguous doctor ref smoke',
          confirm_duplicate: true,
        });

        expect(res.statusCode).toBe(201);
        expect(res.body.data.appointment.doctor_id).toBe(collisionId);
        expect(res.body.data.appointment.doctor_name).toBe('Dr. Direct Collision');
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM appointments WHERE reason = 'Ambiguous doctor ref smoke'`,
        ).catch(() => {});
        if (collisionId) {
          await prisma.$executeRawUnsafe(
            `DELETE FROM doctors WHERE id = $1::int`,
            collisionId,
          ).catch(() => {});
        }
        await prisma.$executeRawUnsafe(
          `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
          COLLISION_DIRECT_DOCTOR_UID,
          COLLISION_PROFILE_DOCTOR_UID,
        ).catch(() => {});
      }
    });

    it('rejects a double-booking on the same doctor/date/time with 409', async () => {
      // First a fresh booking at 11:00. confirm_duplicate because this
      // patient already has SCHEDULED slots earlier today; the test
      // exercises slot-conflict on the second booking by otherPatient,
      // not the same-day-duplicate guard for this patient.
      const ok = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '11:00',
        reason: 'Slot A',
        confirm_duplicate: true,
      });
      expect(ok.statusCode).toBe(201);

      // Second patient tries the same slot → 409
      const clash = await otherPatient.post('/api/v1/appointments/book').send({
        patient_id: otherPatientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '11:00',
        reason: 'Slot A collision',
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.body.details?.conflicting_appointment_id).toBeDefined();
    });
  });

  describe('updateAppointment (reschedule) + status transitions', () => {
    let apptId;

    beforeAll(async () => {
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '14:00',
        reason: 'For lifecycle walk-through',
        // Same patient already has earlier slots booked today; opt past
        // the duplicate-same-day guard.
        confirm_duplicate: true,
      });
      expect(res.statusCode).toBe(201);
      apptId = res.body.data.appointment.id;
    });

    it('reschedules to a new time with PUT /:id and increments nothing else', async () => {
      const res = await patient.put(`/api/v1/appointments/${apptId}`).send({
        appointment_time: '15:00',
      });
      expect(res.statusCode).toBe(200);
      assertResponse('PUT', '/api/v1/appointments/{id}', res.body);
      expect(res.body.data.appointment.appointment_time).toBe('15:00');
    });

    it('refuses reschedule to a conflicting slot (409)', async () => {
      // 10:00 is occupied by an earlier test
      const res = await patient.put(`/api/v1/appointments/${apptId}`).send({
        appointment_time: '10:00',
      });
      expect(res.statusCode).toBe(409);
    });

    it('blocks another patient from updating this appointment (IDOR)', async () => {
      const res = await otherPatient.put(`/api/v1/appointments/${apptId}`).send({
        appointment_time: '16:00',
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects an unknown status value', async () => {
      const res = await admin.put(`/api/v1/appointments/${apptId}/status`).send({
        status: 'BOGUS',
      });
      expect(res.statusCode).toBe(400);
    });

    it('doctor can advance SCHEDULED → IN_PROGRESS', async () => {
      const res = await doctor.put(`/api/v1/appointments/${apptId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(200);
      assertResponse('PUT', '/api/v1/appointments/{id}/status', res.body);
      expect(res.body.data.appointment.status).toBe('IN_PROGRESS');
    });

    it('doctor can update complaint/progress text during an in-progress consult', async () => {
      const res = await doctor.put(`/api/v1/appointments/${apptId}`).send({
        reason: 'Follow-up progress note test',
        notes: 'Follow-up progress note test',
      });
      expect(res.statusCode).toBe(200);
      assertResponse('PUT', '/api/v1/appointments/{id}', res.body);
      expect(res.body.data.addendum).toBe(true);
      expect(res.body.data.appointment.reason).toBe('Follow-up progress note test');
      expect(res.body.data.appointment.notes).toBe('Follow-up progress note test');
    });

    it('doctor advances IN_PROGRESS → COMPLETED', async () => {
      const res = await doctor.put(`/api/v1/appointments/${apptId}/status`).send({
        status: 'COMPLETED',
        notes: 'Consult done, no follow-up',
      });
      expect(res.statusCode).toBe(200);
      assertResponse('PUT', '/api/v1/appointments/{id}/status', res.body);
      expect(res.body.data.appointment.status).toBe('COMPLETED');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, notes FROM appointments WHERE id = $1`, apptId);
      expect(row[0].status).toBe('COMPLETED');
      expect(row[0].notes).toMatch(/Consult done/);
    });

    it('another doctor cannot update someone else\'s appointment status (IDOR)', async () => {
      // Create a second doctor-client bound to a different user id
      const strangerDoctor = mkClient('DOCTOR', '00000000-0000-4000-8000-000000000777', 777777, '9000070777');
      const res = await strangerDoctor.put(`/api/v1/appointments/${apptId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(403);
    });

    // Finding: 2026-05-09-follow-up-opd-doctor-no-edit-after-complete
    // Once an appointment is COMPLETED, a doctor must still be able
    // to append a brief clinical note as a late addendum. Locking the
    // record contradicts the natural OPD flow (see patient → mark
    // complete → write note). Date/time/visit_type stay locked.
    it('doctor can append a late clinical addendum (notes/reason) on a COMPLETED appointment', async () => {
      const res = await doctor.put(`/api/v1/appointments/${apptId}`).send({
        notes: 'Late addendum: BP 130/82 noted on exit.',
        reason: 'Follow-up of seasonal allergy',
      });
      expect(res.statusCode).toBe(200);
      assertResponse('PUT', '/api/v1/appointments/{id}', res.body);
      expect(res.body.data.addendum).toBe(true);
      expect(res.body.data.appointment.notes).toMatch(/Late addendum/);

      const audit = await prisma.$queryRawUnsafe(
        `SELECT action, resource_id, metadata
           FROM audit_logs
          WHERE resource = 'appointment' AND resource_id = $1
            AND action = 'APPOINTMENT_ADDENDUM'
          ORDER BY id DESC LIMIT 1`,
        String(apptId),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0].metadata?.fields).toEqual(
        expect.arrayContaining(['notes', 'reason']),
      );
    });

    it('rejects date/time changes on a COMPLETED appointment', async () => {
      const res = await doctor.put(`/api/v1/appointments/${apptId}`).send({
        appointment_time: '17:00',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Can only update scheduled appointments/);
    });

    it('rejects a patient trying to use the addendum path on a COMPLETED appointment', async () => {
      const res = await patient.put(`/api/v1/appointments/${apptId}`).send({
        notes: 'Patient-side note',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/Can only update scheduled appointments/);
    });
  });

  describe('front office queue reschedule', () => {
    it('keeps the original date row as RESCHEDULED and creates a linked future appointment', async () => {
      const book = await receptionist.post('/api/v1/appointments/book').send({
        patient_id: patientIntId,
        doctor_id: doctorIntId,
        appointment_date: apptDate,
        appointment_time: '16:30',
        reason: 'Queue reschedule regression',
        confirm_duplicate: true,
      });
      expect(book.statusCode).toBe(201);
      const originalId = book.body.data.appointment.id;
      const targetDate = futureDateISO(91);

      const res = await receptionist
        .post(`/api/v1/appointments/${originalId}/reschedule`)
        .send({
          appointment_date: targetDate,
          appointment_time: '17:00',
          confirmation_notes: 'Patient requested next available day',
        });

      expect(res.statusCode).toBe(200);
      assertResponse('POST', '/api/v1/appointments/{id}/reschedule', res.body);
      expect(res.body.data.original.status).toBe('RESCHEDULED');
      expect(res.body.data.appointment.status).toBe('SCHEDULED');
      expect(res.body.data.appointment.parent_appointment_id).toBe(originalId);
      expect(res.body.data.appointment.appointment_date.slice(0, 10)).toBe(targetDate);

      const todayList = await receptionist
        .get(`/api/v1/appointments/list?date=${apptDate}&page=1&limit=100`);
      expect(todayList.statusCode).toBe(200);
      const todayRow = todayList.body.data.appointments.find((row) => row.id === originalId);
      expect(todayRow?.status).toBe('RESCHEDULED');

      const futureList = await receptionist
        .get(`/api/v1/appointments/list?date=${targetDate}&page=1&limit=100`);
      expect(futureList.statusCode).toBe(200);
      const futureRow = futureList.body.data.appointments.find(
        (row) => row.id === res.body.data.appointment.id,
      );
      expect(futureRow?.status).toBe('SCHEDULED');
      expect(futureRow?.parent_appointment_id).toBe(originalId);
    });
  });

  describe('admission counter worklist', () => {
    it('allows reception desk roles to list appointments and receives doctor uid options', async () => {
      const list = await receptionist.get('/api/v1/appointments/list?limit=5');
      expect(list.statusCode).toBe(200);
      expect(Array.isArray(list.body.data?.appointments)).toBe(true);

      const inchargeList = await receptionIncharge.get('/api/v1/appointments/list?limit=5');
      expect(inchargeList.statusCode).toBe(200);

      const options = await receptionist.get('/api/v1/appointments/doctors/options?search=Appointment%20Tester&limit=5');
      expect(options.statusCode).toBe(200);
      const doctorOption = options.body.data?.doctors?.find((row) => row.id === doctorIntId);
      expect(doctorOption).toMatchObject({
        id: doctorIntId,
        uid: DOCTOR_UID,
        name: 'Dr. Appointment Tester',
      });
    });

    it('lists OPD appointments advised for admission at GET /appointments?advised_for_admission=true', async () => {
      const advised = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (phone, patient_id, doctor_id, doctor_name, patient_name,
            appointment_date, appointment_time, status, token_number,
            department, reason, advised_for_admission_at,
            advised_for_admission_by, advised_for_admission_note,
            created_at, updated_at)
         VALUES
           ($1, $2::int, $3::int, 'Dr. Appointment Tester',
            'Appointment Test Patient', CURRENT_DATE, '15:30',
            'COMPLETED', 'ADMIT-001', 'General Medicine',
            'Acute gastroenteritis with dehydration',
            NOW(), $4::uuid, 'Admit for IV fluids and monitoring',
            NOW(), NOW())
         RETURNING id`,
        PATIENT_PHONE,
        patientIntId,
        doctorIntId,
        DOCTOR_UID,
      );
      const routine = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (phone, patient_id, doctor_id, doctor_name, patient_name,
            appointment_date, appointment_time, status, token_number,
            department, reason, created_at, updated_at)
         VALUES
           ($1, $2::int, $3::int, 'Dr. Appointment Tester',
            'Appointment Test Patient', CURRENT_DATE, '15:45',
            'COMPLETED', 'ADMIT-002', 'General Medicine',
            'Routine follow-up without admission advice', NOW(), NOW())
         RETURNING id`,
        PATIENT_PHONE,
        patientIntId,
        doctorIntId,
      );

      const res = await admin.get('/api/v1/appointments?advised_for_admission=true&limit=20');
      expect(res.statusCode).toBe(200);
      const ids = res.body.data.appointments.map((a) => a.id);
      expect(ids).toContain(advised[0].id);
      expect(ids).not.toContain(routine[0].id);
      const row = res.body.data.appointments.find((a) => a.id === advised[0].id);
      expect(row.advised_for_admission_at).toBeTruthy();
      expect(row.advised_for_admission_note).toBe('Admit for IV fluids and monitoring');
      expect(row.doctor_name).toBe('Dr. Appointment Tester');
    });

    // Finding: 2026-05-17-inpatient-admission-receptionist-30bd3752.
    // The canonical advise endpoint at POST /api/v1/appointments/:id/advise-admission
    // exists but the swarm + real receptionists keep probing
    // /api/v1/admissions/advise — added as a discoverable alias.
    it('accepts the discoverable POST /api/v1/admissions/advise alias by appointment_id', async () => {
      // Seed an OPD appointment to advise on.
      const seed = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (phone, patient_id, doctor_id, doctor_name, patient_name,
            appointment_date, appointment_time, status, token_number,
            department, reason, created_at, updated_at)
         VALUES
           ($1, $2::int, $3::int, 'Dr. Appointment Tester',
            'Appointment Test Patient', CURRENT_DATE, '16:00',
            'COMPLETED', 'ADMIT-ALIAS-001', 'General Medicine',
            'OPD doctor signals admission', NOW(), NOW())
         RETURNING id`,
        PATIENT_PHONE, patientIntId, doctorIntId,
      );
      const apptId = seed[0].id;

      // adviseForAdmission requires DOCTOR/CONSULTANT/JUNIOR_DOCTOR/ADMIN/SUPER_ADMIN.
      // Our admin mkClient is ADMIN — call should succeed.
      const res = await admin
        .post('/api/v1/admissions/advise')
        .send({ appointment_id: apptId, note: 'Advise via alias' });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.appointment_id ?? res.body.data.id).toBe(apptId);

      // The underlying row must show the advise stamp set.
      const row = await prisma.$queryRawUnsafe(
        `SELECT advised_for_admission_at, advised_for_admission_note
           FROM appointments WHERE id = $1::int`,
        apptId,
      );
      expect(row[0].advised_for_admission_at).toBeTruthy();
      expect(row[0].advised_for_admission_note).toBe('Advise via alias');
    });
  });

  describe('follow-up list metadata', () => {
    it('preserves visit_type in patient history and the doctor queue', async () => {
      const today = istDateString();
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, phone, appointment_date, appointment_time,
            status, reason, token_number, department, visit_type, updated_at)
         VALUES ($1, $2, $3, $4::date, '23:58', 'CONFIRMED',
            'Follow-up list metadata', '997', 'Cardiology', 'FOLLOW_UP', NOW())
         RETURNING id`,
        patientIntId, doctorIntId, PATIENT_PHONE, today,
      );
      const insertedId = rows[0].id;

      const history = await doctor.get(`/api/v1/appointments/patient/${patientIntId}`);
      expect(history.statusCode).toBe(200);
      const historyRow = history.body.data.appointments.find((a) => a.id === insertedId);
      expect(historyRow).toBeDefined();
      expect(historyRow.visit_type).toBe('FOLLOW_UP');

      const queue = await doctor.get(`/api/v1/appointments/queue/today?doctor_id=${doctorIntId}`);
      expect(queue.statusCode).toBe(200);
      const queueRow = queue.body.data.find((a) => a.id === insertedId);
      expect(queueRow).toBeDefined();
      expect(queueRow.visit_type).toBe('FOLLOW_UP');
    });

    it('includes prior diagnosis, prescription, and note context when opening a follow-up chart', async () => {
      const today = istDateString();
      const prior = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, phone, appointment_date, appointment_time,
            status, reason, token_number, department, visit_type, updated_at)
         VALUES ($1, $2, $3, $4::date, '09:30', 'COMPLETED',
            'Initial allergy visit', '998', 'Cardiology', 'NEW', NOW())
         RETURNING id`,
        patientIntId, doctorIntId, PATIENT_PHONE, today,
      );
      const followUp = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, phone, appointment_date, appointment_time,
            status, reason, token_number, department, visit_type,
            parent_appointment_id, updated_at)
         VALUES ($1, $2, $3, $4::date, '10:00', 'CONFIRMED',
            'Review allergy response', '999', 'Cardiology', 'FOLLOW_UP',
            $5::int, NOW())
         RETURNING id`,
        patientIntId, doctorIntId, PATIENT_PHONE, today, prior[0].id,
      );

      await prisma.$executeRawUnsafe(
        `INSERT INTO e_prescriptions
           (patient_id, patient_uid, doctor_id, doctor_uid, appointment_id,
            medications, diagnosis, status, created_by)
         VALUES ($1::int, $2::uuid, $3::int, $4::uuid, $5::int,
            $6::jsonb, 'Seasonal allergy', 'active', $3::int)`,
        patientIntId,
        PATIENT_UID,
        doctorIntId,
        DOCTOR_UID,
        prior[0].id,
        JSON.stringify([{ name: 'Cetirizine', dosage: '10mg' }]),
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO diagnoses
           (patient_uid, icd10_code, description, diagnosis_type, status, diagnosed_by, created_at)
         VALUES ($1::uuid, 'J30.2', 'Seasonal allergic rhinitis', 'primary', 'active', $2::uuid, NOW())`,
        PATIENT_UID,
        DOCTOR_UID,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO clinical_notes
           (patient_uid, author_uid, author_role, note_type, title, content, is_signed, updated_at)
         VALUES ($1::uuid, $2::uuid, 'DOCTOR', 'progress', 'Initial allergy note',
            $3::jsonb, true, NOW())`,
        PATIENT_UID,
        DOCTOR_UID,
        JSON.stringify({ appointment_id: prior[0].id, assessment: 'Allergic rhinitis, start antihistamine' }),
      );

      const detail = await doctor.get(`/api/v1/appointments/${followUp[0].id}`);
      expect(detail.statusCode).toBe(200);
      assertResponse('GET', '/api/v1/appointments/{id}', detail.body);
      const context = detail.body.data.appointment.follow_up_context;
      expect(context.empty).toBe(false);
      expect(context.parent_appointment.id).toBe(prior[0].id);
      expect(context.latest_prescriptions[0]).toMatchObject({ diagnosis: 'Seasonal allergy' });
      expect(context.latest_diagnoses[0]).toMatchObject({ description: 'Seasonal allergic rhinitis' });
      expect(context.latest_notes[0].content).toMatchObject({
        assessment: 'Allergic rhinitis, start antihistamine',
      });
    });
  });

  describe('deleteAppointment (cancel) + IDOR', () => {
    let apptId;

    beforeAll(async () => {
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '16:00',
        reason: 'For cancel branch',
        // Same patient already has earlier slots booked today; opt past
        // the duplicate-same-day guard.
        confirm_duplicate: true,
      });
      apptId = res.body.data.appointment.id;
    });

    it('blocks another patient from cancelling this appointment (IDOR)', async () => {
      const res = await otherPatient.delete(`/api/v1/appointments/${apptId}`);
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for an unknown appointment id', async () => {
      const res = await patient.delete('/api/v1/appointments/99999999');
      expect(res.statusCode).toBe(404);
    });

    it('owner patient can cancel and status flips to CANCELLED', async () => {
      const res = await patient.delete(`/api/v1/appointments/${apptId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('CANCELLED');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM appointments WHERE id = $1`, apptId);
      expect(row[0].status).toBe('CANCELLED');
    });

    it('releases the slot — a new booking at the same time now succeeds', async () => {
      const res = await patient.post('/api/v1/appointments/book').send({
        patient_id: patientIntId, doctor_id: doctorIntId,
        appointment_date: apptDate, appointment_time: '16:00',
        reason: 'After cancel, slot is free',
        // Same patient still has other earlier slots booked today; the
        // 16:00 slot is the one being re-tested, but the same-day-duplicate
        // guard still fires on any same-patient/doctor/date combo.
        confirm_duplicate: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.appointment.status).toBe('SCHEDULED');
    });
  });

  // Finding 2026-05-22-emergency-walk-in-nurse-2dd88574 (H9, HIGH).
  // An ATS-2 emergency walk-in was triaged via the ED triage-priority
  // endpoint (emergency_visits.triage_priority = 'ats_2'), but the doctor
  // queue only understood esi_* codes: the ATS-2 row came back with
  // acuity_rank=null, is_emergent=false, and sorted BELOW lower-acuity
  // walk-in tokens. The queue now maps every triage scale (esi/ats/ctas/
  // manchester) onto the shared 1..5 urgency rank, mirroring
  // edOperationsService.PRIORITY_RANK_SQL.
  describe('doctor queue honors ATS triage acuity', () => {
    const TODAY = istDateString();
    const TENANT = '00000000-0000-4000-8000-000000000001';
    let edVisitId, emergentApptId, routineApptId;

    beforeAll(async () => {
      // Clear any leftover same-day rows for these two patients so the
      // ordering assertion is deterministic regardless of prior tests.
      await prisma.$executeRawUnsafe(
        `DELETE FROM emergency_visits WHERE patient_uid IN ($1::uuid, $2::uuid)`,
        PATIENT_UID, OTHER_PATIENT_UID,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM appointments
          WHERE doctor_id = $1 AND DATE(appointment_date) = $2::date
            AND token_number IN ('801', '802')`,
        doctorIntId, TODAY,
      );

      // (1) The emergency patient: ATS-2 ED triage + a same-day EMERGENCY
      //     appointment carrying a LATE token (802) so a naive token sort
      //     would push it behind the routine OPD token below.
      const ev = await prisma.$queryRawUnsafe(
        `INSERT INTO emergency_visits
           (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint,
            triage_priority, status, created_by, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, 'police', 'Semi-conscious RTA/MLC',
                 'ats_2', 'arriving', $3::uuid, NOW())
         RETURNING id`,
        TENANT, `EMER-H9-${Date.now()}`, PATIENT_UID,
      );
      edVisitId = ev[0].id;

      const ea = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, phone, appointment_date, appointment_time,
            status, reason, token_number, department, visit_type, updated_at)
         VALUES ($1, $2, $3, $4::date, '23:50', 'CONFIRMED',
            'ER triaged ATS-2', '802', 'Emergency', 'EMERGENCY', NOW())
         RETURNING id`,
        patientIntId, doctorIntId, PATIENT_PHONE, TODAY,
      );
      emergentApptId = ea[0].id;

      // (2) The routine OPD patient: an EARLIER token (801), no ED row.
      const ra = await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (patient_id, doctor_id, phone, appointment_date, appointment_time,
            status, reason, token_number, department, visit_type, updated_at)
         VALUES ($1, $2, $3, $4::date, '09:05', 'CONFIRMED',
            'Routine OPD walk-in', '801', 'Cardiology', 'NEW', NOW())
         RETURNING id`,
        otherPatientIntId, doctorIntId, OTHER_PHONE, TODAY,
      );
      routineApptId = ra[0].id;
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM emergency_visits WHERE id = $1`, edVisitId).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM appointments WHERE id IN ($1, $2)`,
        emergentApptId, routineApptId).catch(() => {});
    });

    it('ranks the ATS-2 ER patient first, emergent, with acuity_rank=2', async () => {
      const res = await doctor.get(`/api/v1/appointments/queue/today?doctor_id=${doctorIntId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);

      const queue = res.body.data;
      const emergent = queue.find((a) => a.id === emergentApptId);
      const routine = queue.find((a) => a.id === routineApptId);
      expect(emergent).toBeDefined();
      expect(routine).toBeDefined();

      // The ATS-2 priority must now be recognised — not dropped to null.
      expect(emergent.triage_priority).toBe('ats_2');
      expect(emergent.acuity_rank).toBe(2);
      expect(emergent.is_emergent).toBe(true);
      expect(emergent.emergency_visit_id).toBe(edVisitId);

      // The routine OPD token stays non-emergent / unranked.
      expect(routine.acuity_rank).toBeNull();
      expect(routine.is_emergent).toBe(false);

      // Ordering: the emergent ER row must sit AHEAD of the routine token,
      // even though its token number (802) is higher than the routine
      // token (801). This is the crux of the finding.
      const emergentIdx = queue.findIndex((a) => a.id === emergentApptId);
      const routineIdx = queue.findIndex((a) => a.id === routineApptId);
      expect(emergentIdx).toBeLessThan(routineIdx);
    });
  });
});
