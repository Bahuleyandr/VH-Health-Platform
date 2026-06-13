// Journey: inpatient-admission (swarm journey #5) — deterministic in-CI replacement.
//
// A patient is admitted to a ward bed and the ward team runs the first shift.
// Flow through the REAL API surface across roles:
//   1. Admissions desk (ADMIN) admits the patient to a bed, naming the
//      admitting doctor (canonical: admission.created; bed → occupied).
//   2. Ward nurse records admission vitals (canonical: vitals.recorded).
//   3. Ward nurse records an intake/output entry (canonical: io.recorded).
//   4. Admitting doctor places a routine inpatient order bundle via bulk order
//      (canonical: order.created per order), scoped to the admission encounter.
//   5. Admitting doctor writes the admission H&P note (canonical: note.created).
//
// Assertions: admit RBAC (a non-clinical GENERAL role cannot admit; missing
// consent on a non-emergency admit is blocked), bed state change, the
// admission state machine, and the canonical clinical-timeline invariant on
// every clinical write.
//
// Deterministic: per-run fixtures; admitting-doctor relationship + nurse
// care-team authorise the clinical writes; no time-of-day dependence.

import {
  describeJourney,
  roleClient,
  runSuffix,
  seedUser,
  seedDoctor,
  seedTreatmentConsent,
  seedWardWithBeds,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  cleanupJourney,
  CANONICAL_EVENTS,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const ADMIN_UID = `b3000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DOCTOR_UID = `b3000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NURSE_UID = `b3000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATIENT_UID = `b3000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const NOCONSENT_UID = `b3000005-0000-4000-8000-${RUN.padStart(12, '0')}`;
const WARD_NAME = `JWard-${RUN}`;
const BED_A = `JBED-A-${RUN}`;
const BED_B = `JBED-B-${RUN}`;
const DEPARTMENT = `JInpatient-${RUN}`;
const PATIENT_PHONE = `96401${RUN}`;
const NOCONSENT_PHONE = `96402${RUN}`;
const DOCTOR_PHONE = `+9196403${RUN}`;
const NURSE_PHONE = `+9196404${RUN}`;

describeJourney('Journey: inpatient-admission', () => {
  let admin;
  let doctor;
  let nurse;
  let general;
  let doctorUserId;
  let patientId;
  let bedAId;
  let bedBId;
  let admissionId;

  beforeAll(async () => {
    await cleanupJourney({
      patientUids: [PATIENT_UID, NOCONSENT_UID],
      staffUids: [ADMIN_UID, DOCTOR_UID, NURSE_UID],
      phones: [PATIENT_PHONE, NOCONSENT_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A, BED_B],
    });

    const adminRow = await seedUser({ uid: ADMIN_UID, phone: `+9196400${RUN}`, name: `Adm Officer ${RUN}`, role: 'ADMIN' });
    const doc = await seedDoctor({ uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr Ward ${RUN}`, department: DEPARTMENT });
    doctorUserId = doc.userId;
    const nurseRow = await seedUser({ uid: NURSE_UID, phone: NURSE_PHONE, name: `Ward Nurse ${RUN}`, role: 'NURSING_STAFF' });

    const patient = await seedUser({ uid: PATIENT_UID, phone: `+91${PATIENT_PHONE}`, name: `Inpatient ${RUN}`, role: 'PATIENT' });
    patientId = patient.id;
    await seedTreatmentConsent(PATIENT_UID);

    // A second patient deliberately WITHOUT consent, to prove the consent gate.
    await seedUser({ uid: NOCONSENT_UID, phone: `+91${NOCONSENT_PHONE}`, name: `NoConsent ${RUN}`, role: 'PATIENT' });

    const ward = await seedWardWithBeds({ wardName: WARD_NAME, bedNumbers: [BED_A, BED_B] });
    [bedAId, bedBId] = ward.bedIds;

    admin = roleClient('ADMIN', { uid: ADMIN_UID, id: adminRow.id });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseRow.id, phone: NURSE_PHONE });
    general = roleClient('GENERAL', { uid: ADMIN_UID, id: adminRow.id });

    // Nurse needs a care-team relationship for the clinical writes; the doctor
    // gets an admission relationship from being the admitting doctor (step 1).
    await grantCareTeam({ patientUid: PATIENT_UID, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF', memberName: `Inpatient ${RUN}` });
  });

  afterAll(async () => {
    await cleanupJourney({
      patientUids: [PATIENT_UID, NOCONSENT_UID],
      staffUids: [ADMIN_UID, DOCTOR_UID, NURSE_UID],
      phones: [PATIENT_PHONE, NOCONSENT_PHONE],
      departments: [DEPARTMENT],
      wardNames: [WARD_NAME],
      bedNumbers: [BED_A, BED_B],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — admissions desk admits the patient', () => {
    it('forbids a non-clinical GENERAL role from admitting', async () => {
      const res = await general.post('/api/v1/emr/admit').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(403);
    });

    it('blocks a non-emergency admit when the patient has no active consent', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: NOCONSENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'Elective workup',
        admission_type: 'elective',
        priority: 'routine',
        bed_id: bedBId,
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.code || res.body.message || '')).toMatch(/consent/i);
    });

    it('admits the consented patient to a bed and writes the canonical admission triple', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'Community-acquired pneumonia, hypoxic',
        admitting_diagnosis: 'CAP',
        admission_type: 'elective',
        priority: 'routine',
        department: DEPARTMENT,
        bed_id: bedAId,
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      admissionId = res.body.data?.admission?.id;
      expect(admissionId).toBeDefined();

      // Bed is now occupied by this admission.
      const bed = await prisma.$queryRawUnsafe(`SELECT status FROM beds WHERE id = $1`, bedAId);
      expect(String(bed[0].status).toLowerCase()).toBe('occupied');

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.admissionCreated, sourceId: admissionId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 2 — ward nurse records admission vitals', () => {
    it('records vitals and writes the canonical vitals triple', async () => {
      const res = await nurse.post('/api/v1/emr/vitals').send({
        patient_uid: PATIENT_UID,
        heart_rate: 104,
        systolic_bp: 110,
        diastolic_bp: 70,
        temperature: 38.9,
        spo2: 91,
        respiratory_rate: 26,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 3 — ward nurse records intake/output', () => {
    it('records an I/O entry and writes the canonical io triple', async () => {
      const res = await nurse.post('/api/v1/emr/io').send({
        patient_uid: PATIENT_UID,
        io_type: 'intake',
        category: 'iv',
        amount_ml: 500,
        description: 'NS bolus',
      });
      expect(res.statusCode).toBe(201);
      const ioId = res.body.data?.id || res.body.data?.io?.id || res.body.data?.entry?.id;
      expect(ioId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.ioRecorded, sourceId: ioId, patientUid: PATIENT_UID,
      });
    });
  });

  describe('Step 4 — admitting doctor places the admission order bundle', () => {
    it('creates a bulk order set and writes a canonical order triple per order', async () => {
      const res = await doctor.post('/api/v1/emr/orders/bulk').send({
        orders: [
          {
            patient_uid: PATIENT_UID,
            order_type: 'investigation',
            priority: 'routine',
            details: { test_name: 'Chest X-ray PA', reason: 'CAP' },
          },
          {
            patient_uid: PATIENT_UID,
            order_type: 'nursing',
            priority: 'routine',
            details: { description: 'O2 to keep SpO2 >= 94%', frequency: 'continuous' },
          },
        ],
      });
      expect(res.statusCode).toBe(201);
      const created = res.body.data;
      expect(Array.isArray(created)).toBe(true);
      expect(created.length).toBe(2);

      for (const item of created) {
        // Bulk returns { order, cds_warnings } per item.
        const orderId = item.order?.id ?? item.id;
        expect(orderId).toBeTruthy();
        await assertCanonicalClinicalWrite({
          event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid: PATIENT_UID,
        });
      }
    });
  });

  describe('Step 5 — admitting doctor writes the admission note', () => {
    it('creates an admission_note and writes the canonical note triple', async () => {
      const res = await doctor.post('/api/v1/emr/notes').send({
        patient_uid: PATIENT_UID,
        note_type: 'admission_note',
        content: {
          chief_complaint: 'Fever and breathlessness x 4 days',
          history_of_present_illness: 'Productive cough, pleuritic chest pain, hypoxia on arrival.',
          assessment: 'Community-acquired pneumonia, CURB-65 2.',
          plan: 'IV antibiotics, O2, CXR, monitor sats; reassess in 24h.',
        },
      });
      expect(res.statusCode).toBe(201);
      const noteId = res.body.data.id;
      expect(res.body.data.note_type).toBe('admission_note');
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.noteCreated, sourceId: noteId, patientUid: PATIENT_UID,
      });
    });

    it('canonical timeline carries the inpatient admission events', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT event_type FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
        PATIENT_UID);
      const types = rows.map((r) => r.event_type);
      expect(types).toEqual(expect.arrayContaining([
        'admission.created', 'vitals.recorded', 'io.recorded', 'order.created', 'note.created',
      ]));
    });
  });
});
