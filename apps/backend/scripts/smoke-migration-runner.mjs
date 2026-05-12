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
//   4. `TRUNCATE _migrations` to simulate a DB with full baseline schema but
//      empty tracker (the migration scenario the auto-detect branch handles).
//      Run `ci-setup-db.mjs` again. Assert it re-recorded `000_baseline.sql`
//      via the canonical-table probe and processed the remaining migrations
//      idempotently.
//
// This script is destructive against its target DB only — it CREATEs and
// DROPs the database itself, never your dev `vhhealth` data DB.
//
// Recommended local run (Windows localhost→WSL forwarding is flaky — run
// from inside WSL against the pgvector docker container):
//   wsl -d Ubuntu-24.04 -- docker run -d --name vh-pg-migrunner \
//     -e POSTGRES_USER=vhhealth -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=vhhealth -p 56432:5432 pgvector/pgvector:pg16
//   wsl -d Ubuntu-24.04 -- bash -c "cd /mnt/d/.../apps/backend && \
//     MIGRUN_SMOKE_DB_PASSWORD=test node scripts/smoke-migration-runner.mjs"

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

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

function runCiSetup() {
  const result = spawnSync(process.execPath, [ciSetupDb], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: smokeUrl },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    fatal(`ci-setup-db.mjs exited ${result.status}`);
  }
  return (result.stdout || '') + (result.stderr || '');
}

async function trackerNames() {
  const c = new pg.Client({ connectionString: smokeUrl });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT name FROM _migrations ORDER BY name');
    return rows.map((r) => r.name);
  } finally {
    await c.end();
  }
}

async function truncateTracker() {
  const c = new pg.Client({ connectionString: smokeUrl });
  await c.connect();
  try {
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
  const tracker1 = await trackerNames();
  if (tracker1.length < sqlFiles.length) {
    fatal(
      `first run: expected ≥${sqlFiles.length} tracker rows, got ${tracker1.length}.\n` +
      `ci-setup-db.mjs output follows:\n${out1}`,
    );
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

  // Step 3: simulate baseline-applied-but-untracked
  await truncateTracker();
  const out3 = runCiSetup();
  const tracker3 = await trackerNames();
  if (!out3.includes('Detected pre-existing baseline schema')) {
    fatal(`third run did not auto-detect baseline:\n${out3}`);
  }
  if (!tracker3.includes('000_baseline.sql')) {
    fatal(`third run did not record 000_baseline.sql via auto-detect. tracker=${JSON.stringify(tracker3)}`);
  }
  log(`third run OK — baseline auto-detect re-recorded ${tracker3.length} row(s)`);

  log('SMOKE PASSED');
}

main().catch((err) => {
  fatal(err?.stack || err?.message || String(err));
});
