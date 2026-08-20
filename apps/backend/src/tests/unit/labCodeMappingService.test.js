// src/tests/unit/labCodeMappingService.test.js
//
// Terminology WP3 (migration 721) — analyzer-code → catalog/LOINC mapping
// service. Prisma-mocked: covers CRUD validation, the resolver TTL cache,
// and the fail-open + double-gated (env AND tenant) ingest enrichment.

import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const getLabLoincMappingSettings = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
  prismaReadOnly: { $queryRawUnsafe: jest.fn() },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getLabLoincMappingSettings,
  getTenantSettings: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const service = await import('../../services/lab/labCodeMappingService.js');
const { AppError } = await import('../../utils/AppError.js');

const TENANT = '11111111-2222-4333-8444-555555555555';

const MAPPING_ROW = {
  id: 7n,
  tenant_id: TENANT,
  source_key: 'any',
  incoming_code: 'K',
  incoming_code_system: null,
  catalog_id: null,
  loinc_code: '2823-3',
  display: 'Potassium',
  active: true,
  verified_by: null,
  verified_at: null,
  created_by: null,
  created_at: new Date('2026-08-20T00:00:00Z'),
  updated_at: new Date('2026-08-20T00:00:00Z'),
};

beforeEach(() => {
  queryRawUnsafe.mockReset();
  getLabLoincMappingSettings.mockReset();
  service._invalidateLabCodeMappingCache();
  delete process.env.LAB_LOINC_MAPPING_ENABLED;
});

afterAll(() => {
  delete process.env.LAB_LOINC_MAPPING_ENABLED;
});

