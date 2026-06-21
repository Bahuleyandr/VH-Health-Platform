// W2 (multi-tenancy program) schema-completeness deep test.
//
// Migrations 328-336 made every tenant-owned table carry tenant_id + a
// tenant_isolation RLS policy, and moved every human-facing identifier from
// a GLOBAL unique to a per-tenant one. This suite locks in the two W2
// behaviours that the existing tenant-rls suites do not cover:
//
//   PART 1 — per-tenant uniqueness (done-criterion: "no global-unique that
//     breaks on tenant #2"). For a representative table from each unique-swap
//     migration, tenant B can mint the SAME business key that already exists in
//     tenant A (no 23505), while a duplicate WITHIN one tenant is still
//     rejected. Covers: invoices (329), payroll_runs (330), departments (332),
//     users.phone (333, the §8.1 cornerstone), admins (334, dual partial),
//     leave_types (336).
//
//   PART 2 — RLS read/write isolation + SUPER_ADMIN bypass on a NEWLY-isolated
//     Pattern-A table (departments, mig 332), proving the W2 tenant_isolation
//     policy actually fires under enforcement. Mirrors the APP_ROLE non-owner
//     technique from tenant-rls-phase-2.deep.test.js (Postgres exempts table
//     owners/superusers from RLS, so the suite SET LOCAL ROLEs to a NOLOGIN
//     app role before asserting isolation).
//
// Cleanup is defensive and tag-based so a crashed prior run self-heals.

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import {
  getCurrentTenantId,
  runInTenantContext,
  runWithSuperAdmin,
} from '../lib/tenantContext.js';

const TENANT_A = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a201';
const TENANT_B = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b202';
const APP_ROLE = 'rls_w2_test_app';
const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

// Unique suffix so concurrent / re-run rows never collide across runs.
const SFX = String(Date.now() % 100000).padStart(5, '0');

