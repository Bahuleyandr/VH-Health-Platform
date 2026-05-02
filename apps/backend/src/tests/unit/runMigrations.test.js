/**
 * Unit tests for the migration runner + the multi-statement SQL splitter.
 *
 * Background: Prisma's `$executeRawUnsafe` uses prepared statements which
 * Postgres restricts to a single command per call. A `.sql` file with
 * multiple semicolon-separated statements (which is most of our migrations)
 * was being rejected with `42601 — cannot insert multiple commands into a
 * prepared statement` — and the previous runner swallowed the error as
 * "non-fatal — schema managed by Prisma", letting the app boot on a broken
 * schema. This tests the fix.
 *
 * Two layers:
 *   1. Pure splitter — covers comment / quote / dollar-quote handling.
 *   2. Runner — mocks `prisma.$executeRawUnsafe`, points the runner at a
 *      tmp dir of test SQL files, and asserts that a multi-statement file
 *      produces N executeRawUnsafe calls (N = the number of statements)
 *      plus 1 INSERT into _migrations. Failure mode re-throws (no longer
 *      silently swallowed).
 */

import { jest } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { splitStatements } from '../../utils/migrations/splitStatements.js';

// ---------- splitStatements unit tests ---------------------------------------

describe('splitStatements', () => {
  it('returns [] on empty / non-string input', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements(null)).toEqual([]);
    expect(splitStatements(undefined)).toEqual([]);
    expect(splitStatements(42)).toEqual([]);
  });

  it('splits a simple two-statement file', () => {
    const sql = 'CREATE TABLE x (id int);\nINSERT INTO x VALUES (1);';
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE x (id int)',
      'INSERT INTO x VALUES (1)',
    ]);
  });

  it('handles a trailing statement without a final semicolon', () => {
    const sql = 'CREATE TABLE x (id int);\nINSERT INTO x VALUES (1)';
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE x (id int)',
      'INSERT INTO x VALUES (1)',
    ]);
  });

  it('drops comment-only segments between statements', () => {
    const sql = '-- header comment\nCREATE TABLE x (id int);\n-- between\n;\nINSERT INTO x VALUES (1);';
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('CREATE TABLE x');
    expect(out[1]).toBe('INSERT INTO x VALUES (1)');
  });

  it('does not split on a semicolon inside a single-quoted string', () => {
    const sql = `INSERT INTO x VALUES ('hello; world');`;
    expect(splitStatements(sql)).toEqual([`INSERT INTO x VALUES ('hello; world')`]);
  });

  it('handles `\'\'` escaped single quotes', () => {
    const sql = `INSERT INTO x VALUES ('it''s fine; really'); SELECT 1;`;
    expect(splitStatements(sql)).toEqual([
      `INSERT INTO x VALUES ('it''s fine; really')`,
      'SELECT 1',
    ]);
  });

  it('does not split on a semicolon inside a double-quoted identifier', () => {
    const sql = `CREATE TABLE "weird; name" (id int); INSERT INTO "weird; name" VALUES (1);`;
    expect(splitStatements(sql)).toEqual([
      `CREATE TABLE "weird; name" (id int)`,
      `INSERT INTO "weird; name" VALUES (1)`,
    ]);
  });

  it('does not split inside a `$$ ... $$` function body', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$
      BEGIN
        RAISE NOTICE 'hi; there';
        RETURN 1;
      END
    $$ LANGUAGE plpgsql;
    SELECT f();`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('CREATE FUNCTION f()');
    expect(out[0]).toContain('RAISE NOTICE');
    expect(out[0]).toContain('RETURN 1');
    expect(out[1]).toBe('SELECT f()');
  });

  it('does not split inside a tagged dollar-quote `$tag$ ... $tag$`', () => {
    const sql = `DO $body$
      BEGIN
        EXECUTE 'CREATE TABLE z (id int);';
        EXECUTE 'CREATE INDEX z_id_idx ON z(id);';
      END
    $body$;
    SELECT 1;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('DO $body$');
    expect(out[0]).toContain('$body$');
    expect(out[1]).toBe('SELECT 1');
  });

  it('does not confuse `$` outside of a tag with a dollar-quote opener', () => {
    // `$1` is a Postgres bind-parameter placeholder, not a quote.
    const sql = `INSERT INTO x VALUES ($1, $2); SELECT 2;`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('INSERT INTO x VALUES ($1, $2)');
    expect(out[1]).toBe('SELECT 2');
  });

  it('skips line comments containing semicolons', () => {
    const sql = `CREATE TABLE x (id int); -- semicolon; in comment\nINSERT INTO x VALUES (1);`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
  });

  it('skips block comments containing semicolons', () => {
    const sql = `CREATE TABLE x (id int); /* multi\n; line\n; comment */ INSERT INTO x VALUES (1);`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
  });

  it('handles BEGIN/COMMIT wrappers as separate statements', () => {
    const sql = 'BEGIN;\nCREATE TABLE x (id int);\nCOMMIT;';
    expect(splitStatements(sql)).toEqual([
      'BEGIN',
      'CREATE TABLE x (id int)',
      'COMMIT',
    ]);
  });
});

// ---------- runMigrations integration tests ----------------------------------

const executeRawUnsafeMock = jest.fn();
const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $executeRawUnsafe: executeRawUnsafeMock,
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { runMigrations } = await import('../../utils/migrations/runMigrations.js');

