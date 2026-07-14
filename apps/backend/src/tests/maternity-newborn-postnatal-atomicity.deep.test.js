// D7 M-C rework — newborn/Apgar/postnatal canonical events under the SIGNED
// contract (decision record obgyn-d7-decision-record.md, SHA-256
// E82EEC9A054CA3708A31F48568818BB27F9986D8F5A02C37AF9407F4D5DB9562).
//
// REPRO/INVERSION PROVENANCE: the pre-D7 frozen WIP (checkpoint commit
// 17c6b30c7, preserved verbatim in this branch's provenance) proved the OLD
// behaviour of this file's subjects:
//   - a 'both' postnatal visit emitted ONE canonical pair on a single
//     "unique infant else mother" subject;
//   - Apgar/postnatal events for a missing, ambiguous, or foreign infant
//     identity FELL BACK to the mother's patient record.
// Those assertions INVERT here by design:
//   - B-i DUAL PAIRS: a 'both' visit writes ONE detail row and TWO canonical
//     pairs — a maternal event carrying ONLY maternal facts and an infant
//     event carrying ONLY infant facts (strict per-subject payload
//     separation; F-n1 keeps shared notes/red-flags detail-row-only).
//   - Infant-scope subjects are the newborn's OWN identity (S-2 FULL scope),
//     validated by the signed E-3 predicate + E-c1 re-check in-transaction;
//     absent/invalid identity REJECTS fail-closed (409) — no mother
//     fallback, no proxy writes (mirrors R1's immunisation hardening).
//   - F-1: a 'both' (and 'baby') visit without a linked newborn is rejected.
//   - B-2/B-r1: stillbirth newborns have no identity -> infant-scope writes
//     reject; early_neonatal_death newborns HAVE identity and their events
//     attribute to it.
//   - Apgar rows are amendable (UPSERT) -> #589 fingerprint + `:tx:<xid8>`
//     keys behind an effective-state no-op guard (exact retry = pure no-op;
//     A -> B -> A keeps three distinct revision keys).
// recordNewborn's canonical pair is owned by R1's Shape-3 build and is
// covered by maternity-birth-identity.deep.test.js — not re-tested here.

import { randomUUID } from 'crypto';

import pg from 'pg';

import prisma from '../lib/prisma.js';
import {
  recordApgar,
  recordNewborn,
  recordPostnatalVisit,
} from '../services/maternity/maternityService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACTOR_UID = randomUUID();
const installedTriggers = [];
let phoneSequence = 0;

const APGAR_KEY_RE = /^maternity_apgar_scores:\d+:[0-9a-f]{32}:tx:\d+$/;
const APGAR_AUDIT_KEY_RE = /^maternity_apgar_scores:\d+:audit:[0-9a-f]{32}:tx:\d+$/;

function nextPhone() {
  phoneSequence += 1;
  return `+9186${String(Date.now()).slice(-7)}${phoneSequence}`;
}

function apgarKeyParts(key) {
  const match = String(key).match(/^maternity_apgar_scores:(\d+):(?:audit:)?([0-9a-f]{32}):tx:(\d+)$/);
  if (!match) throw new Error(`Unexpected Apgar idempotency key shape: ${key}`);
  return { id: match[1], fingerprint: match[2], tx: match[3] };
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

async function installFailureTrigger({ table, condition }) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `r2_mc_fail_${suffix}`;
  const triggerName = `r2_mc_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };

  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'R2 M-C injected failure ${suffix}';
         END IF;
         RETURN NEW;
       END;
       $$`,
  );
  try {
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${triggerName}
         AFTER INSERT ON ${table}
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
  tenantId = TENANT_A, role = 'PATIENT', name = null, isActive = true,
} = {}) {
  const uid = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, NOW())`,
    uid,
    nextPhone(),
    name || `R2 MC ${role} ${uid.slice(0, 8)}`,
    role,
    isActive,
    tenantId,
  );
  return uid;
}

async function seedDelivery({ tenantId = TENANT_A, motherName = null } = {}) {
  const motherUid = await seedUser({ tenantId, name: motherName });
  const pregnancies = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-10-01'::date, '2026-07-08'::date, 'delivered', $2::uuid, $3::uuid)
     RETURNING *`,
    motherUid,
    ACTOR_UID,
    tenantId,
  );
  const deliveries = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries
       (pregnancy_id, delivery_datetime, delivery_mode, delivered_by, tenant_id)
     VALUES ($1::int, '2026-07-08T05:30:00Z'::timestamptz, 'nvd', $2::uuid, $3::uuid)
     RETURNING *`,
    Number(pregnancies[0].id),
    ACTOR_UID,
    tenantId,
  );
  return { motherUid, pregnancy: pregnancies[0], delivery: deliveries[0] };
}

// Direct SQL newborn row with a CONTROLLABLE identity link — the vehicle for
// signed-invalid states (identity-less, mother-linked, foreign-linked rows)
// that the post-R1 product path can no longer create.
async function seedNewbornRow({
  deliveryId, tenantId = TENANT_A, linkedPatientUid = null, birthOrder = 1, outcome = 'live',
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_order, birth_datetime, outcome,
        newborn_patient_uid, recorded_by, tenant_id)
     VALUES ($1::int, $2::int, '2026-07-08T05:31:00Z'::timestamptz, $3,
             $4::uuid, $5::uuid, $6::uuid)
     RETURNING *`,
    Number(deliveryId),
    Number(birthOrder),
    outcome,
    linkedPatientUid,
    ACTOR_UID,
    tenantId,
  );
  return rows[0];
}

