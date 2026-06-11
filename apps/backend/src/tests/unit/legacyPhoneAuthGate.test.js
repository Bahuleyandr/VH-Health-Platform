// Regression test for finding 2026-05-22-walk-in-opd-patient-36657889 (H3).
//
// POST /api/v1/auth/login (legacy) → AuthService.legacyLogin → directOtpLogin
// minted a usable JWT for ANY registered phone with NO OTP/password — anyone
// who knew a patient's number could open that patient's chart. The fix gates
// the legacy phone-only login/register so it is refused by default everywhere
// and can only be explicitly enabled for local compatibility outside
// production. The gate runs BEFORE any DB call.

import { AuthService } from '../../services/auth/authService.js';

describe('legacy phone-only auth gate (H3)', () => {
  const origEnv = process.env.NODE_ENV;
  const originalLegacyPhoneAuth = process.env.ENABLE_LEGACY_PHONE_AUTH;
  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    if (originalLegacyPhoneAuth === undefined) {
      delete process.env.ENABLE_LEGACY_PHONE_AUTH;
    } else {
      process.env.ENABLE_LEGACY_PHONE_AUTH = originalLegacyPhoneAuth;
    }
  });

  it('refuses legacyLogin in production with 403 PHONE_AUTH_DISABLED (no JWT, no DB call)', async () => {
    process.env.NODE_ENV = 'production';
    await expect(AuthService.legacyLogin('9999999999', {}))
      .rejects.toMatchObject({ statusCode: 403, code: 'PHONE_AUTH_DISABLED' });
  });

  it('refuses legacyRegister in production with 403 PHONE_AUTH_DISABLED', async () => {
    process.env.NODE_ENV = 'production';
    await expect(AuthService.legacyRegister('9999999999', {}))
      .rejects.toMatchObject({ statusCode: 403, code: 'PHONE_AUTH_DISABLED' });
  });

  it('refuses legacy phone auth by default outside production', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_LEGACY_PHONE_AUTH;
    expect(() => AuthService._assertLegacyPhoneAuthAllowed('login'))
      .toThrow(/Phone-only login is disabled/i);
  });

  it('is case-insensitive about the production marker', () => {
    process.env.NODE_ENV = 'PRODUCTION';
    process.env.ENABLE_LEGACY_PHONE_AUTH = 'true';
    expect(() => AuthService._assertLegacyPhoneAuthAllowed('login'))
      .toThrow(/Phone-only login is disabled/i);
  });

  it('allows legacy phone auth only when explicitly enabled outside production', () => {
    process.env.ENABLE_LEGACY_PHONE_AUTH = 'true';
    for (const env of ['test', 'development', 'staging', '']) {
      process.env.NODE_ENV = env;
      expect(() => AuthService._assertLegacyPhoneAuthAllowed('login')).not.toThrow();
    }
  });
});
