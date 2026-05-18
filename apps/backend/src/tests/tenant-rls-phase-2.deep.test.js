// Phase-2 RLS integration test.
//
// Proves that with AUTH_ENFORCE_TENANT_RLS=true, the AsyncLocalStorage
// tenant context (seeded by tenantRlsMiddleware in the express chain, or
// by runInTenantContext directly) causes the prisma proxy at
// src/lib/prisma.js to auto-wrap every raw-SQL call in setTenant() — so
// tenant_isolation policies from migration 075 + 236 actually fire.
//
// Test scenario:
//   1. Seed TENANT_A and TENANT_B (plus the default tenant that
//      already exists).
//   2. Insert one appointment row scoped to each tenant.
//   3. With the flag OFF: a plain prisma.$queryRaw sees BOTH rows
//      (legacy permissive mode — no behaviour change for current code).
//   4. With the flag ON + a tenant-A context: the same query returns
//      ONLY tenant-A's row.
//   5. With the flag ON + a SUPER_ADMIN bypass context: both rows
//      visible.
//   6. With the flag ON + an empty context (cron-shaped path): the
//      query passes through (legacy permissive) and sees both rows.
//
// Cleanup is defensive — runs even when individual asserts fail.

import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import {
  getCurrentTenantId,
  runInTenantContext,
  runWithSuperAdmin,
} from '../lib/tenantContext.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb02';
const PATIENT_A_PHONE = `+9199900${String(Date.now() % 10000).padStart(5, '0')}`;
const PATIENT_B_PHONE = `+9199901${String(Date.now() % 10000).padStart(5, '0')}`;

let patientAId;
let patientBId;
let apptAId;
let apptBId;

async function cleanup() {
  if (apptAId) {
    await prisma.$executeRawUnsafe(
      'DELETE FROM appointment_status_history WHERE appointment_id = $1',
      apptAId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM appointments WHERE id = $1', apptAId).catch(() => {});
  }
  if (apptBId) {
    await prisma.$executeRawUnsafe(
      'DELETE FROM appointment_status_history WHERE appointment_id = $1',
      apptBId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM appointments WHERE id = $1', apptBId).catch(() => {});
  }
  if (patientAId) {
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE id = $1', patientAId).catch(() => {});
  }
  if (patientBId) {
    await prisma.$executeRawUnsafe('DELETE FROM users WHERE id = $1', patientBId).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    "DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)",
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

describe('Phase-2 tenant RLS via AsyncLocalStorage', () => {
  beforeAll(async () => {
    await cleanup();

    // Seed both tenants — `tenants` has check constraints, keep the rows
    // minimal but valid.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())`,
      TENANT_A, `phase2-rls-a-${Date.now()}`, 'Phase2 Tenant A',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())`,
      TENANT_B, `phase2-rls-b-${Date.now()}`, 'Phase2 Tenant B',
    );

    // Seed one patient per tenant.
    const pa = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1, 'Phase2 Patient A', 'PATIENT', $2::uuid, true, NOW())
       RETURNING id`,
      PATIENT_A_PHONE, TENANT_A,
    );
    patientAId = pa[0].id;
    const pb = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1, 'Phase2 Patient B', 'PATIENT', $2::uuid, true, NOW())
       RETURNING id`,
      PATIENT_B_PHONE, TENANT_B,
    );
    patientBId = pb[0].id;

    // Seed one appointment per tenant.
    const aa = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, appointment_date, appointment_time, status,
          token_number, department, tenant_id, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '09:00', 'CONFIRMED', '950',
               'Phase2-RLS', $3::uuid, NOW())
       RETURNING id`,
      PATIENT_A_PHONE, patientAId, TENANT_A,
    );
    apptAId = aa[0].id;
    const ab = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, appointment_date, appointment_time, status,
          token_number, department, tenant_id, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '09:15', 'CONFIRMED', '951',
               'Phase2-RLS', $3::uuid, NOW())
       RETURNING id`,
      PATIENT_B_PHONE, patientBId, TENANT_B,
    );
    apptBId = ab[0].id;
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  afterEach(() => {
    delete process.env.AUTH_ENFORCE_TENANT_RLS;
  });

  it('legacy mode (flag OFF) — query returns both tenants rows (permissive)', async () => {
    delete process.env.AUTH_ENFORCE_TENANT_RLS;
    const rows = await runInTenantContext(TENANT_A, () => prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text FROM appointments WHERE department = 'Phase2-RLS' ORDER BY id`,
    ));
    expect(rows).toHaveLength(2);
  });

  it('flag ON + tenant-A context — query returns ONLY tenant-A row', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    const rows = await runInTenantContext(TENANT_A, () => prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text AS tenant_id FROM appointments WHERE department = 'Phase2-RLS' ORDER BY id`,
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(apptAId);
    expect(rows[0].tenant_id).toBe(TENANT_A);
  });

  it('flag ON + tenant-B context — query returns ONLY tenant-B row', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    const rows = await runInTenantContext(TENANT_B, () => prisma.$queryRawUnsafe(
      `SELECT id, tenant_id::text AS tenant_id FROM appointments WHERE department = 'Phase2-RLS' ORDER BY id`,
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(apptBId);
    expect(rows[0].tenant_id).toBe(TENANT_B);
  });

  it('flag ON + SUPER_ADMIN bypass — both rows visible (cross-tenant admin)', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    const rows = await runWithSuperAdmin(() => prisma.$queryRawUnsafe(
      `SELECT id FROM appointments WHERE department = 'Phase2-RLS' ORDER BY id`,
    ));
    expect(rows).toHaveLength(2);
  });

  it('flag ON + no context (cron-shaped) — passes through, sees both (matches migration 075 permissive default)', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    // Deliberately NOT wrapping in runInTenantContext — emulates a cron
    // job or bootstrap path that hasn't set up a tenant scope. The
    // wrapper short-circuits, the GUC stays unset, and the policy is
    // permissive.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM appointments WHERE department = 'Phase2-RLS' ORDER BY id`,
    );
    expect(rows).toHaveLength(2);
  });

  it('flag ON + tenant-A WRITE — INSERT against tenant_id=B is rejected by WITH CHECK', async () => {
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    await expect(
      runInTenantContext(TENANT_A, () => prisma.$executeRawUnsafe(
        `INSERT INTO appointments
           (phone, patient_id, appointment_date, appointment_time, status,
            token_number, department, tenant_id, updated_at)
         VALUES ('+919876500000', $1, CURRENT_DATE, '10:00', 'CONFIRMED', '999',
                 'Phase2-RLS-WRITE', $2::uuid, NOW())`,
        patientBId, TENANT_B,
      )),
    ).rejects.toThrow();
  });

  it('getCurrentTenantId returns the right value inside a context', async () => {
    await runInTenantContext(TENANT_A, () => {
      expect(getCurrentTenantId()).toBe(TENANT_A);
    });
    await runInTenantContext(TENANT_B, () => {
      expect(getCurrentTenantId()).toBe(TENANT_B);
    });
    expect(getCurrentTenantId()).toBe(null);
  });
});
