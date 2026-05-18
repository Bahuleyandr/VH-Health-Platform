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
import prisma from '../lib/prisma.js';
import { API_KEY, authClient } from './testClient.js';
import { normalizePhone } from '../utils/phoneUtils.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Distinct UIDs/phones so this suite doesn't collide with worklist-deep.
const PATIENT_UID = 'c4444444-4444-4444-8444-44444444aa01';
const PATIENT_PHONE = '9000040001';
const DOCTOR_UID = 'c4444444-4444-4444-8444-44444444aa02';
const DOCTOR_PHONE = '9000040002';

async function deletePatient(uid) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM notifications
       WHERE data->>'patient_uid' = $1
          OR phone = $2`,
    uid, normalizePhone(DOCTOR_PHONE),
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
       WHERE (payload->>'patient_uid')::text = $1`,
    uid,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM lab_critical_alerts WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM emergency_visits WHERE patient_uid = $1::uuid`, uid).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
}

async function makeUser(uid, phone, name, role) {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, uid).catch(() => {});
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

  beforeAll(async () => {
    await deletePatient(PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});

    await makeUser(PATIENT_UID, PATIENT_PHONE, 'Lab Alert Test Patient', 'PATIENT');
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

    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, critical_high, is_active)
       VALUES ($1::uuid, 'TROPI', 'Troponin I', 0.04, true)
       ON CONFLICT DO NOTHING`,
      TENANT_ID,
    );
  });

  afterAll(async () => {
    await deletePatient(PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('signs off a critical troponin → doctor sees it in /notifications/my', async () => {
    // 1. Submit a critical troponin value via the lab path (mirrors what
    //    the LAB_STAFF agent does in the emergency-walk-in journey).
    const labRes = await labTech.post('/api/v1/lab/results').send({
      patient_uid: PATIENT_UID,
      test_code: 'TROPI',
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
