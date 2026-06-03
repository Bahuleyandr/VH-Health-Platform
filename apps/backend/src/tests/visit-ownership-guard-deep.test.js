// Regression test for H2 (HIGH, RBAC):
//   2026-05-21-follow-up-opd-doctor-188a603b
//
// An unassigned doctor was correctly DENIED the appointment READ
// (GET /appointments/:id → "Access denied") but could still WRITE/SIGN a
// clinical note for that visit and COMPLETE it:
//   - POST /api/v1/emr/notes              (create progress note)
//   - POST /api/v1/emr/notes/:id/sign     (sign the note)
//   - POST /api/v1/appointments/:id/complete (close the visit)
//
// The fix applies the same assigned-doctor ownership standard the GET/PUT/
// DELETE appointment paths use (checkAppointmentPermission) to these three
// mutating endpoints, via assertCanWriteAppointmentClinical /
// canWriteAppointmentClinical. The assigned doctor (and authorized
// supervisors) succeed; a different, non-supervisory doctor is Forbidden.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b20201';
const ASSIGNED_DOCTOR_UID = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b20202';
const OTHER_DOCTOR_UID = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b20203';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const PROGRESS_NOTE_CONTENT = {
  summary: 'Follow-up: BP controlled.',
  current_status: 'Stable, no new complaints.',
  plan: 'Continue current antihypertensive; review in 4 weeks.',
};

describe('H2 — visit-ownership guard on note create / sign / complete', () => {
  let patientId;
  let assignedDoctorId;
  let otherDoctorId;
  let appointmentId;
  const createdNoteIds = [];

  // Tokens carry both the int `id` (matched against appointments.doctor_id)
  // and the uuid `uid` (matched against the note author / resolved assigned
  // doctor uid) — the fix accepts either identifier.
  let assignedDoctorToken;
  let otherDoctorToken;

  async function clearCareTeam() {
    await prisma.$executeRawUnsafe(`DELETE FROM care_team_members WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM care_teams WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  }

  beforeAll(async () => {
    await clearCareTeam();

    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9020200201', 'H2 Patient', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`, PATIENT_UID);
    patientId = patient[0].id;

    const assigned = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9020200202', 'Dr Assigned', 'DOCTOR', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`, ASSIGNED_DOCTOR_UID);
    assignedDoctorId = assigned[0].id;

    const other = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9020200203', 'Dr Other', 'DOCTOR', true, NOW())
       ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
       RETURNING id`, OTHER_DOCTOR_UID);
    otherDoctorId = other[0].id;

    const appt = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (patient_id, doctor_id, appointment_date, appointment_time, phone, reason,
          status, department, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '10:30', '9020200201', 'OPD follow-up',
               'CONFIRMED', 'General Medicine', NOW())
       RETURNING id`, patientId, assignedDoctorId);
    appointmentId = appt[0].id;

    assignedDoctorToken = generateTestToken('DOCTOR', { uid: ASSIGNED_DOCTOR_UID, id: assignedDoctorId });
    otherDoctorToken = generateTestToken('DOCTOR', { uid: OTHER_DOCTOR_UID, id: otherDoctorId });

    const careTeam = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, appointment_id, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::int, 'op', 'H2 visit ownership test team', 'active', $4::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      appointmentId,
      ASSIGNED_DOCTOR_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO care_team_members
         (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
          relationship_kind, break_glass_allowed, created_by, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'DOCTOR', 'Dr Other',
               'covering_doctor', false, $5::uuid, NOW())`,
      TENANT_ID,
      careTeam[0].id,
      PATIENT_UID,
      OTHER_DOCTOR_UID,
      ASSIGNED_DOCTOR_UID,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    if (appointmentId) {
      await prisma.$executeRawUnsafe(`DELETE FROM appointment_status_history WHERE appointment_id = $1::int`, appointmentId).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE id = $1::int`, appointmentId).catch(() => {});
    }
    await clearCareTeam();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, ASSIGNED_DOCTOR_UID, OTHER_DOCTOR_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  // ---- POST /emr/notes ------------------------------------------------------

  it('blocks a NON-assigned doctor from creating a note on the visit (403)', async () => {
    const res = await request(app)
      .post('/api/v1/emr/notes')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .send({
        patient_uid: PATIENT_UID,
        appointment_id: appointmentId,
        note_type: 'progress',
        content: PROGRESS_NOTE_CONTENT,
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_ASSIGNED_CLINICIAN');

    // Nothing was written under the impostor's identity.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_notes WHERE appointment_id = $1::int`,
      appointmentId,
    );
    expect(rows[0].n).toBe(0);
  });

  it('allows the ASSIGNED doctor to create a note on the visit (201)', async () => {
    const res = await request(app)
      .post('/api/v1/emr/notes')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${assignedDoctorToken}`)
      .send({
        patient_uid: PATIENT_UID,
        appointment_id: appointmentId,
        note_type: 'progress',
        content: PROGRESS_NOTE_CONTENT,
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(String(res.body.data.author_uid)).toBe(ASSIGNED_DOCTOR_UID);
    createdNoteIds.push(res.body.data.id);
  });

  // ---- POST /emr/notes/:id/sign --------------------------------------------

  it('blocks a NON-assigned doctor from signing the visit note (403)', async () => {
    const noteId = createdNoteIds[0];
    expect(noteId).toBeTruthy();

    const res = await request(app)
      .post(`/api/v1/emr/notes/${noteId}/sign`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .send({});

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_ASSIGNED_CLINICIAN');

    const rows = await prisma.$queryRawUnsafe(
      `SELECT is_signed, signed_by FROM clinical_notes WHERE id = $1::int`,
      noteId,
    );
    expect(rows[0].is_signed).toBe(false);
    expect(rows[0].signed_by).toBeNull();
  });

  it('allows the ASSIGNED doctor to sign the visit note (200)', async () => {
    const noteId = createdNoteIds[0];

    const res = await request(app)
      .post(`/api/v1/emr/notes/${noteId}/sign`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${assignedDoctorToken}`)
      .send({});

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.is_signed).toBe(true);
    expect(String(res.body.data.signed_by)).toBe(ASSIGNED_DOCTOR_UID);
  });

  // ---- POST /appointments/:id/complete -------------------------------------

  it('blocks a NON-assigned doctor from completing the visit (403)', async () => {
    const res = await request(app)
      .post(`/api/v1/appointments/${appointmentId}/complete`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${otherDoctorToken}`)
      .send({ notes: 'Visit done.' });

    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status FROM appointments WHERE id = $1::int`,
      appointmentId,
    );
    expect(rows[0].status).not.toBe('COMPLETED');
  });

  it('allows the ASSIGNED doctor to complete the visit (200)', async () => {
    const res = await request(app)
      .post(`/api/v1/appointments/${appointmentId}/complete`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${assignedDoctorToken}`)
      .send({ notes: 'Visit complete, follow-up in 4 weeks.' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('COMPLETED');
  });
});
