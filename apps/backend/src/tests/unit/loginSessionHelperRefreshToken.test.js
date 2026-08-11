// src/tests/unit/loginSessionHelperRefreshToken.test.js
//
// Unit coverage for the SHARED refresh-token minter
// (loginSessionHelper.generateRefreshToken), the single source of truth for
// how every realm (patient / admin / Firebase) stamps a refresh credential.
//
// C-9 (audit 2026-06-18): the public /refresh-token endpoint now accepts ONLY
// tokens carrying `type:'refresh'`. This helper is what mints them, so these
// tests pin the security-load-bearing shape: the `type:'refresh'` claim, the
// identity claims, and the long (30d) refresh expiry — distinct from the short
// access-token TTL.
//
// jwtUtils + securityConfig are REAL so we assert against a genuinely signed
// token; only prisma + the session writer are stubbed to keep the import graph
// hermetic (no DB / WS / Redis handles).

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

const prismaMock = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../services/auth/userActiveSession.js', () => ({
  claimUserSession: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { generateRefreshToken } = await import('../../services/auth/loginSessionHelper.js');

function decode(token) {
  return jwt.decode(token);
}

describe('loginSessionHelper.generateRefreshToken', () => {
  it('mints a token carrying type:refresh with the full identity claims', async () => {
    const token = await generateRefreshToken({
      uid: 'user-uuid-1',
      id: 42,
      phone: '+919876543210',
      role: 'PATIENT',
    });
    const payload = decode(token);

    expect(payload.type).toBe('refresh');
    // jwtUtils maps uid -> sub (the codebase's canonical uid claim), keeps id/phone/role.
    expect(payload.sub).toBe('user-uuid-1');
    expect(payload.id).toBe(42);
    expect(payload.phone).toBe('+919876543210');
    expect(payload.role).toBe('PATIENT');
    // Every minted token is revocable.
    expect(typeof payload.jti).toBe('string');
    // R1: the mint-time token generation is stamped so the refresh endpoints
    // can refuse tokens minted under an older epoch at issuance time.
    expect(payload.token_epoch).toBe(0);
  });

  it('uses the long refresh expiry (30 days), not the short access TTL', async () => {
    const token = await generateRefreshToken({ uid: 'u', id: 1, phone: '+91', role: 'PATIENT' });
    const { iat, exp } = decode(token);
    expect(exp - iat).toBe(30 * 24 * 60 * 60);
  });

  it('omits id, phone, and MFA step-up when they are not supplied (admin-shape payload)', async () => {
    const token = await generateRefreshToken({
      uid: 'admin-uuid',
      role: 'ADMIN',
      realm: 'admin',
      // Even a caller that presents the old flag must not turn a 30-day
      // refresh credential into renewable proof of a one-time TOTP step-up.
      mfa: true,
    });
    const payload = decode(token);

    expect(payload.type).toBe('refresh');
    expect(payload.sub).toBe('admin-uuid');
    expect(payload.role).toBe('ADMIN');
    expect(payload.realm).toBe('admin');
    expect(payload.mfa).toBeUndefined();
    expect(payload.id).toBeUndefined();
    expect(payload.phone).toBeUndefined();
  });
});
