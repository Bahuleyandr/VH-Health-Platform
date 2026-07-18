import { jest } from '@jest/globals';

const getTenantByIdMock = jest.fn();
const loggerDebugMock = jest.fn();

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: getTenantByIdMock,
  requireTenantId: (tenantId) => {
    if (tenantId) return tenantId;
    const error = new Error('Tenant context required');
    error.code = 'TENANT_CONTEXT_REQUIRED';
    throw error;
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    debug: loggerDebugMock,
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const {
  CARE_PATHWAY_KEYS,
  CANONICAL_PATHWAY_KEYS,
  PATHWAY_MODES,
  DEFAULT_PATHWAY_MODE,
  normalizePathwayMode,
  resolvePathwayMode,
} = await import('../../services/pathways/pathwayMode.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATHWAY_KEY = CARE_PATHWAY_KEYS.DIAGNOSTICS;

afterEach(() => {
  getTenantByIdMock.mockReset();
  loggerDebugMock.mockReset();
  delete process.env.CARE_PATHWAYS_MODE;
  delete process.env.CARE_PATHWAY_MODE;
});

describe('pathway mode contract', () => {
  it('publishes exactly the six canonical program pathway keys', () => {
    expect(CANONICAL_PATHWAY_KEYS).toEqual([
      'diagnostics_order_to_action',
      'referral_request_to_closure',
      'op_contact_to_recovery',
      'inpatient_admission_to_recovery',
      'emergency_arrival_to_aftercare',
      'surgery_decision_to_recovery',
    ]);
    expect(new Set(CANONICAL_PATHWAY_KEYS)).toHaveProperty('size', 6);
    expect(Object.isFrozen(CANONICAL_PATHWAY_KEYS)).toBe(true);
  });

  it('normalizes only off, shadow and active', () => {
    expect(normalizePathwayMode('off')).toBe(PATHWAY_MODES.OFF);
    expect(normalizePathwayMode(' SHADOW ')).toBe(PATHWAY_MODES.SHADOW);
    expect(normalizePathwayMode('ACTIVE')).toBe(PATHWAY_MODES.ACTIVE);
    expect(normalizePathwayMode('enforce')).toBeNull();
    expect(normalizePathwayMode(true)).toBeNull();
    expect(DEFAULT_PATHWAY_MODE).toBe(PATHWAY_MODES.OFF);
  });

  it.each(['off', 'shadow', 'active'])('reads explicit %s from the nested tenant setting', async (mode) => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_pathways: { [PATHWAY_KEY]: mode } },
    });
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe(mode);
    expect(getTenantByIdMock).toHaveBeenCalledWith(TENANT);
  });

  it('tolerates cache-backed settings represented as a JSON string', async () => {
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: JSON.stringify({ care_pathways: { [PATHWAY_KEY]: 'shadow' } }),
    });
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe('shadow');
  });

  it.each([
    null,
    { id: TENANT, settings: null },
    { id: TENANT, settings: [] },
    { id: TENANT, settings: '{malformed' },
    { id: TENANT, settings: {} },
    { id: TENANT, settings: { care_pathways: null } },
    { id: TENANT, settings: { care_pathways: [] } },
    { id: TENANT, settings: { care_pathways: { [PATHWAY_KEY]: 'enforce' } } },
  ])('fails closed to off for a missing or malformed tenant setting: %p', async (tenant) => {
    getTenantByIdMock.mockResolvedValueOnce(tenant);
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe('off');
  });

  it('fails closed to off on lookup failure', async () => {
    getTenantByIdMock.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe('off');
    expect(loggerDebugMock).toHaveBeenCalledWith(
      'care pathway mode resolve fell back to off',
      expect.objectContaining({ tenantId: TENANT, pathwayKey: PATHWAY_KEY }),
    );
  });

  it('returns off without a tenant lookup for an unknown pathway key', async () => {
    await expect(resolvePathwayMode(TENANT, 'diagnostics')).resolves.toBe('off');
    expect(getTenantByIdMock).not.toHaveBeenCalled();
  });

  it('does not read rollout settings inherited through an object prototype', async () => {
    const settings = Object.create({ care_pathways: { [PATHWAY_KEY]: 'active' } });
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings });
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe('off');
  });

  it('does not execute rollout-setting accessors', async () => {
    const activeGetter = jest.fn(() => 'active');
    const carePathways = {};
    Object.defineProperty(carePathways, PATHWAY_KEY, { enumerable: true, get: activeGetter });
    getTenantByIdMock.mockResolvedValueOnce({
      id: TENANT,
      settings: { care_pathways: carePathways },
    });
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe('off');
    expect(activeGetter).not.toHaveBeenCalled();
  });

  it('requires tenant context before resolving even an unknown pathway key', async () => {
    await expect(resolvePathwayMode(null, 'diagnostics')).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_REQUIRED',
    });
    expect(getTenantByIdMock).not.toHaveBeenCalled();
  });

  it('has no environment-wide active override', async () => {
    process.env.CARE_PATHWAYS_MODE = 'active';
    process.env.CARE_PATHWAY_MODE = 'active';
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolvePathwayMode(TENANT, PATHWAY_KEY)).resolves.toBe('off');
  });
});
