// Audit §3 (multi-tenancy) — rbacService cross-tenant user mutation.
//
// RBACService.assignRole (role change) and RBACService.toggleUserStatus both
// mutated users by `WHERE phone = $1` inside a bare prisma.$transaction. Because
// `users.phone` is GLOBALLY UNIQUE (users_phone_key) and a bare $transaction
// leaves RLS permissive (GUC unset), a tenant-A admin could change the role of,
// or lock/unlock, a tenant-B user just by knowing their phone number.
//
// The fix resolves the ACTING admin's tenant_id (from users by the actor uid),
// adds `AND tenant_id = $actorTenant::uuid` to the user SELECT and UPDATE, and
// wraps the transaction in setTenantTx(actorTenantId, …) so RLS WITH CHECK also
// fires under a non-owner role. A foreign-tenant phone now resolves to 0 rows →
// AppError.notFound (never a silent cross-tenant write).
//
// These tests call the service methods directly with a clean, self-isolating
// fixture set (two tenants, each with one ADMIN actor + one GENERAL_STAFF
// target, all on globally-unique phones). GENERAL_STAFF→NURSING_STAFF is used
// for the role change: both roles are uncapped, so checkRoleCapacity can never
// pre-empt the tenant check and the cross-tenant assertion lands on the real
// notFound. Needs the test Postgres; self-skips when unconfigured.

import prisma, { setTenantTx } from '../lib/prisma.js';
import { RBACService } from '../services/infrastructure/rbacService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_B = 'cb100000-0000-4000-8000-00000000b001';
const TENANT_C = 'cb100000-0000-4000-8000-00000000c001';

// Actors (admins) — one per tenant.
const ADMIN_B = 'cb100000-0000-4000-8000-0000000a0b01';
const ADMIN_C = 'cb100000-0000-4000-8000-0000000a0c01';
// Phones are deliberately ALL-DIGIT so normalizePhone() is a no-op (it strips
// any non-digit/non-+ char, so letters would make the stored value diverge from
// the looked-up one). +91 + 10 digits = 13 chars, returned unchanged.
const ADMIN_B_PHONE = '+919000300001';
const ADMIN_C_PHONE = '+919000300002';

// Targets (general staff) — one per tenant.
const TARGET_B = 'cb100000-0000-4000-8000-0000000700b1';
const TARGET_C = 'cb100000-0000-4000-8000-0000000700c1';
const TARGET_B_PHONE = '+919000300003';
const TARGET_C_PHONE = '+919000300004';

const ALL_UIDS = [ADMIN_B, ADMIN_C, TARGET_B, TARGET_C];
const ALL_PHONES = [ADMIN_B_PHONE, ADMIN_C_PHONE, TARGET_B_PHONE, TARGET_C_PHONE];

async function cleanup() {
  // Audit rows key on phone (no uid FK), so clear them by the test phones first.
  await prisma.$executeRawUnsafe(
    `DELETE FROM user_role_audit WHERE phone IN ($1, $2, $3, $4)`,
    ...ALL_PHONES,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        OR phone IN ($5, $6, $7, $8)`,
    ...ALL_UIDS, ...ALL_PHONES,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_B, TENANT_C,
  ).catch(() => {});
}

async function seedUser(uid, tenantId, phone, role) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NOW())`,
    uid, tenantId, phone, `RBAC XT ${role}`, role,
  );
}

