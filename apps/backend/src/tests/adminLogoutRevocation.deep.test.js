// adminLogoutRevocation.deep.test.js
//
// Audit finding #2 (4th pass): the admin app POSTs /api/v1/auth/admin/logout on
// sign-out, but the backend had no such route — the request 404'd and only the
// Next.js cookie was cleared. A captured admin JWT therefore stayed valid for
// its full 4h life after "logout". This proves the now-wired route exists,
// persists the presented token's jti to the revocation store, and that the same
// token is then rejected at jwtAuth (TOKEN_REVOKED) on a protected admin route.
//
// DB-backed (invalidated_tokens fallback) — self-skips when no test DB is set.

import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';

import { generateTestToken, API_KEY } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const ADMIN_UID = '550e8400-e29b-41d4-a716-446655440000';
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

  afterAll(async () => {
    try {
      await prisma.$queryRawUnsafe('DELETE FROM invalidated_tokens WHERE jti = $1', jti);
    } catch {
      /* best-effort cleanup */
    }
    await prisma.$disconnect().catch(() => {});
  });

  test('POST /auth/admin/logout exists, blacklists the jti, and the token is then rejected', async () => {
    const token = generateTestToken('ADMIN', { uid: ADMIN_UID, jti });

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
  });
});
