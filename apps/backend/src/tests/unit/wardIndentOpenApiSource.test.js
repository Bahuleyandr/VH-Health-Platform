import { buildOpenApiDocument } from '../../../scripts/openapi/buildSpec.mjs';
import {
  operations,
  schemas,
} from '../../../scripts/openapi/schemas/wardIndents.mjs';

const LIST_PATH = '/api/v1/pharmacy/ward-indents';
const RECEIVE_PATH = '/api/v1/pharmacy/ward-indents/{id}/receive';
const RECONCILE_PATH = '/api/v1/pharmacy/ward-indents/{id}/reconcile';
const COVERAGE_RECOVERY_PATH =
  '/api/v1/pharmacy-orders/ward-indents/notification-coverage/recover';
const IPD_CANDIDATES_PATH = '/api/v1/ipd/ward-indents/{indentId}/items/{itemId}/inventory-candidates';

function buildDocument(routes) {
  return buildOpenApiDocument(
    routes,
    {
      openapi: '3.0.3',
      components: { schemas },
      tagRegistry: [{ slug: 'pharmacy' }, { slug: 'ipd' }],
    },
    operations,
  );
}

describe('ward-indent OpenAPI source matches the live Staff contract', () => {
  it('documents worklist and paired keyset cursor filters', () => {
    const document = buildDocument([{ method: 'get', path: LIST_PATH }]);
    const parameters = Object.fromEntries(
      document.paths[LIST_PATH].get.parameters.map((parameter) => [
        parameter.name,
        parameter,
      ]),
    );

    expect(parameters.worklist.schema.enum).toEqual([
      'open',
      'terminal',
      'owned',
      'overdue',
    ]);
    expect(parameters.before_requested_at.schema).toEqual({
      type: 'string',
      format: 'date-time',
    });
    expect(parameters.before_id.schema).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
    });
    expect(parameters.before_requested_at.description).toMatch(/together with before_id/i);
    expect(parameters.before_id.description).toMatch(/together with before_requested_at/i);
  });

  it('accepts the substitution acknowledgements sent by Staff receive', () => {
    const document = buildDocument([{ method: 'post', path: RECEIVE_PATH }]);
    const requestSchema = document.paths[RECEIVE_PATH].post.requestBody
      .content['application/json'].schema;

    expect(requestSchema).toEqual({
      $ref: '#/components/schemas/WardIndentReceiveRequest',
    });
    expect(schemas.WardIndentReceiveRequest.additionalProperties).toBe(false);
    expect(schemas.WardIndentReceiveRequest.properties.substitution_acknowledgements)
      .toEqual({
        type: 'array',
        uniqueItems: true,
        items: {
          $ref: '#/components/schemas/WardIndentSubstitutionAcknowledgement',
        },
      });
    expect(schemas.WardIndentSubstitutionAcknowledgement).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['item_id'],
      properties: {
        item_id: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
        },
      },
    });
  });

  it('accepts allocation returns without narrowing bigint allocation IDs', () => {
    const document = buildDocument([{ method: 'post', path: RECONCILE_PATH }]);
    const requestSchema = document.paths[RECONCILE_PATH].post.requestBody
      .content['application/json'].schema;

    expect(requestSchema).toEqual({
      $ref: '#/components/schemas/WardIndentReconcileRequest',
    });
    expect(schemas.WardIndentReconcileRequest.additionalProperties).toBe(false);
    expect(schemas.WardIndentReconcileRequest.properties.allocation_returns)
      .toEqual({
        type: 'array',
        uniqueItems: true,
        items: { $ref: '#/components/schemas/WardIndentAllocationReturn' },
      });
    expect(schemas.WardIndentAllocationReturn.properties.allocation_id.oneOf)
      .toEqual([
        {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        {
          type: 'string',
          pattern: '^[1-9][0-9]*$',
          description: 'Positive decimal string when the identifier exceeds the JavaScript safe-integer range.',
        },
      ]);
  });

  it('documents inventory candidates on the live IPD compatibility surface', () => {
    const document = buildDocument([
      { method: 'get', path: IPD_CANDIDATES_PATH },
    ]);
    const operation = document.paths[IPD_CANDIDATES_PATH].get;

    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WardIndentInventoryCandidatesResponse',
    });
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'indentId',
        in: 'path',
        required: true,
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
        },
      }),
      expect.objectContaining({
        name: 'itemId',
        in: 'path',
        required: true,
        schema: {
          type: 'integer',
          minimum: 1,
          maximum: 2147483647,
        },
      }),
    ]));
  });

  it('documents the bounded operator notification-coverage recovery contract', () => {
    // This is the only ward-indent path mounted under /api/v1/pharmacy-orders,
    // so the URL's own first segment is not a published tag. The real generator
    // never tags it from the URL either: it resolves `pharmacy` from the route
    // module, which is why src/docs/openapi.json publishes this operation under
    // `pharmacy`. Feed the stub the same srcFile the router registers with so
    // the harness resolves the tag exactly as generation does.
    const document = buildDocument([{
      method: 'post',
      path: COVERAGE_RECOVERY_PATH,
      srcFile: 'pharmacy/wardIndentRoutes.js',
    }]);
    const operation = document.paths[COVERAGE_RECOVERY_PATH].post;
    expect(operation.tags).toEqual(['pharmacy']);
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WardIndentNotificationCoverageRecoveryRequest',
    });
    expect(schemas.WardIndentNotificationCoverageRecoveryRequest).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: expect.objectContaining({
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 25,
        }),
      },
    });
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WardIndentNotificationCoverageRecoveryResponse',
    });
    expect(schemas.WardIndentNotificationCoverageRecoverySummary.required).toEqual([
      'scanned',
      'recovered',
      'held',
      'awaitingRecipients',
      'recoveredTaskIds',
      'heldTaskIds',
      'limit',
    ]);
  });
});
