import { splitStatements } from '../../src/utils/migrations/splitStatements.js';
import {
  parseMigrationDirectives,
  safeMigrationStatementTimeout,
} from './migrationDirectives.mjs';
import { migrationChecksum } from './migrationChecksum.mjs';

const TRACK_MIGRATION_SQL =
  'INSERT INTO _migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING';
const ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL =
  'ALTER TABLE public._migrations ADD COLUMN IF NOT EXISTS checksum TEXT';

function stripLeadingComments(statement) {
  let remaining = String(statement || '');
  while (true) {
    const previous = remaining;
    remaining = remaining.replace(/^\s*--[^\n]*(?:\r?\n|$)/, '');
    remaining = remaining.replace(/^\s*\/\*[\s\S]*?\*\//, '');
    if (remaining === previous) return remaining.trim();
  }
}

function isTransactionBoundaryStatement(statement) {
  const normalized = stripLeadingComments(statement).replace(/\s+/g, ' ').toUpperCase();
  return /^(BEGIN|START TRANSACTION)( WORK| TRANSACTION)?$/.test(normalized)
    || /^(COMMIT|END)( WORK)?$/.test(normalized)
    || /^ROLLBACK( WORK)?$/.test(normalized);
}

async function trackMigration(client, file, sql) {
  await client.query(TRACK_MIGRATION_SQL, [file, migrationChecksum(sql)]);
}

async function rollbackBestEffort(client) {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The failed statement may already have closed or aborted its transaction.
  }
}

export async function executeCiMigrationFile({
  client,
  file,
  sql,
  baseline = false,
  selfManaged = false,
  forceTransactional = false,
  beforeTransaction = null,
}) {
  const directives = parseMigrationDirectives(sql);
  const timeout = safeMigrationStatementTimeout(directives.statementTimeout);

  if (directives.noTransaction) {
    await client.query("SET lock_timeout = '15s'");
    await client.query(`SET statement_timeout = '${timeout}'`);
    try {
      const statements = splitStatements(sql);
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (isTransactionBoundaryStatement(statement)) continue;
        try {
          await client.query(statement);
        } catch (err) {
          err.migrationStatementIndex = index + 1;
          err.migrationStatementPreview = stripLeadingComments(statement)
            .replace(/\s+/g, ' ')
            .slice(0, 180);
          throw err;
        }
      }
      await trackMigration(client, file, sql);
    } finally {
      await client.query("SET statement_timeout = '120s'").catch(() => {});
      await client.query("SET lock_timeout = '15s'").catch(() => {});
    }
    return { mode: 'no-transaction', directives };
  }

  if (forceTransactional) {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query(`SET LOCAL statement_timeout = '${timeout}'`);
      const preflight = beforeTransaction ? await beforeTransaction(client) : null;
      if (preflight?.skipMigration === true) {
        await client.query('COMMIT');
        return { mode: 'concurrent-already-applied', directives };
      }
      const statements = splitStatements(sql);
      for (let index = 0; index < statements.length; index += 1) {
        const statement = statements[index];
        if (isTransactionBoundaryStatement(statement)) continue;
        try {
          await client.query(statement);
        } catch (err) {
          err.migrationStatementIndex = index + 1;
          err.migrationStatementPreview = stripLeadingComments(statement)
            .replace(/\s+/g, ' ')
            .slice(0, 180);
          throw err;
        }
      }
      await trackMigration(client, file, sql);
      await client.query('COMMIT');
    } catch (err) {
      await rollbackBestEffort(client);
      throw err;
    }
    return { mode: 'transactional-gated', directives };
  }

  if (baseline || selfManaged) {
    try {
      await client.query(sql);
      if (baseline) {
        await client.query(ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL);
      }
      await trackMigration(client, file, sql);
    } catch (err) {
      await rollbackBestEffort(client);
      throw err;
    }
    return { mode: baseline ? 'baseline' : 'self-managed', directives };
  }

  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query(`SET LOCAL statement_timeout = '${timeout}'`);
    await client.query(sql);
    await trackMigration(client, file, sql);
    await client.query('COMMIT');
  } catch (err) {
    await rollbackBestEffort(client);
    throw err;
  }
  return { mode: 'transactional', directives };
}

export { ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL, TRACK_MIGRATION_SQL };
