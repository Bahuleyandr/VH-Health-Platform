#!/usr/bin/env node
// scripts/smoke-migration-runner.mjs
//
// Verifies that `ci-setup-db.mjs` is tracker-driven and safe to re-run:
//
//   1. Drop + recreate a throwaway DB (default `migrun_smoke`) and enable
//      pgvector inside it (baseline requires it). Defaults target the
//      pgvector docker container described in `000_baseline.sql` —
//      127.0.0.1:56432 as user `vhhealth` / db `migrun_smoke`. Override via
//      MIGRUN_SMOKE_DB / MIGRUN_SMOKE_DB_HOST / MIGRUN_SMOKE_DB_PORT /
//      MIGRUN_SMOKE_DB_USER / MIGRUN_SMOKE_DB_PASSWORD.
//   2. Run `ci-setup-db.mjs` once. Assert it applied every `.sql` migration
//      and populated `_migrations` with one row per file.
//   3. Run `ci-setup-db.mjs` a second time. Assert it reported zero applies
//      (everything skipped via the tracker).
//   4. Corrupt one recorded checksum and assert setup exits nonzero before
//      applying a migration, seeding data, or provisioning roles.
//   5. Recreate the DB with only `000_baseline.sql`, then empty its tracker.
//      Assert `ci-setup-db.mjs` exits nonzero before applying a migration,
//      seeding data, provisioning roles, or inferring migration history.
//
// This script is destructive against its target DB only — it CREATEs and
// DROPs the database itself, never your dev `vhhealth` data DB.
//
// Recommended local run (Windows localhost→WSL forwarding is flaky — run
// from inside WSL against the pgvector docker container):
//   wsl -d Ubuntu-24.04 -- docker run -d --name vh-pg-migrunner \
//     -e POSTGRES_USER=vhhealth -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=vhhealth -p 56432:5432 pgvector/pgvector:pg17
//   wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/d/.../apps/backend && \
//     MIGRUN_SMOKE_DB_PASSWORD=test node scripts/smoke-migration-runner.mjs"

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, '..');
const ciSetupDb = join(backendRoot, 'scripts', 'ci-setup-db.mjs');
const migrationsDir = join(backendRoot, 'src', 'migrations');

const requireFromBackend = createRequire(join(backendRoot, 'package.json'));
const pg = requireFromBackend('pg');

const SMOKE_DB = process.env.MIGRUN_SMOKE_DB || 'migrun_smoke';
const HOST = process.env.MIGRUN_SMOKE_DB_HOST || '127.0.0.1';
const PORT = process.env.MIGRUN_SMOKE_DB_PORT || '56432';
const USER = process.env.MIGRUN_SMOKE_DB_USER || 'vhhealth';
const PASSWORD = process.env.MIGRUN_SMOKE_DB_PASSWORD || '';
const ADMIN_DB = process.env.MIGRUN_SMOKE_ADMIN_DB || 'postgres';

const auth = PASSWORD ? `${USER}:${encodeURIComponent(PASSWORD)}` : USER;
const adminUrl = `postgresql://${auth}@${HOST}:${PORT}/${ADMIN_DB}`;
const smokeUrl = `postgresql://${auth}@${HOST}:${PORT}/${SMOKE_DB}`;

function log(msg) {
  console.log(`[smoke-migration-runner] ${msg}`);
}

function fatal(msg) {
  console.error(`[smoke-migration-runner] FATAL: ${msg}`);
  process.exit(1);
}

