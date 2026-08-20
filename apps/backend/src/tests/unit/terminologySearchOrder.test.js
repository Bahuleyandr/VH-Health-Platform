import { jest } from '@jest/globals';

let conceptCount = 0;
let localRows = [];

const queryRawUnsafeMock = jest.fn(async (sql, ...params) => {
  const text = String(sql);
  if (text.includes('SELECT concept_count FROM terminology_code_systems')) {
    return [{ concept_count: conceptCount }];
  }
  if (text.includes('FROM terminology_concepts') && text.includes('ORDER BY match_rank')) {
    return localRows;
  }
  if (text.includes('INSERT INTO terminology_concepts')) {
    return [{
      system_key: 'ICD11',
      code: params[0],
      display: params[1],
      category: params[2],
      semantic_tag: params[3],
      status: 'active',
      properties: {},
    }];
  }
  return [];
});
const executeRawUnsafeMock = jest.fn(async () => ({}));
const whoSearchMock = jest.fn(async () => [{
  code: 'WHO.NL5',
  display: 'WHO NL5 Result',
  category: 'who',
  semantic_tag: 'disease',
  status: 'active',
  release_id: '2026-01',
  language: 'en',
  source: 'who_icd_api',
}]);
const isConfiguredMock = jest.fn(() => true);
const enabledForTenantMock = jest.fn(async () => true);

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
  },
  prismaReadOnly: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/hl7/loincValidator.js', () => ({
  isValidStructure: jest.fn(() => true),
}));

jest.unstable_mockModule('../../services/terminology/whoIcdClient.js', () => ({
  default: {
    isConfigured: isConfiguredMock,
    searchIcd11: whoSearchMock,
    lookupIcd11Code: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/terminology/terminologySettingsService.js', () => ({
  isTerminologySystemEnabledForTenant: enabledForTenantMock,
  getTenantTerminologySettings: jest.fn(async () => ({
    preferred_diagnosis_system: 'ICD11',
    enabled_systems: ['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC'],
    snomed_pickers_enabled: false,
    is_default: true,
  })),
}));

const {
  ICD11_LOCAL_FIRST_CONCEPT_THRESHOLD,
  searchConcepts,
} = await import('../../services/terminology/terminologyService.js');

beforeEach(() => {
  conceptCount = 0;
  localRows = [];
  jest.clearAllMocks();
  isConfiguredMock.mockReturnValue(true);
  enabledForTenantMock.mockResolvedValue(true);
  whoSearchMock.mockResolvedValue([{
    code: 'WHO.NL5',
    display: 'WHO NL5 Result',
    category: 'who',
    semantic_tag: 'disease',
    status: 'active',
    release_id: '2026-01',
    language: 'en',
    source: 'who_icd_api',
  }]);
});

describe('ICD-11 search ordering', () => {
  test('starter-sized ICD-11 catalog stays WHO-first when WHO is configured', async () => {
    conceptCount = 10;

    const rows = await searchConcepts({ system: 'ICD11', q: 'hypertension', limit: 5, tenantId: 'tenant-a' });

    expect(rows[0]).toMatchObject({ code: 'WHO.NL5', source: 'who_icd_api' });
    expect(whoSearchMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls.some((call) => String(call[0]).includes('ORDER BY match_rank'))).toBe(false);
  });

  test('import-sized ICD-11 catalog searches local rows before WHO', async () => {
    conceptCount = ICD11_LOCAL_FIRST_CONCEPT_THRESHOLD + 1;
    localRows = [{
      system_key: 'ICD11',
      code: 'LOCAL.NL5',
      display: 'Local NL5 Result',
      category: 'local',
      semantic_tag: 'disease',
      status: 'active',
      match_rank: 0,
    }];

    const rows = await searchConcepts({ system: 'ICD11', q: 'hypertension', limit: 5, tenantId: 'tenant-a' });

    expect(rows).toEqual(localRows);
    expect(whoSearchMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock.mock.calls.some((call) => String(call[0]).includes('ORDER BY match_rank'))).toBe(true);
  });

  test('import-sized ICD-11 catalog falls back to WHO after a local miss', async () => {
    conceptCount = ICD11_LOCAL_FIRST_CONCEPT_THRESHOLD + 1;
    localRows = [];

    const rows = await searchConcepts({ system: 'ICD11', q: 'rare term', limit: 5, tenantId: 'tenant-a' });

    expect(rows[0]).toMatchObject({ code: 'WHO.NL5', source: 'who_icd_api' });
    expect(whoSearchMock).toHaveBeenCalledTimes(1);
  });
});
