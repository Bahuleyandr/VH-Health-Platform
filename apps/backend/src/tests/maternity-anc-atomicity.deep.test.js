import { randomUUID } from 'crypto';

import { jest } from '@jest/globals';

import prisma from '../lib/prisma.js';
import {
  maybePropagateAncSupplements,
  recordAncVisit,
  recordFetalKick,
  recordSupplement,
  setSupplementReminder,
} from '../services/maternity/maternityService.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = randomUUID();
const TENANT_B_SLUG = `ma-atomic-${randomUUID().slice(0, 8)}`;
const ACTOR_UID = randomUUID();
const createdUserUids = [];
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9186${String(Date.now()).slice(-7)}${phoneSequence}`;
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
  const functionName = `ma_atomic_fail_${suffix}`;
  const triggerName = `ma_atomic_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'M-A injected failure ${suffix}';
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
  uid = randomUUID(),
  isPregnant = false,
} = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users
       (uid, phone, name, role, is_active, is_pregnant, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5, $6::uuid, NOW())`,
    uid,
    nextPhone(),
    `M-A Atomic ${randomUUID().slice(0, 8)}`,
    role,
    isPregnant,
    tenantId,
  );
  createdUserUids.push(uid);
  return uid;
}

async function seedPregnancy({ patientUid, tenantId = TENANT_A } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-11-01'::date, '2025-11-01'::date + 280,
             'ongoing', $2::uuid, $3::uuid)
     RETURNING *`,
    patientUid,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

async function seedSupplement({ pregnancyId, tenantId = TENANT_A, reminderEnabled = true } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_supplements
       (pregnancy_id, supplement, dose, frequency, route, start_date,
        reminder_enabled, prescribed_by, tenant_id)
     VALUES ($1::int, 'iron', '60 mg', 'once_daily', 'oral', CURRENT_DATE,
             $2, $3::uuid, $4::uuid)
     RETURNING *`,
    Number(pregnancyId),
    reminderEnabled,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

async function canonicalRows(patientUid, eventType) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, event_type, event_subtype, event_status, source_table, source_id,
            resource_type, resource_id, actor_uid, actor_role, occurred_at,
            visible_to_patient, clinical_summary, payload, tags, idempotency_key
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

async function detailCount(table, pregnancyId) {
  const sqlByTable = {
    maternity_anc_visits: `SELECT COUNT(*)::int AS count FROM maternity_anc_visits
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    maternity_supplements: `SELECT COUNT(*)::int AS count FROM maternity_supplements
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
    maternity_fetal_kicks: `SELECT COUNT(*)::int AS count FROM maternity_fetal_kicks
      WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
  };
  const sql = sqlByTable[table];
  if (!sql) throw new Error(`Unsupported detail table: ${table}`);
  const rows = await prisma.$queryRawUnsafe(
    sql,
    TENANT_A,
    Number(pregnancyId),
  );
  return Number(rows[0].count);
}

// Split `<state-fingerprint-base>:tx:<xid8>` revision keys. Every genuine
// mutation must carry a transaction-unique xid8 suffix; the base keeps the
// persisted-state fingerprint so A->B->A revisions share bases 1 and 3.
function splitRevisionKey(key) {
  const marker = String(key).lastIndexOf(':tx:');
  if (marker === -1) return { base: String(key), tx: null };
  return { base: String(key).slice(0, marker), tx: String(key).slice(marker + 4) };
}

function expectRevisionKeySequence(timeline, audit) {
  const timelineKeys = timeline.map(({ idempotency_key }) => splitRevisionKey(idempotency_key));
  const auditKeys = audit.map(({ idempotency_key }) => splitRevisionKey(idempotency_key));
  // Every genuine revision carries a numeric xid8 suffix.
  expect(timelineKeys.every(({ tx }) => tx && /^\d+$/.test(tx))).toBe(true);
  expect(auditKeys.every(({ tx }) => tx && /^\d+$/.test(tx))).toBe(true);
  // Revisions 1 and 3 share the persisted-state hash base but not the xid.
  expect(timelineKeys[0].base).toBe(timelineKeys[2].base);
  expect(timelineKeys[1].base).not.toBe(timelineKeys[0].base);
  expect(timelineKeys[0].tx).not.toBe(timelineKeys[2].tx);
  expect(auditKeys[0].base).toBe(auditKeys[2].base);
  expect(auditKeys[0].tx).not.toBe(auditKeys[2].tx);
  // Timeline and audit rows of one mutation share the same transaction xid.
  expect(auditKeys.map(({ tx }) => tx)).toEqual(timelineKeys.map(({ tx }) => tx));
}

