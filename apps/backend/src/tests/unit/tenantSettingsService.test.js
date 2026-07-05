import { jest } from '@jest/globals';

const getTenantById = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById,
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));
const {
  getTenantSettings,
  getRateLimitOverride,
  getBranding,
  getFrontDeskBiometricCaptureSettings,
} = await import(
  '../../services/tenant/tenantSettingsService.js'
);

describe('tenantSettingsService', () => {
  beforeEach(() => getTenantById.mockReset());

  it('returns the parsed settings object', async () => {
    getTenantById.mockResolvedValue({
      settings: { rateLimits: { patient: { max: 250 } }, branding: { name: 'A' } },
    });
    expect(await getTenantSettings('t1')).toEqual({
      rateLimits: { patient: { max: 250 } },
      branding: { name: 'A' },
    });
  });

  it('returns {} when tenant missing or settings null', async () => {
    getTenantById.mockResolvedValue(null);
    expect(await getTenantSettings('t1')).toEqual({});
    getTenantById.mockResolvedValue({ settings: null });
    expect(await getTenantSettings('t1')).toEqual({});
  });

  it('returns {} (never throws) when the lookup rejects', async () => {
    getTenantById.mockRejectedValue(new Error('db down'));
    expect(await getTenantSettings('t1')).toEqual({});
  });

  it('getRateLimitOverride returns the profile override or null', async () => {
    getTenantById.mockResolvedValue({
      settings: { rateLimits: { patient: { windowMs: 60000, max: 250 } } },
    });
    expect(await getRateLimitOverride('t1', 'patient')).toEqual({ windowMs: 60000, max: 250 });
    expect(await getRateLimitOverride('t1', 'staff')).toBeNull();
  });

  it('getBranding returns the branding object or {}', async () => {
    getTenantById.mockResolvedValue({ settings: { branding: { name: 'Apollo' } } });
    expect(await getBranding('t1')).toEqual({ name: 'Apollo' });
    getTenantById.mockResolvedValue({ settings: {} });
    expect(await getBranding('t1')).toEqual({});
  });

  it('getFrontDeskBiometricCaptureSettings is disabled by default', async () => {
    getTenantById.mockResolvedValue({ settings: {} });
    expect(await getFrontDeskBiometricCaptureSettings('t1')).toEqual({
      enabled: false,
      modes: [],
      provider: null,
    });
  });

  it('getFrontDeskBiometricCaptureSettings filters the documented modes', async () => {
    getTenantById.mockResolvedValue({
      settings: {
        biometricCapture: {
          frontDeskRegistration: {
            enabled: true,
            modes: ['face', 'fingerprint', 'palm'],
            provider: 'Procured SDK',
          },
        },
      },
    });
    expect(await getFrontDeskBiometricCaptureSettings('t1')).toEqual({
      enabled: true,
      modes: ['face', 'fingerprint'],
      provider: 'Procured SDK',
    });
  });
});
