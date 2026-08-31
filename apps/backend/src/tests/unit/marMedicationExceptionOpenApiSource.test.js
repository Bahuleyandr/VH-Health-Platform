import { operations, schemas } from '../../../scripts/openapi/schemas/clinicalMar.mjs';

describe('MAR medication exception OpenAPI source', () => {
  test.each([
    'GET /api/v1/clinical/mar/exceptions',
    'POST /api/v1/clinical/mar/exceptions/{caseId}/claim',
    'POST /api/v1/clinical/mar/exceptions/{caseId}/disposition',
  ])('%s has a non-empty operation description', (key) => {
    expect(operations[key]).toBeDefined();
    expect(operations[key].description).toEqual(expect.any(String));
    expect(operations[key].description.trim()).not.toBe('');
  });

  test('the disposition contract exposes only bounded non-treatment decisions', () => {
    expect(schemas.MarMedicationExceptionDispositionRequest.properties.disposition.enum)
      .toEqual([
        'reviewed_no_replacement',
        'replacement_ordered',
        'order_stopped',
      ]);
    expect(schemas.MarMedicationExceptionDispositionRequest.properties.disposition.enum)
      .not.toContain('hold_released');
    expect(schemas.MarMedicationExceptionDispositionRequest.properties)
      .not.toHaveProperty('reschedule_at');
  });

  test('MAR and supply identifiers match their PostgreSQL wire domains', () => {
    expect(schemas.MarVerifyRequest.properties.ma_id).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    });
    expect(operations[
      'POST /api/v1/clinical/mar/{id}/supply-overrides/{consumptionId}/reconcile'
    ].pathParameters).toMatchObject({
      id: { type: 'integer', minimum: 1, maximum: 2147483647 },
      consumptionId: {
        type: 'string',
        pattern: '^[1-9][0-9]{0,18}$',
        'x-vhhealth-maximumDecimal': '9223372036854775807',
      },
    });
    expect(schemas.MarSupplyReconciliationAllocation.properties.inventory_allocation_id)
      .toMatchObject({
        type: 'string',
        pattern: '^[1-9][0-9]{0,18}$',
        'x-vhhealth-maximumDecimal': '9223372036854775807',
      });
    expect(schemas.MarSupplyConsumption.properties.id.type).toBe('string');
    expect(schemas.MarSupplyConsumption.properties.inventory_allocation_id.type)
      .toBe('string');
    expect(schemas.MarSupplyReconciliationLink.properties.inventory_allocation_id.type)
      .toBe('string');
  });
});
