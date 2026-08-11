import { splitStatements } from '../../src/utils/migrations/splitStatements.js';
import {
  parseMigrationDirectives,
  safeMigrationStatementTimeout,
} from './migrationDirectives.mjs';

const TRACK_MIGRATION_SQL =
  'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING';

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

async function trackMigration(client, file) {
  await client.query(TRACK_MIGRATION_SQL, [file]);
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
      await trackMigration(client, file);
    } finally {
      await client.query("SET statement_timeout = '120s'").catch(() => {});
      await client.query("SET lock_timeout = '15s'").catch(() => {});
    }
    return { mode: 'no-transaction', directives };
  }

  if (baseline || selfManaged) {
    try {
      await client.query(sql);
      await trackMigration(client, file);
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
    await trackMigration(client, file);
    await client.query('COMMIT');
  } catch (err) {
    await rollbackBestEffort(client);
    throw err;
  }
  return { mode: 'transactional', directives };
}

export { TRACK_MIGRATION_SQL };
