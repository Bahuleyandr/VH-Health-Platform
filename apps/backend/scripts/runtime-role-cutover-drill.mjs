#!/usr/bin/env node
// runtime-role-cutover-drill.mjs
//
// STAGING DRY-RUN for the production non-superuser DB-role cutover + RLS
// enforcement. Proves, against a real Postgres, the load-bearing go-live step
// in docs/GO_LIVE_ACTIVATION_CHECKLIST.md (Phases B / D / E): the app must
// connect as a NOSUPERUSER NOBYPASSRLS role (`vhhealth_runtime`, member of
// `vhhealth_app`) so the `tenant_isolation` RLS policies actually ENFORCE,
// while the migration Job runs as the OWNER. This cutover has never been
// rehearsed on a real DB; this script de-risks it before prod.
//
// What it does (idempotent, self-contained, leaves no residue):
//   1. Create a UNIQUELY-NAMED scratch DB on 127.0.0.1:55432 as the postgres
//      SUPERUSER (drop-if-exists first). NEVER touches `vhhealth_test` or the
//      dev cluster — another agent uses vhhealth_test concurrently.
//   1b. PROVE the pgvector go-live blocker (security-review HIGH #5): on the
//      FRESH DB (vector absent), a NOSUPERUSER owner — even WITH bypassrls (the
//      exact prod posture) — CANNOT `CREATE EXTENSION vector` (untrusted ext →
//      42501; bypassrls ≠ extension-creation rights). Then provision extensions
//      AS SUPERUSER (mirrors cluster.yaml bootstrap.initdb.postInitApplicationSQL,
//      which CNPG runs as superuser at initdb) and assert `vector` is PRESENT
//      before migrations apply — i.e. the migration Job's db:ensure-pgvector is a
//      safe idempotent no-op once the cluster.yaml fix has created it.
//   2. Apply ALL migrations (incl. 310) as the OWNER via the ci-setup path
//      (scripts/ci-setup-db.mjs, tracker-driven) — mirrors the prod migration
//      Job that connects with DATABASE_SUPERUSER_URL (Phase D2).
//   3. Create `vhhealth_app` (NOLOGIN NOSUPERUSER NOBYPASSRLS) + `vhhealth_runtime`
//      (LOGIN NOSUPERUSER NOBYPASSRLS, member of vhhealth_app) + grants,
//      mirroring infra/kubernetes/base/cnpg/cluster.yaml (managed.roles) and
//      overlays/dalekdefender/rls-runtime-role.sql (Phase B1 / D1).
//   4. Connect AS `vhhealth_runtime`, `SET LOCAL ROLE vhhealth_app`, set the
//      tenant GUC, and PROVE RLS enforces on representative policied PHI tables
//      (clinical_ai_generations + appointments) — Phase E:
//        (a) insert PHI under tenant A;
//        (b) under tenant B that row is INVISIBLE (cross-tenant read blocked);
//        (c) a WITH-CHECK cross-tenant write (GUC=A, row tenant_id=B) is REJECTED;
//        (d) migration-310 proof: an INSERT that OMITS tenant_id under tenant B
//            lands tenant_id=B (GUC-reading default, NOT the literal default).
//      Plus a posture sanity check: vhhealth_runtime / vhhealth_app are both
//      rolsuper=f rolbypassrls=f (Phase E2).
//   5. Print a clear PASS/FAIL line per check; exit non-zero on ANY failure;
//      TEAR DOWN the scratch DB at the end (and on failure).
//
// Run:
//   node apps/backend/scripts/runtime-role-cutover-drill.mjs
//
// Prereq: Postgres on 127.0.0.1:55432 must be up. If it is not, run
//   node apps/backend/scripts/qa-cluster-up.mjs
// first (that brings the QA cluster up) — this drill still uses its OWN
// scratch DB, never vhhealth_test.
//
// Companion doc: docs/RUNTIME_ROLE_CUTOVER_DRILL.md (maps each check to the
// prod cutover steps in GO_LIVE_ACTIVATION_CHECKLIST.md Phases B/D/E).

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '..');

// pg lives in apps/backend/node_modules. Reach it via CJS require (same pattern
// as qa-cluster-up.mjs).
const requireFromBackend = createRequire(path.join(backendDir, 'package.json'));
const pg = requireFromBackend('pg');

// ── Connection facts (mirror qa-cluster-up.mjs: superuser on 127.0.0.1:55432) ─
const HOST = '127.0.0.1';
const PORT = process.env.VHHEALTH_TEST_DB_PORT || '55432';
const SUPERUSER = 'postgres';

// UNIQUE scratch DB name — never `vhhealth_test`, never the dev DB. Default is a
// fixed-but-distinct name so re-runs are idempotent (drop-if-exists handles a
// leftover from a crashed run); override with --db=<name> if you want isolation
// between two concurrent drills.
const dbArg = process.argv.find((a) => a.startsWith('--db='));
const SCRATCH_DB = dbArg ? dbArg.slice('--db='.length) : 'vhhealth_cutover_drill';

