// Phase-3 deep review S6-06 — recordMissed / holdMedication race guards.
//
// Before the fix, both paths checked the dose status OUTSIDE the transaction
// and then ran an unguarded UPDATE. Two nurses acting on one overdue dose
// could interleave so that an administered dose was flipped back to
// 'missed'/'held', and the hold path also overwrote administered_by,
// destroying the administering nurse's attribution.
//
// These tests reproduce the race deterministically: a concurrent transaction
// takes the row lock (FOR UPDATE), the missed/hold call passes its Phase-0
// pre-flight (row still 'scheduled') and blocks on the in-tx lock, then the
// concurrent transaction administers the dose and commits. The unblocked
// missed/hold call must now see status='administered' inside its own tx and
// reject with a 409 MAR_ADMINISTRATION_STATE_CONFLICT — leaving the
// administered record (status, administered_by, administered_at) untouched
// and emitting no canonical mar.missed / mar.held event.
//
// Proven against the real marService + real QA DB (mirrors
// mar-canonical-atomicity.deep.test.js setup).

import { randomUUID } from 'crypto';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const prisma = (await import('../lib/prisma.js')).default;
const marService = await import('../services/clinical/marService.js');

const PATIENT_UID = randomUUID();
const ADMINISTERING_NURSE = randomUUID();
const SECOND_NURSE = randomUUID();
const SCHED_BASE = '2026-07-02T08:00:00Z';
const DRUG = `MAR_RACE_${randomUUID().slice(0, 8)}`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function seedScheduledDose(scheduledTime = SCHED_BASE) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
     VALUES ($1::uuid, $2, '5 mg', 'oral', $3::timestamptz, 'scheduled') RETURNING id`,
    PATIENT_UID, DRUG, scheduledTime,
  );
  return rows[0].id;
}

async function maRow(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, administered_by::text, administered_at, hold_reason, notes
       FROM medication_administrations WHERE id = $1`,
    id,
  );
  return rows[0];
}

async function timelineRows(eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2`,
    PATIENT_UID, eventType,
  );
}

async function auditRows(action) {
  return prisma.$queryRawUnsafe(
    `SELECT id FROM clinical_audit_events
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

/**
 * Run `raceLoser(id)` while a concurrent transaction holds the row lock, then
 * administer the dose in that concurrent transaction and commit. Returns
 * `{ loser }` — the promise of the losing call, boxed so the async return
 * does not unwrap (and therefore throw) the expected rejection.
 */
async function administerWhileBlocked(id, raceLoser) {
  const lockHeld = deferred();
  const releaseLock = deferred();

  const winner = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT id FROM medication_administrations WHERE id = $1 FOR UPDATE`,
      id,
    );
    lockHeld.resolve();
    await releaseLock.promise;
    await tx.$executeRawUnsafe(
      `UPDATE medication_administrations
          SET status = 'administered',
              administered_at = NOW(),
              administered_by = $2::uuid
        WHERE id = $1`,
      id, ADMINISTERING_NURSE,
    );
  }, { timeout: 30_000, maxWait: 10_000 });

  await lockHeld.promise;

  // Kick off the losing call: its Phase-0 pre-flight read (plain prisma, no
  // lock) still sees 'scheduled', so it proceeds into its transaction and
  // blocks on the FOR UPDATE row lock held by `winner`.
  const loser = raceLoser(id);
  loser.catch(() => {}); // settled via expect() below; avoid unhandled warning

  // Give the loser time to pass Phase 0 and queue on the row lock, then let
  // the winner administer + commit.
  await new Promise((resolve) => setTimeout(resolve, 750));
  releaseLock.resolve();
  await winner;

  return { loser };
}

d('MAR missed/hold race guards — S6-06 (Phase-3 deep review)', () => {
  beforeAll(cleanup);
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); await prisma.$disconnect().catch(() => {}); });

  it('recordMissed racing an administration returns 409 and does not overwrite the administered record', async () => {
    const id = await seedScheduledDose();

    const { loser } = await administerWhileBlocked(
      id,
      (doseId) => marService.recordMissed(doseId, 'dose overdue', SECOND_NURSE),
    );

    await expect(loser).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_ADMINISTRATION_STATE_CONFLICT',
    });

    // The administered record survives untouched — status and attribution.
    const row = await maRow(id);
    expect(row.status).toBe('administered');
    expect(row.administered_by).toBe(ADMINISTERING_NURSE);
    expect(row.administered_at).not.toBeNull();
    expect(row.notes).toBeNull(); // missed reason was not written

    // No canonical mar.missed event was emitted for the rejected write.
    expect(await timelineRows('mar.missed')).toHaveLength(0);
    expect(await auditRows('mar.missed')).toHaveLength(0);
  }, 60_000);

  it('holdMedication racing an administration returns 409 and preserves the administering nurse attribution', async () => {
    const id = await seedScheduledDose();

    const { loser } = await administerWhileBlocked(
      id,
      (doseId) => marService.holdMedication(doseId, 'pending review', SECOND_NURSE),
    );

    await expect(loser).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAR_ADMINISTRATION_STATE_CONFLICT',
    });

    // The hold must not clobber the administering nurse's identity or flip
    // the administered dose back to held.
    const row = await maRow(id);
    expect(row.status).toBe('administered');
    expect(row.administered_by).toBe(ADMINISTERING_NURSE);
    expect(row.hold_reason).toBeNull();

    // No canonical mar.held event was emitted for the rejected write.
    expect(await timelineRows('mar.held')).toHaveLength(0);
    expect(await auditRows('mar.held')).toHaveLength(0);
  }, 60_000);

  it('recordMissed on an already-administered dose (no concurrent lock) still refuses without overwriting', async () => {
    const id = await seedScheduledDose('2026-07-02T09:00:00Z');
    await prisma.$executeRawUnsafe(
      `UPDATE medication_administrations
          SET status = 'administered', administered_at = NOW(), administered_by = $2::uuid
        WHERE id = $1`,
      id, ADMINISTERING_NURSE,
    );

    // Phase-0 sees the final state → invalid transition (400 pre-flight path).
    await expect(marService.recordMissed(id, 'late', SECOND_NURSE)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    const row = await maRow(id);
    expect(row.status).toBe('administered');
    expect(row.administered_by).toBe(ADMINISTERING_NURSE);
  }, 30_000);

  it('recordMissed and holdMedication still succeed on an uncontended scheduled dose', async () => {
    const missedId = await seedScheduledDose('2026-07-02T10:00:00Z');
    const missed = await marService.recordMissed(missedId, 'patient NPO', SECOND_NURSE);
    expect(missed.status).toBe('missed');
    expect((await timelineRows('mar.missed')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('mar.missed')).length).toBeGreaterThanOrEqual(1);

    const heldId = await seedScheduledDose('2026-07-02T11:00:00Z');
    const held = await marService.holdMedication(heldId, 'awaiting review', SECOND_NURSE);
    expect(held.status).toBe('held');
    expect(held.hold_reason).toBe('awaiting review');
    expect((await timelineRows('mar.held')).length).toBeGreaterThanOrEqual(1);
    expect((await auditRows('mar.held')).length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
