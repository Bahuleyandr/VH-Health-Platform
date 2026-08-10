// adminLogoutRevocation.deep.test.js
//
// Audit finding #2 (4th pass): the admin app POSTs /api/v1/auth/admin/logout on
// sign-out, but the backend had no such route — the request 404'd and only the
// Next.js cookie was cleared. A captured admin JWT therefore stayed valid for
// its full 4h life after "logout". This proves the now-wired route exists,
// persists the presented token's jti to the revocation store, and that the same
// token is then rejected at jwtAuth (TOKEN_REVOKED) on a protected admin route.
//
// HERMETIC identity (2026-08-10): logout → revokeAllUserTokens durably bumps
// the identity's token_epoch (migration 650) and upserts a 30-day
// `user:<uid>` revoke-all watermark. Doing that to the SHARED seeded harness
// admin (550e8400-…, hard-coded in testClient.js and used by every admin-role
// suite) permanently invalidates the epoch-less tokens all LATER suites in the
// same DB mint for it — isUserTokensRevoked treats a missing token_epoch claim
// as epoch 0, so once the DB epoch is ≥1 every testClient admin token gets
// 401 TOKEN_REVOKED regardless of iat. That is exactly the cross-suite
// pollution that turned main's backend CI shards red. This suite therefore
// creates its own throwaway ADMIN identity and restores every piece of durable
// state in afterAll (which runs even when the test body throws).
//
// DB-backed (invalidated_tokens fallback) — self-skips when no test DB is set.

import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';

import { generateTestToken, API_KEY } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const ADMIN_PHONE = '+919899044001';
const authHeaders = (token) => ({ 'x-api-key': API_KEY, Authorization: `Bearer ${token}` });

// blacklistToken persists to invalidated_tokens via setImmediate (fire-and-
// forget) and the test env has no Redis, so the row lands a tick after the
// 200. Poll briefly rather than racing it.
async function waitForBlacklistRow(jti, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT 1 FROM invalidated_tokens WHERE jti = $1 LIMIT 1',
      jti,
    );
    if (rows.length > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

d('Admin logout revokes the presented JWT (#2)', () => {
  const jti = `a2-admin-logout-${Date.now()}`;
  let adminUid;

  beforeAll(async () => {
    // Own throwaway ADMIN identity — mirrors the migration-082 seeded harness
    // user's shape, but with a fresh uid so the epoch bump and revoke-all
    // watermark this suite provokes can never leak into other suites' tokens.
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, registered_at, updated_at)
       VALUES ($1, 'A2 Admin Logout Revocation Fixture', 'ADMIN', true, NOW(), NOW())
       RETURNING uid`,
      ADMIN_PHONE,
    );
    adminUid = rows[0].uid;
  });

  afterAll(async () => {
    // Restore ALL durable state (afterAll runs even when the test throws):
    // the presented token's jti row, the `user:<uid>` revoke-all watermark
    // written by revokeAllUserTokens, the best-effort logout audit row, and
    // the throwaway identity itself (taking its bumped token_epoch with it).
    try {
      await prisma.$executeRawUnsafe(
        'DELETE FROM invalidated_tokens WHERE jti = $1 OR jti = $2',
        jti,
        `user:${adminUid}`,
      );
      await prisma.$executeRawUnsafe(
        'DELETE FROM auth_logs WHERE user_id = $1',
        String(adminUid),
      );
      await prisma.$executeRawUnsafe(
        'DELETE FROM users WHERE uid = $1::uuid',
        adminUid,
      );
    } catch {
      /* best-effort cleanup */
    }
    await prisma.$disconnect().catch(() => {});
  });

  test('POST /auth/admin/logout exists, blacklists the jti, and the token is then rejected', async () => {
    const token = generateTestToken('ADMIN', { uid: adminUid, jti });

    // (1) The admin logout route now exists (previously 404'd) and succeeds.
    const logoutRes = await request(app)
      .post('/api/v1/auth/admin/logout')
      .set(authHeaders(token));
    expect(logoutRes.statusCode).toBe(200);

    // (2) Core property: the presented token's jti is persisted to the
    // revocation store — logout actually revokes, it does not merely clear a
    // cookie.
    expect(await waitForBlacklistRow(jti)).toBe(true);

    // (3) End-to-end: reusing the SAME token on a protected admin route is now
    // rejected at jwtAuth (before the controller) with TOKEN_REVOKED. The
    // specific code proves the 401 is the blacklist, not an unrelated reject.
    const reuseRes = await request(app)
      .get('/api/v1/auth/admin/profile')
      .set(authHeaders(token));
    expect(reuseRes.statusCode).toBe(401);
    expect(reuseRes.body.code).toBe('TOKEN_REVOKED');

    // (4) Hermeticity proof: the R1 epoch bump landed on THIS identity —
    // the revoke-all machinery ran — and only on it. The shared seeded
    // harness admin's epoch is untouched, so later suites' tokens stay valid.
    const own = await prisma.$queryRawUnsafe(
      'SELECT token_epoch FROM users WHERE uid = $1::uuid',
      adminUid,
    );
    expect(Number(own[0].token_epoch)).toBeGreaterThanOrEqual(1);
    const seeded = await prisma.$queryRawUnsafe(
      "SELECT token_epoch FROM users WHERE uid = '550e8400-e29b-41d4-a716-446655440000'::uuid",
    );
    if (seeded.length > 0) {
      expect(Number(seeded[0].token_epoch)).toBe(0);
    }
  });
});