// Product-path newborn (R1's Shape-3 atomic minting) — the signed way to a
// VALID infant identity, including B-2 outcome semantics.
async function recordNewbornViaProduct({ deliveryId, birthOrder = 1, outcome = 'live' }) {
  return recordNewborn({
    tenantId: TENANT_A,
    delivery_id: deliveryId,
    birth_order: birthOrder,
    birth_datetime: new Date('2026-07-08T05:31:00.000Z'),
    sex: 'female',
    outcome,
    recorded_by: ACTOR_UID,
    actor_uid: ACTOR_UID,
    actor_role: 'NURSING_STAFF',
  });
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

async function apgarCount(newbornId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM maternity_apgar_scores WHERE newborn_id = $1::int`,
    Number(newbornId),
  );
  return Number(rows[0].count);
}

async function postnatalCount(deliveryId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM maternity_postnatal_visits
      WHERE delivery_id = $1::int`,
    Number(deliveryId),
  );
  return Number(rows[0].count);
}

function expectZeroEvents(events) {
  expect(events.timeline).toHaveLength(0);
  expect(events.audit).toHaveLength(0);
}

async function cleanup() {
  for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  for (const tenantId of [TENANT_A, TENANT_B]) {
    for (const sql of [
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`,
      `DELETE FROM patient_consents WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_apgar_scores WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_postnatal_visits WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_newborns WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_deliveries WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_pregnancies WHERE tenant_id = $1::uuid`,
      `DELETE FROM patient_merge_requests WHERE tenant_id = $1::uuid`,
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
    ]) {
      await prisma.$executeRawUnsafe(sql, tenantId).catch(() => {});
    }
    await prisma
      .$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId)
      .catch(() => {});
  }
}

d('D7 M-C — Apgar and postnatal canonical events under the signed contract', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'R2 MC Tenant A'),
              ($3::uuid, $4, 'R2 MC Tenant B')`,
      TENANT_A, `r2mc-a-${TENANT_A.slice(0, 8)}`,
      TENANT_B, `r2mc-b-${TENANT_B.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'R2 MC Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      ACTOR_UID, nextPhone(), TENANT_A,
    );
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) await dropFailureTrigger(entry);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 30_000);

  describe('Apgar — infant subject + #589 revision keys', () => {
    test('events attribute to the INFANT identity with fingerprint+tx keys; the mother gets nothing', async () => {
      const { motherUid, delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);

      const apgar = await recordApgar({
        tenantId: TENANT_A,
        newborn_id: newborn.id,
        time_minute: 1,
        appearance: 1,
        pulse: 2,
        grimace: 1,
        activity: 2,
        respiration: 2,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });

      expect(Number(apgar.total_score)).toBe(8);
      expect(await apgarCount(newborn.id)).toBe(1);

      const { timeline, audit } = await canonicalRows(infantUid, 'maternity.apgar_recorded');
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({
        tenant_id: TENANT_A,
        patient_uid: infantUid,
        event_status: 'recorded',
        source_table: 'maternity_apgar_scores',
        source_id: String(apgar.id),
        resource_type: 'apgar_score',
        resource_id: String(apgar.id),
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
        visible_to_patient: false,
        clinical_summary: 'Apgar score recorded',
      });
      expect(timeline[0].payload).toEqual({
        apgar_score_id: apgar.id,
        newborn_id: newborn.id,
        time_minute: 1,
        total_score: 8,
      });
      expect(timeline[0].idempotency_key).toMatch(APGAR_KEY_RE);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        patient_uid: infantUid,
        action_status: 'success',
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
        resource_table: 'maternity_apgar_scores',
        resource_id: String(apgar.id),
        after_state: { total_score: 8 },
      });
      expect(audit[0].idempotency_key).toMatch(APGAR_AUDIT_KEY_RE);

      // INVERSION of the frozen assertion set: the mother is NOT the subject.
      expectZeroEvents(await canonicalRows(motherUid, 'maternity.apgar_recorded'));
    });

    test('exact retry is a pure no-op; amended scores allocate one revision; A->B->A keeps three distinct keys', async () => {
      const { delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);
      const inputA = {
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
      const inputB = { ...inputA, grimace: 2 };

      const first = await recordApgar(inputA);
      const retryA = await recordApgar(inputA);
      // Effective-state guard: the retry returned BEFORE the UPSERT — same
      // row, recorded_at not re-stamped.
      expect(retryA.id).toBe(first.id);
      expect(new Date(retryA.recorded_at).toISOString())
        .toBe(new Date(first.recorded_at).toISOString());

      const second = await recordApgar(inputB);
      const retryB = await recordApgar(inputB);
      const third = await recordApgar(inputA); // A -> B -> A

      expect(second.id).toBe(first.id);
      expect(retryB.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(await apgarCount(newborn.id)).toBe(1);

      const { timeline, audit } = await canonicalRows(infantUid, 'maternity.apgar_recorded');
      expect(timeline).toHaveLength(3);
      expect(audit).toHaveLength(3);
      expect(timeline.map(({ payload }) => payload.total_score)).toEqual([8, 9, 8]);

      const keys = timeline.map(({ idempotency_key: key }) => key);
      expect(new Set(keys).size).toBe(3);
      for (const key of keys) expect(key).toMatch(APGAR_KEY_RE);
      const [revA1, revB, revA2] = keys.map(apgarKeyParts);
      // The state fingerprint is stable across the return to state A; the
      // xid8 suffix is what keeps the third revision from being absorbed.
      expect(revA2.fingerprint).toBe(revA1.fingerprint);
      expect(revB.fingerprint).not.toBe(revA1.fingerprint);
      expect(new Set([revA1.tx, revB.tx, revA2.tx]).size).toBe(3);
      expect(new Set(audit.map(({ idempotency_key: key }) => key)).size).toBe(3);
    }, 30_000);

    test.each([
      ['absent identity link', 'NEWBORN_IDENTITY_REQUIRED', null,
        async () => {
          const { motherUid, delivery } = await seedDelivery();
          const newborn = await seedNewbornRow({ deliveryId: delivery.id, linkedPatientUid: null });
          return { newborn, motherUid, subjectUid: null };
        }],
      ['inactive infant identity', 'NEWBORN_IDENTITY_INVALID', 'inactive',
        async () => {
          const infantUid = await seedUser({ isActive: false });
          const { motherUid, delivery } = await seedDelivery();
          const newborn = await seedNewbornRow({ deliveryId: delivery.id, linkedPatientUid: infantUid });
          return { newborn, motherUid, subjectUid: infantUid };
        }],
      ['soft-deleted infant identity', 'NEWBORN_IDENTITY_INVALID', 'deleted',
        async () => {
          const infantUid = await seedUser();
          const { motherUid, delivery } = await seedDelivery();
          const newborn = await seedNewbornRow({ deliveryId: delivery.id, linkedPatientUid: infantUid });
          await prisma.$executeRawUnsafe(
            `UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE uid = $1::uuid`,
            infantUid,
          );
          return { newborn, motherUid, subjectUid: infantUid };
        }],
      ['merged-away infant identity', 'NEWBORN_IDENTITY_INVALID', 'merged_away',
        async () => {
          const infantUid = await seedUser();
          const mergeTarget = await seedUser();
          const { motherUid, delivery } = await seedDelivery();
          const newborn = await seedNewbornRow({ deliveryId: delivery.id, linkedPatientUid: infantUid });
          await prisma.$executeRawUnsafe(
            `INSERT INTO patient_merge_requests
               (tenant_id, primary_uid, secondary_uid, status, executed_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'executed', NOW())`,
            TENANT_A, mergeTarget, infantUid,
          );
          return { newborn, motherUid, subjectUid: infantUid };
        }],
      ['mother-as-link (E-3 mother-exclusion arm)', 'NEWBORN_IDENTITY_INVALID', 'mother_identity',
        async () => {
          const { motherUid, delivery } = await seedDelivery();
          const newborn = await seedNewbornRow({ deliveryId: delivery.id, linkedPatientUid: motherUid });
          return { newborn, motherUid, subjectUid: motherUid };
        }],
      ['cross-tenant infant identity', 'NEWBORN_IDENTITY_INVALID', 'not_found',
        async () => {
          const foreignUid = await seedUser({ tenantId: TENANT_B });
          const { motherUid, delivery } = await seedDelivery();
          const newborn = await seedNewbornRow({ deliveryId: delivery.id, linkedPatientUid: foreignUid });
          return { newborn, motherUid, subjectUid: foreignUid };
        }],
    ])('INVERTED: %s REJECTS the Apgar write — no mother attribution, zero writes', async (
      _label,
      expectedCode,
      expectedReason,
      seedCase,
    ) => {
      const { newborn, motherUid, subjectUid } = await seedCase();

      const expectation = { statusCode: 409, code: expectedCode };
      if (expectedReason) expectation.details = { reason: expectedReason };
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
      })).rejects.toMatchObject(expectation);

      expect(await apgarCount(newborn.id)).toBe(0);
      expectZeroEvents(await canonicalRows(motherUid, 'maternity.apgar_recorded'));
      if (subjectUid) {
        expectZeroEvents(await canonicalRows(subjectUid, 'maternity.apgar_recorded'));
      }
    }, 30_000);

    test('B-2/B-r1 outcome gating: stillbirth rejects (no identity); early_neonatal_death attributes to its own identity', async () => {
      // Product-path stillbirth: NO identity is minted (B-2).
      const stillbirthCase = await seedDelivery();
      const stillborn = await recordNewbornViaProduct({
        deliveryId: stillbirthCase.delivery.id,
        outcome: 'fresh_stillbirth',
      });
      expect(stillborn.newborn_patient_uid).toBeNull();
      await expect(recordApgar({
        tenantId: TENANT_A,
        newborn_id: stillborn.id,
        time_minute: 1,
        appearance: 0,
        pulse: 0,
        grimace: 0,
        activity: 0,
        respiration: 0,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 409, code: 'NEWBORN_IDENTITY_REQUIRED' });
      expect(await apgarCount(stillborn.id)).toBe(0);
      expectZeroEvents(await canonicalRows(stillbirthCase.motherUid, 'maternity.apgar_recorded'));

      // Belt-and-braces: a stillbirth row that somehow CARRIES an identity
      // (impossible via product code post-R1) still rejects on outcome.
      const carrierUid = await seedUser();
      await prisma.$executeRawUnsafe(
        `UPDATE maternity_newborns SET newborn_patient_uid = $1::uuid WHERE id = $2::int`,
        carrierUid, Number(stillborn.id),
      );
      await expect(recordApgar({
        tenantId: TENANT_A,
        newborn_id: stillborn.id,
        time_minute: 1,
        appearance: 0,
        pulse: 0,
        grimace: 0,
        activity: 0,
        respiration: 0,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NEWBORN_IDENTITY_INVALID',
        details: { reason: 'identity_forbidden_for_outcome' },
      });
      expect(await apgarCount(stillborn.id)).toBe(0);

      // B-r1: a baby who lived and died within the early neonatal window HAS
      // an identity, and their events attribute to it.
      const endCase = await seedDelivery();
      const endNewborn = await recordNewbornViaProduct({
        deliveryId: endCase.delivery.id,
        outcome: 'early_neonatal_death',
      });
      const endUid = String(endNewborn.newborn_patient_uid);
      expect(endNewborn.minted_identity).toBeTruthy();
      const endApgar = await recordApgar({
        tenantId: TENANT_A,
        newborn_id: endNewborn.id,
        time_minute: 1,
        appearance: 1,
        pulse: 1,
        grimace: 0,
        activity: 1,
        respiration: 1,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });
      expect(Number(endApgar.total_score)).toBe(4);
      const endEvents = await canonicalRows(endUid, 'maternity.apgar_recorded');
      expect(endEvents.timeline).toHaveLength(1);
      expect(endEvents.audit).toHaveLength(1);
      expectZeroEvents(await canonicalRows(endCase.motherUid, 'maternity.apgar_recorded'));
    }, 30_000);

    test.each([
      ['canonical timeline', 'clinical_timeline_events', 'event_type'],
      ['clinical audit', 'clinical_audit_events', 'action'],
    ])('atomic rollback at %s: fresh UPSERT and amendment both roll back with their pair', async (
      _label,
      table,
      discriminator,
    ) => {
      const { delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);
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
      const condition = `NEW.patient_uid = '${infantUid}'::uuid AND NEW.${discriminator} = 'maternity.apgar_recorded'`;

      // Fresh-insert path.
      let removeTrigger = await installFailureTrigger({ table, condition });
      await expect(recordApgar(input)).rejects.toBeTruthy();
      await removeTrigger();
      expect(await apgarCount(newborn.id)).toBe(0);
      expectZeroEvents(await canonicalRows(infantUid, 'maternity.apgar_recorded'));

      // Clean write, then an amendment that fails at the canonical insert:
      // the detail UPDATE rolls back with it.
      const initial = await recordApgar(input);
      removeTrigger = await installFailureTrigger({ table, condition });
      await expect(recordApgar({ ...input, pulse: 2 })).rejects.toBeTruthy();
      await removeTrigger();

      const persisted = await prisma.$queryRawUnsafe(
        `SELECT id, appearance, pulse, grimace, activity, respiration, total_score
           FROM maternity_apgar_scores
          WHERE newborn_id = $1::int AND time_minute = 5`,
        Number(newborn.id),
      );
      expect(persisted).toEqual([expect.objectContaining({
        id: initial.id,
        pulse: 1,
        total_score: 5,
      })]);
      const events = await canonicalRows(infantUid, 'maternity.apgar_recorded');
      expect(events.timeline).toHaveLength(1);
      expect(events.timeline[0].payload.total_score).toBe(5);
      expect(events.audit).toHaveLength(1);
    }, 30_000);

    test('E-c1: an identity invalidated AFTER preflight is caught by the in-tx re-check under the users row lock', async () => {
      const { motherUid, delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);

      const client = new pg.Client({ connectionString: CONNECTION_STRING });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE uid = $1`,
          [infantUid],
        );

        const attempt = recordApgar({
          tenantId: TENANT_A,
          newborn_id: newborn.id,
          time_minute: 10,
          appearance: 2,
          pulse: 2,
          grimace: 2,
          activity: 2,
          respiration: 2,
          recorded_by: ACTOR_UID,
          actor_uid: ACTOR_UID,
          actor_role: 'NURSING_STAFF',
        });
        const commitSoon = (async () => {
          await new Promise((resolve) => { setTimeout(resolve, 400); });
          await client.query('COMMIT');
        })();

        await expect(attempt).rejects.toMatchObject({
          statusCode: 409,
          code: 'NEWBORN_IDENTITY_INVALID',
          details: { reason: 'deleted' },
        });
        await commitSoon;

        expect(await apgarCount(newborn.id)).toBe(0);
        expectZeroEvents(await canonicalRows(infantUid, 'maternity.apgar_recorded'));
        expectZeroEvents(await canonicalRows(motherUid, 'maternity.apgar_recorded'));
      } finally {
        await client.end().catch(() => {});
      }
    }, 30_000);
  });

  describe('Postnatal visits — B-i dual pairs, F-1, per-subject payload separation', () => {
    test('mother-only visit: ONE maternal pair, no newborn required, infant untouched even when linked', async () => {
      const { motherUid, delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);

      const visit = await recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        newborn_id: newborn.id, // linkage allowed; scope still decides subjects
        visit_kind: 'mother',
        visit_at: new Date('2026-07-10T06:00:00.000Z'),
        mother_temp_c: 37.4,
        mother_pulse_bpm: 84,
        uterine_involution: 'normal',
        lochia: 'rubra',
        red_flags: ['MC_PRIVATE_MOTHER_FLAG'],
        notes: 'MC_PRIVATE_MOTHER_NOTES',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });

      expect(visit.visit_kind).toBe('mother');
      expect(visit.notes).toBe('MC_PRIVATE_MOTHER_NOTES');
      const maternal = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
      expect(maternal.timeline).toHaveLength(1);
      expect(maternal.audit).toHaveLength(1);
      expect(maternal.timeline[0].idempotency_key)
        .toBe(`maternity_postnatal_visits:${visit.id}:mother:recorded`);
      expect(maternal.audit[0].idempotency_key)
        .toBe(`maternity_postnatal_visits:${visit.id}:mother:audit:recorded`);
      expect(maternal.timeline[0].payload).toEqual({
        postnatal_visit_id: visit.id,
        delivery_id: delivery.id,
        visit_kind: 'mother',
        subject_scope: 'mother',
        mother_temp_c: 37.4,
        mother_pulse_bpm: 84,
        mother_bp_systolic: null,
        mother_bp_diastolic: null,
        uterine_involution: 'normal',
        lochia: 'rubra',
        perineum_status: null,
        breastfeeding_status: null,
      });
      // F-n1: shared free text stays detail-row-only.
      const canonicalText = JSON.stringify([
        maternal.timeline[0].payload,
        maternal.audit[0].after_state,
        maternal.audit[0].metadata,
      ]);
      for (const excluded of ['MC_PRIVATE_MOTHER_FLAG', 'MC_PRIVATE_MOTHER_NOTES', 'red_flags', 'notes', 'baby_']) {
        expect(canonicalText).not.toContain(excluded);
      }
      expectZeroEvents(await canonicalRows(infantUid, 'maternity.postnatal_visit_recorded'));
    });

    test('INVERTED: a both visit writes ONE detail row and TWO canonical pairs with strict per-subject payloads', async () => {
      const { motherUid, delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);

      const visit = await recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        newborn_id: newborn.id,
        visit_kind: 'both',
        visit_at: new Date('2026-07-11T06:30:00.000Z'),
        mother_temp_c: 38.1,
        mother_pulse_bpm: 96,
        mother_bp_systolic: 145,
        mother_bp_diastolic: 92,
        uterine_involution: 'sub_involution',
        lochia: 'foul',
        perineum_status: 'healing',
        breastfeeding_status: 'exclusive',
        baby_weight_g: 3100,
        baby_temperature_c: 37.2,
        baby_feeding: 'breast',
        baby_jaundice: 'mild',
        baby_passed_meconium: true,
        baby_passed_urine: true,
        baby_cord_status: 'healthy',
        red_flags: ['MC_PRIVATE_RED_FLAG'],
        notes: 'MC_PRIVATE_POSTNATAL_NARRATIVE',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });

      expect(await postnatalCount(delivery.id)).toBe(1);
      expect(visit.red_flags).toEqual(['MC_PRIVATE_RED_FLAG']);
      expect(visit.notes).toBe('MC_PRIVATE_POSTNATAL_NARRATIVE');

      const maternal = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
      const infant = await canonicalRows(infantUid, 'maternity.postnatal_visit_recorded');

      // The frozen WIP asserted ONE infant-only pair here; the signed B-i
      // rule is exactly two pairs — one per subject — over one detail row.
      expect(maternal.timeline).toHaveLength(1);
      expect(maternal.audit).toHaveLength(1);
      expect(infant.timeline).toHaveLength(1);
      expect(infant.audit).toHaveLength(1);
      expect(maternal.timeline[0].source_id).toBe(String(visit.id));
      expect(infant.timeline[0].source_id).toBe(String(visit.id));

      // Maternal event: ONLY maternal facts.
      expect(maternal.timeline[0]).toMatchObject({
        patient_uid: motherUid,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
        visible_to_patient: false,
        clinical_summary: 'Postnatal visit recorded (mother)',
      });
      expect(maternal.timeline[0].payload).toEqual({
        postnatal_visit_id: visit.id,
        delivery_id: delivery.id,
        visit_kind: 'both',
        subject_scope: 'mother',
        mother_temp_c: 38.1,
        mother_pulse_bpm: 96,
        mother_bp_systolic: 145,
        mother_bp_diastolic: 92,
        uterine_involution: 'sub_involution',
        lochia: 'foul',
        perineum_status: 'healing',
        breastfeeding_status: 'exclusive',
      });
      expect(maternal.timeline[0].idempotency_key)
        .toBe(`maternity_postnatal_visits:${visit.id}:mother:recorded`);
      expect(maternal.audit[0].idempotency_key)
        .toBe(`maternity_postnatal_visits:${visit.id}:mother:audit:recorded`);
      expect(maternal.audit[0].after_state).toEqual({
        postnatal_visit_recorded: true,
        visit_kind: 'both',
        subject_scope: 'mother',
      });

      // Infant event: ONLY infant facts, on the infant's own identity.
      expect(infant.timeline[0]).toMatchObject({
        patient_uid: infantUid,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
        visible_to_patient: false,
        clinical_summary: 'Postnatal visit recorded (baby)',
      });
      expect(infant.timeline[0].payload).toEqual({
        postnatal_visit_id: visit.id,
        delivery_id: delivery.id,
        visit_kind: 'both',
        subject_scope: 'infant',
        newborn_id: newborn.id,
        baby_weight_g: 3100,
        baby_temperature_c: 37.2,
        baby_feeding: 'breast',
        baby_jaundice: 'mild',
        baby_passed_meconium: true,
        baby_passed_urine: true,
        baby_cord_status: 'healthy',
      });
      expect(infant.timeline[0].idempotency_key)
        .toBe(`maternity_postnatal_visits:${visit.id}:infant:recorded`);
      expect(infant.audit[0].idempotency_key)
        .toBe(`maternity_postnatal_visits:${visit.id}:infant:audit:recorded`);
      expect(infant.audit[0].after_state).toEqual({
        postnatal_visit_recorded: true,
        visit_kind: 'both',
        subject_scope: 'infant',
      });

      // Strict separation, proven by string sweep on the full canonical
      // surface of each pair: maternal facts absent from the infant side,
      // infant facts absent from the maternal side, shared free text
      // (notes/red-flags) in NEITHER (F-n1).
      const maternalText = JSON.stringify([
        maternal.timeline[0].payload,
        maternal.audit[0].after_state,
        maternal.audit[0].metadata,
      ]);
      const infantText = JSON.stringify([
        infant.timeline[0].payload,
        infant.audit[0].after_state,
        infant.audit[0].metadata,
      ]);
      const sharedSecrets = ['MC_PRIVATE_RED_FLAG', 'MC_PRIVATE_POSTNATAL_NARRATIVE', 'red_flags', 'notes'];
      const infantFacts = ['baby_weight_g', 'baby_temperature_c', 'baby_feeding', 'baby_jaundice',
        'baby_passed_meconium', 'baby_passed_urine', 'baby_cord_status'];
      const maternalFacts = ['mother_temp_c', 'mother_pulse_bpm', 'mother_bp_systolic', 'mother_bp_diastolic',
        'uterine_involution', 'lochia', 'perineum_status', 'breastfeeding_status'];
      for (const excluded of [...sharedSecrets, ...infantFacts]) {
        expect(maternalText).not.toContain(excluded);
      }
      for (const excluded of [...sharedSecrets, ...maternalFacts]) {
        expect(infantText).not.toContain(excluded);
      }
    });

    test.each([
      ['both'],
      ['baby'],
    ])('F-1: a %s visit without a linked newborn is REJECTED with zero writes', async (visitKind) => {
      const { motherUid, delivery } = await seedDelivery();
      await recordNewbornViaProduct({ deliveryId: delivery.id }); // baby exists; staff still must LINK it

      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        visit_kind: visitKind,
        visit_at: new Date('2026-07-11T07:00:00.000Z'),
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'MATERNITY_POSTNATAL_NEWBORN_LINK_REQUIRED',
      });

      expect(await postnatalCount(delivery.id)).toBe(0);
      expectZeroEvents(await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded'));
    });

    test('invalid visit_kind is rejected with a clean 400 before any write', async () => {
      const { motherUid, delivery } = await seedDelivery();
      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        visit_kind: 'family',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 400 });
      expect(await postnatalCount(delivery.id)).toBe(0);
      expectZeroEvents(await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded'));
    });

    test('INVERTED: infant-scope visits with absent or mother-linked identities REJECT — no maternal fallback pair', async () => {
      // Absent identity (identity-less SQL row — the pre-R1 shape).
      const absentCase = await seedDelivery();
      const absentNewborn = await seedNewbornRow({
        deliveryId: absentCase.delivery.id, linkedPatientUid: null,
      });
      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: absentCase.delivery.id,
        newborn_id: absentNewborn.id,
        visit_kind: 'both',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 409, code: 'NEWBORN_IDENTITY_REQUIRED' });
      expect(await postnatalCount(absentCase.delivery.id)).toBe(0);
      expectZeroEvents(await canonicalRows(absentCase.motherUid, 'maternity.postnatal_visit_recorded'));

      // Mother-as-link (E-3 mother-exclusion arm) on a baby-only visit.
      const motherLinkCase = await seedDelivery();
      const motherLinked = await seedNewbornRow({
        deliveryId: motherLinkCase.delivery.id,
        linkedPatientUid: motherLinkCase.motherUid,
      });
      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: motherLinkCase.delivery.id,
        newborn_id: motherLinked.id,
        visit_kind: 'baby',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NEWBORN_IDENTITY_INVALID',
        details: { reason: 'mother_identity' },
      });
      expect(await postnatalCount(motherLinkCase.delivery.id)).toBe(0);
      expectZeroEvents(
        await canonicalRows(motherLinkCase.motherUid, 'maternity.postnatal_visit_recorded'),
      );
    }, 30_000);

    test.each([
      ['maternal timeline (first pair)', 'clinical_timeline_events', 'event_type', 'mother'],
      ['maternal audit (first pair)', 'clinical_audit_events', 'action', 'mother'],
      ['infant timeline (SECOND pair)', 'clinical_timeline_events', 'event_type', 'infant'],
      ['infant audit (SECOND pair)', 'clinical_audit_events', 'action', 'infant'],
    ])('atomic dual-pair rollback: failure at the %s rolls back the detail row and BOTH pairs', async (
      _label,
      table,
      discriminator,
      failingScope,
    ) => {
      const { motherUid, delivery } = await seedDelivery();
      const newborn = await recordNewbornViaProduct({ deliveryId: delivery.id });
      const infantUid = String(newborn.newborn_patient_uid);
      const failingUid = failingScope === 'mother' ? motherUid : infantUid;
      const condition = `NEW.patient_uid = '${failingUid}'::uuid AND NEW.${discriminator} = 'maternity.postnatal_visit_recorded'`;
      const removeTrigger = await installFailureTrigger({ table, condition });
      const input = {
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        newborn_id: newborn.id,
        visit_kind: 'both',
        visit_at: new Date('2026-07-11T08:00:00.000Z'),
        mother_temp_c: 37.0,
        baby_temperature_c: 37.1,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      };

      await expect(recordPostnatalVisit(input)).rejects.toBeTruthy();
      await removeTrigger();

      // Everything rolled back together: no detail row, and NEITHER subject
      // keeps a pair (in the SECOND-pair cases this proves the already-
      // written maternal pair was rolled back too).
      expect(await postnatalCount(delivery.id)).toBe(0);
      expectZeroEvents(await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded'));
      expectZeroEvents(await canonicalRows(infantUid, 'maternity.postnatal_visit_recorded'));

      // A clean retry lands the full contract: one detail row, two pairs.
      const visit = await recordPostnatalVisit(input);
      expect(await postnatalCount(delivery.id)).toBe(1);
      const maternal = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
      const infant = await canonicalRows(infantUid, 'maternity.postnatal_visit_recorded');
      expect(maternal.timeline).toHaveLength(1);
      expect(maternal.audit).toHaveLength(1);
      expect(infant.timeline).toHaveLength(1);
      expect(infant.audit).toHaveLength(1);
      expect(maternal.timeline[0].source_id).toBe(String(visit.id));
      expect(infant.timeline[0].source_id).toBe(String(visit.id));
    }, 30_000);

    test('F-t1 twins: one visit per infant on distinct identities; a cross-delivery newborn link is a 403', async () => {
      const { motherUid, delivery } = await seedDelivery({ motherName: 'Meena R2MC' });
      const twin1 = await recordNewbornViaProduct({ deliveryId: delivery.id, birthOrder: 1 });
      const twin2 = await recordNewbornViaProduct({ deliveryId: delivery.id, birthOrder: 2 });
      const twin1Uid = String(twin1.newborn_patient_uid);
      const twin2Uid = String(twin2.newborn_patient_uid);
      expect(twin1Uid).not.toBe(twin2Uid);

      const visit1 = await recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        newborn_id: twin1.id,
        visit_kind: 'both',
        visit_at: new Date('2026-07-12T06:00:00.000Z'),
        baby_weight_g: 2400,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });
      const visit2 = await recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: delivery.id,
        newborn_id: twin2.id,
        visit_kind: 'both',
        visit_at: new Date('2026-07-12T06:10:00.000Z'),
        baby_weight_g: 2300,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });

      const twin1Events = await canonicalRows(twin1Uid, 'maternity.postnatal_visit_recorded');
      const twin2Events = await canonicalRows(twin2Uid, 'maternity.postnatal_visit_recorded');
      expect(twin1Events.timeline).toHaveLength(1);
      expect(twin2Events.timeline).toHaveLength(1);
      expect(twin1Events.timeline[0].payload.newborn_id).toBe(twin1.id);
      expect(twin2Events.timeline[0].payload.newborn_id).toBe(twin2.id);
      expect(twin1Events.timeline[0].source_id).toBe(String(visit1.id));
      expect(twin2Events.timeline[0].source_id).toBe(String(visit2.id));
      // The mother carries one maternal pair per visit — two visits, two.
      const maternal = await canonicalRows(motherUid, 'maternity.postnatal_visit_recorded');
      expect(maternal.timeline).toHaveLength(2);
      expect(new Set(maternal.timeline.map(({ idempotency_key: key }) => key)).size).toBe(2);

      // A newborn from ANOTHER delivery cannot be linked to this visit.
      const otherCase = await seedDelivery();
      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: otherCase.delivery.id,
        newborn_id: twin1.id,
        visit_kind: 'both',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 403 });
      expect(await postnatalCount(otherCase.delivery.id)).toBe(0);
    }, 30_000);
  });

  describe('tenant isolation', () => {
    test('foreign-tenant deliveries and newborns preflight-reject with zero detail rows and zero events', async () => {
      const foreignInfantUid = await seedUser({ tenantId: TENANT_B });
      const tenantBCase = await seedDelivery({ tenantId: TENANT_B });
      const tenantBNewborn = await seedNewbornRow({
        deliveryId: tenantBCase.delivery.id,
        tenantId: TENANT_B,
        linkedPatientUid: foreignInfantUid,
      });

      await expect(recordApgar({
        tenantId: TENANT_A,
        newborn_id: tenantBNewborn.id,
        time_minute: 1,
        appearance: 2,
        pulse: 2,
        grimace: 2,
        activity: 2,
        respiration: 2,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 404 });

      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: tenantBCase.delivery.id,
        visit_kind: 'mother',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 404 });

      // Tenant-A delivery + tenant-B newborn id: the newborn preflight 404s.
      const tenantACase = await seedDelivery();
      await expect(recordPostnatalVisit({
        tenantId: TENANT_A,
        delivery_id: tenantACase.delivery.id,
        newborn_id: tenantBNewborn.id,
        visit_kind: 'both',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({ statusCode: 404 });

      expect(await apgarCount(tenantBNewborn.id)).toBe(0);
      expect(await postnatalCount(tenantBCase.delivery.id)).toBe(0);
      expect(await postnatalCount(tenantACase.delivery.id)).toBe(0);
      expectZeroEvents(await canonicalRows(tenantBCase.motherUid, 'maternity.postnatal_visit_recorded'));
      expectZeroEvents(await canonicalRows(foreignInfantUid, 'maternity.apgar_recorded'));
      expectZeroEvents(await canonicalRows(foreignInfantUid, 'maternity.postnatal_visit_recorded'));
    }, 30_000);
  });
});
