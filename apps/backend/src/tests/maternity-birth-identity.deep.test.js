// D7 Shape-3 birth-identity build — recordNewborn atomically mints the
// infant's patient identity + guardian link + consent evidence + canonical
// pair (decision record obgyn-d7-decision-record.md, SHA-256
// E82EEC9A054CA3708A31F48568818BB27F9986D8F5A02C37AF9407F4D5DB9562).
//
// Matrix: live-birth minting (identity/guardian/consent/canonical, all
// atomic), per-write failure injection rolls back EVERYTHING, twins get
// birth-order-qualified provisional names + distinct identities, the A-1
// unique indexes surface duplicates as clean 409s (including the true
// index-backstop race via an interleaved uncommitted competitor),
// stillbirths never mint, early_neonatal_death mints, explicit
// pre-registered identities are validated against the signed E-3 predicate,
// and every path is tenant-scoped.

import { randomUUID } from 'crypto';

import pg from 'pg';

import prisma from '../lib/prisma.js';
import { istDateString } from '../utils/dateUtils.js';
import { recordNewborn } from '../services/maternity/maternityService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ACTOR_UID = randomUUID();
const ACTOR_NAME = 'R1 Nurse';
const installedTriggers = [];
let phoneSequence = 0;

function nextPhone() {
  phoneSequence += 1;
  return `+9188${String(Date.now()).slice(-7)}${phoneSequence}`;
}

async function seedUser({
  tenantId = TENANT_A, role = 'PATIENT', name = null, uid = randomUUID(),
  isActive = true, isDeleted = false,
} = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, is_deleted, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, NOW())`,
    uid,
    nextPhone(),
    name || `R1 ${role} ${uid.slice(0, 8)}`,
    role,
    isActive,
    isDeleted,
    tenantId,
  );
  return uid;
}

async function seedDelivery({ tenantId = TENANT_A, motherName } = {}) {
  const motherUid = await seedUser({ tenantId, name: motherName });
  const pregnancyRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-10-05', '2026-07-12', 'delivered', $2::uuid, $3::uuid)
     RETURNING id`,
    motherUid, ACTOR_UID, tenantId,
  );
  const deliveryRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries
       (pregnancy_id, delivery_datetime, delivery_mode, delivered_by, tenant_id)
     VALUES ($1::int, '2026-07-12T03:15:00Z', 'nvd', $2::uuid, $3::uuid)
     RETURNING id`,
    Number(pregnancyRows[0].id), ACTOR_UID, tenantId,
  );
  return {
    motherUid,
    pregnancyId: Number(pregnancyRows[0].id),
    deliveryId: Number(deliveryRows[0].id),
  };
}

async function installFailureTrigger({ table, condition }) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `r1_birth_fail_${suffix}`;
  const triggerName = `r1_birth_trigger_${suffix}`;
  const entry = { table, functionName, triggerName };
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${functionName}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $$
       BEGIN
         IF ${condition} THEN
           RAISE EXCEPTION 'R1 injected failure ${suffix}';
         END IF;
         RETURN NEW;
       END;
       $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${triggerName}
       AFTER INSERT ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  );
  installedTriggers.push(entry);
  return async () => {
    await prisma
      .$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`)
      .catch(() => {});
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => {});
    const index = installedTriggers.indexOf(entry);
    if (index >= 0) installedTriggers.splice(index, 1);
  };
}

async function infantUserRow(uid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, id, phone, name, birthday::text AS birthday, gender, role,
            is_minor, is_active, is_deleted,
            guardian_user_id, guardian_name, guardian_phone, guardian_relationship,
            tenant_id
       FROM users
      WHERE uid = $1::uuid`,
    String(uid),
  );
  return rows[0] || null;
}

async function consentRowsFor(uid) {
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, consent_type, granted, status, granted_by,
            source, consent_method, witness_name, witness_uid, tenant_id
       FROM patient_consents
      WHERE patient_uid = $1::uuid
      ORDER BY id`,
    String(uid),
  );
}

