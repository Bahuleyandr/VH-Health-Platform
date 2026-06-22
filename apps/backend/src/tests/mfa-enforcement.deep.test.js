// Deep integration tests for mandatory TOTP MFA enforcement on SUPER_ADMIN.
//
// Covers every branch of the REQUIRE_MFA_FOR_SUPER_ADMIN flag:
//   1. SUPER_ADMIN without TOTP + flag ON  → mfa_setup_required response
//   2. SUPER_ADMIN without TOTP + flag OFF → normal login succeeds
//   3. SUPER_ADMIN with TOTP enrolled      → existing challenge flow
//   4. ADMIN (non-super) + flag ON         → normal login (not gated)
//   5. Setup token rejected on non-setup endpoint → 403 INSUFFICIENT_SCOPE
//   6. End-to-end enrollment: login → setup-enroll → setup-confirm → JWT
//
// Skipped when no TEST_DATABASE_URL/DATABASE_URL is configured (mirrors the
// skip pattern of other *-deep.test.js integration tests).

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { generate as otpGenerate } from 'otplib';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { decryptSecret } from '../utils/totpUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);

const USERNAME_SUPER_NO_TOTP = 'mfa_test_super_no_totp';
const USERNAME_SUPER_NO_TOTP_FLAG_OFF = 'mfa_test_super_flag_off';
const USERNAME_SUPER_WITH_TOTP = 'mfa_test_super_with_totp';
const USERNAME_ADMIN_NO_TOTP = 'mfa_test_admin_plain';
const PASSWORD = 'TestPass1!';

const d = DB_CONFIGURED ? describe : describe.skip;

