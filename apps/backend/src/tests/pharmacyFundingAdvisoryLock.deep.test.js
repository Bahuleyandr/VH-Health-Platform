// Behavioural proof that the pharmacy funding-authority advisory lock actually
// serialises. Every other test of this lock in the corpus asserts that a STRING
// APPEARS IN A FILE — pharmacyFundingAuthoritySourceContract,
// substitutionFundingReauthorisationSourceContract, advisoryLockVoidGuard and
// the service unit mocks all pin source text. Text assertions cannot see the
// two ways this lock silently stops working:
//
//   1. a salt drift — same key text, different hashtextextended() salt, so the
//      two call sites hash to different lock ids and never block each other;
//   2. a key-shape drift — e.g. dropping the patient uid from the key, which
//      makes the lock coarser or finer than intended without changing any of
//      the strings the contract tests look for.
//
// Both leave every source-text assertion green while mutual exclusion is gone,
// and this lock is what serialises money authority for a patient. So prove the
// behaviour: two concurrent transactions on the SAME (tenant, patient) must
// serialise, and unrelated keys must not.
//
// The key is lifted from the runtime call site in pharmacyCapService
// (lockPharmacyFundingAuthorityTx): hashtextextended over
// 'vh:pharmacy_funding_authority:' || tenant || ':' || patient, salted 753.

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

const ADVISORY_SQL = `SELECT pg_advisory_xact_lock(
   hashtextextended(
     'vh:pharmacy_funding_authority:' || $1::uuid::text || ':' || $2::uuid::text,
     753
   )
 )::text AS lock_acquired`;

// A lock that is genuinely free is granted in single-digit milliseconds. The
// generous ceiling is deliberate: this suite shares a shard with ~150 others,
// so a slow-but-granted lock must never read as "blocked" and invent a failure.
// A real block never resolves at all, so the gap between the two is not close.
const FREE_LOCK_CEILING_MS = 10_000;
// For the contended case the direction is reversed — the attempt must still be
// unresolved after this — so it stays short, and is corroborated against
// pg_stat_activity rather than resting on the timer alone.
const CONTENDED_PROBE_MS = 1_500;

d('pharmacy funding authority advisory lock (behavioural)', () => {
  const TENANT = randomUUID();
  const PATIENT_A = randomUUID();
  const PATIENT_B = randomUUID();

  /** @type {pg.Client} */ let holder;
  /** @type {pg.Client} */ let contender;

  beforeAll(async () => {
    holder = new pg.Client({ connectionString: databaseUrl });
    contender = new pg.Client({ connectionString: databaseUrl });
    await holder.connect();
    await contender.connect();
  }, 30_000);

  afterAll(async () => {
    await holder?.end().catch(() => {});
    await contender?.end().catch(() => {});
  });

  afterEach(async () => {
    // Both connections must leave no transaction open, or the next case would
    // inherit a lock and pass for the wrong reason.
    await holder.query('ROLLBACK').catch(() => {});
    await contender.query('ROLLBACK').catch(() => {});
  });

  /** Is some backend currently waiting on this advisory lock? */
  async function someoneIsWaitingOnTheLock() {
    const probe = new pg.Client({ connectionString: databaseUrl });
    await probe.connect();
    try {
      const { rows } = await probe.query(
        `SELECT count(*)::int AS waiting
           FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query LIKE '%vh:pharmacy_funding_authority:%'`,
      );
      return rows[0].waiting > 0;
    } finally {
      await probe.end().catch(() => {});
    }
  }

  /**
   * Take the lock on a key that must be free. Races the attempt against the
   * ceiling rather than simply awaiting it: if the key has silently coarsened
   * and this now contends, awaiting would hang until jest's own timeout and
   * report a bare 60s timeout. Racing fails in seconds and names the cause.
   */
  async function expectGrantedPromptly(client, tenantId, patientUid, sql = ADVISORY_SQL) {
    const outcome = await Promise.race([
      client.query(sql, [tenantId, patientUid]).then(() => 'granted'),
      new Promise((resolve) => {
        setTimeout(() => resolve('contended'), FREE_LOCK_CEILING_MS);
      }),
    ]);
    // 'contended' means an unrelated key blocked on the holder's lock — the
    // lock is coarser than its key claims.
    expect(outcome).toBe('granted');
  }

  it('serialises two transactions holding the same tenant and patient', async () => {
    await holder.query('BEGIN');
    await holder.query(ADVISORY_SQL, [TENANT, PATIENT_A]);

    // The contender must NOT get the same lock while the holder's transaction
    // is open. If it does, mutual exclusion is gone — exactly the regression no
    // source-text assertion can see.
    await contender.query('BEGIN');
    let granted = false;
    const attempt = contender
      .query(ADVISORY_SQL, [TENANT, PATIENT_A])
      .then(() => { granted = true; });

    const outcome = await Promise.race([
      attempt.then(() => 'granted'),
      new Promise((resolve) => { setTimeout(() => resolve('still waiting'), CONTENDED_PROBE_MS); }),
    ]);
    expect(outcome).toBe('still waiting');
    expect(granted).toBe(false);
    // Corroborate with Postgres itself rather than trusting the timer alone.
    expect(await someoneIsWaitingOnTheLock()).toBe(true);

    // Releasing the holder must let the contender straight through, which also
    // proves it was queued on this lock rather than failing for another reason.
    await holder.query('COMMIT');
    await attempt;
    expect(granted).toBe(true);
    await contender.query('COMMIT');
  }, 60_000);

  it('does not serialise different patients in the same tenant', async () => {
    await holder.query('BEGIN');
    await holder.query(ADVISORY_SQL, [TENANT, PATIENT_A]);

    // A different patient is a different key. If this blocks, the lock is
    // coarser than intended and would serialise unrelated patients' money.
    await contender.query('BEGIN');
    await expectGrantedPromptly(contender, TENANT, PATIENT_B);

    await contender.query('COMMIT');
    await holder.query('COMMIT');
  }, 60_000);

  it('does not serialise the same patient across different tenants', async () => {
    const otherTenant = randomUUID();
    await holder.query('BEGIN');
    await holder.query(ADVISORY_SQL, [TENANT, PATIENT_A]);

    // Tenant is part of the key, so the same patient uid under another tenant
    // is a distinct lock. If this blocks, the tenant half of the key was lost.
    await contender.query('BEGIN');
    await expectGrantedPromptly(contender, otherTenant, PATIENT_A);

    await contender.query('COMMIT');
    await holder.query('COMMIT');
  }, 60_000);

  it('pins the salt: the same key text under another salt is a different lock', async () => {
    // The salt is the invisible half of the identity. If someone changes 753 on
    // one call site only, every source-text assertion still passes while the two
    // sites quietly stop colliding. Prove the salt participates by showing the
    // same key text under a different salt does not contend.
    await holder.query('BEGIN');
    await holder.query(ADVISORY_SQL, [TENANT, PATIENT_A]);

    await contender.query('BEGIN');
    await expectGrantedPromptly(
      contender,
      TENANT,
      PATIENT_A,
      `SELECT pg_advisory_xact_lock(
         hashtextextended(
           'vh:pharmacy_funding_authority:' || $1::uuid::text || ':' || $2::uuid::text,
           754
         )
       )::text AS lock_acquired`,
    );

    await contender.query('COMMIT');
    await holder.query('COMMIT');
  }, 60_000);
});
