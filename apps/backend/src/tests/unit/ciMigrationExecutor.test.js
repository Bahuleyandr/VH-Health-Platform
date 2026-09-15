import { jest } from '@jest/globals';

import {
  ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL,
  TRACK_MIGRATION_SQL,
  executeCiMigrationFile,
} from '../../../scripts/lib/ciMigrationExecutor.mjs';
import { migrationChecksum } from '../../../scripts/lib/migrationChecksum.mjs';

function client() {
  return { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
}

describe('ci migration executor directives', () => {
  test('runs a concurrent-index migration statement-by-statement without BEGIN', async () => {
    const db = client();
    const migrationSql = `-- @no-transaction
-- @statement_timeout: 0
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_test ON test_table (id);`;

    await executeCiMigrationFile({
      client: db,
      file: '999_concurrent.sql',
      sql: migrationSql,
    });

    const statements = db.query.mock.calls.map(([sql]) => sql);
    expect(statements).not.toContain('BEGIN');
    expect(statements).toContain("SET statement_timeout = '0'");
    expect(statements.some((sql) => String(sql).includes('CREATE INDEX CONCURRENTLY'))).toBe(true);
    expect(statements).toContain("SET statement_timeout = '120s'");
    expect(db.query.mock.calls.at(-3)).toEqual([
      'INSERT INTO _migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      ['999_concurrent.sql', migrationChecksum(migrationSql)],
    ]);
  });

  test('adds the checksum column before recording a fresh baseline', async () => {
    const db = client();
    const sql = 'CREATE TABLE public._migrations (name text PRIMARY KEY);';

    await executeCiMigrationFile({
      client: db,
      file: '000_baseline.sql',
      sql,
      baseline: true,
    });

    expect(db.query.mock.calls.map(([statement]) => statement)).toEqual([
      sql,
      ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL,
      'INSERT INTO _migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
    ]);
    expect(db.query.mock.calls.at(-1)[1]).toEqual([
      '000_baseline.sql',
      migrationChecksum(sql),
    ]);
  });

  test('honors a statement timeout on the normal transactional path', async () => {
    const db = client();

    await executeCiMigrationFile({
      client: db,
      file: '999_timeout.sql',
      sql: '-- @statement_timeout: 600s\nUPDATE test_table SET id = id;',
    });

    const statements = db.query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('BEGIN');
    expect(statements).toContain("SET LOCAL statement_timeout = '600s'");
    expect(statements).toContain('COMMIT');
  });

  test('rolls back a normal migration failure but leaves no-transaction recovery to idempotent SQL', async () => {
    const transactional = client();
    transactional.query.mockImplementation(async (sql) => {
      if (String(sql).includes('UPDATE test_table')) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    await expect(executeCiMigrationFile({
      client: transactional,
      file: '999_tx.sql',
      sql: 'UPDATE test_table SET id = id;',
    })).rejects.toThrow('boom');
    expect(transactional.query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');

    const nonTransactional = client();
    nonTransactional.query.mockImplementation(async (sql) => {
      if (String(sql).includes('CREATE INDEX CONCURRENTLY')) throw new Error('boom');
      return { rows: [], rowCount: 0 };
    });
    await expect(executeCiMigrationFile({
      client: nonTransactional,
      file: '999_no_tx.sql',
      sql: '-- @no-transaction\nCREATE INDEX CONCURRENTLY idx_test ON test_table (id);',
    })).rejects.toThrow('boom');
    expect(nonTransactional.query.mock.calls.map(([sql]) => sql)).not.toContain('ROLLBACK');
  });
});

const READ_TIMEOUTS = "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout";
const SET_LOCK_TIMEOUT = "SELECT set_config('lock_timeout', $1, false)";
const SET_STATEMENT_TIMEOUT = "SELECT set_config('statement_timeout', $1, false)";
const RESTORE_TIMEOUT = 'SELECT set_config($1, $2, false)';
const SELF_MANAGED_SQL = 'BEGIN; SELECT 1; COMMIT;';

function sessionClient(incoming, fail = () => null) {
  const settings = { ...incoming };
  const observed = [];
  const db = { settings, observed, query: jest.fn(async (sql, values) => {
    observed.push({ sql, values, settings: { ...settings } });
    const error = fail(sql, values);
    if (error) throw error;
    if (sql === READ_TIMEOUTS) return { rows: [{ ...settings }] };
    if (sql === SET_LOCK_TIMEOUT) settings.lock_timeout = values[0];
    if (sql === SET_STATEMENT_TIMEOUT) settings.statement_timeout = values[0];
    if (sql === RESTORE_TIMEOUT) settings[values[0]] = values[1];
    return { rows: [], rowCount: 0 };
  }) };
  return db;
}

describe('self-managed migration session timeouts', () => {
  test.each([
    { label: 'default budgets from unlimited session', directive: '', timeout: '120s', statement: '0', lock: '0' },
    { label: 'explicit directive from inherited budgets', directive: '-- @statement_timeout: 600s\n', timeout: '600s', statement: '2min', lock: '15s' },
    { label: 'explicit unlimited directive', directive: '-- @statement_timeout: 0\n', timeout: '0', statement: '45s', lock: '3s' },
  ])('$label', async ({ directive, timeout, statement, lock }) => {
    const incoming = { statement_timeout: statement, lock_timeout: lock };
    const db = sessionClient(incoming);
    const sql = directive + SELF_MANAGED_SQL;
    const result = await executeCiMigrationFile({ client: db, file: 'self.sql', sql, selfManaged: true });

    expect(result.mode).toBe('self-managed');
    expect(db.query.mock.calls).toEqual([
      [READ_TIMEOUTS],
      [SET_LOCK_TIMEOUT, ['15s']],
      [SET_STATEMENT_TIMEOUT, [timeout]],
      [sql],
      [TRACK_MIGRATION_SQL, ['self.sql', migrationChecksum(sql)]],
      [RESTORE_TIMEOUT, ['statement_timeout', statement]],
      [RESTORE_TIMEOUT, ['lock_timeout', lock]],
    ]);
    expect(db.observed.find((call) => call.sql === sql).settings).toEqual({ statement_timeout: timeout, lock_timeout: '15s' });
    expect(db.settings).toEqual(incoming);
  });

  test('a failed timeout read never changes settings or submits migration SQL', async () => {
    const failure = new Error('read settings failed');
    const incoming = { statement_timeout: '0', lock_timeout: '0' };
    const db = sessionClient(incoming, (sql) => sql === READ_TIMEOUTS ? failure : null);
    await expect(executeCiMigrationFile({ client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true }))
      .rejects.toBe(failure);
    expect(db.query.mock.calls).toEqual([[READ_TIMEOUTS]]);
    expect(db.settings).toEqual(incoming);
  });

  test('missing captured settings fail before any session mutation or migration SQL', async () => {
    const db = client();
    await expect(executeCiMigrationFile({ client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true }))
      .rejects.toThrow('Cannot capture self-managed migration session timeouts');
    expect(db.query.mock.calls).toEqual([[READ_TIMEOUTS]]);
  });

  test.each([
    { label: 'lock setup', failingSql: SET_LOCK_TIMEOUT, executesSql: false },
    { label: 'statement setup', failingSql: SET_STATEMENT_TIMEOUT, executesSql: false },
    { label: 'migration SQL', failingSql: SELF_MANAGED_SQL, executesSql: true },
    { label: 'tracker insertion', failingSql: TRACK_MIGRATION_SQL, executesSql: true },
  ])('restores both settings after rollback on $label failure', async ({ failingSql, executesSql }) => {
    const failure = Object.assign(new Error('original migration failure'), { code: '57014' });
    const incoming = { statement_timeout: '0', lock_timeout: '7s' };
    const db = sessionClient(incoming, (sql) => sql === failingSql ? failure : null);
    await expect(executeCiMigrationFile({ client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true }))
      .rejects.toBe(failure);
    expect(db.query.mock.calls.slice(-3)).toEqual([
      ['ROLLBACK'],
      [RESTORE_TIMEOUT, ['statement_timeout', '0']],
      [RESTORE_TIMEOUT, ['lock_timeout', '7s']],
    ]);
    expect(db.query.mock.calls.some(([sql]) => sql === SELF_MANAGED_SQL)).toBe(executesSql);
    expect(db.query.mock.calls.some(([sql]) => sql === TRACK_MIGRATION_SQL)).toBe(failingSql === TRACK_MIGRATION_SQL);
    expect(db.settings).toEqual(incoming);
  });

  test.each(['statement_timeout', 'lock_timeout', 'both'])('reports %s restoration failure and still attempts both restores', async (setting) => {
    const failures = {
      statement_timeout: new Error('statement restore failed'), lock_timeout: new Error('lock restore failed'),
    };
    const db = sessionClient({ statement_timeout: '0', lock_timeout: '0' }, (sql, values) => (
      sql === RESTORE_TIMEOUT && (setting === 'both' || values[0] === setting) ? failures[values[0]] : null
    ));
    const expected = setting === 'both' ? Object.values(failures) : [failures[setting]];
    await expect(executeCiMigrationFile({ client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true }))
      .rejects.toMatchObject({ name: 'AggregateError', errors: expected });
    expect(db.query.mock.calls.slice(-2)).toEqual([
      [RESTORE_TIMEOUT, ['statement_timeout', '0']], [RESTORE_TIMEOUT, ['lock_timeout', '0']],
    ]);
    expect(db.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
    if (setting !== 'both') {
      expect(db.settings[setting === 'lock_timeout' ? 'statement_timeout' : 'lock_timeout']).toBe('0');
    }
  });

  test('retains the original failure and every cleanup failure without masking any', async () => {
    const original = Object.assign(new Error('migration SQL failed'), { code: '23514' });
    const rollback = new Error('rollback failed');
    const statement = new Error('statement restore failed');
    const lock = new Error('lock restore failed');
    const db = sessionClient({ statement_timeout: '0', lock_timeout: '0' }, (sql, values) => {
      if (sql === SELF_MANAGED_SQL) return original;
      if (sql === 'ROLLBACK') return rollback;
      if (sql === RESTORE_TIMEOUT) return values[0] === 'statement_timeout' ? statement : lock;
      return null;
    });
    const result = executeCiMigrationFile({ client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true });
    await expect(result).rejects.toMatchObject({
      name: 'AggregateError', cause: original, errors: [original, rollback, statement, lock],
      message: expect.stringContaining('migration SQL failed; rollback failed; statement restore failed; lock restore failed'),
    });
    expect(db.query.mock.calls.slice(-3).map(([sql]) => sql)).toEqual(['ROLLBACK', RESTORE_TIMEOUT, RESTORE_TIMEOUT]);
  });

  test('a rollback failure does not prevent restoration of either session setting', async () => {
    const original = new Error('SQL failed');
    const rollback = new Error('rollback failed');
    const incoming = { statement_timeout: '30s', lock_timeout: '2s' };
    const db = sessionClient(incoming, (sql) => sql === SELF_MANAGED_SQL ? original : sql === 'ROLLBACK' ? rollback : null);
    await expect(executeCiMigrationFile({ client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true }))
      .rejects.toMatchObject({ cause: original, errors: [original, rollback] });
    expect(db.settings).toEqual(incoming);
  });

  test('baseline remains exempt even when classified as self-managed', async () => {
    const db = client();
    await executeCiMigrationFile({ client: db, file: '000_baseline.sql', sql: SELF_MANAGED_SQL, baseline: true, selfManaged: true });
    expect(db.query.mock.calls).toEqual([
      [SELF_MANAGED_SQL], [ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL],
      [TRACK_MIGRATION_SQL, ['000_baseline.sql', migrationChecksum(SELF_MANAGED_SQL)]],
    ]);
  });

  test('forced transactional handling keeps precedence and its concurrency preflight', async () => {
    const db = client();
    const beforeTransaction = jest.fn(async () => ({ skipMigration: true }));
    const result = await executeCiMigrationFile({
      client: db, file: 'self.sql', sql: SELF_MANAGED_SQL, selfManaged: true, forceTransactional: true, beforeTransaction,
    });
    expect(result.mode).toBe('concurrent-already-applied');
    expect(beforeTransaction).toHaveBeenCalledWith(db);
    expect(db.query.mock.calls).toEqual([
      ['BEGIN'], ["SET LOCAL lock_timeout = '15s'"], ["SET LOCAL statement_timeout = '120s'"], ['COMMIT'],
    ]);
  });

  test('no-transaction directives keep precedence over self-managed classification', async () => {
    const db = client();
    const result = await executeCiMigrationFile({
      client: db, file: 'self.sql', sql: '-- @no-transaction\nBEGIN; SELECT 1; COMMIT;', selfManaged: true,
    });
    expect(result.mode).toBe('no-transaction');
    expect(db.query.mock.calls.map(([sql]) => sql)).not.toContain(READ_TIMEOUTS);
    expect(db.query.mock.calls.map(([sql]) => sql)).not.toContain('BEGIN');
    expect(db.query.mock.calls.map(([sql]) => sql)).toContain('SELECT 1');
  });
});
