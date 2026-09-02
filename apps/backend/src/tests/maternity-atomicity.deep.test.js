import { randomUUID } from 'crypto';
import { Client } from 'pg';

import prisma from '../lib/prisma.js';
import {
  admitToLabor,
  createPregnancy,
  recordAncVisit,
  updatePregnancy,
  recordPartographEntry,
  recordDelivery,
} from '../services/maternity/maternityService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = randomUUID();
const ACTOR_UID = randomUUID();
const PERFORMER_UID = randomUUID();
const TENANT_B_SLUG = `c2-atomic-${randomUUID().slice(0, 8)}`;
const createdPatientUids = [];
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9187${String(Date.now()).slice(-7)}${phoneSequence}`;
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
  const functionName = `c2_atomic_fail_${suffix}`;
  const triggerName = `c2_atomic_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'C2 injected failure ${suffix}';
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

async function installAdvisoryBarrierTrigger({ namespace, key }) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `c2_atomic_wait_${suffix}`;
  const triggerName = `c2_atomic_wait_trigger_${suffix}`;
  const entry = { table: 'maternity_anc_visits', functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         PERFORM pg_advisory_xact_lock(${Number(namespace)}, ${Number(key)});
         RETURN NEW;
       END;
       $$`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${triggerName}
         BEFORE INSERT ON maternity_anc_visits
         FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
  } catch (error) {
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    throw error;
  }

  installedTriggers.push(entry);
  return () => dropFailureTrigger(entry);
}

async function waitForLockWaiters(expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS waiters
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.waiters) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} blocked database operation(s)`);
}

async function seedUser({
  tenantId = TENANT_A,
  role = 'PATIENT',
  name = `C2 Atomic ${randomUUID().slice(0, 8)}`,
  uid = randomUUID(),
  isPregnant = false,
  lmpDate = null,
} = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, is_pregnant, pregnancy_lmp_date,
        tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5, $6::date, $7::uuid, NOW())`,
    uid,
    nextPhone(),
    name,
    role,
    isPregnant,
    lmpDate,
    tenantId,
  );
  if (role === 'PATIENT') createdPatientUids.push(uid);
  return uid;
}

async function seedPregnancy({
  patientUid,
  tenantId = TENANT_A,
  lmpDate = '2025-10-01',
  pregnancyNumber = 1,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, $2::int, $3::date, $3::date + 280, 'ongoing', $4::uuid, $5::uuid)
     RETURNING *`,
    patientUid,
    pregnancyNumber,
    lmpDate,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

async function seedAdmission({ patientUid, tenantId = TENANT_A } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions
       (patient_uid, tenant_id, status, admitted_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', NOW(), NOW())
     RETURNING *`,
    patientUid,
    tenantId,
  );
  return rows[0];
}

async function seedLabor({ pregnancyId, tenantId = TENANT_A, admissionId = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_labor_admissions
       (pregnancy_id, admission_id, admission_reason, status, attending_obstetrician, tenant_id)
     VALUES ($1::int, $2::int, 'spontaneous_labour', 'active', $3::uuid, $4::uuid)
     RETURNING *`,
    Number(pregnancyId),
    admissionId == null ? null : Number(admissionId),
    PERFORMER_UID,
    tenantId,
  );
  return rows[0];
}

async function patientProjection(patientUid, tenantId = TENANT_A) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT is_pregnant, pregnancy_lmp_date::text AS pregnancy_lmp_date
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    tenantId,
    patientUid,
  );
  return rows[0];
}

async function canonicalRows(patientUid, eventType) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, event_type, event_status, source_table, source_id,
            resource_type, resource_id, actor_uid, actor_role,
            visible_to_patient, clinical_summary, payload, idempotency_key
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
      ORDER BY created_at`,
    patientUid,
    eventType,
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
            resource_type, resource_table, resource_id, after_state, metadata,
            idempotency_key
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
      ORDER BY created_at`,
    patientUid,
    eventType,
  );
  return { timeline, audit };
}

async function assertCreateRolledBack(patientUid) {
  const pregnancies = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_A,
    patientUid,
  );
  const projection = await patientProjection(patientUid);
  const events = await canonicalRows(patientUid, 'maternity.pregnancy_created');

  expect(pregnancies).toHaveLength(0);
  expect(projection).toMatchObject({ is_pregnant: false, pregnancy_lmp_date: null });
  expect(events.timeline).toHaveLength(0);
  expect(events.audit).toHaveLength(0);
}

