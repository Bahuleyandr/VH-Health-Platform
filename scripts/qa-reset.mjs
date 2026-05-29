#!/usr/bin/env node
// QA harness — reset spine.
//
// Tears the local QA database down to a known-good baseline:
//   1. Validate six guardrails (host, db name, NODE_ENV, role, env confirm, advisory lock).
//   2. Acquire pg advisory lock so concurrent runs fail fast.
//   3. Bootstrap schema via apps/backend/scripts/ensure-test-db.mjs (drops + prisma db push + hybrid migrations).
//   4. Seed via apps/backend/scripts/seed-comprehensive-test-data.mjs.
//   5. Seed staff accounts used by smoke tests (EMP-1001..EMP-1015).
//   6. Run scripts/seed-qa-tenant.mjs to add QA-only edge-case fixtures + record qa_seed_meta row.
//   7. Release advisory lock.
//
// Refuses to run unless every guardrail passes. By design no flag bypasses
// any guardrail — fix the env, don't fork the script.
//
// Usage:
//   NODE_ENV=qa \
//   DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test \
//   VH_QA_RESET_CONFIRM=vhhealth_test \
//     node scripts/qa-reset.mjs
//
// Optional flags:
//   --dry-run   Validate guardrails only; don't mutate anything.
//   --skip-bootstrap   Skip ensure-test-db.mjs (use when schema is already current).
//   --quiet     Suppress per-step banners.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'apps', 'backend');

// pg is installed in apps/backend/node_modules. There is no root package.json,
// so escape ESM resolution by creating a CJS require rooted at the backend.
const requireFromBackend = createRequire(path.join(backendDir, 'package.json'));
const pg = requireFromBackend('pg');

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ADVISORY_LOCK_KEY = 919117; // arbitrary stable QA-harness id
const DEFAULT_DB_NAME = 'vhhealth_test';
const DEFAULT_QA_ROLE = 'qa_writer';

const args = parseArgs(process.argv.slice(2));

const QA_DB_NAME = process.env.VHHEALTH_TEST_DB_NAME || DEFAULT_DB_NAME;
const QA_ROLE = process.env.VH_QA_DB_ROLE || DEFAULT_QA_ROLE;

function parseArgs(argv) {
  const out = { dryRun: false, skipBootstrap: false, quiet: false };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-bootstrap') out.skipBootstrap = true;
    else if (a === '--quiet') out.quiet = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function log(msg) {
  if (!args.quiet) console.log(`[qa-reset] ${msg}`);
}

function fatal(msg) {
  console.error(`[qa-reset] FATAL: ${msg}`);
  process.exit(2);
}

function parseDbUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '5432',
      user: decodeURIComponent(u.username || ''),
      database: (u.pathname || '').replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

function validateGuardrails() {
  const failures = [];

  // Guardrail 1 + 2 + 4: parse DATABASE_URL and check host/db/role.
  const url = process.env.DATABASE_URL;
  if (!url) failures.push('DATABASE_URL is not set');
  const parsed = parseDbUrl(url);
  if (url && !parsed) failures.push(`DATABASE_URL is not parseable: ${url}`);

  if (parsed) {
    if (!ALLOWED_HOSTS.has(parsed.host)) {
      failures.push(`DATABASE_URL host must be one of [${[...ALLOWED_HOSTS].join(', ')}], got ${parsed.host}`);
    }
    if (parsed.database !== QA_DB_NAME) {
      failures.push(`DATABASE_URL database must be ${QA_DB_NAME}, got ${parsed.database}`);
    }
    if (parsed.user !== QA_ROLE) {
      failures.push(`DATABASE_URL user must be ${QA_ROLE} (not postgres superuser), got ${parsed.user}`);
    }
  }

  // Guardrail 3: NODE_ENV must be qa or test.
  const env = process.env.NODE_ENV || '';
  if (!['qa', 'test'].includes(env)) {
    failures.push(`NODE_ENV must be "qa" or "test", got "${env}"`);
  }

  // Guardrail 5: explicit confirmation env var.
  const confirm = process.env.VH_QA_RESET_CONFIRM || '';
  if (confirm !== QA_DB_NAME) {
    failures.push(`VH_QA_RESET_CONFIRM must equal ${QA_DB_NAME} (got "${confirm}")`);
  }

  if (failures.length) {
    fatal(
      'guardrails failed:\n  - ' +
        failures.join('\n  - ') +
        '\nFix the environment and rerun. No flag bypasses these checks.'
    );
  }

  log(`guardrails 1-5 passed (host=${parsed.host}, db=${parsed.database}, user=${parsed.user}, NODE_ENV=${env})`);
  return parsed;
}

async function withAdvisoryLock(parsed, fn) {
  // Guardrail 6: advisory lock acquired-or-die.
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY]);
    if (!lockRes.rows[0].got) {
      fatal(`could not acquire advisory lock ${ADVISORY_LOCK_KEY}; another QA reset is already running`);
    }
    log(`acquired advisory lock ${ADVISORY_LOCK_KEY}`);
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      log('released advisory lock');
    }
  } finally {
    await client.end();
  }
}

