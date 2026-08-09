// BE-H3 (review 2026-08-09) — deep regressions for the virtual-ward check-in
// dropped-red-band fix.
//
// Before: the check-in INSERT failure was swallowed (checkInId stayed null),
// the escalation block was gated on checkInId, the enrollment flip carried a
// bare .catch(() => {}), and the route returned HTTP 200/201 with
// check_in_id: null — a deteriorating (red-band) patient was told "submitted"
// with nothing persisted and nobody escalated.
//
// Now, for non-green bands, check-in + escalation + enrollment flip + the
// canonical timeline/audit pairs (+ the in-tx care-team outbox alert for red)
// are ONE transaction, and any failure THROWS
// (VIRTUAL_WARD_CHECKIN_PERSIST_FAILED) so the patient app knows the
// check-in did not land. The virtual-ward tables ship in the migrations
// (026 + baseline), so there is deliberately no missing-schema grace on the
// non-green path.
//
// Template: virtual-ward-checkin-idor.deep.test.js (deep supertest,
// self-skips without DB, seeds via $queryRawUnsafe, generateTestToken).

import { randomUUID } from 'crypto';

import request from 'supertest';

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT = '00000000-0000-4000-8000-000000000001';
const CHECK_IN = '/api/v1/patient/virtual-ward/check-in';

const RED_PATIENT_UID = randomUUID();
const AMBER_PATIENT_UID = randomUUID();
const GREEN_PATIENT_UID = randomUUID();
const FAIL_PATIENT_UID = randomUUID();
const CARE_MANAGER_UID = randomUUID();
const ALL_UIDS = [RED_PATIENT_UID, AMBER_PATIENT_UID, GREEN_PATIENT_UID, FAIL_PATIENT_UID, CARE_MANAGER_UID];

const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9189${String(Date.now()).slice(-7)}${phoneSequence}`;
}

function client(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    post: (p, body) =>
      request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`).send(body),
  };
}

async function seedUser(uid, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW()) RETURNING id`,
    uid, nextPhone(), name, role, TENANT,
  );
  return rows[0].id;
}

async function seedEnrollment(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO virtual_ward_enrollments
       (tenant_id, patient_uid, care_manager_uid, pathway, start_date,
        expected_check_in_cadence_hours, metadata, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'generic_post_discharge', CURRENT_DATE,
             24, '{}'::jsonb, 'active', NOW(), NOW())
     RETURNING id`,
    TENANT, patientUid, CARE_MANAGER_UID,
  );
  return rows[0].id;
}

async function dropFailureTrigger(entry) {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS ${entry.triggerName} ON ${entry.table}`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS ${entry.functionName}()`,
  ).catch(() => {});
  const index = installedTriggers.indexOf(entry);
  if (index >= 0) installedTriggers.splice(index, 1);
}

