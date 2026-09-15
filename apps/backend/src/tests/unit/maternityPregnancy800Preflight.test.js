import { jest } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACKNOWLEDGEMENT_FLAG, DOMAINS, LIMITS, TARGET_MIGRATION,
  assertOperationalSafety, collectPregnancy800Report, matchesDomainExpression,
  parseArgs, runPregnancy800Preflight,
} from '../../../scripts/maternity-pregnancy-800-preflight.mjs';

function fixture(overrides = {}) {
  const state = {
    session: { read_only: 'on', isolation: 'repeatable read', row_security: 'off',
      lock_timeout: '5s', statement_timeout: '30s', server_version_num: '170010',
      replica: false, observed_at: '2026-09-11 00:00:00+00', complete_visibility: true },
    relations: ['_migrations', 'maternity_pregnancies'].map((relname, index) => ({
      oid: String(index + 100), relname, relkind: 'r', relrowsecurity: true,
      relforcerowsecurity: true, can_select: true, inherited: false, locked: true,
    })),
    columns: [
      { name: 'booking_status', type: 'character varying(20)', not_null: true },
      { name: 'edd_method', type: 'character varying(20)', not_null: false },
      { name: 'id', type: 'integer', not_null: true },
      { name: 'status', type: 'character varying(20)', not_null: true },
      { name: 'tenant_id', type: 'uuid', not_null: true },
    ],
    constraints: [], tracker: [],
    population: { total_rows: '2', invalid_edd_method: '0', invalid_booking_status: '0', invalid_status: '0' },
    ...overrides,
  };
  const client = {
    connect: jest.fn(async () => {}), end: jest.fn(async () => {}),
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [state.session] };
      if (sql.includes('FROM pg_catalog.pg_class')) return { rows: state.relations };
      if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: state.columns };
      if (sql.includes('FROM pg_catalog.pg_constraint')) return { rows: state.constraints };
      if (sql.includes('SELECT name, checksum')) return { rows: state.tracker };
      if (sql.includes('AS total_rows')) return { rows: state.population ? [state.population] : [] };
      return { rows: [] };
    }),
  };
  return { client, state };
}

const options = { acknowledged: true, databaseUrl: 'postgresql://localhost/test' };

