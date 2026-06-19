// Audit §3 (Clinical core & safety) — MAR scheduleMedications / recordMissed /
// holdMedication must persist their canonical clinical_timeline_events +
// clinical_audit_events row INSIDE the same transaction as the
// medication_administrations detail write (was: recordCanonicalMarEvent ran
// outside the tx, swallowed — so a scheduled/missed/held dose could exist with
// no canonical medication-safety record).
//
// recordAdministration is intentionally NOT exercised here for change — it was
// already hardened (its own setTenantTx + 23505 MAR_DUPLICATE_ADMINISTRATION
// mapping) and is left untouched.
//
// Proven against the real marService + real QA DB via a toggle-mock of
// recordCanonicalClinicalEvent (delegates to the real impl unless forced to fail).

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
const marService = await import('../services/clinical/marService.js');

const PATIENT_UID = randomUUID();
const NURSE_UID = randomUUID();
const SCHED_BASE = '2026-07-01T08:00:00Z';
const DRUG = `MAR_ATOM_${randomUUID().slice(0, 8)}`;

async function maRows() {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, scheduled_time FROM medication_administrations
      WHERE patient_uid = $1::uuid AND medication_name = $2 ORDER BY id`,
    PATIENT_UID, DRUG,
  );
}
async function timelineRows(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id, event_type, source_table, source_id FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2`,
    PATIENT_UID, eventType,
  );
}
async function auditRows(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id, action FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2`,
    PATIENT_UID, action,
  );
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'medication_administrations'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'medication_administrations'`,
    PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid AND medication_name = $2`,
    PATIENT_UID, DRUG,
  ).catch(() => {});
}

d('MAR canonical atomicity — schedule/missed/held (audit §3)', () => {
  beforeAll(cleanup);
  afterEach(() => { ctl.forceFail = false; });
  afterAll(async () => { await cleanup(); await prisma.$disconnect().catch(() => {}); });

  it('scheduleMedications persists the MA row + canonical mar.scheduled timeline + audit atomically', async () => {
    const created = await marService.scheduleMedications(PATIENT_UID, null, [
      { medication_name: DRUG, dose: '5 mg', route: 'oral', scheduled_time: SCHED_BASE },
    ], { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF' });

    expect(created).toHaveLength(1);
    const rows = await maRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');

    const tl = await timelineRows('mar.scheduled');
    expect(tl.length).toBeGreaterThanOrEqual(1);
    expect(tl[0].source_table).toBe('medication_administrations');
    expect(String(tl[0].source_id)).toBe(String(rows[0].id));
    expect((await auditRows('mar.scheduled')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('rolls back the scheduled MA row when the canonical write fails (no orphan dose)', async () => {
    await cleanup();
    ctl.forceFail = true;
    await expect(
      marService.scheduleMedications(PATIENT_UID, null, [
        { medication_name: DRUG, dose: '5 mg', route: 'oral', scheduled_time: SCHED_BASE },
      ], { actorUid: NURSE_UID, actorRole: 'NURSING_STAFF' }),
    ).rejects.toThrow(/forced canonical event failure/);

    expect(await maRows()).toHaveLength(0);          // MA row rolled back
    expect(await timelineRows('mar.scheduled')).toHaveLength(0);
  }, 30_000);

  it('recordMissed flips status + emits canonical mar.missed atomically; rolls back on canonical failure', async () => {
    await cleanup();
    // Seed a scheduled row directly (bypass scheduleMedications to isolate recordMissed).
    const seed = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, $2, '5 mg', 'oral', $3::timestamptz, 'scheduled') RETURNING id`,
      PATIENT_UID, DRUG, SCHED_BASE,
    );
    const id = seed[0].id;

    // Forced failure → status must NOT change to 'missed'.
    ctl.forceFail = true;
    await expect(marService.recordMissed(id, 'patient NPO', NURSE_UID)).rejects.toThrow(/forced canonical event failure/);
    let row = await prisma.$queryRawUnsafe(`SELECT status FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('scheduled'); // rolled back
    expect(await timelineRows('mar.missed')).toHaveLength(0);

    // Success → atomic flip + canonical event.
    ctl.forceFail = false;
    await marService.recordMissed(id, 'patient NPO', NURSE_UID);
    row = await prisma.$queryRawUnsafe(`SELECT status FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('missed');
    expect((await timelineRows('mar.missed')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('mar.missed')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('holdMedication flips status + emits canonical mar.held atomically; rolls back on canonical failure', async () => {
    await cleanup();
    const seed = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, $2, '5 mg', 'oral', $3::timestamptz, 'scheduled') RETURNING id`,
      PATIENT_UID, DRUG, SCHED_BASE,
    );
    const id = seed[0].id;

    ctl.forceFail = true;
    await expect(marService.holdMedication(id, 'await review', NURSE_UID)).rejects.toThrow(/forced canonical event failure/);
    let row = await prisma.$queryRawUnsafe(`SELECT status, hold_reason FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('scheduled'); // rolled back
    expect(row[0].hold_reason).toBeNull();
    expect(await timelineRows('mar.held')).toHaveLength(0);

    ctl.forceFail = false;
    await marService.holdMedication(id, 'await review', NURSE_UID);
    row = await prisma.$queryRawUnsafe(`SELECT status, hold_reason FROM medication_administrations WHERE id = $1`, id);
    expect(row[0].status).toBe('held');
    expect(row[0].hold_reason).toBe('await review');
    expect((await timelineRows('mar.held')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('mar.held')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
