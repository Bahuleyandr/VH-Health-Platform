// Regression test for the P2 finding:
//   POST /api/v1/clinical/progress-notes 500s on OPD note save.
//
// The discoverability alias folded appointment_id into encounter_id
// (`encounter_id: req.body.encounter_id || req.body.appointment_id`). For an
// OPD note that put an INTEGER appointment id into the UUID encounter lookup
// (prisma.admissions.findFirst({ where: { encounter_id } })), throwing a type
// error → 500. createNote already binds OPD notes via a separate
// appointment_id param (migration 240); the route now passes both keys
// distinctly. Canonical encounter lifecycle support may additionally bind the
// note to the appointment's UUID patient_encounters row.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a90901';
const DOCTOR_UID = 'a9a9a9a9-a9a9-4a9a-8a9a-a9a9a9a90902';
const TODAY_HOSPITAL_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

describe('POST /clinical/progress-notes — OPD note save (no 500)', () => {
  let patientId;
  let appointmentId;
  let createdNoteId;
  const doctorToken = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 990902 });

  beforeAll(async () => {
    const u = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9009090901', 'Progress Note Patient', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`, PATIENT_UID);
    patientId = u[0].id;

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (patient_id, doctor_id, appointment_date, appointment_time, phone, reason,
          status, department, updated_at)
       VALUES ($1, NULL, $2::date, '11:00', '9009090901', 'OPD follow-up',
               'CONFIRMED', 'General Medicine', NOW())
       RETURNING id`, patientId, TODAY_HOSPITAL_DATE);
    appointmentId = a[0].id;
  });

  afterAll(async () => {
    if (createdNoteId) {
      await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE id = $1::int`, createdNoteId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    if (appointmentId) {
      await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE id = $1::int`, appointmentId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('saves an OPD progress note bound to the appointment (201, not 500)', async () => {
    const res = await request(app)
      .post('/api/v1/clinical/progress-notes')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        patient_uid: PATIENT_UID,
        appointment_id: appointmentId,
        note_type: 'consultant_round', // alias → 'progress'
        content: 'OPD follow-up: patient stable, continue current medications.',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.note_type).toBe('progress');
    createdNoteId = res.body.data.id;

    // The fix routes appointment_id to the appointment binding. Canonical OP
    // encounters also stamp the UUID encounter_id so note/timeline/signature
    // lifecycle state can be audited per visit.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT appointment_id, encounter_id FROM clinical_notes WHERE id = $1::int`,
      createdNoteId,
    );
    expect(Number(rows[0].appointment_id)).toBe(appointmentId);
    expect(rows[0].encounter_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects an unknown appointment_id with 404 (not 500)', async () => {
    const res = await request(app)
      .post('/api/v1/clinical/progress-notes')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        patient_uid: PATIENT_UID,
        appointment_id: 2000000001,
        note_type: 'progress',
        content: 'note text',
      });

    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
