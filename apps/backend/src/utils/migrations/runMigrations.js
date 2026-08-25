// src/utils/migrations/runMigrations.js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Client as PgClient } from 'pg';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  parseMigrationDirectives,
  safeMigrationStatementTimeout,
} from '../../../scripts/lib/migrationDirectives.mjs';
import {
  applyNoTransactionStatements,
  isTransactionBoundaryStatement,
  statementPreview,
} from './applyNoTransactionMigration.js';
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

// sha256 of a migration file's on-disk bytes, newline-normalised so a CRLF/LF
// checkout difference is not reported as content drift.
function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

// Enforcement is OPT-IN. Default is fail-open (warn only) so a checkout that
// legitimately differs — or the grandfathered migration-669 in-place edit — can
// never brick a production boot on a checksum mismatch. Set to '1'/'true' to
// make drift on an already-applied migration fatal.
function migrationChecksumEnforced() {
  return process.env.MIGRATION_CHECKSUM_ENFORCE === '1'
    || process.env.MIGRATION_CHECKSUM_ENFORCE === 'true';
}

/**
 * Content-integrity verify + first-run seed for the `_migrations` tracker.
 *
 * The tracker was name-only, so an in-place edit of an already-applied migration
 * was undetectable by machinery (the migration-669 episode of PR #902 — a
 * semantically-neutral SET CONSTRAINTS addition, applied to some DBs and not
 * others with zero signal). We now record a sha256 per newly-applied file and
 * check it on every boot.
 *
 * Rows with a NULL checksum (applied before this column existed, 669 included)
 * are SEEDED from current on-disk content on first run — so seeding adopts the
 * current bytes and cannot retroactively flag the historical 669 edit; it only
 * establishes the baseline that FUTURE in-place edits are measured against.
 * Rows whose recorded checksum differs from on-disk are logged loudly, and are
 * fatal only when migrationChecksumEnforced().
 */
async function reconcileMigrationChecksums({ migrationsDir, executedRows, onDiskFiles }) {
  const onDisk = new Set(onDiskFiles);
  const drift = [];
  let seeded = 0;
  for (const row of executedRows) {
    const file = row?.name;
    if (!file || !onDisk.has(file)) continue; // dropped/renamed files: nothing to compare
    let sql;
    try {
      sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    } catch {
      continue;
    }
    const actual = migrationChecksum(sql);
    if (row.checksum == null) {
      await prisma.$executeRawUnsafe(
        'UPDATE _migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL',
        actual, file,
      );
      seeded += 1;
    } else if (row.checksum !== actual) {
      drift.push({ file, recorded: row.checksum, actual });
    }
  }

  if (seeded > 0) {
    logger.info(`Seeded checksums for ${seeded} pre-existing migration(s) from on-disk content.`);
  }
  if (drift.length > 0) {
    for (const d of drift) {
      logger.error(
        `⚠️ Migration content drift: ${d.file} was edited in place after it was applied `
        + `(recorded ${d.recorded.slice(0, 12)}…, on-disk ${d.actual.slice(0, 12)}…). `
        + 'An already-applied migration changed on disk; this DB still holds the old effect.',
      );
    }
    if (migrationChecksumEnforced()) {
      const err = new Error(
        `Migration checksum drift on ${drift.length} already-applied migration(s): `
        + `${drift.map((d) => d.file).join(', ')}`,
      );
      err.code = 'MIGRATION_CHECKSUM_DRIFT';
      err.migrationChecksumDrift = drift;
      throw err;
    }
  }
  return { seeded, drift };
}

function migrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) {
    const err = new Error(`Migrations directory not found: ${migrationsDir}`);
    err.code = 'MIGRATIONS_DIRECTORY_MISSING';
    throw err;
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

export function evaluateMigrationState(files, executedRows) {
  const expected = [...files].sort();
  const executed = new Set(
    (Array.isArray(executedRows) ? executedRows : executedRows?.rows ?? [])
      .map((row) => row?.name)
      .filter(Boolean),
  );
  const pending = expected.filter((file) => !executed.has(file));
  const unexpected = [...executed].filter((file) => !expected.includes(file)).sort();

  return {
    current: pending.length === 0 && unexpected.length === 0,
    requiredCurrent: pending.length === 0,
    expectedCount: expected.length,
    executedCount: executed.size,
    expectedTip: expected.at(-1) ?? null,
    executedTip: [...executed].sort().at(-1) ?? null,
    pending,
    unexpected,
  };
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

/**
 * Production workers are read-only migration consumers. Argo's owner-credential
 * PreSync Job applies DDL; every API worker must only prove that the tracker is
 * an exact match for the image's immutable migration directory before it binds
 * a socket. This deliberately performs no CREATE/INSERT/ALTER operation.
 */
export async function verifyMigrationsCurrent({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  const state = await readMigrationState({ migrationsDir });
  if (!state.current) {
    const err = new Error(
      `Database migration tracker does not match this image `
      + `(expected tip ${state.expectedTip || 'none'}, database tip ${state.executedTip || 'none'}, `
      + `${state.pending.length} pending, ${state.unexpected.length} unexpected)`,
    );
    err.code = 'MIGRATION_TIP_MISMATCH';
    err.migrationState = state;
    throw err;
  }
  return state;
}

export async function readMigrationState({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  let files = migrationFiles(migrationsDir);
  if (files.includes(OPTIONAL_PGVECTOR_MIGRATION)
    && canSkipOptionalPgvectorMigration()
    && !(await isPgvectorAvailable())) {
    files = files.filter((file) => file !== OPTIONAL_PGVECTOR_MIGRATION);
  }

  const executed = await prisma.$queryRawUnsafe('SELECT name FROM _migrations ORDER BY name');
  return evaluateMigrationState(files, executed);
}

// A Postgres time/interval value we are willing to inject into SET. Files are
// repo-authored, but validate anyway (defense-in-depth): a bare integer (ms),
// '0' (disabled), or an integer with a ms/s/min unit. The validation itself
// lives in scripts/lib/migrationDirectives.mjs so the CI applier
// (scripts/ci-setup-db.mjs) and this runner cannot disagree about what a
// directive means; all this wrapper adds is the operator-facing warning.
function safeStatementTimeout(value, fallback = '120s') {
  const safe = safeMigrationStatementTimeout(value, fallback);
  if (value != null && safe !== value) {
    logger.warn(`runMigrations: ignoring invalid @statement_timeout '${value}'; using ${fallback}`);
  }
  return safe;
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

async function createNoTransactionClient() {
  const client = new PgClient({
    connectionString: process.env.DATABASE_URL,
    application_name: 'vhhealth-no-transaction-migrations',
  });
  await client.connect();
  return client;
}

async function executeMigrationFile(
  file,
  statements,
  directives = {},
  noTransactionClientFactory = createNoTransactionClient,
  checksum = null,
) {
  const timeout = safeStatementTimeout(directives.statementTimeout);

  if (directives.noTransaction) {
    // No wrapping transaction: statements run on the session so CONCURRENTLY /
    // VACUUM / etc. are legal. There is NO atomic rollback — a mid-file failure
    // leaves the file partially applied and UNRECORDED, so a @no-transaction
    // migration MUST be written re-runnable (IF NOT EXISTS / CONCURRENTLY). The
    // file is recorded only after every statement succeeds.
    //
    // applyNoTransactionStatements is shared with every other consumer that has
    // to apply a @no-transaction file (migration deep tests included) so none of
    // them can reinvent a subtly different apply — see the module header.
    const client = await noTransactionClientFactory();
    try {
      await applyNoTransactionStatements(client, statements, { statementTimeout: timeout });
      await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
    } finally {
      await client.end().catch(() => {});
    }
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '15s'");
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${timeout}'`);
    await runStatements(tx, statements);
    await tx.$executeRawUnsafe('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', file, checksum);
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
export async function runMigrations({
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  noTransactionClientFactory = createNoTransactionClient,
} = {}) {
  // Create migrations tracking table. DDL → $executeRawUnsafe.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Content-integrity column (added 2026-08-25). Nullable + IF NOT EXISTS so
  // existing trackers upgrade in place; pre-existing rows are back-seeded below.
  await prisma.$executeRawUnsafe('ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

  // Get already-run migrations (name + recorded checksum).
  const executed = await prisma.$queryRawUnsafe('SELECT name, checksum FROM _migrations ORDER BY name');
  const executedRows = (Array.isArray(executed) ? executed : executed?.rows ?? []);
  const executedNames = new Set(executedRows.map((r) => r.name));

  const files = migrationFiles(migrationsDir);

  // Verify already-applied migrations still match their on-disk bytes; seed
  // checksums for pre-existing rows. Fail-open unless MIGRATION_CHECKSUM_ENFORCE.
  await reconcileMigrationChecksums({ migrationsDir, executedRows, onDiskFiles: files });

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
    const checksum = migrationChecksum(sql);
    const statements = splitStatements(sql);
    const directives = parseMigrationDirectives(sql);

    if (statements.length === 0) {
      logger.warn(`Migration ${file} contained no executable statements (comments-only file?). Recording as applied.`);
      await prisma.$executeRawUnsafe('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', file, checksum);
      continue;
    }

    const mode = directives.noTransaction ? ' [no-transaction]' : '';
    const timeoutNote = directives.statementTimeout ? ` [statement_timeout=${directives.statementTimeout}]` : '';
    logger.info(`Running migration: ${file} (${statements.length} statement${statements.length === 1 ? '' : 's'})${mode}${timeoutNote}`);

    try {
      await executeMigrationFile(
        file,
        statements,
        directives,
        noTransactionClientFactory,
        checksum,
      );
      ran += 1;
      logger.info(`✅ Migration completed: ${file}`);
    } catch (err) {
      if (isOptionalPgvectorUnavailable(file, err)) {
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
