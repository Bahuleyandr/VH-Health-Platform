import { jest } from '@jest/globals';

// Mock the tenant service so we control what tenants.settings the resolver sees.
const getTenantByIdMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: getTenantByIdMock,
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  CARE_TEAM_ENFORCEMENT_MODES,
  DEFAULT_ENFORCEMENT_MODE,
  normalizeEnforcementMode,
  resolveEnforcementModeForTenant,
  resolveEnforcementModeForRequest,
} = await import('../../services/security/careTeamEnforcement.js');

const TENANT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  getTenantByIdMock.mockReset();
  delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
});

describe('careTeamEnforcement.normalizeEnforcementMode', () => {
  it('accepts the three valid modes case-insensitively', () => {
    expect(normalizeEnforcementMode('off')).toBe('off');
    expect(normalizeEnforcementMode('SHADOW')).toBe('shadow');
    expect(normalizeEnforcementMode('  Enforce ')).toBe('enforce');
  });

  it('rejects unknown / empty values', () => {
    expect(normalizeEnforcementMode('strict')).toBeNull();
    expect(normalizeEnforcementMode('')).toBeNull();
    expect(normalizeEnforcementMode(null)).toBeNull();
    expect(normalizeEnforcementMode(undefined)).toBeNull();
  });
});

describe('careTeamEnforcement.resolveEnforcementModeForTenant', () => {
  it('defaults to shadow when the tenant has no setting', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('shadow');
    expect(DEFAULT_ENFORCEMENT_MODE).toBe(CARE_TEAM_ENFORCEMENT_MODES.SHADOW);
  });

  it('reads off from tenants.settings.care_team_enforcement_mode', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_team_enforcement_mode: 'off' },
    });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('off');
  });

  it('reads enforce from tenants.settings', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_team_enforcement_mode: 'enforce' },
    });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('reads shadow from tenants.settings explicitly', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_team_enforcement_mode: 'shadow' },
    });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('shadow');
  });

  it('tolerates settings stored as a JSON string', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: JSON.stringify({ care_team_enforcement_mode: 'enforce' }),
    });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('fails closed when stored settings JSON cannot be parsed', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: '{not-json' });
    await expect(resolveEnforcementModeForTenant(TENANT)).rejects.toMatchObject({
      code: 'CARE_TEAM_MODE_UNAVAILABLE',
    });
  });

  it('ignores an invalid per-tenant value and falls back to default', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_team_enforcement_mode: 'banana' },
    });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('shadow');
  });

  it('uses the CARE_TEAM_ENFORCEMENT_MODE env var as the fallback when no tenant setting', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'off';
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('off');
  });

  it('per-tenant setting overrides the env var', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'off';
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_team_enforcement_mode: 'enforce' },
    });
    await expect(resolveEnforcementModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('fails closed when the tenant lookup throws instead of downgrading enforce to shadow', async () => {
    getTenantByIdMock.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveEnforcementModeForTenant(TENANT)).rejects.toMatchObject({
      code: 'CARE_TEAM_MODE_UNAVAILABLE',
    });
  });

  it('fails closed when the tenant row is missing', async () => {
    getTenantByIdMock.mockResolvedValueOnce(null);
    await expect(resolveEnforcementModeForTenant(TENANT)).rejects.toMatchObject({
      code: 'CARE_TEAM_MODE_UNAVAILABLE',
    });
  });
});

describe('careTeamEnforcement.resolveEnforcementModeForRequest', () => {
  it('keys off req.tenantId', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_team_enforcement_mode: 'enforce' },
    });
    await expect(resolveEnforcementModeForRequest({ tenantId: TENANT })).resolves.toBe('enforce');
    expect(getTenantByIdMock).toHaveBeenCalledWith(TENANT);
  });

  it('falls back to the default tenant id when the request carries none', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: 'x', settings: {} });
    await expect(resolveEnforcementModeForRequest({})).resolves.toBe('shadow');
    expect(getTenantByIdMock).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
  });
});
