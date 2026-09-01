import { buildOpenApiDocument } from '../../../scripts/openapi/buildSpec.mjs';
import * as money from '../../../scripts/openapi/schemas/money.mjs';
import * as paymentGateway from '../../../scripts/openapi/schemas/paymentGateway.mjs';

const creditNoteRoutes = [
  { method: 'get', path: '/api/v1/billing/v2/credit-notes/{id}' },
  { method: 'post', path: '/api/v1/billing/v2/credit-notes/{id}/approve' },
  { method: 'post', path: '/api/v1/billing/v2/credit-notes/{id}/reject' },
  { method: 'post', path: '/api/v1/billing/v2/credit-notes/{id}/apply' },
];

const refundApprovalRoute = {
  method: 'post',
  path: '/api/v1/billing/v2/refunds/{id}/approve',
};
const refundListRoute = {
  method: 'get',
  path: '/api/v1/billing/v2/refunds',
};
const refundRaiseRoute = {
  method: 'post',
  path: '/api/v1/billing/v2/refunds',
};

function generatedOperation(route) {
  const document = buildOpenApiDocument(
    [route],
    {
      openapi: '3.0.3',
      components: { schemas: money.schemas },
      tagRegistry: [{ slug: 'billing' }],
    },
    money.operations,
  );
  return document.paths[route.path][route.method];
}

describe('MED-03 billing OpenAPI source semantics', () => {
  it.each(creditNoteRoutes)('$method $path emits a positive bigint path identifier', (route) => {
    const operation = generatedOperation(route);
    const id = operation.parameters.find((parameter) => (
      parameter.in === 'path' && parameter.name === 'id'
    ));
    expect(id).toEqual({
      name: 'id',
      in: 'path',
      required: true,
      schema: {
        oneOf: [
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
        ],
      },
    });
  });

  it('keeps signed monetary bigint wire values while narrowing only credit-note paths', () => {
    expect(money.schemas.BillingCreditNote.properties.amount_minor.oneOf[0]).toEqual({
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  it('generates the required durable refund-approval command header and mismatch response', () => {
    const operation = generatedOperation(refundApprovalRoute);
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
      }),
    ]));
    expect(operation.responses['422']).toEqual(expect.objectContaining({
      description: expect.stringMatching(/different refund approval command/i),
    }));
  });

  it('documents the exact wired refund list status filter', () => {
    const operation = generatedOperation(refundListRoute);
    const queryNames = operation.parameters
      .filter((parameter) => parameter.in === 'query')
      .map((parameter) => parameter.name);
    expect(queryNames).toContain('approval_status');
    expect(queryNames).not.toContain('status');
  });

  it('requires idempotency and excludes unimplemented insurance settlement at creation', () => {
    const operation = generatedOperation(refundRaiseRoute);
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
      }),
    ]));
    expect(money.schemas.RaiseRefundRequest.properties.mode.enum)
      .toEqual(['CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET']);
    expect(money.schemas.BillingCreditNoteApplyRequest.properties.refund_mode.enum)
      .toEqual(['CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD', 'WALLET']);
  });

  it('keeps integrated electronic refund recovery on the gateway rail', () => {
    const recoveryPath = paymentGateway.schemas.PaymentGatewayRefundReconcileRequest
      .properties.recovery_path;
    expect(recoveryPath.enum).toEqual(['gateway_retry']);
    expect(recoveryPath.description).toMatch(/cannot be released to manual payout/i);
    expect(paymentGateway.operations[
      'POST /api/v1/billing/gateway/refunds/{id}/reconcile'
    ].description).toMatch(/cannot be released to manual payout/i);
  });
});
