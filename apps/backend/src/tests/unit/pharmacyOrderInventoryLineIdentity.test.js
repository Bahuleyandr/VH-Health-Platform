import { jest } from '@jest/globals';

import {
  authoritativeSubstitutionAllowed,
  orderControlledWitnessSelector,
  pharmacyOrderControlledWitnessPayload,
  resolveCounterDispenseAuthorityTx,
  resolvePrescriptionLineIndexes,
  substitutionWitnessPayload,
} from '../../services/pharmacy/pharmacyOrderInventoryService.js';
import {
  CONTROLLED_DISPENSE_APPROVAL_SCOPES,
  controlledDispenseApprovalFingerprint,
} from '../../services/pharmacy/controlledDispenseWitnessService.js';

describe('order controlled-witness quantity contract', () => {
  const baseSelection = {
    order_line_index: 0,
    inventory_item_id: 17,
    inventory_batch_id: 27,
  };

  test('accepts the NUMERIC(14,4) ceiling without changing the selected quantity', () => {
    expect(orderControlledWitnessSelector({
      ...baseSelection,
      quantity: 9_999_999_999.9999,
    })).toEqual({
      ...baseSelection,
      quantity: 9_999_999_999.9999,
    });
  });

  test.each([1.00001, 9_999_999_999.99991, 10_000_000_000])(
    'rejects an allocation quantity that the ledger cannot represent exactly: %s',
    (quantity) => {
      let error;
      try {
        orderControlledWitnessSelector({ ...baseSelection, quantity });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        statusCode: 400,
        code: 'PHARMACY_DISPENSE_QUANTITY_INVALID',
      });
    },
  );

  test.each([
    [
      'order evidence',
      { inventory_dispensed_quantity: '0.00001' },
      {},
      'PHARMACY_ORDER_WITNESS_ORDER_EVIDENCE_CONFLICT',
    ],
    [
      'prescription evidence',
      {},
      { remaining_quantity: '1.99999' },
      'PHARMACY_ORDER_WITNESS_PRESCRIPTION_EVIDENCE_CONFLICT',
    ],
  ])('rejects malformed stored %s as an authority conflict', (
    _label,
    orderLineOverride,
    prescriptionLineOverride,
    code,
  ) => {
    let error;
    try {
      pharmacyOrderControlledWitnessPayload({
        order: {
          id: 73,
          inventory_authority_version: 4,
          status: 'PENDING',
          delivery_type: 'counter',
          facility_id: 7,
        },
        orderLine: {
          catalog_id: 17,
          ordered_qty: 2,
          inventory_dispensed_quantity: 0,
          inventory_remaining_quantity: 2,
          ...orderLineOverride,
        },
        orderLineIndex: 0,
        inventoryItem: { id: 81 },
        inventoryBatch: { id: 91, expiry_date: '2027-08-30' },
        quantity: 1,
        patientUid: '11111111-1111-4111-8111-111111111111',
        prescription: { id: 101, revision: 3 },
        prescriptionLineIndex: 0,
        prescriptionLine: {
          catalog_id: 17,
          quantity: 2,
          dispensed_quantity: 0,
          remaining_quantity: 2,
          ...prescriptionLineOverride,
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ statusCode: 409, code });
  });

  test('fingerprint changes when a revoked grant is replaced or signing evidence drifts', () => {
    const buildPayload = ({ grantId = '501', signedAt = '2026-08-30T10:00:00.000Z' } = {}) => (
      pharmacyOrderControlledWitnessPayload({
        order: {
          id: 73,
          inventory_authority_version: 4,
          status: 'PENDING',
          delivery_type: 'counter',
          facility_id: 7,
        },
        orderLine: {
          catalog_id: 17,
          ordered_qty: 2,
          inventory_dispensed_quantity: 0,
          inventory_remaining_quantity: 2,
        },
        orderLineIndex: 0,
        requesterGrant: {
          grant_id: grantId,
          actor_role: 'PHARMACY_STAFF',
          facility_id: 7,
        },
        inventoryItem: { id: 81 },
        inventoryBatch: { id: 91, expiry_date: '2027-08-30' },
        quantity: 1,
        patientUid: '11111111-1111-4111-8111-111111111111',
        prescription: {
          id: 101,
          revision: 3,
          status: 'pharmacy_linked',
          lifecycle_status: 'signed',
          doctor_id: 31,
          doctor_uid: '22222222-2222-4222-8222-222222222222',
          signed_at: signedAt,
          signed_by: '22222222-2222-4222-8222-222222222222',
          locked_at: '2026-08-30T10:00:01.000Z',
          locked_by: '22222222-2222-4222-8222-222222222222',
        },
        prescriptionLineIndex: 0,
        prescriptionLine: {
          catalog_id: 17,
          quantity: 2,
          dispensed_quantity: 0,
          remaining_quantity: 2,
        },
      })
    );
    const fingerprint = (payload) => controlledDispenseApprovalFingerprint({
      scope: CONTROLLED_DISPENSE_APPROVAL_SCOPES.pharmacyOrder,
      payload,
      requestedBy: '33333333-3333-4333-8333-333333333333',
    });
    const original = buildPayload();

    expect(Object.keys(original).sort()).toEqual([
      'batch_number',
      'batch_safety_contract',
      'contract',
      'expiry_date',
      'facility_id',
      'inventory_batch_id',
      'inventory_item_id',
      'lot_number',
      'operation',
      'order_catalog_id',
      'order_dispensed_quantity',
      'order_id',
      'order_inventory_authority_version',
      'order_line_index',
      'order_ordered_quantity',
      'order_remaining_quantity',
      'order_status',
      'patient_uid',
      'prescriber_uid',
      'prescriber_user_id',
      'prescription_catalog_id',
      'prescription_dispensed_quantity',
      'prescription_id',
      'prescription_lifecycle_status',
      'prescription_line_index',
      'prescription_locked_at',
      'prescription_locked_by',
      'prescription_number',
      'prescription_ordered_quantity',
      'prescription_remaining_quantity',
      'prescription_revision',
      'prescription_signed_at',
      'prescription_signed_by',
      'prescription_status',
      'quantity',
      'requester_facility_grant_id',
      'requester_facility_role',
    ].sort());
    expect(original).toMatchObject({
      requester_facility_grant_id: '501',
      prescriber_user_id: 31,
      prescriber_uid: '22222222-2222-4222-8222-222222222222',
      prescription_signed_at: '2026-08-30T10:00:00.000Z',
      prescription_locked_at: '2026-08-30T10:00:01.000Z',
    });
    expect(fingerprint(buildPayload({ grantId: '502' }))).not.toBe(fingerprint(original));
    expect(fingerprint(buildPayload({ signedAt: '2026-08-30T10:05:00.000Z' })))
      .not.toBe(fingerprint(original));
  });
});

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
  test('rejects a high-magnitude fifth decimal before pricing or stock allocation', async () => {
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
          ordered_qty: 9_999_999_999.9999,
          dispensed_qty: 9_999_999_999.99991,
        }],
        completeRemainder: false,
      },
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_DISPENSE_QUANTITY_INVALID',
    });
  });

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
