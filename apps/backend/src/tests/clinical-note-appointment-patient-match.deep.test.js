// createNote appointment↔patient consistency guard — deep integration (#3c).
//
// Finding (#3c): createNote bound a note to an appointment via appointment_id
// but never checked that the note's patient_uid matched the APPOINTMENT's
// patient. A clinician authorized to write on appointment X (patient A) could
// therefore pass patient_uid = B and have the note + its canonical
// timeline/audit events recorded onto patient B's chart while cross-linked to
// A's visit — a cross-patient integrity / medico-legal defect.
//
// This suite proves the guard:
//   1. REJECTS a note whose patient_uid differs from the appointment's patient
//      (code NOTE_APPOINTMENT_PATIENT_MISMATCH) and writes nothing; and
//   2. does NOT false-fire on a MATCHING patient (the only rejection there is
//      the unrelated terminal-session guard, OP_NOTE_SESSION_CLOSED) — so the
//      consistency check is scoped to genuine mismatches.
// Both cases reject before the clinical write, so no downstream rows are
// created (trivial cleanup).
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import { createNote } from '../services/emr/clinicalNotesService.js';

const prisma = (await import('../lib/prisma.js')).default;

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_A_UID = 'c3a70000-0000-4000-8000-0000000003a1';
const PATIENT_B_UID = 'c3a70000-0000-4000-8000-0000000003b2';
const DOCTOR_UID = 'c3a70000-0000-4000-8000-0000000003d3';
const PHONE_A = '+919000300001';
const PHONE_B = '+919000300002';
const PHONE_D = '+919000300003';

const OP_CONTENT = {
  chief_complaint: 'Cough x3 days',
  history: 'No fever',
  examination: 'Chest clear',
  diagnosis: 'URTI',
  plan: 'Rest, fluids',
};

async function cleanup() {
  // Defensive: both test cases reject before any write, but clean prior runs.
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_notes WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE phone IN ($1, $2, $3)`,
    PHONE_A, PHONE_B, PHONE_D,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID, DOCTOR_UID,
  );
}

async function seedUser(uid, phone, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW()) RETURNING id`,
    uid, phone, name, role,
  );
  return rows[0].id;
}

// Appointment for patient A. doctor_id is intentionally NULL so the
// assigned-clinician guard is a no-op and the patient-consistency guard is the
// property under test. `status` lets each case land on the intended branch.
async function seedAppointmentForA(patientAId, status) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (uid, phone, patient_id, doctor_id, appointment_date, appointment_time,
        status, department, tenant_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2::int, NULL, CURRENT_DATE, '10:00',
             $3, 'General Medicine', $4::uuid, NOW())
     RETURNING id`,
    PHONE_A, patientAId, status, TENANT,
  );
  return rows[0].id;
}

d('createNote — appointment/patient consistency (#3c)', () => {
  let patientAId;
  let openApptId;
  let terminalApptId;

  beforeAll(async () => {
    await cleanup();
    patientAId = await seedUser(PATIENT_A_UID, PHONE_A, 'PATIENT', 'Patient A');
    await seedUser(PATIENT_B_UID, PHONE_B, 'PATIENT', 'Patient B');
    await seedUser(DOCTOR_UID, PHONE_D, 'DOCTOR', 'Dr Guard');
    openApptId = await seedAppointmentForA(patientAId, 'CONFIRMED');
    terminalApptId = await seedAppointmentForA(patientAId, 'COMPLETED');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('REJECTS a note whose patient_uid differs from the appointment patient', async () => {
    await expect(createNote({
      appointment_id: openApptId,
      patient_uid: PATIENT_B_UID, // ← mismatch: this appointment belongs to A
      author_uid: DOCTOR_UID,
      author_role: 'DOCTOR',
      note_type: 'op_consultation',
      content: OP_CONTENT,
      tenant_id: TENANT,
    })).rejects.toMatchObject({ code: 'NOTE_APPOINTMENT_PATIENT_MISMATCH' });

    // Nothing was written onto patient B's chart.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM clinical_notes WHERE patient_uid = $1::uuid`,
      PATIENT_B_UID,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  test('does NOT flag a matching patient as a mismatch', async () => {
    // Same patient as the appointment → the consistency guard must PASS. We use
    // a terminal appointment so the call still rejects (OP_NOTE_SESSION_CLOSED)
    // without performing a clinical write — proving the rejection is NOT the
    // patient-mismatch guard false-firing on a legitimate match.
    await expect(createNote({
      appointment_id: terminalApptId,
      patient_uid: PATIENT_A_UID, // ← matches the appointment patient
      author_uid: DOCTOR_UID,
      author_role: 'DOCTOR',
      note_type: 'op_consultation',
      content: OP_CONTENT,
      tenant_id: TENANT,
    })).rejects.toMatchObject({ code: 'OP_NOTE_SESSION_CLOSED' });
  });
});
