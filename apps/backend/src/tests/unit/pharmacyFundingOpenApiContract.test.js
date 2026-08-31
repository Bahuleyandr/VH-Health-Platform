import * as money from '../../../scripts/openapi/schemas/money.mjs';
import * as pharmacy from '../../../scripts/openapi/schemas/pharmacy.mjs';

describe('pharmacy funding handwritten OpenAPI contract', () => {
  it('publishes strict order materialization and the canonical Staff task shape', () => {
    const operation = money.operations[
      'POST /api/v1/billing/v2/pharmacy-funding/orders/{orderId}/materialize'
    ];
    expect(operation.pathParameters.orderId).toMatchObject({ type: 'integer', minimum: 1 });
    expect(operation.request).toBe('PharmacyFundingMaterializeRequest');
    expect(operation.response).toBe('PharmacyFundingResolutionResponse');
    expect(money.schemas.PharmacyFundingMaterializeRequest).toMatchObject({
      additionalProperties: false,
    });
    expect(pharmacy.schemas.PharmacyFundingRecoveryTask).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['task_id', 'status', 'owner_role', 'deep_link']),
    });
    expect(pharmacy.schemas.PharmacyFundingRecoveryTask.properties).not.toHaveProperty(
      'assigned_role',
    );
    expect(pharmacy.schemas.PharmacyFundingRecoveryTask.properties.owner_role.enum)
      .not.toContain('TPA_DESK');
    expect(money.schemas.PharmacyFundingResolution.properties.fundingRecovery).toEqual({
      nullable: true,
      allOf: [{ $ref: '#/components/schemas/PharmacyFundingRecoveryTask' }],
    });
  });

  it('binds recovery lookup to exact order, invoice line, and optional claim ids', () => {
    const operation = money.operations['GET /api/v1/billing/v2/pharmacy-funding/recovery'];
    expect(operation.response).toBe('PharmacyFundingRecoveryResponse');
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pharmacy_order_id', in: 'query', required: true }),
      expect.objectContaining({ name: 'invoice_item_id', in: 'query', required: true }),
      expect.objectContaining({ name: 'tpa_claim_id', in: 'query', required: false }),
    ]));
    expect(money.schemas.PharmacyFundingRecoveryRecord.required).toEqual(expect.arrayContaining([
      'invoice_item_id', 'invoice_id', 'source_authority_version',
      'source_authority_sha256', 'patient_uid', 'invoice_status',
    ]));
  });

  it('requires exact line authority and durable idempotency for a TPA decision', () => {
    const operation = money.operations[
      'POST /api/v1/billing/v2/pharmacy-funding/tasks/{taskId}/decision'
    ];
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(operation.pathParameters.taskId).toMatchObject({ type: 'integer', minimum: 1 });
    expect(money.schemas.PharmacyFundingLineDecisionRequest.required).toEqual([
      'pharmacy_order_id', 'invoice_item_id', 'tpa_claim_id', 'order_version',
      'order_items_sha256', 'approved_amount', 'non_payable_amount', 'reason_code',
    ]);
    expect(money.schemas.PharmacyFundingLineDecisionRequest.additionalProperties).toBe(false);
  });

  it('documents server-derived posted-payment retry with no collected-amount field', () => {
    const operation = money.operations[
      'POST /api/v1/billing/v2/pharmacy-funding/tasks/{taskId}/retry'
    ];
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(money.schemas.PharmacyFundingRetryRequest.properties).toEqual({
      payment_id: { type: 'integer', minimum: 1, maximum: 2147483647 },
    });
    expect(money.schemas.PharmacyFundingRetryRequest.properties).not.toHaveProperty('amount_collected');
    expect(operation.description).toContain('append-only payment allocations');
    expect(money.schemas.PharmacyFundingResolution.properties.status.enum).toEqual(
      expect.arrayContaining(['funded', 'blocked', 'invalidated', 'closed']),
    );
  });

  it('requires idempotency before compensating allocated payment reversal', () => {
    const operation = money.operations[
      'POST /api/v1/billing/v2/payments/{id}/reverse'
    ];
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(operation.description).toContain('append-only reversal evidence');
  });

  it('publishes strict exact-case reconciliation lookup', () => {
    const operation = money.operations[
      'GET /api/v1/billing/v2/pharmacy-funding/reconciliations/{caseId}'
    ];
    expect(operation.pathParameters.caseId).toMatchObject({ type: 'integer', minimum: 1 });
    expect(operation.response).toBe('PharmacyFundingReconciliationCaseResponse');
    expect(money.schemas.PharmacyFundingReconciliationCase.additionalProperties).toBe(false);
    expect(money.schemas.PharmacyFundingReconciliationCase.required).toEqual(
      expect.arrayContaining([
        'id', 'pharmacy_order_id', 'task_id', 'snapshot_sha256',
        'current_snapshot_sha256', 'current_snapshot', 'active_line_count',
      ]),
    );
  });

  it('requires a strict idempotent dual-owner reconciliation decision tuple', () => {
    const operation = money.operations[
      'POST /api/v1/billing/v2/pharmacy-funding/reconciliations/{caseId}/decision'
    ];
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(operation.request).toBe('PharmacyFundingReconciliationDecisionRequest');
    expect(operation.response).toBe('PharmacyFundingReconciliationDecisionResponse');
    expect(money.schemas.PharmacyFundingReconciliationDecisionRequest).toMatchObject({
      additionalProperties: false,
      required: [
        'keeper_invoice_item_id', 'resolution_path', 'expected_snapshot_sha256',
      ],
    });
    expect(money.schemas.PharmacyFundingReconciliationDecisionResult.additionalProperties)
      .toBe(false);
    expect(
      money.schemas.PharmacyFundingReconciliationDecisionRequest.properties.resolution_path.enum,
    ).toEqual([
      'SAFE_DEACTIVATE_DUPLICATES', 'KEEP_CURRENT_AUTHORITY', 'CANCEL_ORDER', 'REBILL',
    ]);
  });
});
