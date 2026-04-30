/**
 * Phase B3 — billingMastersService unit tests.
 *
 * Drives validation, default-demotion, and SQL load shape across
 * payers / TPAs / tariff plans + items / packages + items / payer↔
 * tariff links / resolveServicePrice.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  addPackageItem,
  linkPayerTariff,
  listPackageItems,
  listPackages,
  listPayerTariffLinks,
  listPayers,
  listTariffItems,
  listTariffPlans,
  listTpas,
  resolveServicePrice,
  upsertPackage,
  upsertPayer,
  upsertTariffItem,
  upsertTariffPlan,
  upsertTpa,
  __testing__,
} = await import('../../services/billingMasters/billingMastersService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('upsertPayer', () => {
  it('rejects missing payer_code', async () => {
    await expect(upsertPayer({ tenantId: TENANT, displayName: 'Star Health' }))
      .rejects.toThrow(/payer_code is required/);
  });

  it('rejects missing display_name', async () => {
    await expect(upsertPayer({ tenantId: TENANT, payerCode: 'STAR' }))
      .rejects.toThrow(/display_name is required/);
  });

  it('rejects unknown payer_kind', async () => {
    await expect(upsertPayer({
      tenantId: TENANT, payerCode: 'STAR', displayName: 'Star Health', payerKind: 'magic',
    })).rejects.toThrow(/payer_kind must be one of/);
  });

  it('inserts a new payer', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, payer_code: 'STAR', payer_kind: 'private_insurance' }]);
    const row = await upsertPayer({
      tenantId: TENANT, payerCode: 'STAR', displayName: 'Star Health',
    });
    expect(row.id).toBe(1);
  });

  it('updates an existing payer when id provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, payer_code: 'STAR', status: 'paused' }]);
    const row = await upsertPayer({
      tenantId: TENANT, id: 7, payerCode: 'STAR', displayName: 'Star Health', status: 'paused',
    });
    expect(row.status).toBe('paused');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/UPDATE payers/);
  });

  it('throws conflict on duplicate payer_code', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertPayer({
      tenantId: TENANT, payerCode: 'STAR', displayName: 'Star',
    })).rejects.toThrow(/payer_code already exists/);
  });
});

describe('listPayers / listTpas degrade gracefully', () => {
  it('listPayers returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "payers" does not exist'));
    expect(await listPayers({ tenantId: TENANT })).toEqual({ payers: [], count: 0 });
  });

  it('listTpas returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tpas" does not exist'));
    expect(await listTpas({ tenantId: TENANT })).toEqual({ tpas: [], count: 0 });
  });
});

describe('upsertTpa', () => {
  it('rejects missing tpa_code', async () => {
    await expect(upsertTpa({ tenantId: TENANT, displayName: 'Medi Assist' }))
      .rejects.toThrow(/tpa_code is required/);
  });

  it('inserts a TPA optionally linked to parent payer', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, tpa_code: 'MA', parent_payer_id: 7 }]);
    const row = await upsertTpa({
      tenantId: TENANT, tpaCode: 'MA', displayName: 'Medi Assist', parentPayerId: 7,
    });
    expect(row.parent_payer_id).toBe(7);
  });

  it('throws on invalid parent_payer_id (FK)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('insert or update violates foreign key constraint'));
    await expect(upsertTpa({
      tenantId: TENANT, tpaCode: 'MA', displayName: 'Medi Assist', parentPayerId: 999,
    })).rejects.toThrow(/parent_payer_id is invalid/);
  });
});

describe('upsertTariffPlan default-demotion', () => {
  it('demotes other defaults when isDefault=true + status=active', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // demote
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, plan_code: 'X', is_default: true, status: 'active' }]);
    const row = await upsertTariffPlan({
      tenantId: TENANT, planCode: 'X', displayName: 'Default plan', isDefault: true,
    });
    expect(row.is_default).toBe(true);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET is_default = false/);
  });

  it('rejects effective_to before effective_from is fine: handled at DB CHECK; service accepts both null', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await upsertTariffPlan({
      tenantId: TENANT, planCode: 'X', displayName: 'X',
      effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31',
    });
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toContain('2026-01-01');
    expect(params).toContain('2026-12-31');
  });

  it('rejects malformed date', async () => {
    await expect(upsertTariffPlan({
      tenantId: TENANT, planCode: 'X', displayName: 'X', effectiveFrom: '01-01-2026',
    })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('upsertTariffItem', () => {
  it('rejects missing service_code', async () => {
    await expect(upsertTariffItem({
      tenantId: TENANT, tariffPlanId: 1, displayName: 'X', unitPriceMinor: 1000,
    })).rejects.toThrow(/service_code is required/);
  });

  it('rejects missing unit_price_minor', async () => {
    await expect(upsertTariffItem({
      tenantId: TENANT, tariffPlanId: 1, serviceCode: 'X', displayName: 'X',
    })).rejects.toThrow(/unit_price_minor is required/);
  });

  it('rejects tax_rate_pct out of range', async () => {
    await expect(upsertTariffItem({
      tenantId: TENANT, tariffPlanId: 1, serviceCode: 'X',
      displayName: 'X', unitPriceMinor: 1000, taxRatePct: 200,
    })).rejects.toThrow(/tax_rate_pct must be 0..100/);
  });

  it('inserts a service tariff line', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, service_code: 'CONS_GP', unit_price_minor: 50000 }]);
    const row = await upsertTariffItem({
      tenantId: TENANT, tariffPlanId: 1, serviceCode: 'CONS_GP',
      serviceKind: 'consultation', displayName: 'GP consult', unitPriceMinor: 50000,
      taxable: true, taxRatePct: 5,
    });
    expect(row.id).toBe(1);
  });

  it('throws conflict on duplicate (plan, service_code)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(upsertTariffItem({
      tenantId: TENANT, tariffPlanId: 1, serviceCode: 'CONS_GP',
      displayName: 'GP', unitPriceMinor: 1000,
    })).rejects.toThrow(/already exists in this plan/);
  });
});

describe('upsertPackage + addPackageItem', () => {
  it('rejects missing package_code', async () => {
    await expect(upsertPackage({ tenantId: TENANT, displayName: 'Knee replacement' }))
      .rejects.toThrow(/package_code is required/);
  });

  it('inserts a package', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, package_code: 'KNEE_3D' }]);
    const row = await upsertPackage({
      tenantId: TENANT, packageCode: 'KNEE_3D', displayName: 'Knee replacement 3-day',
      durationDays: 3, fixedPriceMinor: 2_500_000,
    });
    expect(row.id).toBe(1);
  });

  it('addPackageItem requires service_code', async () => {
    await expect(addPackageItem({
      tenantId: TENANT, packageId: 1, displayName: 'Implant',
    })).rejects.toThrow(/service_code is required/);
  });

  it('addPackageItem inserts a line item', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, service_code: 'IMP_KNEE' }]);
    const row = await addPackageItem({
      tenantId: TENANT, packageId: 1, serviceCode: 'IMP_KNEE',
      serviceKind: 'consumable', displayName: 'Knee implant', quantity: 1,
    });
    expect(row.id).toBe(1);
  });

  it('addPackageItem throws on invalid package_id (FK)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('insert or update violates foreign key constraint'));
    await expect(addPackageItem({
      tenantId: TENANT, packageId: 999, serviceCode: 'X', displayName: 'X',
    })).rejects.toThrow(/Invalid package_id/);
  });
});

describe('linkPayerTariff + listPayerTariffLinks', () => {
  it('rejects when neither payer_id nor tpa_id', async () => {
    await expect(linkPayerTariff({ tenantId: TENANT, tariffPlanId: 1 }))
      .rejects.toThrow(/payer_id or tpa_id is required/);
  });

  it('inserts a primary link', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, is_primary: true, status: 'active' }]);
    const row = await linkPayerTariff({
      tenantId: TENANT, payerId: 7, tariffPlanId: 1, isPrimary: true,
    });
    expect(row.is_primary).toBe(true);
  });

  it('listPayerTariffLinks degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "payer_tariff_links" does not exist'));
    expect(await listPayerTariffLinks({ tenantId: TENANT })).toEqual({ links: [], count: 0 });
  });
});

describe('resolveServicePrice', () => {
  it('rejects missing service_code', async () => {
    await expect(resolveServicePrice({ tenantId: TENANT }))
      .rejects.toThrow(/service_code is required/);
  });

  it('returns null when no price found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await resolveServicePrice({ tenantId: TENANT, serviceCode: 'CONS_GP' });
    expect(row).toBeNull();
  });

  it('returns matched row with payer + tariff plan info', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      tariff_item_id: 1, tariff_plan_id: 5, service_code: 'CONS_GP',
      service_kind: 'consultation', display_name: 'GP consult',
      unit_price_minor: 50000, plan_code: 'STAR_2026',
      payer_id: 7, tpa_id: null, is_primary: true,
    }]);
    const row = await resolveServicePrice({
      tenantId: TENANT, serviceCode: 'CONS_GP', payerId: 7,
    });
    expect(row.unit_price_minor).toBe(50000);
    expect(row.payer_id).toBe(7);
  });

  it('falls back to is_primary link when no payer/tpa specified', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      tariff_item_id: 1, unit_price_minor: 50000, is_primary: true,
    }]);
    await resolveServicePrice({ tenantId: TENANT, serviceCode: 'CONS_GP' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ptl\.is_primary = true/);
  });

  it('applies as_of date window filter when provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ tariff_item_id: 1, unit_price_minor: 50000 }]);
    await resolveServicePrice({
      tenantId: TENANT, serviceCode: 'CONS_GP', payerId: 7, asOf: '2026-06-01',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/effective_from IS NULL OR ptl\.effective_from <= /);
    expect(sql).toMatch(/effective_to IS NULL OR ptl\.effective_to >= /);
  });

  it('degrades to null on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "payer_tariff_links" does not exist'));
    const row = await resolveServicePrice({
      tenantId: TENANT, serviceCode: 'CONS_GP', payerId: 7,
    });
    expect(row).toBeNull();
  });
});

describe('list helpers degrade on schema-missing', () => {
  it('listTariffPlans / listTariffItems / listPackages / listPackageItems degrade', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tariff_plans" does not exist'));
    expect(await listTariffPlans({ tenantId: TENANT })).toEqual({ plans: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tariff_items" does not exist'));
    expect(await listTariffItems({ tenantId: TENANT, tariffPlanId: 1 })).toEqual({ items: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "packages" does not exist'));
    expect(await listPackages({ tenantId: TENANT })).toEqual({ packages: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "package_items" does not exist'));
    expect(await listPackageItems({ tenantId: TENANT, packageId: 1 })).toEqual({ items: [], count: 0 });
  });
});
