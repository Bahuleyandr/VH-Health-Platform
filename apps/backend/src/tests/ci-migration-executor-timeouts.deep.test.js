import { randomInt } from 'node:crypto';
import { Client } from 'pg';

import { executeCiMigrationFile } from '../../scripts/lib/ciMigrationExecutor.mjs';
import { migrationChecksum } from '../../scripts/lib/migrationChecksum.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const OBSERVE_TIMEOUTS = `INSERT INTO executor_timeout_observations
  SELECT (SELECT setting::integer FROM pg_settings WHERE name = 'statement_timeout'),
         (SELECT setting::integer FROM pg_settings WHERE name = 'lock_timeout'),
         pg_backend_pid();`;

async function sessionState(db) {
  const { rows: [state] } = await db.query(`SELECT
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout,
    pg_backend_pid() AS pid`);
  return state;
}

async function setIncoming(db, statement, lock) {
  await db.query("SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)", [statement, lock]);
  return sessionState(db);
}

describe('CI migration executor session budgets on PostgreSQL 17', () => {
  let db;

  beforeEach(async () => {
    if (!databaseUrl) throw new Error('PostgreSQL integration coverage requires TEST_DATABASE_URL or DATABASE_URL');
    db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await db.connect();
    const { rows: [version] } = await db.query("SELECT current_setting('server_version_num')::integer AS version");
    expect(version.version).toBeGreaterThanOrEqual(170000);
    expect(version.version).toBeLessThan(180000);
    await db.query(`SET search_path = pg_temp, pg_catalog;
      CREATE TEMP TABLE _migrations (name text PRIMARY KEY, checksum text);
      CREATE TEMP TABLE executor_timeout_observations (statement_ms integer, lock_ms integer, pid integer);
      CREATE TEMP TABLE executor_timeout_writes (id integer PRIMARY KEY);`);
    const { rows: [tracker] } = await db.query("SELECT '_migrations'::regclass::oid = 'pg_temp._migrations'::regclass::oid AS isolated");
    expect(tracker.isolated).toBe(true);
    expect((await db.query('INSERT INTO executor_timeout_writes VALUES (1) RETURNING id')).rows).toEqual([{ id: 1 }]);
    expect((await db.query("INSERT INTO _migrations VALUES ('fixture-control.sql', 'synthetic') RETURNING name")).rows)
      .toEqual([{ name: 'fixture-control.sql' }]);
    expect((await db.query('DELETE FROM executor_timeout_writes')).rowCount).toBe(1);
    expect((await db.query('DELETE FROM _migrations')).rowCount).toBe(1);
  });

  afterEach(async () => {
    // Closing this dedicated connection rolls back any open transaction and drops its temporary fixtures.
    if (db) await db.end();
    db = null;
  });

  test.each([
    { label: 'defaults from unlimited session', directive: '', statement: '0', lock: '0', expected: 120000 },
    { label: 'defaults from shorter deployment budgets', directive: '', statement: '60s', lock: '10s', expected: 120000 },
    { label: 'finite directive', directive: '-- @statement_timeout: 600s\n', statement: '42s', lock: '7s', expected: 600000 },
    { label: 'unlimited directive', directive: '-- @statement_timeout: 0\n', statement: '30s', lock: '2s', expected: 0 },
  ])('observes $label inside SQL and restores the exact same session', async ({ directive, statement, lock, expected }) => {
    const incoming = await setIncoming(db, statement, lock);
    const sql = `${directive}BEGIN; ${OBSERVE_TIMEOUTS} COMMIT;`;
    const result = await executeCiMigrationFile({ client: db, file: 'self.sql', sql, selfManaged: true });
    expect(result.mode).toBe('self-managed');
    expect((await db.query('SELECT * FROM executor_timeout_observations')).rows).toEqual([
      { statement_ms: expected, lock_ms: 15000, pid: incoming.pid },
    ]);
    expect((await db.query('SELECT name, checksum FROM _migrations')).rows).toEqual([
      { name: 'self.sql', checksum: migrationChecksum(sql) },
    ]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test.each([
    { label: 'unlimited', statement: '0', lock: '0' },
    { label: 'finite', statement: '40s', lock: '3s' },
  ])('cancels slow SQL, rolls back and restores $label incoming settings', async ({ statement, lock }) => {
    const incoming = await setIncoming(db, statement, lock);
    const sql = `-- @statement_timeout: 200ms
