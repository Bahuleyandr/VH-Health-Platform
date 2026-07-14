import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import {
  recordApgar,
  recordNewborn,
  recordPostnatalVisit,
} from '../services/maternity/maternityService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = randomUUID();
const TENANT_B_SLUG = `mc-atomic-${randomUUID().slice(0, 8)}`;
const ACTOR_UID = randomUUID();
const createdUserUids = [];
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9185${String(Date.now()).slice(-7)}${phoneSequence}`;
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
  const functionName = `mc_atomic_fail_${suffix}`;
  const triggerName = `mc_atomic_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'M-C injected failure ${suffix}';
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

async function seedUser({ tenantId = TENANT_A, role = 'PATIENT', uid = randomUUID() } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
    uid,
    nextPhone(),
    `M-C Atomic ${randomUUID().slice(0, 8)}`,
    role,
    tenantId,
  );
  createdUserUids.push(uid);
  return uid;
}

async function seedDelivery({ patientUid, tenantId = TENANT_A } = {}) {
  const pregnancies = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-10-01'::date, '2025-10-01'::date + 280,
             'delivered', $2::uuid, $3::uuid)
     RETURNING *`,
    patientUid,
    ACTOR_UID,
    tenantId,
  );
  const deliveries = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries
       (pregnancy_id, delivery_datetime, delivery_mode, delivered_by, tenant_id)
     VALUES ($1::int, '2026-07-08T05:30:00.000Z'::timestamptz, 'nvd', $2::uuid, $3::uuid)
     RETURNING *`,
    Number(pregnancies[0].id),
    ACTOR_UID,
    tenantId,
  );
  return { pregnancy: pregnancies[0], delivery: deliveries[0] };
}

async function seedNewborn({
  deliveryId,
  tenantId = TENANT_A,
  newbornPatientUid = null,
  birthOrder = 1,
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_order, birth_datetime, outcome,
        newborn_patient_uid, recorded_by, tenant_id)
     VALUES ($1::int, $2::int, '2026-07-08T05:31:00.000Z'::timestamptz, 'live',
             $3::uuid, $4::uuid, $5::uuid)
     RETURNING *`,
    Number(deliveryId),
    Number(birthOrder),
    newbornPatientUid,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

async function canonicalRows(patientUid, eventType) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, patient_uid, event_type, event_status, source_table, source_id,
            resource_type, resource_id, actor_uid, actor_role, occurred_at,
            visible_to_patient, clinical_summary, payload, tags, idempotency_key
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
      ORDER BY created_at, id`,
    patientUid,
    eventType,
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
            resource_type, resource_table, resource_id, after_state, metadata,
            idempotency_key
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
      ORDER BY created_at, id`,
    patientUid,
    eventType,
  );
  return { timeline, audit };
}

async function detailCount(table, foreignKey, id) {
  const sqlByTable = {
    maternity_newborns: `SELECT COUNT(*)::int AS count FROM maternity_newborns
      WHERE tenant_id = $1::uuid AND delivery_id = $2::int`,
    maternity_apgar_scores: `SELECT COUNT(*)::int AS count FROM maternity_apgar_scores
      WHERE tenant_id = $1::uuid AND newborn_id = $2::int`,
    maternity_postnatal_visits: `SELECT COUNT(*)::int AS count FROM maternity_postnatal_visits
      WHERE tenant_id = $1::uuid AND delivery_id = $2::int`,
  };
  const expectedForeignKey = {
    maternity_newborns: 'delivery_id',
    maternity_apgar_scores: 'newborn_id',
    maternity_postnatal_visits: 'delivery_id',
  }[table];
  if (!sqlByTable[table] || foreignKey !== expectedForeignKey) {
    throw new Error(`Unsupported detail counter: ${table}.${foreignKey}`);
  }
  const rows = await prisma.$queryRawUnsafe(sqlByTable[table], TENANT_A, Number(id));
  return Number(rows[0].count);
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  const uids = [...new Set([ACTOR_UID, ...createdUserUids])];
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
    uids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
    uids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[])`,
    uids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    uids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
  createdUserUids.length = 0;
}

