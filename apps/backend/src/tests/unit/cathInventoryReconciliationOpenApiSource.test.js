import { buildOpenApiDocument } from '../../../scripts/openapi/buildSpec.mjs';
import {
  operations,
  schemas,
} from '../../../scripts/openapi/schemas/cathConsumables.mjs';

const PATH = '/api/v1/cath-lab/cases/{caseId}/consumables/{usageId}/inventory-reconcile';
const ROUTINE_ROLES = [
  'PHARMACIST',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
];
const DOCUMENTED_ROLES = [...ROUTINE_ROLES, 'ADMIN', 'SUPER_ADMIN'];
const RECONCILIATION_FIELDS = [
  'case_id',
  'usage_id',
  'patient_uid',
  'item_name',
  'catalog_item_id',
  'facility_id',
  'inventory_item_id',
  'inventory_batch_id',
  'batch_number',
  'documented_quantity',
  'decremented_quantity',
  'remaining_quantity',
  'inventory_decrement_status',
  'inventory_warning',
  'task_id',
  'task_status',
  'workflow_sla_instance_id',
  'sla_status',
  'sla_recorded_status',
  'due_at',
  'actionable',
  'coverage_gap',
  'deep_link',
  'retry_path',
];

function generatedOperation(method) {
  const document = buildOpenApiDocument(
    [{ method, path: PATH }],
    {
      openapi: '3.0.3',
      components: { schemas },
      tagRegistry: [{ slug: 'cath-lab' }],
    },
    operations,
  );
  return document.paths[PATH][method];
}

describe('Cath inventory reconciliation OpenAPI source', () => {
  test.each(['GET', 'POST'])('%s documents the exact operator boundary', (method) => {
    const operation = operations[`${method} ${PATH}`];
    expect(operation).toBeDefined();
    expect(operation.description).toEqual(expect.any(String));
    expect(operation.description.trim()).not.toBe('');
    expect(operation.description.match(/\b[A-Z][A-Z_]+\b/g)).toEqual(DOCUMENTED_ROLES);
    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(generatedOperation(method.toLowerCase()).security)
      .toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    if (method === 'GET') {
      expect(operation.description).toMatch(
        /ADMIN and SUPER_ADMIN.*read only.*coverage-gap recovery.*no active pharmacy operator/i,
      );
    } else {
      expect(operation.description).toMatch(
        /ADMIN and SUPER_ADMIN.*read-only.*cannot perform this inventory mutation/i,
      );
    }
  });

  test('GET is read-only and does not require an idempotency command header', () => {
    const source = operations[`GET ${PATH}`];
    const operation = generatedOperation('get');
    expect(source.parameters ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key' }),
    ]));
    expect(operation.parameters).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key' }),
    ]));
    expect(source.response).toBe('CathInventoryReconciliationReadResponse');
  });

  test('POST requires Idempotency-Key and has no request body', () => {
    const source = operations[`POST ${PATH}`];
    const operation = generatedOperation('post');
    expect(source.parameters).toEqual([
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
      }),
    ]);
    expect(source).not.toHaveProperty('request');
    expect(source).not.toHaveProperty('requestContent');
    expect(operation).not.toHaveProperty('requestBody');
    expect(source.response).toBe('CathInventoryReconciliationCommandResponse');
  });

  test('uses positive bigint case and usage path identifiers', () => {
    for (const method of ['GET', 'POST']) {
      const { pathParameters } = operations[`${method} ${PATH}`];
      expect(pathParameters.caseId).toEqual(schemas.CathInventoryReconciliation.properties.case_id);
      expect(pathParameters.usageId).toEqual(schemas.CathInventoryReconciliation.properties.usage_id);
    }
  });

  test('matches every Staff reconciliation field and command outcome', () => {
    const reconciliation = schemas.CathInventoryReconciliation;
    expect(reconciliation.required).toEqual(RECONCILIATION_FIELDS);
    expect(Object.keys(reconciliation.properties)).toEqual(RECONCILIATION_FIELDS);
    expect(schemas.CathInventoryReconciliationCommandData.required)
      .toEqual(['outcome', 'reconciliation']);
    expect(schemas.CathInventoryReconciliationCommandData.properties.outcome.enum)
      .toEqual(['completed', 'still_insufficient']);
    expect(schemas.CathInventoryReconciliationCommandData.properties.reconciliation)
      .toEqual({ $ref: '#/components/schemas/CathInventoryReconciliation' });
  });

  test('matches the service wire types for identifiers, quantities, and route metadata', () => {
    const properties = schemas.CathInventoryReconciliation.properties;
    for (const field of [
      'case_id',
      'usage_id',
      'catalog_item_id',
      'inventory_item_id',
      'task_id',
    ]) {
      expect(properties[field].oneOf).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'string', pattern: '^[1-9][0-9]*$' }),
      ]));
    }
    // facility_id is deliberately NOT a BIGINT_WIRE identifier:
    // cathInventoryReconciliationView emits `Number(record.facility_id)`, and
    // facilities.id is int4, so the wire value is a JSON number and never the
    // decimal-string half of the bigint union.
    expect(properties.facility_id).toEqual({ type: 'integer', minimum: 1 });
    expect(properties.facility_id).not.toHaveProperty('oneOf');
    expect(properties.inventory_batch_id).toMatchObject({
      nullable: true,
      oneOf: expect.arrayContaining([
        expect.objectContaining({ type: 'string', pattern: '^[1-9][0-9]*$' }),
      ]),
    });
    for (const field of [
      'documented_quantity',
      'decremented_quantity',
      'remaining_quantity',
    ]) {
      expect(properties[field]).toMatchObject({
        type: 'string',
        pattern: '^(?:0|[1-9][0-9]*)\\.[0-9]{4}$',
      });
    }
    expect(properties.deep_link.pattern).toContain('case_id=');
    expect(properties.deep_link.pattern).toContain('&consumable_usage_id=');
    expect(properties.retry_path.pattern).toContain('/inventory-reconcile$');
  });
});
