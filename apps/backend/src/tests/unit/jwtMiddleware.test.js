// Unit tests for jwtMiddleware — locks in the contract that `req.user` carries
// `{ uid, role, roles?, phone?, email?, id? }`. The `id` surface was added
// 2026-04-14 after an audit found 100+ call sites doing `String(user.id)` against
// an always-undefined field. Broken IDOR checks in appointments + elsewhere.

import jwt from 'jsonwebtoken';
import jwtMiddleware from '../../middleware/jwtMiddleware.js';
import prisma from '../../lib/prisma.js';

const SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-ci-must-be-at-least-32-chars';

function makeReq(tokenPayload, extraHeaders = {}) {
  const token = jwt.sign(tokenPayload, SECRET, { expiresIn: '1h' });
  return {
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
    connection: { remoteAddress: '127.0.0.1' },
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

describe('jwtMiddleware.req.user shape', () => {
  it('surfaces uid + role + id when all three are present on the token', async () => {
    const req = makeReq({
      uid: 'test-user-1',
      id: 42,
      role: 'DOCTOR',
      phone: '+919000000000',
      email: 'doc@test.local',
    });
    const res = makeRes();
    let nextCalled = false;
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user).toMatchObject({
      uid: 'test-user-1',
      id: 42,
      role: 'DOCTOR',
      phone: '+919000000000',
      email: 'doc@test.local',
    });
  });

  it('normalizes SUPER_ADMIN → ADMIN', async () => {
    const req = makeReq({ uid: 'test-admin-2', id: 1, role: 'SUPER_ADMIN' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.role).toBe('ADMIN');
  });

  it('normalizes NURSE → NURSING_STAFF', async () => {
    const req = makeReq({ uid: 'test-nurse-3', id: 2, role: 'NURSE' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.role).toBe('NURSING_STAFF');
  });

  it('rejects a UUID token when no users or admins identity row matches', async () => {
    const req = makeReq({ uid: 'a0000000-0000-4000-8000-000000000004', role: 'PATIENT' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body?.code).toBe('TOKEN_REVOKED');
    expect(req.user).toBeUndefined();
  });

  // Regression for finding
  // 2026-05-08-walk-in-opd-doctor-idor-check-always-fails-for-staff-jwt:
  // many token-issuance paths (admin login, MFA verify, staff PIN login)
  // never carried an integer `id` claim, so every IDOR check that compared
  // `req.user.id` against an int FK silently 403'd. The fallback below
  // resolves users.uid → users.id when the token doesn't carry it.
  describe('id fallback via uid → users.id lookup', () => {
    const FALLBACK_UID = 'a0000000-0000-4000-8000-0000000fb001';
    let fallbackId;

    beforeAll(async () => {
      await prisma
        .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, FALLBACK_UID)
        .catch(() => {});
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, '9999220001', 'JWT Fallback Doctor', 'DOCTOR', true, NOW())
         RETURNING id`,
        FALLBACK_UID
      );
      fallbackId = rows[0].id;
    });

    afterAll(async () => {
      await prisma
        .$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, FALLBACK_UID)
        .catch(() => {});
    });

    it('resolves req.user.id from the users table when token omits the id claim', async () => {
      const req = makeReq({ uid: FALLBACK_UID, role: 'DOCTOR' }); // no `id` claim
      const res = makeRes();
      await jwtMiddleware(req, res, () => {});
      expect(req.user.uid).toBe(FALLBACK_UID);
      expect(req.user.id).toBe(fallbackId);
    });
  });

  it('accepts userId claim as a fallback for id', async () => {
    const req = makeReq({ uid: 'test-user-5', userId: 99, role: 'PATIENT' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.id).toBe(99);
  });

  it('rejects missing Authorization header with 401', async () => {
    const req = { headers: {}, connection: { remoteAddress: '127.0.0.1' } };
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body?.success).toBe(false);
  });

  it('rejects malformed Authorization header with 401', async () => {
    const req = { headers: { authorization: 'Basic abc' }, connection: { remoteAddress: '127.0.0.1' } };
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const tampered = jwt.sign({ uid: 'x', role: 'PATIENT' }, 'wrong-secret', { expiresIn: '1h' });
    const req = { headers: { authorization: `Bearer ${tampered}` }, connection: { remoteAddress: '127.0.0.1' } };
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with no uid-like claim with 400', async () => {
    const req = makeReq({ role: 'PATIENT' }); // no uid/sub/id
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(400);
  });
});

// The `mfa` claim is stamped only on tokens minted by the admin 2FA challenge
// (mfaVerifyChallenge). It must survive onto req.user so requireSuperAdminStepUp
// can gate sensitive namespaces (audit 2026-06-18 — SUPER_ADMIN un-scoped bypass).
describe('jwtMiddleware.req.user.mfa (2FA step-up claim)', () => {
  it('surfaces mfa:true from a 2FA-verified admin token', async () => {
    const req = makeReq({ uid: 'test-admin-a', id: 7, role: 'SUPER_ADMIN', mfa: true });
    const res = makeRes();
    let nextCalled = false;
    await jwtMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.user.mfa).toBe(true);
  });

  it('does not invent mfa when the token lacks the claim (password-only session)', async () => {
    const req = makeReq({ uid: 'test-admin-b', id: 8, role: 'ADMIN' });
    const res = makeRes();
    await jwtMiddleware(req, res, () => {});
    expect(req.user.mfa).not.toBe(true);
  });
});
