// Deep integration test for the critical-lab-alert → ER-doctor feed gap.
//
// Pre-fix bug: when a STAT troponin is signed off as critical, the
// recipient fan-out queues a notification_outbox row for the ordering
// ER doctor but never writes the in-app `notifications` row. The
// doctor's GET /api/v1/notifications/my therefore returns an empty
// feed even though a PENDING outbox row exists for them. See finding
// 2026-05-13-emergency-walk-in-lab-tech-1e24f95f.
//
// Post-fix behaviour (verified here):
//   - notification_outbox has the row (existing behaviour, kept)
//   - notifications table also has a row keyed on normalized phone
//   - GET /api/v1/notifications/my surfaces the lab_critical_alert
//     with payload.result_id matching the underlying lab_results row

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { API_KEY, authClient } from './testClient.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Distinct UIDs/phones so this suite doesn't collide with worklist-deep.
const PATIENT_UID = 'c4444444-4444-4444-8444-44444444aa01';
const PATIENT_PHONE = '9000040001';
const DOCTOR_UID = 'c4444444-4444-4444-8444-44444444aa02';
const DOCTOR_PHONE = '9000040002';
const IDEMPOTENCY_RUN = Date.now();
const CRITICAL_TEST_CODE = `TCA${IDEMPOTENCY_RUN}`;

