import { readFileSync } from 'node:fs';

import {
  operations,
  schemas,
} from '../../../scripts/openapi/schemas/pharmacyCounterSale.mjs';
import {
  canonicalCounterSaleBigIntId,
  counterSaleVoidCommandFingerprint,
} from '../../services/pharmacy/counterSaleService.js';

const migration = readFileSync(
  new URL('../../migrations/746_pharmacy_counter_sale_void_obligations.sql', import.meta.url),
  'utf8',
);
const routes = readFileSync(
  new URL('../../routes/pharmacy/counterSaleRoutes.js', import.meta.url),
  'utf8',
);
const service = readFileSync(
  new URL('../../services/pharmacy/counterSaleService.js', import.meta.url),
  'utf8',
);

describe('MED-03 counter-sale void closure contract', () => {
  test('binds durable command identity to tenant, sale, actor, disposition, and reason', () => {
    const command = {
      tenantId: '00000000-0000-4000-8000-000000000001',
      saleId: '81',
      reason: 'Never handed over',
      disposition: 'NEVER_HANDED_OVER',
      requestedBy: '00000000-0000-4000-8000-000000000002',
    };
    const exact = counterSaleVoidCommandFingerprint(command);
    expect(exact).toMatch(/^[a-f0-9]{64}$/);
    expect(counterSaleVoidCommandFingerprint({ ...command })).toBe(exact);
    for (const changed of [
      { tenantId: '00000000-0000-4000-8000-000000000099' },
      { saleId: '82' },
      { reason: 'Changed reason' },
      { disposition: 'PATIENT_RETURNED' },
      { requestedBy: '00000000-0000-4000-8000-000000000003' },
    ]) {
      expect(counterSaleVoidCommandFingerprint({ ...command, ...changed })).not.toBe(exact);
    }
  });

  test('preserves canonical signed-64 sale, request, and allocation ids above 2^53', () => {
    expect(canonicalCounterSaleBigIntId('9007199254740993')).toBe('9007199254740993');
    expect(canonicalCounterSaleBigIntId('0009007199254740993')).toBe('9007199254740993');
    expect(canonicalCounterSaleBigIntId('9223372036854775807')).toBe(
      '9223372036854775807',
    );
    for (const invalid of [
      9007199254740992,
      '0',
      '-1',
      '9223372036854775808',
      '1.5',
      '',
    ]) {
      expect(() => canonicalCounterSaleBigIntId(invalid)).toThrow(
        /canonical positive signed 64-bit decimal string/,
      );
    }

    const command = {
      tenantId: '00000000-0000-4000-8000-000000000001',
      reason: 'Never handed over',
      disposition: 'NEVER_HANDED_OVER',
      requestedBy: '00000000-0000-4000-8000-000000000002',
    };
    expect(counterSaleVoidCommandFingerprint({
      ...command, saleId: '9007199254740993',
    })).not.toBe(counterSaleVoidCommandFingerprint({
      ...command, saleId: '9007199254740994',
    }));

    expect(service).not.toMatch(/const saleId = Number\(id\)/);
    expect(service).not.toMatch(
      /Number\((?:request|allocation|replay|concurrentReplay)\.(?:id|counter_sale_id)\)/,
    );
  });

  test('publishes canonical signed-64 identifier schemas for paths and responses', () => {
    const assertCanonicalIdSchema = (schema) => {
      expect(schema).toMatchObject({
        type: 'string',
        pattern: '^[1-9][0-9]{0,18}$',
        minLength: 1,
        maxLength: 19,
        'x-maximum': '9223372036854775807',
      });
      expect(schema.description).toMatch(/signed 64-bit|canonical/i);
    };

    assertCanonicalIdSchema(schemas.PharmacyCounterSale.properties.id);
    assertCanonicalIdSchema(schemas.PharmacyCounterSale.properties.void_request_id);
    assertCanonicalIdSchema(schemas.PharmacyCounterSaleAllocation.properties.id);
    assertCanonicalIdSchema(schemas.PharmacyCounterSaleVoidTask.properties.id);
    assertCanonicalIdSchema(schemas.PharmacyCounterSaleVoidTask.properties.counter_sale_id);
    assertCanonicalIdSchema(
      schemas.PharmacyCounterSaleVoidAction.properties.counter_sale_void_request_id,
    );
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      assertCanonicalIdSchema(
        operations[`GET ${prefix}/counter-sales/{id}`].pathParameters.id,
      );
      assertCanonicalIdSchema(
        operations[`POST ${prefix}/counter-sales/{id}/void`].pathParameters.id,
      );
    }
  });

  test('canonicalizes every counter-sale mutation across both router aliases', () => {
    expect(routes).toContain(
      "COUNTER_SALE_IDEMPOTENCY_BASE = '/api/v1/pharmacy-orders/counter-sales'",
    );
    expect(routes).not.toContain('originalUrl');
    expect(routes).toContain("raw.replace(/^0+(?=\\d)/, '')");
    expect(routes.match(/requestPathForIdempotency:/g)).toHaveLength(6);
    expect(routes).toContain("requestPathForIdempotency: counterSaleMutationPath(),");
    expect(routes).toContain("requestPathForIdempotency: counterSaleIdMutationPath('void'),");
    expect(routes).toContain(
      "requestPathForIdempotency: counterSaleIdMutationPath('void/reconcile')",
    );
    expect(routes).toContain(
      "requestPathForIdempotency: counterSaleIdMutationPath('void/rejection/resolve')",
    );
  });

  test('keeps pharmacy out of approval/payout and gates restock on exact paid evidence', () => {
    expect(service).not.toMatch(/\bapproveRefund\s*\(/);
    expect(service).not.toMatch(/\bmarkRefundPaid\s*\(/);
    const payoutRoles = service.match(/const VOID_PAYOUT_ROLES = \[[\s\S]*?\];/)?.[0];
    expect(payoutRoles).toContain('FINANCE_INCHARGE');
    expect(payoutRoles).not.toMatch(/'ADMIN'|'SUPER_ADMIN'/);
    expect(service).toContain('counter_sale_void_has_paid_evidence($1::bigint)');
    expect(service).toContain("reference_type: 'pharmacy_counter_sale_void'");
    expect(service).toContain("status = 'VOIDED'");
    expect(service).toContain("status = 'REFUND_REJECTED_REVIEW'");
    expect(service).toContain('/billing/refunds?refund_id=');
    expect(service).toContain('/pharmacy?tab=counter-sales&sale_id=');
    expect(service.match(/action_label_key:/g)).toHaveLength(3);
    expect(service.match(/VOID_FINANCE_ACTION_LABEL_KEY/g)).toHaveLength(3);
    expect(service.match(/VOID_RECONCILIATION_ACTION_LABEL_KEY/g)).toHaveLength(3);
    expect(service).toContain("'s4.lib.counter_sale.open_finance_workflow'");
    expect(service).toContain("'s4.lib.counter_sale.open_reconciliation'");
  });

  test('migration makes the obligation tenant-bound, exclusive, guarded, and runtime least-privilege', () => {
    expect(migration).toContain('CREATE TABLE pharmacy_counter_sale_void_requests');
    expect(migration).toContain('ux_counter_sale_void_request_tenant_id');
    expect(migration).toContain('fk_counter_sale_void_sale_tenant');
    expect(migration).toContain('fk_counter_sale_void_invoice_tenant');
    expect(migration).toContain('fk_counter_sale_void_patient_tenant');
    expect(migration).toContain('counter_sale_void_request_id');
    expect(migration).toContain('CREATE UNIQUE INDEX ux_billing_refund_counter_sale_void_request');
    expect(migration).toContain('counter_sale_void_has_paid_evidence');
    expect(migration).toContain("current_setting('app.audit_bypass', TRUE) = 'on'");
    expect(migration).toContain('NEW.requested_at := transaction_timestamp()');
    expect(migration).toContain('NEW.created_at := NEW.requested_at');
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE');
    expect(migration).toContain('counter_sale_void_stock_return_guard');
    expect(migration).toContain('counter_sale_void_allocation_return_guard');
    expect(migration).toContain('payment_gateway_refunds');
    expect(migration).toContain("execution.status = 'processed'");
    expect(migration).toContain('JOIN payment_gateway_orders gateway_order');
    expect(migration).toContain('gateway_order.billing_payment_id');
    expect(migration).toContain('payment.reference = sale.payment_reference');
    expect(migration).toContain('payment.reference = execution.provider_payment_id');
    expect(migration).toContain('billing_refund_offline_electronic_evidence');
    expect(migration).toContain('original_payment_id');
    expect(migration).toContain('original_advance_id IS NULL');
    expect(migration).toContain(
      'counter-sale offline electronic payout does not match the original sale receipt',
    );
    expect(migration.match(/sale\.payment_reference = payment\.reference/g)).toHaveLength(2);
    expect(migration).toContain('AND payment.patient_uid = $12::uuid');
    expect(migration).toContain(
      'RENAME TO care_pathway_assert_task_sla_source_binding_pre_746',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_source_binding',
    );
    expect(migration).toContain(
      'RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_746',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_completion_receipt',
    );
    expect(migration).toContain(
      'terminal counter-sale void task lacks its exact domain receipt',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) TO %I',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_source_binding_pre_746(UUID, INTEGER) TO %I',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) TO %I',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.care_pathway_assert_task_sla_completion_receipt_pre_746(UUID, INTEGER) TO %I',
    );
    expect(migration).toContain(
      'REVOKE ALL PRIVILEGES ON FUNCTION care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM PUBLIC',
    );
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT INSERT (tenant_id, counter_sale_id');
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON FUNCTION public.counter_sale_void_refund_guard()');
  });

  test('documents substantive status/reconcile semantics and 202 pending on both aliases', () => {
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const status = operations[`GET ${prefix}/counter-sales/{id}/void-status`];
      const initiate = operations[`POST ${prefix}/counter-sales/{id}/void`];
      const reconcile = operations[`POST ${prefix}/counter-sales/{id}/void/reconcile`];
      expect(status.description.length).toBeGreaterThan(80);
      expect(status.description).toMatch(/refund|obligation|payout/i);
      expect(initiate.responseStatus).toBe(202);
      expect(initiate.description.length).toBeGreaterThan(80);
      expect(reconcile.description.length).toBeGreaterThan(80);
      expect(reconcile.description).toMatch(/paid|evidence|restock/i);
    }
    expect(schemas.PharmacyCounterSaleVoidResult.required).toEqual(
      expect.arrayContaining(['workflow_status', 'void_request', 'refund', 'actions']),
    );
  });
});