BEGIN;
INSERT INTO executor_timeout_writes VALUES (1);
SELECT pg_sleep(2);
COMMIT;`;
    await expect(executeCiMigrationFile({ client: db, file: 'cancel.sql', sql, selfManaged: true }))
      .rejects.toMatchObject({ code: '57014', message: expect.stringContaining('statement timeout') });
    expect(await sessionState(db)).toEqual(incoming);
    expect((await db.query('SELECT * FROM executor_timeout_writes')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM _migrations')).rows).toEqual([]);

    const followup = `BEGIN; ${OBSERVE_TIMEOUTS} COMMIT;`;
    await executeCiMigrationFile({ client: db, file: 'after-cancel.sql', sql: followup, selfManaged: true });
    expect((await db.query('SELECT name FROM _migrations')).rows).toEqual([{ name: 'after-cancel.sql' }]);
    expect((await db.query('SELECT * FROM executor_timeout_observations')).rows).toEqual([
      { statement_ms: 120000, lock_ms: 15000, pid: incoming.pid },
    ]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test('the real lock timeout cancels a blocked transaction before its longer statement deadline', async () => {
    const incoming = await setIncoming(db, '0', '0');
    const blocker = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    const key = [randomInt(1, 2147483647), randomInt(1, 2147483647)];
    try {
      await blocker.connect();
      const { rows: [owner] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      expect(owner.pid).not.toBe(incoming.pid);
      await blocker.query('SELECT pg_advisory_lock($1::integer, $2::integer)', key);
      const sql = `-- @statement_timeout: 20s