describe('migration 800 read-only preflight', () => {
  test('requires explicit scope acknowledgement and a dedicated DSN', () => {
    expect(() => assertOperationalSafety({ ...options, acknowledged: false })).toThrow('ALL_TENANT');
    expect(() => assertOperationalSafety({ acknowledged: true })).toThrow('DATABASE_URL_REQUIRED');
    expect(() => assertOperationalSafety({ ...options, databaseUrl: 'not a URL' })).toThrow('INVALID_DATABASE_URL');
    expect(() => assertOperationalSafety({ ...options, databaseUrl: 'https://localhost/test' })).toThrow('INVALID_DATABASE_URL');
  });

  test('refuses connection options that could override its safety settings', () => {
    expect(() => assertOperationalSafety({ ...options,
      databaseUrl: 'postgresql://localhost/test?options=-c%20statement_timeout%3D0',
    })).toThrow('DATABASE_URL_OPTIONS_NOT_ALLOWED');
  });

  test('has no sampled, acceptance, correction or schema CLI mode', () => {
    expect(parseArgs([ACKNOWLEDGEMENT_FLAG, '--export', '/tmp/report.json']))
      .toEqual({ acknowledged: true, exportPath: '/tmp/report.json' });
    for (const argument of ['--tenant', '--accept', '--fix', '--schema', '--export']) {
      expect(() => parseArgs([argument])).toThrow('INVALID_ARGUMENT');
    }
  });

  test('pins safety and table locks before the first snapshot query', async () => {
    const { client } = fixture();
    const report = await collectPregnancy800Report(client);
    expect(client.query.mock.calls.slice(0, 7).map(([sql]) => sql)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "SET LOCAL lock_timeout = '5000ms'", "SET LOCAL statement_timeout = '30000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '30s'", 'SET LOCAL row_security = off',
      'SET LOCAL search_path = pg_catalog',
      'LOCK TABLE "public".maternity_pregnancies, "public"._migrations IN ACCESS SHARE MODE',
    ]);
    expect(client.query.mock.calls.at(-1)).toEqual(['COMMIT']);
    expect(report).toMatchObject({ total_rows: '2', authorizes_rollout: false, status: 'report_only' });
    expect(report.domains).toHaveLength(3);
    expect(report.domains.every(domain => !domain.present)).toBe(true);
  });

  test.each([
    ['read_only', 'off'], ['isolation', 'read committed'], ['row_security', 'on'],
    ['complete_visibility', false], ['statement_timeout', '0'], ['lock_timeout', '0'],
  ])('rejects unsafe session %s before population queries', async (key, value) => {
    const { client, state } = fixture();
    state.session[key] = value;
    await expect(collectPregnancy800Report(client)).rejects.toThrow('SESSION_VISIBILITY_UNPROVEN');
    expect(client.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('AS total_rows'))).toBe(false);
  });

  test.each([['replica', true, 'PRIMARY_SNAPSHOT_REQUIRED'], ['server_version_num', '180001', 'POSTGRES_17_REQUIRED']])(
    'rejects unsupported %s', async (key, value, code) => {
      const { client, state } = fixture();
      state.session[key] = value;
      await expect(collectPregnancy800Report(client)).rejects.toThrow(code);
    },
  );

  test.each(['inherited', 'locked', 'can_select', 'relkind'])('rejects unproven relation %s', async key => {
    const { client, state } = fixture();
    state.relations[1][key] = key === 'inherited' ? true : key === 'relkind' ? 'p' : false;
    await expect(collectPregnancy800Report(client)).rejects.toThrow('RELATION_SCOPE_UNPROVEN');
  });

  test('rejects missing relation and changed column type/nullability', async () => {
    const missing = fixture({ relations: [] });
    await expect(collectPregnancy800Report(missing.client)).rejects.toThrow('RELATION_SCOPE_UNPROVEN');
    const changed = fixture();
    changed.state.columns[0].not_null = false;
    await expect(collectPregnancy800Report(changed.client)).rejects.toThrow('COLUMN_LINEAGE_MISMATCH');
  });

  test('accepts PostgreSQL IN and typed ANY spellings without widening the domains', () => {
    expect(DOMAINS).toHaveLength(3);
    for (const domain of DOMAINS) {
      const prefix = domain.nullable ? `${domain.column} IS NULL OR ` : '';
      const values = domain.values.map(value => `'${value}'::character varying`).join(', ');
      const expression = `${prefix}((${domain.column})::text = ANY ((ARRAY[${values}])::text[]))`;
      expect(matchesDomainExpression(expression, domain)).toBe(true);
      expect(matchesDomainExpression(`${expression} OR true`, domain)).toBe(false);
      expect(matchesDomainExpression(expression.replace(domain.values[0], 'unknown'), domain)).toBe(false);
      expect(matchesDomainExpression(expression.replaceAll(domain.column, `"${domain.column.toUpperCase()}"`), domain)).toBe(false);
    }
  });

  test('rejects a same-name constraint with the wrong predicate', async () => {
    const { client } = fixture({ constraints: [{ name: 'maternity_pregnancies_status_check',
      type: 'c', validated: true, expression: 'status IS NOT NULL', definition: 'CHECK (status IS NOT NULL)' }] });
    await expect(collectPregnancy800Report(client)).rejects.toThrow('CONSTRAINT_LINEAGE_MISMATCH');
  });

  test.each(['on(go)ing', 'ongoing :: text', 'on  going', 'on\tgoing'])('preserves literal content %s during deparse comparison', value => {
    const domain = DOMAINS[2];
    const values = domain.values.map(item => `'${item === 'ongoing' ? value : item}'`).join(', ');
    expect(matchesDomainExpression(`status IN (${values})`, domain)).toBe(false);
  });

  test('reports equivalent differently named constraints for lineage review', async () => {
    const { client } = fixture({ constraints: [{ name: 'legacy_status_domain', type: 'c', validated: false,
      expression: "status IN ('ongoing', 'delivered', 'aborted', 'still_birth', 'transferred')",
      definition: "CHECK (status IN ('ongoing', 'delivered', 'aborted', 'still_birth', 'transferred')) NOT VALID" }] });
    const report = await collectPregnancy800Report(client);
    expect(report.stop_reasons).toContain('EQUIVALENT_CONSTRAINT_LINEAGE_REVIEW_REQUIRED');
    expect(report.domains[2].equivalent_other_names).toEqual(['legacy_status_domain']);
  });

  test('rejects unproven tracker checksums and applied-but-missing catalog evidence', async () => {
    const invalid = fixture({ tracker: [{ name: TARGET_MIGRATION, checksum: null }] });
    await expect(collectPregnancy800Report(invalid.client)).rejects.toThrow('TRACKER_CHECKSUM_UNPROVEN');
    const missing = fixture({ tracker: [{ name: TARGET_MIGRATION, checksum: 'a'.repeat(64) }] });
    await expect(collectPregnancy800Report(missing.client)).rejects.toThrow('APPLIED_CATALOG_MISMATCH');
  });

  test('reports exact aggregate violations, not row values or identities', async () => {
    const { client } = fixture({ population: { total_rows: '2', invalid_edd_method: '1',
      invalid_booking_status: '0', invalid_status: '1' } });
    const report = await collectPregnancy800Report(client);
    expect(report.domains.map(domain => domain.violating_rows)).toEqual(['1', '0', '1']);
    expect(report.stop_reasons).toContain('CLINICAL_RECORDS_REVIEW_REQUIRED');
    const sql = client.query.mock.calls.find(([statement]) => statement.includes('AS total_rows'))[0];
    expect(sql.match(/IS FALSE/g)).toHaveLength(3);
    expect(sql).not.toMatch(/GROUP BY|LIMIT|patient_uid|WHERE tenant_id/i);
    expect(JSON.stringify(report)).not.toMatch(/patient_uid|pregnancy_number|observed_status/);
  });

  test('preserves bigint counts and identifies an empty population without approval', async () => {
    const empty = fixture({ population: { total_rows: '0', invalid_edd_method: '0',
      invalid_booking_status: '0', invalid_status: '0' } });
    const report = await collectPregnancy800Report(empty.client);
    expect(report.stop_reasons).toContain('EMPTY_POPULATION_NOT_CLINICAL_VALIDATION');
    expect(report.authorizes_rollout).toBe(false);
    const large = fixture();
    large.state.population.total_rows = '9007199254740993';
    expect((await collectPregnancy800Report(large.client)).total_rows).toBe('9007199254740993');
  });

  test('refuses missing, malformed and impossible population results', async () => {
    for (const population of [null, {}, { total_rows: '0', invalid_edd_method: '1' }]) {
      const { client } = fixture({ population });
      await expect(collectPregnancy800Report(client)).rejects.toThrow('INCOMPLETE_POPULATION');
      expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    }
  });

  test('does not swallow lock failures or publish a partial report', async () => {
    const { client } = fixture();
    client.query.mockImplementation(async sql => {
      if (sql.startsWith('LOCK TABLE')) throw Object.assign(new Error('lock wait'), { code: '55P03' });
      return { rows: [] };
    });
    await expect(collectPregnancy800Report(client)).rejects.toMatchObject({ code: '55P03' });
    expect(client.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });

  test('pins connection limits, closes the client, and never overwrites exported evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'maternity-800-preflight-'));
    const exportPath = join(directory, 'report.json');
    const { client } = fixture();
    const clientFactory = jest.fn(async () => client);
    try {
      await runPregnancy800Preflight({ ...options, clientFactory, exportPath });
      expect(clientFactory.mock.calls[0][0]).toMatchObject({
        connectionTimeoutMillis: LIMITS.connectionMs, query_timeout: 35000,
        statement_timeout: 30000, lock_timeout: 5000, options: '-c default_transaction_read_only=on',
      });
      const before = await readFile(exportPath, 'utf8');
      expect(JSON.parse(before).report_sha256).toMatch(/^[a-f0-9]{64}$/);
      await expect(runPregnancy800Preflight({ ...options, clientFactory, exportPath }))
        .rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(exportPath, 'utf8')).toBe(before);
      expect(client.end).toHaveBeenCalledTimes(2);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('does not create a client before authorization and closes a failed connection', async () => {
    const { client } = fixture();
    const clientFactory = jest.fn(async () => client);
    await expect(runPregnancy800Preflight({ clientFactory })).rejects.toThrow('ALL_TENANT');
    expect(clientFactory).not.toHaveBeenCalled();
    client.connect.mockRejectedValue(new Error('connection failed'));
    await expect(runPregnancy800Preflight({ ...options, clientFactory })).rejects.toThrow('connection failed');
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
