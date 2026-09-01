import { jest } from '@jest/globals';
import { Prisma } from '@prisma/client';

const { loadWardIndentMedicationClosureTx } = await import(
  '../../services/ipd/wardIndentMedicationClosureService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';

test('preserves Decimal and other value objects while normalizing allocation BigInts', async () => {
  class InventoryValue {
    constructor(value) {
      this.value = value;
    }

    toString() {
      return this.value;
    }
  }

  const reservedQuantity = new Prisma.Decimal('2.0000');
  const capturedAt = new Date('2026-08-30T06:00:00.000Z');
  const inventoryValue = new InventoryValue('opaque');
  const queryRaw = jest.fn()
    .mockResolvedValueOnce([{
      id: 91n,
      reserved_quantity: reservedQuantity,
      issued_quantity: new Prisma.Decimal(0),
      authority_released_quantity: new Prisma.Decimal(0),
      captured_at: capturedAt,
      inventory_value: inventoryValue,
      plain_values: {
        string_value: 'reserved',
        number_value: 2,
        boolean_value: true,
        null_value: null,
        undefined_value: undefined,
        nested: {
          safe_bigint: 92n,
          unsafe_bigint: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        },
      },
    }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);

  const closure = await loadWardIndentMedicationClosureTx(
    { $queryRawUnsafe: queryRaw },
    TENANT,
    41,
  );

  expect(closure.allocations[0]).toMatchObject({ id: 91 });
  expect(closure.allocations[0].reserved_quantity).toBe(reservedQuantity);
  expect(Number(closure.allocations[0].reserved_quantity)).toBe(2);
  expect(closure.allocations[0].captured_at).toBe(capturedAt);
  expect(closure.allocations[0].inventory_value).toBe(inventoryValue);
  expect(closure.allocations[0].plain_values).toEqual({
    string_value: 'reserved',
    number_value: 2,
    boolean_value: true,
    null_value: null,
    undefined_value: undefined,
    nested: {
      safe_bigint: 92,
      unsafe_bigint: '9007199254740992',
    },
  });
});
