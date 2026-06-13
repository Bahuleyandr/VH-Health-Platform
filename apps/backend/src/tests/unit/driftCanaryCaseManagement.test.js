import { jest } from '@jest/globals';

const mockQueryRawUnsafe = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: mockQueryRawUnsafe };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/hallucinationDefenses.js', () => ({
  runOutputDefenses: jest.fn(() => []),
}));

const {
  deactivateCanaryCase,
  listCanaryCases,
  upsertCanaryCase,
} = await import('../../services/ai/driftCanaryService.js');

describe('drift canary case management', () => {
  beforeEach(() => {
    mockQueryRawUnsafe.mockReset();
  });

  it('lists tenant-scoped cases with optional module and active filters', async () => {
    const row = {
      id: 7,
      module_key: 'discharge_summary',
      label: 'sealed pneumonia case',
      input_packet: { chart: {} },
      expected_keys: ['hospital_course'],
      expected_citations_min: 1,
      active: false,
      created_at: '2026-04-22T00:00:00Z',
    };
    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    const result = await listCanaryCases({
      tenantId: 'tenant-1',
      moduleKey: 'discharge_summary',
      active: 'inactive',
      limit: 999,
    });

    expect(result).toEqual({ cases: [row], count: 1 });
    const [sql, ...params] = mockQueryRawUnsafe.mock.calls[0];
    expect(sql).toContain('WHERE tenant_id = $1::uuid AND module_key = $2 AND active = $3');
    expect(sql).toContain('LIMIT $4');
    expect(params).toEqual(['tenant-1', 'discharge_summary', false, 500]);
  });

  it('returns an empty list when canary tables are not migrated yet', async () => {
    mockQueryRawUnsafe.mockRejectedValueOnce(new Error('relation "clinical_ai_canary_cases" does not exist'));

    await expect(listCanaryCases({ tenantId: 'tenant-1' })).resolves.toEqual({ cases: [], count: 0 });
  });

  it('normalizes and saves canary case payloads', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([{
      id: 8,
      module_key: 'patient_record_summary',
      label: 'synthetic stable discharge',
      expected_keys: ['summary', 'blockers'],
      expected_citations_min: 2,
      active: true,
      created_at: '2026-04-22T00:00:00Z',
    }]);

    await upsertCanaryCase({
      tenantId: 'tenant-1',
      moduleKey: ' patient_record_summary ',
      label: ' synthetic stable discharge ',
      inputPacket: { citations: [{ id: 'synthetic-note-1' }] },
      expectedKeys: [' summary ', '', 'blockers'],
      expectedCitationsMin: '2',
    });

    const [, ...params] = mockQueryRawUnsafe.mock.calls[0];
    expect(params[0]).toBe('tenant-1');
    expect(params[1]).toBe('patient_record_summary');
    expect(params[2]).toBe('synthetic stable discharge');
    expect(JSON.parse(params[3])).toEqual({ citations: [{ id: 'synthetic-note-1' }] });
    expect(params[4]).toEqual(['summary', 'blockers']);
    expect(params[5]).toBe(2);
  });

  it('requires canary input packets to be JSON objects', async () => {
    await expect(upsertCanaryCase({
      tenantId: 'tenant-1',
      moduleKey: 'discharge_summary',
      label: 'invalid',
      inputPacket: [],
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled();
  });

  it('deactivates cases without deleting historical rows', async () => {
    const row = {
      id: 9,
      module_key: 'discharge_summary',
      label: 'old case',
      active: false,
    };
    mockQueryRawUnsafe.mockResolvedValueOnce([row]);

    await expect(deactivateCanaryCase({ tenantId: 'tenant-1', id: '9' })).resolves.toBe(row);
    const [sql, ...params] = mockQueryRawUnsafe.mock.calls[0];
    expect(sql).toContain('SET active = false');
    expect(params).toEqual(['tenant-1', 9]);
  });

  it('returns not found when a canary case id is outside the tenant scope', async () => {
    mockQueryRawUnsafe.mockResolvedValueOnce([]);

    await expect(deactivateCanaryCase({ tenantId: 'tenant-1', id: '10' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