async function cleanup() {
  // FK order: invoices -> users; the rest are standalone.
  await prisma.$executeRawUnsafe(`DELETE FROM invoices WHERE invoice_number LIKE 'W2RLS-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE 'W2RLS %'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM departments WHERE name LIKE 'W2RLS-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM leave_types WHERE leave_type LIKE 'W2RLS-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM payroll_runs WHERE year >= 4000 AND year < 4100`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM admins WHERE username LIKE 'W2RLS-%'`).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B,
  ).catch(() => {});
}

describe('W2 schema multi-tenancy (migrations 328-336)', () => {
  beforeAll(async () => {
    await cleanup();

    // NOLOGIN app role + grants so PART 2 can exercise RLS as a non-owner.
    // On local QA (qa_writer, non-superuser, cannot CREATE ROLE) the role is
    // expected to pre-exist; tolerate the perm error like phase-2 does.
    try {
      await prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
            CREATE ROLE ${APP_ROLE} NOLOGIN;
          END IF;
        END $$;`);
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
      await prisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
      await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON departments, tenants TO ${APP_ROLE}`);
      const me = (await prisma.$queryRawUnsafe(`SELECT current_user AS u`))[0].u;
      try { await prisma.$executeRawUnsafe(`GRANT ${APP_ROLE} TO ${me}`); } catch { /* already a member */ }
    } catch (err) {
      const exists = await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1`, APP_ROLE);
      if (!exists.length) {
        throw new Error(`Test role ${APP_ROLE} missing and current user cannot CREATE ROLE (${err.message})`);
      }
    }

    for (const [id, slug, name] of [[TENANT_A, `w2-a-${SFX}`, 'W2 Tenant A'], [TENANT_B, `w2-b-${SFX}`, 'W2 Tenant B']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        id, slug, name,
      );
    }
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  afterEach(() => {
    delete process.env.AUTH_ENFORCE_TENANT_RLS;
    delete process.env.AUTH_TENANT_RLS_TEST_ROLE;
  });

  // -------------------------------------------------------------------------
  // PART 1 — per-tenant uniqueness (no enforcement needed: the UNIQUE index is
  // enforced regardless of role; GUC unset => permissive policy => inserts with
  // explicit tenant_id pass WITH CHECK).
  // -------------------------------------------------------------------------
  describe('per-tenant unique collisions (global-unique-breaks-on-tenant-2 cleared)', () => {
    it('departments.name (332): same name in two tenants OK; dup within a tenant rejected', async () => {
      const nm = `W2RLS-Cardiology-${SFX}`;
      await prisma.$executeRawUnsafe(`INSERT INTO departments (name, tenant_id, updated_at) VALUES ($1, $2::uuid, NOW())`, nm, TENANT_A);
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO departments (name, tenant_id, updated_at) VALUES ($1, $2::uuid, NOW())`, nm, TENANT_B),
      ).resolves.toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO departments (name, tenant_id, updated_at) VALUES ($1, $2::uuid, NOW())`, nm, TENANT_A),
      ).rejects.toThrow();
    });

    it('leave_types.leave_type (336): same type in two tenants OK; dup within a tenant rejected', async () => {
      const lt = `W2RLS-Sick-${SFX}`;
      await prisma.$executeRawUnsafe(`INSERT INTO leave_types (leave_type, tenant_id) VALUES ($1, $2::uuid)`, lt, TENANT_A);
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO leave_types (leave_type, tenant_id) VALUES ($1, $2::uuid)`, lt, TENANT_B),
      ).resolves.toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO leave_types (leave_type, tenant_id) VALUES ($1, $2::uuid)`, lt, TENANT_A),
      ).rejects.toThrow();
    });

    it('payroll_runs (month,year) (330): same period in two tenants OK; dup within a tenant rejected', async () => {
      const yr = 4001;
      await prisma.$executeRawUnsafe(`INSERT INTO payroll_runs (month, year, tenant_id) VALUES (3, $1, $2::uuid)`, yr, TENANT_A);
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO payroll_runs (month, year, tenant_id) VALUES (3, $1, $2::uuid)`, yr, TENANT_B),
      ).resolves.toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO payroll_runs (month, year, tenant_id) VALUES (3, $1, $2::uuid)`, yr, TENANT_A),
      ).rejects.toThrow();
    });

    it('users.phone (333 §8.1): same phone in two tenants = two patients; dup within a tenant rejected', async () => {
      const ph = `+9198${SFX}0001`;
      await prisma.$executeRawUnsafe(`INSERT INTO users (phone, name, tenant_id, updated_at) VALUES ($1, 'W2RLS UserA', $2::uuid, NOW())`, ph, TENANT_A);
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO users (phone, name, tenant_id, updated_at) VALUES ($1, 'W2RLS UserB', $2::uuid, NOW())`, ph, TENANT_B),
      ).resolves.toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO users (phone, name, tenant_id, updated_at) VALUES ($1, 'W2RLS UserA2', $2::uuid, NOW())`, ph, TENANT_A),
      ).rejects.toThrow();
    });

    it('admins.username (334): same username in two tenants OK; dup within a tenant rejected; platform (null) unique', async () => {
      const un = `W2RLS-admin-${SFX}`;
      await prisma.$executeRawUnsafe(`INSERT INTO admins (username, password_hash, tenant_id) VALUES ($1, 'x', $2::uuid)`, un, TENANT_A);
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO admins (username, password_hash, tenant_id) VALUES ($1, 'x', $2::uuid)`, un, TENANT_B),
      ).resolves.toBeDefined();
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO admins (username, password_hash, tenant_id) VALUES ($1, 'x', $2::uuid)`, un, TENANT_A),
      ).rejects.toThrow();
      // Platform SUPER_ADMIN (tenant_id NULL) usernames are globally unique.
      const su = `W2RLS-super-${SFX}`;
      await prisma.$executeRawUnsafe(`INSERT INTO admins (username, password_hash, tenant_id) VALUES ($1, 'x', NULL)`, su);
      await expect(
        prisma.$executeRawUnsafe(`INSERT INTO admins (username, password_hash, tenant_id) VALUES ($1, 'x', NULL)`, su),
      ).rejects.toThrow();
    });

    it('invoices.invoice_number (329 BLOCKER): same invoice number in two tenants OK; dup within a tenant rejected', async () => {
      // patient_uid is a NOT NULL FK to users.uid — seed one patient per tenant.
      const mk = async (tenant, tag) => (await prisma.$queryRawUnsafe(
        `INSERT INTO users (phone, name, tenant_id, updated_at) VALUES ($1, 'W2RLS Inv${tag}', $2::uuid, NOW()) RETURNING uid`,
        `+9197${SFX}${tag}`, tenant,
      ))[0].uid;
      const uidA = await mk(TENANT_A, '1');
      const uidB = await mk(TENANT_B, '2');
      const inv = `W2RLS-INV-${SFX}`;
      const ins = (tenant, uid) => prisma.$executeRawUnsafe(
        `INSERT INTO invoices (invoice_number, patient_uid, type, items, subtotal, total_amount, tenant_id, updated_at)
         VALUES ($1, $2::uuid, 'OP', '[]'::jsonb, 0, 0, $3::uuid, NOW())`,
        inv, uid, tenant,
      );
      await ins(TENANT_A, uidA);
      await expect(ins(TENANT_B, uidB)).resolves.toBeDefined();
      await expect(ins(TENANT_A, uidA)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // PART 2 — RLS read/write isolation on a newly-isolated Pattern-A table.
  // -------------------------------------------------------------------------
  describe('RLS isolation on a W2 Pattern-A table (departments, mig 332)', () => {
    const nm = (t) => `W2RLS-Dept-${t}-${SFX}`;

    beforeAll(async () => {
      // Seed one department per tenant (as the connecting role; GUC unset =>
      // permissive, so explicit tenant_id is honoured).
      await prisma.$executeRawUnsafe(`INSERT INTO departments (name, tenant_id, updated_at) VALUES ($1, $2::uuid, NOW())`, nm('A'), TENANT_A);
      await prisma.$executeRawUnsafe(`INSERT INTO departments (name, tenant_id, updated_at) VALUES ($1, $2::uuid, NOW())`, nm('B'), TENANT_B);
    }, 30000);

    it('flag ON + tenant-A context — sees ONLY tenant-A department', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.AUTH_TENANT_RLS_TEST_ROLE = APP_ROLE;
      const rows = await runInTenantContext(TENANT_A, () => prisma.$queryRawUnsafe(
        `SELECT name, tenant_id::text AS tenant_id FROM departments WHERE name LIKE 'W2RLS-Dept-%' ORDER BY name`,
      ));
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it('flag ON + tenant-B context — sees ONLY tenant-B department', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.AUTH_TENANT_RLS_TEST_ROLE = APP_ROLE;
      const rows = await runInTenantContext(TENANT_B, () => prisma.$queryRawUnsafe(
        `SELECT name, tenant_id::text AS tenant_id FROM departments WHERE name LIKE 'W2RLS-Dept-%' ORDER BY name`,
      ));
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(TENANT_B);
    });

    it('flag ON + SUPER_ADMIN bypass — sees BOTH tenants', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.AUTH_TENANT_RLS_TEST_ROLE = APP_ROLE;
      const rows = await runWithSuperAdmin(() => prisma.$queryRawUnsafe(
        `SELECT name FROM departments WHERE name LIKE 'W2RLS-Dept-%' ORDER BY name`,
      ));
      expect(rows).toHaveLength(2);
    });

    it('flag ON + tenant-A WRITE of a tenant-B row — rejected by WITH CHECK', async () => {
      process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
      process.env.AUTH_TENANT_RLS_TEST_ROLE = APP_ROLE;
      await expect(
        runInTenantContext(TENANT_A, () => prisma.$executeRawUnsafe(
          `INSERT INTO departments (name, tenant_id, updated_at) VALUES ($1, $2::uuid, NOW())`,
          `W2RLS-Dept-XCHECK-${SFX}`, TENANT_B,
        )),
      ).rejects.toThrow();
    });

    it('getCurrentTenantId reflects the active context', async () => {
      await runInTenantContext(TENANT_A, () => { expect(getCurrentTenantId()).toBe(TENANT_A); });
      expect(getCurrentTenantId()).toBe(null);
    });
  });
});
