// Unit tests for the package cost estimator. The package master lookup
// is mocked; the line-item / review-flag logic is the unit under test.
//
// Finding: 2026-05-09-tpa-insurance-claim-admission-no-estimated-cost-package-calculator

import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

const { estimatePackageCost } = await import(
  '../../services/insurance/packagesService.js'
);

const CATARACT = {
  id: 1,
  package_code: 'DC-CATARACT-PHACO',
  display_name: 'Cataract — Phacoemulsification + IOL (day-care)',
  base_specialty: 'ophthalmology',
  duration_days: 1,
  fixed_price_minor: 1500000n,
  currency: 'INR',
  status: 'active',
  inclusion_notes: 'Topical anaesthesia, surgeon fee, OT charges, IOL.',
  exclusion_notes: 'Premium IOL upgrades.',
};

describe('estimatePackageCost', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects when neither package_id nor package_code is supplied', async () => {
    await expect(
      estimatePackageCost({ tenantId: 't' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('throws notFound when the package lookup misses', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(
      estimatePackageCost({ tenantId: 't', package_id: 999 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns a clean priced estimate for an in-bundle stay (no review needed)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([CATARACT]);
    const out = await estimatePackageCost({
      tenantId: 't', package_id: 1, los_days: 1,
    });
    expect(out.line_items).toHaveLength(1);
    expect(out.line_items[0]).toMatchObject({
      kind: 'package_base', amount_minor: 1500000, review_required: false,
    });
    expect(out.estimated_total_minor).toBe(1500000);
    expect(out.estimated_total_is_lower_bound).toBe(false);
    expect(out.review_required).toBe(false);
    expect(out.review_flags).toEqual([]);
  });

  it('emits a review-flagged extended_stay line when los exceeds the bundle', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([CATARACT]);
    const out = await estimatePackageCost({
      tenantId: 't', package_id: 1, los_days: 4,
    });
    const extended = out.line_items.find((l) => l.kind === 'extended_stay');
    expect(extended).toBeTruthy();
    expect(extended.amount_minor).toBeNull();
    expect(extended.review_required).toBe(true);
    expect(extended.note).toMatch(/clinical\/financial review required/i);
    // total still only counts the priced base line, flagged as a lower bound
    expect(out.estimated_total_minor).toBe(1500000);
    expect(out.estimated_total_is_lower_bound).toBe(true);
    expect(out.review_required).toBe(true);
    expect(out.review_flags.join(' ')).toMatch(/Extended stay of 3 day/);
  });

  it('emits a review-flagged room_upgrade line when room is above general ward', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([CATARACT]);
    const out = await estimatePackageCost({
      tenantId: 't', package_id: 1, room_category: 'private',
    });
    const upgrade = out.line_items.find((l) => l.kind === 'room_upgrade');
    expect(upgrade).toBeTruthy();
    expect(upgrade.amount_minor).toBeNull();
    expect(upgrade.review_required).toBe(true);
    expect(out.review_required).toBe(true);
  });

  it('does not emit a room_upgrade line for a general-ward request', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([CATARACT]);
    const out = await estimatePackageCost({
      tenantId: 't', package_id: 1, room_category: 'general',
    });
    expect(out.line_items.find((l) => l.kind === 'room_upgrade')).toBeUndefined();
    expect(out.review_required).toBe(false);
  });

  it('flags the base line for review when the package has no fixed price', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { ...CATARACT, fixed_price_minor: null },
    ]);
    const out = await estimatePackageCost({ tenantId: 't', package_id: 1 });
    expect(out.line_items[0]).toMatchObject({
      kind: 'package_base', amount_minor: null, review_required: true,
    });
    expect(out.estimated_total_minor).toBe(0);
    expect(out.review_required).toBe(true);
  });
});
