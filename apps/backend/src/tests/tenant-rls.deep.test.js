// Deep integration tests for Row-Level Security tenant isolation (migration 075).
// Proves:
//   1. Cross-tenant reads via queryAsTenant are blocked (other tenant's rows hidden).
//   2. SUPER_ADMIN bypass via { superAdmin: true } returns rows from every tenant.
//   3. Legacy db.query() continues to see all rows (GUC unset = permissive policy).
//   4. RLS WITH CHECK blocks inserting a row into the wrong tenant.
//   5. queryAsTenant throws on missing tenantId without superAdmin.
//   6. WS1 B1.2 (migration 310): an INSERT that omits tenant_id auto-scopes to
//      the request tenant via the GUC-reading column DEFAULT (the WITH CHECK
//      then passes), proven end-to-end through setTenant().
//
// Why this test sets a non-owner role: Postgres exempts table OWNERS from RLS
// by default. The test harness connects as the cluster superuser, which owns
// the clinical_ai_* tables, so RLS would be silently bypassed. Production runs
// as a dedicated app role (not the table owner), where RLS is enforced. To
// faithfully simulate production we create `rls_test_app` at setup time and
// pipe every assertion through a thin helper that SETs that ROLE before the
// statement runs. The legacy `db.query()` test (case 3) also uses this helper
// to confirm permissive behavior under a non-owner role.

import prisma, { setTenant } from '../lib/prisma.js';

// Owner-path helper (no RLS enforcement — Postgres exempts table owners).
// Used for setup/teardown + the permissive-GUC assertion. Matches the old
// `db.query()` contract: `$executeRawUnsafe` for writes that don't return
// rows, `$queryRawUnsafe` for anything that does.
async function ownerQuery(text, params = []) {
  // Heuristic: SELECT / WITH / RETURNING → rows come back.
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
const TENANT_B = '00000000-0000-4000-8000-0000000000b2';
const TAG_A = 'rls-deep-test-tenant-a';
const TAG_B = 'rls-deep-test-tenant-b';
// Tag for the WS1 B1.2 GUC-default insert (migration 310). Distinct so its
// row is cleaned up alongside TAG_A / TAG_B without colliding with them.
const TAG_GUC_DEFAULT = 'rls-deep-test-guc-default-b';
const APP_ROLE = 'rls_test_app';

// Shape that callers expected from the previous pg-based helpers: a plain
// `{ rows, rowCount }` envelope. We return `rowCount` from `length` because
// SELECTs don't track it separately under Prisma raw calls.
function toPgShape(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  return { rows: arr, rowCount: arr.length };
}

// Run a query as the non-owner APP_ROLE. Mirrors the contract of
// `db.queryAsTenant`: optional superAdmin bypass. Uses `prisma.$transaction`
// (batch 28+) — the $transaction callback gets a tenant-scoped `tx` client
// and BEGIN/COMMIT is implicit, so `SET LOCAL ROLE` + the GUC set_config
// are scoped to this single transaction and can't bleed across test cases.
async function asAppRole(text, params, tenantId, { superAdmin = false } = {}) {
  if (!superAdmin && !tenantId) {
    throw new Error('asAppRole requires tenantId (or { superAdmin: true })');
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    const gucValue = superAdmin ? 'bypass' : tenantId;
    await tx.$executeRawUnsafe(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      gucValue,
    );
    const rows = await tx.$queryRawUnsafe(text, ...params);
    return toPgShape(rows);
  });
}

// Variant that leaves the GUC unset — simulates legacy `db.query()` from a
// non-owner app role. RLS should be permissive.
async function asAppRoleNoGuc(text, params) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
    const rows = await tx.$queryRawUnsafe(text, ...params);
    return toPgShape(rows);
  });
}