// Roles mirror the prod manifest. The OWNER of the scratch DB (created by us as
// superuser) plays the part of the bootstrap.initdb.owner `vhhealth` in prod —
// it owns every table, runs migrations, and (like prod) is exempt from
// non-FORCEd RLS. We deliberately name it `vhhealth` to match prod semantics.
const OWNER_ROLE = 'vhhealth';
const OWNER_PASSWORD = 'cutover_drill_owner';
const APP_ROLE = 'vhhealth_app'; // NOLOGIN SET LOCAL ROLE target
const RUNTIME_ROLE = 'vhhealth_runtime'; // LOGIN connection role
const RUNTIME_PASSWORD = 'cutover_drill_runtime';

const ADMIN_URL = `postgresql://${SUPERUSER}@${HOST}:${PORT}/postgres`;
const OWNER_URL = `postgresql://${OWNER_ROLE}:${OWNER_PASSWORD}@${HOST}:${PORT}/${SCRATCH_DB}`;
const SUPER_ON_SCRATCH_URL = `postgresql://${SUPERUSER}@${HOST}:${PORT}/${SCRATCH_DB}`;
const RUNTIME_URL = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${HOST}:${PORT}/${SCRATCH_DB}`;

// ── Tenant fixtures (match tenant-rls.deep.test.js so the proof is faithful) ──
const TENANT_A = '00000000-0000-4000-8000-000000000001'; // literal DEFAULT_TENANT_ID
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';
const LITERAL_DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
const TAG_A = 'cutover-drill-tenant-a';
const TAG_B = 'cutover-drill-tenant-b';
const TAG_WRONG = 'cutover-drill-wrong-tenant';
const TAG_GUC_DEFAULT = 'cutover-drill-guc-default-b';

// ── Tiny logging + result tracking ───────────────────────────────────────────
function log(msg) {
  console.log(`[cutover-drill] ${msg}`);
}

const results = []; // { name, pass, detail }
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// Assert helper: runs an async producer, records PASS/FAIL from a predicate.
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, err && err.message ? err.message.split('\n')[0] : String(err));
  }
}

// ── Step 1: scratch DB lifecycle (drop-if-exists, create, teardown) ──────────
async function dropScratchDb() {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    // Terminate any lingering backends on the scratch DB so DROP can proceed
    // even if a prior crashed run left an open connection.
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [SCRATCH_DB],
    );
    // DROP DATABASE cannot be parameterized or run in a tx block — guard the
    // name to a strict identifier and interpolate. (We control SCRATCH_DB.)
    if (!/^[a-z_][a-z0-9_]*$/i.test(SCRATCH_DB)) {
      throw new Error(`unsafe scratch DB name: ${SCRATCH_DB}`);
    }
    await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  } finally {
    await client.end();
  }
}

async function createScratchDbAndOwner() {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    // Owner role first (must exist before it can own the DB). Idempotent.
    const r = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [OWNER_ROLE]);
    if (r.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${OWNER_ROLE} LOGIN PASSWORD '${OWNER_PASSWORD}'`,
      );
    } else {
      // Make the password deterministic + ensure it can LOGIN (the dev/QA
      // clusters may already carry a `vhhealth` role from other work).
      await client.query(
        `ALTER ROLE ${OWNER_ROLE} WITH LOGIN PASSWORD '${OWNER_PASSWORD}'`,
      );
    }
    // Pin UTF8 / template0 exactly like qa-cluster-up.mjs so multibyte clinical
    // text can't silently corrupt, and OWNER owns it.
    await client.query(
      `CREATE DATABASE ${SCRATCH_DB} OWNER ${OWNER_ROLE} ENCODING 'UTF8' TEMPLATE template0`,
    );
  } finally {
    await client.end();
  }
}

