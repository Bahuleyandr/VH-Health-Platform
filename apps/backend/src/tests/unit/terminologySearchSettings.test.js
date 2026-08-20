// WP1 — settings-aware diagnosis search (searchDiagnosisConcepts) and its
// pure system resolver. Prisma, WHO client, and the settings service are all
// mocked; no DB.

import { jest } from '@jest/globals';

let tenantSettings;
let localRowsBySystem;
let failingSystems;

const localRowFor = (systemKey, i = 0) => ({
  system_key: systemKey,
  code: `${systemKey}-CODE-${i}`,
  display: `${systemKey} synthetic display ${i}`,
  category: null,
  semantic_tag: null,
  status: 'active',
  match_rank: i,
});

const queryRawUnsafeMock = jest.fn(async (sql, ...params) => {
  const text = String(sql);
  if (text.includes('SELECT concept_count FROM terminology_code_systems')) {
    return [{ concept_count: 0 }];
  }
  if (text.includes('FROM terminology_concepts') && text.includes('ORDER BY match_rank')) {
    const systemKey = params[0];
    if (failingSystems.has(systemKey)) {
      throw new Error(`synthetic ${systemKey} failure`);
    }
    return localRowsBySystem[systemKey] || [];
  }
  return [];
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock, $executeRawUnsafe: jest.fn(async () => ({})) },
  prismaReadOnly: { $queryRawUnsafe: queryRawUnsafeMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/hl7/loincValidator.js', () => ({
  isValidStructure: jest.fn(() => true),
}));

// WHO client unconfigured so ICD11 searches stay on the local path.
jest.unstable_mockModule('../../services/terminology/whoIcdClient.js', () => ({
  default: {
    isConfigured: jest.fn(() => false),
    searchIcd11: jest.fn(),
    lookupIcd11Code: jest.fn(),
  },
}));

const getSettingsMock = jest.fn(async () => tenantSettings);
jest.unstable_mockModule('../../services/terminology/terminologySettingsService.js', () => ({
  getTenantTerminologySettings: getSettingsMock,
  isTerminologySystemEnabledForTenant: jest.fn(
    async (tenantId, system) => tenantSettings.enabled_systems.includes(system),
  ),
}));

const {
  DIAGNOSIS_SEARCH_SYSTEMS,
  resolveDiagnosisSearchSystems,
  searchDiagnosisConcepts,
} = await import('../../services/terminology/terminologyService.js');

beforeEach(() => {
  jest.clearAllMocks();
  failingSystems = new Set();
  tenantSettings = {
    tenant_id: '00000000-0000-4000-8000-000000000001',
    preferred_diagnosis_system: 'ICD11',
    enabled_systems: ['ICD10', 'ICD11', 'SNOMED_CT', 'LOINC', 'ATC'],
    snomed_pickers_enabled: false,
    is_default: true,
  };
  localRowsBySystem = {
    ICD11: [localRowFor('ICD11', 0), localRowFor('ICD11', 1)],
    ICD10: [localRowFor('ICD10', 0)],
    SNOMED_CT: [localRowFor('SNOMED_CT', 0)],
  };
});

describe('resolveDiagnosisSearchSystems (pure)', () => {
  test('defaults: ICD11 preferred, SNOMED excluded while the dark flag is off', () => {
    expect(resolveDiagnosisSearchSystems(tenantSettings)).toEqual(['ICD11', 'ICD10']);
  });

  test('snomed_pickers_enabled=true adds SNOMED_CT after the preferred system', () => {
    tenantSettings.snomed_pickers_enabled = true;
    expect(resolveDiagnosisSearchSystems(tenantSettings)).toEqual(['ICD11', 'ICD10', 'SNOMED_CT']);
  });

  test('preferred system moves to the front', () => {
    tenantSettings.preferred_diagnosis_system = 'ICD10';
    expect(resolveDiagnosisSearchSystems(tenantSettings)).toEqual(['ICD10', 'ICD11']);
  });

  test('enabled_systems filters the candidate list', () => {
    tenantSettings.enabled_systems = ['ICD11'];
    expect(resolveDiagnosisSearchSystems(tenantSettings)).toEqual(['ICD11']);
  });

  test('SNOMED preferred but dark flag off falls back to default order', () => {
    tenantSettings.preferred_diagnosis_system = 'SNOMED_CT';
    expect(resolveDiagnosisSearchSystems(tenantSettings)).toEqual(['ICD11', 'ICD10']);
  });

  test('LOINC/ATC never join the diagnosis fan-out', () => {
    expect(DIAGNOSIS_SEARCH_SYSTEMS).toEqual(['ICD11', 'ICD10', 'SNOMED_CT']);
    expect(resolveDiagnosisSearchSystems({
      preferred_diagnosis_system: 'ICD11',
      enabled_systems: ['LOINC', 'ATC'],
      snomed_pickers_enabled: true,
    })).toEqual([]);
  });
});

