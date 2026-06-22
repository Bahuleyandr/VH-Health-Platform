// src/utils/migrations/runMigrations.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { splitStatements } from './splitStatements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const OPTIONAL_PGVECTOR_MIGRATION = '113_knowledge_base_foundation.sql';
const MIGRATION_TRANSACTION_OPTIONS = {
  maxWait: 15_000,
  timeout: 300_000,
};

function canSkipOptionalPgvectorMigration() {
  return process.env.NODE_ENV !== 'production' && process.env.REQUIRE_PGVECTOR !== 'true';
}

function isOptionalPgvectorUnavailable(file, err) {
  if (file !== OPTIONAL_PGVECTOR_MIGRATION) return false;
  if (!canSkipOptionalPgvectorMigration()) return false;
  return /extension "vector" is not available|type "vector" does not exist|pgvector/i.test(
    String(err?.message || ''),
  );
}

async function isPgvectorAvailable() {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT 1 FROM pg_available_extensions WHERE name = 'vector' LIMIT 1",
  );
  return (Array.isArray(rows) ? rows : rows?.rows ?? []).length > 0;
}

async function rollbackBestEffort() {
  try {
    await prisma.$executeRawUnsafe('ROLLBACK');
  } catch {
    // The failed statement may not have left an open transaction on this connection.
  }
}