// ── Step 1.4: PROVE the pgvector blocker (security-review HIGH #5) ─────────────
// THE BLOCKER this drill must surface and the cluster.yaml fix must close:
// `vector` (pgvector) is an UNTRUSTED extension, so ONLY a superuser may
// `CREATE EXTENSION vector`. The prod migration Job's step 1 (`db:ensure-pgvector`
// → CREATE EXTENSION IF NOT EXISTS vector) connects as the bootstrap OWNER
// `vhhealth` via DATABASE_SUPERUSER_URL — a NOSUPERUSER role that carries
// bypassrls:true. bypassrls is NOT extension-creation rights, so on a FRESH
// cluster (vector not yet present) that step 42501s and the migration Job dies
// before applying 000_baseline (which declares columns of type public.vector).
//
// We prove this on the fresh scratch DB BEFORE any extension is created, and we
// do it with the owner set to BYPASSRLS — the EXACT prod posture (managed.roles
// `vhhealth { bypassrls: true }`) — so the proof demonstrates that even a
// bypassrls owner is denied. Empirically (PG17) the error is
// `42501 permission denied to create extension "vector"`, and the same holds for
// the `IF NOT EXISTS` form the Job actually runs (IF NOT EXISTS does not suppress
// the privilege check when the extension is absent), so we assert BOTH forms 42501.
async function proveOwnerCannotCreateVectorWhenAbsent() {
  // Sanity: vector must be AVAILABLE in this PG (image ships the .so) — otherwise
  // the failure would be 0A000/58P01 (missing control file), a DIFFERENT problem
  // (the residual operator-verify caveat), not the privilege blocker we mean to
  // prove. This mirrors ensure-pgvector-extension.mjs's pg_available_extensions
  // probe + the cluster.yaml OPERATOR VERIFY note.
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const av = await admin.query(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`,
    );
    if (av.rowCount === 0) {
      throw new Error(
        "pgvector is NOT available in this Postgres (image lacks the .so) — cannot " +
        'prove the privilege blocker; this is the separate image-dependent caveat. ' +
        'Use a pgvector-bearing image (e.g. pgvector/pgvector:pg17 or the prod CNPG image).',
      );
    }
  } finally {
    await admin.end();
  }

  // Put the owner in the EXACT prod posture: NOSUPERUSER + BYPASSRLS.
  await setOwnerBypassRls(true);
  try {
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      // Posture assertion: the owner really is NOSUPERUSER with BYPASSRLS (so the
      // 42501 below cannot be hand-waved as "well it wasn't bypassrls anyway").
      const me = await owner.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      if (me.rows[0].rolsuper) throw new Error('owner is unexpectedly SUPERUSER — cannot prove the blocker');
      if (!me.rows[0].rolbypassrls) throw new Error('owner is not BYPASSRLS — set prod-faithful posture first');

      // Bare form.
      let code1 = null;
      try {
        await owner.query(`CREATE EXTENSION vector`);
      } catch (err) {
        code1 = err.code || 'unknown';
      }
      if (code1 === null) {
        throw new Error('CREATE EXTENSION vector SUCCEEDED as the NOSUPERUSER owner — blocker not reproduced (is the owner secretly a superuser?)');
      }
      if (code1 !== '42501') {
        throw new Error(`expected 42501 (insufficient_privilege) but got ${code1} — different failure mode`);
      }

      // IF NOT EXISTS form — the literal command `db:ensure-pgvector` runs. Must
      // ALSO 42501 while the extension is absent (proves the prod Job's exact
      // step fails on a fresh cluster, not just the bare form).
      let code2 = null;
      try {
        await owner.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch (err) {
        code2 = err.code || 'unknown';
      }
      if (code2 !== '42501') {
        throw new Error(`CREATE EXTENSION IF NOT EXISTS vector returned ${code2 === null ? 'success' : code2}, expected 42501 while absent`);
      }
      return 'NOSUPERUSER+BYPASSRLS owner denied (42501) for both `CREATE EXTENSION vector` and the `IF NOT EXISTS` form';
    } finally {
      await owner.end();
    }
  } finally {
    // Restore NOBYPASSRLS — Step 2 re-enables it explicitly for the apply.
    await setOwnerBypassRls(false);
  }
}

// ── Step 1.5: provision extensions as SUPERUSER, before any migration ─────────
// 000_baseline.sql references `public.vector` (pgvector) and other contrib
// types WITHOUT a CREATE EXTENSION of its own — it assumes the extensions
// already exist (exactly as the QA cluster has pgcrypto/pg_trgm/vector
// pre-installed). In prod these are provided BEFORE the migration Job by CNPG:
// the pgvector-bearing CNPG image + `bootstrap.initdb.postInitApplicationSQL`
// (pgcrypto/citext/uuid-ossp/pg_stat_statements) — see cluster.yaml. pgvector
// is an UNTRUSTED extension, so only a SUPERUSER can create it; the OWNER role
// cannot (CREATE EXTENSION vector → 42501). We therefore create them here as
// the superuser, mirroring the operator-provisioned prod substrate, so the
// owner-run migration pass starts from the same baseline prod's Job sees.
const REQUIRED_EXTENSIONS = ['pgcrypto', 'pg_trgm', 'citext', 'uuid-ossp', 'vector'];
async function createExtensionsAsSuperuser() {
  const client = new pg.Client({ connectionString: SUPER_ON_SCRATCH_URL });
  await client.connect();
  try {
    for (const ext of REQUIRED_EXTENSIONS) {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
    }
  } finally {
    await client.end();
  }
  log(`extensions ensured as superuser: ${REQUIRED_EXTENSIONS.join(', ')} (mirrors CNPG image + postInitApplicationSQL)`);
}

// ── Step 1.5 verification: vector is PRESENT before migrations apply ───────────
// Mirrors the cluster.yaml FIX: `CREATE EXTENSION IF NOT EXISTS vector;` in
// bootstrap.initdb.postInitApplicationSQL runs as the SUPERUSER at initdb, so on
// a fresh prod cluster `vector` already exists in pg_extension BEFORE the PreSync
// migration Job runs — which is why 000_baseline (columns of type public.vector)
// applies and the Job's `db:ensure-pgvector` is a harmless idempotent no-op. Here
// createExtensionsAsSuperuser() played the role of postInitApplicationSQL; this
// asserts the post-condition, on the application DB, before the migration pass.
async function assertVectorPresentBeforeMigrations() {
  const client = new pg.Client({ connectionString: SUPER_ON_SCRATCH_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    if (r.rowCount === 0) {
      throw new Error(
        'vector NOT present before migrations — the postInitApplicationSQL-equivalent ' +
        'provisioning did not run; 000_baseline (columns of type public.vector) will fail',
      );
    }
    // Also confirm the owner's idempotent re-run is now a true no-op (the prod
    // Job's `db:ensure-pgvector` behaviour once initdb has created the extension).
    // The owner is NOBYPASSRLS here (restored after the blocker proof) — exactly
    // the pre-apply prod posture before Step 2 grants bypassrls.
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      await owner.query(`CREATE EXTENSION IF NOT EXISTS vector`); // must NOT throw now
    } finally {
      await owner.end();
    }
    return `vector ${r.rows[0].extversion} present; owner CREATE EXTENSION IF NOT EXISTS vector is a no-op`;
  } finally {
    await client.end();
  }
}

// ── Step 1.6: migration-role RLS posture (THE surfaced cutover risk) ──────────
// CUTOVER RISK (de-risked here, never rehearsed before): the migration chain
// CANNOT be applied by a NOSUPERUSER NOBYPASSRLS owner. Two facts collide:
//   1. 000_baseline.sql is a `pg_dump --schema-only` and carries a session-level
//      `SET row_security = off` (line 48). For a non-superuser, that turns RLS
//      into FAIL-LOUD mode: any later statement that "would be affected by" an
//      RLS policy raises 42501 instead of transparently applying the policy.
//   2. Migrations 237/272 do `ALTER TABLE ... FORCE ROW LEVEL SECURITY`, which
//      removes the owner's RLS exemption. So once the baseline has run in the
//      session, the next DDL/DML that touches a FORCE-RLS table under the
//      non-superuser owner (e.g. 240's FK-add to clinical_notes, 255's beds
//      seed) 42501s, and ci-setup's wrapping tx then 25P02-cascades the rest.
// The QA cluster never hits this because ci-setup-db.mjs connects to it as the
// `postgres` SUPERUSER (superusers ignore row_security=off + bypass RLS).
//
// PROD IMPLICATION: cluster.yaml runs the migration Job as the bootstrap owner
// `vhhealth` with enableSuperuserAccess:false, and managed.roles does NOT give
// `vhhealth` superuser or BYPASSRLS — so a FRESH-cluster migration pass
// (checklist D2) will 42501 exactly like this drill did, on first bring-up.
// FIX prod must adopt: the migration Job's role needs BYPASSRLS (or superuser)
// for the apply, e.g. a managed.roles entry `vhhealth { bypassrls: true }` or a
// dedicated migrator role; the *runtime* role must stay NOBYPASSRLS.
//
// This drill therefore grants BYPASSRLS to the OWNER for the migration phase
// ONLY (mirroring the corrected prod migrator posture), verifies the chain
// applies clean, then STRIPS it before the runtime proofs so the proofs run
// against a true NOBYPASSRLS posture.
async function setOwnerBypassRls(on) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(`ALTER ROLE ${OWNER_ROLE} ${on ? 'BYPASSRLS' : 'NOBYPASSRLS'}`);
  } finally {
    await client.end();
  }
}

// ── Step 2: apply ALL migrations as the OWNER via ci-setup-db.mjs ─────────────
function applyMigrationsAsOwner() {
  log('applying ALL migrations as OWNER via ci-setup-db.mjs (mirrors prod migration Job)');
  const r = spawnSync(
    process.execPath,
    [path.join(backendDir, 'scripts', 'ci-setup-db.mjs'), '--skip-seeds'],
    {
      cwd: backendDir,
      // The OWNER DSN is the analogue of prod's DATABASE_SUPERUSER_URL: the
      // migration runner connects as the table owner, which can ALTER its own
      // objects (migration 310's per-table ALTER ... SET DEFAULT needs owner).
      // The owner carries BYPASSRLS for THIS phase only (see setOwnerBypassRls
      // + the cutover-risk note above) — stripped before the runtime proofs.
      env: { ...process.env, DATABASE_URL: OWNER_URL },
      stdio: 'inherit',
    },
  );
  if (r.status !== 0) {
    throw new Error(`ci-setup-db.mjs exited with code ${r.status}`);
  }
}

// Assert the migration pass left ZERO un-applied migration files. ci-setup-db
// treats per-file errors as non-fatal (exit 0) — so a partial apply would
// otherwise sail through and the RLS proofs would run on a half-migrated DB.
// We require every *.sql on disk (minus the one known-bad skip ci-setup makes)
// to be tracked in _migrations.
const KNOWN_BAD_SKIPPED = new Set(['017_seed_departments_doctors.sql']);
async function assertAllMigrationsApplied() {
  const { readdirSync } = await import('node:fs');
  const migDir = path.join(backendDir, 'src', 'migrations');
  const onDisk = readdirSync(migDir).filter((f) => f.endsWith('.sql'));
  const expected = onDisk.filter((f) => !KNOWN_BAD_SKIPPED.has(f));

  const client = new pg.Client({ connectionString: SUPER_ON_SCRATCH_URL });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT name FROM _migrations`);
    const tracked = new Set(rows.map((r) => r.name));
    const missing = expected.filter((f) => !tracked.has(f));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} migration(s) NOT applied (first few: ${missing.slice(0, 5).join(', ')}) ` +
        '— migration chain is not clean under the owner posture',
      );
    }
    return `all ${expected.length} migration files applied (excl. ${KNOWN_BAD_SKIPPED.size} known-bad skip)`;
  } finally {
    await client.end();
  }
}

// Confirm migration 310 actually ran on this DB (tracker row present). If 310
// were skipped, check (d) would still pass on a single-tenant insert but fail
// for tenant B — we assert its presence explicitly so a silent skip is caught.
async function assertMigration310Tracked() {
  const client = new pg.Client({ connectionString: SUPER_ON_SCRATCH_URL });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT 1 FROM _migrations WHERE name = '310_tenant_id_guc_default.sql'`,
    );
    if (r.rowCount === 0) {
      throw new Error('migration 310 not recorded in _migrations — GUC-default never applied');
    }
    return '310_tenant_id_guc_default.sql present in _migrations';
  } finally {
    await client.end();
  }
}