describeIfDb('Tenant RLS policies (migration 075)', () => {
  // Remember any pre-existing runtime-role env so we can restore it in
  // afterAll. The WS1 B1.2 test below drives setTenant() (not the inline
  // asAppRole helper), so it needs setTenant to issue `SET LOCAL ROLE
  // rls_test_app` — otherwise, when this suite's DATABASE_URL connects as a
  // superuser (the default test URL), RLS is bypassed and the WITH CHECK
  // assertion would be vacuous. tenantRlsRuntimeRole() reads process.env live
  // per transaction, so setting it here is sufficient.
  const prevRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
  const prevTestRole = process.env.AUTH_TENANT_RLS_TEST_ROLE;

  beforeAll(async () => {
    // setTenant()'s SET LOCAL ROLE target. Scoped to this suite (restored in
    // afterAll) so it can't leak the role into unrelated suites in the chunk.
    process.env.AUTH_TENANT_RLS_TEST_ROLE = APP_ROLE;

    // Create the non-owner application role if it does not already exist, and
    // grant it the minimum privileges needed to exercise RLS on the two tables
    // this suite touches. CREATE ROLE is idempotent via DO/pg_roles check.
    await ownerQuery(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_test_app') THEN
          CREATE ROLE rls_test_app NOLOGIN;
        END IF;
      END $$;
    `);
    await ownerQuery(`GRANT USAGE ON SCHEMA public TO rls_test_app`);
    await ownerQuery(`GRANT SELECT, INSERT, UPDATE, DELETE ON clinical_ai_generations TO rls_test_app`);
    await ownerQuery(`GRANT SELECT ON tenants TO rls_test_app`);
    await ownerQuery(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_test_app`);

    // Seed tenant B via the legacy path (bypasses RLS on `tenants` table — not
    // one of the 11 tenant-scoped tables in the policy set).
    await ownerQuery(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'rls-deep-b', 'RLS Deep Test Tenant B', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_B]
    );

    // Clean prior runs (both tenants), then seed one generation per tenant via
    // the legacy owner path (so the seed itself is not subject to RLS).
    await ownerQuery(
      `DELETE FROM clinical_ai_generations
       WHERE source_hash IN ($1, $2, $3, 'rls-wrong-tenant-insert')`,
      [TAG_A, TAG_B, TAG_GUC_DEFAULT]
    );

    await ownerQuery(
      `INSERT INTO clinical_ai_generations
         (tenant_id, task_type, provider, model, prompt_version, source_hash, status)
       VALUES ($1::uuid, 'rls_test', 'template', 'test', 'rls-v1', $2, 'draft')`,
      [TENANT_A, TAG_A]
    );

    await ownerQuery(
      `INSERT INTO clinical_ai_generations
         (tenant_id, task_type, provider, model, prompt_version, source_hash, status)
       VALUES ($1::uuid, 'rls_test', 'template', 'test', 'rls-v1', $2, 'draft')`,
      [TENANT_B, TAG_B]
    );
  });

  afterAll(async () => {
    // Owner path cleanup — RLS is exempt for the owner, so a single DELETE
    // reaches rows for both tenants. Delete the clinical_ai rows BEFORE the
    // tenant row so the FK constraint doesn't fire.
    await ownerQuery(
      `DELETE FROM clinical_ai_generations
       WHERE source_hash IN ($1, $2, $3, 'rls-wrong-tenant-insert')`,
      [TAG_A, TAG_B, TAG_GUC_DEFAULT]
    );
    await ownerQuery(
      `DELETE FROM tenants WHERE id = $1::uuid`,
      [TENANT_B]
    );

    // Restore the runtime-role env exactly as it was before this suite ran.
    if (prevRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = prevRuntimeRole;
    if (prevTestRole === undefined) delete process.env.AUTH_TENANT_RLS_TEST_ROLE;
    else process.env.AUTH_TENANT_RLS_TEST_ROLE = prevTestRole;
  });

  it('blocks cross-tenant reads when scoped to TENANT_A', async () => {
    const result = await asAppRole(
      `SELECT tenant_id, source_hash FROM clinical_ai_generations
       WHERE source_hash IN ($1, $2)`,
      [TAG_A, TAG_B],
      TENANT_A
    );
    const sources = result.rows.map((r) => r.source_hash);
    expect(sources).toContain(TAG_A);
    expect(sources).not.toContain(TAG_B);
    for (const row of result.rows) {
      expect(String(row.tenant_id)).toBe(TENANT_A);
    }
  });

  it('blocks cross-tenant reads when scoped to TENANT_B', async () => {
    const result = await asAppRole(
      `SELECT tenant_id, source_hash FROM clinical_ai_generations
       WHERE source_hash IN ($1, $2)`,
      [TAG_A, TAG_B],
      TENANT_B
    );
    const sources = result.rows.map((r) => r.source_hash);
    expect(sources).toContain(TAG_B);
    expect(sources).not.toContain(TAG_A);
  });

  it('allows SUPER_ADMIN bypass to see all tenants', async () => {
    const result = await asAppRole(
      `SELECT tenant_id, source_hash FROM clinical_ai_generations
       WHERE source_hash IN ($1, $2)`,
      [TAG_A, TAG_B],
      null,
      { superAdmin: true }
    );
    const sources = result.rows.map((r) => r.source_hash);
    expect(sources).toContain(TAG_A);
    expect(sources).toContain(TAG_B);
  });

  it('keeps legacy db.query() semantics permissive (GUC unset, non-owner role sees all rows)', async () => {
    // The real legacy `db.query()` runs as the owner (which is always exempt
    // from RLS) — but this test still has to demonstrate that the RLS policy
    // is PERMISSIVE when the GUC is unset, even for a non-owner role. So we
    // call the helper that sets ROLE but skips the GUC, and expect both rows.
    const result = await asAppRoleNoGuc(
      `SELECT tenant_id, source_hash FROM clinical_ai_generations
       WHERE source_hash IN ($1, $2)`,
      [TAG_A, TAG_B]
    );
    const sources = result.rows.map((r) => r.source_hash);
    expect(sources).toContain(TAG_A);
    expect(sources).toContain(TAG_B);
  });

  it('blocks INSERT of a row into the wrong tenant (RLS WITH CHECK)', async () => {
    // GUC is TENANT_A, but the INSERT tries to place the row under TENANT_B.
    // The WITH CHECK clause must reject the write with a policy violation.
    await expect(
      asAppRole(
        `INSERT INTO clinical_ai_generations
           (tenant_id, task_type, provider, model, prompt_version, source_hash, status)
         VALUES ($1::uuid, 'rls_test', 'template', 'test', 'rls-v1', 'rls-wrong-tenant-insert', 'draft')`,
        [TENANT_B],
        TENANT_A
      )
    ).rejects.toThrow();

    // Confirm nothing landed on disk, even via bypass.
    const verifyRows = await setTenant(
      null,
      (tx) => tx.$queryRawUnsafe(
        `SELECT 1 FROM clinical_ai_generations WHERE source_hash = 'rls-wrong-tenant-insert'`
      ),
      { superAdmin: true },
    );
    expect(Array.isArray(verifyRows) ? verifyRows.length : 0).toBe(0);
  });

  it('throws when setTenant is called without tenantId or superAdmin', async () => {
    await expect(
      setTenant(null, (tx) => tx.$queryRawUnsafe('SELECT 1'))
    ).rejects.toThrow(/requires tenantId/);
  });

  // WS1 B1.2 — multi-tenant INSERT completion (migration 310).
  // Before 310, the tenant_id column DEFAULTed to the LITERAL default tenant,
  // so an INSERT under setTenant(TENANT_B) that omitted tenant_id got the
  // default-tenant value, which then FAILED the tenant_isolation WITH CHECK
  // (default != TENANT_B) with a 42501 — only single-tenant inserts worked.
  // Migration 310 changes the DEFAULT to read the GUC, so an insert that omits
  // tenant_id auto-scopes to the request tenant and the WITH CHECK passes.
  // This proves that end-to-end through the app's own setTenant() helper, under
  // the non-owner / non-bypassrls rls_test_app role (so the WITH CHECK is
  // genuinely enforced, not bypassed).
  it('auto-populates tenant_id from the GUC default on an INSERT that omits it (migration 310)', async () => {
    // setTenant issues SET LOCAL ROLE rls_test_app (AUTH_TENANT_RLS_TEST_ROLE,
    // set in beforeAll) then SET LOCAL app.current_tenant_id = TENANT_B. The
    // INSERT names NO tenant_id, so the GUC-reading column DEFAULT supplies it.
    const inserted = await setTenant(TENANT_B, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (task_type, provider, model, prompt_version, source_hash, status)
       VALUES ('rls_test', 'template', 'test', 'rls-v1', $1, 'draft')
       RETURNING tenant_id`,
      TAG_GUC_DEFAULT,
    ));
    // The write succeeded (no 42501) AND the row auto-scoped to TENANT_B.
    expect(Array.isArray(inserted) ? inserted.length : 0).toBe(1);
    expect(String(inserted[0].tenant_id)).toBe(TENANT_B);

    // Independently confirm the persisted row carries TENANT_B (read via a
    // super-admin bypass so the assertion can't be fooled by RLS filtering).
    const verifyRows = await setTenant(
      null,
      (tx) => tx.$queryRawUnsafe(
        `SELECT tenant_id FROM clinical_ai_generations WHERE source_hash = $1`,
        TAG_GUC_DEFAULT,
      ),
      { superAdmin: true },
    );
    expect(verifyRows.length).toBe(1);
    expect(String(verifyRows[0].tenant_id)).toBe(TENANT_B);
  });
});

if (!hasDatabaseUrl) {
  console.warn(
    'tenant-rls.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.'
  );
}