// Owner-path reads (DATABASE_URL connects as a superuser/table-owner, exempt
// from RLS) so post-state assertions see the row regardless of any GUC scope.
async function readUserByPhone(phone) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid::text AS uid, role, is_active, tenant_id::text AS tenant_id
       FROM users WHERE phone = $1`,
    phone,
  );
  return rows[0];
}

d('rbacService cross-tenant user mutation (audit §3)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1::uuid, 'rbac-xt-tenant-b', 'RBAC XT Tenant B'),
         ($2::uuid, 'rbac-xt-tenant-c', 'RBAC XT Tenant C')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, TENANT_C,
    );
    await seedUser(ADMIN_B, TENANT_B, ADMIN_B_PHONE, 'ADMIN');
    await seedUser(ADMIN_C, TENANT_C, ADMIN_C_PHONE, 'ADMIN');
    await seedUser(TARGET_B, TENANT_B, TARGET_B_PHONE, 'GENERAL_STAFF');
    await seedUser(TARGET_C, TENANT_C, TARGET_C_PHONE, 'GENERAL_STAFF');
  }, 30000);

  afterAll(async () => {
    await cleanup();
  }, 30000);

  describe('assignRole (role change)', () => {
    test('tenant-B admin CANNOT change the role of a tenant-C user (notFound, no mutation)', async () => {
      const adminB = { uid: ADMIN_B, role: 'ADMIN' };

      await expect(
        RBACService.assignRole(
          { phone: TARGET_C_PHONE, role: 'NURSING_STAFF', reason: 'xt attempt' },
          adminB,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

      // The tenant-C user is untouched.
      const targetC = await readUserByPhone(TARGET_C_PHONE);
      expect(targetC.tenant_id).toBe(TENANT_C);
      expect(targetC.role).toBe('GENERAL_STAFF');

      // And no audit row leaked for the cross-tenant target.
      const audit = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM user_role_audit WHERE phone = $1`,
        TARGET_C_PHONE,
      );
      expect(audit[0].n).toBe(0);
    });

    test('tenant-B admin CAN change the role of a tenant-B user (same-tenant succeeds)', async () => {
      const adminB = { uid: ADMIN_B, role: 'ADMIN' };

      const result = await RBACService.assignRole(
        { phone: TARGET_B_PHONE, role: 'NURSING_STAFF', reason: 'same-tenant ok' },
        adminB,
      );
      expect(result.unchanged).toBeUndefined();
      expect(result.newRole).toBe('NURSING_STAFF');

      const targetB = await readUserByPhone(TARGET_B_PHONE);
      expect(targetB.tenant_id).toBe(TENANT_B);
      expect(targetB.role).toBe('NURSING_STAFF');
    });
  });

  describe('toggleUserStatus (lock/unlock)', () => {
    test('tenant-B admin CANNOT lock a tenant-C user (notFound, no mutation)', async () => {
      const adminB = { uid: ADMIN_B };

      await expect(
        RBACService.toggleUserStatus(
          { phone: TARGET_C_PHONE, action: 'lock', reason: 'xt attempt' },
          adminB,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

      // The tenant-C user stays active.
      const targetC = await readUserByPhone(TARGET_C_PHONE);
      expect(targetC.tenant_id).toBe(TENANT_C);
      expect(targetC.is_active).toBe(true);
    });

    test('tenant-B admin CAN lock a tenant-B user (same-tenant succeeds)', async () => {
      const adminB = { uid: ADMIN_B };

      const result = await RBACService.toggleUserStatus(
        { phone: TARGET_B_PHONE, action: 'lock', reason: 'same-tenant ok' },
        adminB,
      );
      expect(result.isActive).toBe(false);

      const targetB = await readUserByPhone(TARGET_B_PHONE);
      expect(targetB.tenant_id).toBe(TENANT_B);
      expect(targetB.is_active).toBe(false);
    });
  });

  // Belt-and-braces: even with RLS enforced under a non-owner role (the prod
  // shape), the explicit tenant predicate confines the write. Drive the same
  // cross-tenant lock through setTenantTx as tenant B and confirm zero rows
  // change for the tenant-C target. (Owner-exempt RLS in the default test DB is
  // why the explicit predicate — not RLS alone — is the load-bearing fix.)
  test('explicit predicate confines the UPDATE under setTenantTx tenant scope', async () => {
    const rowCount = await setTenantTx(TENANT_B, async (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE users SET is_active = false
           WHERE phone = $1 AND tenant_id = $2::uuid`,
        TARGET_C_PHONE, TENANT_B,
      ),
    );
    expect(Number(rowCount)).toBe(0);

    const targetC = await readUserByPhone(TARGET_C_PHONE);
    expect(targetC.is_active).toBe(true);
  });
});

if (!DB_CONFIGURED) {
  console.warn(
    'rbacCrossTenantUserMutation.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.',
  );
}
