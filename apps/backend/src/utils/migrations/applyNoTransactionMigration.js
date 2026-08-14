// src/utils/migrations/applyNoTransactionMigration.js
//
// The ONE implementation of "apply a `-- @no-transaction` migration file to a
// single Postgres session". `runMigrations.js` calls it for the real boot-time
// apply, and anything else that has to apply such a file — a migration deep
// test against a scratch database, for instance — must call it too, so the two
// cannot drift apart.
//
// Why this has to be shared. A @no-transaction file is allowed to contain
// `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`, which Postgres
// rejects inside a transaction block. Handing the whole file to node-postgres
// as one multi-statement simple query makes it an *implicit* transaction block,
// so the file dies with `DROP INDEX CONCURRENTLY cannot run inside a
// transaction block` even though the production runner applies it happily. The
// file must be split and applied statement by statement on a session with no
// wrapping transaction, exactly as done here. (Migration 666's own deep test
// hand-rolled `client.query(wholeFile)` and went red the moment the H-1 lock
// lane added the CONCURRENTLY builds — this module exists so that class of
// break cannot recur.)
//
// Deliberately free of any `prisma` / `logger` import: a deep test must be able
// to import this without instantiating a Prisma client it would then have to
// disconnect.

import {
  parseMigrationDirectives,
  safeMigrationStatementTimeout,
} from '../../../scripts/lib/migrationDirectives.mjs';
import { splitStatements } from './splitStatements.js';

/**
 * Strip line/block comments from a SQL fragment, leaving string and identifier
 * literals intact. Used only for classifying and previewing statements — never
 * for what is actually sent to Postgres.
 */
export function stripSqlComments(sql) {
  let body = '';
  let i = 0;
  let mode = 'normal';

  while (i < sql.length) {
    const ch = sql[i];
    const next = i + 1 < sql.length ? sql[i + 1] : '';

    if (mode === 'line_comment') {
      if (ch === '\n') {
        body += ch;
        mode = 'normal';
      }
      i += 1;
      continue;
    }

    if (mode === 'block_comment') {
      if (ch === '*' && next === '/') {
        mode = 'normal';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (mode === 'single_quote') {
      body += ch;
      if (ch === "'") {
        if (next === "'") {
          body += next;
          i += 2;
          continue;
        }
        mode = 'normal';
      }
      i += 1;
      continue;
    }

    if (mode === 'double_quote') {
      body += ch;
      if (ch === '"') {
        if (next === '"') {
          body += next;
          i += 2;
          continue;
        }
        mode = 'normal';
      }
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      mode = 'line_comment';
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      mode = 'block_comment';
      i += 2;
      continue;
    }

    if (ch === "'") mode = 'single_quote';
    if (ch === '"') mode = 'double_quote';

    body += ch;
    i += 1;
  }

  return body;
}

export function isTransactionBoundaryStatement(stmt) {
  const normalized = stripSqlComments(stmt).trim().replace(/\s+/g, ' ').toUpperCase();
  return /^(BEGIN|START TRANSACTION)( WORK| TRANSACTION)?$/.test(normalized)
    || /^(COMMIT|END)( WORK)?$/.test(normalized)
    || /^ROLLBACK( WORK)?$/.test(normalized);
}

export function statementPreview(stmt) {
  return stripSqlComments(stmt).replace(/\s+/g, ' ').trim().slice(0, 180);
}

/**
 * Run pre-split statements one at a time on a node-postgres client, decorating
 * any failure with the 1-based statement index and a comment-stripped preview.
 */
export async function runPgStatements(client, statements) {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    if (isTransactionBoundaryStatement(stmt)) continue;
    try {
      await client.query(stmt);
    } catch (err) {
      err.migrationStatementIndex = index + 1;
      err.migrationStatementPreview = statementPreview(stmt);
      throw err;
    }
  }
}

/**
 * Apply already-split @no-transaction statements to one session: session-level
 * lock/statement timeouts first (SET, not SET LOCAL — there is no transaction
 * to scope them to), then every statement individually.
 *
 * Does NOT record the file in `_migrations`; the caller owns tracker
 * bookkeeping, because it must be the last statement on the session and only a
 * real runner has a tracker to write to.
 *
 * @param {import('pg').Client} client - already-connected node-postgres client
 * @param {string[]} statements - output of splitStatements()
 * @param {{ statementTimeout?: string }} [options]
 */
export async function applyNoTransactionStatements(
  client,
  statements,
  { statementTimeout = '120s' } = {},
) {
  await client.query("SET lock_timeout = '15s'");
  await client.query(`SET statement_timeout = '${statementTimeout}'`);
  await runPgStatements(client, statements);
  return statements;
}

/**
 * Apply one whole `-- @no-transaction` migration file to a session, parsing its
 * directives and splitting it with the same code the runner uses.
 *
 * Refuses a file without the directive rather than silently applying it the
 * wrong way: a transactional migration applied statement-by-statement loses its
 * all-or-nothing guarantee, which is the opposite of what its author asked for.
 *
 * @param {import('pg').Client} client - already-connected node-postgres client
 * @param {string} sql - the raw migration file contents
 * @param {{ statementTimeout?: string }} [options] - override the file directive
 * @returns {Promise<{ directives: object, statements: string[] }>}
 */
export async function applyNoTransactionMigrationSql(client, sql, { statementTimeout } = {}) {
  const directives = parseMigrationDirectives(sql);
  if (!directives.noTransaction) {
    const err = new Error(
      'applyNoTransactionMigrationSql requires a migration file declaring `-- @no-transaction`',
    );
    err.code = 'MIGRATION_NOT_NO_TRANSACTION';
    throw err;
  }

  const statements = splitStatements(sql);
  await applyNoTransactionStatements(client, statements, {
    statementTimeout: statementTimeout ?? safeMigrationStatementTimeout(directives.statementTimeout),
  });
  return { directives, statements };
}

export default applyNoTransactionMigrationSql;
