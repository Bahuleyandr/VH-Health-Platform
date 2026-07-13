// M-E — canonical-event parity for the ANC branch of registerWalkIn.
//
// A pregnancy episode born at the walk-in counter must be indistinguishable
// on the canonical layer from one born through
// maternityService.createPregnancy (C2, PR #579): the same staff-only
// maternity.pregnancy_created clinical_timeline_events +
// clinical_audit_events pair, written inside the SAME setTenantTx
// transaction as the maternity_pregnancies insert, keyed off the source row,
// attributed to the authenticated walk-in staff actor, and carrying no
// free-text or PII in the payload.
//
// Proven against the real HTTP surface (supertest → app.js → real DB):
//   1. A new ANC walk-in pregnancy emits exactly ONE canonical/audit pair
//      whose shape matches the C2 contract, and a same-patient
//      re-registration adds neither a second pregnancy nor a second pair.
//   2. A pre-existing ongoing pregnancy produces no duplicate pregnancy and
//      no pregnancy_created event at all.
//   3. An injected failure at either canonical write rolls back the ENTIRE
//      walk-in transaction — appointment, pregnancy, and the users
//      is_pregnant projection included.
//   4. A non-ANC walk-in (no lmp_date) stays byte-for-byte off the maternity
//      canonical layer while keeping its registration response behavior.

import { randomUUID } from 'crypto';
import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = DEFAULT_TENANT_ID;
const STAFF_UID = 'a7777777-7777-4777-8777-77777777fe01';
const STAFF_ROLE = 'RECEPTIONIST';
// Deterministically 10 digits so registerWalkIn's normalizePhone() always
// rewrites them to the +91 form — cleanup below matches both forms.
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const ANC_DEPARTMENT = 'Obstetrics'; // deptPrefix() → 'ANC'
const OPD_DEPARTMENT = `MEWalkinGeneral-${RUN_SUFFIX}`; // no map hit → 'MEWA'
const FREE_TEXT_REASON = 'internal counter narrative must stay off the canonical layer';

const createdPatientUids = [];
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `97781${String((Number(RUN_SUFFIX) + phoneSequence) % 100000).padStart(5, '0')}`;
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
  const functionName = `me_walkin_fail_${suffix}`;
  const triggerName = `me_walkin_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'M-E injected failure ${suffix}';
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

async function seedPatient({ name, phone = nextPhone(), uid = randomUUID() } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', true, NOW())`,
    uid,
    `+91${phone}`,
    name,
  );
  createdPatientUids.push(uid);
  return { uid, phone };
}

async function patientByUid(uid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, is_pregnant, pregnancy_lmp_date::text AS pregnancy_lmp_date
       FROM users WHERE uid = $1::uuid`,
    uid,
  );
  return rows[0];
}

async function pregnanciesFor(uid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, pregnancy_number, status, created_by
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY id`,
    TENANT_ID,
    uid,
  );
}

async function appointmentsFor(uid) {
  return prisma.$queryRawUnsafe(
    `SELECT a.id FROM appointments a
       JOIN users u ON u.id = a.patient_id
      WHERE u.uid = $1::uuid`,
    uid,
  );
}

async function canonicalRows(patientUid, eventType = 'maternity.pregnancy_created') {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, event_type, event_status, source_table, source_id,
            resource_type, resource_id, actor_uid, actor_role,
            visible_to_patient, clinical_summary, payload
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
      ORDER BY created_at`,
    patientUid,
    eventType,
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
            resource_type, resource_table, resource_id, after_state, metadata
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
      ORDER BY created_at`,
    patientUid,
    eventType,
  );
  return { timeline, audit };
}

function walkInBody(phone, overrides = {}) {
  return {
    patient_name: 'ME Walkin Antenatal',
    patient_phone: phone,
    patient_gender: 'F',
    department: ANC_DEPARTMENT,
    reason: FREE_TEXT_REASON,
    visit_type: 'NEW',
    ...overrides,
  };
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);

  if (createdPatientUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
      createdPatientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
      createdPatientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[])`,
      createdPatientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointment_status_history
        WHERE appointment_id IN (
          SELECT a.id FROM appointments a
            JOIN users u ON u.id = a.patient_id
           WHERE u.uid = ANY($1::uuid[]))`,
      createdPatientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments
        WHERE patient_id IN (SELECT id FROM users WHERE uid = ANY($1::uuid[]))`,
      createdPatientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      createdPatientUids,
    ).catch(() => {});
    createdPatientUids.length = 0;
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = $1::uuid`,
    STAFF_UID,
  ).catch(() => {});
}