async function installFailureTrigger({ table, operation, condition }) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `vwesc_fail_${suffix}`;
  const triggerName = `vwesc_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'VW-ESC injected failure ${suffix}';
         END IF;
         RETURN NEW;
       END;
       $$`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${triggerName}
         AFTER ${operation} ON ${table}
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
  } catch (error) {
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    throw error;
  }

  installedTriggers.push(entry);
  return () => dropFailureTrigger(entry);
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox WHERE payload->>'patient_uid' = ANY($1::text[])`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM virtual_ward_escalations WHERE patient_uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM virtual_ward_check_ins WHERE patient_uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM virtual_ward_enrollments WHERE patient_uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    ALL_UIDS,
  ).catch(() => {});
}

d('BE-H3 — virtual-ward red-band check-ins persist + escalate atomically', () => {
  const patientIds = {};

  beforeAll(async () => {
    await cleanup();
    await seedUser(CARE_MANAGER_UID, 'DOCTOR', 'VW-ESC Care Mgr');
    patientIds.red = await seedUser(RED_PATIENT_UID, 'PATIENT', 'VW-ESC Red Patient');
    patientIds.amber = await seedUser(AMBER_PATIENT_UID, 'PATIENT', 'VW-ESC Amber Patient');
    patientIds.green = await seedUser(GREEN_PATIENT_UID, 'PATIENT', 'VW-ESC Green Patient');
    patientIds.fail = await seedUser(FAIL_PATIENT_UID, 'PATIENT', 'VW-ESC Fail Patient');
    await seedEnrollment(RED_PATIENT_UID);
    await seedEnrollment(AMBER_PATIENT_UID);
    await seedEnrollment(GREEN_PATIENT_UID);
    await seedEnrollment(FAIL_PATIENT_UID);
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('red-band success: check-in + escalation + canonical pairs + enrollment flip + outbox alert', async () => {
    const res = await client('PATIENT', RED_PATIENT_UID, patientIds.red).post(CHECK_IN, {
      patient_uid: RED_PATIENT_UID,
      symptoms: { chest_pain: true },
      vitals: { spo2: 86 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.triage_band).toBe('red');
    expect(res.body.data.check_in_id).toBeTruthy();
    expect(res.body.data.persisted).toBe(true);
    expect(res.body.data.escalation_id).toBeTruthy();
    const checkInId = res.body.data.check_in_id;
    const escalationId = res.body.data.escalation_id;

    const checkIns = await prisma.$queryRawUnsafe(
      `SELECT triage_band FROM virtual_ward_check_ins WHERE id = $1::int`, checkInId,
    );
    expect(checkIns).toHaveLength(1);
    expect(checkIns[0].triage_band).toBe('red');

    const escalations = await prisma.$queryRawUnsafe(
      `SELECT severity, check_in_id FROM virtual_ward_escalations WHERE id = $1::int`, escalationId,
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ severity: 'red', check_in_id: checkInId });

    const enrollment = await prisma.$queryRawUnsafe(
      `SELECT status FROM virtual_ward_enrollments WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, RED_PATIENT_UID,
    );
    expect(enrollment[0].status).toBe('escalated');

    // Canonical pair for the check-in…
    const checkInTimeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, event_status FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `virtual_ward_check_ins:${checkInId}:recorded`,
    );
    expect(checkInTimeline).toHaveLength(1);
    expect(checkInTimeline[0]).toMatchObject({
      event_type: 'virtual_ward.check_in_recorded',
      event_status: 'red',
    });
    const checkInAudit = await prisma.$queryRawUnsafe(
      `SELECT action_status FROM clinical_audit_events WHERE idempotency_key = $1`,
      `virtual_ward_check_ins:${checkInId}:audit:recorded`,
    );
    expect(checkInAudit).toHaveLength(1);

    // …and for the escalation.
    const escalationTimeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `virtual_ward_escalations:${escalationId}:raised`,
    );
    expect(escalationTimeline).toHaveLength(1);
    expect(escalationTimeline[0].event_type).toBe('virtual_ward.escalation_raised');

    // Durable care-team alert (in the same transaction as the escalation).
    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT status, recipient_id, title FROM notification_outbox
        WHERE tenant_id = $1::uuid AND source_event_key = $2`,
      TENANT, `virtual_ward_escalations:${escalationId}:red_alert`,
    );
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].status).toBe('PENDING');
    expect(outboxRows[0].recipient_id).toBe(CARE_MANAGER_UID);
    expect(outboxRows[0].title).toMatch(/red escalation/i);
  }, 30_000);

  test('amber check-in gets the escalation canonical pair too (SF-3); enrollment flip + outbox stay red-only', async () => {
    const res = await client('PATIENT', AMBER_PATIENT_UID, patientIds.amber).post(CHECK_IN, {
      patient_uid: AMBER_PATIENT_UID,
      symptoms: { fever: true },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.triage_band).toBe('amber');
    expect(res.body.data.persisted).toBe(true);
    expect(res.body.data.escalation_id).toBeTruthy();
    const escalationId = res.body.data.escalation_id;

    // Canonical invariant: the amber escalation row carries its own
    // timeline+audit pair in the same transaction.
    const escalationTimeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, event_status FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `virtual_ward_escalations:${escalationId}:raised`,
    );
    expect(escalationTimeline).toHaveLength(1);
    expect(escalationTimeline[0]).toMatchObject({
      event_type: 'virtual_ward.escalation_raised',
      event_status: 'amber',
    });
    const escalationAudit = await prisma.$queryRawUnsafe(
      `SELECT action_status FROM clinical_audit_events WHERE idempotency_key = $1`,
      `virtual_ward_escalations:${escalationId}:audit:raised`,
    );
    expect(escalationAudit).toHaveLength(1);

    // Amber is "follow-up today", not "call now": no enrollment flip, no
    // red outbox alert.
    const enrollment = await prisma.$queryRawUnsafe(
      `SELECT status FROM virtual_ward_enrollments WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, AMBER_PATIENT_UID,
    );
    expect(enrollment[0].status).toBe('active');
    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM notification_outbox WHERE payload->>'patient_uid' = $1`,
      AMBER_PATIENT_UID,
    );
    expect(outboxRows).toHaveLength(0);
  }, 30_000);

  test('non-green persist failure: error response, full rollback, nothing silently dropped', async () => {
    const removeTrigger = await installFailureTrigger({
      table: 'virtual_ward_check_ins',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${FAIL_PATIENT_UID}'::uuid`,
    });

    const res = await client('PATIENT', FAIL_PATIENT_UID, patientIds.fail).post(CHECK_IN, {
      patient_uid: FAIL_PATIENT_UID,
      symptoms: { chest_pain: true },
    });
    await removeTrigger();

    // The patient app is TOLD the check-in did not land — no silent 2xx.
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);

    // Full rollback: no check-in, no escalation, enrollment untouched,
    // no canonical rows, no outbox alert.
    const checkIns = await prisma.$queryRawUnsafe(
      `SELECT id FROM virtual_ward_check_ins WHERE patient_uid = $1::uuid`, FAIL_PATIENT_UID,
    );
    expect(checkIns).toHaveLength(0);
    const escalations = await prisma.$queryRawUnsafe(
      `SELECT id FROM virtual_ward_escalations WHERE patient_uid = $1::uuid`, FAIL_PATIENT_UID,
    );
    expect(escalations).toHaveLength(0);
    const enrollment = await prisma.$queryRawUnsafe(
      `SELECT status FROM virtual_ward_enrollments WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, FAIL_PATIENT_UID,
    );
    expect(enrollment[0].status).toBe('active');
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, FAIL_PATIENT_UID,
    );
    expect(timeline).toHaveLength(0);
    const outboxRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM notification_outbox WHERE payload->>'patient_uid' = $1`, FAIL_PATIENT_UID,
    );
    expect(outboxRows).toHaveLength(0);
  }, 30_000);

  test('green check-in persists with its canonical pair and stays 201', async () => {
    const res = await client('PATIENT', GREEN_PATIENT_UID, patientIds.green).post(CHECK_IN, {
      patient_uid: GREEN_PATIENT_UID,
      vitals: { heart_rate: 72 },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.triage_band).toBe('green');
    expect(res.body.data.check_in_id).toBeTruthy();
    expect(res.body.data.persisted).toBe(true);
    expect(res.body.data.escalation_id).toBeNull();

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_status FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `virtual_ward_check_ins:${res.body.data.check_in_id}:recorded`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event_status).toBe('green');

    const enrollment = await prisma.$queryRawUnsafe(
      `SELECT status FROM virtual_ward_enrollments WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT, GREEN_PATIENT_UID,
    );
    expect(enrollment[0].status).toBe('active');
  }, 30_000);
});
