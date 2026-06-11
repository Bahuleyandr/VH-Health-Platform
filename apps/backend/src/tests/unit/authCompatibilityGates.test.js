import {
  isDevAuthEnabled,
  isLegacyPhoneAuthAllowed,
  isProductionEnv,
} from '../../utils/authCompatibilityGates.js';

describe('auth compatibility gates', () => {
  it('detects production case-insensitively', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'PRODUCTION' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'test' })).toBe(false);
  });

  it('keeps legacy phone auth disabled by default outside production', () => {
    expect(isLegacyPhoneAuthAllowed({ NODE_ENV: 'test' })).toBe(false);
    expect(isLegacyPhoneAuthAllowed({ NODE_ENV: 'development', ENABLE_LEGACY_PHONE_AUTH: 'false' })).toBe(false);
  });

  it('allows legacy phone auth only when explicitly enabled outside production', () => {
    expect(isLegacyPhoneAuthAllowed({
      NODE_ENV: 'development',
      ENABLE_LEGACY_PHONE_AUTH: 'true',
    })).toBe(true);
    expect(isLegacyPhoneAuthAllowed({
      NODE_ENV: 'production',
      ENABLE_LEGACY_PHONE_AUTH: 'true',
    })).toBe(false);
  });

  it('keeps dev auth disabled by default outside production', () => {
    expect(isDevAuthEnabled({ NODE_ENV: 'test' })).toBe(false);
    expect(isDevAuthEnabled({ NODE_ENV: 'development', ENABLE_DEV_AUTH: 'false' })).toBe(false);
  });

  it('allows dev auth only when explicitly enabled outside production', () => {
    expect(isDevAuthEnabled({
      NODE_ENV: 'development',
      ENABLE_DEV_AUTH: 'true',
    })).toBe(true);
    expect(isDevAuthEnabled({
      NODE_ENV: 'production',
      ENABLE_DEV_AUTH: 'true',
    })).toBe(false);
  });
});