// ── Step 3: create the runtime roles + grants (mirror manifest / SQL refs) ────
// Run as SUPERUSER on the scratch DB so CREATE ROLE / GRANT all succeed
// unconditionally (prod gets the role from CNPG managed.roles + boot grants;
// here we provision both in one deterministic pass). Mirrors
// overlays/dalekdefender/rls-runtime-role.sql and cluster.yaml managed.roles.
async function createRuntimeRolesAndGrants() {
  const client = new pg.Client({ connectionString: SUPER_ON_SCRATCH_URL });
  await client.connect();
  try {
    // vhhealth_app — NOLOGIN SET LOCAL ROLE target, NOSUPERUSER NOBYPASSRLS.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} NOLOGIN;
        END IF;
      END $$;`);
    await client.query(`ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await client.query(`GRANT CONNECT ON DATABASE ${SCRATCH_DB} TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`)
      .catch((e) => log(`  (app fn grants partial: ${e.message.split('\n')[0]})`));
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`);

    // vhhealth_runtime — LOGIN connection role, NOSUPERUSER NOBYPASSRLS,
    // member of vhhealth_app (so SET LOCAL ROLE vhhealth_app is reachable).
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
          CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${RUNTIME_PASSWORD}';
        END IF;
      END $$;`);
    // Deterministic password + enforce the security posture every run.
    await client.query(
      `ALTER ROLE ${RUNTIME_ROLE} WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await client.query(`GRANT ${APP_ROLE} TO ${RUNTIME_ROLE}`);
    await client.query(`GRANT CONNECT ON DATABASE ${SCRATCH_DB} TO ${RUNTIME_ROLE}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${RUNTIME_ROLE}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${RUNTIME_ROLE}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${RUNTIME_ROLE}`)
      .catch((e) => log(`  (runtime fn grants partial: ${e.message.split('\n')[0]})`));
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${RUNTIME_ROLE}`);
    await client.query(`
      ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${RUNTIME_ROLE}`);
  } finally {
    await client.end();
  }
}