function stripSqlComments(sql) {
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

function isTransactionBoundaryStatement(stmt) {
  const normalized = stripSqlComments(stmt).trim().replace(/\s+/g, ' ').toUpperCase();
  return /^(BEGIN|START TRANSACTION)( WORK| TRANSACTION)?$/.test(normalized) ||
    /^(COMMIT|END)( WORK)?$/.test(normalized) ||
    /^ROLLBACK( WORK)?$/.test(normalized);
}

function statementPreview(stmt) {
  return stripSqlComments(stmt).replace(/\s+/g, ' ').trim().slice(0, 180);
}

// Per-file scale-safety escape hatch (audit 2026-06-22 H5). Heavy DDL at real
// hospital data volume — CREATE INDEX CONCURRENTLY, full-table backfills — can't
// run inside the default single transaction (CONCURRENTLY is rejected in a tx
// block) or under the hard 120s statement_timeout (a long build aborts → the pod
// crashloops on the cutover deploy). A migration opts out with header comments:
//   -- @no-transaction            run statements on the session (no wrapping tx)
//   -- @statement_timeout: 0      raise/disable the per-statement timeout ('0' = off)
// Both are optional and independent. Without them, behavior is unchanged.
function parseMigrationDirectives(sql) {
  const noTransaction = /^[ \t]*--[ \t]*@no-transaction\b/im.test(sql);
  const m = sql.match(/^[ \t]*--[ \t]*@statement_timeout:[ \t]*(\S+)/im);
  return { noTransaction, statementTimeout: m ? m[1].trim() : null };
}

// A Postgres time/interval value we are willing to inject into SET. Files are
// repo-authored, but validate anyway (defense-in-depth): a bare integer (ms),
// '0' (disabled), or an integer with a ms/s/min unit.
function safeStatementTimeout(value, fallback = '120s') {
  if (value == null) return fallback;
  if (value === '0' || /^\d+(ms|s|min)?$/i.test(value)) return value;
  logger.warn(`runMigrations: ignoring invalid @statement_timeout '${value}'; using ${fallback}`);
  return fallback;
}

async function runStatements(client, statements) {
  for (let index = 0; index < statements.length; index += 1) {
    const stmt = statements[index];
    if (isTransactionBoundaryStatement(stmt)) continue;
    try {
      await client.$executeRawUnsafe(stmt);
    } catch (err) {
      err.migrationStatementIndex = index + 1;
      err.migrationStatementPreview = statementPreview(stmt);
      throw err;
    }
  }
}

async function executeMigrationFile(file, statements, directives = {}) {
  const timeout = safeStatementTimeout(directives.statementTimeout);

  if (directives.noTransaction) {
    // No wrapping transaction: statements run on the session so CONCURRENTLY /
    // VACUUM / etc. are legal. There is NO atomic rollback — a mid-file failure
    // leaves the file partially applied and UNRECORDED, so a @no-transaction
    // migration MUST be written re-runnable (IF NOT EXISTS / CONCURRENTLY). The
    // file is recorded only after every statement succeeds.
    await prisma.$executeRawUnsafe("SET lock_timeout = '15s'");
    await prisma.$executeRawUnsafe(`SET statement_timeout = '${timeout}'`);
    try {
      await runStatements(prisma, statements);
      await prisma.$executeRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', file);
    } finally {
      // Restore the runner's session default so later files aren't left uncapped.
      await prisma.$executeRawUnsafe("SET statement_timeout = '120s'").catch(() => {});
      await prisma.$executeRawUnsafe("SET lock_timeout = '15s'").catch(() => {});
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '15s'");
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${timeout}'`);
    await runStatements(tx, statements);
    await tx.$executeRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', file);
  }, MIGRATION_TRANSACTION_OPTIONS);
}

/**
 * Apply pending `.sql` migrations from `src/migrations/` in filename order.
 *
 * Tracking lives in a `_migrations` table (autocreated). Each migration file
 * runs in two passes:
 *
 *   1. Split the file content into individual SQL statements (via
 *      `splitStatements`) so we don't hit Postgres error 42601 — `cannot
 *      insert multiple commands into a prepared statement` — that Prisma's
 *      `$executeRawUnsafe` raises when the input contains more than one
 *      command separated by `;`.
 *
 *   2. Execute each statement, then atomically record the file in
 *      `_migrations` so subsequent runs skip it. Failure inside any
 *      statement aborts the file (we do NOT record it as completed),
 *      and the runner re-throws so `bin/www.js` can exit with a clear
 *      error.
 *
 * Migration failure is FATAL by design: a half-applied schema leads to
 * silent runtime errors that are far harder to diagnose than a startup
 * crash. The previous behavior — catching errors and warning "non-fatal
 * — schema managed by Prisma" — masked real schema drift on dalekdefender
 * (verified 2026-05-01 — migrations 108-139 all silently failed and the
 * pod ran on a broken schema for an unknown number of restarts).
 */
export async function runMigrations({ migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  // F-2 — bound how long the runner waits on a relation lock. Without
  // this, an orphan idle-in-transaction connection (audit_log,
  // workflow_resume, etc.) holding a row lock on a table the migration
  // wants to ALTER causes the runner to hang indefinitely. With a
  // 15s lock_timeout, the runner bails fast and surfaces a clear
  // error so the operator can pg_terminate_backend() the orphan and
  // restart. Hit twice during the 2026-05-09 deploy of E batch.
  try {
    await prisma.$executeRawUnsafe("SET lock_timeout = '15s'");
    await prisma.$executeRawUnsafe("SET statement_timeout = '120s'");
  } catch (err) {
    logger.warn(`runMigrations: could not set lock/statement timeouts (${err?.message}); continuing with defaults`);
  }

  // Create migrations tracking table. DDL → $executeRawUnsafe.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // Get already-run migrations.
  const executed = await prisma.$queryRawUnsafe('SELECT name FROM _migrations ORDER BY name');
  const executedNames = new Set(
    (Array.isArray(executed) ? executed : executed?.rows ?? []).map((r) => r.name),
  );

  if (!fs.existsSync(migrationsDir)) {
    logger.info('No migrations directory found, skipping.');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  let skippedOptional = 0;
  for (const file of files) {
    if (executedNames.has(file)) continue;

    if (
      file === OPTIONAL_PGVECTOR_MIGRATION &&
      canSkipOptionalPgvectorMigration() &&
      !(await isPgvectorAvailable())
    ) {
      skippedOptional += 1;
      logger.warn(`Skipping ${file}: pgvector is unavailable in this non-production database.`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const statements = splitStatements(sql);
    const directives = parseMigrationDirectives(sql);

    if (statements.length === 0) {
      logger.warn(`Migration ${file} contained no executable statements (comments-only file?). Recording as applied.`);
      await prisma.$executeRawUnsafe('INSERT INTO _migrations (name) VALUES ($1)', file);
      continue;
    }

    const mode = directives.noTransaction ? ' [no-transaction]' : '';
    const timeoutNote = directives.statementTimeout ? ` [statement_timeout=${directives.statementTimeout}]` : '';
    logger.info(`Running migration: ${file} (${statements.length} statement${statements.length === 1 ? '' : 's'})${mode}${timeoutNote}`);

    try {
      await executeMigrationFile(file, statements, directives);
      ran += 1;
      logger.info(`✅ Migration completed: ${file}`);
    } catch (err) {
      if (isOptionalPgvectorUnavailable(file, err)) {
        await rollbackBestEffort();
        await prisma.$disconnect();
        skippedOptional += 1;
        logger.warn(`Skipping ${file}: pgvector is unavailable in this non-production database.`, {
          error: err?.message,
          code: err?.code,
        });
        continue;
      }

      logger.error(`❌ Migration ${file} failed`, {
        error: err?.message,
        code: err?.code,
        statements_attempted: statements.length,
        statement_index: err?.migrationStatementIndex,
        statement_preview: err?.migrationStatementPreview,
      });
      // Re-throw so the caller can surface a fatal startup error.
      // Do NOT swallow — a half-applied schema is far worse than a crash.
      throw err;
    }
  }

  if (ran === 0 && skippedOptional === 0) {
    logger.info('No pending migrations.');
  } else if (ran === 0) {
    logger.info(`No pending migrations applied; skipped ${skippedOptional} optional migration(s).`);
  } else {
    const skippedSuffix = skippedOptional > 0 ? `; skipped ${skippedOptional} optional migration(s)` : '';
    logger.info(`✅ Ran ${ran} migration(s)${skippedSuffix}.`);
  }
}

export { DEFAULT_MIGRATIONS_DIR };
export default runMigrations;
