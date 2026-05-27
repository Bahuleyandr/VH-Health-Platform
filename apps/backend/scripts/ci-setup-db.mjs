#!/usr/bin/env node
import logger from '../src/logging/logger.js';
// scripts/ci-setup-db.mjs
//
// Apply raw `src/migrations/*.sql` against a Postgres DB, tracker-driven so a
// re-run against an already-bootstrapped DB is a no-op:
//
//   1. Probe for the `_migrations` tracker table. On a truly fresh DB it does
//      not exist yet — `000_baseline.sql` will create it. On an existing DB
//      it does, so we load the applied set and skip any file already tracked.
//   2. Baseline auto-detect — if the canonical tables created exclusively by
//      `000_baseline.sql` (users, appointments, admissions) are present but
//      `000_baseline.sql` is not in `_migrations`, record it without re-running.
//      Catches DBs bootstrapped before this script became tracker-aware
//      (or any DB where the tracker row was lost).
//   3. For each `.sql` file (sorted by name): skip if already in `_migrations`,
//      otherwise apply + record. Files that already wrap themselves in
//      `BEGIN; ... COMMIT;` are applied as-is. The baseline file is also
//      applied as-is (it creates `_migrations` mid-file, so the tracker insert
//      runs as a follow-up statement). All other files run inside one
//      BEGIN/COMMIT so a partial failure leaves no tracker row.
//   4. Seed scripts populate departments/doctors + a minimal ICD-10 catalog.
//
// Boot-time migrations (apps/backend/src/utils/migrations/runMigrations.js)
// already use this tracker convention; this script aligns CI/dev with it so
// re-running against an existing DB no longer chokes on non-idempotent DDL in
// the baseline (e.g. bare `CREATE FUNCTION`).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'src', 'migrations');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  logger.error('DATABASE_URL not set');
  process.exit(1);
}

// Migrations that the memory file notes will fully fail — skip to keep noise down.
const SKIP_MIGRATIONS = new Set([
  '017_seed_departments_doctors.sql', // replaced by seed-departments-doctors-local.mjs
]);

// Tables created exclusively by `000_baseline.sql`. Presence of all three
// against an empty `_migrations` row for baseline means the DB was bootstrapped
// before this script started tracking — mark baseline applied without
// re-running its non-idempotent DDL.
const BASELINE_CANONICAL_TABLES = ['users', 'appointments', 'admissions'];
const BASELINE_FILE = '000_baseline.sql';

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

if (!existsSync(MIGRATIONS_DIR)) {
  logger.error(`Migration directory not found: ${MIGRATIONS_DIR}`);
  process.exit(1);
}

async function trackerTableExists() {
  const { rowCount } = await client.query(
    `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = '_migrations'`,
  );
  return rowCount > 0;
}

async function baselineCanonicalTablesPresent() {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [BASELINE_CANONICAL_TABLES],
  );
  return rows.length === BASELINE_CANONICAL_TABLES.length;
}

// 1. Snapshot the applied set, if the tracker exists. On a fresh DB the
//    tracker is created by 000_baseline.sql later in the loop, so we start
//    with an empty set.
const applied = new Set();
if (await trackerTableExists()) {
  const { rows } = await client.query('SELECT name FROM _migrations');
  for (const row of rows) applied.add(row.name);

  // 2. Baseline auto-detect: full baseline schema present, tracker row missing.
  if (!applied.has(BASELINE_FILE) && (await baselineCanonicalTablesPresent())) {
    logger.info(
      `→ Detected pre-existing baseline schema without tracker entry — recording ${BASELINE_FILE} as applied`,
    );
    await client.query(
      'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [BASELINE_FILE],
    );
    applied.add(BASELINE_FILE);
  }
}

// Detect whether a file opens its own top-level transaction. The simple state
// machine skips leading whitespace, line comments, and block comments, then
// checks for the BEGIN keyword. Files such as `000_baseline.sql` contain
// `BEGIN` inside plpgsql function bodies — those bodies sit far below the
// initial comment block, so this approach only matches a real top-level BEGIN.
function fileStartsWithBegin(sql) {
  let i = 0;
  const n = sql.length;
  while (i < n) {
    while (i < n && (sql[i] === ' ' || sql[i] === '\t' || sql[i] === '\r' || sql[i] === '\n')) i++;
    if (i + 1 < n && sql[i] === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (i + 1 < n && sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
  return /^begin\b/i.test(sql.slice(i, i + 16));
}

logger.info('→ Applying raw src/migrations/*.sql …');
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  logger.error(`No SQL migrations found in: ${MIGRATIONS_DIR}`);
  process.exit(1);
}

let appliedCount = 0;
let alreadyApplied = 0;
let knownBadSkipped = 0;
let errors = 0;
for (const file of files) {
  if (SKIP_MIGRATIONS.has(file)) {
    logger.info(`  ~ ${file} (skipped — known-bad)`);
    knownBadSkipped++;
    continue;
  }
  if (applied.has(file)) {
    logger.info(`  - ${file} (skipping — already applied)`);
    alreadyApplied++;
    continue;
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  // Apply the file:
  //   - baseline manages its own structure (creates _migrations itself) — run
  //     as-is, then record in a follow-up insert that depends on the table
  //     existing post-baseline.
  //   - Files that begin with their own `BEGIN; ... COMMIT;` likewise manage
  //     their own transaction — apply as-is.
  //   - Everything else gets wrapped in BEGIN/COMMIT so the tracker insert
  //     atomically lands with the schema delta.
  const selfManaged = file === BASELINE_FILE || fileStartsWithBegin(sql);
  try {
    if (selfManaged) {
      await client.query(sql);
      await client.query(
        'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [file],
      );
    } else {
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
          [file],
        );
        await client.query('COMMIT');
      } catch (innerErr) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore — transaction may already be aborted
        }
        throw innerErr;
      }
    }
    logger.info(`  ✓ ${file}`);
    applied.add(file);
    appliedCount++;
  } catch (err) {
    logger.info(`  ! ${file} — ${err.code || ''} ${(err.message || '').split('\n')[0]}`);
    errors++;
  }
}
logger.info(
  `→ Migrations: ${appliedCount} applied, ${alreadyApplied} already-tracked, ${knownBadSkipped} skipped (known-bad), ${errors} with non-fatal errors\n`,
);

// Seed minimal lookup data the tests rely on
logger.info('→ Seeding departments + doctors …');
try {
  await import('./seed-departments-doctors-local.mjs');
  logger.info('  ✓ Departments + doctors seeded\n');
} catch (err) {
  logger.info(`  ! Seed departments failed: ${err.message}\n`);
}

logger.info('→ Seeding ICD-10 catalog …');
try {
  await import('./seed-icd10-local.mjs');
  logger.info('  ✓ ICD-10 seeded\n');
} catch (err) {
  logger.info(`  ! Seed ICD-10 failed: ${err.message}\n`);
}

// Test staff accounts (EMP-1001..EMP-1021) — required for every staff-side
// login in tests, smoke runs, and the agent-driven QA swarm. Without these
// a fresh vhhealth_test has zero rows in staff/users and every EMP-100X
// login returns "Login failed", blocking all journey drivers at step 1.
logger.info('→ Seeding test staff accounts (EMP-1001..EMP-1021) …');
try {
  await import('./seed-test-staff-accounts.mjs');
  logger.info('  ✓ Test staff accounts seeded\n');
} catch (err) {
  logger.info(`  ! Seed test staff failed: ${err.message}\n`);
}

await client.end();
logger.info('CI DB setup complete.');