BEGIN;
INSERT INTO executor_timeout_writes VALUES (1);
SELECT pg_advisory_xact_lock(${key[0]}, ${key[1]});
COMMIT;`;
      await expect(executeCiMigrationFile({ client: db, file: 'locked.sql', sql, selfManaged: true }))
        .rejects.toMatchObject({ code: '55P03', message: expect.stringContaining('lock timeout') });
      expect(await sessionState(db)).toEqual(incoming);
      expect((await db.query('SELECT * FROM executor_timeout_writes')).rows).toEqual([]);
      expect((await db.query('SELECT * FROM _migrations')).rows).toEqual([]);
    } finally {
      await blocker.end();
    }
  }, 30000);

  test('SQL failure recovers the aborted transaction and never records the file', async () => {
    const incoming = await setIncoming(db, '25s', '4s');
    const sql = 'BEGIN; INSERT INTO executor_timeout_writes VALUES (1); SELECT 1 / 0; COMMIT;';
    await expect(executeCiMigrationFile({ client: db, file: 'invalid.sql', sql, selfManaged: true }))
      .rejects.toMatchObject({ code: '22012' });
    expect(await sessionState(db)).toEqual(incoming);
    expect((await db.query('SELECT * FROM executor_timeout_writes')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM _migrations')).rows).toEqual([]);
  });

  test('tracker failure does not pretend already-committed self-managed SQL was rolled back', async () => {
    const incoming = await setIncoming(db, '0', '0');
    await db.query("ALTER TABLE pg_temp._migrations ADD CONSTRAINT reject_fixture_name CHECK (name <> 'rejected.sql')");
    const sql = 'BEGIN; INSERT INTO executor_timeout_writes VALUES (1); COMMIT;';
    await expect(executeCiMigrationFile({ client: db, file: 'rejected.sql', sql, selfManaged: true }))
      .rejects.toMatchObject({ code: '23514', constraint: 'reject_fixture_name' });
    expect((await db.query('SELECT * FROM executor_timeout_writes')).rows).toEqual([{ id: 1 }]);
    expect((await db.query('SELECT * FROM _migrations')).rows).toEqual([]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test('restores captured settings even if successful migration SQL changes its session budgets', async () => {
    const incoming = await setIncoming(db, '0', '6s');
    const sql = "BEGIN; SET statement_timeout = '4s'; SET lock_timeout = '1s'; COMMIT;";
    await executeCiMigrationFile({ client: db, file: 'changes-settings.sql', sql, selfManaged: true });
    expect((await db.query('SELECT name, checksum FROM _migrations')).rows).toEqual([
      { name: 'changes-settings.sql', checksum: migrationChecksum(sql) },
    ]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test('keeps the existing tracker conflict behavior without overwriting the first checksum', async () => {
    const incoming = await setIncoming(db, '0', '0');
    const first = 'BEGIN; INSERT INTO executor_timeout_writes VALUES (1); COMMIT;';
    const second = 'BEGIN; INSERT INTO executor_timeout_writes VALUES (2); COMMIT;';
    await executeCiMigrationFile({ client: db, file: 'same.sql', sql: first, selfManaged: true });
    await executeCiMigrationFile({ client: db, file: 'same.sql', sql: second, selfManaged: true });
    expect((await db.query('SELECT * FROM executor_timeout_writes ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect((await db.query('SELECT name, checksum FROM _migrations')).rows).toEqual([
      { name: 'same.sql', checksum: migrationChecksum(first) },
    ]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test.each([
    { label: 'ordinary', options: {}, expectedMode: 'transactional', wrapped: false },
    { label: 'forced', options: { selfManaged: true, forceTransactional: true }, expectedMode: 'transactional-gated', wrapped: true },
  ])('preserves $label transactional budgets and atomic tracker failure', async ({ options, expectedMode, wrapped }) => {
    const incoming = await setIncoming(db, '0', '0');
    const sql = `-- @statement_timeout: 600s\n${wrapped ? 'BEGIN;' : ''} ${OBSERVE_TIMEOUTS} ${wrapped ? 'COMMIT;' : ''}`;
    const result = await executeCiMigrationFile({ client: db, file: 'ordinary.sql', sql, ...options });
    expect(result.mode).toBe(expectedMode);
    expect((await db.query('SELECT * FROM executor_timeout_observations')).rows).toEqual([
      { statement_ms: 600000, lock_ms: 15000, pid: incoming.pid },
    ]);
    await db.query("ALTER TABLE pg_temp._migrations ADD CONSTRAINT reject_fixture_name CHECK (name <> 'rejected.sql')");
    const rejectedSql = `${wrapped ? 'BEGIN;' : ''} INSERT INTO executor_timeout_writes VALUES (1); ${wrapped ? 'COMMIT;' : ''}`;
    await expect(executeCiMigrationFile({ client: db, file: 'rejected.sql', sql: rejectedSql, ...options }))
      .rejects.toMatchObject({ code: '23514' });
    expect((await db.query('SELECT * FROM executor_timeout_writes')).rows).toEqual([]);
    expect((await db.query('SELECT name, checksum FROM _migrations')).rows).toEqual([
      { name: 'ordinary.sql', checksum: migrationChecksum(sql) },
    ]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test('preserves forced-mode preflight skipping without applying SQL or recording a second file', async () => {
    const incoming = await setIncoming(db, '0', '0');
    let observed;
    const result = await executeCiMigrationFile({
      client: db, file: 'skip.sql', sql: 'BEGIN; SELECT 1 / 0; COMMIT;', selfManaged: true, forceTransactional: true,
      beforeTransaction: async (transaction) => {
        observed = await sessionState(transaction);
        return { skipMigration: true };
      },
    });
    expect(result.mode).toBe('concurrent-already-applied');
    expect(observed.pid).toBe(incoming.pid);
    expect((await db.query('SELECT * FROM _migrations')).rows).toEqual([]);
    expect(await sessionState(db)).toEqual(incoming);
  });

  test('preserves no-transaction directive precedence and its existing reset policy', async () => {
    const incoming = await setIncoming(db, '120s', '15s');
    const sql = `-- @no-transaction\n-- @statement_timeout: 0\nBEGIN; ${OBSERVE_TIMEOUTS} COMMIT;`;
    const result = await executeCiMigrationFile({ client: db, file: 'no-transaction.sql', sql, selfManaged: true });
    expect(result.mode).toBe('no-transaction');
    expect((await db.query('SELECT * FROM executor_timeout_observations')).rows).toEqual([
      { statement_ms: 0, lock_ms: 15000, pid: incoming.pid },
    ]);
    expect((await db.query('SELECT name, checksum FROM _migrations')).rows).toEqual([
      { name: 'no-transaction.sql', checksum: migrationChecksum(sql) },
    ]);
    expect(await sessionState(db)).toEqual(incoming);
  });
});
