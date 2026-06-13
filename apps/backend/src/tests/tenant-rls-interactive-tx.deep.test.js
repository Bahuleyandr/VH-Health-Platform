// SEC-3 / B1.3 — interactive-transaction tenant isolation.
//
// tenant-rls.deep.test.js proves the SQL layer; tenant-rls-phase-2.deep.test.js
// proves the prisma-proxy auto-wrapper for top-level raw/model calls;
// tenant-rls-http.deep.test.js proves the full request path. NONE of them
// covered the gap this suite closes: code that opens its OWN interactive
// transaction via `prisma.$transaction(async (tx) => …)`.
//
// The gap: the prisma proxy's auto-wrapper only scopes top-level
// `prisma.$queryRaw*` / `prisma.model.*` calls. The `tx` client handed to a
// `prisma.$transaction` callback bypasses that wrapper, so `app.current_tenant_id`
// stays UNSET inside the tx → migration 075/304's tenant_isolation policy falls
// through to its PERMISSIVE branch → cross-tenant PHI is reachable inside the
// transaction. The fix is `setTenantTx(tenantId, fn)` (src/lib/prisma.js), which
// issues `set_config('app.current_tenant_id', …, true)` (and SET LOCAL ROLE) as
// the FIRST statements of the tx so the strict branch applies to every query.
//
// This suite is deliberately NON-VACUOUS: it first proves the LEAK still
// happens with a bare `prisma.$transaction` (the pre-fix shape), then proves
// `setTenantTx` closes it — so a regression that silently stops scoping would
// fail the "fixed" assertions while the "leak" assertions keep passing.
//
// It also exercises the real converted service path: admissionService
// .markForDischarge({ tenantId: <other tenant> }) against another tenant's
// admission now throws notFound (the scoped FOR UPDATE select cannot see the
// row) instead of mutating cross-tenant PHI.
//
// Role model mirrors the sibling deep tests: CI connects as a superuser
// (bypasses RLS even under FORCE), local QA as qa_writer. Routing the tx
// through a non-owner, NOBYPASSRLS role via AUTH_TENANT_RLS_RUNTIME_ROLE makes
// enforcement real in both environments.

import prisma, { setTenantTx } from '../lib/prisma.js';
import { runInTenantContext } from '../lib/tenantContext.js';
import admissionService from '../services/emr/admissionService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaac21';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbc22';
// Unique per-run patient_uids so a crashed prior run can't collide. admissions
// has no FK on patient_uid, so any uuid is fine.
const PUID_A = 'cccccccc-cccc-4ccc-8ccc-ccccccccc0a1';
const PUID_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddd0b2';
// admissions.admitting_doctor is uuid; tag rows for cleanup/selection via the
// free-text `ward` column instead. Any uuid is fine for admitting_doctor (no FK).
const DOC_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeee0c3';
const WARD_TAG_A = 'RLS-SECTX-WARD-A';
const WARD_TAG_B = 'RLS-SECTX-WARD-B';
const APP_ROLE = 'rls_sectx_test_app';

let savedEnforceFlag;
let savedRuntimeRole;
let admissionAId;
let admissionBId;