d('M-E walk-in ANC canonical parity', () => {
  let staffToken;

  beforeAll(async () => {
    await cleanup();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9778100099', 'ME Walkin Reception', $2, true, NOW())
       RETURNING id`,
      STAFF_UID,
      STAFF_ROLE,
    );
    staffToken = generateTestToken(STAFF_ROLE, { uid: STAFF_UID, id: rows[0].id });
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  function postWalkIn(body) {
    return request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send(body);
  }

  test('new ANC walk-in pregnancy emits exactly one staff-only C2-shaped canonical pair, and re-registration adds no second pair', async () => {
    const lmp = new Date(Date.now() - 12 * 7 * 86400000).toISOString().slice(0, 10);
    const { uid, phone } = await seedPatient({ name: 'ME Walkin Antenatal' });

    const res = await postWalkIn(walkInBody(phone, { lmp_date: lmp, gravida: 2, parity: 1 }));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // Preserved ANC registration behavior: token/queue fields + GA echo.
    expect(res.body.data.token_number).toBeTruthy();
    expect(res.body.data.visit_no).toBeTruthy();
    expect(res.body.data.gestational_age?.weeks).toBeGreaterThanOrEqual(11);

    const pregnancies = await pregnanciesFor(uid);
    expect(pregnancies).toHaveLength(1);
    const pregnancy = pregnancies[0];
    expect(String(pregnancy.created_by)).toBe(STAFF_UID);

    const { timeline, audit } = await canonicalRows(uid);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_ID,
      event_type: 'maternity.pregnancy_created',
      event_status: 'ongoing',
      source_table: 'maternity_pregnancies',
      source_id: String(pregnancy.id),
      resource_type: 'pregnancy',
      resource_id: String(pregnancy.id),
      actor_uid: STAFF_UID,
      actor_role: STAFF_ROLE,
      visible_to_patient: false,
      clinical_summary: 'Pregnancy episode recorded',
      payload: {
        pregnancy_id: pregnancy.id,
        pregnancy_number: pregnancy.pregnancy_number,
        status: 'ongoing',
      },
    });
    // Minimal payload — exactly the C2 keys, nothing else rides along.
    expect(Object.keys(timeline[0].payload).sort()).toEqual([
      'pregnancy_id', 'pregnancy_number', 'status',
    ]);

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: TENANT_ID,
      patient_uid: uid,
      action: 'maternity.pregnancy_created',
      action_status: 'success',
      actor_uid: STAFF_UID,
      actor_role: STAFF_ROLE,
      resource_type: 'pregnancy',
      resource_table: 'maternity_pregnancies',
      resource_id: String(pregnancy.id),
      after_state: {
        pregnancy_status: 'ongoing',
        user_is_pregnant: true,
      },
    });

    // Staff-only + no free-text/PII anywhere on the canonical pair.
    const canonicalText = JSON.stringify([timeline[0], audit[0]]);
    expect(canonicalText).not.toContain('internal counter narrative');
    expect(canonicalText).not.toContain('ME Walkin Antenatal');
    expect(canonicalText).not.toContain(phone);
    expect(canonicalText).not.toContain(lmp);

    // Re-registering the same patient must not duplicate the pregnancy or
    // the canonical pair (the ongoing-pregnancy guard short-circuits both).
    const again = await postWalkIn(walkInBody(phone, { lmp_date: lmp, gravida: 2, parity: 1 }));
    expect(again.statusCode).toBe(200);
    expect(await pregnanciesFor(uid)).toHaveLength(1);
    const after = await canonicalRows(uid);
    expect(after.timeline).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
  });

  test('an existing ongoing pregnancy produces no duplicate pregnancy and no pregnancy_created event', async () => {
    const lmp = new Date(Date.now() - 10 * 7 * 86400000).toISOString().slice(0, 10);
    const { uid, phone } = await seedPatient({ name: 'ME Walkin Existing' });
    await prisma.$executeRawUnsafe(
      `INSERT INTO maternity_pregnancies
         (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
       VALUES ($1::uuid, 1, $2::date, $2::date + 280, 'ongoing', $3::uuid, $4::uuid)`,
      uid,
      lmp,
      STAFF_UID,
      TENANT_ID,
    );

    const res = await postWalkIn(walkInBody(phone, { lmp_date: lmp }));
    expect(res.statusCode).toBe(200);

    expect(await pregnanciesFor(uid)).toHaveLength(1);
    const { timeline, audit } = await canonicalRows(uid);
    expect(timeline).toHaveLength(0);
    expect(audit).toHaveLength(0);
    // The projection update still runs for an existing pregnancy.
    expect((await patientByUid(uid)).is_pregnant).toBe(true);
  });

  test.each([
    ['canonical timeline', (uid) => ({
      table: 'clinical_timeline_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${uid}'::uuid AND NEW.event_type = 'maternity.pregnancy_created'`,
    })],
    ['clinical audit', (uid) => ({
      table: 'clinical_audit_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${uid}'::uuid AND NEW.action = 'maternity.pregnancy_created'`,
    })],
  ])('injected failure at %s rolls back the whole walk-in transaction', async (_label, triggerFor) => {
    const lmp = new Date(Date.now() - 8 * 7 * 86400000).toISOString().slice(0, 10);
    const { uid, phone } = await seedPatient({ name: 'ME Walkin Rollback' });
    const removeTrigger = await installFailureTrigger(triggerFor(uid));
    try {
      const res = await postWalkIn(walkInBody(phone, { lmp_date: lmp }));
      expect(res.statusCode).toBe(500);
      expect(res.body.details?.code).toBe('WALK_IN_FAILED');
    } finally {
      await removeTrigger();
    }

    expect(await appointmentsFor(uid)).toHaveLength(0);
    expect(await pregnanciesFor(uid)).toHaveLength(0);
    expect(await patientByUid(uid)).toMatchObject({
      is_pregnant: false,
      pregnancy_lmp_date: null,
    });
    const { timeline, audit } = await canonicalRows(uid);
    expect(timeline).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  test('a non-ANC walk-in stays off the maternity canonical layer and keeps its registration behavior', async () => {
    const { uid, phone } = await seedPatient({ name: 'ME Walkin General' });

    const res = await postWalkIn(walkInBody(phone, {
      department: OPD_DEPARTMENT,
      patient_gender: 'M',
    }));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token_number).toBeTruthy();
    expect(res.body.data.visit_no).toBeTruthy();
    expect(res.body.data.gestational_age).toBeUndefined();

    expect(await appointmentsFor(uid)).toHaveLength(1);
    expect(await pregnanciesFor(uid)).toHaveLength(0);
    expect((await patientByUid(uid)).is_pregnant).toBe(false);
    const { timeline, audit } = await canonicalRows(uid);
    expect(timeline).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});