async function tupleVersion(table, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT xmin::text AS xmin, created_at,
            to_jsonb(t) - 'alerts' AS row_state
       FROM ${table} t
      WHERE id = $1::int`,
    Number(id),
  );
  return {
    xmin: rows[0].xmin,
    created_at: new Date(rows[0].created_at).toISOString(),
    row_state: JSON.stringify(rows[0].row_state),
  };
}

async function userProjectionVersion(uid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT xmin::text AS xmin, updated_at, is_pregnant
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    TENANT_A,
    uid,
  );
  return {
    xmin: rows[0].xmin,
    updated_at: new Date(rows[0].updated_at).toISOString(),
    is_pregnant: rows[0].is_pregnant,
  };
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  if (createdUserUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM maternity_pregnancies WHERE patient_uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      createdUserUids,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
  createdUserUids.length = 0;
}

d('M-A ANC, supplement, reminder, and fetal-kick atomic writes', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'M-A Atomic Tenant B')`,
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

  test('ANC visit commits detail, pregnancy projection, staff-only canonical event, and audit together', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const visit = await recordAncVisit({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-14',
      gestational_age_weeks: 27,
      weight_kg: 63.4,
      notes: 'staff-only ANC narrative',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    const users = await prisma.$queryRawUnsafe(
      `SELECT is_pregnant FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_A,
      patientUid,
    );
    expect(users[0].is_pregnant).toBe(true);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      tenant_id: TENANT_A,
      event_status: 'recorded',
      source_table: 'maternity_anc_visits',
      source_id: String(visit.id),
      resource_type: 'anc_visit',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: {
        anc_visit_id: visit.id,
        pregnancy_id: pregnancy.id,
        visit_number: 1,
      },
    });
    expect(JSON.stringify(timeline[0].payload)).not.toContain('staff-only ANC narrative');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      resource_table: 'maternity_anc_visits',
      resource_id: String(visit.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      after_state: { anc_visit_recorded: true, user_is_pregnant: true },
    });
  });

  test('ANC A-to-B-to-A revisions each persist once while exact retries dedupe', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-19',
      weight_kg: 63.4,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };

    await recordAncVisit(input);
    await recordAncVisit(input);
    await recordAncVisit({ ...input, weight_kg: 64.1 });
    await recordAncVisit({ ...input, weight_kg: 64.1 });
    await recordAncVisit(input);
    await recordAncVisit(input);

    const visits = await prisma.$queryRawUnsafe(
      `SELECT id, weight_kg::text AS weight_kg
         FROM maternity_anc_visits
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(visits).toHaveLength(1);
    expect(Number(visits[0].weight_kg)).toBe(63.4);

    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(timeline).toHaveLength(3);
    expect(audit).toHaveLength(3);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expectRevisionKeySequence(timeline, audit);
  });

  test('ANC exact retry leaves the visit tuple and the pregnancy projection untouched', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-21',
      weight_kg: 62.8,
      notes: 'tuple stability baseline',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };
    const visit = await recordAncVisit(input);

    const visitBefore = await tupleVersion('maternity_anc_visits', visit.id);
    const userBefore = await userProjectionVersion(patientUid);
    await recordAncVisit(input);
    const visitAfter = await tupleVersion('maternity_anc_visits', visit.id);
    const userAfter = await userProjectionVersion(patientUid);

    expect(visitAfter.xmin).toBe(visitBefore.xmin);
    expect(visitAfter.row_state).toBe(visitBefore.row_state);
    expect(userAfter.xmin).toBe(userBefore.xmin);
    expect(userAfter.updated_at).toBe(userBefore.updated_at);
    expect(userAfter.is_pregnant).toBe(true);

    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  test('concurrent ANC mutations collapse identical writes and keep distinct writes unique', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-22',
      weight_kg: 63.0,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };
    await recordAncVisit(input);

    await Promise.all([
      recordAncVisit({ ...input, weight_kg: 66.2 }),
      recordAncVisit({ ...input, weight_kg: 66.2 }),
    ]);
    let { timeline, audit } = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(timeline).toHaveLength(2);
    expect(audit).toHaveLength(2);

    await Promise.all([
      recordAncVisit({ ...input, weight_kg: 67.3 }),
      recordAncVisit({ ...input, weight_kg: 68.4 }),
    ]);
    ({ timeline, audit } = await canonicalRows(patientUid, 'maternity.anc_visit_recorded'));
    expect(timeline).toHaveLength(4);
    expect(audit).toHaveLength(4);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    const timelineTx = timeline.map(({ idempotency_key }) => splitRevisionKey(idempotency_key).tx);
    const auditTx = audit.map(({ idempotency_key }) => splitRevisionKey(idempotency_key).tx);
    expect(new Set(timelineTx)).toEqual(new Set(auditTx));

    const visits = await prisma.$queryRawUnsafe(
      `SELECT weight_kg::text AS weight_kg
         FROM maternity_anc_visits
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(visits).toHaveLength(1);
    expect([67.3, 68.4]).toContain(Number(visits[0].weight_kg));
  });

  test('ANC visit and pregnancy projection roll back when canonical timeline persistence fails', async () => {
    const patientUid = await seedUser();
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.anc_visit_recorded'`,
    });

    await expect(recordAncVisit({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-15',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_anc_visits', pregnancy.id)).toBe(0);
    const users = await prisma.$queryRawUnsafe(
      `SELECT is_pregnant FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      TENANT_A,
      patientUid,
    );
    expect(users[0].is_pregnant).toBe(false);
    const events = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('ANC mutation rejects a pregnancy from another tenant without writing detail or canonical rows', async () => {
    const patientUid = await seedUser({ tenantId: TENANT_B });
    const pregnancy = await seedPregnancy({ patientUid, tenantId: TENANT_B });

    await expect(recordAncVisit({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      visit_date: '2026-05-16',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_anc_visits WHERE pregnancy_id = $1::int`,
      Number(pregnancy.id),
    );
    expect(rows).toHaveLength(0);
    const events = await canonicalRows(patientUid, 'maternity.anc_visit_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('supplement create, distinct updates, and retries preserve exact canonical coverage', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement: 'iron',
      dose: '60 mg',
      frequency: 'once_daily',
      start_date: '2026-05-17',
      notes: 'staff-only supplement narrative',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };
    const first = await recordSupplement(input);
    const tupleBefore = await tupleVersion('maternity_supplements', first.id);
    const second = await recordSupplement(input);
    const tupleAfterRetry = await tupleVersion('maternity_supplements', first.id);
    await recordSupplement({ ...input, dose: '90 mg' });
    await recordSupplement({ ...input, dose: '90 mg' });
    const fourth = await recordSupplement(input);
    const fifth = await recordSupplement(input);

    expect(second.id).toBe(first.id);
    expect(second.continued).toBe(true);
    expect(tupleAfterRetry.xmin).toBe(tupleBefore.xmin);
    expect(tupleAfterRetry.row_state).toBe(tupleBefore.row_state);
    expect(fourth.id).toBe(first.id);
    expect(fifth.id).toBe(first.id);
    expect(String(fifth.dose)).toBe('60 mg');
    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      event_status: 'recorded',
      source_id: String(first.id),
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: {
        supplement_id: first.id,
        pregnancy_id: pregnancy.id,
        supplement: 'iron',
        frequency: 'once_daily',
        continued: false,
      },
    });
    expect(JSON.stringify(timeline[0].payload)).not.toContain('staff-only supplement narrative');
    expect(timeline.filter(({ event_status }) => event_status === 'continued')).toHaveLength(2);
    expect(timeline.map(({ payload }) => payload.continued)).toEqual([false, true, true]);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expect(audit).toHaveLength(3);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expectRevisionKeySequence(timeline, audit);
  });

  test('concurrent supplement updates collapse identical writes and keep distinct writes unique', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement: 'iron',
      dose: '60 mg',
      frequency: 'once_daily',
      start_date: '2026-05-17',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    };
    await recordSupplement(input);

    await Promise.all([
      recordSupplement({ ...input, dose: '120 mg' }),
      recordSupplement({ ...input, dose: '120 mg' }),
    ]);
    let { timeline, audit } = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(timeline).toHaveLength(2);
    expect(audit).toHaveLength(2);

    await Promise.all([
      recordSupplement({ ...input, dose: '150 mg' }),
      recordSupplement({ ...input, dose: '180 mg' }),
    ]);
    ({ timeline, audit } = await canonicalRows(patientUid, 'maternity.supplement_recorded'));
    expect(timeline).toHaveLength(4);
    expect(audit).toHaveLength(4);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(1);
    const stored = await prisma.$queryRawUnsafe(
      `SELECT dose FROM maternity_supplements
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect(['150 mg', '180 mg']).toContain(stored[0].dose);
  });

  test('supplement detail and timeline roll back when clinical audit persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_audit_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.supplement_recorded'`,
    });

    await expect(recordSupplement({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement: 'calcium',
      dose: '500 mg',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(0);
    const events = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('prescription propagation commits each new supplement with canonical coverage and is retry-safe', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      patient_uid: patientUid,
      medications: [{ name: 'Iron with Folic Acid', dose: '60 mg', frequency: 'OD' }],
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'DOCTOR',
    };
    const first = await maybePropagateAncSupplements(input);
    const second = await maybePropagateAncSupplements(input);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      event_subtype: 'prescription_propagated',
      actor_uid: ACTOR_UID,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: expect.objectContaining({
        pregnancy_id: pregnancy.id,
        supplement: 'iron',
        source_kind: 'prescription',
      }),
    });
    expect(audit).toHaveLength(1);
  });

  test('prescription propagation rolls back detail when canonical persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.supplement_recorded'`,
    });

    await expect(maybePropagateAncSupplements({
      tenantId: TENANT_A,
      patient_uid: patientUid,
      medications: [{ name: 'Calcium 500mg', frequency: 'BD' }],
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'DOCTOR',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_supplements', pregnancy.id)).toBe(0);
    const events = await canonicalRows(patientUid, 'maternity.supplement_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('patient reminder preference writes one staff-only canonical pair and exact actor provenance', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement_id: supplement.id,
      reminder_enabled: false,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    };
    const first = await setSupplementReminder(input);
    const tupleBefore = await tupleVersion('maternity_supplements', supplement.id);
    const second = await setSupplementReminder(input);
    const tupleAfterRetry = await tupleVersion('maternity_supplements', supplement.id);
    const third = await setSupplementReminder({ ...input, reminder_enabled: true });
    const thirdRetry = await setSupplementReminder({ ...input, reminder_enabled: true });
    const fourth = await setSupplementReminder(input);
    const fifth = await setSupplementReminder(input);

    expect(first.reminder_enabled).toBe(false);
    expect(second.id).toBe(first.id);
    expect(tupleAfterRetry.xmin).toBe(tupleBefore.xmin);
    expect(tupleAfterRetry.row_state).toBe(tupleBefore.row_state);
    expect(third.reminder_enabled).toBe(true);
    expect(thirdRetry.reminder_enabled).toBe(true);
    expect(fourth.id).toBe(first.id);
    expect(fourth.reminder_enabled).toBe(false);
    expect(fifth.id).toBe(first.id);
    expect(fifth.reminder_enabled).toBe(false);
    const { timeline, audit } = await canonicalRows(
      patientUid,
      'maternity.supplement_reminder_updated',
    );
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      event_status: 'disabled',
      actor_uid: patientUid,
      actor_role: 'PATIENT',
      visible_to_patient: false,
      payload: {
        supplement_id: supplement.id,
        pregnancy_id: pregnancy.id,
        reminder_enabled: false,
      },
    });
    expect(timeline.map(({ event_status }) => event_status)).toEqual(['disabled', 'enabled', 'disabled']);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expect(audit).toHaveLength(3);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expectRevisionKeySequence(timeline, audit);
  });

  test('concurrent reminder toggles never collide on canonical revision keys', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement_id: supplement.id,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    };
    await setSupplementReminder({ ...input, reminder_enabled: false });

    // Concurrent identical toggles collapse to exactly one revision pair.
    await Promise.all([
      setSupplementReminder({ ...input, reminder_enabled: true }),
      setSupplementReminder({ ...input, reminder_enabled: true }),
    ]);
    let { timeline, audit } = await canonicalRows(
      patientUid,
      'maternity.supplement_reminder_updated',
    );
    expect(timeline).toHaveLength(2);
    expect(audit).toHaveLength(2);

    // A boolean surface cannot make opposing concurrent writes both genuine
    // in a fixed order, so assert coherence rather than a fixed count: keys
    // stay unique and the newest revision matches the persisted state.
    await Promise.all([
      setSupplementReminder({ ...input, reminder_enabled: false }),
      setSupplementReminder({ ...input, reminder_enabled: true }),
    ]);
    ({ timeline, audit } = await canonicalRows(
      patientUid,
      'maternity.supplement_reminder_updated',
    ));
    expect(timeline.length).toBeGreaterThanOrEqual(3);
    expect(timeline.length).toBeLessThanOrEqual(4);
    expect(audit.length).toBe(timeline.length);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key)))
      .toHaveProperty('size', timeline.length);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key)))
      .toHaveProperty('size', audit.length);
    const stored = await prisma.$queryRawUnsafe(
      `SELECT reminder_enabled FROM maternity_supplements WHERE id = $1::int`,
      Number(supplement.id),
    );
    // Order-free coherence: from the enabled state, a lone genuine phase-2
    // write can only be the disable (an enable would no-op), so 3 total
    // revisions imply final disabled; 4 revisions mean disable-then-enable
    // both landed, so the persisted state must be enabled.
    expect(stored[0].reminder_enabled).toBe(timeline.length === 4);
  });

  test('reminder preference update rolls back when canonical audit persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_audit_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.action = 'maternity.supplement_reminder_updated'`,
    });

    await expect(setSupplementReminder({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement_id: supplement.id,
      reminder_enabled: false,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    })).rejects.toBeTruthy();
    await removeTrigger();

    const rows = await prisma.$queryRawUnsafe(
      `SELECT reminder_enabled FROM maternity_supplements WHERE id = $1::int`,
      Number(supplement.id),
    );
    expect(rows[0].reminder_enabled).toBe(true);
    const events = await canonicalRows(patientUid, 'maternity.supplement_reminder_updated');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });

  test('patient fetal-kick input is unverified, patient-generated, staff-only, and retry-safe', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      log_date: '2026-05-18',
      kick_count: 8,
      observation_window_minutes: 720,
      notes: 'patient narrative must stay out of canonical payload',
      recorded_by: patientUid,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    };
    const first = await recordFetalKick(input);
    const tupleBefore = await tupleVersion('maternity_fetal_kicks', first.id);
    const second = await recordFetalKick(input);
    const tupleAfterRetry = await tupleVersion('maternity_fetal_kicks', first.id);
    await recordFetalKick({ ...input, kick_count: 9 });
    await recordFetalKick({ ...input, kick_count: 9 });
    const fourth = await recordFetalKick(input);
    const fifth = await recordFetalKick(input);

    expect(second.id).toBe(first.id);
    expect(tupleAfterRetry.xmin).toBe(tupleBefore.xmin);
    expect(tupleAfterRetry.row_state).toBe(tupleBefore.row_state);
    expect(fourth.id).toBe(first.id);
    expect(fifth.id).toBe(first.id);
    expect(Number(fifth.kick_count)).toBe(8);
    expect(await detailCount('maternity_fetal_kicks', pregnancy.id)).toBe(1);
    const { timeline, audit } = await canonicalRows(patientUid, 'maternity.fetal_kick_recorded');
    expect(timeline).toHaveLength(3);
    expect(timeline[0]).toMatchObject({
      event_status: 'unverified',
      actor_uid: patientUid,
      actor_role: 'PATIENT',
      visible_to_patient: false,
      clinical_summary: 'Patient-generated fetal kick count recorded — unverified',
      payload: {
        fetal_kick_id: first.id,
        pregnancy_id: pregnancy.id,
        kick_count: 8,
        observation_window_minutes: 720,
        source_kind: 'patient_generated',
        verification_status: 'unverified',
      },
    });
    expect(timeline[0].tags).toEqual(expect.arrayContaining(['patient_generated', 'unverified']));
    expect(JSON.stringify(timeline[0].payload)).not.toContain('patient narrative');
    expect(timeline.map(({ payload }) => payload.kick_count)).toEqual([8, 9, 8]);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expect(audit).toHaveLength(3);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    expectRevisionKeySequence(timeline, audit);
    expect(audit[0].after_state).toEqual({
      kick_count: 8,
      low_count_flag: true,
      verification_status: 'unverified',
    });
  });

  test('concurrent fetal-kick writes collapse identical entries and keep distinct entries unique', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const input = {
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      log_date: '2026-05-20',
      kick_count: 8,
      observation_window_minutes: 720,
      recorded_by: patientUid,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    };
    await recordFetalKick(input);

    await Promise.all([
      recordFetalKick({ ...input, kick_count: 11 }),
      recordFetalKick({ ...input, kick_count: 11 }),
    ]);
    let { timeline, audit } = await canonicalRows(patientUid, 'maternity.fetal_kick_recorded');
    expect(timeline).toHaveLength(2);
    expect(audit).toHaveLength(2);

    await Promise.all([
      recordFetalKick({ ...input, kick_count: 12 }),
      recordFetalKick({ ...input, kick_count: 13 }),
    ]);
    ({ timeline, audit } = await canonicalRows(patientUid, 'maternity.fetal_kick_recorded'));
    expect(timeline).toHaveLength(4);
    expect(audit).toHaveLength(4);
    expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 4);
    expect(await detailCount('maternity_fetal_kicks', pregnancy.id)).toBe(1);
    const stored = await prisma.$queryRawUnsafe(
      `SELECT kick_count FROM maternity_fetal_kicks
        WHERE tenant_id = $1::uuid AND pregnancy_id = $2::int`,
      TENANT_A,
      Number(pregnancy.id),
    );
    expect([12, 13]).toContain(Number(stored[0].kick_count));
  });

  test('supplement, reminder, and fetal-kick mutations reject a pregnancy from another tenant', async () => {
    const patientUid = await seedUser({ tenantId: TENANT_B });
    const pregnancy = await seedPregnancy({ patientUid, tenantId: TENANT_B });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id, tenantId: TENANT_B });

    await expect(recordSupplement({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement: 'calcium',
      dose: '500 mg',
      prescribed_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(setSupplementReminder({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      supplement_id: supplement.id,
      reminder_enabled: false,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordFetalKick({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      log_date: '2026-05-21',
      kick_count: 9,
      recorded_by: patientUid,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    })).rejects.toMatchObject({ statusCode: 404 });

    const supplements = await prisma.$queryRawUnsafe(
      `SELECT id, reminder_enabled FROM maternity_supplements WHERE pregnancy_id = $1::int`,
      Number(pregnancy.id),
    );
    expect(supplements).toHaveLength(1);
    expect(supplements[0].reminder_enabled).toBe(true);
    const kicks = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_fetal_kicks WHERE pregnancy_id = $1::int`,
      Number(pregnancy.id),
    );
    expect(kicks).toHaveLength(0);
    for (const eventType of [
      'maternity.supplement_recorded',
      'maternity.supplement_reminder_updated',
      'maternity.fetal_kick_recorded',
    ]) {
      const events = await canonicalRows(patientUid, eventType);
      expect(events.timeline).toHaveLength(0);
      expect(events.audit).toHaveLength(0);
    }
  });

  test('a frozen JS clock still yields distinct genuine canonical revisions', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const supplement = await seedSupplement({ pregnancyId: pregnancy.id });

    jest.useFakeTimers({
      now: new Date('2026-07-14T10:00:00.000Z'),
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask',
        'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback',
        'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval',
        'setTimeout', 'clearTimeout',
      ],
    });
    try {
      expect(Date.now()).toBe(new Date('2026-07-14T10:00:00.000Z').getTime());

      const ancInput = {
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        visit_date: '2026-05-23',
        weight_kg: 63.4,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      };
      await recordAncVisit(ancInput);
      await recordAncVisit({ ...ancInput, weight_kg: 64.1 });
      await recordAncVisit(ancInput);

      const supplementInput = {
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        supplement: 'calcium',
        dose: '500 mg',
        frequency: 'once_daily',
        start_date: '2026-05-23',
        prescribed_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      };
      await recordSupplement(supplementInput);
      await recordSupplement({ ...supplementInput, dose: '750 mg' });
      await recordSupplement(supplementInput);

      const reminderInput = {
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        supplement_id: supplement.id,
        actor_uid: patientUid,
        actor_role: 'PATIENT',
      };
      await setSupplementReminder({ ...reminderInput, reminder_enabled: false });
      await setSupplementReminder({ ...reminderInput, reminder_enabled: true });
      await setSupplementReminder({ ...reminderInput, reminder_enabled: false });

      const kickInput = {
        tenantId: TENANT_A,
        pregnancy_id: pregnancy.id,
        log_date: '2026-05-23',
        kick_count: 8,
        observation_window_minutes: 720,
        recorded_by: patientUid,
        actor_uid: patientUid,
        actor_role: 'PATIENT',
      };
      await recordFetalKick(kickInput);
      await recordFetalKick({ ...kickInput, kick_count: 9 });
      await recordFetalKick(kickInput);
    } finally {
      jest.useRealTimers();
    }

    for (const eventType of [
      'maternity.anc_visit_recorded',
      'maternity.supplement_recorded',
      'maternity.supplement_reminder_updated',
      'maternity.fetal_kick_recorded',
    ]) {
      const { timeline, audit } = await canonicalRows(patientUid, eventType);
      expect(timeline).toHaveLength(3);
      expect(audit).toHaveLength(3);
      expect(new Set(timeline.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
      expect(new Set(audit.map(({ idempotency_key }) => idempotency_key))).toHaveProperty('size', 3);
    }
  });

  test('fetal-kick detail rolls back when canonical timeline persistence fails', async () => {
    const patientUid = await seedUser({ isPregnant: true });
    const pregnancy = await seedPregnancy({ patientUid });
    const removeTrigger = await installFailureTrigger({
      table: 'clinical_timeline_events',
      operation: 'INSERT',
      condition: `NEW.patient_uid = '${patientUid}'::uuid AND NEW.event_type = 'maternity.fetal_kick_recorded'`,
    });

    await expect(recordFetalKick({
      tenantId: TENANT_A,
      pregnancy_id: pregnancy.id,
      log_date: '2026-05-19',
      kick_count: 12,
      recorded_by: patientUid,
      actor_uid: patientUid,
      actor_role: 'PATIENT',
    })).rejects.toBeTruthy();
    await removeTrigger();

    expect(await detailCount('maternity_fetal_kicks', pregnancy.id)).toBe(0);
    const events = await canonicalRows(patientUid, 'maternity.fetal_kick_recorded');
    expect(events.timeline).toHaveLength(0);
    expect(events.audit).toHaveLength(0);
  });
});
