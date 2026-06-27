// Journey: emergency-walk-in (swarm journey #3) — deterministic in-CI replacement.
//
// An undifferentiated emergency patient arrives at the ED. Flow through the
// REAL API surface across roles:
//   1. Receptionist registers an EMERGENCY walk-in flagged medico-legal (MLC);
//      this creates the emergency_visits row (status 'arriving') + the ER
//      appointment.
//   2. ED nurse moves the visit arriving → in_triage and records a triage
//      assessment (ESI level) on the ED triage surface.
//   3. ED nurse records triage vitals (canonical: vitals.recorded).
//   4. Visit advances in_triage → in_treatment.
//   5. ED doctor places a STAT investigation order scoped to the ER visit
//      (canonical: order.created).
//   6. Doctor dispositions the visit in_treatment → discharged.
//
// Assertions: ER visit creation + MLC flag, the ED visit state machine
// (including an illegal-transition rejection), triage-priority queue effect,
// canonical timeline invariant on each clinical write, RBAC.
//
// Deterministic: per-run fixture ids; ER visit obtained from the walk-in
// response (no time-of-day dependence); care-team grants authorise the
// nurse + doctor clinical writes.

import {
  describeJourney,
  roleClient,
  runSuffix,
  seedUser,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  cleanupJourney,
  uidForUserId,
  CANONICAL_EVENTS,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const NURSE_UID = `b2000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DOCTOR_UID = `b2000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b2000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JEmergency-${RUN}`; // substring "emergency" → EMER visit prefix
const PATIENT_PHONE = `96301${RUN}`;
const NURSE_PHONE = `+9196302${RUN}`;
const DOCTOR_PHONE = `+9196303${RUN}`;
const RECEPTIONIST_PHONE = `96304${RUN}`;

describeJourney('Journey: emergency-walk-in', () => {
  let receptionist;
  let nurse;
  let doctor;

  let erVisitId;
  let appointmentId;
  let patientId;
  let patientUid;

  beforeAll(async () => {
    await cleanupJourney({
      staffUids: [NURSE_UID, DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });

    const nurseRow = await seedUser({
      uid: NURSE_UID, phone: NURSE_PHONE, name: `ED Nurse ${RUN}`, role: 'NURSING_STAFF',
    });
    const doctorRow = await seedUser({
      uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `ED Doctor ${RUN}`, role: 'DOCTOR',
    });
    const recepRow = await seedUser({
      uid: RECEPTIONIST_UID, phone: `+91${RECEPTIONIST_PHONE}`, name: `ED Reception ${RUN}`, role: 'RECEPTIONIST',
    });

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: recepRow.id });
    nurse = roleClient('NURSING_STAFF', { uid: NURSE_UID, id: nurseRow.id, phone: NURSE_PHONE });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorRow.id, phone: DOCTOR_PHONE });
  });

  afterAll(async () => {
    await cleanupJourney({
      patientUids: [patientUid].filter(Boolean),
      staffUids: [NURSE_UID, DOCTOR_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the emergency walk-in (MLC)', () => {
    it('creates the ER visit + flags it medico-legal', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `RTA Victim ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'M',
        department: DEPARTMENT,
        reason: 'Road traffic accident — brought by ambulance',
        visit_type: 'EMERGENCY',
        chief_complaint: 'Polytrauma, GCS 14',
        mlc: true,
        mlc_number: `FIR-${RUN}`,
        mlc_notes: 'Brought by 108 ambulance.',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.er_visit_id).not.toBeNull();
      expect(res.body.data.er_is_mlc).toBe(true);

      erVisitId = res.body.data.er_visit_id;
      appointmentId = res.body.data.id;
      patientId = res.body.data.patient_id;
      patientUid = await uidForUserId(patientId);
      expect(patientUid).toBeTruthy();

      const ev = await prisma.$queryRawUnsafe(
        `SELECT status, is_mlc, chief_complaint FROM emergency_visits WHERE id = $1`, erVisitId);
      expect(ev[0]).toMatchObject({ status: 'arriving', is_mlc: true });
      expect(ev[0].chief_complaint).toMatch(/Polytrauma/);

      // Authorise the ED nurse + doctor for the clinical writes below.
      await grantCareTeam({ patientUid, staffUid: NURSE_UID, staffRole: 'NURSING_STAFF', memberName: `RTA Victim ${RUN}` });
      await grantCareTeam({ patientUid, staffUid: DOCTOR_UID, staffRole: 'DOCTOR', memberName: `RTA Victim ${RUN}` });
    });
  });

  describe('Step 2 — ED nurse triages', () => {
    it('rejects an illegal visit transition (arriving → discharged is not allowed)', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'discharged',
      });
      expect(res.statusCode).toBe(400);
      expect(String(res.body.code || res.body.message || '')).toMatch(/transition|invalid/i);
    });

    it('moves the visit arriving → in_triage', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'in_triage',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('in_triage');
    });

    it('sets the triage priority (queue effect)', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/triage-priority`).send({
        triage_priority: 'esi_2',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.triage_priority).toBe('esi_2');
    });

    it('records a triage assessment on the ED surface', async () => {
      const res = await nurse.post('/api/v1/ed/triage-assessments').send({
        emergency_visit_id: erVisitId,
        patient_uid: patientUid,
        assessment_kind: 'esi',
        level: 2,
        presenting_complaint: 'Polytrauma after RTA',
        pain_score: 7,
        circulation_concern: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data.id).toBeTruthy();
    });
  });

  describe('Step 3 — ED nurse records triage vitals', () => {
    it('records vitals and writes the canonical vitals triple', async () => {
      const res = await nurse.post('/api/v1/emr/vitals').send({
        patient_uid: patientUid,
        triage_acuity: 2,
        heart_rate: 118,
        systolic_bp: 96,
        diastolic_bp: 60,
        spo2: 94,
        respiratory_rate: 24,
        gcs_score: 14,
      });
      expect(res.statusCode).toBe(201);
      const vitalsId = res.body.data?.vitals?.id;
      expect(vitalsId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.vitalsRecorded, sourceId: vitalsId, patientUid,
      });
    });
  });

  describe('Step 4 — visit moves into treatment', () => {
    it('advances in_triage → in_treatment', async () => {
      const res = await nurse.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'in_treatment',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('in_treatment');
    });
  });

  describe('Step 5 — ED doctor places a STAT order scoped to the ER visit', () => {
    it('creates a STAT investigation order and writes the canonical order triple', async () => {
      const res = await doctor.post('/api/v1/emr/orders').set('Idempotency-Key', `emergency-walkin-order-stat-${Date.now()}`).send({
        patient_uid: patientUid,
        er_visit_id: erVisitId,
        order_type: 'investigation',
        priority: 'stat',
        details: { test_name: 'FAST ultrasound + Trauma panel', reason: 'Polytrauma workup' },
      });
      expect(res.statusCode).toBe(201);
      const order = res.body.data?.order || res.body.data;
      const orderId = order?.id;
      expect(orderId).toBeTruthy();
      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid,
      });
    });
  });

  describe('Step 6 — doctor dispositions the visit', () => {
    it('advances in_treatment → discharged with a disposition', async () => {
      const res = await doctor.patch(`/api/v1/ed/visits/${erVisitId}/transition`).send({
        next_status: 'discharged',
        disposition: 'discharged_home',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('discharged');

      const ev = await prisma.$queryRawUnsafe(
        `SELECT status, disposition_at FROM emergency_visits WHERE id = $1`, erVisitId);
      expect(ev[0].status).toBe('discharged');
      expect(ev[0].disposition_at).not.toBeNull();
    });
  });
});
