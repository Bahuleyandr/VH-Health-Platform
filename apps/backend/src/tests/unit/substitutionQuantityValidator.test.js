import { validationResult } from 'express-validator';

import {
  dispenseSubstitutionValidator,
  isPositiveNumeric14_4Quantity,
} from '../../validators/pharmacy/orderValidators.js';

const validBody = {
  order_id: 1,
  prescription_id: 2,
  order_line_index: 0,
  prescription_line_index: 0,
  patient_uid: '11111111-1111-4111-8111-111111111111',
  inventory_item_id: 3,
  inventory_batch_id: 4,
  quantity: '1',
  original_catalog_id: 5,
  final_catalog_id: 6,
};

async function quantityValidationErrors(quantity) {
  const req = { body: { ...validBody, quantity } };
  for (const validator of dispenseSubstitutionValidator) {
    await validator.run(req);
  }
  return validationResult(req).array().filter((failure) => failure.path === 'quantity');
}

describe('dispense-substitution NUMERIC(14,4) quantity boundary', () => {
  test('accepts the exact positive NUMERIC(14,4) ceiling', async () => {
    expect(isPositiveNumeric14_4Quantity('9999999999.9999')).toBe(true);
    await expect(quantityValidationErrors('9999999999.9999')).resolves.toEqual([]);
  });

  test('rejects a high-magnitude fifth decimal before unsafe number coercion', async () => {
    const quantity = '9999999999.99999';
    expect(isPositiveNumeric14_4Quantity(quantity)).toBe(false);
    const failures = await quantityValidationErrors(quantity);
    expect(failures).toEqual([
      expect.objectContaining({
        msg: 'quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places',
      }),
    ]);
  });
});