let tmpDir;

beforeEach(() => {
  executeRawUnsafeMock.mockReset();
  queryRawUnsafeMock.mockReset();
  // Default: tracker is empty (no migrations applied yet).
  queryRawUnsafeMock.mockResolvedValue([]);
  // Default: every executeRawUnsafe call resolves successfully.
  executeRawUnsafeMock.mockResolvedValue(0);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runMigrations-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('runMigrations', () => {
  it('splits a multi-statement file and runs each statement separately, then records', async () => {
    const file = '999_test_multi.sql';
    fs.writeFileSync(
      path.join(tmpDir, file),
      `BEGIN;
CREATE TABLE _test_x (id int);
INSERT INTO _test_x VALUES (1);
INSERT INTO _test_x VALUES (2);
COMMIT;`,
    );

    await runMigrations({ migrationsDir: tmpDir });

    const calls = executeRawUnsafeMock.mock.calls.map((c) => c[0]);
    // Calls = bootstrap CREATE TABLE _migrations + 5 statements + 1 INSERT INTO _migrations.
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('CREATE TABLE _test_x (id int)');
    expect(calls).toContain('INSERT INTO _test_x VALUES (1)');
    expect(calls).toContain('INSERT INTO _test_x VALUES (2)');
    expect(calls).toContain('COMMIT');

    // Tracker INSERT carries the file name as the bind param.
    const trackerInsert = executeRawUnsafeMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO _migrations'),
    );
    expect(trackerInsert).toBeDefined();
    expect(trackerInsert[1]).toBe(file);
  });

  it('exercises the dollar-quote splitter via a function-body migration', async () => {
    const file = '999_test_dollar_quote.sql';
    fs.writeFileSync(
      path.join(tmpDir, file),
      `CREATE OR REPLACE FUNCTION _test_f() RETURNS int AS $$
BEGIN
  RAISE NOTICE 'two; semicolons; here';
  RETURN 1;
END
$$ LANGUAGE plpgsql;
SELECT _test_f();`,
    );

    await runMigrations({ migrationsDir: tmpDir });

    const calls = executeRawUnsafeMock.mock.calls.map((c) => c[0]);
    const fnCall = calls.find((s) => s && s.includes('CREATE OR REPLACE FUNCTION _test_f'));
    const selectCall = calls.find((s) => s === 'SELECT _test_f()');

    // The function body must come back as ONE statement, not three.
    expect(fnCall).toBeDefined();
    expect(fnCall).toContain('RAISE NOTICE');
    expect(fnCall).toContain('RETURN 1');
    expect(fnCall).toContain('LANGUAGE plpgsql');
    expect(selectCall).toBe('SELECT _test_f()');
  });

  it('throws (no longer swallows) when a statement fails — and does NOT record the file', async () => {
    const file = '999_test_failing.sql';
    fs.writeFileSync(
      path.join(tmpDir, file),
      'CREATE TABLE _test_y (id int);\nBROKEN STATEMENT HERE;',
    );

    // Make the BROKEN line reject; everything else succeeds.
    executeRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('BROKEN STATEMENT HERE')) {
        return Promise.reject(
          Object.assign(new Error('syntax error at or near "BROKEN"'), { code: '42601' }),
        );
      }
      return Promise.resolve(0);
    });

    await expect(runMigrations({ migrationsDir: tmpDir })).rejects.toThrow(/BROKEN|syntax error/);

    // Tracker INSERT must NOT have fired for the failed file.
    const trackerInserts = executeRawUnsafeMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO _migrations'),
    );
    expect(trackerInserts).toHaveLength(0);
  });

  it('skips files already in the _migrations tracker', async () => {
    const file = '999_test_skip.sql';
    fs.writeFileSync(path.join(tmpDir, file), 'CREATE TABLE _test_skip (id int);');

    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValueOnce([{ name: file }]);

    await runMigrations({ migrationsDir: tmpDir });

    // Only the bootstrap CREATE TABLE _migrations call should have fired.
    const fileCalls = executeRawUnsafeMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('_test_skip'),
    );
    expect(fileCalls).toHaveLength(0);
  });

  it('handles a multi-statement file whose statement count matches what the splitter returns', async () => {
    // Direct sanity check: the runner's call count for non-tracker, non-bootstrap
    // calls should equal splitStatements(file).length.
    const sql = `BEGIN;
CREATE TABLE _test_count (id int);
CREATE INDEX _test_count_idx ON _test_count(id);
INSERT INTO _test_count VALUES (1);
COMMIT;`;
    const file = '999_test_count.sql';
    fs.writeFileSync(path.join(tmpDir, file), sql);
    const expected = splitStatements(sql);
    expect(expected).toHaveLength(5); // BEGIN, CREATE, CREATE, INSERT, COMMIT

    await runMigrations({ migrationsDir: tmpDir });

    const calls = executeRawUnsafeMock.mock.calls.map((c) => c[0]).filter(Boolean);
    // Bootstrap CREATE TABLE _migrations + 5 split statements + 1 INSERT INTO _migrations = 7.
    // Filter to non-bootstrap, non-tracker calls and count.
    const stmtCalls = calls.filter(
      (s) => !s.includes('CREATE TABLE IF NOT EXISTS _migrations') && !s.includes('INSERT INTO _migrations'),
    );
    expect(stmtCalls).toHaveLength(5);
  });
});
