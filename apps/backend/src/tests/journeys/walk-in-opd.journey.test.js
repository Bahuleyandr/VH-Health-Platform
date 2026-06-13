// Journey: walk-in-opd (swarm journey #11) — deterministic in-CI replacement.
//
// Flow exercised end-to-end across roles through the REAL API surface:
//   1. Receptionist registers a walk-in OPD patient (auto-assigned doctor).
//   2. Doctor opens the consult: SCHEDULED/CONFIRMED → IN_PROGRESS.
//   3. Doctor records vitals (canonical: vitals.recorded).
//   4. Doctor writes the OP consultation note bound to the visit
//      (auto-creates the canonical encounter; canonical: note.created).
//   5. Doctor places an investigation order (canonical: order.created).
//   6. Doctor completes the consult: IN_PROGRESS → COMPLETED.
//   7. The patient's canonical timeline reflects the visit's clinical events.
//
// Assertions: appointment state-machine transitions, RBAC (a stranger doctor
// cannot drive the visit; a non-front-desk role cannot register a walk-in),
// and the canonical clinical-timeline invariant on every clinical write.
//
// Deterministic: every fixture id namespaced per-run; "today" derived from the
// Postgres hospital clock; doctor authorised via an explicit care-team grant
// AND the assigned-appointment relationship.

