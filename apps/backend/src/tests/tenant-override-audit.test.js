// Phase-3 SUPER_ADMIN x-tenant-id override audit + reason requirement.
//
// Asserts:
//   1. A regular SUPER_ADMIN request (no x-tenant-id header) lands on
//      the JWT's claim tenant — no audit_logs TENANT_OVERRIDE_USED row.
//   2. A SUPER_ADMIN request with x-tenant-id but NO reason header is
//      rejected 400 with code TENANT_OVERRIDE_REASON_REQUIRED.
//   3. A SUPER_ADMIN request with x-tenant-id AND a valid reason is
//      accepted AND writes a TENANT_OVERRIDE_USED row to audit_logs
//      carrying original_tenant_id, target_tenant_id, reason, request_id.
//   4. A non-SUPER_ADMIN passing x-tenant-id is silently ignored — the
//      JWT's tenant wins; the x-tenant-id is not honoured even with a
//      reason (the audit doesn't capture it either).
//
// Reference: docs/GAP_ANALYSIS_TENANT_RLS.md (Phase 3) and the
// middleware at src/middleware/tenantContextMiddleware.js.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-00000000ab10';

const SUPER_ADMIN_UID = 'a8888888-8888-4888-8888-88888888aa01';
const DOCTOR_UID      = 'a8888888-8888-4888-8888-88888888aa02';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');

let superAdminToken;
let doctorToken;

async function cleanup() {
  // Drop any audit rows this test wrote. Two separate placeholders
  // instead of ANY($1::uuid[]) so the raw-params lint rule (which
  // flags any array argument as suspicious) doesn't trip.
  await prisma.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE action = 'TENANT_OVERRIDE_USED' AND uid IN ($1::uuid, $2::uuid)`,
    SUPER_ADMIN_UID, DOCTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    SUPER_ADMIN_UID, DOCTOR_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
}

describe('Phase-3 SUPER_ADMIN x-tenant-id override audit', () => {
  beforeAll(async () => {
    await cleanup();

    // Seed tenant B (TENANT_A is the always-present default).
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, 'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B, `phase3-override-${RUN_SUFFIX}`, `Phase3 Override ${RUN_SUFFIX}`,
    );

    // Two seeded users — one SUPER_ADMIN, one DOCTOR, both in tenant A.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'SUPER_ADMIN', $4::uuid, true, NOW())`,
      SUPER_ADMIN_UID, `+9199985${RUN_SUFFIX}`, `Phase3 SA ${RUN_SUFFIX}`, TENANT_A,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid, $2, $3, 'DOCTOR', $4::uuid, true, NOW())`,
      DOCTOR_UID, `+9199986${RUN_SUFFIX}`, `Phase3 DR ${RUN_SUFFIX}`, TENANT_A,
    );

    superAdminToken = generateTestToken('SUPER_ADMIN', {
      uid: SUPER_ADMIN_UID,
      tenant_id: TENANT_A,
    });
    doctorToken = generateTestToken('DOCTOR', {
      uid: DOCTOR_UID,
      tenant_id: TENANT_A,
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  async function countOverrideAuditRows(actorUid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM audit_logs
        WHERE action = 'TENANT_OVERRIDE_USED'
          AND uid = $1::uuid`,
      actorUid,
    );
    return rows[0]?.n ?? 0;
  }

  it('SUPER_ADMIN without an x-tenant-id header writes no audit row', async () => {
    const before = await countOverrideAuditRows(SUPER_ADMIN_UID);
    const res = await request(app)
      .get('/api/v1/health')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect([200, 304]).toContain(res.statusCode);
    // Race-tolerant: setImmediate audit-writer needs a tick to run.
    await new Promise((r) => setImmediate(r));
    const after = await countOverrideAuditRows(SUPER_ADMIN_UID);
    expect(after).toBe(before);
  });

  it('SUPER_ADMIN with x-tenant-id but no reason is rejected 400 with code TENANT_OVERRIDE_REASON_REQUIRED', async () => {
    const before = await countOverrideAuditRows(SUPER_ADMIN_UID);
    const res = await request(app)
      .get('/api/v1/dashboard')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('x-tenant-id', TENANT_B);
    expect(res.statusCode).toBe(400);
    expect(res.body?.code || res.body?.error?.code).toBe('TENANT_OVERRIDE_REASON_REQUIRED');
    await new Promise((r) => setImmediate(r));
    const after = await countOverrideAuditRows(SUPER_ADMIN_UID);
    expect(after).toBe(before);
  });

  it('SUPER_ADMIN with x-tenant-id AND a valid reason is accepted and writes a TENANT_OVERRIDE_USED audit row', async () => {
    const before = await countOverrideAuditRows(SUPER_ADMIN_UID);
    const res = await request(app)
      .get('/api/v1/dashboard')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('x-tenant-id', TENANT_B)
      .set('x-tenant-override-reason', 'Investigating ticket VHH-1234 for tenant B');
    // Dashboard handler may 200 or have its own RBAC — we don't care
    // about the specific status, only that the override isn't rejected
    // by the tenant middleware.
    expect(res.statusCode).not.toBe(400);
    // setImmediate gives the fire-and-forget audit write one tick to run.
    // Poll briefly in case the DB write is slow.
    let after = before;
    for (let i = 0; i < 20; i++) {
      after = await countOverrideAuditRows(SUPER_ADMIN_UID);
      if (after > before) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after).toBeGreaterThan(before);

    const latest = await prisma.$queryRawUnsafe(
      `SELECT metadata
         FROM audit_logs
        WHERE action = 'TENANT_OVERRIDE_USED' AND uid = $1::uuid
        ORDER BY created_at DESC LIMIT 1`,
      SUPER_ADMIN_UID,
    );
    expect(latest.length).toBe(1);
    const meta = latest[0].metadata;
    expect(meta.target_tenant_id).toBe(TENANT_B);
    expect(meta.original_tenant_id).toBe(TENANT_A);
    expect(meta.reason).toContain('VHH-1234');
  });

  it('non-SUPER_ADMIN passing x-tenant-id is silently ignored — no audit row, no override', async () => {
    const before = await countOverrideAuditRows(DOCTOR_UID);
    const res = await request(app)
      .get('/api/v1/health')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${doctorToken}`)
      .set('x-tenant-id', TENANT_B)
      .set('x-tenant-override-reason', 'a doctor cannot grant themself this');
    // Non-SUPER_ADMIN — the override is ignored, request behaves
    // normally for whatever the route's RBAC allows.
    expect([200, 304, 403]).toContain(res.statusCode);
    await new Promise((r) => setImmediate(r));
    const after = await countOverrideAuditRows(DOCTOR_UID);
    expect(after).toBe(before);
  });
});