async function assertPregnancyUpdateRolledBack({ patientUid, pregnancyId, lmpDate }) {
  const pregnancies = await prisma.$queryRawUnsafe(
    `SELECT lmp_date::text AS lmp_date, high_risk, notes
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    TENANT_A,
    Number(pregnancyId),
  );
  const projection = await patientProjection(patientUid);
  const events = await canonicalRows(patientUid, 'maternity.pregnancy_updated');

  expect(pregnancies[0]).toMatchObject({
    lmp_date: lmpDate,
    high_risk: false,
    notes: null,
  });
  expect(projection).toMatchObject({ is_pregnant: false, pregnancy_lmp_date: null });
  expect(events.timeline).toHaveLength(0);
  expect(events.audit).toHaveLength(0);
}

async function assertLaborAdmissionRolledBack({ patientUid, pregnancyId }) {
  const admissions = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_labor_admissions
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    TENANT_A,
    Number(pregnancyId),
  );
  const events = await canonicalRows(patientUid, 'maternity.labor_admission_recorded');

  expect(admissions).toHaveLength(0);
  expect(events.timeline).toHaveLength(0);
  expect(events.audit).toHaveLength(0);
}

async function assertPartographRolledBack({ patientUid, laborId }) {
  const entries = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_partograph_entries
      WHERE tenant_id = $1::uuid AND labor_admission_id = $2::int`,
    TENANT_A,
    Number(laborId),
  );
  const labor = await prisma.$queryRawUnsafe(
    `SELECT status FROM maternity_labor_admissions
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    TENANT_A,
    Number(laborId),
  );
  const events = await canonicalRows(patientUid, 'maternity.partograph_entry_recorded');

  expect(entries).toHaveLength(0);
  expect(labor[0]?.status).toBe('active');
  expect(events.timeline).toHaveLength(0);
  expect(events.audit).toHaveLength(0);
}

async function assertDeliveryRolledBack({ patientUid, pregnancyId, laborId, lmpDate }) {
  const deliveries = await prisma.$queryRawUnsafe(
    `SELECT id FROM maternity_deliveries
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    TENANT_A,
    Number(pregnancyId),
  );
  const pregnancies = await prisma.$queryRawUnsafe(
    `SELECT status FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    TENANT_A,
    Number(pregnancyId),
  );
  const labor = await prisma.$queryRawUnsafe(
    `SELECT status FROM maternity_labor_admissions
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    TENANT_A,
    Number(laborId),
  );
  const projection = await patientProjection(patientUid);
  const events = await canonicalRows(patientUid, 'maternity.delivery_recorded');

  expect(deliveries).toHaveLength(0);
  expect(pregnancies[0].status).toBe('ongoing');
  expect(labor[0].status).toBe('active');
  expect(projection).toMatchObject({ is_pregnant: true, pregnancy_lmp_date: lmpDate });
  expect(events.timeline).toHaveLength(0);
  expect(events.audit).toHaveLength(0);
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
      `DELETE FROM admissions WHERE patient_uid = ANY($1::uuid[])`,
      createdPatientUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      createdPatientUids,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    ACTOR_UID,
    PERFORMER_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
}

