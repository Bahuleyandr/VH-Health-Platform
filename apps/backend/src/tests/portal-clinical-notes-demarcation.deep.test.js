// Patient portal clinical-notes demarcation.
//
// Clinical safety invariant: in-hospital notes must never reach the patient
// portal. Only signed OP notes with a first-class appointment_id are visible.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { hospitalToday } from './journeys/_journeyHarness.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'c4e10000-0000-4000-8000-000000000101';
const DOCTOR_UID = 'c4e10000-0000-4000-8000-000000000102';
const PATIENT_PHONE = '+919000420101';
const DOCTOR_PHONE = '+919000420102';

function patientClient(patientId) {
  const token = generateTestToken('PATIENT', {
    uid: PATIENT_UID,
    id: patientId,
    phone: PATIENT_PHONE,
    tenant_id: TENANT,
  });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM video_sessions
      WHERE teleconsultation_id IN (
        SELECT id FROM teleconsultations WHERE patient_uid = $1::uuid
      )`,
    PATIENT_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM teleconsultations WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_consents WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
    PATIENT_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE phone = $1`,
    PATIENT_PHONE,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM doctors WHERE user_id IN (
       SELECT id FROM users WHERE uid IN ($1::uuid, $2::uuid)
     )`,
    PATIENT_UID,
    DOCTOR_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    DOCTOR_UID,
  );
}

async function seedUser(uid, phone, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NOW())
     RETURNING id`,
    TENANT,
    uid,
    phone,
    name,
    role,
  );
  return rows[0].id;
}

async function seedAppointment(patientId, doctorId, { visitType = 'FOLLOW_UP', time = '09:47' } = {}) {
  const today = await hospitalToday();
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (tenant_id, phone, patient_id, doctor_id, doctor_name,
        appointment_date, appointment_time, status, reason, department, visit_type,
        updated_at)
     VALUES ($1::uuid, $2, $3::int, $4::int, 'Dr Portal Demarcation',
             $5::date, $6,
             'COMPLETED', 'Portal OP note demarcation', 'General Medicine',
             $7, NOW())
     RETURNING id`,
    TENANT,
    PATIENT_PHONE,
    patientId,
    doctorId,
    today,
    time,
    visitType,
  );
  return rows[0].id;
}

async function seedTeleconsultation(appointmentId) {
  const consultRows = await prisma.$queryRawUnsafe(
    `INSERT INTO teleconsultations
       (tenant_id, appointment_id, patient_uid, doctor_uid, consult_type, status,
        scheduled_start, remote_consent_id, remote_consent_signed_at,
        recording_consent, metadata, created_by, created_at, updated_at)
     VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'video', 'scheduled',
             NOW(), 'patient_consent:portal-demarcation', NOW(),
             false, '{"source":"portal-demarcation-regression"}'::jsonb,
             $4::uuid, NOW(), NOW())
     RETURNING id`,
    TENANT,
    appointmentId,
    PATIENT_UID,
    DOCTOR_UID,
  );
  const teleconsultationId = consultRows[0].id;
  await prisma.$queryRawUnsafe(
    `INSERT INTO video_sessions
       (tenant_id, teleconsultation_id, provider, external_session_id,
        recording_status, status, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::int, 'livekit', 'tc_portal_demarcation_room',
             'disabled', 'created', '{"source":"portal-demarcation-regression"}'::jsonb,
             NOW(), NOW())`,
    TENANT,
    teleconsultationId,
  );
  return teleconsultationId;
}

async function seedAdmission() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions
       (tenant_id, patient_uid, status, allergies, admission_type, admitted_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', ARRAY[]::text[], 'inpatient', NOW(), NOW())
     RETURNING id, encounter_id`,
    TENANT,
    PATIENT_UID,
  );
  return rows[0];
}

