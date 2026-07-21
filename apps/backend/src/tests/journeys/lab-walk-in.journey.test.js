// Journey: lab-walk-in (swarm journey #6) — deterministic in-CI replacement.
//
// A walk-in patient gets a lab investigation ordered, collected, resulted, and
// signed off — the closed lab loop driven through the REAL API across roles:
//   1. Receptionist registers a walk-in OPD patient.
//   2. Doctor places a lab order via the canonical CPOE path (/emr/orders type
//      'lab'): writes canonical order.created AND materializes an
//      investigations row that surfaces on the lab worklist (the CPOE→lab
//      bridge).
//   3. The order appears on the lab tech's worklist.
//   4. Lab tech collects the sample (REQUESTED → sample collected).
//   5. Lab tech records a numeric result that trips the critical threshold,
//      firing a critical alert.
//   6. A non-pathologist is refused sign-off (RBAC); the pathologist then signs
//      the result off (verified).
//
// Assertions: canonical order.created triple, the CPOE→lab materialization,
// worklist visibility, lab result/critical-alert behaviour, and the sign-off
// RBAC tier gate.
//
// Deterministic: per-run fixtures; ordering doctor authorised by care-team; lab
// tech + pathologist are staff roles that don't need a patient relationship for
// the lab worklist/result/signoff surface.

import {
  describeJourney,
  roleClient,
  runSuffix,
  seedDoctor,
  grantCareTeam,
  assertCanonicalClinicalWrite,
  cleanupJourney,
  uidForUserId,
  CANONICAL_EVENTS,
  prisma,
} from './_journeyHarness.js';

