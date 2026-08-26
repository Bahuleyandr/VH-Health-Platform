import { jest } from '@jest/globals';

let conceptCount = 0;
let conceptRows = [];
let completedLinkedImport = 'none';

const queryRawUnsafeMock = jest.fn(async (sql) => {
  const text = String(sql);
  if (text.includes('FROM terminology_import_batches b')) {
    return completedLinkedImport === 'full' ? [{ found: 1 }] : [];
  }
  if (text.includes('SELECT concept_count FROM terminology_code_systems')) {
    return [{ concept_count: conceptCount }];
  }
  if (text.includes('FROM terminology_concepts')) {
    return conceptRows;
  }
  return [];
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: jest.fn(),
  },
  prismaReadOnly: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/terminology/whoIcdClient.js', () => ({
  default: {
    isConfigured: jest.fn(() => false),
    searchIcd11: jest.fn(),
    lookupIcd11Code: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/terminology/terminologySettingsService.js', () => ({
  getTenantTerminologySettings: jest.fn(),
  isTerminologySystemEnabledForTenant: jest.fn(async () => true),
}));

const {
  clearImportCompletenessCacheForTests,
  validateCode,
} = await import('../../services/terminology/terminologyService.js');

beforeEach(() => {
  jest.clearAllMocks();
  clearImportCompletenessCacheForTests();
  conceptCount = 12;
  conceptRows = [];
  completedLinkedImport = 'none';
});

describe('terminology concept-import authority', () => {
  test('migration seeds, WHO cache rows, and map-only aggregates stay advisory without linked concept provenance', async () => {
    const verdict = await validateCode('ICD11', 'NOT-IN-PARTIAL-CACHE');

    expect(verdict).toEqual({
      valid: false,
      mode: 'partial',
      reason: 'catalog_import_incomplete',
      concept: null,
    });
    const authorityCall = queryRawUnsafeMock.mock.calls.find(
      ([sql]) => String(sql).includes('FROM terminology_import_batches b'),
    );
    expect(authorityCall).toBeDefined();
    const authoritySql = String(authorityCall[0]);
    expect(authoritySql).toContain('c.last_import_batch_id = b.id');
    expect(authoritySql).toContain('c.last_seen_release IS NOT DISTINCT FROM b.release_label');
    expect(authoritySql).toContain("(b.metadata->>'full')::boolean, false) = true");
    expect(authoritySql).not.toContain('rows_inserted');
  });

  test('a completed linked incremental import remains advisory', async () => {
    completedLinkedImport = 'partial';

    await expect(validateCode('ICD10', 'ZZZ.99')).resolves.toEqual({
      valid: false,
      mode: 'partial',
      reason: 'catalog_import_incomplete',
      concept: null,
    });
  });

  test('a completed full batch backed by a linked imported concept makes a miss authoritative', async () => {
    completedLinkedImport = 'full';

    await expect(validateCode('ICD10', 'ZZZ.99')).resolves.toEqual({
      valid: false,
      mode: 'catalog',
      reason: 'code_not_found',
      concept: null,
    });
  });

  test('LOINC keeps its structural fallback when no linked concept import exists', async () => {
    await expect(validateCode('LOINC', '8480-6')).resolves.toMatchObject({
      valid: true,
      mode: 'structural',
      reason: 'catalog_not_imported_structural_pass',
    });
    await expect(validateCode('LOINC', 'not-a-loinc')).resolves.toMatchObject({
      valid: false,
      mode: 'structural',
      reason: 'invalid_structure',
    });
  });

  test('LOINC catalogue misses become authoritative after a linked full concept import', async () => {
    completedLinkedImport = 'full';

    await expect(validateCode('LOINC', '8480-6')).resolves.toMatchObject({
      valid: false,
      mode: 'catalog',
      reason: 'code_not_found',
    });
  });
});