function runScript(label, script, options = {}) {
  // options.env: KV pairs added on top of process.env.
  // options.unsetEnv: array of var names to drop from the child's env
  //   (e.g. ensure-test-db.mjs early-exits if DATABASE_URL is set).
  log(`running ${label}: ${script}`);
  const childEnv = { ...process.env, ...(options.env || {}) };
  for (const name of options.unsetEnv || []) {
    delete childEnv[name];
  }
  const result = spawnSync(process.execPath, [script], {
    cwd: backendDir,
    env: childEnv,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fatal(`${label} failed with exit code ${result.status}`);
  }
}

function computeSeedVersion() {
  // Hash the seeder source files so a finding can be tied to an exact seed.
  const sources = [
    path.join(backendDir, 'scripts', 'seed-comprehensive-test-data.mjs'),
    path.join(backendDir, 'scripts', 'seed-current-bed-structure.mjs'),
    path.join(backendDir, 'scripts', 'seed-test-staff-accounts.mjs'),
    path.join(__dirname, 'seed-qa-tenant.mjs'),
  ].filter((p) => fs.existsSync(p));

  const hash = createHash('sha256');
  for (const file of sources) {
    hash.update(file).update(fs.readFileSync(file));
  }
  return hash.digest('hex').slice(0, 16);
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

async function grantQaWriterPrivs() {
  // Connect as postgres (the URL the comprehensive seed used) to issue GRANTs.
  const postgresUrl = process.env.DATABASE_URL.replace(
    /\/\/qa_writer(:[^@]*)?@/,
    '//postgres@'
  );
  const client = new pg.Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${QA_ROLE}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
         ON ALL TABLES IN SCHEMA public TO ${QA_ROLE}`
    );
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${QA_ROLE}`
    );
    // Future tables/sequences created by the postgres role auto-grant to qa_writer.
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${QA_ROLE}`
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${QA_ROLE}`
    );
    log(`granted CRUD + sequence privileges to ${QA_ROLE} on public`);
  } finally {
    await client.end();
  }
}

async function ensureQaSeedMetaTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS qa_seed_meta (
      id           SERIAL PRIMARY KEY,
      seed_version TEXT NOT NULL,
      seeded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      git_sha      TEXT,
      seed_tag     TEXT NOT NULL DEFAULT 'qa_seed',
      notes        TEXT
    )
  `);
}

async function writeSeedMetaRow(client, seedVersion, sha, notes) {
  await ensureQaSeedMetaTable(client);
  await client.query(
    `INSERT INTO qa_seed_meta (seed_version, git_sha, seed_tag, notes)
     VALUES ($1, $2, $3, $4)`,
    [seedVersion, sha, 'qa_seed', notes]
  );
}

async function main() {
  const t0 = Date.now();
  log(`starting QA reset (dryRun=${args.dryRun}, skipBootstrap=${args.skipBootstrap})`);

  const parsed = validateGuardrails();

  if (args.dryRun) {
    log('dry-run: guardrails passed, exiting without mutation');
    return;
  }

  await withAdvisoryLock(parsed, async (lockClient) => {
    if (!args.skipBootstrap) {
      // ensure-test-db.mjs early-exits if DATABASE_URL or TEST_DATABASE_URL
      // is set. Drop them from the child env so the bootstrap rebuilds schema
      // under its own postgres superuser config.
      runScript(
        'schema bootstrap (ensure-test-db)',
        path.join(backendDir, 'scripts', 'ensure-test-db.mjs'),
        { unsetEnv: ['DATABASE_URL', 'TEST_DATABASE_URL'] }
      );
    } else {
      log('skip-bootstrap: trusting current schema');
    }

    // Comprehensive seed runs as the configured Postgres superuser via its
    // own internal env load (.env.local / .env). It uses the same DB.
    runScript(
      'comprehensive seed',
      path.join(backendDir, 'scripts', 'seed-comprehensive-test-data.mjs'),
      {
        env: {
          // Comprehensive seed needs superuser. Switch role from qa_writer
          // to postgres for this child only — the rest of the orchestrator
          // keeps using qa_writer.
          DATABASE_URL: process.env.DATABASE_URL.replace(
            /\/\/qa_writer(:[^@]*)?@/,
            '//postgres@'
          ),
        },
      }
    );

    // The DB was dropped+recreated by the bootstrap step, so any prior
    // GRANTs to qa_writer were wiped. Re-grant CRUD on the public schema
    // before the QA tenant seed runs (it connects as qa_writer).
    await grantQaWriterPrivs();

    // Staff smoke journeys assume EMP-1001..EMP-1015 exist after reset.
    runScript('test staff seed', path.join(backendDir, 'scripts', 'seed-test-staff-accounts.mjs'));

    // QA tenant seed runs as qa_writer (whatever the orchestrator was given).
    runScript('qa tenant seed', path.join(__dirname, 'seed-qa-tenant.mjs'));

    const seedVersion = computeSeedVersion();
    const sha = gitSha();
    await writeSeedMetaRow(lockClient, seedVersion, sha, `reset_at=${new Date().toISOString()}`);
    log(`recorded qa_seed_meta seed_version=${seedVersion} git_sha=${sha.slice(0, 8)}`);
  });

  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('[qa-reset] crashed:', err);
  process.exit(1);
});
