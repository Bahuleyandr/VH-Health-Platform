/**
 * Phase E2 — numberingSeriesService unit tests.
 * Covers validation + the format helper + the atomic next-number bump
 * + cadence reset.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  getNextNumber,
  listNumberingSeries,
  upsertNumberingSeries,
  __testing__,
} = await import('../../services/compliance/numberingSeriesService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('applyFormat', () => {
  it('substitutes YYYY/YY/MM/DD/SEQ with padding', () => {
    const out = __testing__.applyFormat('INV-{YYYY}-{SEQ}', 42, 6, new Date('2026-04-30T12:00:00Z'));
    expect(out).toBe('INV-2026-000042');
  });
  it('handles MM/DD/YY', () => {
    const out = __testing__.applyFormat('PO-{YY}{MM}{DD}-{SEQ}', 7, 4, new Date('2026-04-30T00:00:00Z'));
    expect(out).toBe('PO-260430-0007');
  });
  it('honours zero padding', () => {
    expect(__testing__.applyFormat('X-{SEQ}', 7, 0)).toBe('X-7');
  });
});

describe('isResetDue', () => {
  it('never resets when cadence is "never"', () => {
    expect(__testing__.isResetDue('never', '2025-01-01', new Date('2026-04-30'))).toBe(false);
  });
  it('resets yearly when year rolls', () => {
    expect(__testing__.isResetDue('yearly', '2025-12-31', new Date('2026-01-01'))).toBe(true);
  });
  it('does not reset within the same year', () => {
    expect(__testing__.isResetDue('yearly', '2026-01-01', new Date('2026-04-30'))).toBe(false);
  });
  it('resets monthly when month rolls', () => {
    expect(__testing__.isResetDue('monthly', '2026-03-31', new Date('2026-04-01'))).toBe(true);
  });
});

describe('upsertNumberingSeries', () => {
  it('rejects missing code', async () => {
    await expect(upsertNumberingSeries({
      tenantId: TENANT, displayName: 'X', formatTemplate: 'X-{SEQ}',
    })).rejects.toThrow(/code is required/);
  });

  it('rejects missing format_template', async () => {
    await expect(upsertNumberingSeries({
      tenantId: TENANT, code: 'INV', displayName: 'X',
    })).rejects.toThrow(/format_template is required/);
  });

  it('rejects unknown reset_cadence', async () => {
    await expect(upsertNumberingSeries({
      tenantId: TENANT, code: 'INV', displayName: 'X', formatTemplate: 'X',
      resetCadence: 'sometimes',
    })).rejects.toThrow(/reset_cadence must be one of/);
  });

  it('inserts a new series with starting_value seeded into current_value', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, code: 'INV', current_value: 1000, starting_value: 1000 }]);
    const row = await upsertNumberingSeries({
      tenantId: TENANT, code: 'INV', displayName: 'Invoice',
      formatTemplate: 'INV-{YYYY}-{SEQ}', startingValue: 1000, padding: 6,
    });
    expect(row.id).toBe(1);
  });
});

describe('getNextNumber', () => {
  it('throws 404 when series not found or paused', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(getNextNumber({ tenantId: TENANT, code: 'INV' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('atomically bumps current_value and applies the format', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, format_template: 'INV-{YYYY}-{SEQ}', padding: 6,
      reset_cadence: 'never', last_reset_at: null, starting_value: 0, current_value: 41,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ current_value: 42 }]);
    const out = await getNextNumber({
      tenantId: TENANT, code: 'INV', now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(out.sequence).toBe(42);
    expect(out.formatted).toBe('INV-2026-000042');
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/UPDATE numbering_series/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/current_value = current_value \+ 1/);
  });

  it('resets the counter on cadence boundary', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, format_template: 'INV-{YYYY}-{SEQ}', padding: 4,
      reset_cadence: 'yearly', last_reset_at: '2025-12-31', starting_value: 0, current_value: 999,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ current_value: 1 }]);
    const out = await getNextNumber({
      tenantId: TENANT, code: 'INV', now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(out.sequence).toBe(1);
    expect(out.formatted).toBe('INV-2026-0001');
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/last_reset_at = NOW\(\)/);
    expect(updateSql).toMatch(/\$1::bigint \+ 1/);
  });
});

describe('listNumberingSeries', () => {
  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "numbering_series" does not exist'));
    expect(await listNumberingSeries({ tenantId: TENANT })).toEqual({ series: [], count: 0 });
  });
});
