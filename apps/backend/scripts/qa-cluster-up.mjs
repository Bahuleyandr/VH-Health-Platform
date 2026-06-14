#!/usr/bin/env node
// QA cluster bring-up — single-command, idempotent.
//
// Brings up the local QA test cluster at 127.0.0.1:55432 (database
// `vhhealth_test`, role `qa_writer`), then applies any pending raw
// SQL migrations. Designed to be the one prerequisite that turns a
// stopped cluster into the state the qa-orchestrator + qa-reset
// scripts (and the `vh-health-qa` skill) expect.
//
// Idempotent: re-running against a healthy cluster is a fast no-op.
//
// Windows IPv6 caveat (2026-05-13): on this dev host, ::1:55432 has
// an invisible kernel-level reservation that blocks `postgres.exe`
// from binding (despite .NET / Node sockets binding the same address
// fine). We pin postgres to IPv4-only with `-o "-h 127.0.0.1"` and
// also write `listen_addresses = '127.0.0.1'` into postgresql.conf so
// any subsequent `pg_ctl start` invocations behave the same. The
// other dev cluster (port 5433) is unaffected — only port 55432 hits
// the reservation. See CLAUDE.md "Database Access" for the long form.
//
// Usage:
//   node apps/backend/scripts/qa-cluster-up.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

// pg lives in apps/backend/node_modules. Reach it via CJS require.
const requireFromBackend = createRequire(path.join(backendDir, 'package.json'));
const pg = requireFromBackend('pg');

const HOST = '127.0.0.1';
const PORT = process.env.VHHEALTH_TEST_DB_PORT || '55432';
const DB_NAME = process.env.VHHEALTH_TEST_DB_NAME || 'vhhealth_test';
const QA_ROLE = 'qa_writer';
const QA_PASSWORD = 'qa_writer_local';
const SUPERUSER = 'postgres';
const PGDATA =
  process.env.VHHEALTH_TEST_PGDATA ||
  (process.platform === 'win32'
    ? 'D:/Dev/Tools/vhhealth-test-postgres-data'
    : path.join(process.env.HOME || '', '.vhhealth-test-postgres-data'));
const PG_BIN =
  process.env.PG_BIN ||
  (process.platform === 'win32'
    ? 'C:/Program Files/PostgreSQL/17/bin'
    : '/usr/local/bin');
const LOG_FILE = path.join(PGDATA, 'logfile');

const QA_URL = `postgresql://${QA_ROLE}:${QA_PASSWORD}@${HOST}:${PORT}/${DB_NAME}`;
const SUPER_URL = `postgresql://${SUPERUSER}@${HOST}:${PORT}/${DB_NAME}`;
const ADMIN_URL = `postgresql://${SUPERUSER}@${HOST}:${PORT}/postgres`;

function bin(name) {
  return path.join(PG_BIN, process.platform === 'win32' ? `${name}.exe` : name);
}

function log(msg) {
  console.log(`[qa-cluster-up] ${msg}`);
}

function fatal(msg) {
  console.error(`[qa-cluster-up] FATAL: ${msg}`);
  process.exit(1);
}

function pgIsReady() {
  const r = spawnSync(bin('pg_isready'), ['-h', HOST, '-p', PORT], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return r.status === 0;
}

function ensureListenAddressesIpv4Only() {
  // Defensive: rewrite the listen_addresses line in postgresql.conf so
  // future `pg_ctl start` invocations without `-o "-h 127.0.0.1"` also
  // bind IPv4-only. We never want postgres to attempt ::1:55432 on this
  // host. Line-based to avoid regex pitfalls with CRLF.
  const confPath = path.join(PGDATA, 'postgresql.conf');
  if (!fs.existsSync(confPath)) {
    fatal(`postgresql.conf not found at ${confPath} — is the cluster initialized?`);
  }
  const raw = fs.readFileSync(confPath, 'utf8');
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const targetLine = `listen_addresses = '127.0.0.1'\t\t# IPv4 only — IPv6 ::1:${PORT} reserved on this host (see apps/backend/CLAUDE.md)`;
  const lineMatch = /^[ \t]*#?[ \t]*listen_addresses[ \t]*=/;
  let changed = false;
  let found = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lineMatch.test(lines[i])) {
      found = true;
      if (lines[i] !== targetLine) {
        lines[i] = targetLine;
        changed = true;
      }
      break;
    }
  }
  if (!found) {
    lines.push(targetLine);
    changed = true;
  }
  if (changed) {
    log('updating postgresql.conf listen_addresses to 127.0.0.1');
    fs.writeFileSync(confPath, lines.join(newline));
  }
}

function startCluster() {
  if (pgIsReady()) {
    log(`cluster already accepting connections on ${HOST}:${PORT}`);
    return;
  }
  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
    fatal(
      `PGDATA at ${PGDATA} is not an initialized cluster. ` +
        `Run scripts/ensure-test-db.mjs first (it initdb's the cluster).`
    );
  }
  log(`starting cluster from ${PGDATA} on ${HOST}:${PORT}`);
  const r = spawnSync(
    bin('pg_ctl'),
    [
      '-D', PGDATA,
      '-l', LOG_FILE,
      '-o', `-p ${PORT} -h ${HOST}`,
      '-w',
      '-t', '60',
      'start',
    ],
    { encoding: 'utf8', stdio: 'inherit' }
  );
  if (r.status !== 0) {
    let tail = '';
    try {
      tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-15).join('\n');
    } catch {
      tail = '<could not read logfile>';
    }
    if (tail.includes('Permission denied')) {
      fatal(
        `pg_ctl start failed with "Permission denied" on bind. ` +
          `Even with -h 127.0.0.1 this should not happen on this host. ` +
          `Steps to recover: 1) Get-Process postgres (kill any non-service zombie). ` +
          `2) wsl --shutdown. 3) re-run. Last log:\n${tail}`
      );
    }
    fatal(`pg_ctl start failed (exit ${r.status}). Last log:\n${tail}`);
  }
  log('cluster started');
}

