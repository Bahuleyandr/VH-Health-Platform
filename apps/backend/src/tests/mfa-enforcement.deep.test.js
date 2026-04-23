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
});
