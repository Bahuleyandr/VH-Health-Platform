/**
 * MAR double-charting DB guards (audit §3 Clinical core & safety — migration
 * 327, extended by migration 642 / C-L2).
 *
 * 327: the application cross-row duplicate guard in recordAdministration is a
 * check-then-act SELECT with no lock (TOCTOU): two concurrent administrations of
 * sibling rows for the same patient + medication + scheduled slot could both
 * pass the check and chart the dose twice. A partial unique index makes a second
 * 'administered' row for the same (patient_uid, medication_name, scheduled_time)
 * impossible at the DB layer regardless of concurrency. PRN/unscheduled rows
 * (scheduled_time NULL) are exempt — they may legitimately be given more than once.
 *
 * 642 (C-L2): the same TOCTOU exists one step earlier — scheduleMedications'
 * dup pre-check is check-then-insert on plain prisma and 327 only covers
 * status='administered', so two concurrent schedule calls could insert
 * duplicate SCHEDULED rows. uniq_mar_scheduled_dose is the backstop; the
 * service catches the 23505 and returns the winner row (idempotent return,
 * no extra canonical event).
 */
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { scheduleMedications } from '../services/clinical/marService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_UID = 'a9999999-9999-4999-8999-999999999d01';
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const DRUG = 'TESTDRUG_DUPGUARD_327';
const SCHED = '2026-06-19T08:00:00Z';

function pgErrorCode(err) {
  if (!err) return null;
  if (err.meta?.code) return String(err.meta.code);
  if (err.code && /^\d/.test(String(err.code))) return String(err.code);
  return /23505|duplicate key value/i.test(err.message || '') ? '23505' : null;
}

async function seedRow(scheduledTime, status = 'scheduled') {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations (patient_uid, medication_name, scheduled_time, status)
     VALUES ($1::uuid, $2, $3::timestamptz, $4)
     RETURNING id`,
    PATIENT_UID, DRUG, scheduledTime, status,
  );
  return rows[0].id;
}
async function administer(id) {
  return prisma.$executeRawUnsafe(
    `UPDATE medication_administrations SET status = 'administered', administered_at = NOW() WHERE id = $1`,
    id,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

d('MAR duplicate-administration DB guard (migration 327)', () => {
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
      `DELETE FROM medication_administrations WHERE medication_name LIKE $1`, `${DRUG}%`,
    ).catch(() => {});
  }
  beforeAll(cleanup);
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it('rejects a second administered row for the same patient+medication+scheduled_time', async () => {
    const a = await seedRow(SCHED);
    // A duplicate sibling for the same dose. Since migration 642 a second
    // SCHEDULED row for the slot is itself impossible, so seed the sibling as
    // 'held' — a real reachable state (holdMedication) not covered by either
    // partial index until it is administered.
    const b = await seedRow(SCHED, 'held');

    await administer(a); // first administration of the dose: ok

    let code = null;
    try {
      await administer(b); // second row for the SAME dose must be impossible
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe('23505');
  });

  it('allows administering the same drug at a DIFFERENT scheduled_time (not a duplicate)', async () => {
    const c = await seedRow('2026-06-19T20:00:00Z');
    await expect(administer(c)).resolves.toBeDefined();
  });

  it('allows multiple administrations of an unscheduled (PRN) dose', async () => {
    const p1 = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, scheduled_time, status)
       VALUES ($1::uuid, $2, NULL, 'scheduled') RETURNING id`, PATIENT_UID, DRUG);
    const p2 = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, scheduled_time, status)
       VALUES ($1::uuid, $2, NULL, 'scheduled') RETURNING id`, PATIENT_UID, DRUG);
    await administer(p1[0].id);
    await expect(administer(p2[0].id)).resolves.toBeDefined(); // PRN exempt
  });

  it('C-L2: rejects a second SCHEDULED row for the same patient+medication+scheduled_time', async () => {
    await seedRow('2026-06-20T08:00:00Z');
    let code = null;
    try {
      await seedRow('2026-06-20T08:00:00Z');
    } catch (err) {
      code = pgErrorCode(err);
    }
    expect(code).toBe('23505');
  });

  it('C-L2: scheduleMedications losing the insert race returns the winner row, creates nothing, emits no event', async () => {
    const drug = `${DRUG}_RACE_${randomUUID().slice(0, 8)}`;
    const slot = '2026-06-21T08:00:00Z';

    const inserted = deferred();
    const releaseCommit = deferred();
    let winnerId = null;

    // Winner: inserts the scheduled row but holds the transaction open, so the
    // service's Phase-0 pre-check (plain prisma, read-committed) cannot see it.
    const winnerTx = prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
         VALUES ($1::uuid, $2, '500mg', 'oral', $3::timestamptz, 'scheduled') RETURNING id`,
        PATIENT_UID, drug, slot,
      );
      winnerId = rows[0].id;
      inserted.resolve();
      await releaseCommit.promise;
    }, { timeout: 30_000, maxWait: 10_000 });

    await inserted.promise;

    // Loser: passes the pre-check, then its INSERT queues on the
    // uniq_mar_scheduled_dose index entry held by the winner's open tx.
    const loser = scheduleMedications(PATIENT_UID, null, [{
      medication_name: drug, dose: '500mg', route: 'oral', scheduled_time: slot,
    }], { tenantId: DEFAULT_TENANT });

    await new Promise((resolve) => setTimeout(resolve, 750));
    releaseCommit.resolve();
    await winnerTx;

    const results = await loser;
    expect(results).toHaveLength(1);
    expect(Number(results[0].id)).toBe(Number(winnerId)); // idempotent return of the winner

    // Exactly one physical row for the slot.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM medication_administrations WHERE patient_uid = $1::uuid AND medication_name = $2`,
      PATIENT_UID, drug,
    );
    expect(rows).toHaveLength(1);

    // The losing call created nothing, so it emitted no canonical
    // mar.scheduled event for the dedupe-return.
    const events = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND event_type = 'mar.scheduled' AND source_id = $2`,
      PATIENT_UID, String(winnerId),
    );
    expect(events).toHaveLength(0);
  }, 60_000);

  it('C-L2: an uncontended schedule still creates the row and emits exactly one mar.scheduled event', async () => {
    const drug = `${DRUG}_CLEAN_${randomUUID().slice(0, 8)}`;
    const results = await scheduleMedications(PATIENT_UID, null, [{
      medication_name: drug, dose: '250mg', route: 'oral', scheduled_time: '2026-06-22T08:00:00Z',
    }], { tenantId: DEFAULT_TENANT });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('scheduled');

    const events = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND event_type = 'mar.scheduled' AND source_id = $2`,
      PATIENT_UID, String(results[0].id),
    );
    expect(events).toHaveLength(1);
  });
});