async function cleanup() {
  // discharge_consults rows are opened by markForDischarge (happy path) — clear
  // them first (FK to admissions). Best-effort across partially-migrated DBs.
  await prisma.$executeRawUnsafe(
    `DELETE FROM discharge_consults
       WHERE admission_id IN (SELECT id FROM admissions WHERE ward IN ($1, $2))`,
    WARD_TAG_A, WARD_TAG_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE ward IN ($1, $2)`,
    WARD_TAG_A, WARD_TAG_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

d('Tenant RLS — interactive $transaction isolation (SEC-3 / B1.3)', () => {
  beforeAll(async () => {
    savedEnforceFlag = process.env.AUTH_ENFORCE_TENANT_RLS;
    savedRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;

    await cleanup();

    // Ensure the non-owner app role exists with the grants this suite needs.
    // Tolerant of non-superuser QA roles (same contract as the sibling suites).
    try {
      await prisma.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
            CREATE ROLE ${APP_ROLE} NOLOGIN;
          END IF;
        END $$;
      `);
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
      // markForDischarge touches admissions + discharge_consults + audit_logs +
      // the canonical timeline/audit/SLA tables. Grant broadly so the scoped
      // role can execute the whole converted path. Tolerant of pgvector-less
      // clusters that throw resolving vector-typed columns.
      await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
      await prisma.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
      const member = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid
           JOIN pg_roles g ON g.oid = m.member
          WHERE r.rolname = $1 AND g.rolname = current_user LIMIT 1`,
        APP_ROLE,
      );
      if (!member.length) {
        const me = (await prisma.$queryRawUnsafe(`SELECT current_user AS u`))[0].u;
        await prisma.$executeRawUnsafe(`GRANT ${APP_ROLE} TO ${me}`).catch(() => {});
      }
    } catch (err) {
      const exists = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`, APP_ROLE,
      );
      if (!exists.length) {
        throw new Error(
          `Test role ${APP_ROLE} missing and current user cannot CREATE ROLE ` +
          `(seed once as superuser). Original error: ${err.message}`,
        );
      }
    }

    // Seed both tenants (FK target for admissions.tenant_id). Permissive path
    // (GUC unset) so FORCE RLS does not block the seed.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'RLS SecTx Tenant A', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A, `rls-sectx-a-${Date.now()}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'RLS SecTx Tenant B', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, `rls-sectx-b-${Date.now()}`,
    );

    // One 'admitted' admission per tenant (markForDischarge requires admitted).
    // Tagged via `ward` (free text); admitting_doctor is a valid placeholder uuid.
    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, ward, status, admitted_at, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'admitted', NOW(), $1::uuid, NOW())
       RETURNING id`,
      PUID_A, TENANT_A, DOC_UUID, WARD_TAG_A,
    );
    admissionAId = a[0].id;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, ward, status, admitted_at, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'admitted', NOW(), $1::uuid, NOW())
       RETURNING id`,
      PUID_B, TENANT_B, DOC_UUID, WARD_TAG_B,
    );
    admissionBId = b[0].id;
  }, 30000);

  afterAll(async () => {
    if (savedEnforceFlag === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnforceFlag;
    if (savedRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedRuntimeRole;
    await cleanup();
  }, 30000);

  // ----- NON-VACUOUS CONTROL: the bare-$transaction shape STILL leaks -----
  // This is the pre-fix behaviour. A non-owner role inside a plain
  // prisma.$transaction with the GUC UNSET hits the policy's permissive branch
  // and sees BOTH tenants' admissions. If this assertion ever fails, the test
  // below is vacuous (RLS would be blocking regardless of the fix) and must be
  // re-examined.
  it('LEAK (control): bare prisma.$transaction with GUC unset sees BOTH tenants admissions', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
    // Emulate the pre-fix converted-service shape: an interactive tx opened
    // under a tenant-B request context, SET LOCAL ROLE to the prod-like
    // non-owner role, but WITHOUT the GUC (exactly what a bare
    // prisma.$transaction does — the tx client skips the auto-wrapper).
    const rows = await runInTenantContext(TENANT_B, () => prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      return tx.$queryRawUnsafe(
        `SELECT id, tenant_id::text AS tenant_id FROM admissions
          WHERE ward IN ($1, $2) ORDER BY id`,
        WARD_TAG_A, WARD_TAG_B,
      );
    }));
    const tenants = rows.map((r) => r.tenant_id);
    expect(tenants).toContain(TENANT_A);
    expect(tenants).toContain(TENANT_B);
    expect(rows).toHaveLength(2);
  });

  // ----- FIX: setTenantTx scopes the interactive tx to one tenant -----
  it('FIX: setTenantTx(TENANT_B) inside the tx sees ONLY tenant-B admission', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
    const rows = await setTenantTx(TENANT_B, (tx) => tx.$queryRawUnsafe(
      `SELECT id, tenant_id::text AS tenant_id FROM admissions
        WHERE ward IN ($1, $2) ORDER BY id`,
      WARD_TAG_A, WARD_TAG_B,
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(admissionBId);
    expect(rows[0].tenant_id).toBe(TENANT_B);
  });

  it('FIX: setTenantTx(TENANT_A) inside the tx sees ONLY tenant-A admission (symmetry)', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
    const rows = await setTenantTx(TENANT_A, (tx) => tx.$queryRawUnsafe(
      `SELECT id, tenant_id::text AS tenant_id FROM admissions
        WHERE ward IN ($1, $2) ORDER BY id`,
      WARD_TAG_A, WARD_TAG_B,
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(admissionAId);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('FIX: setTenantTx(TENANT_A) UPDATE cannot touch tenant-B admission (RLS USING hides the row)', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;
    // Scoped to A, attempt to mutate B's row by id. RLS USING hides it, so the
    // UPDATE matches zero rows (affected count 0) — no cross-tenant write.
    const affected = await setTenantTx(TENANT_A, (tx) => tx.$executeRawUnsafe(
      `UPDATE admissions SET updated_at = NOW() WHERE id = $1`,
      admissionBId,
    ));
    expect(Number(affected)).toBe(0);

    // Confirm via a bypass read that B's row is intact + still tenant-B.
    const check = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
      `SELECT tenant_id::text AS tenant_id FROM admissions WHERE id = $1`,
      admissionBId,
    ), { superAdmin: true });
    expect(check[0].tenant_id).toBe(TENANT_B);
  });

  // ----- FIX (service path): the converted markForDischarge is scoped -----
  // markForDischarge opens its Phase-1 tx via scopedTx(tenantId, …) now. Asking
  // it to discharge a tenant-A admission while scoped to tenant-B must fail the
  // FOR UPDATE lookup (RLS hides the row) → AppError.notFound, NOT a
  // cross-tenant mutation. Pre-fix (bare $transaction) the lookup would find
  // the row and proceed.
  it('FIX (service): markForDischarge under tenant-B context cannot reach a tenant-A admission', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;

    await expect(
      runInTenantContext(TENANT_B, () => admissionService.markForDischarge(
        admissionAId,
        PUID_B, // requestedBy (any uid)
        'DOCTOR',
        { tenantId: TENANT_B },
      )),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The tenant-A admission must be untouched: still 'admitted', no
    // discharge_initiated_at stamp.
    const after = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
      `SELECT status, discharge_initiated_at FROM admissions WHERE id = $1`,
      admissionAId,
    ), { superAdmin: true });
    expect(after[0].status).toBe('admitted');
    expect(after[0].discharge_initiated_at).toBeNull();
  });

  // ----- Same-tenant happy path still works (isolation, not outage) -----
  it('FIX (service): markForDischarge under tenant-A context DOES discharge the tenant-A admission', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;

    const result = await runInTenantContext(TENANT_A, () => admissionService.markForDischarge(
      admissionAId,
      PUID_A,
      'DOCTOR',
      { tenantId: TENANT_A },
    ));
    expect(result?.admission?.id).toBe(admissionAId);

    const after = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
      `SELECT discharge_initiated_at FROM admissions WHERE id = $1`,
      admissionAId,
    ), { superAdmin: true });
    expect(after[0].discharge_initiated_at).not.toBeNull();
  });
});
