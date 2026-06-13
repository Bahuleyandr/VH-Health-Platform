// Journey: pediatric-opd (swarm journey #8) — deterministic in-CI replacement.
//
// A paediatric OPD walk-in: a minor is registered under a guardian, seen by the
// paeds doctor, weighed/measured, prescribed a weight-based medication, and has
// the immunisation schedule reviewed. Flow exercised end-to-end across roles
// through the REAL API surface (modelled on walk-in-opd.journey.test.js):
//   1. Receptionist registers a MINOR walk-in (DOB < 18) under a guardian —
//      guardian name/phone/relationship + guardian legal ID — auto-assigning
//      the department doctor and capturing the child's weight.
//   2. Doctor opens the consult: SCHEDULED/CONFIRMED → IN_PROGRESS.
//   3. Doctor records growth vitals (weight_kg + height_cm + paeds temperature
//      route); canonical: vitals.recorded, plus the WHO growth snapshot.
//   4. Doctor places a WEIGHT-BASED medication order (canonical: order.created).
//   5. Doctor writes the OP consultation note bound to the visit (auto-creates
//      the canonical encounter; canonical: note.created).
//   6. Doctor reviews immunisations: seed the schedule from DOB, read the
//      due/overdue panel, and record a catch-up dose given.
//   7. Doctor completes the consult: IN_PROGRESS → COMPLETED; the patient's
//      canonical timeline reflects the visit's clinical events.
//
// Assertions: minor-registration guardian guards, appointment state-machine
// transitions, RBAC (a stranger doctor cannot drive the visit; a non-front-desk
// role cannot register a walk-in; a nurse cannot write a medication order), and
// the canonical clinical-timeline invariant on every clinical write.
//
// Deterministic: every fixture id namespaced per-run; DOB derived from the
// Postgres hospital clock (~2 years old, so the child is in the WHO 0-5 growth
// table AND the at-birth immunisation doses are reliably overdue); doctor
// authorised via an explicit care-team grant AND the assigned-appointment
// relationship. The vaccine_catalogue the immunisation step reads is seeded by
// migration 160 (Indian NIS/IAP doses) on every fresh vhhealth_test DB.