async function ensureDatabaseAndRole() {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    const dbRes = await client.query(
      `SELECT 1, datname,
              pg_encoding_to_char(encoding) AS enc
         FROM pg_database
        WHERE datname = $1`,
      [DB_NAME]
    );
    if (dbRes.rowCount === 0) {
      // Pin ENCODING=UTF8 + TEMPLATE template0 so the new DB inherits
      // UTF-8 regardless of what template1 happens to be on this host.
      // Non-UTF8 storage silently corrupts multibyte clinical text
      // (em dashes, °C, μg, Tamil/Hindi script) to U+FFFD on read.
      // Finding: 2026-05-09-surgical-day-care-nurse-non-ascii-theatre-checklist.
      log(`creating database ${DB_NAME} with ENCODING 'UTF8'`);
      await client.query(`CREATE DATABASE ${DB_NAME} ENCODING 'UTF8' TEMPLATE template0`);
    } else if (dbRes.rows[0].enc && String(dbRes.rows[0].enc).toUpperCase() !== 'UTF8') {
      // Refuse to proceed against a non-UTF8 DB — re-creating it loses
      // data, but silently using it corrupts clinical text. Operator
      // recovery: drop & recreate (or re-run after dropping the stray DB).
      fatal(
        `existing database ${DB_NAME} has encoding=${dbRes.rows[0].enc}, not UTF8. ` +
          `Multibyte clinical chars will silently corrupt to U+FFFD. ` +
          `Drop the DB ('DROP DATABASE ${DB_NAME}') and re-run, or pick a different DB_NAME.`
      );
    }

    const roleRes = await client.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [QA_ROLE]
    );
    if (roleRes.rowCount === 0) {
      log(`creating role ${QA_ROLE}`);
      await client.query(`CREATE ROLE ${QA_ROLE} LOGIN PASSWORD '${QA_PASSWORD}'`);
    } else {
      // Make password deterministic so the orchestrator URL keeps working.
      await client.query(`ALTER ROLE ${QA_ROLE} WITH PASSWORD '${QA_PASSWORD}'`);
    }
  } finally {
    await client.end();
  }

  // Grants run against the target DB.
  const dbClient = new pg.Client({ connectionString: SUPER_URL });
  await dbClient.connect();
  try {
    await dbClient.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await dbClient.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${QA_ROLE}`);
    await dbClient.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
         ON ALL TABLES IN SCHEMA public TO ${QA_ROLE}`
    );
    await dbClient.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${QA_ROLE}`
    );
    await dbClient.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${SUPERUSER} IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${QA_ROLE}`
    );
    await dbClient.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${SUPERUSER} IN SCHEMA public
         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${QA_ROLE}`
    );

    // Non-owner RLS test roles (roadmap A2). The *-deep RLS suites SET LOCAL
    // ROLE to these so tenant_isolation policies actually fire even though
    // qa_writer/superuser connections would otherwise bypass them. qa_writer
    // cannot CREATE ROLE itself, so provision them here (idempotent).
    for (const rlsRole of ['rls_test_app', 'rls_phase2_test_app', 'rls_http_test_app', 'rls_sectx_test_app', 'rls_phi_routes_test_app', 'rls_journey_test_app']) {
      await dbClient.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rlsRole}') THEN
            CREATE ROLE ${rlsRole} NOLOGIN;
          END IF;
        END $$`);
      await dbClient.query(`ALTER ROLE ${rlsRole} NOSUPERUSER NOBYPASSRLS`);
      await dbClient.query(`GRANT USAGE ON SCHEMA public TO ${rlsRole}`);
      await dbClient.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rlsRole}`
      );
      await dbClient.query(
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${rlsRole}`
      );
      // Tolerant: on clusters without pgvector, resolving vector-typed
      // function signatures throws 58P01 — EXECUTE on specific functions is
      // not needed by the RLS suites anyway.
      await dbClient.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${rlsRole}`)
        .catch((err) => console.warn(`  (skipping function grants for ${rlsRole}: ${err.message})`));
      await dbClient.query(`GRANT ${rlsRole} TO ${QA_ROLE}`);
      await dbClient.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${SUPERUSER} IN SCHEMA public
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rlsRole}`
      );
    }
  } finally {
    await dbClient.end();
  }
}

function applyMigrations() {
  log('applying pending migrations via ci-setup-db.mjs');
  const r = spawnSync(
    process.execPath,
    [path.join(backendDir, 'scripts', 'ci-setup-db.mjs')],
    {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: SUPER_URL },
      stdio: 'inherit',
    }
  );
  if (r.status !== 0) {
    fatal(`ci-setup-db.mjs exited with code ${r.status}`);
  }
}

async function verifyWindowsConnectivity() {
  // Test the exact URL the orchestrator + reset use.
  const client = new pg.Client({ connectionString: QA_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT current_user AS u, current_database() AS d, inet_server_port() AS p`
    );
    const row = r.rows[0];
    log(`verified qa_writer connect: user=${row.u} db=${row.d} port=${row.p}`);
  } finally {
    await client.end();
  }
}

async function main() {
  ensureListenAddressesIpv4Only();
  startCluster();
  if (!pgIsReady()) {
    fatal('cluster started but pg_isready still reports failure');
  }
  await ensureDatabaseAndRole();
  applyMigrations();
  await verifyWindowsConnectivity();
  console.log(`\nQA cluster ready at ${QA_URL}\n`);
}

main().catch((err) => {
  console.error('[qa-cluster-up] crashed:', err);
  process.exit(1);
});
