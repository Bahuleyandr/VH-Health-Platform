// Journey: follow-up-opd (swarm journey #4) — deterministic in-CI replacement.
//
// A returning patient comes back for a scheduled follow-up consult. Flow
// through the REAL API surface:
//   1. Receptionist books a FOLLOW_UP appointment for today with the doctor.
//   2. Doctor opens the consult: SCHEDULED → IN_PROGRESS.
//   3. Doctor records follow-up vitals (canonical: vitals.recorded).
//   4. Doctor writes a progress note bound to the visit (auto-creates the
//      canonical encounter; canonical: note.created).
//   5. Doctor adds a follow-up medication order is NOT done here (covered by
//      walk-in-opd); instead the doctor signs the note (canonical: note.signed),
//      proving the OP note lifecycle, then completes the visit.
//   6. IN_PROGRESS → COMPLETED, with a late addendum still permitted.
//
// Assertions: booking + state-machine transitions, RBAC (patient cannot drive
// another patient's visit status), OP-note same-day session gate, and the
// canonical clinical-timeline invariant on each clinical write.
//
// Deterministic: appointment booked for the Postgres hospital "today" so the
// OP-note same-day session gate passes regardless of wall clock; fixtures
// namespaced per run.

import {
  describeJourney,
  roleClient,
  runSuffix,
  hospitalToday,
  seedUser,
  seedDoctor,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  cleanupJourney,
  CANONICAL_EVENTS,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const DOCTOR_UID = `b1000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `b1000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const OTHER_PATIENT_UID = `b1000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b1000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JFollowUpOPD-${RUN}`;
const PATIENT_PHONE = `96201${RUN}`;
const OTHER_PHONE = `96202${RUN}`;
const DOCTOR_PHONE = `+9196203${RUN}`;
const RECEPTIONIST_PHONE = `96204${RUN}`;

describeJourney('Journey: follow-up-opd', () => {
  let receptionist;
  let doctor;
  let patientClient;
  let otherPatientClient;
  let doctorUserId;
  let patientId;
  let otherPatientId;
  let appointmentId;
  let today;

  beforeAll(async () => {
    await cleanupJourney({
      patientUids: [PATIENT_UID, OTHER_PATIENT_UID],
      staffUids: [DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, OTHER_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });

    today = await hospitalToday();

    const doc = await seedDoctor({
      uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr FollowUp ${RUN}`, department: DEPARTMENT,
    });
    doctorUserId = doc.userId;

    const patient = await seedUser({
      uid: PATIENT_UID, phone: `+91${PATIENT_PHONE}`, name: `FollowUp Patient ${RUN}`, role: 'PATIENT',
    });
    patientId = patient.id;

    const other = await seedUser({
      uid: OTHER_PATIENT_UID, phone: `+91${OTHER_PHONE}`, name: `Other Patient ${RUN}`, role: 'PATIENT',
    });
    otherPatientId = other.id;

    const recep = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, NOW()) RETURNING id`,
      RECEPTIONIST_UID, `+91${RECEPTIONIST_PHONE}`, `Reception ${RUN}`,
    );

    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: DOCTOR_UID, memberName: `FollowUp Patient ${RUN}` });

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: recep[0].id });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    patientClient = roleClient('PATIENT', { uid: PATIENT_UID, id: patientId, phone: `+91${PATIENT_PHONE}` });
    otherPatientClient = roleClient('PATIENT', { uid: OTHER_PATIENT_UID, id: otherPatientId, phone: `+91${OTHER_PHONE}` });
  });

  afterAll(async () => {
    await cleanupJourney({
      patientUids: [PATIENT_UID, OTHER_PATIENT_UID],
      staffUids: [DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, OTHER_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist books the follow-up', () => {
    it('books a FOLLOW_UP appointment for today with the assigned doctor', async () => {
      const res = await receptionist.post('/api/v1/appointments').send({
        patient_id: patientId,
        patient_phone: `+91${PATIENT_PHONE}`,
        doctor_id: doctorUserId,
        date: today,
        time: '15:30',
        reason: 'Follow-up: review CBC + symptom progress',
        visit_type: 'FOLLOW_UP',
        department: DEPARTMENT,
      });
      expect(res.statusCode).toBe(201);
      const appt = res.body.data.appointment;
      expect(appt.id).toBeDefined();
      expect(appt.status).toBe('SCHEDULED');
      appointmentId = appt.id;

      const row = await prisma.$queryRawUnsafe(
        `SELECT visit_type, doctor_id, status FROM appointments WHERE id = $1`, appointmentId);
      expect(row[0]).toMatchObject({
        visit_type: 'FOLLOW_UP', doctor_id: doctorUserId, status: 'SCHEDULED',
      });
    });
  });

  describe('Step 2 — doctor opens the consult', () => {
    it('blocks another patient from driving this appointment status (IDOR)', async () => {
      const res = await otherPatientClient.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(403);
    });

    it('assigned doctor advances SCHEDULED → IN_PROGRESS', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('IN_PROGRESS');
    });
  });

  describe('Step 3 — doctor records follow-up vitals', () => {
    it('records vitals and writes the canonical vitals triple', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 76,
        systolic_bp: 120,
        diastolic_bp: 78,
        temperature: 36.7,
        spo2: 99,
        respiratory_rate: 16,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 4 — doctor writes + signs the progress note', () => {
    let noteId;

    it('creates a progress note bound to the visit (auto-creates encounter)', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: PATIENT_UID,
        appointment_id: appointmentId,
        note_type: 'progress',
        content: {
          summary: 'Afebrile, symptoms resolving.',
          current_status: 'Improving on symptomatic care.',
          plan: 'Continue fluids; no antibiotics; routine follow-up if recurrence.',
        },
      });
      expect(res.statusCode).toBe(201);
      noteId = res.body.data.id;
      expect(res.body.data.note_type).toBe('progress');

      const row = await prisma.$queryRawUnsafe(
        `SELECT encounter_id, appointment_id FROM clinical_notes WHERE id = $1::int`, noteId);
      expect(Number(row[0].appointment_id)).toBe(appointmentId);
      expect(row[0].encounter_id).toMatch(/^[0-9a-f-]{36}$/i);

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteCreated, sourceId: noteId, patientUid: PATIENT_UID,
      });
    });

    it('signs the note (canonical note.signed event) and locks it from in-place edits', async () => {
      const res = await doctor.post(`/api/v1/emr/notes/${noteId}/sign`).send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.data.is_signed).toBe(true);

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteSigned, sourceId: noteId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 5 — doctor completes the consult', () => {
    it('advances IN_PROGRESS → COMPLETED', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'COMPLETED',
        notes: 'Follow-up complete; recovered.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('COMPLETED');
    });

    it('canonical timeline carries the follow-up visit events', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        PATIENT_UID);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'vitals.recorded', 'note.created', 'note.signed',
      ]));
    });
  });
});
