// WP4 — deterministic formulary→drug-KB resolution (migration 722).
// Prisma-mocked: tier precedence (explicit link → ATC binding → composition →
// null/substring fallback), the double gate (env AND tenant setting, both
// default off ⇒ zero DB traffic), fail-open on DB errors, and the coverage
// report tier accounting.
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const getDrugKbSettingsMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getDrugKbSettings: getDrugKbSettingsMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: loggerWarnMock, error: jest.fn(), debug: jest.fn(),
  },
}));

const {
  resolveDrugKeys,
  coverageReport,
  isDrugKbDeterministicEnvEnabled,
  __resetDrugKbLinkCache,
} = await import('../../services/clinical/drugKbLinkService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

const MONOGRAPHS = [
  { drug_key: 'warfarin', atc_code: 'B01AA03', aliases: ['warf'] },
  { drug_key: 'ibuprofen', atc_code: 'M01AE01', aliases: ['brufen', 'combiflam'] },
  { drug_key: 'paracetamol', atc_code: 'N02BE01', aliases: ['crocin', 'acetaminophen'] },
];

function dispatchResolveQueries({ links = [], atc = [], compositions = [] } = {}) {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (/FROM drug_kb_catalog_links/.test(sql)) return links;
    if (/FROM drug_kb_monographs m/.test(sql)) return MONOGRAPHS;
    if (/FROM terminology_catalog_bindings/.test(sql)) return atc;
    if (/JOIN drug_compositions/.test(sql)) return compositions;
    throw new Error(`unexpected SQL in test: ${sql.slice(0, 80)}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetDrugKbLinkCache();
  delete process.env.DRUG_KB_DETERMINISTIC_MATCHING;
  getDrugKbSettingsMock.mockResolvedValue({ deterministicMatching: true, counterSaleAdvisory: false });
});

afterAll(() => {
  delete process.env.DRUG_KB_DETERMINISTIC_MATCHING;
});

describe('gating (dark by default)', () => {
  test('env unset → disabled, no settings read, zero DB traffic', async () => {
    const result = await resolveDrugKeys({ tenantId: TENANT, medications: [{ name: 'x', catalog_id: 1 }] });
    expect(result).toEqual({ enabled: false, resolutions: null });
    expect(isDrugKbDeterministicEnvEnabled()).toBe(false);
    expect(getDrugKbSettingsMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('env=false → disabled', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'false';
    const result = await resolveDrugKeys({ tenantId: TENANT, medications: [{ name: 'x', catalog_id: 1 }] });
    expect(result).toEqual({ enabled: false, resolutions: null });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('env on but tenant setting off → disabled, zero DB traffic', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    getDrugKbSettingsMock.mockResolvedValue({ deterministicMatching: false, counterSaleAdvisory: false });
    const result = await resolveDrugKeys({ tenantId: TENANT, medications: [{ name: 'x', catalog_id: 1 }] });
    expect(result).toEqual({ enabled: false, resolutions: null });
    expect(getDrugKbSettingsMock).toHaveBeenCalledWith(TENANT);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  test('no tenantId or empty meds → disabled without touching anything', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    expect(await resolveDrugKeys({ medications: [{ name: 'x' }] }))
      .toEqual({ enabled: false, resolutions: null });
    expect(await resolveDrugKeys({ tenantId: TENANT, medications: [] }))
      .toEqual({ enabled: false, resolutions: null });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('tier precedence', () => {
  beforeEach(() => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
  });

  test('explicit link beats ATC beats composition; unresolvable med → null', async () => {
    dispatchResolveQueries({
      // catalog 1 has BOTH an explicit link and an ATC binding — link wins.
      links: [{ pharmacy_catalog_id: 1, drug_key: 'warfarin', link_source: 'vendor_import', confidence: '0.990' }],
      atc: [
        { catalog_id: 1, atc_code: 'M01AE01' },
        { catalog_id: 2, atc_code: 'M01AE01' },
      ],
      compositions: [
        { catalog_id: 2, active_ingredients: ['Paracetamol'] }, // shadowed by ATC
        { catalog_id: 3, active_ingredients: ['Ibuprofen', 'Paracetamol'] },
      ],
    });
    const meds = [
      { name: 'Brand A', catalog_id: 1 },
      { name: 'Brand B', catalog_id: 2 },
      { name: 'Brand C', catalog_id: 3 },
      { name: 'Free-text med' }, // no catalog id → substring fallback
      { name: 'Brand D', catalog_id: 99 }, // catalog id with no resolution
    ];
    const result = await resolveDrugKeys({ tenantId: TENANT, medications: meds });
    expect(result.enabled).toBe(true);
    expect(result.resolutions).toHaveLength(5);
    expect(result.resolutions[0]).toEqual({ catalog_id: 1, drug_keys: ['warfarin'], tier: 'explicit_link' });
    expect(result.resolutions[1]).toEqual({ catalog_id: 2, drug_keys: ['ibuprofen'], tier: 'atc' });
    expect(result.resolutions[2].tier).toBe('composition');
    expect(result.resolutions[2].drug_keys.sort()).toEqual(['ibuprofen', 'paracetamol']);
    expect(result.resolutions[3]).toBeNull();
    expect(result.resolutions[4]).toBeNull();
  });

  test('composition ingredients match monograph aliases (normalized)', async () => {
    dispatchResolveQueries({
      compositions: [{ catalog_id: 7, active_ingredients: ['  CROCIN '] }],
    });
    const result = await resolveDrugKeys({
      tenantId: TENANT,
      medications: [{ name: 'Some brand', catalog_id: 7 }],
    });
    expect(result.resolutions[0]).toEqual({ catalog_id: 7, drug_keys: ['paracetamol'], tier: 'composition' });
  });

  test('rejected/retired links are filtered by the query predicate (SQL contract)', async () => {
    dispatchResolveQueries({});
    await resolveDrugKeys({ tenantId: TENANT, medications: [{ name: 'x', catalog_id: 1 }] });
    const linkSql = queryRawUnsafeMock.mock.calls
      .map((c) => c[0])
      .find((sql) => /FROM drug_kb_catalog_links/.test(sql));
    expect(linkSql).toMatch(/is_active/);
    expect(linkSql).toMatch(/review_status NOT IN \('rejected', 'retired'\)/);
  });
});

describe('strict transaction-pinned resolution', () => {
  test('uses the supplied transaction and bypasses optional feature gates', async () => {
    dispatchResolveQueries({
      links: [{ pharmacy_catalog_id: 1, drug_key: 'warfarin' }],
    });
    const db = { $queryRawUnsafe: queryRawUnsafeMock };

    const result = await resolveDrugKeys({
      tenantId: TENANT,
      medications: [{ name: 'Brand A', catalog_id: 1 }],
      db,
      strict: true,
    });

    expect(result.resolutions).toEqual([
      expect.objectContaining({ catalog_id: 1, drug_keys: ['warfarin'], tier: 'explicit_link' }),
    ]);
    expect(getDrugKbSettingsMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalled();
  });

  test('throws instead of falling back to text for an unresolved catalog identity', async () => {
    dispatchResolveQueries();

    await expect(resolveDrugKeys({
      tenantId: TENANT,
      medications: [{ name: 'Unlinked Brand', catalog_id: 99 }],
      db: { $queryRawUnsafe: queryRawUnsafeMock },
      strict: true,
    })).rejects.toMatchObject({ code: 'DRUG_KB_IDENTITY_UNRESOLVED' });
  });

  test('rejects an explicit link whose key is absent from the active KB revision', async () => {
    dispatchResolveQueries({
      links: [{ pharmacy_catalog_id: 1, drug_key: 'inactive_vendor_key' }],
    });

    await expect(resolveDrugKeys({
      tenantId: TENANT,
      medications: [{ name: 'Brand A', catalog_id: 1 }],
      db: { $queryRawUnsafe: queryRawUnsafeMock },
      strict: true,
    })).rejects.toMatchObject({ code: 'DRUG_KB_IDENTITY_UNRESOLVED' });
  });
});

describe('fail-open posture', () => {
  test('DB error → disabled result, warn logged, never throws', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    queryRawUnsafeMock.mockRejectedValue(new Error('connection refused'));
    const result = await resolveDrugKeys({ tenantId: TENANT, medications: [{ name: 'x', catalog_id: 1 }] });
    expect(result).toEqual({ enabled: false, resolutions: null });
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  test('missing table (un-migrated env, 42P01) → disabled result, never throws', async () => {
    process.env.DRUG_KB_DETERMINISTIC_MATCHING = 'true';
    const err = new Error('relation "drug_kb_catalog_links" does not exist');
    err.code = '42P01';
    queryRawUnsafeMock.mockRejectedValue(err);
    const result = await resolveDrugKeys({ tenantId: TENANT, medications: [{ name: 'x', catalog_id: 1 }] });
    expect(result).toEqual({ enabled: false, resolutions: null });
  });
});

describe('coverageReport', () => {
  test('counts each catalog item once at its highest tier', async () => {
    getDrugKbSettingsMock.mockResolvedValue({ deterministicMatching: false, counterSaleAdvisory: false });
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/FROM pharmacy_catalog\s+WHERE tenant_id/.test(sql.replace(/\n/g, ' '))) {
        return [
          { id: 1, name: 'Warf 5', generic_name: null, composition_id: null }, // explicit
          { id: 2, name: 'Brand X', generic_name: null, composition_id: null }, // atc
          { id: 3, name: 'Brand Y', generic_name: null, composition_id: 9 }, // composition
          { id: 4, name: 'Crocin 650', generic_name: 'paracetamol', composition_id: null }, // text
          { id: 5, name: 'Ayurvedic tonic', generic_name: null, composition_id: null }, // unmatched
        ];
      }
      if (/FROM drug_kb_catalog_links/.test(sql)) return [{ catalog_id: 1 }];
      if (/FROM terminology_catalog_bindings/.test(sql)) return [{ catalog_id: 2 }];
      if (/JOIN drug_compositions/.test(sql)) return [{ catalog_id: 3, active_ingredients: ['ibuprofen'] }];
      if (/FROM drug_kb_monographs m/.test(sql)) return MONOGRAPHS;
      throw new Error(`unexpected SQL in coverage test: ${sql.slice(0, 80)}`);
    });
    const report = await coverageReport({ tenantId: TENANT });
    expect(report.kb_available).toBe(true);
    expect(report.total_active_catalog_items).toBe(5);
    expect(report.resolved).toEqual({
      explicit_link: 1, atc_binding: 1, composition: 1, text_fallback: 1,
    });
    expect(report.unmatched).toBe(1);
    expect(report.deterministic_pct).toBe(60);
    expect(report.any_pct).toBe(80);
    expect(report.deterministic_matching).toEqual({
      env_enabled: false, tenant_enabled: false, effective: false,
    });
  });

  test('never throws: DB failure yields the zeroed report', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('boom'));
    const report = await coverageReport({ tenantId: TENANT });
    expect(report.kb_available).toBe(false);
    expect(report.total_active_catalog_items).toBe(0);
    expect(loggerWarnMock).toHaveBeenCalled();
  });

  test('no tenant → empty report without DB traffic', async () => {
    const report = await coverageReport({});
    expect(report.kb_available).toBe(false);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});