async function recreateSmokeDb() {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SMOKE_DB}`);
    await admin.query(`CREATE DATABASE ${SMOKE_DB}`);
  } finally {
    await admin.end();
  }
  // baseline.sql references the pgvector type — enable it in the new DB.
  const smoke = new pg.Client({ connectionString: smokeUrl });
  await smoke.connect();
  try {
    const avail = await smoke.query(
      "SELECT 1 FROM pg_available_extensions WHERE name='vector' LIMIT 1",
    );
    if (avail.rowCount === 0) {
      fatal(
        `pgvector is not available on ${HOST}:${PORT}. Start the pgvector ` +
        'docker container per the header comment, or run this script against ' +
        'a cluster with pgvector installed.',
      );
    }
    await smoke.query('CREATE EXTENSION IF NOT EXISTS vector');
  } finally {
    await smoke.end();
  }
  log(`recreated ${SMOKE_DB} on ${HOST}:${PORT} (pgvector enabled)`);
}

function invokeCiSetup() {
  return spawnSync(process.execPath, [ciSetupDb], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: smokeUrl },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function runCiSetup() {
  const result = invokeCiSetup();
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fatal(`ci-setup-db.mjs exited ${result.status}`);
  }
  return (result.stdout || '') + (result.stderr || '');
}

async function trackerRows() {
  const c = new pg.Client({ connectionString: smokeUrl });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT name, checksum FROM _migrations ORDER BY name');
    return rows;
  } finally {
    await c.end();
  }
}

async function trackerNames() {
  const c = new pg.Client({ connectionString: smokeUrl });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT name FROM _migrations ORDER BY name');
    return rows.map(({ name }) => name);
  } finally {
    await c.end();
  }
}

async function corruptOneTrackerChecksum() {
  const c = new pg.Client({ connectionString: smokeUrl });
  await c.connect();
  try {
    const { rows } = await c.query(
      `UPDATE public._migrations
          SET checksum = $1
        WHERE name = (SELECT name FROM public._migrations ORDER BY name LIMIT 1)
      RETURNING name`,
      ['0'.repeat(64)],
    );
    return rows[0]?.name;
  } finally {
    await c.end();
  }
}

async function createUntrackedBaselineDb() {
  await recreateSmokeDb();
  const c = new pg.Client({ connectionString: smokeUrl });
  await c.connect();
  try {
    await c.query(readFileSync(join(migrationsDir, '000_baseline.sql'), 'utf8'));
    await c.query('TRUNCATE _migrations');
  } finally {
    await c.end();
  }
}

function expectedMigrationFiles() {
  return readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
}

async function main() {
  const sqlFiles = expectedMigrationFiles();
  log(`${sqlFiles.length} migration file(s) found in src/migrations/`);

  // Step 1: fresh DB → first run
  await recreateSmokeDb();
  const out1 = runCiSetup();
  const tracker1 = await trackerRows();
  if (tracker1.length < sqlFiles.length) {
    fatal(
      `first run: expected ≥${sqlFiles.length} tracker rows, got ${tracker1.length}.\n` +
      `ci-setup-db.mjs output follows:\n${out1}`,
    );
  }
  const invalidChecksums = tracker1.filter(
    ({ checksum }) => !/^[0-9a-f]{64}$/.test(String(checksum || '')),
  );
  if (invalidChecksums.length > 0) {
    fatal(`first run recorded invalid checksums: ${JSON.stringify(invalidChecksums)}`);
  }
  log(`first run OK — ${tracker1.length} tracker row(s)`);

  // Step 2: re-run on populated DB → everything skipped
  const t0 = Date.now();
  const out2 = runCiSetup();
  const ms2 = Date.now() - t0;
  if (/\b[1-9]\d* applied,/.test(out2)) {
    fatal(`second run unexpectedly applied migrations:\n${out2}`);
  }
  if (!/0 applied,/.test(out2)) {
    fatal(`second run did not log "0 applied":\n${out2}`);
  }
  log(`second run OK — 0 applied in ${ms2}ms`);

  // Step 3: established checksum drift must fail before setup can continue.
  const corrupted = await corruptOneTrackerChecksum();
  const result3 = invokeCiSetup();
  const out3 = (result3.stdout || '') + (result3.stderr || '');
  if (result3.status === 0) {
    fatal(`third run accepted checksum drift for ${corrupted}:\n${out3}`);
  }
  if (!out3.includes('MIGRATION_CHECKSUM_DRIFT') && !out3.includes('checksum mismatches')) {
    fatal(`third run did not report checksum drift for ${corrupted}:\n${out3}`);
  }
  if (/\s✓\s.+\.sql|→ Seeding|RLS test roles provisioned/.test(out3)) {
    fatal(`third run performed setup work after checksum verification failed:\n${out3}`);
  }
  log('third run OK — checksum drift rejected before migration or seed mutation');

  // Step 4: baseline schema with missing history must fail before mutation.
  await createUntrackedBaselineDb();
  const result4 = invokeCiSetup();
  const out4 = (result4.stdout || '') + (result4.stderr || '');
  const tracker4 = await trackerNames();
  if (result4.status === 0) {
    fatal(`fourth run accepted a canonical schema with missing migration history:\n${out4}`);
  }
  if (!out4.includes('canonical baseline schema exists but _migrations does not record')) {
    fatal(`fourth run did not report the missing tracker invariant:\n${out4}`);
  }
  if (tracker4.length !== 0) {
    fatal(`fourth run mutated the migration tracker: ${JSON.stringify(tracker4)}`);
  }
  if (/\s✓\s.+\.sql|→ Seeding|RLS test roles provisioned/.test(out4)) {
    fatal(`fourth run performed setup work after the tracker preflight failed:\n${out4}`);
  }
  log('fourth run OK — missing tracker rejected before migration or seed mutation');

  log('SMOKE PASSED');
}

main().catch((err) => {
  fatal(err?.stack || err?.message || String(err));
});