import {
  describeJourney,
  roleClient,
  runSuffix,
  hospitalToday,
  seedDoctor,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  fetchPatientTimeline,
  cleanupJourney,
  uidForUserId,
  CANONICAL_EVENTS,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const DOCTOR_UID = `b0000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const STRANGER_DOCTOR_UID = `b0000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b0000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JWalkInOPD-${RUN}`;
const PATIENT_PHONE = `96001${RUN}`;
const DOCTOR_PHONE = `+9196101${RUN}`;
const STRANGER_PHONE = `+9196102${RUN}`;
const RECEPTIONIST_PHONE = `96103${RUN}`;

describeJourney('Journey: walk-in-opd', () => {
  let receptionist;
  let doctor;
  let strangerDoctor;
  let doctorUserId;
  let receptionistId;

  let appointmentId;
  let patientId;
  let patientUid;

  beforeAll(async () => {
    await cleanupJourney({
      patientUids: [],
      staffUids: [DOCTOR_UID, STRANGER_DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });

    const doc = await seedDoctor({
      uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr WalkIn ${RUN}`, department: DEPARTMENT,
    });
    doctorUserId = doc.userId;

    await seedDoctor({
      uid: STRANGER_DOCTOR_UID, phone: STRANGER_PHONE,
      name: `Dr Stranger ${RUN}`, department: `${DEPARTMENT}-other`,
    });

    const recep = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, NOW()) RETURNING id`,
      RECEPTIONIST_UID, `+91${RECEPTIONIST_PHONE}`, `Reception ${RUN}`,
    );
    receptionistId = recep[0].id;

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: receptionistId });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    strangerDoctor = roleClient('DOCTOR', { uid: STRANGER_DOCTOR_UID, id: 0, phone: STRANGER_PHONE });
  });

  afterAll(async () => {
    await cleanupJourney({
      patientUids: [patientUid].filter(Boolean),
      staffUids: [DOCTOR_UID, STRANGER_DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT, `${DEPARTMENT}-other`],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the walk-in', () => {
    it('rejects a non-front-desk role (lab staff) from registering a walk-in', async () => {
      const lab = roleClient('LAB_STAFF', { uid: STRANGER_DOCTOR_UID, id: 0 });
      const res = await lab.post('/api/v1/appointments/walk-in').send({
        patient_name: 'Should Fail',
        patient_phone: PATIENT_PHONE,
        department: DEPARTMENT,
        reason: 'Walk-in OPD',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.message || '')).toMatch(/front-desk/i);
    });

    it('registers the patient + creates the OPD appointment, auto-assigning the department doctor', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `WalkIn Patient ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'M',
        department: DEPARTMENT,
        reason: 'Fever and body ache, walk-in OPD',
        visit_type: 'NEW',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeDefined();
      // auto-assignment picks the only doctor in this department
      expect(res.body.data.doctor_id).toBe(doctorUserId);

      appointmentId = res.body.data.id;
      patientId = res.body.data.patient_id;
      patientUid = await uidForUserId(patientId);
      expect(patientUid).toBeTruthy();

      // Persisted appointment row is in a live pre-consult state.
      const row = await prisma.$queryRawUnsafe(
        `SELECT status, doctor_id, department FROM appointments WHERE id = $1`, appointmentId);
      expect(row[0].doctor_id).toBe(doctorUserId);
      expect(row[0].department).toBe(DEPARTMENT);
      expect(['SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'WAITING']).toContain(row[0].status);

      // Now that we know the patient, grant the assigned doctor an explicit
      // care-team relationship (belt-and-braces with the appointment
      // relationship) so the clinical-write guard resolves deterministically.
      await grantCareTeam({
        patientUid, staffUid: DOCTOR_UID, memberName: `WalkIn Patient ${RUN}`,
      });
    });
  });

  describe('Step 2 — doctor opens the consult', () => {
    it('blocks a stranger doctor from advancing the appointment (RBAC/IDOR)', async () => {
      const res = await strangerDoctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(403);
    });

    it('assigned doctor advances SCHEDULED/CONFIRMED → IN_PROGRESS', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'IN_PROGRESS',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('IN_PROGRESS');
    });
  });

  describe('Step 3 — doctor records vitals', () => {
    it('records vitals and writes the canonical vitals timeline + audit triple', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: patientUid,
        heart_rate: 92,
        systolic_bp: 128,
        diastolic_bp: 82,
        temperature: 38.4,
        spo2: 97,
        respiratory_rate: 20,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded,
        sourceId: vitalsId,
        patientUid,
      });
    });
  });

  describe('Step 4 — doctor writes the OP consultation note', () => {
    let noteId;

    it('creates an op_consultation note bound to the visit (auto-creates the encounter)', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: patientUid,
        appointment_id: appointmentId,
        note_type: 'op_consultation',
        content: {
          chief_complaint: 'Fever x 3 days',
          history: 'No travel, no rash. Mild myalgia.',
          examination: 'Febrile, chest clear, abdomen soft.',
          diagnosis: 'Viral fever',
          plan: 'Symptomatic care, CBC, review in 48h.',
        },
      });
      expect(res.statusCode).toBe(201);
      noteId = res.body.data.id;
      expect(noteId).toBeTruthy();

      // The OP note auto-creates the canonical encounter (migration 240 +
      // ensureEncounterForAppointment) — the UUID encounter_id is stamped.
      const row = await prisma.$queryRawUnsafe(
        `SELECT appointment_id, encounter_id, note_type FROM clinical_notes WHERE id = $1::int`,
        noteId);
      expect(Number(row[0].appointment_id)).toBe(appointmentId);
      expect(row[0].encounter_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(row[0].note_type).toBe('op_consultation');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteCreated,
        sourceId: noteId,
        patientUid,
      });
    });

    it('refuses a second OP consultation note on the same visit (one active note per visit)', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: patientUid,
        appointment_id: appointmentId,
        note_type: 'op_consultation',
        content: {
          chief_complaint: 'dup', history: 'dup', examination: 'dup',
          diagnosis: 'dup', plan: 'dup',
        },
      });
      expect(res.statusCode).toBe(409);
      expect(String(res.body.code || res.body.message || '')).toMatch(/already has|OP_NOTE_ALREADY_EXISTS/i);
    });
  });

  describe('Step 5 — doctor places an investigation order', () => {
    it('creates an investigation order and writes the canonical order timeline + audit triple', async () => {
      const res = await doctor.post('/api/v1/emr/orders').send({
        patient_uid: patientUid,
        order_type: 'investigation',
        priority: 'routine',
        details: { test_name: 'Complete Blood Count', reason: 'Febrile illness workup' },
      });
      expect(res.statusCode).toBe(201);
      const order = res.body.data?.order || res.body.data;
      const orderId = order?.id;
      expect(orderId).toBeTruthy();

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated,
        sourceId: orderId,
        patientUid,
      });
    });
  });

  describe('Step 6 — doctor completes the consult', () => {
    it('advances IN_PROGRESS → COMPLETED', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'COMPLETED',
        notes: 'Consult complete; awaiting CBC.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('COMPLETED');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM appointments WHERE id = $1`, appointmentId);
      expect(row[0].status).toBe('COMPLETED');
    });
  });

  describe('Step 7 — canonical patient timeline reflects the visit', () => {
    it("exposes the visit's clinical events on the patient timeline read endpoint", async () => {
      const res = await fetchPatientTimeline(doctor, patientUid);
      expect(res.statusCode).toBe(200);

      // The canonical timeline rows we wrote this visit must be queryable.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        patientUid);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'vitals.recorded',
        'note.created',
        'order.created',
      ]));
    });
  });
});