async function seedSignedNote({ noteType, title, content, appointmentId = null, encounterId = null }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_notes
       (tenant_id, patient_uid, encounter_id, appointment_id, author_uid, author_role,
        note_type, title, content, is_signed, signed_at, signed_by, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, 'DOCTOR',
             $6, $7, $8::jsonb, true, NOW(), $5::uuid, 'current', NOW(), NOW())
     RETURNING id`,
    TENANT,
    PATIENT_UID,
    encounterId,
    appointmentId,
    DOCTOR_UID,
    noteType,
    title,
    JSON.stringify(content),
  );
  return rows[0].id;
}

d('patient portal clinical-notes demarcation', () => {
  let patientId;
  let doctorId;
  let appointmentId;
  let teleAppointmentId;
  let opNoteId;
  let teleOpNoteId;
  let ipProgressNoteId;
  let caseSheetNoteId;
  let patient;

  beforeAll(async () => {
    await cleanup();
    patientId = await seedUser(PATIENT_UID, PATIENT_PHONE, 'PATIENT', 'Portal Demarcation Patient');
    doctorId = await seedUser(DOCTOR_UID, DOCTOR_PHONE, 'DOCTOR', 'Dr Portal Demarcation');
    await prisma.$queryRawUnsafe(
      `INSERT INTO doctors
         (tenant_id, user_id, name, department, specialty, is_active, is_available, available_days, updated_at)
       VALUES ($1::uuid, $2::int, 'Dr Portal Demarcation', 'General Medicine',
               'Physician', true, true, ARRAY['Mon','Tue','Wed','Thu','Fri'], NOW())`,
      TENANT,
      doctorId,
    );
    appointmentId = await seedAppointment(patientId, doctorId);
    teleAppointmentId = await seedAppointment(patientId, doctorId, {
      visitType: 'TELE',
      time: '10:47',
    });
    await seedTeleconsultation(teleAppointmentId);
    const admission = await seedAdmission();

    opNoteId = await seedSignedNote({
      noteType: 'op_consultation',
      title: 'Signed OP consultation',
      appointmentId,
      content: {
        chief_complaint: 'Follow-up cough',
        history: 'Improving',
        examination: 'Chest clear',
        diagnosis: 'Resolving URTI',
        plan: 'Continue fluids',
      },
    });
    teleOpNoteId = await seedSignedNote({
      noteType: 'op_consultation',
      title: 'Signed TELE consultation',
      appointmentId: teleAppointmentId,
      content: {
        chief_complaint: 'Teleconsult follow-up',
        history: 'Video consult connected',
        examination: 'Remote review only',
        diagnosis: 'Stable',
        plan: 'Continue current plan',
      },
    });
    ipProgressNoteId = await seedSignedNote({
      noteType: 'progress',
      title: 'Signed IP progress',
      encounterId: admission.encounter_id,
      content: {
        summary: 'Ward round reviewed',
        current_status: 'Stable in ward',
        plan: 'Continue inpatient monitoring',
      },
    });
    caseSheetNoteId = await seedSignedNote({
      noteType: 'case_sheet',
      title: 'Signed admission case sheet',
      encounterId: admission.encounter_id,
      content: {
        chief_complaints: 'Admission workup',
        provisional_diagnosis: 'Observation',
      },
    });

    patient = patientClient(patientId);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('lists only signed OP appointment-bound notes for the patient', async () => {
    const res = await patient.get('/api/v1/portal/clinical-notes');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((row) => row.id).sort((a, b) => a - b))
      .toEqual([opNoteId, teleOpNoteId].sort((a, b) => a - b));
    const byId = new Map(res.body.data.map((row) => [row.id, row]));
    expect(byId.get(opNoteId)).toMatchObject({
      id: opNoteId,
      note_type: 'op_consultation',
      title: 'Signed OP consultation',
    });
    expect(byId.get(teleOpNoteId)).toMatchObject({
      id: teleOpNoteId,
      note_type: 'op_consultation',
      title: 'Signed TELE consultation',
    });
  });

  test('intersects requested note_type with patient-visible vocabulary', async () => {
    const caseSheet = await patient.get('/api/v1/portal/clinical-notes?note_type=case_sheet');
    expect(caseSheet.statusCode).toBe(200);
    expect(caseSheet.body.data).toEqual([]);

    const progress = await patient.get('/api/v1/portal/clinical-notes?note_type=progress');
    expect(progress.statusCode).toBe(200);
    expect(progress.body.data).toEqual([]);
  });

  test('does not expose IP progress or case-sheet notes by id', async () => {
    const ipProgress = await patient.get(`/api/v1/portal/clinical-notes/${ipProgressNoteId}`);
    expect(ipProgress.statusCode).toBe(404);

    const caseSheet = await patient.get(`/api/v1/portal/clinical-notes/${caseSheetNoteId}`);
    expect(caseSheet.statusCode).toBe(404);
  });

  test('appointment-scoped notes require the first-class appointment_id linkage', async () => {
    const res = await patient.get(`/api/v1/portal/clinical-notes/appointment/${appointmentId}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((row) => row.id)).toEqual([opNoteId]);
    expect(res.body.data[0].note_type).toBe('op_consultation');
  });

  test('teleconsult notes use the same appointment-bound OP note path', async () => {
    const res = await patient.get(`/api/v1/portal/clinical-notes/appointment/${teleAppointmentId}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((row) => row.id)).toEqual([teleOpNoteId]);
    expect(res.body.data[0]).toMatchObject({
      note_type: 'op_consultation',
      title: 'Signed TELE consultation',
    });
  });
});
