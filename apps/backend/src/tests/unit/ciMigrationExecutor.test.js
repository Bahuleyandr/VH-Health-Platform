import { jest } from '@jest/globals';

import {
  ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL,
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