async function cleanupFixture() {
  await setTenantTx(TENANT_ID, async (tx) => {
    const resultRows = await tx.$queryRawUnsafe(
      `SELECT id, test_code
         FROM lab_results
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    const resultIds = resultRows.map((row) => Number(row.id));
    const resultIdTexts = resultIds.map(String);
    const testCodes = [...new Set([...resultRows.map((row) => row.test_code), CRITICAL_TEST_CODE])];
    const investigationRows = await tx.$queryRawUnsafe(
      `SELECT id
         FROM investigations
        WHERE tenant_id = $1::uuid
          AND (
            patient_uid = $2::uuid
            OR patient_id IN (
              SELECT id
                FROM users
               WHERE tenant_id = $1::uuid
                 AND uid = $2::uuid
            )
          )`,
      TENANT_ID,
      PATIENT_UID,
    );
    const investigationIds = investigationRows.map((row) => Number(row.id));

    // This suite creates append-only clinical evidence. Teardown is confined
    // to its exact fixtures in the disposable superuser test database.
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
      `DELETE FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
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
    await tx.$executeRawUnsafe(
      `DELETE FROM investigations
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])`,
      TENANT_ID,
      investigationIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_thresholds
        WHERE tenant_id = $1::uuid
          AND test_code = ANY($2::text[])`,
      TENANT_ID,
      testCodes,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE (payload->>'patient_uid' = $1 OR payload->>'result_id' = ANY($2::text[]))`,
      PATIENT_UID,
      resultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notifications
        WHERE data->>'patient_uid' = $1
           OR data->>'result_id' = ANY($2::text[])
           OR phone = $3`,
      PATIENT_UID,
      resultIdTexts,
      normalizePhone(DOCTOR_PHONE),
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM emergency_visits
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])`,
      TENANT_ID,
      [PATIENT_UID, DOCTOR_UID],
    );
  });
}

async function makeUser(uid, phone, name, role) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW())
     RETURNING id`,
    uid, phone, name, role,
  );
  return rows[0].id;
}

function doctorTokenFor(uid, phone) {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret';
  return jwt.sign(
    { uid, id: 9999, phone, role: 'DOCTOR' },
    secret,
    { expiresIn: '1h' },
  );
}

describe('Critical lab alert reaches ER doctor in-app feed — deep integration', () => {
  const labTech = authClient('LAB_STAFF');
  let doctorId;
  let investigationId;

  beforeAll(async () => {
    await cleanupFixture();

    const patientId = await makeUser(PATIENT_UID, PATIENT_PHONE, 'Lab Alert Test Patient', 'PATIENT');
    doctorId = await makeUser(DOCTOR_UID, DOCTOR_PHONE, 'Lab Alert Test ER Doctor', 'DOCTOR');

    // Active ER visit with the doctor as attending — this is what the
    // recipient fan-out keys on (emergency_visits.attending_doctor_uid).
    await prisma.$executeRawUnsafe(
      `INSERT INTO emergency_visits
         (tenant_id, visit_number, patient_uid, arrival_mode, chief_complaint,
          attending_doctor_uid, status)
       VALUES ($1::uuid, $2, $3::uuid, 'walk_in', 'Chest pain', $4::uuid, 'arriving')`,
      TENANT_ID, `EMER-LABALERT-${Date.now()}`, PATIENT_UID, DOCTOR_UID,
    );

    const investigationRows = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (tenant_id, phone, patient_id, patient_uid, test_name, test_type,
          status, priority, requested_by, requested_at, updated_at)
       VALUES
         ($1::uuid, $2, $3, $4::uuid, 'Troponin I', 'blood',
          'REQUESTED', 'STAT', $5::uuid, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_PHONE,
      patientId,
      PATIENT_UID,
      DOCTOR_UID,
    );
    investigationId = investigationRows[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_critical_thresholds
       (tenant_id, test_code, test_name, critical_high, is_active)
       VALUES ($1::uuid, $2, 'Troponin I', 0.04, true)`,
      TENANT_ID,
      CRITICAL_TEST_CODE,
    );
  });

  afterAll(async () => {
    try {
      await cleanupFixture();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('signs off a critical troponin → doctor sees it in /notifications/my', async () => {
    // 1. Submit a critical troponin value via the lab path (mirrors what
    //    the LAB_STAFF agent does in the emergency-walk-in journey).
    const labRes = await labTech.post('/api/v1/lab/results')
      .set('Idempotency-Key', `lab-critical-alert-${IDEMPOTENCY_RUN}`)
      .send({
      investigation_id: investigationId,
      patient_uid: PATIENT_UID,
      test_code: CRITICAL_TEST_CODE,
      test_name: 'Troponin I',
      value_text: '0.85',
      unit: 'ng/mL',
      });
    expect(labRes.statusCode).toBe(200);
    expect(labRes.body.data?.result?.is_critical).toBe(true);
    expect(labRes.body.data?.alerts?.length).toBeGreaterThanOrEqual(1);
    const resultId = labRes.body.data.result.id;

    // 2. Confirm the existing outbox fan-out still works (regression
    //    guard: the dual-write must not break the FCM delivery queue).
    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT id, type, recipient_id, status, payload
         FROM notification_outbox
        WHERE type = 'lab_critical_alert'
          AND (payload->>'result_id')::int = $1::int
          AND recipient_id = $2::text`,
      resultId, String(doctorId),
    );
    expect(outboxRows.length).toBeGreaterThanOrEqual(1);
    expect(outboxRows[0].status).toBe('PENDING');

    // 3. Confirm the in-app feed row was written (the fix).
    const feedRows = await prisma.$queryRawUnsafe(
      `SELECT id, phone, type, priority, data
         FROM notifications
        WHERE phone = $1
          AND type = 'lab_critical_alert'
          AND (data->>'result_id')::int = $2::int`,
      normalizePhone(DOCTOR_PHONE), resultId,
    );
    expect(feedRows.length).toBeGreaterThanOrEqual(1);
    expect(feedRows[0].priority).toBe('HIGH');

    // 4. End-to-end: the ordering doctor's GET /api/v1/notifications/my
    //    surfaces the alert. This is the verification gate from the
    //    finding body — pre-fix this returns notifications: [].
    //    The DOCTOR-role response strips `data` (formatNotificationResponse
    //    only includes private fields for ADMIN), so we assert on type,
    //    priority, and unread state — result_id linkage is already
    //    verified at step 3 against the DB row.
    const doctorToken = doctorTokenFor(DOCTOR_UID, DOCTOR_PHONE);
    const feedRes = await request(app)
      .get('/api/v1/notifications/my')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`);

    expect(feedRes.statusCode).toBe(200);
    const notifications = feedRes.body?.data?.notifications || [];
    expect(notifications.length).toBeGreaterThanOrEqual(1);
    const labAlert = notifications.find((n) => n.type === 'lab_critical_alert');
    expect(labAlert).toBeDefined();
    expect(labAlert.priority).toBe('HIGH');
    expect(labAlert.is_read).toBe(false);
    expect(String(labAlert.title)).toMatch(/CRITICAL/i);

    // Regression for 2026-05-15-dynamic-acute-abdomen-doctor-6f4e954e:
    // descriptive read-back methods must not trip the old VARCHAR(40)
    // database limit and surface as a generic 500.
    const [alertRow] = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM lab_critical_alerts
        WHERE result_id = $1::int
        ORDER BY id DESC
        LIMIT 1`,
      resultId,
    );
    const ackMethod = 'manual phone read-back to ward nurse and surgical team';
    const ackRes = await request(app)
      .post(`/api/v1/lab/alerts/critical/${alertRow.id}/ack`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`)
      .send({
        acknowledged_by_name: 'Dr Lab Alert Test ER Doctor',
        read_back_method: ackMethod,
        notes: 'Escalated and read back to receiving team.',
      });

    expect(ackRes.statusCode).toBe(200);
    expect(ackRes.body.data.read_back_method).toBe(ackMethod);
    expect(ackRes.body.data.acknowledged_at).toBeTruthy();
  });
});
