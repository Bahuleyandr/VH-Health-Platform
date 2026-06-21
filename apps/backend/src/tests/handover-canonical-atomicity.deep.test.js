// Audit §3 (Clinical core & safety) — nurse handover (SBAR) creation +
// acknowledgement must persist their canonical clinical_timeline_events +
// clinical_audit_events row INSIDE the same transaction as the nurse_handovers
// detail write (was: post-commit best-effort inside the swallowing
// bestEffortHandoverTimelineEvent, so a shift-safety handover could persist with
// no canonical timeline/audit row).
//
// Proven against the real handoverService + real QA DB:
//   1. createHandover persists nurse_handovers + handover.created timeline + audit
//      atomically.
//   2. A forced canonical-write failure ROLLS BACK the handover insert (no orphan).
//   3. acknowledgeHandover persists handover.acknowledged timeline + audit
//      atomically, and a forced failure rolls back the acknowledgement flip.

import { jest } from '@jest/globals';
import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const ctl = { forceFail: false };
const actualCanonical = await import('../services/clinical/canonicalClinicalPlatformService.js');
jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  ...actualCanonical,
  recordCanonicalClinicalEvent: async (...args) => {
    if (ctl.forceFail) throw new Error('forced canonical event failure (test)');
    return actualCanonical.recordCanonicalClinicalEvent(...args);
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

async function cleanupOutputs() {
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, TENANT_ID).catch(() => {});
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
    await cleanupOutputs();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('createHandover persists nurse_handovers + canonical timeline + audit in one tx', async () => {
    const created = await handoverService.createHandover(baseHandover());
    expect(created.id).toBeTruthy();

    expect(await handoverRows()).toHaveLength(1);
    const tl = await timelineRows('handover.created');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(tl[0].source_table).toBe('nurse_handovers');
    expect(String(tl[0].source_id)).toBe(String(created.id));
    expect((await auditRows('handover.created')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('rolls back createHandover when the canonical write fails (no orphan handover)', async () => {
    ctl.forceFail = true;
    await expect(handoverService.createHandover(baseHandover())).rejects.toThrow(/forced canonical event failure/);

    expect(await handoverRows()).toHaveLength(0);
    expect(await timelineRows('handover.created')).toHaveLength(0);
  }, 30_000);

  it('acknowledgeHandover persists canonical acknowledged event atomically, and rolls back on canonical failure', async () => {
    // First create a real handover (canonical OK).
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

    // Now let it succeed: ack flips + canonical acknowledged event persists atomically.
    ctl.forceFail = false;
    await handoverService.acknowledgeHandover(created.id, INCOMING_NURSE);
    const afterOk = await prisma.$queryRawUnsafe(
      `SELECT acknowledged FROM nurse_handovers WHERE id = $1`, created.id,
    );
    expect(afterOk[0].acknowledged).toBe(true);
    expect((await timelineRows('handover.acknowledged')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('handover.acknowledged')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
