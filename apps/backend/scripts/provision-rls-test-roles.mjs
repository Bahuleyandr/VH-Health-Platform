#!/usr/bin/env node
// provision-rls-test-roles.mjs
//
// Creates the non-owner RLS test roles that the *-deep RLS-posture suites
// `SET LOCAL ROLE` into (audit-append-only, tenant-rls-phase-2, tenant-rls-phi-
// routes, the cross-tenant journey, …). These connections are otherwise a
// superuser/qa_writer that would bypass tenant_isolation policies, so the suites
// switch to a sealed NOSUPERUSER NOBYPASSRLS role to make the policies actually
// fire. If the role is absent the suites skip; if it is present but ungranted
// they fail with `42501 permission denied` — exactly the failure that surfaced
// on the docker CI path (which runs ci-setup-db, not qa-cluster-up).
//
// This is the SINGLE source of that setup so qa-cluster-up.mjs (the QA cluster)
// and run-db-guardrails-docker.mjs (the docker CI path) cannot drift again.
//
// Must run connected as a SUPERUSER (CREATE ROLE + ALTER DEFAULT PRIVILEGES),
// AFTER the schema exists so `GRANT … ON ALL TABLES` covers every table.
// Idempotent. Env: DATABASE_URL (or pass connectionString); RLS_GRANT_TO_ROLE
// (optional — also GRANT each role to that login role, e.g. qa_writer, so a
// non-superuser writer can SET ROLE into them).
import pg from 'pg';

export const RLS_TEST_ROLES = [
  'rls_test_app',
  'rls_phase2_test_app',
  'rls_http_test_app',
  'rls_sectx_test_app',
  'rls_phi_routes_test_app',
  'rls_journey_test_app',
  'rls_w2_test_app',
];

export async function provisionRlsTestRoles({ connectionString, grantToRole } = {}) {
  const url = connectionString || process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('provision-rls-test-roles: DATABASE_URL (or connectionString) required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // The owner whose future tables should auto-grant to the RLS roles (the
    // connected superuser, which is also what ran the migrations).
    const { rows } = await client.query('SELECT current_user AS u');
    const owner = rows[0].u;
    for (const role of RLS_TEST_ROLES) {
      await client.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
             CREATE ROLE ${role} NOLOGIN;
           END IF;
         END $$`,
      );
      await client.query(`ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await client.query(`REVOKE ALL PRIVILEGES ON TABLE public._migrations FROM ${role}`);
      await client.query(`GRANT SELECT ON TABLE public._migrations TO ${role}`);
      await client.query(`REVOKE ALL PRIVILEGES ON SEQUENCE public._migrations_id_seq FROM ${role}`);
      // Tolerant: vector-typed function signatures throw 58P01 on clusters
      // without pgvector; the RLS suites don't need EXECUTE anyway.
      await client
        .query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`)
        .catch((err) => console.warn(`  (skipping function grants for ${role}: ${err.message})`));
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      );
      if (grantToRole) {
        await client.query(`GRANT ${role} TO ${grantToRole}`);
      }
    }
    console.log(
      `provision-rls-test-roles: ${RLS_TEST_ROLES.length} RLS test roles ready`
        + (grantToRole ? ` (granted to ${grantToRole})` : ''),
    );
  } finally {
    await client.end();
  }
}

// CLI entrypoint.
const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('provision-rls-test-roles.mjs');
if (invokedDirectly) {
  provisionRlsTestRoles({ grantToRole: process.env.RLS_GRANT_TO_ROLE || undefined })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('provision-rls-test-roles failed:', err.message);
      process.exit(1);
    });
}