describe('searchDiagnosisConcepts (frozen WP1 contract)', () => {
  test('default settings: ICD11 group first, then ICD10; no SNOMED; contract shape', async () => {
    const result = await searchDiagnosisConcepts({ tenantId: 'tenant-a', q: 'synthetic', limit: 10 });

    expect(result.query).toBe('synthetic');
    expect(result.resolved).toEqual({
      preferred_system: 'ICD11',
      systems: ['ICD11', 'ICD10'],
      snomed_included: false,
    });
    expect(result.concepts.map((c) => c.system_key)).toEqual(['ICD11', 'ICD11', 'ICD10']);
    // Every row carries the full frozen row shape.
    for (const concept of result.concepts) {
      expect(Object.keys(concept).sort()).toEqual(
        ['category', 'code', 'display', 'match_rank', 'semantic_tag', 'status', 'system_key'],
      );
    }
  });

  test('snomed flag on: SNOMED_CT rows join the fan-out, flagged in resolved', async () => {
    tenantSettings.snomed_pickers_enabled = true;

    const result = await searchDiagnosisConcepts({ tenantId: 'tenant-a', q: 'synthetic', limit: 10 });

    expect(result.resolved.systems).toEqual(['ICD11', 'ICD10', 'SNOMED_CT']);
    expect(result.resolved.snomed_included).toBe(true);
    expect(result.concepts.map((c) => c.system_key)).toEqual(['ICD11', 'ICD11', 'ICD10', 'SNOMED_CT']);
  });

  test('preferred ICD10 puts ICD10 rows first', async () => {
    tenantSettings.preferred_diagnosis_system = 'ICD10';

    const result = await searchDiagnosisConcepts({ tenantId: 'tenant-a', q: 'synthetic', limit: 10 });

    expect(result.resolved.systems).toEqual(['ICD10', 'ICD11']);
    expect(result.concepts[0].system_key).toBe('ICD10');
  });

  test('a failing secondary system is fail-open: other groups still return', async () => {
    failingSystems.add('ICD10');

    const result = await searchDiagnosisConcepts({ tenantId: 'tenant-a', q: 'synthetic', limit: 10 });

    expect(result.resolved.systems).toEqual(['ICD11', 'ICD10']);
    expect(result.concepts.map((c) => c.system_key)).toEqual(['ICD11', 'ICD11']);
  });

  test('nothing imported: empty concepts (client degrades to free text), no throw', async () => {
    localRowsBySystem = {};

    const result = await searchDiagnosisConcepts({ tenantId: 'tenant-a', q: 'synthetic', limit: 10 });

    expect(result.concepts).toEqual([]);
    expect(result.resolved.systems).toEqual(['ICD11', 'ICD10']);
  });

  test('query under 2 chars throws TERMINOLOGY_QUERY_TOO_SHORT before any lookup', async () => {
    await expect(searchDiagnosisConcepts({ tenantId: 'tenant-a', q: 'x', limit: 10 }))
      .rejects.toMatchObject({ code: 'TERMINOLOGY_QUERY_TOO_SHORT', statusCode: 400 });
    expect(getSettingsMock).not.toHaveBeenCalled();
  });
});
