// Deep integration tests: the mfa_setup token carries the identity's CURRENT
// token_epoch (R1 issuance-time revocation gate, migration 650).
//
// The setup token is a REST bearer on /mfa/setup-enroll + /mfa/setup-confirm,
// so it runs through jwtMiddleware's fail-closed revocation gate like any
// other bearer. Pre-fix it was minted WITHOUT a token_epoch claim, so the
// gate treated it as legacy epoch-0 and refused it (401 TOKEN_REVOKED) for
// any admin whose durable epoch was ever bumped — i.e. a SUPER_ADMIN who had
// ever logged out (or been force-revoked) could never complete FIRST-TIME MFA
// enrollment: login returned a setup token that every setup route rejected.
//
// Mirrors mfa-enforcement.deep.test.js (real app + real DB seeding) and
// ws-ticket-epoch-revocation.deep.test.js (epoch bump via revokeAllUserTokens):
//   1. Admin with durable epoch >= 1 logs in → setup token carries the
//      current epoch and is ACCEPTED by /mfa/setup-enroll (pre-fix: 401).
//   2. A setup token minted BEFORE a revoke-all is still refused 401 —
//      the fix does not weaken the gate.
//   3. issueSetupToken refuses to mint without a finite epoch — the
//      structural guard that keeps this bug class from returning.
//
// Skipped when no TEST_DATABASE_URL/DATABASE_URL is configured (mirrors the
// skip pattern of other *-deep.test.js integration tests).

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { issueSetupToken } from '../utils/jwtUtils.js';
import { getCurrentTokenEpoch, revokeAllUserTokens } from '../utils/tokenBlacklist.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

const USERNAME = 'mfa_setup_epoch_super';
const PASSWORD = 'TestPass1!';

const d = DB_CONFIGURED ? describe : describe.skip;

d('mfa_setup token carries token_epoch — deep integration', () => {
  let savedFlag;
  let adminUid;

  beforeAll(async () => {
    savedFlag = process.env.REQUIRE_MFA_FOR_SUPER_ADMIN;
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    // Own throwaway SUPER_ADMIN identity — this suite bumps its token_epoch,
    // so it must never reuse the shared seeded admin (see the shard-2
    // admin-401 pollution fixed in PR #837).
    await prisma.$executeRawUnsafe(
      `DELETE FROM admins WHERE username = $1`, USERNAME,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `INSERT INTO admins (username, email, password_hash, role, status, totp_enabled)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', 'active', FALSE)`,
      USERNAME,
      `${USERNAME}@test.local`,
      passwordHash,
    );
    const [row] = await prisma.$queryRawUnsafe(
      `SELECT uid FROM admins WHERE username = $1`, USERNAME,
    );
    adminUid = String(row.uid);
  });

  afterAll(async () => {
    // Hermetic teardown: remove the throwaway admin AND its revoke-all
    // watermark so no later suite in the same chunk inherits a bumped epoch
    // or a revocation marker from this identity.
    if (adminUid) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM invalidated_tokens WHERE jti = $1`, `user:${adminUid}`,
      ).catch(() => {});
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM admins WHERE username = $1`, USERNAME,
    ).catch(() => {});
    if (savedFlag === undefined) delete process.env.REQUIRE_MFA_FOR_SUPER_ADMIN;
    else process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = savedFlag;
    await prisma.$disconnect().catch(() => {});
  });

  async function loginForSetupToken() {
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const payload = res.body?.data ?? res.body;
    expect(payload.requiresMfaSetup).toBe(true);
    expect(payload.setupToken).toEqual(expect.any(String));
    return payload.setupToken;
  }

  // -----------------------------------------------------------------------
  // 1. Post-revocation identity + fresh setup token → enrollment proceeds
  // -----------------------------------------------------------------------
  it('stamps the current epoch on the setup token and admits it on /mfa/setup-enroll after a prior revoke-all', async () => {
    // The admin has logged out / been force-revoked before: durable epoch >= 1.
    // This is exactly the state in which the pre-fix epoch-less setup token
    // was refused on every setup route.
    await revokeAllUserTokens(adminUid, { reason: 'test_prior_logout' });
    const epoch = await getCurrentTokenEpoch(adminUid);
    expect(epoch).toBeGreaterThanOrEqual(1);

    const setupToken = await loginForSetupToken();
    const decoded = jwt.decode(setupToken);
    expect(decoded.scope).toBe('mfa_setup');
    expect(decoded.token_epoch).toBe(epoch);

    const enrollRes = await request(app)
      .post('/api/v1/auth/admin/mfa/setup-enroll')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${setupToken}`);
    expect(enrollRes.statusCode).toBe(200);
    const enrollPayload = enrollRes.body?.data ?? enrollRes.body;
    expect(enrollPayload.qrCodeDataUrl).toEqual(expect.any(String));
    expect(enrollPayload.encryptedSecret).toEqual(expect.any(String));
  });

  // -----------------------------------------------------------------------
  // 2. A setup token from before a revoke-all is still refused (gate intact)
  // -----------------------------------------------------------------------
  it('still refuses a setup token minted before a revoke-all', async () => {
    const staleToken = await loginForSetupToken();

    // Revoke AFTER the mint: the token's stamped epoch is now strictly older
    // than the identity's durable epoch, so the fail-closed gate refuses it.
    await revokeAllUserTokens(adminUid, { reason: 'test_revoke_after_mint' });

    const enrollRes = await request(app)
      .post('/api/v1/auth/admin/mfa/setup-enroll')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staleToken}`);
    expect(enrollRes.statusCode).toBe(401);
    expect(enrollRes.body?.code).toBe('TOKEN_REVOKED');
  });

  // -----------------------------------------------------------------------
  // 3. Structural guard: no epoch, no mint
  // -----------------------------------------------------------------------
  it('issueSetupToken refuses to mint without a finite token epoch', () => {
    expect(() => issueSetupToken({ uid: adminUid, role: 'SUPER_ADMIN' }))
      .toThrow(/tokenEpoch/);
    expect(() => issueSetupToken({ uid: adminUid, role: 'SUPER_ADMIN' }, Number.NaN))
      .toThrow(/tokenEpoch/);
  });
});
