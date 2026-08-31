import { buildOpenApiDocument } from '../../../scripts/openapi/buildSpec.mjs';
import * as emr from '../../../scripts/openapi/schemas/emr.mjs';

const verificationRoute = {
  method: 'put',
  path: '/api/v1/emr/orders/{id}/verify',
};

function generatedOperation() {
  const document = buildOpenApiDocument(
    [verificationRoute],
    {
      openapi: '3.0.3',
      components: { schemas: emr.schemas },
      tagRegistry: [{ slug: 'emr' }],
    },
    emr.operations,
  );
  return document.paths[verificationRoute.path][verificationRoute.method];
}

describe('clinical-order verification OpenAPI source semantics', () => {
  test('requires dual authentication, a positive order id, and durable command identity', () => {
    const operation = generatedOperation();

    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(operation.parameters).toEqual(expect.arrayContaining([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'integer', minimum: 1 },
      },
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description: expect.stringMatching(/tenant, actor, role, order, and body/i),
      }),
    ]));
  });

  test('publishes the exact role and persisted-order-type authorization matrix', () => {
    const operation = generatedOperation();

    expect(operation.description).toMatch(/NURSING_STAFF.*ICU_INCHARGE/s);
    expect(operation.description).toMatch(/PHARMACY_STAFF.*PHARMACIST/s);
    expect(operation.description).toMatch(/pharmacy roles.*medication orders only/i);
    expect(operation.description).toMatch(/patient relationship.*persisted order type.*rechecked before every replay/i);
    expect(operation.description).toMatch(/immutable original verified response/i);
  });

  test('publishes every fail-closed command response', () => {
    const operation = generatedOperation();

    expect(Object.keys(operation.responses).sort()).toEqual([
      '200', '400', '401', '403', '404', '409', '422', '503',
    ]);
    for (const status of ['400', '403', '409', '422', '503']) {
      expect(operation.responses[status]).toMatchObject({
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/EmrErrorResponse' },
          },
        },
      });
    }
    expect(operation.responses['403'].description).toMatch(/device.*role.*capability.*patient relationship.*order type/i);
    expect(operation.responses['409'].description).toMatch(/in flight.*concurrently.*permanent command receipt/i);
    expect(operation.responses['422'].description).toMatch(/actor role.*request body/i);
    expect(operation.responses['503'].description).toMatch(/failed closed.*retry is safe/i);
  });
});