const RUN = runSuffix();
const DOCTOR_UID = `b4000001-0000-4000-8000-${RUN.padStart(12, '0')}`;
const LABTECH_UID = `b4000002-0000-4000-8000-${RUN.padStart(12, '0')}`;
const PATHOLOGIST_UID = `b4000003-0000-4000-8000-${RUN.padStart(12, '0')}`;
const RECEPTIONIST_UID = `b4000004-0000-4000-8000-${RUN.padStart(12, '0')}`;
const DEPARTMENT = `JLabWalkIn-${RUN}`;
const PATIENT_PHONE = `96501${RUN}`;
const DOCTOR_PHONE = `+9196502${RUN}`;
const LABTECH_PHONE = `+9196503${RUN}`;
const PATHOLOGIST_PHONE = `+9196504${RUN}`;
const RECEPTIONIST_PHONE = `96505${RUN}`;
const CRITICAL_TEST_CODE = `JWL${RUN}`;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function cleanupLabWalkInEvidence() {
  const resultRows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND test_code = $2`,
    TENANT_ID,
    CRITICAL_TEST_CODE,
  );
  const resultIds = resultRows.map((row) => Number(row.id));
  if (resultIds.length === 0) return;

  const resultIdTexts = resultIds.map(String);
  await prisma.$transaction(async (tx) => {
    // The journey deliberately creates append-only clinical evidence. Confine
    // teardown to its exact fixtures in the disposable superuser CI database;
    // clinical_audit_events stay intact so the tenant hash chain is preserved.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      TENANT_ID,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_reconciliation_receipts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      TENANT_ID,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      TENANT_ID,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id IN (
            SELECT id
              FROM tasks
             WHERE tenant_id = $1::uuid
               AND related_resource_type = 'lab_result'
               AND related_resource_id = ANY($2::text[])
          )`,
      TENANT_ID,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'lab_result'
          AND related_resource_id = ANY($2::text[])`,
      TENANT_ID,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'lab_result'
          AND source_id = ANY($2::text[])`,
      TENANT_ID,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_pathologist_signoffs
        WHERE tenant_id = $1::uuid
          AND result_ids && $2::int[]`,
      TENANT_ID,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE payload->>'result_id' = ANY($1::text[])`,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notifications
        WHERE data->>'result_id' = ANY($1::text[])`,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_results
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])`,
      TENANT_ID,
      resultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_result_ingest_commands
        WHERE tenant_id = $1::uuid
          AND result_ids && $2::int[]`,
      TENANT_ID,
      resultIds,
    );
  });
}

describeJourney('Journey: lab-walk-in', () => {
  let receptionist;
  let doctor;
  let labTech;
  let pathologist;
  let doctorUserId;

  let patientId;
  let patientUid;
  let orderId;
  let investigationId;
  let resultId;

  beforeAll(async () => {
    await cleanupLabWalkInEvidence();
    await cleanupJourney({
      staffUids: [DOCTOR_UID, LABTECH_UID, PATHOLOGIST_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });

    const doc = await seedDoctor({
      uid: DOCTOR_UID, phone: DOCTOR_PHONE, name: `Dr LabWalkIn ${RUN}`, department: DEPARTMENT,
    });
    doctorUserId = doc.userId;

    const labRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'LAB_STAFF', true, NOW()) RETURNING id`,
      LABTECH_UID, LABTECH_PHONE, `Lab Tech ${RUN}`);
    const pathRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATHOLOGIST', true, NOW()) RETURNING id`,
      PATHOLOGIST_UID, PATHOLOGIST_PHONE, `Dr Path ${RUN}`);
    const recepRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'RECEPTIONIST', true, NOW()) RETURNING id`,
      RECEPTIONIST_UID, `+91${RECEPTIONIST_PHONE}`, `Reception ${RUN}`);

    receptionist = roleClient('RECEPTIONIST', { uid: RECEPTIONIST_UID, id: recepRow[0].id });
    doctor = roleClient('DOCTOR', { uid: DOCTOR_UID, id: doctorUserId, phone: DOCTOR_PHONE });
    labTech = roleClient('LAB_STAFF', { uid: LABTECH_UID, id: labRow[0].id, phone: LABTECH_PHONE });
    pathologist = roleClient('PATHOLOGIST', { uid: PATHOLOGIST_UID, id: pathRow[0].id, phone: PATHOLOGIST_PHONE });
    await prisma.$queryRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, critical_high, is_active)
       VALUES ('00000000-0000-4000-8000-000000000001'::uuid, $1,
               'Troponin I', 0.04, true)`,
      CRITICAL_TEST_CODE,
    );
  });

  afterAll(async () => {
    await cleanupLabWalkInEvidence();
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_critical_thresholds
        WHERE tenant_id = $1::uuid
          AND test_code = $2`,
      TENANT_ID,
      CRITICAL_TEST_CODE,
    );
    await cleanupJourney({
      patientUids: [patientUid].filter(Boolean),
      staffUids: [DOCTOR_UID, LABTECH_UID, PATHOLOGIST_UID, RECEPTIONIST_UID],
      phones: [PATIENT_PHONE, RECEPTIONIST_PHONE],
      departments: [DEPARTMENT],
    });
    await prisma.$disconnect().catch(() => {});
  });

  describe('Step 1 — receptionist registers the walk-in', () => {
    it('registers the OPD walk-in patient', async () => {
      const res = await receptionist.post('/api/v1/appointments/walk-in').send({
        patient_name: `Lab WalkIn Patient ${RUN}`,
        patient_phone: PATIENT_PHONE,
        patient_gender: 'F',
        department: DEPARTMENT,
        reason: 'Fatigue — needs bloodwork',
        visit_type: 'NEW',
      });
      expect(res.statusCode).toBe(200);
      patientId = res.body.data.patient_id;
      patientUid = await uidForUserId(patientId);
      expect(patientUid).toBeTruthy();

      await grantCareTeam({ patientUid, staffUid: DOCTOR_UID, memberName: `Lab WalkIn Patient ${RUN}` });
    });
  });

  describe('Step 2 — doctor places the lab order (CPOE)', () => {
    it('creates a lab order, writes the canonical order triple, and materializes an investigation', async () => {
      const res = await doctor.post('/api/v1/emr/orders').set('Idempotency-Key', `lab-walkin-order-troponin-${Date.now()}`).send({
        patient_uid: patientUid,
        order_type: 'lab',
        priority: 'STAT',
        details: {
          test_name: 'Troponin I',
          test_code: CRITICAL_TEST_CODE,
          test_type: 'LAB',
          reason: 'Rule out ACS in walk-in chest discomfort',
        },
      });
      expect(res.statusCode).toBe(201);
      orderId = (res.body.data?.order || res.body.data)?.id;
      expect(orderId).toBeTruthy();

      await assertCanonicalClinicalWrite({
        event: CANONICAL_EVENTS.orderCreated, sourceId: orderId, patientUid,
      });

      // CPOE→lab bridge: the EMR order materializes an investigations row,
      // linked back to the clinical order via its notes marker.
      const investigations = await prisma.$queryRawUnsafe(
        `SELECT id, test_name, priority, status FROM investigations
          WHERE patient_uid = $1::uuid AND notes LIKE $2
          ORDER BY id DESC LIMIT 1`,
        patientUid, `%clinical_order_id:${orderId}%`);
      expect(investigations.length).toBe(1);
      investigationId = investigations[0].id;
      expect(investigations[0].test_name).toBe('Troponin I');
      expect(investigations[0].priority).toBe('STAT');
    });
  });

  describe('Step 3 — order surfaces on the lab worklist', () => {
    it('lists the new investigation on the OPD lab worklist', async () => {
      const res = await labTech.get('/api/v1/lab/worklist?limit=200');
      expect(res.statusCode).toBe(200);
      const row = res.body.data.find((item) => item.id === investigationId);
      expect(row).toBeDefined();
      expect(row.patient_uid).toBe(patientUid);
    });
  });

  describe('Step 4 — lab tech collects the sample', () => {
    it('marks the sample collected', async () => {
      const res = await labTech.post(`/api/v1/lab/samples/${investigationId}/collect`).send({
        collected_notes: 'Venous draw x1 SST',
        sample_barcode: `LWB-${RUN}`,
      });
      expect(res.statusCode).toBe(200);

      const inv = await prisma.$queryRawUnsafe(
        `SELECT status, collected_at FROM investigations WHERE id = $1`, investigationId);
      expect(inv[0].collected_at).not.toBeNull();
    });
  });

  describe('Step 5 — lab tech records a critical result', () => {
    it('rejects a non-numeric value for a test with a critical threshold', async () => {
      const res = await labTech.post('/api/v1/lab/results')
        .set('Idempotency-Key', `lab-walkin-nonnumeric-${RUN}`)
        .send({
        investigation_id: investigationId,
        patient_uid: patientUid,
        test_code: CRITICAL_TEST_CODE,
        test_name: 'Troponin I',
        value_text: 'high',
        unit: 'ng/mL',
        });
      expect(res.statusCode).toBe(400);
      expect(String(res.body.message || '')).toMatch(/numeric/i);
    });

    it('records a numeric result above threshold and fires a critical alert', async () => {
      const res = await labTech.post('/api/v1/lab/results')
        .set('Idempotency-Key', `lab-walkin-critical-${RUN}`)
        .send({
        investigation_id: investigationId,
        patient_uid: patientUid,
        test_code: CRITICAL_TEST_CODE,
        test_name: 'Troponin I',
        value_text: '0.85',
        unit: 'ng/mL',
        });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.result?.is_critical).toBe(true);
      expect(res.body.data?.alerts?.length).toBeGreaterThanOrEqual(1);
      resultId = res.body.data.result.id;
      expect(resultId).toBeTruthy();
    });
  });

  describe('Step 6 — pathologist signs off', () => {
    it('refuses sign-off from a non-pathologist (lab tech)', async () => {
      const res = await labTech.post('/api/v1/lab/pathologist/signoff').send({
        result_ids: [resultId],
        patient_uid: patientUid,
        decision: 'verified',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.message || '')).toMatch(/pathologist/i);
    });

    it('pathologist signs the result off as verified', async () => {
      const res = await pathologist.post('/api/v1/lab/pathologist/signoff')
        .set('Idempotency-Key', `lab-walkin-signoff-${RUN}`)
        .send({
        result_ids: [resultId],
        patient_uid: patientUid,
        decision: 'verified',
        comments: 'Consistent with myocardial injury; clinical correlation advised.',
        });
      expect(res.statusCode).toBe(200);

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, signed_off_by, signed_off_at FROM lab_results WHERE id = $1`, resultId);
      expect(String(row[0].status).toLowerCase()).toMatch(/verified|signed|final/);
      expect(row[0].signed_off_by).not.toBeNull();
    });
  });
});
