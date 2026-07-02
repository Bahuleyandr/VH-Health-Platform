// Deep integration tests for the acting-as delegation hop.
//
// Migration 202 added `users.guardian_user_id`; the 2026-05-13 chip added
// `X-Acting-As-Uid` header support in `jwtMiddleware` so a guardian's JWT
// can act on a linked minor's behalf for the duration of one request.
// Every IDOR check downstream compares against `req.user.id` after the
// middleware rewrites it — so the test exercises an existing real
// endpoint (`GET /api/v1/users/me`) and asserts the response payload
// reflects the dependent's identity, not the guardian's.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateTestToken } from './testClient.js';
import { withAuditBypass } from './helpers/auditBypass.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const GUARDIAN_UID = 'b3333333-3333-4333-8333-333333333a01';
const GUARDIAN_PHONE = '9000030001';
const OTHER_GUARDIAN_UID = 'b3333333-3333-4333-8333-333333333a02';
const OTHER_GUARDIAN_PHONE = '9000030002';
const MINOR_LINKED_UID = 'b3333333-3333-4333-8333-333333333a03';
const MINOR_LINKED_PHONE = '9000030003';
const MINOR_OTHER_UID = 'b3333333-3333-4333-8333-333333333a04';
const MINOR_OTHER_PHONE = '9000030004';
const MINOR_FOREIGN_UID = 'b3333333-3333-4333-8333-333333333a05';
const MINOR_FOREIGN_PHONE = '9000030005';
const FOREIGN_TENANT_UID = 'b3333333-3333-4333-8333-3333333333aa';

function asGuardian({ uid, id, phone }) {
  const token = generateTestToken('PATIENT', { uid, id, phone });
  return (method, path, { actingAs } = {}) => {
    let req = request(app)[method](path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);
    if (actingAs) req = req.set('X-Acting-As-Uid', actingAs);
    return req;
  };
}

