import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

const {
  deriveCycleItemReconciliation,
  applyParReconciliation,
} = await import('../../services/linen/linenLaundryService.js');

describe('linenLaundryService count reconciliation', () => {
  it('flags missing linen when clean return plus damage is lower than soiled collection', () => {
    const result = deriveCycleItemReconciliation({
      soiledCollectedQuantity: 10,
      cleanReturnedQuantity: 8,
      damagedQuantity: 1,
    });

    expect(result).toMatchObject({
      soiled_collected_quantity: 10,
      clean_returned_quantity: 8,
      damaged_quantity: 1,
      missing_quantity: 1,
      discrepancy_quantity: -1,
      discrepancy_flag: true,
    });
  });

  it('updates ward actual quantity from collected and clean return counts', () => {
    expect(applyParReconciliation({
      actualQuantity: 20,
      soiledCollectedQuantity: 10,
      cleanReturnedQuantity: 8,
    })).toBe(18);
  });
});
