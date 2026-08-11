import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const queryRaw = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: (...args) => queryRawUnsafe(...args),
    $queryRaw: (...args) => queryRaw(...args),
  },
  setTenantTx: async (_tenantId, fn) => fn({
    $queryRawUnsafe: (...args) => queryRawUnsafe(...args),
  }),
  setTenant: async (_tenantId, fn) => fn({
    $queryRawUnsafe: (...args) => queryRawUnsafe(...args),
  }),
  isTenantTransactionClient: () => true,
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
  getTenantById: jest.fn().mockResolvedValue({ settings: {} }),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { listAmbientEncounters } = await import('../../services/ai/ambientDocumentationService.js');
const { listCanaryRuns } = await import('../../services/ai/driftCanaryService.js');
const { listChargeCaptureAudits } = await import('../../services/ai/operationalAiService.js');
const { listExperiments } = await import('../../services/ai/promptExperimentService.js');
const { generateRoster, listRosterRuns } = await import('../../services/ai/rosterOptimizerService.js');
const { listTrialMatches } = await import('../../services/ai/trialMatcherService.js');
const { listLabAutoverifications } = await import('../../services/ai/labAutoverificationService.js');
const { getPharmacyAnalytics } = await import('../../services/pharmacy/analyticsService.js');
const { getStaffShift } = await import('../../services/staff/shiftService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

describe('authoritative decision-support queries', () => {
  beforeEach(() => {
    queryRawUnsafe.mockReset();
    queryRaw.mockReset();
  });

  test.each([
    ['ambient encounter list', () => listAmbientEncounters({ tenantId: TENANT })],
    ['canary run list', () => listCanaryRuns({ tenantId: TENANT })],
    ['charge-capture audit list', () => listChargeCaptureAudits({ tenantId: TENANT })],
    ['prompt experiment list', () => listExperiments({ tenantId: TENANT })],
    ['roster run list', () => listRosterRuns({ tenantId: TENANT })],
    ['trial-match list', () => listTrialMatches({ tenantId: TENANT })],
    ['lab autoverification list', () => listLabAutoverifications({ tenantId: TENANT })],
  ])('%s propagates database faults instead of returning an empty success', async (_label, invoke) => {
    const fault = new Error('authoritative query unavailable');
    queryRawUnsafe.mockRejectedValueOnce(fault);

    await expect(invoke()).rejects.toBe(fault);
  });

  it('pharmacy analytics propagates a popular-category query fault', async () => {
    const fault = new Error('medication categories unavailable');
    queryRaw
      .mockResolvedValueOnce([{ total_orders: 1 }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(fault);

    await expect(getPharmacyAnalytics()).rejects.toBe(fault);
  });

  it('lab autoverification does not report an empty list when its schema is missing', async () => {
    const fault = new Error('relation "clinical_ai_lab_autoverifications" does not exist');
    queryRawUnsafe.mockRejectedValueOnce(fault);

    await expect(listLabAutoverifications({ tenantId: TENANT })).rejects.toBe(fault);
  });

  it('staff shift lookup propagates UUID-resolution faults', async () => {
    const fault = new Error('staff roster database unavailable');
    queryRawUnsafe.mockRejectedValueOnce(fault);

    await expect(getStaffShift('11111111-1111-4111-8111-111111111111')).rejects.toBe(fault);
  });

  it('roster generation propagates historical-demand faults from the tenant-scoped assignment query', async () => {
    const fault = new Error('shift history unavailable');
    queryRawUnsafe.mockRejectedValueOnce(fault);

    await expect(generateRoster({
      req: { tenantId: TENANT, user: { uid: '22222222-2222-4222-8222-222222222222' } },
      department: 'emergency',
      startDate: '2026-08-17',
      endDate: '2026-08-18',
    })).rejects.toBe(fault);

    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('JOIN staff_shift_assignments');
    expect(sql).toContain('JOIN staff_shifts');
    expect(sql).toContain('ssa.tenant_id = $1::uuid');
    expect(params).toEqual([TENANT, 'emergency']);
  });

  it('roster generation never retries a failed tenant-scoped staff query without tenant filters', async () => {
    const fault = new Error('staff pool unavailable');
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(fault);

    await expect(generateRoster({
      req: { tenantId: TENANT, user: { uid: '22222222-2222-4222-8222-222222222222' } },
      department: 'emergency',
      startDate: '2026-08-17',
      endDate: '2026-08-18',
    })).rejects.toBe(fault);

    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [staffSql, ...staffParams] = queryRawUnsafe.mock.calls[1];
    expect(staffSql).toContain('s.tenant_id = $1::uuid');
    expect(staffParams).toEqual([TENANT, 'emergency']);
  });
});
