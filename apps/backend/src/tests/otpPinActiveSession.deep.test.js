// Audit finding #27: OTP/PIN access tokens must be registered in
// user_active_sessions so session policy and revoke-all apply to every login
// realm. This test uses the real OTP, PIN, session, JWT, and revocation paths
// against a disposable database.

import { jest } from '@jest/globals';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

import prisma from '../lib/prisma.js';
import jwtMiddleware from '../middleware/jwtMiddleware.js';
import { AuthService } from '../services/auth/authService.js';
import { storeOTP } from '../services/auth/otpService.js';
import { StaffAuthService } from '../services/auth/staffAuthService.js';
import { revokeAllUserTokens } from '../utils/tokenBlacklist.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '27000000-0000-4000-8000-000000000001';
const PATIENT_UID = '27000000-0000-4000-8000-000000000011';
const STAFF_UID = '27000000-0000-4000-8000-000000000012';
const PATIENT_PHONE = '+919270000011';
const STAFF_PHONE = '+919270000012';
const EMPLOYEE_ID = 'OTP27EMP';
const PIN = '4827';
const DEVICE_TOKEN = 'otp27-registered-device-token';
const REQUEST = {
  ip: '203.0.113.27',
  headers: {
    'user-agent': 'vh-health-otp-pin-deep-test',
    'x-forwarded-for': '203.0.113.27',
  },
  connection: { remoteAddress: '203.0.113.27' },
};

let patientId;
let staffId;

async function waitForRevokeAllMarker(uid, issuedAt, tries = 100) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1
         FROM invalidated_tokens
        WHERE jti = $1
          AND created_at > to_timestamp($2)
        LIMIT 1`,
      `user:${uid}`,
      issuedAt,
    );
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function waitUntilAfterIssuedSecond(issuedAt) {
  while (Math.floor(Date.now() / 1000) <= issuedAt) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function expectTrackedAndRevoked({ uid, token }) {
  const decoded = jwt.decode(token);
  expect(decoded).toMatchObject({ sub: uid, deviceType: 'mobile' });
  expect(decoded.jti).toEqual(expect.any(String));

  const sessions = await prisma.$queryRawUnsafe(
    `SELECT jti, device_type, ip_address::text AS ip_address, user_agent, tenant_id::text AS tenant_id
       FROM user_active_sessions
      WHERE user_uid = $1::uuid`,
    uid,
  );
  expect(sessions).toEqual([
    expect.objectContaining({
      jti: decoded.jti,
      device_type: 'mobile',
      ip_address: REQUEST.ip,
      user_agent: REQUEST.headers['user-agent'],
      tenant_id: TENANT_ID,
    }),
  ]);

  // Avoid the revoke-all watermark sharing the token's whole-second iat. This
  // makes both Redis and PostgreSQL prove that revocation happened afterwards.
  await waitUntilAfterIssuedSecond(decoded.iat);
  await revokeAllUserTokens(uid);
  expect(await waitForRevokeAllMarker(uid, decoded.iat)).toBe(true);

  // Prove the middleware rejection comes from revoke-all, not a per-token jti
  // row that would mask a broken user watermark.
  const individualRows = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM invalidated_tokens WHERE jti = $1 LIMIT 1',
    decoded.jti,
  );
  expect(individualRows).toHaveLength(0);

  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const next = jest.fn();

  await jwtMiddleware(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(401);
  expect(res.body).toMatchObject({ code: 'TOKEN_REVOKED' });
}

d('OTP/PIN active-session tracking and revoke-all (#27)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, 'otp-pin-27', 'OTP PIN 27', 'IN', 'DPDP', 'active', '{}'::jsonb, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );

    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid, $2, 'OTP 27 Patient', 'PATIENT', $3::uuid, true, NOW())
       RETURNING id`,
      PATIENT_UID,
      PATIENT_PHONE,
      TENANT_ID,
    );
    patientId = patientRows[0].id;

    const staffRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, email, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid, $2, 'OTP 27 Staff', 'otp27.staff@example.test', 'NURSE', $3::uuid, true, NOW())
       RETURNING id`,
      STAFF_UID,
      STAFF_PHONE,
      TENANT_ID,
    );
    staffId = staffRows[0].id;
    const pinHash = await bcrypt.hash(PIN, 10);

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff
         (user_id, employee_id, name, department, position, is_active, pin_hash,
          tenant_id, skills, certifications, identity_overrides, updated_at)
       VALUES
         ($1::uuid, $2, 'OTP 27 Staff', 'Nursing', 'Nurse', true, $3,
          $4::uuid, '{}'::text[], '{}'::text[], '{}'::jsonb, NOW())`,
      STAFF_UID,
      EMPLOYEE_ID,
      pinHash,
      TENANT_ID,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_devices
         (staff_id, device_id, device_name, device_token, is_active, tenant_id,
          registered_at, trust_expires_at, created_at)
       VALUES
         ($1, 'otp27-device', 'OTP 27 Device', $2, true, $3::uuid,
          NOW(), NOW() + INTERVAL '1 day', NOW())`,
      staffId,
      DEVICE_TOKEN,
      TENANT_ID,
    );
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      'DELETE FROM invalidated_tokens WHERE jti IN ($1, $2)',
      `user:${PATIENT_UID}`,
      `user:${STAFF_UID}`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      'DELETE FROM user_active_sessions WHERE user_uid IN ($1::uuid, $2::uuid)',
      PATIENT_UID,
      STAFF_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM otp_logs WHERE phone = $1', PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM otp_sessions WHERE phone = $1', PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM auth_logs WHERE phone = $1', EMPLOYEE_ID).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM admin_activity_logs WHERE admin_uid = $1::uuid', STAFF_UID).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM staff_devices WHERE staff_id = $1', staffId).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM staff WHERE user_id = $1::uuid', STAFF_UID).catch(() => {});
    await prisma.$executeRawUnsafe(
      'DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)',
      PATIENT_UID,
      STAFF_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM tenants WHERE id = $1::uuid', TENANT_ID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('tracks a real OTP login and revoke-all rejects its bearer', async () => {
    const { otp } = await storeOTP(PATIENT_PHONE, 'login', patientId);
    const result = await AuthService.verifyOtpAndAuthenticate(
      PATIENT_PHONE,
      otp,
      REQUEST,
      { deviceType: 'mobile' },
    );

    await expectTrackedAndRevoked({ uid: PATIENT_UID, token: result.token });
  });

  it('tracks the live device-bound PIN login and revoke-all rejects its bearer', async () => {
    const result = await StaffAuthService.authenticateStaffWithPin(
      EMPLOYEE_ID,
      PIN,
      REQUEST,
      { deviceType: 'mobile', deviceToken: DEVICE_TOKEN },
    );

    await expectTrackedAndRevoked({ uid: STAFF_UID, token: result.accessToken });
  });
});
