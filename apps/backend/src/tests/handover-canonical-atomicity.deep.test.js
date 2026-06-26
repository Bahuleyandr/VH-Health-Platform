// Audit §3 (Clinical core & safety) — nurse handover (SBAR) creation +
// acknowledgement must persist their canonical clinical_timeline_events +
// clinical_audit_events row INSIDE the same transaction as the nurse_handovers
// detail write (was: post-commit best-effort inside the swallowing
// bestEffortHandoverTimelineEvent, so a shift-safety handover could persist with
// no canonical timeline/audit row).
//
// Audit A2 (event-outbox) — the SAFETY-CRITICAL clinical.handover.created /
// .acknowledged event_outbox row is now also written INSIDE the same tx (was
// post-commit best-effort, so a crash between COMMIT and the publish dropped the
// event). This suite proves the outbox row is atomic with the handover write:
// present on success, ABSENT when the tx rolls back, and stamped with the right
// tenant_id.
//
// Proven against the real handoverService + real QA DB:
//   1. createHandover persists nurse_handovers + handover.created timeline + audit
//      + event_outbox atomically (event_outbox row carries the correct tenant_id).
//   2. A forced canonical-write failure ROLLS BACK the handover insert AND the
//      event_outbox row (no orphan of either).
//   3. acknowledgeHandover persists handover.acknowledged timeline + audit
//      + event_outbox atomically, and a forced failure rolls back the
//      acknowledgement flip AND the event_outbox row.

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const ctl = { forceFail: false, forceOutboxFail: false };
const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: async (...args) => {
    if (ctl.forceFail) throw new Error('forced canonical event failure (test)');
    return actualCanonical.recordCanonicalClinicalEvent(...args);
  },
}));

// Mock the outbox publisher so we can force the IN-TX publishEvent to throw and
// prove the handover write rolls back with it (the distinguishing A2 guarantee:
// pre-fix the publish was post-commit, so its failure could NOT roll the
// handover back). Delegates to the real implementation otherwise.
const actualOutbox = await import('../services/events/eventOutboxService.js');
jest.unstable_mockModule('../services/events/eventOutboxService.js', () => ({
  ...actualOutbox,
  publishEvent: async (...args) => {
    if (ctl.forceOutboxFail) throw new Error('forced outbox publish failure (test)');
    return actualOutbox.publishEvent(...args);
  },
}));

const prisma = (await import('../lib/prisma.js')).default;
const handoverService = await import('../services/clinical/handoverService.js');

const TENANT_ID = randomUUID();
const PATIENT_UID = randomUUID();
const OUTGOING_NURSE = randomUUID();
const INCOMING_NURSE = randomUUID();
const PATIENT_PHONE = `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

async function handoverRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, acknowledged FROM nurse_handovers WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
    TENANT_ID, PATIENT_UID,
  );
}
async function timelineRows(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, source_id FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND event_type = $3`,
    TENANT_ID, PATIENT_UID, eventType,
  );
}
async function auditRows(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND action = $3`,
    TENANT_ID, PATIENT_UID, action,
  );
}
// event_outbox rows for THIS tenant + a specific handover event type. The outbox
// row written inside the handover tx carries the explicit tenant_id, so scope by
// it (the row is not patient-keyed for .acknowledged).
async function outboxRows(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, aggregate_type, aggregate_id, tenant_id
       FROM event_outbox
      WHERE tenant_id = $1::uuid AND event_type = $2`,
    TENANT_ID, eventType,
  );
}

async function cleanupOutputs() {
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM nurse_handovers WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
}
async function cleanup() {
  await cleanupOutputs();
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID, OUTGOING_NURSE, INCOMING_NURSE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_ID).catch(() => {});
}

const baseHandover = () => ({
  patient_uid: PATIENT_UID,
  ward: 'ICU',
  bed_number: 'ICU-07',
  outgoing_nurse: OUTGOING_NURSE,
  incoming_nurse: INCOMING_NURSE,
  shift: 'night',
  patient_summary: 'Post-op day 1, stable, on O2 2L.',
  active_issues: ['watch urine output'],
  pending_tasks: ['6h ABG'],
  medications_due: ['Paracetamol 1g IV at 02:00'],
  special_instructions: 'Escalate SpO2 < 92%.',
  tenant_id: TENANT_ID,
});