d('MFA enforcement for SUPER_ADMIN — deep integration', () => {
  let passwordHash;
  let savedFlag;

  beforeAll(async () => {
    savedFlag = process.env.REQUIRE_MFA_FOR_SUPER_ADMIN;
    passwordHash = await bcrypt.hash(PASSWORD, 10);

    // Clean up any leftovers from previous runs
    await prisma.$executeRawUnsafe(
      `DELETE FROM admins WHERE username IN ($1, $2, $3, $4)`,
      USERNAME_SUPER_NO_TOTP,
      USERNAME_SUPER_NO_TOTP_FLAG_OFF,
      USERNAME_SUPER_WITH_TOTP,
      USERNAME_ADMIN_NO_TOTP,
    ).catch(() => {});

    // Seed: SUPER_ADMIN without TOTP (used by scenarios 1, 2, 5, 6)
    await prisma.$executeRawUnsafe(
      `INSERT INTO admins (username, email, password_hash, role, status, totp_enabled)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', 'active', FALSE)`,
      USERNAME_SUPER_NO_TOTP,
      `${USERNAME_SUPER_NO_TOTP}@test.local`,
      passwordHash,
    );

    // Seed: SUPER_ADMIN without TOTP (scenario 2 — flag OFF)
    await prisma.$executeRawUnsafe(
      `INSERT INTO admins (username, email, password_hash, role, status, totp_enabled)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', 'active', FALSE)`,
      USERNAME_SUPER_NO_TOTP_FLAG_OFF,
      `${USERNAME_SUPER_NO_TOTP_FLAG_OFF}@test.local`,
      passwordHash,
    );

    // Seed: SUPER_ADMIN with TOTP enabled (scenario 3)
    // Use a fake encryptedSecret — the challenge flow doesn't need it to verify
    // yet; it only issues a challenge token at login.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admins (username, email, password_hash, role, status,
         totp_enabled, totp_secret_encrypted, totp_enrolled_at)
       VALUES ($1, $2, $3, 'SUPER_ADMIN', 'active', TRUE, $4, NOW())`,
      USERNAME_SUPER_WITH_TOTP,
      `${USERNAME_SUPER_WITH_TOTP}@test.local`,
      passwordHash,
      'dead:beef:feed', // stub — not exercised here
    );

    // Seed: regular ADMIN without TOTP (scenario 4)
    await prisma.$executeRawUnsafe(
      `INSERT INTO admins (username, email, password_hash, role, status, totp_enabled)
       VALUES ($1, $2, $3, 'ADMIN', 'active', FALSE)`,
      USERNAME_ADMIN_NO_TOTP,
      `${USERNAME_ADMIN_NO_TOTP}@test.local`,
      passwordHash,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM admins WHERE username IN ($1, $2, $3, $4)`,
      USERNAME_SUPER_NO_TOTP,
      USERNAME_SUPER_NO_TOTP_FLAG_OFF,
      USERNAME_SUPER_WITH_TOTP,
      USERNAME_ADMIN_NO_TOTP,
    ).catch(() => {});
    if (savedFlag === undefined) delete process.env.REQUIRE_MFA_FOR_SUPER_ADMIN;
    else process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = savedFlag;
    await prisma.$disconnect().catch(() => {});
  });

  // ---------------------------------------------------------------------
  // 1. SUPER_ADMIN without TOTP + flag ON → mfa_setup_required
  // ---------------------------------------------------------------------
  it('returns mfa_setup_required for SUPER_ADMIN without TOTP when flag is on', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME_SUPER_NO_TOTP, password: PASSWORD });

    expect(res.statusCode).toBe(200);
    const payload = res.body?.data ?? res.body;
    expect(payload.requiresMfaSetup).toBe(true);
    expect(payload.setupToken).toEqual(expect.any(String));
    expect(payload.expiresIn).toBe(600);
    expect(payload.token).toBeUndefined();
    expect(payload.accessToken).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 2. SUPER_ADMIN without TOTP + flag OFF → normal login succeeds
  // ---------------------------------------------------------------------
  it('issues a normal JWT for SUPER_ADMIN without TOTP when flag is off', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'false';
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME_SUPER_NO_TOTP_FLAG_OFF, password: PASSWORD });

    expect(res.statusCode).toBe(200);
    const payload = res.body?.data ?? res.body;
    expect(payload.requiresMfaSetup).toBeFalsy();
    expect(payload.token).toEqual(expect.any(String));
    expect(payload.admin?.role).toBe('SUPER_ADMIN');
  });

  // ---------------------------------------------------------------------
  // 3. SUPER_ADMIN with TOTP enrolled → existing challenge flow
  // ---------------------------------------------------------------------
  it('issues the existing TOTP challenge for SUPER_ADMIN with TOTP enrolled', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME_SUPER_WITH_TOTP, password: PASSWORD });

    expect(res.statusCode).toBe(200);
    const payload = res.body?.data ?? res.body;
    expect(payload.requiresMfaSetup).toBeFalsy();
    expect(payload.requiresTwoFactor).toBe(true);
    expect(payload.challengeToken).toEqual(expect.any(String));
  });

  // ---------------------------------------------------------------------
  // 4. Regular ADMIN without TOTP + flag ON → normal login (flag targets
  //    SUPER_ADMIN only)
  // ---------------------------------------------------------------------
  it('does not enforce setup for non-super ADMIN even when flag is on', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    const res = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME_ADMIN_NO_TOTP, password: PASSWORD });

    expect(res.statusCode).toBe(200);
    const payload = res.body?.data ?? res.body;
    expect(payload.requiresMfaSetup).toBeFalsy();
    expect(payload.token).toEqual(expect.any(String));
    expect(payload.admin?.role).toBe('ADMIN');
  });

  // ---------------------------------------------------------------------
  // 5. Setup token rejected on non-setup endpoints → 403 INSUFFICIENT_SCOPE
  // ---------------------------------------------------------------------
  it('rejects the setup token on any non-setup authed endpoint', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    const loginRes = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME_SUPER_NO_TOTP, password: PASSWORD });

    const setupToken = (loginRes.body?.data ?? loginRes.body).setupToken;
    expect(setupToken).toEqual(expect.any(String));

    // /auth/admin/profile is a standard authed endpoint — it must refuse
    // the setup-scoped token.
    const profileRes = await request(app)
      .get('/api/v1/auth/admin/profile')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${setupToken}`);

    expect(profileRes.statusCode).toBe(403);
    const code = profileRes.body?.code || profileRes.body?.error;
    expect(String(code || '')).toMatch(/INSUFFICIENT_SCOPE|Insufficient/i);
  });

  // ---------------------------------------------------------------------
  // 6. End-to-end enrollment: login → setup-enroll → setup-confirm → JWT
  // ---------------------------------------------------------------------
  it('completes first-time enrollment end-to-end and issues a full JWT', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';

    // Make sure this account has NO TOTP (re-used from scenarios above).
    // schema.prisma is documentation-only and doesn't include the TOTP columns,
    // so `prisma.admins.update({ data: { totp_secret_encrypted: ... } })` fails
    // type-validation. Use a raw SQL update instead.
    await prisma.$executeRawUnsafe(
      `UPDATE admins
          SET totp_enabled = FALSE,
              totp_secret_encrypted = NULL,
              totp_backup_codes = NULL,
              totp_enrolled_at = NULL
        WHERE username = $1`,
      USERNAME_SUPER_NO_TOTP
    );

    const loginRes = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: USERNAME_SUPER_NO_TOTP, password: PASSWORD });
    const setupToken = (loginRes.body?.data ?? loginRes.body).setupToken;
    expect(setupToken).toEqual(expect.any(String));

    // Step 1: /mfa/setup-enroll
    const enrollRes = await request(app)
      .post('/api/v1/auth/admin/mfa/setup-enroll')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${setupToken}`);
    expect(enrollRes.statusCode).toBe(200);
    const enrollPayload = enrollRes.body?.data ?? enrollRes.body;
    expect(enrollPayload.qrCodeDataUrl).toEqual(expect.any(String));
    expect(enrollPayload.encryptedSecret).toEqual(expect.any(String));
    expect(Array.isArray(enrollPayload.backupCodes)).toBe(true);
    expect(enrollPayload.backupCodes.length).toBeGreaterThanOrEqual(1);

    // Step 2: generate the real TOTP code from the encryptedSecret.
    // otplib v13 `generate` is async; must be awaited to get the 6-digit string.
    const secret = decryptSecret(enrollPayload.encryptedSecret);
    const code = await otpGenerate({ secret });

    // Step 3: /mfa/setup-confirm
    const confirmRes = await request(app)
      .post('/api/v1/auth/admin/mfa/setup-confirm')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${setupToken}`)
      .send({
        code,
        encryptedSecret: enrollPayload.encryptedSecret,
        backupCodes: enrollPayload.backupCodes,
      });
    expect(confirmRes.statusCode).toBe(200);
    const confirmPayload = confirmRes.body?.data ?? confirmRes.body;
    expect(confirmPayload.token).toEqual(expect.any(String));
    expect(confirmPayload.admin?.role).toBe('SUPER_ADMIN');

    // Verify the DB state was updated.
    const dbAdmin = await prisma.admins.findUnique({
      where: { username: USERNAME_SUPER_NO_TOTP },
      select: { totp_enabled: true, totp_secret_encrypted: true, totp_enrolled_at: true },
    });
    expect(dbAdmin.totp_enabled).toBe(true);
    expect(dbAdmin.totp_secret_encrypted).toBe(enrollPayload.encryptedSecret);
    expect(dbAdmin.totp_enrolled_at).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 7. A completed login-time 2FA challenge stamps the `mfa` step-up claim
  //    on the issued JWT (audit 2026-06-18 — SUPER_ADMIN un-scoped bypass).
  //    requireSuperAdminStepUp reads req.user.mfa to scope the bypass on
  //    sensitive namespaces, so the challenge-verify token MUST carry it.
  // ---------------------------------------------------------------------
  it('stamps mfa:true on the JWT issued by a completed login 2FA challenge', async () => {
    process.env.REQUIRE_MFA_FOR_SUPER_ADMIN = 'true';
    const u = USERNAME_SUPER_NO_TOTP_FLAG_OFF; // super-admin, unused past scenario 2

    // Enroll a real TOTP secret so the login path returns a challenge.
    await prisma.$executeRawUnsafe(
      `UPDATE admins SET totp_enabled = FALSE, totp_secret_encrypted = NULL,
              totp_backup_codes = NULL, totp_enrolled_at = NULL WHERE username = $1`,
      u,
    );
    const login1 = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: u, password: PASSWORD });
    const setupToken = (login1.body?.data ?? login1.body).setupToken;
    expect(setupToken).toEqual(expect.any(String));
    const enroll = await request(app)
      .post('/api/v1/auth/admin/mfa/setup-enroll')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${setupToken}`);
    const ep = enroll.body?.data ?? enroll.body;
    const secret = decryptSecret(ep.encryptedSecret);
    await request(app)
      .post('/api/v1/auth/admin/mfa/setup-confirm')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${setupToken}`)
      .send({ code: await otpGenerate({ secret }), encryptedSecret: ep.encryptedSecret, backupCodes: ep.backupCodes });

    // Fresh login → TOTP challenge → verify.
    const login2 = await request(app)
      .post('/api/v1/auth/admin/login')
      .set('x-api-key', API_KEY)
      .send({ username: u, password: PASSWORD });
    const challengeToken = (login2.body?.data ?? login2.body).challengeToken;
    expect(challengeToken).toEqual(expect.any(String));

    // Use a backup code (not a fresh TOTP) so we don't collide with the code
    // just consumed by setup-confirm inside the same 30s window.
    const verifyRes = await request(app)
      .post('/api/v1/auth/admin/mfa/challenge/verify')
      .set('x-api-key', API_KEY)
      .send({ challengeToken, code: ep.backupCodes[0], useBackupCode: true });
    expect(verifyRes.statusCode).toBe(200);
    const token = (verifyRes.body?.data ?? verifyRes.body).token;
    expect(token).toEqual(expect.any(String));

    const decoded = jwt.decode(token);
    expect(decoded.mfa).toBe(true);
    expect(String(decoded.role).toUpperCase()).toBe('SUPER_ADMIN');
  });

  // ---------------------------------------------------------------------
  // M3 (audit 2026-06-22): the login 2FA challenge must cap verify attempts
  //    per challenge and burn the token at the cap — a failed verify previously
  //    left the token usable for unlimited code guesses within its window.
  // ---------------------------------------------------------------------
  it('caps the login 2FA challenge at challengeMaxAttempts and burns the token (M3)', async () => {
    // Isolate the APPLICATION attempt-cap from the auth rate limiter (failed
    // verifies count against it); restore after.
    const prevRl = process.env.RATE_LIMIT_DISABLED;
    process.env.RATE_LIMIT_DISABLED = 'true';
    try {
      // USERNAME_SUPER_WITH_TOTP is seeded totp_enabled, so a fresh login issues
      // a challenge token. We send wrong codes (a non-matching "backup code") so
      // every verify deterministically fails.
      const login = await request(app)
        .post('/api/v1/auth/admin/login')
        .set('x-api-key', API_KEY)
        .send({ username: USERNAME_SUPER_WITH_TOTP, password: PASSWORD });
      const challengeToken = (login.body?.data ?? login.body).challengeToken;
      expect(challengeToken).toEqual(expect.any(String));

      const cap = 5; // SECURITY_CONFIG.mfa.challengeMaxAttempts default
      for (let i = 0; i < cap; i++) {
        const r = await request(app)
          .post('/api/v1/auth/admin/mfa/challenge/verify')
          .set('x-api-key', API_KEY)
          .send({ challengeToken, code: 'NOT-A-REAL-BACKUP-CODE', useBackupCode: true });
        expect(r.statusCode).toBe(401);
        expect(`${r.body?.error ?? r.body?.message ?? ''}`).toMatch(/invalid mfa code/i);
      }

      // Cap reached → the token is burned and rejected with a distinct message.
      const capped = await request(app)
        .post('/api/v1/auth/admin/mfa/challenge/verify')
        .set('x-api-key', API_KEY)
        .send({ challengeToken, code: 'NOT-A-REAL-BACKUP-CODE', useBackupCode: true });
      expect(capped.statusCode).toBe(401);
      expect(`${capped.body?.error ?? capped.body?.message ?? ''}`).toMatch(/too many attempts/i);

      // The challenge row is gone — it can never be replayed, even with a valid code.
      const remaining = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM totp_challenges WHERE challenge_token = $1`,
        challengeToken,
      );
      expect(remaining[0].c).toBe(0);
    } finally {
      if (prevRl === undefined) delete process.env.RATE_LIMIT_DISABLED;
      else process.env.RATE_LIMIT_DISABLED = prevRl;
    }
  });

  // ---------------------------------------------------------------------
  // 8. Wiring: requireSuperAdminStepUp is mounted on the sensitive admin
  //    control planes — a SUPER_ADMIN token WITHOUT a 2FA session is blocked
  //    there (403 SUPER_ADMIN_MFA_REQUIRED), while a normal ADMIN is not.
  //    (audit 2026-06-18 — SUPER_ADMIN un-scoped bypass)
  // ---------------------------------------------------------------------
  it('blocks a SUPER_ADMIN without a 2FA session on a guarded namespace, but not a normal ADMIN', async () => {
    const [su] = await prisma.$queryRawUnsafe(
      `SELECT uid FROM admins WHERE username = $1`, USERNAME_SUPER_WITH_TOTP,
    );
    const [ad] = await prisma.$queryRawUnsafe(
      `SELECT uid FROM admins WHERE username = $1`, USERNAME_ADMIN_NO_TOTP,
    );

    // SUPER_ADMIN, no `mfa` claim → must be stopped by the step-up gate.
    const superToken = jwt.sign(
      { uid: String(su.uid), id: 1, role: 'SUPER_ADMIN' },
      process.env.JWT_SECRET, { expiresIn: '1h' },
    );
    const superRes = await request(app)
      .get('/api/v1/system')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${superToken}`);
    expect(superRes.statusCode).toBe(403);
    expect(JSON.stringify(superRes.body)).toContain('SUPER_ADMIN_MFA_REQUIRED');

    // Normal ADMIN → step-up does not apply; it must NOT see the step-up 403.
    const adminToken = jwt.sign(
      { uid: String(ad.uid), id: 2, role: 'ADMIN' },
      process.env.JWT_SECRET, { expiresIn: '1h' },
    );
    const adminRes = await request(app)
      .get('/api/v1/system')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(JSON.stringify(adminRes.body)).not.toContain('SUPER_ADMIN_MFA_REQUIRED');
  });
});