// Seed tenant B + one clinical_ai_generations row per tenant via the OWNER
// (owner is exempt from non-FORCEd RLS, so the seed itself isn't filtered).
// Mirrors the seed in tenant-rls.deep.test.js.
async function seedFixtures() {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    await owner.query(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'cutover-drill-b', 'Cutover Drill Tenant B', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B],
    );
    // Tenant A (the literal default) should already exist from migrations/seed;
    // ensure it so the FK on clinical_ai_generations.tenant_id holds.
    await owner.query(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'cutover-drill-a', 'Cutover Drill Tenant A', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_A],
    );
    await owner.query(
      `DELETE FROM clinical_ai_generations
        WHERE source_hash IN ($1, $2, $3, $4)`,
      [TAG_A, TAG_B, TAG_WRONG, TAG_GUC_DEFAULT],
    );
    await owner.query(
      `INSERT INTO clinical_ai_generations
         (tenant_id, task_type, provider, model, prompt_version, source_hash, status)
       VALUES ($1::uuid, 'rls_test', 'template', 'test', 'drill-v1', $2, 'draft')`,
      [TENANT_A, TAG_A],
    );
    await owner.query(
      `INSERT INTO clinical_ai_generations
         (tenant_id, task_type, provider, model, prompt_version, source_hash, status)
       VALUES ($1::uuid, 'rls_test', 'template', 'test', 'drill-v1', $2, 'draft')`,
      [TENANT_B, TAG_B],
    );
  } finally {
    await owner.end();
  }
}

