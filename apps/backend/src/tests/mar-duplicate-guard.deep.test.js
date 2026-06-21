/**
 * MAR double-charting DB guard (audit §3 Clinical core & safety — migration 327).
 *
 * The application cross-row duplicate guard in recordAdministration is a
 * check-then-act SELECT with no lock (TOCTOU): two concurrent administrations of
 * sibling rows for the same patient + medication + scheduled slot could both
 * pass the check and chart the dose twice. A partial unique index makes a second
 * 'administered' row for the same (patient_uid, medication_name, scheduled_time)
 * impossible at the DB layer regardless of concurrency. PRN/unscheduled rows
 * (scheduled_time NULL) are exempt — they may legitimately be given more than once.
 */
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PATIENT_UID = 'a9999999-9999-4999-8999-999999999d01';
const DRUG = 'TESTDRUG_DUPGUARD_327';
const SCHED = '2026-06-19T08:00:00Z';

function pgErrorCode(err) {
  if (!err) return null;
  if (err.meta?.code) return String(err.meta.code);
  if (err.code && /^\d/.test(String(err.code))) return String(err.code);
  return /23505|duplicate key value/i.test(err.message || '') ? '23505' : null;
}

async function seedScheduled(scheduledTime) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO medication_administrations (patient_uid, medication_name, scheduled_time, status)
     VALUES ($1::uuid, $2, $3::timestamptz, 'scheduled')
     RETURNING id`,
    PATIENT_UID, DRUG, scheduledTime,
  );
  return rows[0].id;
}
async function administer(id) {
  return prisma.$executeRawUnsafe(
    `UPDATE medication_administrations SET status = 'administered', administered_at = NOW() WHERE id = $1`,
    id,
  );
}

d('MAR duplicate-administration DB guard (migration 327)', () => {
  async function cleanup() {
    await prisma.$executeRawUnsafe(
      `DELETE FROM medication_administrations WHERE medication_name = $1`, DRUG,
    ).catch(() => {});
  }
  beforeAll(cleanup);
  afterAll(async () => { await cleanup(); await prisma.$disconnect(); });

  it('rejects a second administered row for the same patient+medication+scheduled_time', async () => {
    const a = await seedScheduled(SCHED);
    const b = await seedScheduled(SCHED); // a duplicate sibling for the same dose

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
    const c = await seedScheduled('2026-06-19T20:00:00Z');
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
});
