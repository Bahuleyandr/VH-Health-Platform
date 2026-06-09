// Roadmap A2 (docs/EPIC_LEVEL_ROADMAP.md) — HTTP-level tenant isolation.
//
// tenant-rls.deep.test.js proves the SQL layer; tenant-rls-phase-2.deep.test.js
// proves the AsyncLocalStorage/prisma-proxy layer. This file proves the FULL
// request path a real hospital client takes:
//
//   staff JWT (tenant_id claim) → validateApiKey → jwtMiddleware →
//   tenantContextMiddleware → tenantRlsMiddleware → route RBAC →
//   controller → raw SQL → RLS policy
//
// Scenarios:
//   1. Posture: with enforcement on, tenantRlsRolePosture() reports ok
//      (catches both the SUPERUSER/BYPASSRLS gap and the owner-exemption
//      gap that migration 272 closes).
//   2. Structural: zero tables carry a tenant_isolation policy without
//      FORCE ROW LEVEL SECURITY (272 regression guard).
//   3. Tenant-B admin JWT cannot read tenant-A appointments through
//      GET /api/v1/appointments/list (and vice versa).
//   4. Tenant-A admin JWT still sees tenant-A rows (isolation, not outage).
//
// Skipped when no DATABASE_URL/TEST_DATABASE_URL is configured (mirrors the
// other *-deep.test.js suites).

import request from 'supertest';
import app from '../app.js';
import prisma, { tenantRlsRolePosture } from '../lib/prisma.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaab11';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb12';
const DEPT_A = 'RLS-HTTP-A';
const DEPT_B = 'RLS-HTTP-B';
const PHONE_A = `+9199902${String(Date.now() % 10000).padStart(5, '0')}`;
const PHONE_B = `+9199903${String(Date.now() % 10000).padStart(5, '0')}`;

// Non-owner, non-superuser role for SET LOCAL ROLE. Same pattern as
// tenant-rls-phase-2.deep.test.js: CI connects as a superuser (bypasses RLS
// even under FORCE), local QA as qa_writer. Routing tenant transactions
// through this role makes enforcement real in both environments — and
// exercises the AUTH_TENANT_RLS_RUNTIME_ROLE alias end-to-end.
const APP_ROLE = 'rls_http_test_app';

let savedEnforceFlag;
let savedRuntimeRole;
let patientAId;
let patientBId;

const adminTokenA = () => generateToken({
  uid: '11111111-1111-4111-8111-111111111a01',
  role: 'ADMIN',
  tenant_id: TENANT_A,
  type: 'admin',
});
const adminTokenB = () => generateToken({
  uid: '22222222-2222-4222-8222-222222222b02',
  role: 'ADMIN',
  tenant_id: TENANT_B,
  type: 'admin',
});

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointment_status_history
       WHERE appointment_id IN (SELECT id FROM appointments WHERE department LIKE 'RLS-HTTP-%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE department LIKE 'RLS-HTTP-%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE name LIKE 'RLS HTTP Patient%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

d('Tenant RLS — HTTP staff-route isolation (roadmap A2)', () => {
  beforeAll(async () => {
    savedEnforceFlag = process.env.AUTH_ENFORCE_TENANT_RLS;
    savedRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;

    await cleanup();

    // Ensure the non-owner app role exists with the grants the request
    // path needs. Tolerant of non-superuser QA roles (same contract as
    // tenant-rls-phase-2.deep.test.js).
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
      // Tolerant: pgvector-less clusters throw 58P01 resolving vector-typed
      // columns; qa-cluster-up has already granted what the suite needs.
      await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`).catch(() => {});
      // Membership lets the connecting role SET LOCAL ROLE to APP_ROLE.
      // Skip the grant when membership already exists (qa-cluster-up seeds
      // it) — a redundant GRANT from a non-admin role errors loudly.
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

    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = APP_ROLE;

    // Seed tenants.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'RLS HTTP Tenant A', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_A, `rls-http-a-${Date.now()}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES ($1::uuid, $2, 'RLS HTTP Tenant B', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, `rls-http-b-${Date.now()}`,
    );

    // One patient + one appointment per tenant. Seed writes run with the
    // GUC unset (permissive policy path), so FORCE does not block them.
    const pa = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1, 'RLS HTTP Patient A', 'PATIENT', $2::uuid, true, NOW()) RETURNING id`,
      PHONE_A, TENANT_A,
    );
    patientAId = pa[0].id;
    const pb = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1, 'RLS HTTP Patient B', 'PATIENT', $2::uuid, true, NOW()) RETURNING id`,
      PHONE_B, TENANT_B,
    );
    patientBId = pb[0].id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, appointment_date, appointment_time, status,
          token_number, department, tenant_id, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '09:00', 'CONFIRMED', '960', $3, $4::uuid, NOW())`,
      PHONE_A, patientAId, DEPT_A, TENANT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (phone, patient_id, appointment_date, appointment_time, status,
          token_number, department, tenant_id, updated_at)
       VALUES ($1, $2, CURRENT_DATE, '09:15', 'CONFIRMED', '961', $3, $4::uuid, NOW())`,
      PHONE_B, patientBId, DEPT_B, TENANT_B,
    );
  });

  afterAll(async () => {
    // Restore env before cleanup so the delete sweeps run on the permissive
    // legacy path (no tenant context in this test process anyway).
    if (savedEnforceFlag === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnforceFlag;
    if (savedRuntimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedRuntimeRole;
    await cleanup();
  });

  it('posture probe reports enforceable isolation (no bypass, no owner-exempt tables)', async () => {
    const posture = await tenantRlsRolePosture();
    expect(posture.error).toBeUndefined();
    expect(posture.enforced).toBe(true);
    expect(posture.ok).toBe(true);
    expect(posture.reason).toBe('enforced');
    expect(posture.unforcedOwnedRlsTables).toBe(0);
  });

  it('structural guard: every tenant_isolation table is FORCEd (migration 272)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS unforced
         FROM pg_policies p
         JOIN pg_class c     ON c.relname = p.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
        WHERE p.schemaname = 'public'
          AND p.policyname = 'tenant_isolation'
          AND c.relrowsecurity
          AND NOT c.relforcerowsecurity`,
    );
    expect(rows[0].unforced).toBe(0);
  });

  // NOTE: assertions target res.body.data.appointments — the response also
  // echoes the REQUESTED department back under filters, so whole-body
  // substring checks would false-positive on the echo.
  it('tenant-B admin cannot see tenant-A appointments via GET /appointments/list', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/list?department=${DEPT_A}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.appointments).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(PHONE_A);
  });

  it('tenant-A admin cannot see tenant-B appointments via GET /appointments/list', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/list?department=${DEPT_B}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.appointments).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(PHONE_B);
  });

  it('tenant-A admin still sees tenant-A appointments (isolation, not outage)', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/list?department=${DEPT_A}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    expect(res.status).toBe(200);
    const appts = res.body?.data?.appointments || [];
    expect(appts.length).toBe(1);
    expect(appts[0].department).toBe(DEPT_A);
    expect(appts[0].phone).toBe(PHONE_A);
  });

  it('tenant-B admin still sees tenant-B appointments (symmetry)', async () => {
    const res = await request(app)
      .get(`/api/v1/appointments/list?department=${DEPT_B}`)
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    expect(res.status).toBe(200);
    const appts = res.body?.data?.appointments || [];
    expect(appts.length).toBe(1);
    expect(appts[0].department).toBe(DEPT_B);
    expect(appts[0].phone).toBe(PHONE_B);
  });
});
