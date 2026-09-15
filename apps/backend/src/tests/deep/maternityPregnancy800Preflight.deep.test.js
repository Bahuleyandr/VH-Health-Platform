import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import { DOMAINS, TARGET_MIGRATION, collectPregnancy800Report }
  from '../../../scripts/maternity-pregnancy-800-preflight.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('migration 800 preflight PostgreSQL visibility and domain evidence', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const schema = `pregnancy800_preflight_${suffix}`;
  const role = `pregnancy800_reader_${suffix}`;
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  let connected = false;
  let schemaCreated = false;
  let roleCreated = false;

  const collect = () => collectPregnancy800Report(client, { schemaName: schema });
  const predicate = domain => {
    const membership = `${domain.column} IN (${domain.values.map(value => `'${value}'`).join(', ')})`;
    return domain.nullable ? `${domain.column} IS NULL OR ${membership}` : membership;
  };

  async function insert({ edd = null, booking = 'booked', status = 'ongoing' } = {}) {
    await client.query(`INSERT INTO ${schema}.maternity_pregnancies
      (tenant_id, edd_method, booking_status, status) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), edd, booking, status]);
  }

  async function addChecks() {
    for (const domain of DOMAINS) {
      await client.query(`ALTER TABLE ${schema}.maternity_pregnancies
        ADD CONSTRAINT maternity_pregnancies_${domain.column}_check CHECK (${predicate(domain)}) NOT VALID`);
    }
  }

  beforeAll(async () => {
    await client.connect();
    connected = true;
    await client.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    roleCreated = true;
  });

  beforeEach(async () => {
    await client.query(`CREATE TABLE ${schema}.maternity_pregnancies (
      id serial PRIMARY KEY, tenant_id uuid NOT NULL, edd_method varchar(20),
      booking_status varchar(20) NOT NULL, status varchar(20) NOT NULL
    )`);
    await client.query(`CREATE TABLE ${schema}._migrations (name text PRIMARY KEY, checksum text)`);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await client.query('RESET ROLE');
    await client.query(`DROP TABLE IF EXISTS ${schema}.maternity_pregnancies, ${schema}._migrations`);
  });

  afterAll(async () => {
    if (connected) {
      try {
        if (schemaCreated) await client.query(`DROP SCHEMA ${schema} CASCADE`);
        if (roleCreated) await client.query(`DROP ROLE ${role}`);
      } finally { await client.end(); }
    }
  });

  test('reports a truly empty ordinary relation without authorizing rollout', async () => {
    const report = await collect();
    expect(report.total_rows).toBe('0');
    expect(report.domains).toHaveLength(3);
    expect(report.domains.every(domain => !domain.present)).toBe(true);
    expect(report.authorizes_rollout).toBe(false);
    expect(report.stop_reasons).toContain('EMPTY_POPULATION_NOT_CLINICAL_VALIDATION');
  });

  test('counts all tenants and all three invalid domains without treating NULL EDD as invalid', async () => {
    await insert();
    await insert({ edd: 'historical', booking: 'historical', status: 'historical' });
    const report = await collect();
    expect(report.total_rows).toBe('2');
    expect(report.domains.map(domain => domain.violating_rows)).toEqual(['1', '1', '1']);
    expect(report.stop_reasons).toContain('CLINICAL_RECORDS_REVIEW_REQUIRED');
    expect((await client.query(`SELECT count(*)::text AS n FROM ${schema}.maternity_pregnancies`)).rows[0].n).toBe('2');
  });

  test('recognizes named deparsed checks and tracked checksum without claiming candidate comparison', async () => {
    await insert();
    await addChecks();
    for (const domain of DOMAINS) {
      await client.query(`ALTER TABLE ${schema}.maternity_pregnancies
        VALIDATE CONSTRAINT maternity_pregnancies_${domain.column}_check`);
    }
    await client.query(`INSERT INTO ${schema}._migrations (name, checksum) VALUES ($1, $2)`,
      [TARGET_MIGRATION, 'a'.repeat(64)]);
    const report = await collect();
    expect(report.total_rows).toBe('1');
    expect(report.domains.every(domain => domain.present && domain.validated && domain.definition.startsWith('CHECK'))).toBe(true);
    expect(report.tracker).toEqual({ applied: true, recorded_checksum: 'a'.repeat(64), candidate_checksum_verified: false });
    expect(report.authorizes_rollout).toBe(false);
  });

  test('reports NOT VALID historical rows while an ordinary update fails with 23514', async () => {
    await insert({ status: 'historical' });
    await addChecks();
    const report = await collect();
    expect(report.total_rows).toBe('1');
    expect(report.domains[2]).toMatchObject({ present: true, validated: false, violating_rows: '1' });
    await expect(client.query(`UPDATE ${schema}.maternity_pregnancies SET booking_status = 'booked'`))
      .rejects.toMatchObject({ code: '23514', constraint: 'maternity_pregnancies_status_check' });
  });

  test('rejects misleading same-name constraint definitions', async () => {
    await client.query(`ALTER TABLE ${schema}.maternity_pregnancies
      ADD CONSTRAINT maternity_pregnancies_status_check CHECK (status IS NOT NULL)`);
    await expect(collect()).rejects.toThrow('CONSTRAINT_LINEAGE_MISMATCH');
  });

  test('does not erase parentheses inside a deparsed CHECK literal', async () => {
    await client.query(`ALTER TABLE ${schema}.maternity_pregnancies
      ADD CONSTRAINT maternity_pregnancies_status_check
      CHECK (status IN ('on(go)ing', 'delivered', 'aborted', 'still_birth', 'transferred'))`);
    await expect(collect()).rejects.toThrow('CONSTRAINT_LINEAGE_MISMATCH');
  });

  test('refuses the filtered runtime role and counts both tenants only under existing complete visibility', async () => {
    await insert();
    await insert();
    await client.query(`ALTER TABLE ${schema}.maternity_pregnancies ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${schema}.maternity_pregnancies FORCE ROW LEVEL SECURITY`);
    await client.query(`CREATE POLICY deny_rows ON ${schema}.maternity_pregnancies USING (false)`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    expect((await client.query(`SELECT count(*)::text AS n FROM ${schema}.maternity_pregnancies`)).rows[0].n).toBe('2');
    await client.query(`SET ROLE ${role}`);
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL row_security = off');
      try {
        await expect(client.query(`SELECT count(*) FROM ${schema}.maternity_pregnancies`))
          .rejects.toMatchObject({ code: '42501' });
      } finally { await client.query('ROLLBACK'); }
      await expect(collect()).rejects.toThrow('SESSION_VISIBILITY_UNPROVEN');
    }
    finally { await client.query('RESET ROLE'); }
    const report = await collect();
    expect(report.total_rows).toBe('2');
    expect(report.relations.find(row => row.relname === 'maternity_pregnancies').relforcerowsecurity).toBe(true);
  });

  test('actual report transaction cannot write even with owner credentials', async () => {
    await insert();
    const guarded = { query: async (sql, params) => {
      if (sql.includes('AS total_rows')) {
        await client.query(`UPDATE ${schema}.maternity_pregnancies SET status = 'delivered'`);
      }
      return client.query(sql, params);
    } };
    await expect(collectPregnancy800Report(guarded, { schemaName: schema }))
      .rejects.toMatchObject({ code: '25006' });
    expect((await client.query(`SELECT status FROM ${schema}.maternity_pregnancies`)).rows).toEqual([{ status: 'ongoing' }]);
  });

  test('fails a conflicting DDL lock wait without leaving a report transaction open', async () => {
    const blocker = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE ${schema}.maternity_pregnancies IN ACCESS EXCLUSIVE MODE`);
      await expect(collect()).rejects.toMatchObject({ code: '55P03' });
      expect((await client.query("SELECT current_setting('transaction_read_only') AS state")).rows[0].state).toBe('off');
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
  }, 15000);
});