d('M-C newborn, Apgar, and postnatal atomic writes', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'M-C Atomic Tenant B')`,
      TENANT_B,
      TENANT_B_SLUG,
    );
    await seedUser({ uid: ACTOR_UID, role: 'NURSING_STAFF' });
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('recordNewborn commits detail and a minimal staff-only pair on a unique persisted infant identity', async () => {
    const motherUid = await seedUser();
    const infantUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const usersBefore = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM users WHERE tenant_id = $1::uuid`,
      TENANT_A,
    );

    const newborn = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: delivery.id,
      birth_order: 1,
      birth_datetime: '2026-07-08T05:31:00.000Z',
      sex: 'female',
      birth_weight_g: 3120,
      outcome: 'live',
      resuscitation_done: true,
      resuscitation_type: 'MC_PRIVATE_RESUSCITATION',
      newborn_patient_uid: infantUid,
      congenital_anomaly: true,
      congenital_anomaly_desc: 'MC_PRIVATE_ANOMALY_NARRATIVE',
      notes: 'MC_PRIVATE_NEWBORN_NOTES',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const usersAfter = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM users WHERE tenant_id = $1::uuid`,
      TENANT_A,
    );
    expect(usersAfter[0].count).toBe(usersBefore[0].count);
    expect(newborn.newborn_patient_uid).toBe(infantUid);
    expect(newborn.resuscitation_type).toBe('MC_PRIVATE_RESUSCITATION');
    expect(newborn.congenital_anomaly_desc).toBe('MC_PRIVATE_ANOMALY_NARRATIVE');
    expect(newborn.notes).toBe('MC_PRIVATE_NEWBORN_NOTES');

    const { timeline, audit } = await canonicalRows(infantUid, 'maternity.newborn_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: infantUid,
      event_status: 'recorded',
      source_table: 'maternity_newborns',
      source_id: String(newborn.id),
      resource_type: 'newborn_record',
      resource_id: String(newborn.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      clinical_summary: 'Newborn record documented',
      payload: {
        newborn_id: newborn.id,
        delivery_id: delivery.id,
        birth_order: 1,
      },
      idempotency_key: `maternity_newborns:${newborn.id}:recorded`,
    });
    expect(timeline[0].payload).toEqual({
      newborn_id: newborn.id,
      delivery_id: delivery.id,
      birth_order: 1,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: infantUid,
      action_status: 'success',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_type: 'newborn_record',
      resource_table: 'maternity_newborns',
      resource_id: String(newborn.id),
      after_state: { newborn_recorded: true },
      idempotency_key: `maternity_newborns:${newborn.id}:audit:recorded`,
    });
    const canonicalText = JSON.stringify([
      timeline[0].payload,
      audit[0].after_state,
      audit[0].metadata,
    ]);
    for (const excluded of [
      'MC_PRIVATE_RESUSCITATION',
      'MC_PRIVATE_ANOMALY_NARRATIVE',
      'MC_PRIVATE_NEWBORN_NOTES',
      'resuscitation',
      'congenital',
      'notes',
      'newborn_patient_uid',
    ]) {
      expect(canonicalText).not.toContain(excluded);
    }
    const maternalEvents = await canonicalRows(motherUid, 'maternity.newborn_recorded');
    expect(maternalEvents.timeline).toHaveLength(0);
    expect(maternalEvents.audit).toHaveLength(0);
  });

  test('recordNewborn falls back to the maternal patient when no infant identity is persisted', async () => {
    const motherUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const newborn = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: delivery.id,
      birth_datetime: '2026-07-08T05:32:00.000Z',
      outcome: 'live',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(newborn.newborn_patient_uid).toBeNull();
    const events = await canonicalRows(motherUid, 'maternity.newborn_recorded');
    expect(events.timeline).toHaveLength(1);
    expect(events.audit).toHaveLength(1);
  });

  test.each([
    ['canonical timeline', 'clinical_timeline_events', 'maternity.newborn_recorded'],
    ['clinical audit', 'clinical_audit_events', 'maternity.newborn_recorded'],
  ])('recordNewborn rolls back detail at %s and a clean retry persists one pair', async (
    _label,
    table,
    action,
  ) => {
    const motherUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const condition = table === 'clinical_timeline_events'
      ? `NEW.patient_uid = '${motherUid}'::uuid AND NEW.event_type = '${action}'`
      : `NEW.patient_uid = '${motherUid}'::uuid AND NEW.action = '${action}'`;
    const removeTrigger = await installFailureTrigger({ table, operation: 'INSERT', condition });
    const input = {
      tenantId: TENANT_A,
      delivery_id: delivery.id,
      birth_datetime: '2026-07-08T05:33:00.000Z',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };

    await expect(recordNewborn(input)).rejects.toBeTruthy();
    await removeTrigger();
    expect(await detailCount('maternity_newborns', 'delivery_id', delivery.id)).toBe(0);
    let events = await canonicalRows(motherUid, action);
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);

    await recordNewborn(input);
    expect(await detailCount('maternity_newborns', 'delivery_id', delivery.id)).toBe(1);
    events = await canonicalRows(motherUid, action);
    expect(events.timeline).toHaveLength(1);
    expect(events.audit).toHaveLength(1);
  });

  test('Apgar exact retries dedupe canonical pairs while changed scores create a new revision', async () => {
    const motherUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const newborn = await seedNewborn({ deliveryId: delivery.id });
    const input = {
      tenantId: TENANT_A,
      newborn_id: newborn.id,
      time_minute: 5,
      appearance: 1,
      pulse: 2,
      grimace: 1,
      activity: 2,
      respiration: 2,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };

    const first = await recordApgar(input);
    const second = await recordApgar(input);
    const third = await recordApgar({ ...input, grimace: 2 });
    const fourth = await recordApgar({ ...input, grimace: 2 });

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(fourth.id).toBe(first.id);
    expect(await detailCount('maternity_apgar_scores', 'newborn_id', newborn.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(motherUid, 'maternity.apgar_recorded');
    expect(timeline).toHaveLength(2);
    expect(timeline.map(({ payload }) => payload.total_score).sort()).toEqual([8, 9]);
    expect(timeline.every((row) => row.visible_to_patient === false)).toBe(true);
    expect(timeline.every((row) => row.actor_uid === ACTOR_UID)).toBe(true);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 2);
    expect(audit).toHaveLength(2);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 2);
    expect(timeline[0].payload).toEqual({
      apgar_score_id: first.id,
      newborn_id: newborn.id,
      time_minute: 5,
      total_score: expect.any(Number),
    });
  });

  test.each([
    ['canonical timeline', 'clinical_timeline_events', 'event_type'],
    ['clinical audit', 'clinical_audit_events', 'action'],
  ])('recordApgar rolls back its UPSERT at %s', async (_label, table, discriminator) => {
    const motherUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const newborn = await seedNewborn({ deliveryId: delivery.id });
    const condition = `NEW.patient_uid = '${motherUid}'::uuid AND NEW.${discriminator} = 'maternity.apgar_recorded'`;
    const removeTrigger = await installFailureTrigger({ table, operation: 'INSERT', condition });

    await expect(recordApgar({
      tenantId: TENANT_A,
      newborn_id: newborn.id,
      time_minute: 1,
      appearance: 2,
      pulse: 2,
      grimace: 2,
      activity: 2,
      respiration: 2,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_apgar_scores', 'newborn_id', newborn.id)).toBe(0);
    const events = await canonicalRows(motherUid, 'maternity.apgar_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test.each([
    ['canonical timeline', 'clinical_timeline_events', 'event_type'],
    ['clinical audit', 'clinical_audit_events', 'action'],
  ])('recordApgar rolls back an UPDATE and its new pair at %s', async (
    _label,
    table,
    discriminator,
  ) => {
    const motherUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const newborn = await seedNewborn({ deliveryId: delivery.id });
    const input = {
      tenantId: TENANT_A,
      newborn_id: newborn.id,
      time_minute: 5,
      appearance: 1,
      pulse: 1,
      grimace: 1,
      activity: 1,
      respiration: 1,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };
    const initial = await recordApgar(input);
    const condition = `NEW.patient_uid = '${motherUid}'::uuid AND NEW.${discriminator} = 'maternity.apgar_recorded'`;
    const removeTrigger = await installFailureTrigger({ table, operation: 'INSERT', condition });

    await expect(recordApgar({ ...input, pulse: 2 })).rejects.toBeTruthy();
    await removeTrigger();

    const persisted = await prisma.$queryRawUnsafe(
      `SELECT id, appearance, pulse, grimace, activity, respiration, total_score
         FROM maternity_apgar_scores
        WHERE tenant_id = $1::uuid AND newborn_id = $2::int AND time_minute = 5`,
      TENANT_A,
      Number(newborn.id),
    );
    expect(persisted).toEqual([expect.objectContaining({
      id: initial.id,
      appearance: 1,
      pulse: 1,
      grimace: 1,
      activity: 1,
      respiration: 1,
      total_score: 5,
    })]);
    const events = await canonicalRows(motherUid, 'maternity.apgar_recorded');
    expect(events.timeline).toHaveLength(1);
    expect(events.timeline[0].payload.total_score).toBe(5);
    expect(events.audit).toHaveLength(1);
    expect(events.audit[0].after_state).toEqual({ total_score: 5 });
  });

  test('ambiguous infant links fall back to the maternal patient for Apgar and postnatal events', async () => {
    const motherUid = await seedUser();
    const infantUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const firstNewborn = await seedNewborn({
      deliveryId: delivery.id,
      newbornPatientUid: infantUid,
      birthOrder: 1,
    });
    await seedNewborn({
      deliveryId: delivery.id,
      newbornPatientUid: infantUid,
      birthOrder: 2,
    });

    await recordApgar({
      tenantId: TENANT_A,
      newborn_id: firstNewborn.id,
      time_minute: 1,
      appearance: 2,
      pulse: 2,
      grimace: 2,
      activity: 2,
      respiration: 2,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    await recordPostnatalVisit({
      tenantId: TENANT_A,
      delivery_id: delivery.id,
      newborn_id: firstNewborn.id,
      visit_kind: 'baby',
      visit_at: '2026-07-09T06:00:00.000Z',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const maternalApgar = await canonicalRows(motherUid, 'maternity.apgar_recorded');
    const infantApgar = await canonicalRows(infantUid, 'maternity.apgar_recorded');
    const maternalPostnatal = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
    const infantPostnatal = await canonicalRows(infantUid, 'maternity.postnatal_visit_recorded');
    expect(maternalApgar.timeline).toHaveLength(1);
    expect(maternalApgar.audit).toHaveLength(1);
    expect(infantApgar.timeline).toHaveLength(0);
    expect(infantApgar.audit).toHaveLength(0);
    expect(maternalPostnatal.timeline).toHaveLength(1);
    expect(maternalPostnatal.audit).toHaveLength(1);
    expect(infantPostnatal.timeline).toHaveLength(0);
    expect(infantPostnatal.audit).toHaveLength(0);
  });

  test.each([
    ['missing patient identity', false],
    ['patient identity from another tenant', true],
  ])('a %s link falls back to the maternal patient', async (_label, createForeignPatient) => {
    const motherUid = await seedUser();
    const linkedUid = randomUUID();
    if (createForeignPatient) {
      await seedUser({ tenantId: TENANT_B, uid: linkedUid });
    }
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const newborn = await seedNewborn({
      deliveryId: delivery.id,
      newbornPatientUid: linkedUid,
    });

    await recordApgar({
      tenantId: TENANT_A,
      newborn_id: newborn.id,
      time_minute: 1,
      appearance: 2,
      pulse: 2,
      grimace: 2,
      activity: 2,
      respiration: 2,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const maternalEvents = await canonicalRows(motherUid, 'maternity.apgar_recorded');
    const linkedEvents = await canonicalRows(linkedUid, 'maternity.apgar_recorded');
    expect(maternalEvents.timeline).toHaveLength(1);
    expect(maternalEvents.audit).toHaveLength(1);
    expect(linkedEvents.timeline).toHaveLength(0);
    expect(linkedEvents.audit).toHaveLength(0);
  });

  test('postnatal detail keeps clinical content while the staff-only canonical pair stays minimal', async () => {
    const motherUid = await seedUser();
    const infantUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const newborn = await seedNewborn({
      deliveryId: delivery.id,
      newbornPatientUid: infantUid,
    });
    const visit = await recordPostnatalVisit({
      tenantId: TENANT_A,
      delivery_id: delivery.id,
      newborn_id: newborn.id,
      visit_kind: 'both',
      visit_at: '2026-07-09T06:30:00.000Z',
      mother_temp_c: 38.1,
      mother_bp_systolic: 145,
      mother_bp_diastolic: 92,
      baby_temperature_c: 37.8,
      red_flags: ['MC_PRIVATE_RED_FLAG'],
      notes: 'MC_PRIVATE_POSTNATAL_NARRATIVE',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(visit.red_flags).toEqual(['MC_PRIVATE_RED_FLAG']);
    expect(visit.notes).toBe('MC_PRIVATE_POSTNATAL_NARRATIVE');
    const { timeline, audit } = await canonicalRows(
      infantUid,
      'maternity.postnatal_visit_recorded',
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      patient_uid: infantUid,
      event_status: 'recorded',
      source_table: 'maternity_postnatal_visits',
      source_id: String(visit.id),
      resource_type: 'postnatal_visit',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: {
        postnatal_visit_id: visit.id,
        delivery_id: delivery.id,
        newborn_id: newborn.id,
        visit_kind: 'both',
      },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      patient_uid: infantUid,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      resource_table: 'maternity_postnatal_visits',
      resource_id: String(visit.id),
      after_state: {
        postnatal_visit_recorded: true,
        visit_kind: 'both',
      },
    });
    const canonicalText = JSON.stringify([
      timeline[0].payload,
      audit[0].after_state,
      audit[0].metadata,
    ]);
    for (const excluded of [
      'MC_PRIVATE_RED_FLAG',
      'MC_PRIVATE_POSTNATAL_NARRATIVE',
      'red_flags',
      'notes',
      'mother_temp_c',
      'baby_temperature_c',
    ]) {
      expect(canonicalText).not.toContain(excluded);
    }
  });

  test.each([
    ['canonical timeline', 'clinical_timeline_events', 'event_type'],
    ['clinical audit', 'clinical_audit_events', 'action'],
  ])('recordPostnatalVisit rolls back detail at %s and can be retried cleanly', async (
    _label,
    table,
    discriminator,
  ) => {
    const motherUid = await seedUser();
    const { delivery } = await seedDelivery({ patientUid: motherUid });
    const condition = `NEW.patient_uid = '${motherUid}'::uuid AND NEW.${discriminator} = 'maternity.postnatal_visit_recorded'`;
    const removeTrigger = await installFailureTrigger({ table, operation: 'INSERT', condition });
    const input = {
      tenantId: TENANT_A,
      delivery_id: delivery.id,
      visit_kind: 'mother',
      visit_at: '2026-07-09T07:00:00.000Z',
      red_flags: ['MC_PRIVATE_RETRY_FLAG'],
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };

    await expect(recordPostnatalVisit(input)).rejects.toBeTruthy();
    await removeTrigger();
    expect(await detailCount('maternity_postnatal_visits', 'delivery_id', delivery.id)).toBe(0);
    let events = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);

    await recordPostnatalVisit(input);
    expect(await detailCount('maternity_postnatal_visits', 'delivery_id', delivery.id)).toBe(1);
    events = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
    expect(events.timeline).toHaveLength(1);
    expect(events.audit).toHaveLength(1);
  });

  test('tenant and delivery preflights reject foreign resources without detail or events', async () => {
    const tenantBPatientUid = await seedUser({ tenantId: TENANT_B });
    const { delivery: tenantBDelivery } = await seedDelivery({
      patientUid: tenantBPatientUid,
      tenantId: TENANT_B,
    });
    const tenantBNewborn = await seedNewborn({
      deliveryId: tenantBDelivery.id,
      tenantId: TENANT_B,
    });

    await expect(recordNewborn({
      tenantId: TENANT_A,
      delivery_id: tenantBDelivery.id,
      birth_datetime: '2026-07-08T08:00:00.000Z',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordApgar({
      tenantId: TENANT_A,
      newborn_id: tenantBNewborn.id,
      time_minute: 1,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordPostnatalVisit({
      tenantId: TENANT_A,
      delivery_id: tenantBDelivery.id,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });

    const motherUid = await seedUser();
    const first = await seedDelivery({ patientUid: motherUid });
    const second = await seedDelivery({ patientUid: motherUid });
    const firstNewborn = await seedNewborn({ deliveryId: first.delivery.id });
    await expect(recordPostnatalVisit({
      tenantId: TENANT_A,
      delivery_id: second.delivery.id,
      newborn_id: firstNewborn.id,
      visit_kind: 'baby',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 403 });

    const tenantBEvents = await Promise.all([
      canonicalRows(tenantBPatientUid, 'maternity.newborn_recorded'),
      canonicalRows(tenantBPatientUid, 'maternity.apgar_recorded'),
      canonicalRows(tenantBPatientUid, 'maternity.postnatal_visit_recorded'),
    ]);
    expect(tenantBEvents.every(({ timeline, audit }) => !timeline.length && !audit.length)).toBe(true);
    expect(await detailCount('maternity_postnatal_visits', 'delivery_id', second.delivery.id)).toBe(0);
  });
});
