// src/tests/unit/paymentGatewayService.test.js
//
// paymentGatewayService with mocked persistence + billing:
//   * config gate OFF behavior — every leg of the effective-enablement AND
//     (env kill switch, tenant setting, enabled config row) 403s with
//     PAYMENT_GATEWAY_DISABLED;
//   * order creation through the dry_run adapter (no credentials, no HTTP);
//   * capture booking — collectPayment joins the SAME tx with
//     reference = provider_payment_id; the order paid-flip carries the
//     booked billing_payment_id; replays never book twice;
//   * business booking failures park as requires_reconciliation.
// Real-database proof of the same invariants: paymentGatewayCapture.deep.test.js.

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn(async () => 1);
const txQueryRawUnsafe = jest.fn();
const txExecuteRawUnsafe = jest.fn(async () => 1);
const tx = { $queryRawUnsafe: txQueryRawUnsafe, $executeRawUnsafe: txExecuteRawUnsafe };
const setTenantTx = jest.fn(async (_tenant, fn) => fn(tx));

const collectPayment = jest.fn(async () => ({ id: 77, amount: 500, mode: 'UPI' }));
const markRefundPaid = jest.fn(async () => ({ id: 9 }));
const deriveInvoicePaymentStateFromLedgerTx = jest.fn(async () => {});
const getPaymentGatewaySettings = jest.fn(async () => ({ enabled: true }));
const resolveLedgerWiring = jest.fn(async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }));
const postPaymentEntry = jest.fn(async () => ({ entryId: 1 }));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe },
  prismaReadOnly: { $queryRawUnsafe: queryRawUnsafe },
  setTenant: jest.fn(),
  setTenantTx,
}));
jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  collectPayment,
  markRefundPaid,
  deriveInvoicePaymentStateFromLedgerTx,
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getPaymentGatewaySettings,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (id) => {
    if (!id) throw new Error('tenant required');
    return String(id);
  },
}));
jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring,
}));
jest.unstable_mockModule('../../services/billing/ledger/ledgerPostings.js', () => ({
  postPaymentEntry,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const gateway = await import('../../services/billing/paymentGatewayService.js');

const enabledConfig = {
  id: 3, tenant_id: TENANT, provider: 'dry_run', environment: 'sandbox',
  enabled: true, key_id: null, key_secret_ciphertext: null,
  webhook_secret_ciphertext: null, accepted_methods: ['upi', 'card'],
  metadata: { webhook_token: 'test-webhook-token-000000000000' },
};

const ISSUED_INVOICE = { id: 12, patient_uid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'ISSUED', amount_due: '500.00' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PAYMENT_GATEWAY_ENABLED = 'true';
  getPaymentGatewaySettings.mockResolvedValue({ enabled: true });
  resolveLedgerWiring.mockResolvedValue({ mode: 'shadow', sameTx: false, postCommit: true, skip: false });
  collectPayment.mockResolvedValue({ id: 77, amount: 500, mode: 'UPI' });
});

afterAll(() => { delete process.env.PAYMENT_GATEWAY_ENABLED; });

describe('config gate — DEFAULT OFF, all three legs required', () => {
  it('403 PAYMENT_GATEWAY_DISABLED when the env kill switch is off', async () => {
    delete process.env.PAYMENT_GATEWAY_ENABLED;
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12 }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_GATEWAY_DISABLED' });
    // Gate short-circuits before any DB read.
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('403 when the tenant setting is disabled (strict boolean)', async () => {
    getPaymentGatewaySettings.mockResolvedValue({ enabled: false });
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12 }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_GATEWAY_DISABLED' });
  });

  it('403 when no enabled provider config row exists', async () => {
    queryRawUnsafe.mockResolvedValue([]); // config lookup
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12 }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_GATEWAY_DISABLED' });
  });

  it('resolveGatewayContext reports the failing leg without throwing (marker reads)', async () => {
    delete process.env.PAYMENT_GATEWAY_ENABLED;
    expect(await gateway.resolveGatewayContext(TENANT)).toEqual({ enabled: false, reason: 'env_disabled', config: null });
    process.env.PAYMENT_GATEWAY_ENABLED = 'true';
    getPaymentGatewaySettings.mockResolvedValue({ enabled: false });
    expect((await gateway.resolveGatewayContext(TENANT)).reason).toBe('tenant_disabled');
  });

  it('public /pay gateway view renders the disabled marker instead of throwing', async () => {
    delete process.env.PAYMENT_GATEWAY_ENABLED;
    expect(await gateway.getPublicGatewayViewForLink({ tenantId: TENANT, paymentLinkId: 1 })).toEqual({
      enabled: false, provider: null, keyId: null, providerOrderId: null,
    });
  });
});

describe('order creation (dry_run adapter — zero credentials)', () => {
  it('creates a provider order for an ISSUED invoice and persists the row with explicit tenant', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])   // enabled config
      .mockResolvedValueOnce([ISSUED_INVOICE])  // invoice subject
      .mockImplementationOnce(async (sql, ...params) => [{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        amount: '500.00', currency: 'INR',
        receipt: params[9], provider_order_id: params[10],
        status: 'created', invoice_id: 12, payment_link_id: null,
        expires_at: new Date(),
      }]);

    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: 12, created_by: ISSUED_INVOICE.patient_uid,
      actor: { uid: ISSUED_INVOICE.patient_uid, role: 'PATIENT' },
    });

    expect(order.provider).toBe('dry_run');
    expect(order.providerOrderId).toBe(`order_dry_${order.providerOrderId.slice('order_dry_'.length)}`);
    expect(order.providerOrderId.startsWith('order_dry_pg-')).toBe(true);
    expect(order.amount).toBe(500);

    const insertCall = queryRawUnsafe.mock.calls[2];
    expect(insertCall[0]).toContain('INSERT INTO payment_gateway_orders');
    expect(insertCall[1]).toBe(TENANT); // tenant_id written explicitly
  });

  it('blocks a PATIENT from paying another patient’s invoice', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])
      .mockResolvedValueOnce([ISSUED_INVOICE]);
    await expect(gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: 12,
      actor: { uid: '99999999-9999-4999-8999-999999999999', role: 'PATIENT' },
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects an amount above the invoice due', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])
      .mockResolvedValueOnce([ISSUED_INVOICE]);
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12, amount: 600 }))
      .rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_AMOUNT_EXCEEDS_DUE' });
  });
});