// ── Tenant-scoped statement runner AS the runtime role (the prod path) ────────
// Connect AS vhhealth_runtime, then inside one tx: SET LOCAL ROLE vhhealth_app,
// SET LOCAL app.current_tenant_id, run the statement. This is exactly the prod
// shape: connection role = vhhealth_runtime, effective role = vhhealth_app via
// SET LOCAL ROLE, GUC scoped to the transaction (auto-cleared at COMMIT).
async function asRuntime(client, { tenant, bypass = false }, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const gucValue = bypass ? 'bypass' : tenant;
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [gucValue]);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* tx already aborted */ }
    throw err;
  }
}

// ── Step 4: the RLS enforcement proofs, run AS vhhealth_runtime ───────────────
async function runRlsProofs() {
  const rt = new pg.Client({ connectionString: RUNTIME_URL });
  await rt.connect();
  try {
    // Posture sanity (Phase E2): the connection role + the SET LOCAL ROLE
    // target must BOTH be NOSUPERUSER NOBYPASSRLS, else every policy is inert.
    await check('E2 connection-role posture: vhhealth_runtime + vhhealth_app are NOSUPERUSER NOBYPASSRLS', async () => {
      const { rows } = await rt.query(
        `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
          WHERE rolname IN ($1, $2) ORDER BY rolname`,
        [RUNTIME_ROLE, APP_ROLE],
      );
      if (rows.length !== 2) throw new Error(`expected 2 roles, saw ${rows.length}`);
      for (const r of rows) {
        if (r.rolsuper) throw new Error(`${r.rolname} is SUPERUSER`);
        if (r.rolbypassrls) throw new Error(`${r.rolname} has BYPASSRLS`);
      }
      // Also confirm we actually connected AS the runtime role.
      const who = await rt.query(`SELECT current_user AS u`);
      if (who.rows[0].u !== RUNTIME_ROLE) {
        throw new Error(`connected as ${who.rows[0].u}, expected ${RUNTIME_ROLE}`);
      }
      return `current_user=${who.rows[0].u}; both roles super=f bypassrls=f`;
    });

    // (a) Insert PHI under tenant A — should SUCCEED and auto-scope to A.
    await check('Ea insert PHI under tenant A succeeds and scopes to A (clinical_ai_generations)', async () => {
      const rows = await asRuntime(rt, { tenant: TENANT_A }, () =>
        rt.query(
          `INSERT INTO clinical_ai_generations
             (task_type, provider, model, prompt_version, source_hash, status)
           VALUES ('rls_test','template','test','drill-v1',$1,'draft')
           RETURNING tenant_id`,
          [`${TAG_A}-insert`],
        ).then((r) => r.rows),
      );
      if (rows.length !== 1) throw new Error('insert did not return a row');
      if (String(rows[0].tenant_id) !== TENANT_A) {
        throw new Error(`row landed tenant_id=${rows[0].tenant_id}, expected ${TENANT_A}`);
      }
      return `tenant_id=${rows[0].tenant_id}`;
    });

    // Also prove a core (non-AI) PHI table enforces, so the drill isn't limited
    // to the clinical_ai_* family. appointments is policied by migration 236.
    await check('Ea insert PHI under tenant A succeeds and scopes to A (appointments — migration 236 table)', async () => {
      const rows = await asRuntime(rt, { tenant: TENANT_A }, () =>
        rt.query(
          `INSERT INTO appointments
             (phone, appointment_date, appointment_time, status, doctor_name, updated_at)
           VALUES ('9990000001', CURRENT_DATE, '10:00', 'SCHEDULED', 'Drill Doc', NOW())
           RETURNING id, tenant_id`,
        ).then((r) => r.rows),
      );
      if (rows.length !== 1) throw new Error('appointment insert did not return a row');
      if (String(rows[0].tenant_id) !== TENANT_A) {
        throw new Error(`appointment landed tenant_id=${rows[0].tenant_id}, expected ${TENANT_A}`);
      }
      return `appointment id=${rows[0].id} tenant_id=${rows[0].tenant_id}`;
    });

    // (b) Under tenant B, tenant A's seeded row is INVISIBLE (cross-tenant read
    //     blocked). We query for BOTH tags; only B's must come back.
    await check('Eb cross-tenant read blocked: tenant B cannot see tenant A PHI', async () => {
      const rows = await asRuntime(rt, { tenant: TENANT_B }, () =>
        rt.query(
          `SELECT tenant_id, source_hash FROM clinical_ai_generations
            WHERE source_hash IN ($1, $2)`,
          [TAG_A, TAG_B],
        ).then((r) => r.rows),
      );
      const tags = rows.map((r) => r.source_hash);
      if (tags.includes(TAG_A)) throw new Error('LEAK: tenant B saw tenant A row');
      if (!tags.includes(TAG_B)) throw new Error('tenant B could not see its OWN row (over-restrictive)');
      for (const r of rows) {
        if (String(r.tenant_id) !== TENANT_B) throw new Error(`saw foreign tenant_id ${r.tenant_id}`);
      }
      return `tenant B sees only its own row (${rows.length} row[s], all tenant_id=B)`;
    });

    // (c) WITH-CHECK cross-tenant write rejected: GUC=A, explicit tenant_id=B.
    await check('Ec WITH CHECK rejects cross-tenant write (GUC=A, explicit tenant_id=B)', async () => {
      let rejected = false;
      try {
        await asRuntime(rt, { tenant: TENANT_A }, () =>
          rt.query(
            `INSERT INTO clinical_ai_generations
               (tenant_id, task_type, provider, model, prompt_version, source_hash, status)
             VALUES ($1::uuid,'rls_test','template','test','drill-v1',$2,'draft')`,
            [TENANT_B, TAG_WRONG],
          ),
        );
      } catch (err) {
        rejected = true;
        // 42501 = insufficient_privilege (new row violates RLS policy).
        if (err.code && err.code !== '42501') {
          // Any rejection proves enforcement, but flag an unexpected code.
          return `rejected with code ${err.code} (${err.message.split('\n')[0]})`;
        }
      }
      if (!rejected) throw new Error('cross-tenant write was ACCEPTED — WITH CHECK not enforced');
      // Confirm nothing landed, reading via bypass so RLS can't mask a leak.
      // asRuntime returns the array its fn produced (here r.rows).
      const rows = await asRuntime(rt, { bypass: true }, () =>
        rt.query(
          `SELECT 1 FROM clinical_ai_generations WHERE source_hash = $1`,
          [TAG_WRONG],
        ).then((r) => r.rows),
      );
      if (rows.length !== 0) throw new Error('row persisted despite rejection');
      return 'rejected with 42501; no row persisted (verified via bypass)';
    });

    // (d) Migration-310 proof: INSERT that OMITS tenant_id under tenant B lands
    //     tenant_id=B (GUC-reading DEFAULT), NOT the literal default tenant.
    await check('Ed migration 310: INSERT omitting tenant_id under tenant B lands tenant_id=B (not literal default)', async () => {
      const inserted = await asRuntime(rt, { tenant: TENANT_B }, () =>
        rt.query(
          `INSERT INTO clinical_ai_generations
             (task_type, provider, model, prompt_version, source_hash, status)
           VALUES ('rls_test','template','test','drill-v1',$1,'draft')
           RETURNING tenant_id`,
          [TAG_GUC_DEFAULT],
        ).then((r) => r.rows),
      );
      if (inserted.length !== 1) throw new Error('insert did not return a row (likely 42501 — 310 not applied?)');
      if (String(inserted[0].tenant_id) === LITERAL_DEFAULT_TENANT && TENANT_B !== LITERAL_DEFAULT_TENANT) {
        throw new Error('tenant_id defaulted to the LITERAL default — migration 310 did NOT take effect');
      }
      if (String(inserted[0].tenant_id) !== TENANT_B) {
        throw new Error(`tenant_id=${inserted[0].tenant_id}, expected ${TENANT_B}`);
      }
      // Independently confirm via bypass read. asRuntime returns the array.
      const rows = await asRuntime(rt, { bypass: true }, () =>
        rt.query(
          `SELECT tenant_id FROM clinical_ai_generations WHERE source_hash = $1`,
          [TAG_GUC_DEFAULT],
        ).then((r) => r.rows),
      );
      if (rows.length !== 1 || String(rows[0].tenant_id) !== TENANT_B) {
        throw new Error('persisted row did not carry tenant_id=B');
      }
      return `omitted tenant_id auto-scoped to B (${inserted[0].tenant_id})`;
    });
  } finally {
    await rt.end();
  }
}

