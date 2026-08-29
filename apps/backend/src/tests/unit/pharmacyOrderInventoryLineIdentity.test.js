import { jest } from '@jest/globals';

import {
  authoritativeSubstitutionAllowed,
  resolveCounterDispenseAuthorityTx,
  resolvePrescriptionLineIndexes,
  substitutionWitnessPayload,
} from '../../services/pharmacy/pharmacyOrderInventoryService.js';

describe('pharmacy order prescription line identity', () => {
  const duplicatePrescriptionLines = [
    { catalog_id: 17, quantity: 2 },
    { catalog_id: 17, quantity: 3 },
  ];

  function thrownBy(action) {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('Expected action to throw');
  }

  test('rejects duplicate catalog lines without a persisted prescription line index', () => {
    expect(thrownBy(() => resolvePrescriptionLineIndexes(
      [
        { order_line_index: 0, catalog_id: 17, quantity: 2 },
        { order_line_index: 1, catalog_id: 17, quantity: 3 },
      ],
      duplicatePrescriptionLines,
    ))).toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED',
    });
  });

  test('maps duplicate catalog lines only through distinct stable identities', () => {
    expect(resolvePrescriptionLineIndexes(
      [
        {
          order_line_index: 0,
          prescription_line_index: 1,
          catalog_id: 17,
          quantity: 3,
        },
        {
          order_line_index: 1,
          prescription_line_index: 0,
          catalog_id: 17,
          quantity: 2,
        },
      ],
      duplicatePrescriptionLines,
    )).toEqual([1, 0]);
  });

  test('rejects two order lines targeting the same prescription line', () => {
    expect(thrownBy(() => resolvePrescriptionLineIndexes(
      [
        {
          order_line_index: 0,
          prescription_line_index: 0,
          catalog_id: 17,
          quantity: 2,
        },
        {
          order_line_index: 1,
          prescription_line_index: 0,
          catalog_id: 17,
          quantity: 3,
        },
      ],
      duplicatePrescriptionLines,
    ))).toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_PRESCRIPTION_LINE_AMBIGUOUS',
    });
  });

  test('rejects an order line whose stable index points at a different duplicate catalog identity', () => {
    expect(thrownBy(() => resolvePrescriptionLineIndexes(
      [{
        order_line_index: 0,
        prescription_line_index: 1,
        catalog_id: 17,
        quantity: 2,
      }],
      [
        { catalog_id: 17, quantity: 2 },
        { catalog_id: 18, quantity: 2 },
      ],
    ))).toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_ORDER_PRESCRIPTION_LINE_UNRESOLVED',
      details: {
        order_line_index: 0,
        prescription_line_index: 1,
      },
    });
  });
});

describe('authoritative prescription catalog equivalence', () => {
  const original = {
    composition_id: 11,
    composition_confidence: 'high',
    strength_key: '500mg',
    strength_components: [{ ingredient: 'paracetamol', amount: '500', unit: 'mg' }],
    form_key: 'tablet',
    release_key: 'immediate',
    route: 'oral',
    active_ingredients: ['paracetamol'],
  };

  test('accepts only the same high-confidence composition, strength, form, release, and route', () => {
    expect(authoritativeSubstitutionAllowed(original, { ...original })).toBe(true);

    for (const changed of [
      { composition_id: 12 },
      { composition_confidence: 'medium' },
      { strength_key: '650mg' },
      { form_key: 'syrup' },
      { release_key: 'extended' },
      { route: 'intravenous' },
    ]) {
      expect(authoritativeSubstitutionAllowed(original, { ...original, ...changed })).toBe(false);
    }
  });

  test('requires exact component strengths for combination products', () => {
    const combination = {
      ...original,
      composition_id: 22,
      strength_key: '500mg+125mg',
      active_ingredients: ['amoxicillin', 'clavulanic acid'],
      strength_components: [
        { ingredient: 'amoxicillin', amount: '500', unit: 'mg' },
        { ingredient: 'clavulanic acid', amount: '125', unit: 'mg' },
      ],
    };
    expect(authoritativeSubstitutionAllowed(combination, {
      ...combination,
      strength_components: [...combination.strength_components].reverse(),
    })).toBe(true);
    expect(authoritativeSubstitutionAllowed(combination, {
      ...combination,
      strength_components: [
        combination.strength_components[0],
        { ingredient: 'clavulanic acid', amount: '62.5', unit: 'mg' },
      ],
    })).toBe(false);
  });
});