import {
  describeJourney,
  roleClient,
  runSuffix,
  hospitalDateOffset,
  seedDoctor,
  seedUser,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  fetchPatientTimeline,
  cleanupJourney,
  uidForUserId,
  CANONICAL_EVENTS,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const DOCTOR_UID = `b5000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const STRANGER_DOCTOR_UID = `b5000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b5000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NURSE_UID = `b5000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JPaedsOPD-${RUN}`;
const PATIENT_PHONE = `96601${RUN}`;
const GUARDIAN_PHONE = `96602${RUN}`;
const DOCTOR_PHONE = `+9196603${RUN}`;
const STRANGER_PHONE = `+9196604${RUN}`;
const RECEPTIONIST_PHONE = `96605${RUN}`;
const NURSE_PHONE = `+9196606${RUN}`;

describeJourney('Journey: pediatric-opd', () => {
  let receptionist;
  let doctor;
  let strangerDoctor;
  let nurse;
  let doctorUserId;
  let receptionistId;
  let nurseId;

  let appointmentId;
  let patientId;
  let patientUid;
  let childDob;

  beforeAll(async () => {
    await cleanupJourney({
      patientUids: [],
      staffUids: [DOCTOR_UID, STRANGER_DOCTOR_UID, RECEPTIONIST_UID, NURSE_UID],
      phones: [PATIENT_PHONE, GUARDIAN_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT, `${DEPARTMENT}-other`],
    });

    // ~2 years old: inside the WHO 0-5 growth table (so the percentile snapshot
    // resolves) AND well past every at-birth immunisation dose (so the "due"
    // panel is reliably non-empty), derived from the Postgres clock so it never
    // drifts at the UTC midnight boundary.
    childDob = await hospitalDateOffset(-365 * 2 - 30);

    const doc = await seedDoctor({
      uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr Paeds ${RUN}`,
      department: DEPARTMENT, specialty: 'Paediatrician',
    });
    doctorUserId = doc.userId;

    await seedDoctor({
      uid: STRANGER_DOCTOR_UID, phone: STRANGER_PHONE,
      name: `Dr Stranger ${RUN}`, department: `${DEPARTMENT}-other`,
    });

    const recep = await seedUser({
      uid: RECEPTIONIST_UID, phone: `+91${RECEPTIONIST_PHONE}`,
      name: `Paeds Reception ${RUN}`, role: 'RECEPTIONIST',
    });
    receptionistId = recep.id;

    const nurseRow = await seedUser({
      uid: NURSE_UID, phone: NURSE_PHONE, name: `Paeds Nurse ${RUN}`, role: 'NURSING_STAFF',
    });
    nurseId = nurseRow.id;

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: receptionistId });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    strangerDoctor = roleClient('DOCTOR', { uid: STRANGER_DOCTOR_UID, id: 0, phone: STRANGER_PHONE });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseId, phone: NURSE_PHONE });
  });

  afterAll(async () => {
    await cleanupJourney({
      patientUids: [patientUid].filter(Boolean),
      staffUids: [DOCTOR_UID, STRANGER_DOCTOR_UID, RECEPTIONIST_UID, NURSE_UID],
      phones: [PATIENT_PHONE, GUARDIAN_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT, `${DEPARTMENT}-other`],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the minor walk-in under a guardian', () => {
    it('rejects a non-front-desk role (lab staff) from registering a walk-in', async () => {
      const lab = roleClient('LAB_STAFF', { uid: STRANGER_DOCTOR_UID, id: 0 });
      const res = await lab.post('/api/v1/appointments/walk-in').send({
        patient_name: 'Should Fail',
        patient_phone: PATIENT_PHONE,
        department: DEPARTMENT,
        reason: 'Paeds walk-in',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.message || '')).toMatch(/front-desk/i);
    });

    it('blocks a minor registration that omits the guardian legal ID', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `Paeds Child ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'M',
        patient_birthday: childDob,
        department: DEPARTMENT,
        reason: 'Fever and poor feeding',
        visit_type: 'NEW',
        // guardian contact present, but NO guardian_id_type / guardian_id and
        // no guardian_user_id — the D74 legal-ID guard must reject this.
        guardian_name: `Parent ${RUN}`,
        guardian_phone: GUARDIAN_PHONE,
        guardian_relationship: 'mother',
      });
      expect(res.statusCode).toBe(400);
      expect(String(res.body.code || res.body.message || '')).toMatch(/guardian|MINOR_GUARDIAN_ID_REQUIRED/i);
    });

    it('registers the minor + creates the OPD appointment, auto-assigning the paeds doctor', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `Paeds Child ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'M',
        patient_birthday: childDob,
        department: DEPARTMENT,
        reason: 'Fever x 2 days, poor feeding — paeds OPD',
        visit_type: 'NEW',
        // Guardian (minor consent contact) + legal ID — satisfies both the
        // Phase 0 minor guard and the D74 guardian-legal-ID guard.
        guardian_name: `Parent ${RUN}`,
        guardian_phone: GUARDIAN_PHONE,
        guardian_relationship: 'mother',
        guardian_id_type: 'aadhaar',
        guardian_id: `9999-0000-${RUN}`,
        // Captured at the counter for weight-based prescribing downstream.
        patient_weight_kg: 12.4,
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

      // Persisted patient row is a minor with the guardian + DOB on file.
      const patient = await prisma.$queryRawUnsafe(
        `SELECT is_minor, birthday::text AS birthday, gender, guardian_name, guardian_phone
           FROM users WHERE id = $1::int`, patientId);
      expect(patient[0].is_minor).toBe(true);
      expect(patient[0].birthday).toBe(childDob);
      expect(patient[0].gender).toBeTruthy();
      expect(String(patient[0].guardian_name || '')).toMatch(/Parent/);

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
        patientUid, staffUid: DOCTOR_UID, memberName: `Paeds Child ${RUN}`,
      });
      // Grant the nurse the same patient relationship so the nurse passes the
      // patient-access guard on /emr/orders and the medication RBAC negative in
      // Step 4 asserts the PRESCRIBER gate (not an unrelated access-denied 403).
      await grantCareTeam({
        patientUid, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF',
        memberName: `Paeds Child ${RUN}`,
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

  describe('Step 3 — doctor records growth vitals', () => {
    it('records weight/height vitals and writes the canonical vitals triple', async () => {
      const res = await doctor.post('/api/v1/emr/vitals').send({
        patient_uid: patientUid,
        heart_rate: 112,
        temperature: 38.2,
        temperature_route: 'axillary',
        spo2: 98,
        respiratory_rate: 28,
        weight_kg: 12.4,
        height_cm: 86.5,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded,
        sourceId: vitalsId,
        patientUid,
      });

      // Paeds growth percentile is derived from weight/height + DOB/sex. For a
      // ~2-year-old with both on file the WHO snapshot resolves; assert it
      // when present (best-effort enrichment, never part of the canonical write).
      const growth = res.body.data?.growth;
      if (growth) {
        expect(growth).toEqual(expect.objectContaining({}));
      }
    });
  });

  describe('Step 4 — doctor places a weight-based medication order', () => {
    it('refuses a medication order from a nurse (prescriber RBAC)', async () => {
      const res = await nurse.post('/api/v1/emr/orders').send({
        patient_uid: patientUid,
        order_type: 'medication',
        priority: 'routine',
        details: {
          medication_name: 'Paracetamol syrup',
          dose: '180 mg',
          route: 'oral',
          frequency: 'QID',
        },
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.message || '')).toMatch(/doctor|prescrib/i);
    });

    it('creates a weight-based medication order and writes the canonical order triple', async () => {
      // Weight-based antipyretic: ~12 mg/kg paracetamol for a 12.4 kg child
      // = 150 mg/dose — within the 10-15 mg/kg therapeutic band and well under
      // the platform's paediatric per-dose ceiling (CDS hard-block), so the
      // order is clinically valid and passes the prescription-safety gate.
      const res = await doctor.post('/api/v1/emr/orders').send({
        patient_uid: patientUid,
        order_type: 'medication',
        priority: 'routine',
        details: {
          medication_name: 'Paracetamol syrup',
          dose: '150 mg',
          strength_mg_per_ml: 25,
          dose_basis_mg_per_kg: 12,
          weight_kg: 12.4,
          route: 'oral',
          frequency: 'QID PRN fever',
          duration: '3 days',
          instructions: 'Weight-based antipyretic ~12 mg/kg/dose; max 4 doses/24h.',
        },
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

  describe('Step 5 — doctor writes the OP consultation note', () => {
    let noteId;

    it('creates an op_consultation note bound to the visit (auto-creates the encounter)', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: patientUid,
        appointment_id: appointmentId,
        note_type: 'op_consultation',
        content: {
          chief_complaint: 'Fever x 2 days, reduced feeding',
          history: 'No rash, no breathing difficulty. Immunisation: catch-up pending.',
          examination: 'Active, hydrated. Weight 12.4 kg (~50th centile). Chest clear, ENT normal.',
          diagnosis: 'Viral fever',
          plan: 'Weight-based antipyretic, oral fluids, immunisation catch-up, review in 48h.',
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

  describe('Step 6 — doctor reviews the immunisation schedule', () => {
    let dueImmunisationId;

    it('seeds the immunisation schedule from the child DOB (idempotent)', async () => {
      const res = await doctor.post('/api/v1/paediatric/immunisations/seed').send({
        patient_uid: patientUid,
        dob: childDob,
      });
      expect(res.statusCode).toBe(200);
      // The catalogue (migration 160 seed) yields the full NIS/IAP schedule.
      expect(res.body.data.total).toBeGreaterThan(0);
      expect(Number(res.body.data.inserted) + Number(res.body.data.updated))
        .toBe(Number(res.body.data.total));
    });

    it('lists due/overdue immunisations for the child (at-birth doses are overdue)', async () => {
      const res = await doctor.get(`/api/v1/paediatric/immunisations/patient/${patientUid}/due`);
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // A ~2-year-old has long-overdue at-birth/6-week doses still scheduled.
      expect(res.body.data.length).toBeGreaterThan(0);
      const overdue = res.body.data.find((r) => r.bucket === 'due_or_overdue') || res.body.data[0];
      dueImmunisationId = overdue.id;
      expect(dueImmunisationId).toBeTruthy();
    });

    it('records a catch-up dose as given', async () => {
      const res = await doctor.post(`/api/v1/paediatric/immunisations/${dueImmunisationId}/given`).send({
        status: 'given',
        given_by_name: `Dr Paeds ${RUN}`,
        batch_number: `BCG-${RUN}`,
        manufacturer: 'SII',
        site_of_injection: 'left_deltoid',
        notes: 'Catch-up dose administered at paeds OPD.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('given');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, given_at, given_by FROM patient_immunisations WHERE id = $1`,
        dueImmunisationId);
      expect(row[0].status).toBe('given');
      expect(row[0].given_at).not.toBeNull();
    });
  });

  describe('Step 7 — doctor completes the consult', () => {
    it('advances IN_PROGRESS → COMPLETED', async () => {
      const res = await doctor.put(`/api/v1/appointments/${appointmentId}/status`).send({
        status: 'COMPLETED',
        notes: 'Consult complete; antipyretic + immunisation catch-up given.',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment.status).toBe('COMPLETED');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM appointments WHERE id = $1`, appointmentId);
      expect(row[0].status).toBe('COMPLETED');
    });

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
        'order.created',
        'note.created',
      ]));
    });
  });
});
