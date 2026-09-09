// src/tests/deep/pruneRetentionPlan.deep.test.js
//
// The property migration 804 fixes is not "the prune is faster" — it is that
// the retention cutoff is an INDEX CONDITION rather than a per-row FILTER. A
// timing assertion would pass on a small CI table for the wrong reason, so this
// asserts the plan shape instead.
//
// Both arms run with enable_seqscan off, which makes the assertion independent
// of table size: the question is whether the planner CAN push the cutoff into
// idx_scheduled_job_runs_finished_retention, not whether it is currently worth
// doing. The control arm re-runs the identical query with the pre-804
// clock_timestamp() and asserts the defect is still visible, so a broken probe
// cannot report success.
import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const RETENTION_INDEX = 'idx_scheduled_job_runs_finished_retention';

const CANDIDATE_QUERY = fn => `
  SELECT run.id
    FROM public.scheduled_job_runs AS run
   WHERE run.aggregate_status <> 'running'
     AND run.finished_at < ${fn}() - INTERVAL '400 days'
   ORDER BY run.finished_at, run.id
   LIMIT 1000`;

describeIfDb('migration 804 — the retention cutoff reaches the index', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    if (client) { await client.end(); }
  });

  async function planFor(fn) {
    // SET LOCAL needs a transaction; the whole thing is read-only (EXPLAIN
    // without ANALYZE executes nothing) and is rolled back regardless.
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(`EXPLAIN ${CANDIDATE_QUERY(fn)}`);
      return rows.map(r => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
    }
  }

  it('has the schema this test is about — index and function both present', async () => {
    // Without these the plan assertions could pass or fail for reasons that
    // have nothing to do with migration 804.
    const { rows: idx } = await client.query(
      'SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2',
      ['scheduled_job_runs', RETENTION_INDEX],
    );
    expect(idx).toHaveLength(1);

    const { rows: fn } = await client.query(
      "SELECT prosrc, provolatile FROM pg_proc WHERE proname = 'prune_scheduled_job_run_evidence'",
    );
    expect(fn).toHaveLength(1);
    expect(fn[0].prosrc).toContain('statement_timestamp()');
    expect(fn[0].prosrc).not.toContain('clock_timestamp()');
  });

  it('classifies the two timestamp functions as this fix assumes', async () => {
    const { rows } = await client.query(
      `SELECT proname, provolatile FROM pg_proc
        WHERE proname IN ('clock_timestamp','statement_timestamp','now')
        ORDER BY proname`,
    );
    const volatility = Object.fromEntries(rows.map(r => [r.proname, r.provolatile]));
    expect(volatility.clock_timestamp).toBe('v'); // VOLATILE — cannot bound an index scan
    expect(volatility.statement_timestamp).toBe('s'); // STABLE
    expect(volatility.now).toBe('s');
  });

  it('pushes the cutoff into the retention index (the fixed behaviour)', async () => {
    const plan = await planFor('statement_timestamp');
    expect(plan).toContain(RETENTION_INDEX);
    expect(plan).toMatch(/Index Cond: \(finished_at < \(statement_timestamp\(\)/);
    expect(plan).not.toMatch(/Filter: \(finished_at </);
  });

  it('control arm — the pre-804 cutoff still degrades to a filter', async () => {
    // If this ever stops failing to reach the index, the assertion above has
    // stopped discriminating and the suite is no longer evidence of anything.
    const plan = await planFor('clock_timestamp');
    expect(plan).toContain(RETENTION_INDEX);
    expect(plan).toMatch(/Filter: \(finished_at < \(clock_timestamp\(\)/);
    expect(plan).not.toMatch(/Index Cond: \(finished_at < \(clock_timestamp\(\)/);
  });

  it('deletes nothing on a database younger than the retention window', async () => {
    // The whole cost this migration removes was being paid to delete zero rows.
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM public.scheduled_job_runs
        WHERE aggregate_status <> 'running'
          AND finished_at < statement_timestamp() - INTERVAL '400 days'`,
    );
    expect(rows[0].n).toBe(0);
  });
});