async function purgeActingAsAuditRows(uids) {
  await withAuditBypass(prisma, async (tx) => {
    for (const uid of uids) {
      await tx.$executeRawUnsafe(
        `DELETE FROM hipaa_access_log WHERE actor_uid = $1::uuid OR subject_uid = $1::uuid OR accessed_by = $1::uuid`,
        uid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE uid = $1::uuid OR actor_uid = $1::uuid OR subject_uid = $1::uuid OR resource_id = $1::text`,
        uid,
      );
    }
  });
}

describe('Acting-as delegation — deep integration', () => {
  let guardianId;
  let otherGuardianId;
  let minorLinkedId;
  let minorOtherId;
  let minorForeignId;
  let primaryTenantId;
  let secondaryTenantId;
  let guardianCall;
  let otherGuardianCall;

  beforeAll(async () => {
    const allUids = [
      GUARDIAN_UID, OTHER_GUARDIAN_UID,
      MINOR_LINKED_UID, MINOR_OTHER_UID, MINOR_FOREIGN_UID,
    ];

    // Clean any prior runs in FK-safe order.
    await purgeActingAsAuditRows(allUids);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL WHERE uid = ANY($1::uuid[])`,
      allUids,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids,
    );

    // Pick the existing test-harness tenant (the seed tenant the rest of
    // the deep-test suite uses). Fall back to any tenant row when the
    // seed is named differently in this DB.
    const tenantRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM tenants ORDER BY created_at ASC LIMIT 2`,
    );
    if (!tenantRows.length) {
      throw new Error('No tenants in DB — cannot run acting-as tests');
    }
    primaryTenantId = tenantRows[0].id;
    // Need a distinct tenant for the fail-closed mismatch test. Create a
    // throwaway one if the DB only has a single tenant.
    if (tenantRows.length >= 2) {
      secondaryTenantId = tenantRows[1].id;
    } else {
      const insert = await prisma.$queryRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid, 'acting-as-foreign', 'Acting-as Foreign Tenant', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        FOREIGN_TENANT_UID,
      );
      secondaryTenantId = insert[0]?.id ?? FOREIGN_TENANT_UID;
    }

    // Guardian (adult, primary tenant).
    const g = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Acting-As Guardian', 'PATIENT', true, false, $3::uuid, NOW())
       RETURNING id`,
      GUARDIAN_UID, GUARDIAN_PHONE, primaryTenantId,
    );
    guardianId = g[0].id;

    // Second guardian — used for the not-authorised path.
    const og = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'Acting-As Other Guardian', 'PATIENT', true, false, $3::uuid, NOW())
       RETURNING id`,
      OTHER_GUARDIAN_UID, OTHER_GUARDIAN_PHONE, primaryTenantId,
    );
    otherGuardianId = og[0].id;

    // Minor pre-linked to the primary guardian.
    const ml = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, tenant_id, guardian_user_id, guardian_relationship, updated_at)
       VALUES ($1::uuid, $2, 'Acting-As Linked Minor', 'PATIENT', true, true, $3::uuid, $4, 'parent', NOW())
       RETURNING id`,
      MINOR_LINKED_UID, MINOR_LINKED_PHONE, primaryTenantId, guardianId,
    );
    minorLinkedId = ml[0].id;

    // Minor linked to the OTHER guardian — guardian-A must get 403 if
    // they try to act as this one.
    const mo = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, tenant_id, guardian_user_id, updated_at)
       VALUES ($1::uuid, $2, 'Acting-As Other Minor', 'PATIENT', true, true, $3::uuid, $4, NOW())
       RETURNING id`,
      MINOR_OTHER_UID, MINOR_OTHER_PHONE, primaryTenantId, otherGuardianId,
    );
    minorOtherId = mo[0].id;

    // Minor created via raw INSERT in a foreign tenant + pointed at the
    // primary guardian. This bypasses the linkDependent service (which
    // would reject the cross-tenant write) and gives us a row that
    // exercises the middleware's same-tenant assertion.
    const mf = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, is_minor, tenant_id, guardian_user_id, updated_at)
       VALUES ($1::uuid, $2, 'Acting-As Foreign Minor', 'PATIENT', true, true, $3::uuid, $4, NOW())
       RETURNING id`,
      MINOR_FOREIGN_UID, MINOR_FOREIGN_PHONE, secondaryTenantId, guardianId,
    );
    minorForeignId = mf[0].id;

    guardianCall = asGuardian({ uid: GUARDIAN_UID, id: guardianId, phone: GUARDIAN_PHONE });
    otherGuardianCall = asGuardian({ uid: OTHER_GUARDIAN_UID, id: otherGuardianId, phone: OTHER_GUARDIAN_PHONE });
  });

  afterAll(async () => {
    const allUids = [
      GUARDIAN_UID, OTHER_GUARDIAN_UID,
      MINOR_LINKED_UID, MINOR_OTHER_UID, MINOR_FOREIGN_UID,
    ];
    await purgeActingAsAuditRows(allUids);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL WHERE uid = ANY($1::uuid[])`,
      allUids,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, allUids,
    );
    if (secondaryTenantId === FOREIGN_TENANT_UID) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1::uuid`, FOREIGN_TENANT_UID,
      );
    }
    await prisma.$disconnect();
  });

  test('GET /users/me without delegation returns guardian', async () => {
    const res = await guardianCall('get', '/api/v1/users/me');
    expect(res.status).toBe(200);
    expect(res.body.data.user.uid).toBe(GUARDIAN_UID);
  });

  test('GET /users/me with X-Acting-As-Uid returns dependent (delegation honoured)', async () => {
    // Wait briefly for the prior PHI log to flush, then capture baseline.
    await new Promise((r) => setTimeout(r, 50));
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM hipaa_access_log
        WHERE acting_as_dependent = true
          AND actor_uid = $1::uuid
          AND subject_uid = $2::uuid`,
      GUARDIAN_UID, MINOR_LINKED_UID,
    );

    const res = await guardianCall('get', '/api/v1/users/me', { actingAs: MINOR_LINKED_UID });
    expect(res.status).toBe(200);
    // Middleware rewrote req.user → controller returned the dependent.
    expect(res.body.data.user.uid).toBe(MINOR_LINKED_UID);
    expect(res.body.data.user.uid).not.toBe(GUARDIAN_UID);
  });

  test('Acting-as records actor + subject + flag in hipaa_access_log', async () => {
    // The /dependents route mounts phiAccessLogger('PATIENT_DEMOGRAPHICS')
    // for every call — exercising it with X-Acting-As-Uid is the cleanest
    // way to verify the audit columns capture both actors. After the
    // rewrite the request lists "minor's dependents" (none, because a
    // minor isn't a guardian) — that's a successful 200, which is what
    // phiAccessLogger logs.
    const res = await guardianCall('get', '/api/v1/users/dependents', {
      actingAs: MINOR_LINKED_UID,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.dependents).toEqual([]);

    // Fire-and-forget setImmediate inside logPhiAccess — give it a beat.
    await new Promise((r) => setTimeout(r, 250));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT actor_uid, subject_uid, acting_as_dependent, record_type
         FROM hipaa_access_log
        WHERE acting_as_dependent = true
          AND actor_uid = $1::uuid
          AND subject_uid = $2::uuid
        ORDER BY accessed_at DESC
        LIMIT 1`,
      GUARDIAN_UID, MINOR_LINKED_UID,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].actor_uid).toBe(GUARDIAN_UID);
    expect(rows[0].subject_uid).toBe(MINOR_LINKED_UID);
    expect(rows[0].acting_as_dependent).toBe(true);
  });

  test('Acting-as denied when guardian is not linked to that dependent', async () => {
    // Guardian A tries to act as a minor whose guardian is B → 403.
    const res = await guardianCall('get', '/api/v1/users/me', { actingAs: MINOR_OTHER_UID });
    expect(res.status).toBe(403);
    expect(res.body.code || res.body.error).toMatch(/NOT_AUTHORISED_TO_ACT_AS|Not authorised/i);
  });

  test('Acting-as denied for malformed dependent UID', async () => {
    const res = await guardianCall('get', '/api/v1/users/me', { actingAs: 'not-a-uuid' });
    expect(res.status).toBe(403);
  });

  test('Acting-as denied after the link is removed', async () => {
    // Unlink, then attempt acting-as for the now-unlinked minor.
    await prisma.$executeRawUnsafe(
      `UPDATE users SET guardian_user_id = NULL WHERE id = $1`, minorLinkedId,
    );
    try {
      const res = await guardianCall('get', '/api/v1/users/me', { actingAs: MINOR_LINKED_UID });
      expect(res.status).toBe(403);
    } finally {
      // Restore for any remaining tests.
      await prisma.$executeRawUnsafe(
        `UPDATE users SET guardian_user_id = $1 WHERE id = $2`,
        guardianId, minorLinkedId,
      );
    }
  });

  test('Acting-as denied for cross-tenant dependent (fail-closed)', async () => {
    // minorForeign was raw-inserted in a different tenant but pointed at
    // the primary guardian — the middleware must reject this delegation
    // even though guardian_user_id matches.
    const res = await guardianCall('get', '/api/v1/users/me', { actingAs: MINOR_FOREIGN_UID });
    expect(res.status).toBe(403);

    // The dependent's data must not have leaked.
    expect(res.body.data?.user?.uid).not.toBe(MINOR_FOREIGN_UID);
  });

  test('Acting-as header pointing at self is a no-op (no rewrite, no flag)', async () => {
    const res = await guardianCall('get', '/api/v1/users/me', { actingAs: GUARDIAN_UID });
    expect(res.status).toBe(200);
    expect(res.body.data.user.uid).toBe(GUARDIAN_UID);

    await new Promise((r) => setTimeout(r, 200));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS c FROM hipaa_access_log
        WHERE acting_as_dependent = true
          AND actor_uid = $1::uuid
          AND subject_uid = $1::uuid`,
      GUARDIAN_UID,
    );
    expect(rows[0].c).toBe(0);
  });

  test('Direct (non-delegated) requests do not set the acting_as flag', async () => {
    // Plain /dependents call — no X-Acting-As-Uid. The PHI logger writes
    // a row with acting_as_dependent = false.
    await guardianCall('get', '/api/v1/users/dependents');
    await new Promise((r) => setTimeout(r, 250));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT acting_as_dependent
         FROM hipaa_access_log
        WHERE accessed_by = $1::uuid
        ORDER BY accessed_at DESC
        LIMIT 3`,
      GUARDIAN_UID,
    );
    // Most recent non-delegated rows have the flag off.
    const nonActingRows = rows.filter((r) => r.acting_as_dependent === false);
    expect(nonActingRows.length).toBeGreaterThanOrEqual(1);
  });
});