async function canonicalPairFor(newbornId, tenantId = TENANT_A) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, event_type, event_status, source_table, source_id,
            actor_uid, actor_role, visible_to_patient, payload, idempotency_key
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND event_type = 'maternity.newborn_recorded'
        AND source_id = $2
      ORDER BY created_at`,
    tenantId, String(newbornId),
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, action, resource_table, resource_id, actor_uid,
            actor_role, after_state, idempotency_key
       FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND action = 'maternity.newborn_recorded'
        AND resource_id = $2
      ORDER BY created_at`,
    tenantId, String(newbornId),
  );
  return { timeline, audit };
}

async function countTimelineEvents(tenantId = TENANT_A) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total
       FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid AND event_type = 'maternity.newborn_recorded'`,
    tenantId,
  );
  return Number(rows[0].total);
}

async function cleanupTenant(tenantId) {
  for (const sql of [
    `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`,
    `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`,
    `DELETE FROM patient_consents WHERE tenant_id = $1::uuid`,
    `DELETE FROM newborn_immunisations WHERE tenant_id = $1::uuid`,
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

d('D7 Shape-3 — recordNewborn birth identity minting', () => {
  beforeAll(async () => {
    await cleanupTenant(TENANT_A);
    await cleanupTenant(TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'R1 Birth Identity Tenant A'),
              ($3::uuid, $4, 'R1 Birth Identity Tenant B')`,
      TENANT_A, `r1a-${TENANT_A.slice(0, 8)}`,
      TENANT_B, `r1b-${TENANT_B.slice(0, 8)}`,
    );
    await seedUser({
      tenantId: TENANT_A, role: 'NURSING_STAFF', name: ACTOR_NAME, uid: ACTOR_UID,
    });
  }, 30_000);

  afterEach(async () => {
    for (const entry of [...installedTriggers]) {
      await prisma
        .$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${entry.triggerName} ON ${entry.table}`)
        .catch(() => {});
      await prisma
        .$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${entry.functionName}()`)
        .catch(() => {});
      installedTriggers.splice(installedTriggers.indexOf(entry), 1);
    }
  });

  afterAll(async () => {
    await cleanupTenant(TENANT_A);
    await cleanupTenant(TENANT_B);
    await prisma.$disconnect();
  }, 30_000);

  test('live birth mints identity + guardian link + consent evidence + canonical pair atomically', async () => {
    const { motherUid, pregnancyId, deliveryId } = await seedDelivery({
      motherName: 'Meena R1-Live',
    });
    const motherRow = await infantUserRow(motherUid);

    const birthDatetime = '2026-07-12T03:20:00Z';
    const result = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_datetime: birthDatetime,
      sex: 'female',
      birth_weight_g: 3100,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    // Newborn detail row is linked to the minted identity.
    expect(result.newborn_patient_uid).toBeTruthy();
    expect(result.outcome).toBe('live');
    expect(result.minted_identity).toMatchObject({
      patient_uid: result.newborn_patient_uid,
      guardian_user_id: Number(motherRow.id),
      guardian_relationship: 'mother',
      provisional_name: 'B/O Meena R1-Live',
    });
    expect(result.minted_identity.guardian_consent_id).toEqual(expect.any(Number));

    // The identity row follows the walk-in minor pattern: PATIENT, minor,
    // active, synthetic NB- phone, guardian link to the mother's users.id.
    const infant = await infantUserRow(result.newborn_patient_uid);
    expect(infant).toMatchObject({
      role: 'PATIENT',
      is_minor: true,
      is_active: true,
      is_deleted: false,
      name: 'B/O Meena R1-Live',
      gender: 'female',
      guardian_user_id: Number(motherRow.id),
      guardian_name: 'Meena R1-Live',
      guardian_relationship: 'mother',
      tenant_id: TENANT_A,
    });
    expect(infant.phone).toMatch(/^NB-[0-9A-F]{12}$/);
    expect(infant.birthday).toBe(istDateString(new Date(birthDatetime)));

    // G-3 consent evidence through the EXISTING substrate.
    const consents = await consentRowsFor(result.newborn_patient_uid);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      consent_type: 'treatment',
      granted: true,
      status: 'active',
      granted_by: 'guardian_mother',
      source: 'birth_registration',
      consent_method: 'verbal',
      witness_uid: ACTOR_UID,
      witness_name: ACTOR_NAME,
      tenant_id: TENANT_A,
    });
    expect(Number(consents[0].id)).toBe(result.minted_identity.guardian_consent_id);

    // Exactly one staff-only canonical pair, subject = the INFANT.
    const { timeline, audit } = await canonicalPairFor(result.id);
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      patient_uid: result.newborn_patient_uid,
      event_status: 'recorded',
      source_table: 'maternity_newborns',
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
      visible_to_patient: false,
      payload: expect.objectContaining({
        newborn_id: result.id,
        delivery_id: deliveryId,
        pregnancy_id: pregnancyId,
        birth_order: 1,
        outcome: 'live',
        newborn_patient_uid: result.newborn_patient_uid,
        mother_patient_uid: motherUid,
        identity_minted: true,
        guardian_user_id: Number(motherRow.id),
        guardian_consent_id: result.minted_identity.guardian_consent_id,
      }),
    });
    // Insert-once fixed lifecycle keys per the Idempotency-Key Discipline.
    expect(timeline[0].idempotency_key).toBe(`maternity_newborns:${result.id}:recorded`);
    expect(audit[0].idempotency_key).toBe(`maternity_newborns:${result.id}:audit:recorded`);
    expect(audit[0].patient_uid).toBe(result.newborn_patient_uid);
    // Minimal structured payload — no narrative, no mother name leakage.
    expect(JSON.stringify(timeline[0].payload)).not.toContain('Meena');
  });

  test('failure injected at EACH write rolls back identity, guardian, consent, link and canonical rows', async () => {
    const marker = `R1-Atom-${randomUUID().slice(0, 8)}`;
    const injections = [
      {
        label: 'users (identity mint)',
        table: 'users',
        condition: `NEW.name LIKE 'B/O ${marker}%' AND NEW.tenant_id = '${TENANT_A}'::uuid`,
      },
      {
        label: 'patient_consents (guardian consent)',
        table: 'patient_consents',
        condition: `NEW.source = 'birth_registration' AND NEW.tenant_id = '${TENANT_A}'::uuid`,
      },
      {
        label: 'maternity_newborns (detail row)',
        table: 'maternity_newborns',
        condition: `NEW.tenant_id = '${TENANT_A}'::uuid AND NEW.birth_datetime = '2026-07-12T03:25:00Z'::timestamptz`,
      },
      {
        label: 'clinical_timeline_events (canonical timeline)',
        table: 'clinical_timeline_events',
        condition: `NEW.event_type = 'maternity.newborn_recorded' AND NEW.tenant_id = '${TENANT_A}'::uuid`,
      },
      {
        label: 'clinical_audit_events (canonical audit)',
        table: 'clinical_audit_events',
        condition: `NEW.action = 'maternity.newborn_recorded' AND NEW.tenant_id = '${TENANT_A}'::uuid`,
      },
    ];

    async function birthConsentCount() {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS total
           FROM patient_consents
          WHERE tenant_id = $1::uuid AND source = 'birth_registration'`,
        TENANT_A,
      );
      return Number(rows[0].total);
    }

    for (const injection of injections) {
      const { motherUid, deliveryId } = await seedDelivery({
        motherName: `${marker} ${injection.table}`,
      });
      const timelineBefore = await countTimelineEvents();
      const consentsBefore = await birthConsentCount();
      const removeTrigger = await installFailureTrigger(injection);
      try {
        await expect(recordNewborn({
          tenantId: TENANT_A,
          delivery_id: deliveryId,
          birth_datetime: '2026-07-12T03:25:00Z',
          recorded_by: ACTOR_UID,
          actor_uid: ACTOR_UID,
          actor_role: 'NURSING_STAFF',
        })).rejects.toThrow();
      } finally {
        await removeTrigger();
      }

      // EVERYTHING rolled back: no infant identity, no consent evidence,
      // no newborn row, no canonical rows.
      const infants = await prisma.$queryRawUnsafe(
        `SELECT uid FROM users
          WHERE tenant_id = $1::uuid AND guardian_relationship = 'mother'
            AND name LIKE $2`,
        TENANT_A, `B/O ${marker}%`,
      );
      expect(infants).toHaveLength(0);
      expect(await birthConsentCount()).toBe(consentsBefore);
      const newborns = await prisma.$queryRawUnsafe(
        `SELECT id FROM maternity_newborns WHERE delivery_id = $1::int`,
        deliveryId,
      );
      expect(newborns).toHaveLength(0);
      expect(await countTimelineEvents()).toBe(timelineBefore);
      // Mother row untouched by the rollback.
      expect(await infantUserRow(motherUid)).toBeTruthy();
    }
  }, 60_000);

  test('twins mint distinct identities with birth-order-qualified provisional names', async () => {
    const { deliveryId } = await seedDelivery({ motherName: 'Meena R1-Twins' });

    const twin1 = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_order: 1,
      birth_datetime: '2026-07-12T03:30:00Z',
      sex: 'female',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    const twin2 = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_order: 2,
      birth_datetime: '2026-07-12T03:34:00Z',
      sex: 'male',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });

    expect(twin1.newborn_patient_uid).toBeTruthy();
    expect(twin2.newborn_patient_uid).toBeTruthy();
    expect(twin1.newborn_patient_uid).not.toBe(twin2.newborn_patient_uid);
    expect(twin1.minted_identity.provisional_name).toBe('B/O Meena R1-Twins');
    expect(twin2.minted_identity.provisional_name).toBe('Twin-2 B/O Meena R1-Twins');

    // A-1: the birth-order slot cannot repeat — clean 409, not a 500.
    await expect(recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_order: 2,
      birth_datetime: '2026-07-12T03:40:00Z',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MATERNITY_NEWBORN_BIRTH_ORDER_TAKEN',
    });

    // A-1: one identity backs at most one newborn row — linking twin1's
    // identity to another delivery rejects cleanly.
    const { deliveryId: otherDelivery } = await seedDelivery({
      motherName: 'Meena R1-Other',
    });
    await expect(recordNewborn({
      tenantId: TENANT_A,
      delivery_id: otherDelivery,
      birth_datetime: '2026-07-12T03:45:00Z',
      newborn_patient_uid: twin1.newborn_patient_uid,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NEWBORN_IDENTITY_INVALID',
      details: { reason: 'already_linked' },
    });
  });

  test('A-1 index backstop: an uncommitted competing row surfaces as a clean 409 after commit', async () => {
    // The in-tx prechecks cannot see a competitor's UNCOMMITTED row (MVCC),
    // so this interleaving drives the write into the unique index itself:
    // recordNewborn's INSERT blocks on the in-flight duplicate, the
    // competitor commits, and the 23505 must surface as the mapped 409.
    const { deliveryId } = await seedDelivery({ motherName: 'Meena R1-Race' });
    const client = new pg.Client({ connectionString: CONNECTION_STRING });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO maternity_newborns
           (delivery_id, birth_order, birth_datetime, outcome, tenant_id)
         VALUES ($1, 1, '2026-07-12T03:50:00Z', 'live', $2)`,
        [deliveryId, TENANT_A],
      );

      const attempt = recordNewborn({
        tenantId: TENANT_A,
        delivery_id: deliveryId,
        birth_order: 1,
        birth_datetime: '2026-07-12T03:51:00Z',
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });
      // Give the service time to pass its prechecks and block on the
      // in-flight unique-index entry, then commit the competitor.
      const commitSoon = (async () => {
        await new Promise((resolve) => { setTimeout(resolve, 400); });
        await client.query('COMMIT');
      })();

      await expect(attempt).rejects.toMatchObject({
        statusCode: 409,
        code: 'MATERNITY_NEWBORN_BIRTH_ORDER_TAKEN',
      });
      await commitSoon;

      // The competitor's row is the only one; no identity/consent leaked
      // from the losing mint.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, newborn_patient_uid FROM maternity_newborns WHERE delivery_id = $1::int`,
        deliveryId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].newborn_patient_uid).toBeNull();
      const leakedInfants = await prisma.$queryRawUnsafe(
        `SELECT uid FROM users WHERE tenant_id = $1::uuid AND name LIKE 'B/O Meena R1-Race%'`,
        TENANT_A,
      );
      expect(leakedInfants).toHaveLength(0);
    } finally {
      await client.end().catch(() => {});
    }
  }, 30_000);

  test('concurrent same-slot records: exactly one succeeds, the loser gets a clean 409', async () => {
    const { deliveryId } = await seedDelivery({ motherName: 'Meena R1-Conc' });
    const call = () => recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_order: 1,
      birth_datetime: '2026-07-12T03:55:00Z',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    const [a, b] = await Promise.all([call(), call()]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].error).toMatchObject({ statusCode: 409 });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_newborns WHERE delivery_id = $1::int`,
      deliveryId,
    );
    expect(rows).toHaveLength(1);
    // Exactly one identity minted for the winner.
    const infants = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users WHERE tenant_id = $1::uuid AND name LIKE 'B/O Meena R1-Conc%'`,
      TENANT_A,
    );
    expect(infants).toHaveLength(1);
  });

  test('stillbirths (fresh + macerated) record the detail row but NEVER mint an identity', async () => {
    for (const outcome of ['fresh_stillbirth', 'macerated_stillbirth']) {
      const { motherUid, deliveryId } = await seedDelivery({
        motherName: `Meena R1-${outcome}`,
      });
      const result = await recordNewborn({
        tenantId: TENANT_A,
        delivery_id: deliveryId,
        birth_datetime: '2026-07-12T04:00:00Z',
        outcome,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });

      expect(result.outcome).toBe(outcome);
      expect(result.newborn_patient_uid).toBeNull();
      expect(result.minted_identity).toBeNull();

      // No infant identity, no guardian write, no consent evidence.
      const infants = await prisma.$queryRawUnsafe(
        `SELECT uid FROM users
          WHERE tenant_id = $1::uuid AND name LIKE $2`,
        TENANT_A, `%B/O Meena R1-${outcome}%`,
      );
      expect(infants).toHaveLength(0);

      // The birth event is recorded on the MOTHER's episode (B-2: a
      // stillborn baby never has an identity — this is signed design, not
      // a fallback).
      const { timeline, audit } = await canonicalPairFor(result.id);
      expect(timeline).toHaveLength(1);
      expect(audit).toHaveLength(1);
      expect(timeline[0].patient_uid).toBe(motherUid);
      expect(timeline[0].payload).toMatchObject({
        outcome,
        identity_minted: false,
        newborn_patient_uid: null,
        guardian_consent_id: null,
      });
    }

    // An explicit identity on a stillbirth contradicts B-2 — rejected.
    const { deliveryId } = await seedDelivery({ motherName: 'Meena R1-SB-Link' });
    const preRegistered = await seedUser({ name: 'Pre-registered Baby' });
    await expect(recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_datetime: '2026-07-12T04:05:00Z',
      outcome: 'fresh_stillbirth',
      newborn_patient_uid: preRegistered,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NEWBORN_IDENTITY_INVALID',
      details: { reason: 'identity_forbidden_for_outcome' },
    });

    // Unknown outcomes fail closed.
    await expect(recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_datetime: '2026-07-12T04:06:00Z',
      outcome: 'unknown_outcome',
      recorded_by: ACTOR_UID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'MATERNITY_NEWBORN_OUTCOME_INVALID',
    });
  });

  test('early_neonatal_death mints an identity (a baby who lived gets their own record)', async () => {
    const { deliveryId } = await seedDelivery({ motherName: 'Meena R1-END' });
    const result = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_datetime: '2026-07-12T04:10:00Z',
      outcome: 'early_neonatal_death',
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    expect(result.newborn_patient_uid).toBeTruthy();
    expect(result.minted_identity).toMatchObject({
      provisional_name: 'B/O Meena R1-END',
    });
    const { timeline } = await canonicalPairFor(result.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(result.newborn_patient_uid);
    expect(timeline[0].payload).toMatchObject({
      outcome: 'early_neonatal_death',
      identity_minted: true,
    });
  });

  test('an explicit pre-registered identity is linked without minting and without consent duplication', async () => {
    const { deliveryId } = await seedDelivery({ motherName: 'Meena R1-PreReg' });
    const preRegistered = await seedUser({ name: 'Registered Baby R1' });

    const result = await recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_datetime: '2026-07-12T04:15:00Z',
      newborn_patient_uid: preRegistered,
      recorded_by: ACTOR_UID,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    expect(result.newborn_patient_uid).toBe(preRegistered);
    expect(result.minted_identity).toBeNull();
    // No consent row invented for a pre-registered identity (its consent
    // was captured at its own registration).
    expect(await consentRowsFor(preRegistered)).toHaveLength(0);
    const { timeline } = await canonicalPairFor(result.id);
    expect(timeline[0].patient_uid).toBe(preRegistered);
    expect(timeline[0].payload).toMatchObject({ identity_minted: false });
  });

  test('explicit identities are validated against the signed E-3 predicate (fail-closed)', async () => {
    const { motherUid, deliveryId } = await seedDelivery({ motherName: 'Meena R1-E3' });
    const timelineBefore = await countTimelineEvents();

    const cases = [];
    // Soft-deleted patient.
    const deletedUid = await seedUser({ name: 'Deleted Baby' });
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE uid = $1::uuid`,
      deletedUid,
    );
    cases.push({ uid: deletedUid, reason: 'deleted' });
    // Deactivated patient.
    const inactiveUid = await seedUser({ name: 'Inactive Baby', isActive: false });
    cases.push({ uid: inactiveUid, reason: 'inactive' });
    // Merged-away patient (executed patient_merge_requests row).
    const mergedUid = await seedUser({ name: 'Merged Baby' });
    const mergeTarget = await seedUser({ name: 'Merge Target' });
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_merge_requests
         (tenant_id, primary_uid, secondary_uid, status, executed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'executed', NOW())`,
      TENANT_A, mergeTarget, mergedUid,
    );
    cases.push({ uid: mergedUid, reason: 'merged_away' });
    // Staff account is not a PATIENT subject.
    const staffUid = await seedUser({ name: 'Staff Not Baby', role: 'DOCTOR' });
    cases.push({ uid: staffUid, reason: 'not_patient' });
    // Mother-exclusion arm: the mother's own uid is never the infant.
    cases.push({ uid: motherUid, reason: 'mother_identity' });
    // Cross-tenant uid resolves to nothing inside tenant A.
    const foreignUid = await seedUser({ tenantId: TENANT_B, name: 'Foreign Baby' });
    cases.push({ uid: foreignUid, reason: 'not_found' });
    // Entirely unknown uid.
    cases.push({ uid: randomUUID(), reason: 'not_found' });

    for (const testCase of cases) {
      await expect(recordNewborn({
        tenantId: TENANT_A,
        delivery_id: deliveryId,
        birth_datetime: '2026-07-12T04:20:00Z',
        newborn_patient_uid: testCase.uid,
        recorded_by: ACTOR_UID,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NEWBORN_IDENTITY_INVALID',
        details: { reason: testCase.reason },
      });
    }

    // Nothing was written by any rejected attempt.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_newborns WHERE delivery_id = $1::int`,
      deliveryId,
    );
    expect(rows).toHaveLength(0);
    expect(await countTimelineEvents()).toBe(timelineBefore);
  });

  test('tenant isolation: a delivery in tenant B is invisible to tenant A', async () => {
    const { deliveryId } = await seedDelivery({
      tenantId: TENANT_B, motherName: 'Meena R1-B',
    });
    await expect(recordNewborn({
      tenantId: TENANT_A,
      delivery_id: deliveryId,
      birth_datetime: '2026-07-12T04:25:00Z',
      recorded_by: ACTOR_UID,
    })).rejects.toMatchObject({ statusCode: 404 });
    // No canonical rows leaked into either tenant for this delivery.
    const leaked = await prisma.$queryRawUnsafe(
      `SELECT id FROM maternity_newborns WHERE delivery_id = $1::int`,
      deliveryId,
    );
    expect(leaked).toHaveLength(0);
  });
});
