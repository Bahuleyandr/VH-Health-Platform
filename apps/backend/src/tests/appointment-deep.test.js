// Deep integration tests for appointment booking + status lifecycle.
// Exercises: book → reschedule → status transitions (SCHEDULED → IN_PROGRESS → COMPLETED)
// and SCHEDULED → CANCELLED. Verifies double-booking conflict, IDOR enforcement, and
// side-effects (phone + patient_name + doctor_name populated in the row).

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'a7777777-7777-4777-8777-777777777a01';
const OTHER_PATIENT_UID = 'a7777777-7777-4777-8777-777777777a02';
const DOCTOR_UID = 'a7777777-7777-4777-8777-777777777a03';
const ADMIN_UID = 'a7777777-7777-4777-8777-777777777a04';
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
  let patient, otherPatient, doctor, admin;
  const apptDate = futureDateISO(90);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1, $2)`, PATIENT_PHONE, OTHER_PHONE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id IN (SELECT id FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid))`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID, ADMIN_UID);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID, ADMIN_UID);

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
    const dp = await prisma.$queryRawUnsafe(
      `INSERT INTO doctors (user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
       VALUES ($1, 'Dr. Appointment Tester', 'Cardiology', 'Cardiologist', true, true, ARRAY['Mon','Tue'], NOW())
       RETURNING id`,
      doctorIntId,
    );
    doctorProfileId = dp[0].id;

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '+919000070004', 'Appointment Admin', 'ADMIN', true, NOW())
       RETURNING id`, ADMIN_UID);
    adminIntId = a[0].id;

    patient = mkClient('PATIENT', PATIENT_UID, patientIntId, PATIENT_PHONE);
    otherPatient = mkClient('PATIENT', OTHER_PATIENT_UID, otherPatientIntId, OTHER_PHONE);
    doctor = mkClient('DOCTOR', DOCTOR_UID, doctorIntId, '+919000070003');
    admin = mkClient('ADMIN', ADMIN_UID, adminIntId, '+919000070004');
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1, $2)`, PATIENT_PHONE, OTHER_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM doctors WHERE user_id = $1`, doctorIntId).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID, DOCTOR_UID, ADMIN_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

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
      expect(res.body.data.appointment.status).toBe('IN_PROGRESS');
    });

    it('doctor advances IN_PROGRESS → COMPLETED', async () => {
      const res = await doctor.put(`/api/v1/appointments/${apptId}/status`).send({
        status: 'COMPLETED',
        notes: 'Consult done, no follow-up',
      });
      expect(res.statusCode).toBe(200);
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
});