d('Handover canonical atomicity (audit §3)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, $2, 'Handover Atomicity Tenant')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID, `hand-atom-${TENANT_ID.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Handover Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT_ID,
    );
  }, 60_000);

  afterEach(async () => {
    ctl.forceFail = false;
    ctl.forceOutboxFail = false;
    await cleanupOutputs();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('createHandover persists nurse_handovers + canonical timeline + audit + event_outbox in one tx', async () => {
    const created = await handoverService.createHandover(baseHandover());
    expect(created.id).toBeTruthy();

    expect(await handoverRows()).toHaveLength(1);
    const tl = await timelineRows('handover.created');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(tl[0].source_table).toBe('nurse_handovers');
    expect(String(tl[0].source_id)).toBe(String(created.id));
    expect((await auditRows('handover.created')).length).toBeGreaterThanOrEqual(1);

    // A2: the safety-critical event_outbox row was written inside the SAME tx and
    // carries the correct tenant_id + aggregate linkage.
    const outbox = await outboxRows('clinical.handover.created');
    expect(outbox).toHaveLength(1);
    expect(outbox[0].aggregate_type).toBe('nurse_handover');
    expect(String(outbox[0].aggregate_id)).toBe(String(created.id));
    expect(String(outbox[0].tenant_id)).toBe(TENANT_ID);
  }, 30_000);

  it('rolls back createHandover when the canonical write fails (no orphan handover OR event_outbox)', async () => {
    ctl.forceFail = true;
    await expect(handoverService.createHandover(baseHandover())).rejects.toThrow(/forced canonical event failure/);

    expect(await handoverRows()).toHaveLength(0);
    expect(await timelineRows('handover.created')).toHaveLength(0);
    // A2: the outbox row must NOT survive the rolled-back business tx.
    expect(await outboxRows('clinical.handover.created')).toHaveLength(0);
  }, 30_000);

  it('A2: a failing IN-TX outbox publish rolls the whole createHandover back (proves the publish is inside the tx)', async () => {
    // The distinguishing guarantee: pre-fix the publish ran post-commit, so its
    // failure could not undo the handover. Now publishEvent runs ON `tx` and
    // re-throws → the nurse_handovers insert + canonical rows must all roll back.
    ctl.forceOutboxFail = true;
    await expect(handoverService.createHandover(baseHandover())).rejects.toThrow(/forced outbox publish failure/);

    expect(await handoverRows()).toHaveLength(0);
    expect(await timelineRows('handover.created')).toHaveLength(0);
    expect(await outboxRows('clinical.handover.created')).toHaveLength(0);
  }, 30_000);

  it('A2: a failing IN-TX outbox publish rolls the acknowledge flip back', async () => {
    const created = await handoverService.createHandover(baseHandover());

    ctl.forceOutboxFail = true;
    await expect(handoverService.acknowledgeHandover(created.id, INCOMING_NURSE))
      .rejects.toThrow(/forced outbox publish failure/);

    const afterFail = await prisma.$queryRawUnsafe(
      `SELECT acknowledged FROM nurse_handovers WHERE id = $1`, created.id,
    );
    expect(afterFail[0].acknowledged).toBe(false); // ack flip rolled back with the failed publish
    expect(await timelineRows('handover.acknowledged')).toHaveLength(0);
    expect(await outboxRows('clinical.handover.acknowledged')).toHaveLength(0);
  }, 30_000);

  it('acknowledgeHandover persists canonical + event_outbox atomically, and rolls both back on canonical failure', async () => {
    // First create a real handover (canonical OK). This also writes a
    // clinical.handover.created outbox row — scope ack assertions to the
    // .acknowledged type so they don't collide with it.
    const created = await handoverService.createHandover(baseHandover());

    // Force the canonical write to fail on acknowledge → the ack flip must roll back.
    ctl.forceFail = true;
    await expect(handoverService.acknowledgeHandover(created.id, INCOMING_NURSE))
      .rejects.toThrow(/forced canonical event failure/);

    const afterFail = await prisma.$queryRawUnsafe(
      `SELECT acknowledged FROM nurse_handovers WHERE id = $1`, created.id,
    );
    expect(afterFail[0].acknowledged).toBe(false); // NOT acknowledged — rolled back
    expect(await timelineRows('handover.acknowledged')).toHaveLength(0);
    // A2: the .acknowledged outbox row must NOT survive the rolled-back ack tx.
    expect(await outboxRows('clinical.handover.acknowledged')).toHaveLength(0);

    // Now let it succeed: ack flips + canonical + event_outbox persist atomically.
    ctl.forceFail = false;
    await handoverService.acknowledgeHandover(created.id, INCOMING_NURSE);
    const afterOk = await prisma.$queryRawUnsafe(
      `SELECT acknowledged FROM nurse_handovers WHERE id = $1`, created.id,
    );
    expect(afterOk[0].acknowledged).toBe(true);
    expect((await timelineRows('handover.acknowledged')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('handover.acknowledged')).length).toBeGreaterThanOrEqual(1);
    // A2: the .acknowledged outbox row now exists, atomic with the ack, correct tenant.
    const ackOutbox = await outboxRows('clinical.handover.acknowledged');
    expect(ackOutbox).toHaveLength(1);
    expect(String(ackOutbox[0].aggregate_id)).toBe(String(created.id));
    expect(String(ackOutbox[0].tenant_id)).toBe(TENANT_ID);
  }, 30_000);
});