describe('capture booking (payment.captured)', () => {
  const config = enabledConfig;
  const capturePayload = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_dry_9', order_id: 'order_dry_pg-x', method: 'upi', amount: 50000 } } },
  };
  const orderRow = {
    id: 21, tenant_id: TENANT, provider: 'dry_run', status: 'created',
    invoice_id: 12, payment_link_id: null,
    patient_uid: ISSUED_INVOICE.patient_uid, amount: '500.00', receipt: 'pg-x',
    provider_order_id: 'order_dry_pg-x',
  };

  it('books through collectPayment IN the tx with reference = provider_payment_id, then flips the order paid', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]); // FOR UPDATE lock
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 10, event_type: 'payment.captured' }, payload: capturePayload,
    });

    expect(result.outcome).toBe('captured');
    expect(result.billingPaymentId).toBe(77);
    // collectPayment joined OUR tx (second positional arg { tx }).
    expect(collectPayment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      invoice_id: 12,
      amount: 500,
      mode: 'UPI',
      reference: 'pay_dry_9',
    }), { tx });
    // Order flip in the same tx carries the booked billing_payments id.
    const flip = txExecuteRawUnsafe.mock.calls.find(([sql]) => sql.includes("status = 'paid'"));
    expect(flip).toBeTruthy();
    expect(flip.slice(1)).toEqual(['pay_dry_9', 77, 'upi', 21, TENANT]);
    // Shadow wiring → ledger PAYMENT posted post-commit best-effort.
    expect(postPaymentEntry).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });

  it('replays are a no-op: an already-paid order never books a second payment', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([{ ...orderRow, status: 'paid', billing_payment_id: 77 }]);
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 11, event_type: 'payment.captured' }, payload: capturePayload,
    });
    expect(result.outcome).toBe('replay');
    expect(collectPayment).not.toHaveBeenCalled();
    expect(txExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it('paise amount mismatch parks the order in requires_reconciliation, never paid', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]);
    queryRawUnsafe.mockResolvedValueOnce([{ id: 21 }]); // post-rollback order lookup
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 12, event_type: 'payment.captured' },
      payload: { ...capturePayload, payload: { payment: { entity: { ...capturePayload.payload.payment.entity, amount: 49999 } } } },
    });
    expect(result.outcome).toBe('requires_reconciliation');
    expect(collectPayment).not.toHaveBeenCalled();
    const parked = executeRawUnsafe.mock.calls.find(([sql]) => sql.includes("'requires_reconciliation'"));
    expect(parked).toBeTruthy();
  });

  it('a business booking failure (e.g. voided invoice) parks instead of swallowing into paid', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]);
    const { AppError } = await import('../../utils/AppError.js');
    collectPayment.mockRejectedValue(AppError.badRequest('Cannot collect against VOID invoice'));
    queryRawUnsafe.mockResolvedValueOnce([{ id: 21 }]);
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 13, event_type: 'payment.captured' }, payload: capturePayload,
    });
    expect(result.outcome).toBe('requires_reconciliation');
    const parked = executeRawUnsafe.mock.calls.find(([sql]) => sql.includes("'requires_reconciliation'"));
    expect(parked.slice(1)).toEqual(['pay_dry_9', expect.stringContaining('VOID'), 21, TENANT]);
  });
});

describe('refund.processed webhook', () => {
  it('drives markRefundPaid with reference = provider_refund_id, then marks the leg processed', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ // gateway refund row by provider_refund_id
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
      }])
      .mockResolvedValueOnce([{ id: 6 }]); // processed UPDATE returning
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: { id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9' } } } },
    });
    expect(result.outcome).toBe('refund_processed');
    expect(markRefundPaid).toHaveBeenCalledWith(9, expect.objectContaining({
      tenantId: TENANT, reference: 'rfnd_dry_pgr-9',
    }));
  });

  it('an already-processed execution row is a replay — billing authority untouched', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'processed', billing_refund_id: 9,
    }]);
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: { id: 'rfnd_dry_pgr-9' } } } },
    });
    expect(result.outcome).toBe('replay');
    expect(markRefundPaid).not.toHaveBeenCalled();
  });
});