d('C2 maternity atomic writes', () => {
  const originalGate = process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'C2 Atomic Tenant B')`,
      TENANT_B,
      TENANT_B_SLUG,
    );
    await seedUser({ uid: ACTOR_UID, role: 'NURSING_STAFF', name: 'C2 Atomic Recorder' });
    await seedUser({ uid: PERFORMER_UID, role: 'DOCTOR', name: 'C2 Atomic Performer' });
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
    delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
  });

  afterAll(async () => {
    await cleanup();
    if (originalGate === undefined) delete process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED;
    else process.env.OBGYN_LABOUR_WARD_PRIVILEGE_GATE_ENABLED = originalGate;
    await prisma.$disconnect();
  }, 30_000);

  test('createPregnancy commits detail, projection, staff-only canonical event, and audit together', async () => {
    const patientUid = await seedUser();
    const pregnancy = await createPregnancy({
      tenantId: TENANT_A,
      patient_uid: patientUid,
      pregnancy_number: 2,
      lmp_date: '2025-11-03',
      gravida: 2,
      parity: 1,
      notes: 'private pregnancy narrative must not enter canonical payloads',
      high_risk: true,
      high_risk_reasons: ['internal-risk-tag'],
      created_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: true,
      pregnancy_lmp_date: '2025-11-03',
    });
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.pregnancy_created');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'ongoing',
      source_table: 'maternity_pregnancies',
      source_id: String(pregnancy.id),
      resource_type: 'pregnancy',
      resource_id: String(pregnancy.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      clinical_summary: 'Pregnancy episode recorded',
      payload: {
        pregnancy_id: pregnancy.id,
        pregnancy_number: 2,
        status: 'ongoing',
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: patientUid,
      action_status: 'success',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_type: 'pregnancy',
      resource_table: 'maternity_pregnancies',
      resource_id: String(pregnancy.id),
      after_state: {
        pregnancy_status: 'ongoing',
        user_is_pregnant: true,
      },
    });
    expect(JSON.stringify([timeline[0].payload, audit[0].after_state])).not.toContain('private pregnancy');
    expect(JSON.stringify([timeline[0].payload, audit[0].after_state])).not.toContain('internal-risk-tag');
  });

  test.each([
    ['pregnancy detail', ({ patientUid }) => ({
      table: 'maternity_pregnancies', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid`,
    })],
    ['user projection', ({ patientUid }) => ({
      table: 'users', operation: 'UPDATE',
      condition: `NEW.uid = '${patientUid}'::uuid AND NEW.is_pregnant IS TRUE`,
    })],
    ['canonical timeline', ({ patientUid }) => ({
      table: 'clinical_timeline_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.pregnancy_created'`,
    })],
    ['clinical audit', ({ patientUid }) => ({
      table: 'clinical_audit_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.pregnancy_created'`,
    })],
  ])('createPregnancy rolls back after injected failure at %s', async (_label, triggerFor) => {
    const patientUid = await seedUser();
    const removeTrigger = await installFailureTrigger(triggerFor({ patientUid }));
    try {
      await expect(createPregnancy({
        tenantId: TENANT_A,
        patient_uid: patientUid,
        lmp_date: '2025-12-01',
        created_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    await assertCreateRolledBack(patientUid);
  });

  test('updatePregnancy commits correction, projection, and canonical evidence from stored truth', async () => {
    const patientUid = await seedUser();
    const spoofedPatientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid, lmpDate: '2025-10-01' });

    const updated = await updatePregnancy({
      tenantId: TENANT_A,
      id: pregnancy.id,
      patient_uid: spoofedPatientUid,
      actor_uid: spoofedPatientUid,
      actor_role: 'SUPER_ADMIN',
      lmp_date: '2025-10-15',
      high_risk: true,
      high_risk_reasons: ['private-risk-reason'],
      notes: 'private corrected narrative',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',
    });

    expect(String(updated.patient_uid)).toBe(patientUid);
    expect(updated.status).toBe('ongoing');
    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: true,
      pregnancy_lmp_date: '2025-10-15',
    });
    expect(await patientProjection(spoofedPatientUid)).toMatchObject({
      is_pregnant: false,
      pregnancy_lmp_date: null,
    });

    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.pregnancy_updated');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'ongoing',
      source_table: 'maternity_pregnancies',
      source_id: String(pregnancy.id),
      resource_type: 'pregnancy',
      resource_id: String(pregnancy.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      clinical_summary: 'Pregnancy episode updated',
      payload: {
        pregnancy_id: pregnancy.id,
        updated_fields: ['lmp_date', 'high_risk', 'high_risk_reasons', 'notes'],
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: patientUid,
      action_status: 'success',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_type: 'pregnancy',
      resource_table: 'maternity_pregnancies',
      resource_id: String(pregnancy.id),
      after_state: {
        pregnancy_status: 'ongoing',
        user_is_pregnant: true,
      },
      metadata: {
        updated_fields: ['lmp_date', 'high_risk', 'high_risk_reasons', 'notes'],
      },
    });
    expect(JSON.stringify([timeline[0].payload, audit[0].after_state])).not.toContain(
      'private corrected narrative',
    );
    expect(JSON.stringify([timeline[0].payload, audit[0].after_state])).not.toContain(
      'private-risk-reason',
    );

    const beforeRetry = await prisma.$queryRawUnsafe(
      `SELECT updated_at FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    await updatePregnancy({
      tenantId: TENANT_A,
      id: pregnancy.id,
      lmp_date: '2025-10-15',
      high_risk: true,
      high_risk_reasons: ['private-risk-reason'],
      notes: 'private corrected narrative',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',
    });
    const afterRetry = await prisma.$queryRawUnsafe(
      `SELECT updated_at FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(afterRetry[0].updated_at).toEqual(beforeRetry[0].updated_at);
    const retryEvents = await canonicalRows(patientUid, 'maternity.pregnancy_updated');
    expect(retryEvents.timeline).toHaveLength(1);
    expect(retryEvents.audit).toHaveLength(1);
  });

  test('updatePregnancy preserves the newest ongoing pregnancy projection when correcting an older episode', async () => {
    const patientUid = await seedUser({ isPregnant: true, lmpDate: '2025-12-01' });
    const olderPregnancy = await seedPregnancy({
      patientUid,
      pregnancyNumber: 1,
      lmpDate: '2025-10-01',
    });
    const latestPregnancy = await seedPregnancy({
      patientUid,
      pregnancyNumber: 2,
      lmpDate: '2025-12-01',
    });

    await updatePregnancy({
      tenantId: TENANT_A,
      id: olderPregnancy.id,
      lmp_date: '2025-10-15',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',
    });

    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: true,
      pregnancy_lmp_date: '2025-12-01',
    });
    const latestRows = await prisma.$queryRawUnsafe(
      `SELECT lmp_date::text AS lmp_date
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(latestPregnancy.id),
    );
    expect(latestRows[0].lmp_date).toBe('2025-12-01');
  });

  test('updatePregnancy and recordAncVisit use one lock order and settle without deadlock or lost writes', async () => {
    const patientUid = await seedUser({ isPregnant: true, lmpDate: '2025-10-01' });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate: '2025-10-01' });
    const namespace = 19019;
    const key = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 7), 16);
    const blocker = new Client({
      connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
    });
    const removeBarrier = await installAdvisoryBarrierTrigger({ namespace, key });
    const operations = [];
    let blockerConnected = false;
    let lockReleased = false;
    let results;

    try {
      await blocker.connect();
      blockerConnected = true;
      await blocker.query('SELECT pg_advisory_lock($1::int, $2::int)', [namespace, key]);

      operations.push(recordAncVisit({
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        visit_date: '2026-06-01',
        weight_kg: 68.5,
        notes: 'concurrent ANC correction',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      }));
      await waitForLockWaiters(1);

      operations.push(updatePregnancy({
        tenantId: TENANT_A,
        id: pregnancy.id,
        lmp_date: '2025-10-15',
        notes: 'concurrent pregnancy correction',
      }, {
        actorUid: ACTOR_UID,
        actorRole: 'NURSING_STAFF',
      }));
      await waitForLockWaiters(2);

      await blocker.query('SELECT pg_advisory_unlock($1::int, $2::int)', [namespace, key]);
      lockReleased = true;
      results = await Promise.allSettled(operations);
    } finally {
      if (!lockReleased && blockerConnected) {
        await blocker.query('SELECT pg_advisory_unlock($1::int, $2::int)', [namespace, key])
          .catch(() => {});
      }
      await Promise.allSettled(operations);
      await blocker.end().catch(() => {});
      await removeBarrier();
    }

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'rejected') expect(result.reason?.code).not.toBe('40P01');
    }
    const pregnancyRows = await prisma.$queryRawUnsafe(
      `SELECT lmp_date::text AS lmp_date, notes
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(pregnancyRows[0]).toMatchObject({
      lmp_date: '2025-10-15',
      notes: 'concurrent pregnancy correction',
    });
    const visits = await prisma.$queryRawUnsafe(
      `SELECT weight_kg::text AS weight_kg, notes
         FROM maternity_anc_visits
        WHERE tenant_id = $1::uuid
          AND pregnancy_id = $2::int
          AND visit_date = '2026-06-01'::date`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(visits).toEqual([{
      weight_kg: '68.50',
      notes: 'concurrent ANC correction',
    }]);
    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: true,
      pregnancy_lmp_date: '2025-10-15',
    });
    const updateEvents = await canonicalRows(patientUid, 'maternity.pregnancy_updated');
    const ancEvents = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(updateEvents.timeline).toHaveLength(1);
    expect(updateEvents.audit).toHaveLength(1);
    expect(ancEvents.timeline).toHaveLength(1);
    expect(ancEvents.audit).toHaveLength(1);
  }, 30_000);

  test('updatePregnancy rejects general lifecycle changes and cross-tenant updates without writes', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid, lmpDate: '2025-10-01' });

    await expect(updatePregnancy({
      tenantId: TENANT_A,
      id: pregnancy.id,
      status: 'delivered',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MATERNITY_STATUS_TRANSITION_REQUIRES_LIFECYCLE_ACTION',
    });
    await expect(updatePregnancy({
      tenantId: TENANT_B,
      id: pregnancy.id,
      lmp_date: '2025-10-15',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT lmp_date::text AS lmp_date, status
         FROM maternity_pregnancies
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(rows[0]).toMatchObject({ lmp_date: '2025-10-01', status: 'ongoing' });
    const events = await canonicalRows(patientUid, 'maternity.pregnancy_updated');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test.each([
    ['pregnancy detail', ({ pregnancyId }) => ({
      table: 'maternity_pregnancies', operation: 'UPDATE',
      condition: `NEW.id = ${Number(pregnancyId)}`,
    })],
    ['user projection', ({ patientUid }) => ({
      table: 'users', operation: 'UPDATE',
      condition: `NEW.uid = '${patientUid}'::uuid AND NEW.pregnancy_lmp_date = '2025-10-15'::date`,
    })],
    ['canonical timeline', ({ patientUid }) => ({
      table: 'clinical_timeline_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.pregnancy_updated'`,
    })],
    ['clinical audit', ({ patientUid }) => ({
      table: 'clinical_audit_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.pregnancy_updated'`,
    })],
  ])('updatePregnancy rolls back after injected failure at %s', async (_label, triggerFor) => {
    const lmpDate = '2025-10-01';
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid, lmpDate });
    const removeTrigger = await installFailureTrigger(triggerFor({
      patientUid,
      pregnancyId: pregnancy.id,
    }));
    try {
      await expect(updatePregnancy({
        tenantId: TENANT_A,
        id: pregnancy.id,
        lmp_date: '2025-10-15',
        high_risk: true,
        notes: 'must roll back',
      }, {
        actorUid: ACTOR_UID,
        actorRole: 'NURSING_STAFF',
      })).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    await assertPregnancyUpdateRolledBack({
      patientUid,
      pregnancyId: pregnancy.id,
      lmpDate,
    });
  });

  test('admitToLabor commits detail and a staff-only canonical/audit pair under the submitter identity', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const admission = await seedAdmission({ patientUid });
    const laborAdmission = await admitToLabor({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      admission_id: admission.id,
      admission_reason: 'other',
      gestational_age_weeks: 39.2,
      membrane_status: 'intact',
      cervix_dilation_cm: 3,
      fetal_heart_rate_bpm: 142,
      attending_obstetrician: PERFORMER_UID,
      notes: 'MB_PRIVATE_LABOUR_NARRATIVE',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(String(laborAdmission.attending_obstetrician)).toBe(PERFORMER_UID);
    expect(laborAdmission.admission_reason).toBe('other');
    expect(laborAdmission.notes).toBe('MB_PRIVATE_LABOUR_NARRATIVE');
    const persistedLaborAdmissions = await prisma.$queryRawUnsafe(
      `SELECT id, pregnancy_id, admission_id, admission_reason, attending_obstetrician, notes
         FROM maternity_labor_admissions
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(laborAdmission.id),
    );
    expect(persistedLaborAdmissions).toHaveLength(1);
    expect(persistedLaborAdmissions[0]).toMatchObject({
      id: laborAdmission.id,
      pregnancy_id: pregnancy.id,
      admission_id: admission.id,
      admission_reason: 'other',
      attending_obstetrician: PERFORMER_UID,
      notes: 'MB_PRIVATE_LABOUR_NARRATIVE',
    });

    const { timeline, audit } = await canonicalRows(
      patientUid,
      'maternity.labor_admission_recorded',
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'active',
      source_table: 'maternity_labor_admissions',
      source_id: String(laborAdmission.id),
      resource_type: 'labor_admission',
      resource_id: String(laborAdmission.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      clinical_summary: 'Labour admission recorded',
      payload: {
        labor_admission_id: laborAdmission.id,
        pregnancy_id: pregnancy.id,
        admission_id: admission.id,
      },
      idempotency_key: `maternity_labor_admissions:${laborAdmission.id}:recorded`,
    });
    expect(timeline[0].payload).toEqual({
      labor_admission_id: laborAdmission.id,
      pregnancy_id: pregnancy.id,
      admission_id: admission.id,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: patientUid,
      action_status: 'success',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_type: 'labor_admission',
      resource_table: 'maternity_labor_admissions',
      resource_id: String(laborAdmission.id),
      after_state: { labor_status: 'active' },
      idempotency_key: `maternity_labor_admissions:${laborAdmission.id}:audit:recorded`,
    });
    expect(audit[0].after_state).toEqual({ labor_status: 'active' });
    expect(audit[0].metadata).toEqual({});
    const canonicalText = JSON.stringify([timeline[0].payload, audit[0].after_state, audit[0].metadata]);
    expect(canonicalText).not.toContain('MB_PRIVATE_LABOUR_NARRATIVE');
    expect(canonicalText).not.toContain('admission_reason');
    expect(canonicalText).not.toContain('notes');
  });

  test.each([
    ['canonical timeline', ({ patientUid }) => ({
      table: 'clinical_timeline_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.labor_admission_recorded'`,
    })],
    ['clinical audit', ({ patientUid }) => ({
      table: 'clinical_audit_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.labor_admission_recorded'`,
    })],
  ])('admitToLabor rolls back the detail after injected failure at %s', async (_label, triggerFor) => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const admission = await seedAdmission({ patientUid });
    const removeTrigger = await installFailureTrigger(triggerFor({ patientUid }));
    try {
      await expect(admitToLabor({
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        admission_id: admission.id,
        admission_reason: 'other',
        attending_obstetrician: PERFORMER_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    await assertLaborAdmissionRolledBack({ patientUid, pregnancyId: pregnancy.id });
  });

  test('recordPartographEntry commits detail and a staff-only canonical/audit pair without inpatient content', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const labor = await seedLabor({ pregnancyId: pregnancy.id });
    const entry = await recordPartographEntry({
      tenantId: TENANT_A,
      labor_admission_id: labor.id,
      recorded_at: '2026-07-13T12:00:00.000Z',
      bp_systolic: 138,
      bp_diastolic: 88,
      cervix_dilation_cm: 5,
      contractions_per_10min: 3,
      fetal_heart_rate_bpm: 144,
      oxytocin_units_l: 4.25,
      oxytocin_drops_min: 18,
      drugs_given: 'MB_PRIVATE_DRUG_DETAIL',
      iv_fluids: 'MB_PRIVATE_IV_FLUID_DETAIL',
      notes: 'MB_PRIVATE_PARTOGRAPH_NARRATIVE',
      recorded_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(String(entry.recorded_by)).toBe(PERFORMER_UID);
    expect(entry.drugs_given).toBe('MB_PRIVATE_DRUG_DETAIL');
    expect(entry.iv_fluids).toBe('MB_PRIVATE_IV_FLUID_DETAIL');
    expect(entry.notes).toBe('MB_PRIVATE_PARTOGRAPH_NARRATIVE');
    const persistedPartographEntries = await prisma.$queryRawUnsafe(
      `SELECT id, labor_admission_id, recorded_by, drugs_given, iv_fluids, notes
         FROM maternity_partograph_entries
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT_A,
      Number(entry.id),
    );
    expect(persistedPartographEntries).toHaveLength(1);
    expect(persistedPartographEntries[0]).toMatchObject({
      id: entry.id,
      labor_admission_id: labor.id,
      recorded_by: PERFORMER_UID,
      drugs_given: 'MB_PRIVATE_DRUG_DETAIL',
      iv_fluids: 'MB_PRIVATE_IV_FLUID_DETAIL',
      notes: 'MB_PRIVATE_PARTOGRAPH_NARRATIVE',
    });

    const { timeline, audit } = await canonicalRows(
      patientUid,
      'maternity.partograph_entry_recorded',
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'recorded',
      source_table: 'maternity_partograph_entries',
      source_id: String(entry.id),
      resource_type: 'partograph_entry',
      resource_id: String(entry.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      clinical_summary: 'Partograph entry recorded',
      payload: {
        partograph_entry_id: entry.id,
        labor_admission_id: labor.id,
        pregnancy_id: pregnancy.id,
      },
      idempotency_key: `maternity_partograph_entries:${entry.id}:recorded`,
    });
    expect(timeline[0].payload).toEqual({
      partograph_entry_id: entry.id,
      labor_admission_id: labor.id,
      pregnancy_id: pregnancy.id,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: patientUid,
      action_status: 'success',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_type: 'partograph_entry',
      resource_table: 'maternity_partograph_entries',
      resource_id: String(entry.id),
      after_state: { partograph_entry_recorded: true },
      idempotency_key: `maternity_partograph_entries:${entry.id}:audit:recorded`,
    });
    expect(audit[0].after_state).toEqual({ partograph_entry_recorded: true });
    expect(audit[0].metadata).toEqual({});
    const canonicalText = JSON.stringify([timeline[0].payload, audit[0].after_state, audit[0].metadata]);
    for (const excluded of [
      'MB_PRIVATE_DRUG_DETAIL',
      'MB_PRIVATE_IV_FLUID_DETAIL',
      'MB_PRIVATE_PARTOGRAPH_NARRATIVE',
      'drugs_given',
      'iv_fluids',
      'oxytocin',
      'notes',
    ]) {
      expect(canonicalText).not.toContain(excluded);
    }
  });

  test.each([
    ['canonical timeline', ({ patientUid }) => ({
      table: 'clinical_timeline_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.partograph_entry_recorded'`,
    })],
    ['clinical audit', ({ patientUid }) => ({
      table: 'clinical_audit_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.partograph_entry_recorded'`,
    })],
  ])('recordPartographEntry rolls back the detail after injected failure at %s', async (_label, triggerFor) => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const labor = await seedLabor({ pregnancyId: pregnancy.id });
    const removeTrigger = await installFailureTrigger(triggerFor({ patientUid }));
    try {
      await expect(recordPartographEntry({
        tenantId: TENANT_A,
        labor_admission_id: labor.id,
        recorded_at: '2026-07-13T13:00:00.000Z',
        cervix_dilation_cm: 6,
        recorded_by: PERFORMER_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    await assertPartographRolledBack({ patientUid, laborId: labor.id });
  });

  test('recordDelivery commits all transitions and a staff-only event under the submitter identity', async () => {
    const lmpDate = '2025-09-11';
    const patientUid = await seedUser({ isPregnant: true, lmpDate });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate });
    const labor = await seedLabor({ pregnancyId: pregnancy.id });
    const delivery = await recordDelivery({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      labor_admission_id: labor.id,
      delivery_datetime: '2026-06-18T04:15:00.000Z',
      delivery_mode: 'nvd',
      delivered_by: PERFORMER_UID,
      delivered_by_name: 'C2 Atomic Performer',
      pph_diagnosed: true,
      pph_treatment: 'internal treatment detail',
      complications: 'internal complication narrative',
      notes: 'inpatient labour-room narrative',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const pregnancyRows = await prisma.$queryRawUnsafe(
      `SELECT status FROM maternity_pregnancies WHERE id = $1::int`,
      Number(pregnancy.id),
    );
    const laborRows = await prisma.$queryRawUnsafe(
      `SELECT status FROM maternity_labor_admissions WHERE id = $1::int`,
      Number(labor.id),
    );
    expect(pregnancyRows[0].status).toBe('delivered');
    expect(laborRows[0].status).toBe('delivered');
    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: false,
      pregnancy_lmp_date: null,
    });
    expect(String(delivery.delivered_by)).toBe(PERFORMER_UID);

    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.delivery_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'recorded',
      source_table: 'maternity_deliveries',
      source_id: String(delivery.id),
      resource_type: 'delivery',
      resource_id: String(delivery.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      clinical_summary: 'Delivery recorded',
      payload: {
        delivery_id: delivery.id,
        pregnancy_id: pregnancy.id,
        labor_admission_id: labor.id,
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_table: 'maternity_deliveries',
      resource_id: String(delivery.id),
      after_state: {
        pregnancy_status: 'delivered',
        labor_status: 'delivered',
        user_is_pregnant: false,
      },
    });
    const canonicalText = JSON.stringify([timeline[0], audit[0]]);
    expect(canonicalText).not.toContain('internal treatment');
    expect(canonicalText).not.toContain('internal complication');
    expect(canonicalText).not.toContain('inpatient labour-room');
  });

  test('recordDelivery rejects a second delivery for a delivered pregnancy without further writes', async () => {
    const patientUid = await seedUser({ isPregnant: true, lmpDate: '2025-09-15' });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate: '2025-09-15' });
    const firstDelivery = await recordDelivery({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      delivery_datetime: '2026-06-19T04:15:00.000Z',
      delivery_mode: 'nvd',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    await expect(recordDelivery({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      delivery_datetime: '2026-06-19T04:16:00.000Z',
      delivery_mode: 'nvd',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MATERNITY_PREGNANCY_NOT_ONGOING',
    });

    const deliveries = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_deliveries
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(deliveries.map((row) => row.id)).toEqual([firstDelivery.id]);
    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: false,
      pregnancy_lmp_date: null,
    });
    const events = await canonicalRows(patientUid, 'maternity.delivery_recorded');
    expect(events.timeline).toHaveLength(1);
    expect(events.audit).toHaveLength(1);
  });

  test('recordDelivery serializes concurrent attempts and commits only one delivery', async () => {
    const patientUid = await seedUser({ isPregnant: true, lmpDate: '2025-09-16' });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate: '2025-09-16' });
    const deliveryInput = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      delivery_datetime: '2026-06-19T06:15:00.000Z',
      delivery_mode: 'nvd',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };

    const outcomes = await Promise.allSettled([
      recordDelivery(deliveryInput),
      recordDelivery(deliveryInput),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(({ status }) => status === 'rejected').reason).toMatchObject({
      statusCode: 409,
      code: 'MATERNITY_PREGNANCY_NOT_ONGOING',
    });

    const deliveries = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_deliveries
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(deliveries).toHaveLength(1);
    const events = await canonicalRows(patientUid, 'maternity.delivery_recorded');
    expect(events.timeline).toHaveLength(1);
    expect(events.audit).toHaveLength(1);
  });

  test('recordDelivery rejects a non-active labor admission without writing delivery state', async () => {
    const lmpDate = '2025-09-17';
    const patientUid = await seedUser({ isPregnant: true, lmpDate });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate });
    const labor = await seedLabor({ pregnancyId: pregnancy.id });
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_labor_admissions SET status = 'delivered' WHERE id = $1::int`,
      Number(labor.id),
    );

    await expect(recordDelivery({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      labor_admission_id: labor.id,
      delivery_datetime: '2026-06-20T04:15:00.000Z',
      delivery_mode: 'nvd',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MATERNITY_LABOR_NOT_ACTIVE',
    });

    const deliveries = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_deliveries
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    const pregnancyRows = await prisma.$queryRawUnsafe(
      `SELECT status FROM maternity_pregnancies WHERE id = $1::int`,
      Number(pregnancy.id),
    );
    expect(deliveries).toHaveLength(0);
    expect(pregnancyRows[0].status).toBe('ongoing');
    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: true,
      pregnancy_lmp_date: lmpDate,
    });
    const events = await canonicalRows(patientUid, 'maternity.delivery_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('recordDelivery keeps the user projection pregnant when another ongoing pregnancy exists', async () => {
    const patientUid = await seedUser({ isPregnant: true, lmpDate: '2025-08-01' });
    const deliveredPregnancy = await seedPregnancy({
      patientUid,
      lmpDate: '2025-08-01',
      pregnancyNumber: 1,
    });
    await seedPregnancy({
      patientUid,
      lmpDate: '2026-01-12',
      pregnancyNumber: 2,
    });

    await recordDelivery({
      tenantId: TENANT_A,
      pregnancy_id: deliveredPregnancy.id,
      delivery_datetime: '2026-05-15T08:00:00.000Z',
      delivery_mode: 'lscs_elective',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(await patientProjection(patientUid)).toMatchObject({
      is_pregnant: true,
      pregnancy_lmp_date: '2026-01-12',
    });
  });

  test.each([
    ['delivery detail', ({ pregnancyId }) => ({
      table: 'maternity_deliveries', operation: 'INSERT',
      condition: `NEW.pregnancy_id = ${Number(pregnancyId)}`,
    })],
    ['pregnancy transition', ({ pregnancyId }) => ({
      table: 'maternity_pregnancies', operation: 'UPDATE',
      condition: `NEW.id = ${Number(pregnancyId)} AND NEW.status = 'delivered'`,
    })],
    ['labor transition', ({ laborId }) => ({
      table: 'maternity_labor_admissions', operation: 'UPDATE',
      condition: `NEW.id = ${Number(laborId)} AND NEW.status = 'delivered'`,
    })],
    ['user projection', ({ patientUid }) => ({
      table: 'users', operation: 'UPDATE',
      condition: `NEW.uid = '${patientUid}'::uuid AND NEW.is_pregnant IS FALSE`,
    })],
    ['canonical timeline', ({ patientUid }) => ({
      table: 'clinical_timeline_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.delivery_recorded'`,
    })],
    ['clinical audit', ({ patientUid }) => ({
      table: 'clinical_audit_events', operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.delivery_recorded'`,
    })],
  ])('recordDelivery rolls back after injected failure at %s', async (_label, triggerFor) => {
    const lmpDate = '2025-09-21';
    const patientUid = await seedUser({ isPregnant: true, lmpDate });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate });
    const labor = await seedLabor({ pregnancyId: pregnancy.id });
    const removeTrigger = await installFailureTrigger(triggerFor({
      patientUid,
      pregnancyId: pregnancy.id,
      laborId: labor.id,
    }));
    try {
      await expect(recordDelivery({
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        labor_admission_id: labor.id,
        delivery_datetime: '2026-06-22T10:00:00.000Z',
        delivery_mode: 'nvd',
        delivered_by: PERFORMER_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toThrow();
    } finally {
      await removeTrigger();
    }
    await assertDeliveryRolledBack({
      patientUid,
      pregnancyId: pregnancy.id,
      laborId: labor.id,
      lmpDate,
    });
  });

  test('M-B preflights reject cross-tenant and mismatched maternity resources without writes', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const otherPatientUid = await seedUser();
    const mismatchedAdmission = await seedAdmission({ patientUid: otherPatientUid });
    const tenantBPatientUid = await seedUser({ tenantId: TENANT_B });
    const tenantBAdmission = await seedAdmission({
      patientUid: tenantBPatientUid,
      tenantId: TENANT_B,
    });

    await expect(admitToLabor({
      tenantId: TENANT_B,
      pregnancy_id: pregnancy.id,
      attending_obstetrician: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(admitToLabor({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      admission_id: tenantBAdmission.id,
      attending_obstetrician: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(admitToLabor({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      admission_id: mismatchedAdmission.id,
      attending_obstetrician: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 403 });

    const laborAdmissions = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_labor_admissions WHERE pregnancy_id = $1::int`,
      Number(pregnancy.id),
    );
    const admissionEvents = await canonicalRows(patientUid, 'maternity.labor_admission_recorded');
    expect(laborAdmissions).toHaveLength(0);
    expect(admissionEvents.timeline).toHaveLength(0);
    expect(admissionEvents.audit).toHaveLength(0);

    const partographPatientUid = await seedUser();
    const partographPregnancy = await seedPregnancy({ patientUid: partographPatientUid });
    const labor = await seedLabor({ pregnancyId: partographPregnancy.id });
    await expect(recordPartographEntry({
      tenantId: TENANT_B,
      labor_admission_id: labor.id,
      recorded_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });

    const entries = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_partograph_entries WHERE labor_admission_id = $1::int`,
      Number(labor.id),
    );
    const partographEvents = await canonicalRows(
      partographPatientUid,
      'maternity.partograph_entry_recorded',
    );
    expect(entries).toHaveLength(0);
    expect(partographEvents.timeline).toHaveLength(0);
    expect(partographEvents.audit).toHaveLength(0);
  });

  test('tenant preflights reject cross-tenant pregnancy and delivery writes', async () => {
    const patientUid = await seedUser({ isPregnant: true, lmpDate: '2025-10-10' });
    const pregnancy = await seedPregnancy({ patientUid, lmpDate: '2025-10-10' });

    await expect(createPregnancy({
      tenantId: TENANT_B,
      patient_uid: patientUid,
      lmp_date: '2026-02-02',
      created_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordDelivery({
      tenantId: TENANT_B,
      pregnancy_id: pregnancy.id,
      delivery_datetime: '2026-06-25T12:00:00.000Z',
      delivery_mode: 'nvd',
      delivered_by: PERFORMER_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });

    const pregnancyRows = await prisma.$queryRawUnsafe(
      `SELECT status FROM maternity_pregnancies WHERE id = $1::int`,
      Number(pregnancy.id),
    );
    const deliveries = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_deliveries WHERE pregnancy_id = $1::int`,
      Number(pregnancy.id),
    );
    const tenantBEvents = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_B,
      patientUid,
    );
    expect(pregnancyRows[0].status).toBe('ongoing');
    expect(deliveries).toHaveLength(0);
    expect(tenantBEvents).toHaveLength(0);
  });
});