describe('counter inventory facility custody', () => {
  test('resolves catalog pricing and Inventory V2 identity under the exact tenant facility', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 17, unit_price: '12.50' }])
      .mockResolvedValueOnce([{
        id: 81,
        catalog_id: 17,
        facility_id: 7,
        display_name: 'Drug A',
        status: 'active',
      }]);

    await expect(resolveCounterDispenseAuthorityTx(
      { $queryRawUnsafe: query },
      {
        tenantId: '00000000-0000-4000-8000-000000000001',
        facilityId: 7,
        lines: [{
          order_line_index: 0,
          catalog_id: 17,
          ordered_qty: 2,
          dispensed_qty: 1,
        }],
        completeRemainder: false,
      },
    )).resolves.toEqual([
      expect.objectContaining({
        order_line_index: 0,
        catalog_id: 17,
        inventory_item_id: 81,
        ordered_qty: 2,
        dispensed_qty: 1,
        price: 12.5,
        line_total: 12.5,
      }),
    ]);

    expect(query.mock.calls[0][0]).toMatch(/pharmacy_catalog[\s\S]*tenant_id = \$1::uuid/);
    expect(query.mock.calls[1][0]).toMatch(/pharmacy_inventory_items/);
    expect(query.mock.calls[1][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(query.mock.calls[1][0]).toMatch(/facility_id = \$2::int/);
    expect(query.mock.calls[1].slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      7,
      [17],
    ]);
  });

  test('a no-op partial line preserves its prior positive inventory item identity', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 17, unit_price: '12.50' }])
      .mockResolvedValueOnce([]);

    await expect(resolveCounterDispenseAuthorityTx(
      { $queryRawUnsafe: query },
      {
        tenantId: '00000000-0000-4000-8000-000000000001',
        facilityId: 7,
        lines: [{
          order_line_index: 0,
          catalog_id: 17,
          inventory_item_id: 81,
          ordered_qty: 2,
          dispensed_qty: 1,
          inventory_dispensed_quantity: 1,
          inventory_billable_total: 12.5,
        }],
        completeRemainder: false,
      },
    )).resolves.toEqual([expect.objectContaining({
      order_line_index: 0,
      catalog_id: 17,
      inventory_item_id: 81,
      dispensed_qty: 1,
      inventory_dispensed_quantity: 1,
      inventory_billable_total: 12.5,
      line_total: 12.5,
    })]);

    expect(query.mock.calls[1][0]).toMatch(/pharmacy_inventory_items/);
  });
});

describe('substitution duplicate-line command identity', () => {
  test('preserves exact order and prescription indexes even when both lines share a catalog id', () => {
    const shared = {
      order_id: 71,
      prescription_id: 81,
      inventory_item_id: 91,
      inventory_batch_id: 101,
      quantity: 1,
      original_catalog_id: 17,
      final_catalog_id: 18,
      reason: 'Equivalent brand selected',
    };
    const first = substitutionWitnessPayload({
      ...shared,
      order_line_index: 0,
      prescription_line_index: 0,
    });
    const second = substitutionWitnessPayload({
      ...shared,
      order_line_index: 1,
      prescription_line_index: 1,
    });

    expect(first).toMatchObject({ order_line_index: 0, prescription_line_index: 0 });
    expect(second).toMatchObject({ order_line_index: 1, prescription_line_index: 1 });
    expect(first).not.toEqual(second);
  });
});