describe('createMapping validation', () => {
  it('rejects a missing incoming_code before any SQL runs', async () => {
    await expect(service.createMapping({ tenantId: TENANT, mapping: {} }))
      .rejects.toMatchObject({ statusCode: 400, code: 'LAB_CODE_MAPPING_CODE_REQUIRED' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a structurally invalid loinc_code', async () => {
    await expect(service.createMapping({
      tenantId: TENANT,
      mapping: { incoming_code: 'K', loinc_code: 'NOT-A-LOINC' },
    })).rejects.toMatchObject({ statusCode: 400, code: 'LAB_CODE_MAPPING_LOINC_INVALID' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a mapping with neither catalog_id nor loinc_code', async () => {
    await expect(service.createMapping({
      tenantId: TENANT,
      mapping: { incoming_code: 'K' },
    })).rejects.toMatchObject({ statusCode: 400, code: 'LAB_CODE_MAPPING_TARGET_REQUIRED' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('requires a tenant context (fail closed)', async () => {
    await expect(service.createMapping({
      mapping: { incoming_code: 'K', loinc_code: '2823-3' },
    })).rejects.toMatchObject({ statusCode: 403, code: 'TENANT_CONTEXT_REQUIRED' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('inserts with the tenant predicate and defaults source_key to any', async () => {
    queryRawUnsafe.mockResolvedValueOnce([MAPPING_ROW]);
    const created = await service.createMapping({
      tenantId: TENANT,
      actorUid: 'curator-uid',
      mapping: { incoming_code: 'K', loinc_code: '2823-3', display: 'Potassium' },
    });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, tenantArg, sourceKeyArg, codeArg] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO lab_analyzer_code_mappings');
    expect(tenantArg).toBe(TENANT);
    expect(sourceKeyArg).toBe('any');
    expect(codeArg).toBe('K');
    expect(created).toMatchObject({ id: 7, loinc_code: '2823-3', active: true });
  });

  it('translates the live-unique violation into a 409', async () => {
    queryRawUnsafe.mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint "ux_lab_analyzer_code_mappings_live"'), { code: '23505' }),
    );
    await expect(service.createMapping({
      tenantId: TENANT,
      mapping: { incoming_code: 'K', loinc_code: '2823-3' },
    })).rejects.toMatchObject({ statusCode: 409, code: 'LAB_CODE_MAPPING_DUPLICATE' });
  });
});

describe('updateMapping', () => {
  it('rejects an empty patch', async () => {
    await expect(service.updateMapping({ tenantId: TENANT, id: 7, patch: {} }))
      .rejects.toMatchObject({ statusCode: 400, code: 'LAB_CODE_MAPPING_EMPTY_PATCH' });
  });

  it('404s when the row is not in the tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(service.updateMapping({
      tenantId: TENANT, id: 7, patch: { display: 'x' },
    })).rejects.toMatchObject({ statusCode: 404, code: 'LAB_CODE_MAPPING_NOT_FOUND' });
    const [sql, tenantArg, idArg] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid AND id = $2::bigint');
    expect(tenantArg).toBe(TENANT);
    expect(idArg).toBe(7);
  });

  it('deactivateMapping updates active = false', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ ...MAPPING_ROW, active: false }]);
    const updated = await service.deactivateMapping({ tenantId: TENANT, id: 7 });
    expect(updated.active).toBe(false);
    const [sql] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('active = $3::boolean');
  });

  it('maps the target CHECK violation to a 400', async () => {
    queryRawUnsafe.mockRejectedValueOnce(
      Object.assign(new Error('violates check constraint "chk_lab_analyzer_code_mappings_target"'), { code: '23514' }),
    );
    await expect(service.updateMapping({
      tenantId: TENANT, id: 7, patch: { loinc_code: null },
    })).rejects.toMatchObject({ statusCode: 400, code: 'LAB_CODE_MAPPING_TARGET_REQUIRED' });
  });
});

describe('resolver cache', () => {
  const resolverRows = [
    {
      id: 1n, source_key: 'any', incoming_code: 'K', catalog_id: null,
      loinc_code: '2823-3', display: null, catalog_loinc_code: null,
    },
    {
      id: 2n, source_key: 'SYSMEX-1', incoming_code: 'K', catalog_id: 42n,
      loinc_code: null, display: null, catalog_loinc_code: '6298-4',
    },
  ];

  it('loads once per (tenant, source) inside the TTL and again after invalidation', async () => {
    queryRawUnsafe.mockResolvedValue(resolverRows);
    const first = await service.buildLoincResolver({ tenantId: TENANT, sourceKey: 'SYSMEX-1' });
    const second = await service.buildLoincResolver({ tenantId: TENANT, sourceKey: 'SYSMEX-1' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(first('k')).toBeTruthy();
    expect(second('K')).toBeTruthy();

    service._invalidateLabCodeMappingCache();
    await service.buildLoincResolver({ tenantId: TENANT, sourceKey: 'SYSMEX-1' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('prefers the source-specific row over the any wildcard and falls back to the catalog LOINC binding', async () => {
    queryRawUnsafe.mockResolvedValueOnce(resolverRows);
    const hit = await service.resolveLoincForResult({
      tenantId: TENANT, sourceKey: 'SYSMEX-1', testCode: ' k ',
    });
    // Row 2 (source-specific) wins; its own loinc_code is null so the
    // confirmed catalog binding supplies the code.
    expect(hit).toMatchObject({ mapping_id: 2, catalog_id: 42, loinc_code: '6298-4' });
  });

  it('returns null on a miss', async () => {
    queryRawUnsafe.mockResolvedValueOnce(resolverRows);
    const miss = await service.resolveLoincForResult({
      tenantId: TENANT, sourceKey: 'SYSMEX-1', testCode: 'NA',
    });
    expect(miss).toBeNull();
  });
});

describe('applyLoincMappingEnrichment gating (env AND tenant, fail-open)', () => {
  const rowsFixture = () => ([
    { testCode: 'K', loincCode: null },
    { testCode: 'GLU', loincCode: null },
    { testCode: 'HB', loincCode: '718-7' },
  ]);

  it('is a byte-identical no-op when the env kill switch is off', async () => {
    const rows = rowsFixture();
    const out = await service.applyLoincMappingEnrichment({
      tenantId: TENANT, sourceKey: 'A', rows,
    });
    expect(out).toEqual({ enriched: 0, unmapped: [] });
    expect(rows).toEqual(rowsFixture());
    expect(queryRawUnsafe).not.toHaveBeenCalled();
    expect(getLabLoincMappingSettings).not.toHaveBeenCalled();
  });

  it('is a no-op when env is on but the tenant flag is off', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockResolvedValueOnce({ enabled: false });
    const rows = rowsFixture();
    const out = await service.applyLoincMappingEnrichment({
      tenantId: TENANT, sourceKey: 'A', rows,
    });
    expect(out).toEqual({ enriched: 0, unmapped: [] });
    expect(rows).toEqual(rowsFixture());
    expect(getLabLoincMappingSettings).toHaveBeenCalledWith(TENANT);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('stamps mapping hits, leaves misses untouched, and never overwrites an asserted LOINC', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockResolvedValue({ enabled: true });
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 1n, source_key: 'any', incoming_code: 'K', catalog_id: null,
      loinc_code: '2823-3', display: null, catalog_loinc_code: null,
    }]);
    const rows = rowsFixture();
    const out = await service.applyLoincMappingEnrichment({
      tenantId: TENANT, sourceKey: 'A', rows,
    });
    expect(out.enriched).toBe(1);
    expect(out.unmapped).toEqual(['GLU']);
    expect(rows[0].loincCode).toBe('2823-3'); // mapped hit stamped
    expect(rows[1].loincCode).toBeNull(); // miss = passthrough
    expect(rows[2].loincCode).toBe('718-7'); // analyzer-asserted LOINC kept
  });

  it('supports the ASTM snake_case key contract', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockResolvedValue({ enabled: true });
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 1n, source_key: 'any', incoming_code: 'K', catalog_id: null,
      loinc_code: '2823-3', display: null, catalog_loinc_code: null,
    }]);
    const rows = [{ test_code: 'K' }];
    await service.applyLoincMappingEnrichment({
      tenantId: TENANT, sourceKey: 'A', rows, codeKey: 'test_code', loincKey: 'loinc_code',
    });
    expect(rows[0].loinc_code).toBe('2823-3');
  });

  it('fails open when the resolver query throws — rows stay untouched, nothing propagates', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockResolvedValue({ enabled: true });
    queryRawUnsafe.mockRejectedValueOnce(new Error('db down'));
    const rows = rowsFixture();
    const out = await service.applyLoincMappingEnrichment({
      tenantId: TENANT, sourceKey: 'A', rows,
    });
    expect(out).toMatchObject({ enriched: 0, failed: true });
    expect(rows).toEqual(rowsFixture());
  });

  it('fails open (treats as disabled) when the tenant settings read throws', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockRejectedValueOnce(new Error('settings table missing'));
    const rows = rowsFixture();
    const out = await service.applyLoincMappingEnrichment({
      tenantId: TENANT, sourceKey: 'A', rows,
    });
    expect(out).toEqual({ enriched: 0, unmapped: [] });
    expect(rows).toEqual(rowsFixture());
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('resolveLabLoincMappingGate', () => {
  it('short-circuits without a settings read when env is off', async () => {
    const gate = await service.resolveLabLoincMappingGate(TENANT);
    expect(gate).toEqual({ env: false, tenant: false, effective: false });
    expect(getLabLoincMappingSettings).not.toHaveBeenCalled();
  });

  it('ANDs env and tenant', async () => {
    process.env.LAB_LOINC_MAPPING_ENABLED = 'true';
    getLabLoincMappingSettings.mockResolvedValueOnce({ enabled: true });
    await expect(service.resolveLabLoincMappingGate(TENANT))
      .resolves.toEqual({ env: true, tenant: true, effective: true });
  });
});

describe('coverageReport', () => {
  it('aggregates inbound/mapping/catalog stats with the frozen JSON shape', async () => {
    queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('FROM lab_results')) {
        return [
          { code: 'K', result_count: 10, with_loinc: 4, mapped: true },
          { code: 'GLU', result_count: 6, with_loinc: 0, mapped: false },
        ];
      }
      if (sql.includes('FROM lab_analyzer_code_mappings')) {
        return [{ active: 3, inactive: 1 }];
      }
      if (sql.includes('FROM investigation_test_catalog')) {
        return [{ active_items: 8, loinc_bound: 2 }];
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
    });
    const report = await service.coverageReport({ tenantId: TENANT, days: 14 });
    expect(report).toEqual({
      enabled: { env: false, tenant: false, effective: false },
      window_days: 14,
      inbound: {
        distinct_codes: 2,
        mapped_codes: 1,
        unmapped_codes: 1,
        results_total: 16,
        results_with_loinc: 4,
        top_unmapped: [{ code: 'GLU', result_count: 6 }],
      },
      mappings: { active: 3, inactive: 1 },
      catalog: { active_items: 8, loinc_bound: 2, loinc_bound_pct: 25 },
    });
    // Window is parameterized (make_interval), never string-interpolated.
    const seenCall = queryRawUnsafe.mock.calls.find(([sql]) => sql.includes('FROM lab_results'));
    expect(seenCall[0]).toContain('make_interval(days => $2::int)');
    expect(seenCall[2]).toBe(14);
  });

  it('clamps a nonsense window to the default', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    const report = await service.coverageReport({ tenantId: TENANT, days: 'soon' });
    expect(report.window_days).toBe(30);
  });
});
