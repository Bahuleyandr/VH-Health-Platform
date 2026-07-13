import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import {
  createPregnancy,
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

async function seedLabor({ pregnancyId, tenantId = TENANT_A } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_labor_admissions
       (pregnancy_id, admission_reason, status, attending_obstetrician, tenant_id)
     VALUES ($1::int, 'spontaneous_labour', 'active', $2::uuid, $3::uuid)
     RETURNING *`,
    Number(pregnancyId),
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
  });

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