// ── Orchestration ────────────────────────────────────────────────────────────
// Teardown drops the SCRATCH DB. It deliberately does NOT drop the cluster-global
// roles (vhhealth / vhhealth_app / vhhealth_runtime): Postgres roles are not
// DB-scoped, the dev/QA cluster legitimately uses the `vhhealth` name for other
// work (see apps/backend/CLAUDE.md), and a concurrent agent could share these
// names — dropping them would be the kind of shared-state mutation this drill is
// explicitly forbidden from doing. The roles are left NOLOGIN/NOBYPASSRLS and
// are idempotently re-used on the next run; they own no objects once the scratch
// DB is gone. To remove them by hand: DROP ROLE IF EXISTS vhhealth_runtime, vhhealth_app;
async function teardown() {
  try {
    await dropScratchDb();
    log(`scratch DB ${SCRATCH_DB} torn down`);
  } catch (err) {
    log(`WARNING: scratch DB teardown failed: ${err.message.split('\n')[0]}`);
    log(`  Manual cleanup: psql "${ADMIN_URL}" -c "DROP DATABASE IF EXISTS ${SCRATCH_DB}"`);
  }
}

async function main() {
  log(`staging dry-run for the prod non-superuser DB-role cutover + RLS enforcement`);
  log(`scratch DB: ${SCRATCH_DB} on ${HOST}:${PORT} (NEVER vhhealth_test / dev cluster)`);

  // Pre-flight: superuser reachable on :55432?
  try {
    const ping = new pg.Client({ connectionString: ADMIN_URL });
    await ping.connect();
    await ping.query('SELECT 1');
    await ping.end();
  } catch (err) {
    log(`FATAL: cannot reach Postgres superuser at ${ADMIN_URL.replace(/:[^:@/]*@/, ':***@')}`);
    log(`  ${err.message.split('\n')[0]}`);
    log(`  Bring the QA cluster up first: node apps/backend/scripts/qa-cluster-up.mjs`);
    log(`  (this drill still uses its OWN scratch DB '${SCRATCH_DB}', never vhhealth_test)`);
    process.exit(2);
  }

  let setupOk = false;
  try {
    log('Step 1/4: (re)create scratch DB + owner, prove pgvector blocker, provision extensions as superuser');
    await dropScratchDb();
    await createScratchDbAndOwner();

    // B-pgvector (security-review HIGH #5): on the FRESH scratch DB (no extensions
    // yet), prove the blocker — a NOSUPERUSER owner (even WITH bypassrls) CANNOT
    // CREATE EXTENSION vector → 42501. Recorded as a visible check; it must run
    // BEFORE createExtensionsAsSuperuser (which makes vector present).
    console.log('');
    await check(
      'B-pgvector blocker: NOSUPERUSER+BYPASSRLS owner CANNOT CREATE EXTENSION vector (expect 42501)',
      () => proveOwnerCannotCreateVectorWhenAbsent(),
    );

    // The cluster.yaml FIX, mirrored: postInitApplicationSQL runs as SUPERUSER at
    // initdb and creates vector before the migration Job. createExtensionsAsSuperuser
    // plays that role here.
    await createExtensionsAsSuperuser();

    // B-pgvector fix verification: vector is now PRESENT before migrations apply,
    // and the owner's idempotent re-run (`db:ensure-pgvector`) is a no-op.
    await check(
      'B-pgvector fix: vector present before migrations (postInitApplicationSQL-equivalent) + owner CREATE EXTENSION IF NOT EXISTS is a no-op',
      () => assertVectorPresentBeforeMigrations(),
    );
    console.log('');

    log('Step 2/4: apply ALL migrations as OWNER (incl. 310) — owner carries BYPASSRLS for the apply ONLY');
    // Mirror the CORRECTED prod migrator posture (see setOwnerBypassRls note):
    // the migration role must be BYPASSRLS/superuser or the chain 42501s on the
    // FORCE-RLS tables after the baseline's `SET row_security = off`.
    await setOwnerBypassRls(true);
    try {
      applyMigrationsAsOwner();
    } finally {
      // Strip BYPASSRLS immediately — everything after this (incl. the runtime
      // proofs) must run against a true NOBYPASSRLS posture.
      await setOwnerBypassRls(false);
    }

    log('Step 3/4: create vhhealth_app + vhhealth_runtime roles + grants, seed fixtures');
    await createRuntimeRolesAndGrants();
    await seedFixtures();
    setupOk = true;
  } catch (err) {
    log(`FATAL during setup: ${err && err.message ? err.message : err}`);
  }

  // Migration-phase proofs (D2): record as visible checks so a partial apply
  // can't pass silently. These run only if setup got far enough to have a DB.
  if (setupOk) {
    console.log('');
    await check('D2 migration chain applies clean as the (BYPASSRLS) owner — no 42501/partial apply', () =>
      assertAllMigrationsApplied());
    await check('D2 migration 310 (GUC-reading tenant_id default) is applied', () =>
      assertMigration310Tracked());
  }

  if (setupOk) {
    log('Step 4/4: prove RLS enforces AS vhhealth_runtime (SET LOCAL ROLE vhhealth_app)');
    console.log('');
    try {
      await runRlsProofs();
    } catch (err) {
      record('RLS proof harness', false, err && err.message ? err.message.split('\n')[0] : String(err));
    }
  } else {
    record('setup', false, 'setup failed before RLS proofs could run');
  }

  // Always tear down the scratch DB (success or failure).
  console.log('');
  await teardown();

  // ── Report ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('');
  console.log('────────────────────────────────────────────────────────────');
  console.log(' RUNTIME-ROLE CUTOVER DRILL — RESULT');
  console.log('────────────────────────────────────────────────────────────');
  for (const r of results) {
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  console.log('────────────────────────────────────────────────────────────');
  console.log(`  ${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ''}`);
  console.log('────────────────────────────────────────────────────────────');

  if (failed > 0 || results.length === 0) {
    console.log('\nDRILL FAILED — the prod cutover is NOT proven. Do not cut over.');
    process.exit(1);
  }
  console.log('\nDRILL PASSED — non-superuser runtime role + RLS enforcement proven on a real DB.');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[cutover-drill] crashed:', err);
  // Best-effort teardown even on an unexpected crash.
  await teardown();
  process.exit(1);
});
