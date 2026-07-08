import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock)
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const {
  ENTITLEMENT_FEATURE_KEYS,
  evaluateEntitlement,
  getTenantEntitlementSummary,
  _resetEntitlementCachesForTests
} = await import('../../services/entitlements/entitlementService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

const featureRows = [
  {
    feature_key: ENTITLEMENT_FEATURE_KEYS.clinicalEmergency,
    display_name: 'Emergency care',
    description: 'Urgent care',
    category: 'clinical',
    enforcement_mode: 'status_only',
    urgent_clinical: true,
    route_patterns: ['/api/v1/sos'],
    nav_surfaces: ['patient.sos'],
    mobile_surface_keys: ['patient.sos'],
    metadata: {}
  },
  {
    feature_key: ENTITLEMENT_FEATURE_KEYS.developerApiClients,
    display_name: 'Developer API clients',
    description: 'API clients',
    category: 'developer',
    enforcement_mode: 'hard_block',
    urgent_clinical: false,
    route_patterns: ['/api/v1/admin/api-clients'],
    nav_surfaces: ['admin.api_clients'],
    mobile_surface_keys: [],
    metadata: {}
  }
];

const packageRows = [
  {
    package_key: 'enterprise',
    display_name: 'Enterprise',
    description: 'Full package',
    package_tier: 'enterprise',
    status: 'active',
    grace_period_days: 30,
    metadata: {}
  }
];

const packageFeatureRows = [
  {
    package_key: 'enterprise',
    feature_key: ENTITLEMENT_FEATURE_KEYS.clinicalEmergency,
    included: true,
    limits: {}
  },
  {
    package_key: 'enterprise',
    feature_key: ENTITLEMENT_FEATURE_KEYS.developerApiClients,
    included: true,
    limits: {}
  }
];

function activeEntitlement(overrides = {}) {
  return {
    id: 1n,
    tenant_id: TENANT,
    package_key: 'enterprise',
    package_display_name: 'Enterprise',
    status: 'active',
    starts_at: new Date('2026-07-01T00:00:00Z'),
    expires_at: null,
    grace_ends_at: null,
    source: 'test',
    assigned_by: null,
    metadata: {},
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides
  };
}

function seedCatalogThenEntitlements(entitlements) {
  queryUnsafeMock
    .mockResolvedValueOnce(featureRows)
    .mockResolvedValueOnce(packageRows)
    .mockResolvedValueOnce(packageFeatureRows)
    .mockResolvedValueOnce(entitlements);
}

describe('entitlementService', () => {
  beforeEach(() => {
    queryUnsafeMock.mockReset();
    executeUnsafeMock.mockReset();
    _resetEntitlementCachesForTests();
  });

  it('allows hard-blocked developer features when an active package includes them', async () => {
    seedCatalogThenEntitlements([activeEntitlement()]);

    const decision = await evaluateEntitlement({
      tenantId: TENANT,
      featureKey: ENTITLEMENT_FEATURE_KEYS.developerApiClients
    });

    expect(decision.allowed).toBe(true);
    expect(decision.hardBlock).toBe(true);
    expect(decision.packageKey).toBe('enterprise');
  });

  it('denies hard-blocked developer features when no package is assigned', async () => {
    seedCatalogThenEntitlements([]);

    const decision = await evaluateEntitlement({
      tenantId: TENANT,
      featureKey: ENTITLEMENT_FEATURE_KEYS.developerApiClients
    });

    expect(decision.allowed).toBe(false);
    expect(decision.hardBlock).toBe(true);
    expect(decision.decision).toBe('deny');
  });

  it('keeps urgent clinical care non-blocking even without package entitlement', async () => {
    seedCatalogThenEntitlements([]);

    const decision = await evaluateEntitlement({
      tenantId: TENANT,
      featureKey: ENTITLEMENT_FEATURE_KEYS.clinicalEmergency,
      urgentClinical: true
    });

    expect(decision.allowed).toBe(true);
    expect(decision.hardBlock).toBe(false);
    expect(decision.decision).toBe('status_only');
  });

  it('treats an expired entitlement inside grace as allowed grace', async () => {
    seedCatalogThenEntitlements([
      activeEntitlement({
        status: 'active',
        expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
        grace_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
      })
    ]);

    const decision = await evaluateEntitlement({
      tenantId: TENANT,
      featureKey: ENTITLEMENT_FEATURE_KEYS.developerApiClients
    });

    expect(decision.allowed).toBe(true);
    expect(decision.status).toBe('grace');
    expect(decision.decision).toBe('grace');
  });

  it('builds nav and mobile visibility from the tenant summary', async () => {
    seedCatalogThenEntitlements([]);

    const summary = await getTenantEntitlementSummary(TENANT);

    expect(summary.nav).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'admin.api_clients',
          visible: false
        })
      ])
    );
    expect(summary.mobile).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'patient.sos',
          visible: true
        })
      ])
    );
  });
});
