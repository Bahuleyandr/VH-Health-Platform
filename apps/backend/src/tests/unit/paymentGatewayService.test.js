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
const markGatewayRefundPaid = jest.fn(async () => ({ id: 9 }));
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
  markGatewayRefundPaid,
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

  it('keeps a live provider disabled until its webhook verification secret exists', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      ...enabledConfig,
      provider: 'razorpay',
      key_id: 'rzp_test',
      key_secret_ciphertext: 'enc:key',
      webhook_secret_ciphertext: null,
    }]);
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12 }))
      .rejects.toMatchObject({
        statusCode: 403,
        code: 'PAYMENT_GATEWAY_DISABLED',
        details: { reason: 'credentials_incomplete' },
      });
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

describe('webhook credential rotation', () => {
  it('keeps the stable token and prior encrypted secret for settlement-only callbacks', async () => {
    process.env.FIELD_ENCRYPTION_KEY = 'payment-gateway-test-field-key-32chars';
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        webhook_secret_ciphertext: 'encrypted-prior-secret',
        webhook_credential_version: 1,
        rotation_cutoff: '2026-08-17T08:00:00.000Z',
        metadata: { webhook_token: 'stable-webhook-token-0000000000', marker: 'preserved' },
      }])
      .mockResolvedValueOnce([{ ...enabledConfig, webhook_secret_ciphertext: 'encrypted-new-secret' }]);

    await gateway.upsertGatewayConfig({
      tenantId: TENANT,
      provider: 'dry_run',
      environment: 'sandbox',
      enabled: true,
      webhook_secret: 'replacement-webhook-secret',
      created_by: '11111111-1111-4111-8111-111111111111',
    });

    const metadata = JSON.parse(txQueryRawUnsafe.mock.calls[1][10]);
    expect(metadata).toEqual(expect.objectContaining({
      webhook_token: 'stable-webhook-token-0000000000',
      marker: 'preserved',
      webhook_secret_versions: [expect.objectContaining({
        version: 1,
        ciphertext: 'encrypted-prior-secret',
        retired_at: '2026-08-17T08:00:00.000Z',
      })],
    }));
    expect(txQueryRawUnsafe.mock.calls[1][12]).toBe(2);
    delete process.env.FIELD_ENCRYPTION_KEY;
  });
});

describe('late webhook intent binding', () => {
  it('binds a refund callback to the exact config, payment, billing refund, and nonterminal state', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ id: 7 }]);
    const allowed = await gateway.hasBoundNonterminalWebhookIntent({
      config: { ...enabledConfig, enabled: false },
      payload: { payload: { refund: { entity: {
        id: 'rfnd_R7',
        payment_id: 'pay_R9',
        notes: { billing_refund_id: '9' },
      } } } },
    });
    expect(allowed).toBe(true);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('o.provider_config_id = $4::int');
    expect(sql).toContain("r.status IN ('initiated', 'pending', 'requires_reconciliation')");
    expect(params).toEqual([
      TENANT, 'dry_run', 'sandbox', 3, 'rfnd_R7', 'pay_R9', 9, null, null,
    ]);
  });

  it('binds a retired secret only to the exact pre-rotation credential version', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ id: 7 }]);
    const retiredAt = new Date('2026-08-17T07:00:00.000Z');
    const allowed = await gateway.hasBoundNonterminalWebhookIntent({
      config: { ...enabledConfig, enabled: true, webhook_credential_version: 4 },
      credential: { current: false, version: 3, retiredAt },
      payload: { payload: { payment: { entity: { order_id: 'order_bound' } } } },
    });
    expect(allowed).toBe(true);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('webhook_credential_version = $6::int');
    expect(sql).toContain('created_at <= $7::timestamptz');
    expect(params).toEqual([
      TENANT, 'dry_run', 'sandbox', 3, 'order_bound', 3, retiredAt.toISOString(),
    ]);
  });

  it('rejects an uncorrelated payment callback', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(gateway.hasBoundNonterminalWebhookIntent({
      config: { ...enabledConfig, enabled: false },
      payload: { payload: { payment: { entity: { order_id: 'order_unknown' } } } },
    })).resolves.toBe(false);
  });
});

describe('order creation (dry_run adapter — zero credentials)', () => {
  it('creates a provider order for an ISSUED invoice and persists the row with explicit tenant', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])   // enabled config
      .mockResolvedValueOnce([ISSUED_INVOICE])  // invoice subject
      .mockImplementationOnce(async (sql, ...params) => [{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_config_id: 3, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '500.00', currency: 'INR',
        receipt: params[8], provider_order_id: null, inserted: true,
        status: 'created', invoice_id: 12, payment_link_id: null,
        created_by: params[10], webhook_credential_version: params[11],
        expires_at: new Date(),
      }])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_config_id: 3, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '500.00', currency: 'INR', receipt: 'pg-test',
        provider_order_id: params[0], status: 'created', invoice_id: 12,
        payment_link_id: null, expires_at: new Date(),
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
    expect(insertCall[0]).toContain('provider_order_id, status');
    expect(insertCall[0]).toContain("NULL, 'created'");
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

  it('fails closed when provider order evidence does not exactly bind the persisted intent', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createOrderSpy = jest.spyOn(razorpayAdapter, 'createOrder').mockResolvedValueOnce({
      providerOrderId: 'order_R_mismatch',
      amountPaise: 49999,
      currency: 'USD',
      receipt: 'wrong-receipt',
      status: 'attempted',
    });
    queryRawUnsafe
      .mockResolvedValueOnce([{
        ...enabledConfig,
        provider: 'razorpay',
        key_id: 'rzp_test',
        key_secret_ciphertext: 'test-key-secret',
        webhook_secret_ciphertext: 'test-webhook-secret',
      }])
      .mockResolvedValueOnce([ISSUED_INVOICE])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 31,
        provider: 'razorpay',
        environment: 'sandbox',
        provider_config_id: 3,
        patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '500.00',
        currency: 'INR',
        receipt: params[8],
        provider_order_id: null,
        inserted: true,
        status: 'created',
        invoice_id: 12,
        payment_link_id: null,
      }]);

    await expect(gateway.createGatewayOrder({
      tenantId: TENANT,
      invoice_id: 12,
      idempotency_key: 'strict-order-response',
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ORDER_EVIDENCE_MISMATCH' });
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      expect.stringContaining('amount'),
      31,
      TENANT,
    );
    createOrderSpy.mockRestore();
  });

  it('rejects a masked Razorpay order id even when every other provider field is exact', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createOrderSpy = jest.spyOn(razorpayAdapter, 'createOrder')
      .mockImplementationOnce(async args => ({
        providerOrderId: '***MASKED***',
        amountPaise: args.amountPaise,
        currency: args.currency,
        receipt: args.receipt,
        status: 'created',
      }));
    queryRawUnsafe
      .mockResolvedValueOnce([{
        ...enabledConfig,
        provider: 'razorpay',
        key_id: 'rzp_test',
        key_secret_ciphertext: 'test-key-secret',
        webhook_secret_ciphertext: 'test-webhook-secret',
      }])
      .mockResolvedValueOnce([ISSUED_INVOICE])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 32,
        provider: 'razorpay',
        environment: 'sandbox',
        provider_config_id: 3,
        patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '500.00',
        currency: 'INR',
        receipt: params[8],
        provider_order_id: null,
        inserted: true,
        status: 'created',
        invoice_id: 12,
        payment_link_id: null,
      }]);

    await expect(gateway.createGatewayOrder({
      tenantId: TENANT,
      invoice_id: 12,
      idempotency_key: 'masked-order-response',
    })).rejects.toMatchObject({
      code: 'PAYMENT_GATEWAY_ORDER_EVIDENCE_MISMATCH',
      details: { fields: ['order_id'] },
    });
    createOrderSpy.mockRestore();
  });
});

describe('capture booking (payment.captured)', () => {
  const config = enabledConfig;
  const capturePayload = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_dry_9', order_id: 'order_dry_pg-x', method: 'upi', amount: 50000, currency: 'INR' } } },
  };
  const orderRow = {
    id: 21, tenant_id: TENANT, provider: 'dry_run', status: 'created',
    invoice_id: 12, payment_link_id: null,
    patient_uid: ISSUED_INVOICE.patient_uid, amount: '500.00', receipt: 'pg-x',
    provider_order_id: 'order_dry_pg-x', currency: 'INR',
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
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        ...orderRow, status: 'paid', billing_payment_id: 77, provider_payment_id: 'pay_dry_9',
      }])
      .mockResolvedValueOnce([{
        id: 77, patient_uid: orderRow.patient_uid, invoice_id: orderRow.invoice_id,
        amount: '500.00', mode: 'UPI', reversed: false,
      }]);
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 11, event_type: 'payment.captured' }, payload: capturePayload,
    });
    expect(result.outcome).toBe('replay');
    expect(collectPayment).not.toHaveBeenCalled();
    expect(txExecuteRawUnsafe).not.toHaveBeenCalled();
    expect(postPaymentEntry).toHaveBeenCalledTimes(1);
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

  it('missing currency evidence parks the capture before collectPayment', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]);
    queryRawUnsafe.mockResolvedValueOnce([{ id: 21, status: 'created' }]);
    const entity = { ...capturePayload.payload.payment.entity };
    delete entity.currency;
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT,
      config,
      payload: { ...capturePayload, payload: { payment: { entity } } },
    });
    expect(result.outcome).toBe('requires_reconciliation');
    expect(collectPayment).not.toHaveBeenCalled();
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

  it('does not terminally park an enforce-mode ledger AppError', async () => {
    const { AppError } = await import('../../utils/AppError.js');
    resolveLedgerWiring.mockResolvedValueOnce({
      mode: 'enforce', sameTx: true, postCommit: false, skip: false,
    });
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]);
    postPaymentEntry.mockRejectedValueOnce(
      AppError.badRequest('Unknown ledger account code: BANK', 'LEDGER_BAD_ACCOUNT'),
    );

    await expect(gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 14, event_type: 'payment.captured' }, payload: capturePayload,
    })).rejects.toMatchObject({ code: 'LEDGER_BAD_ACCOUNT' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns a shadow-ledger failure for provider retry and re-drives it from the paid order', async () => {
    const { AppError } = await import('../../utils/AppError.js');
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]);
    postPaymentEntry.mockRejectedValueOnce(
      AppError.internal('Ledger persistence unavailable', 'LEDGER_WRITE_UNAVAILABLE'),
    );

    await expect(gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 15, event_type: 'payment.captured' }, payload: capturePayload,
    })).rejects.toMatchObject({ code: 'LEDGER_WRITE_UNAVAILABLE' });

    const bookedPayment = {
      id: 77, patient_uid: orderRow.patient_uid, invoice_id: orderRow.invoice_id,
      amount: '500.00', mode: 'UPI', reversed: false,
    };
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        ...orderRow, status: 'paid', billing_payment_id: 77, provider_payment_id: 'pay_dry_9',
      }])
      .mockResolvedValueOnce([bookedPayment]);
    postPaymentEntry.mockResolvedValueOnce({ entryId: 31 });

    const replay = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 16, event_type: 'payment.captured' }, payload: capturePayload,
    });
    expect(replay.outcome).toBe('replay');
    expect(collectPayment).toHaveBeenCalledTimes(1);
    expect(postPaymentEntry).toHaveBeenCalledTimes(2);
    expect(postPaymentEntry).toHaveBeenLastCalledWith({
      payment: bookedPayment, tenantId: TENANT,
    });
  });

  it('parks a duplicate payment reference collision instead of falsely acknowledging replay', async () => {
    const { AppError } = await import('../../utils/AppError.js');
    txQueryRawUnsafe.mockResolvedValueOnce([orderRow]);
    collectPayment.mockRejectedValueOnce(AppError.conflict(
      'A payment with this reference already exists',
      'DUPLICATE_PAYMENT_REFERENCE',
    ));
    queryRawUnsafe.mockResolvedValueOnce([{ id: 21, status: 'created' }]);

    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { id: 17, event_type: 'payment.captured' }, payload: capturePayload,
    });
    expect(result).toMatchObject({
      outcome: 'requires_reconciliation', orderId: 21, reason: 'DUPLICATE_PAYMENT_REFERENCE',
    });
    const parked = executeRawUnsafe.mock.calls.find(([sql]) => sql.includes("'requires_reconciliation'"));
    expect(parked.slice(1)).toEqual([
      'pay_dry_9', expect.stringContaining('DUPLICATE_PAYMENT_REFERENCE'), 21, TENANT,
    ]);
  });
});

describe('refund initiation (double-execution guard)', () => {
  it('short-circuits to the existing live execution leg WITHOUT re-calling the provider or inserting', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]); // gate: enabled config
    txQueryRawUnsafe
      .mockResolvedValueOnce([{ // billing_refunds FOR UPDATE
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: null, approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([{ // existing live execution leg
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, gateway_order_id: 21, amount: '150.00',
        provider_refund_id: 'rfnd_dry_pgr-9',
      }]);

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    });
    expect(result.replay).toBe(true);
    expect(result.id).toBe(6);
    // A completed provider leg never re-enters provider execution.
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE');
    const insertCall = txQueryRawUnsafe.mock.calls.find(([sql]) => sql.includes('INSERT INTO payment_gateway_refunds'));
    expect(insertCall).toBeUndefined();
  });

  it('commits a durable intent before provider execution, then records provider evidence separately', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{ // billing_refunds FOR UPDATE
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'dup charge', approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([]) // no live execution leg
      .mockResolvedValueOnce([{ // exact paid gateway order + payment + config
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        payment_invoice_id: 12, payment_patient_uid: ISSUED_INVOICE.patient_uid,
        payment_mode: 'UPI', config_provider: 'dry_run', config_environment: 'sandbox',
        key_id: null, key_secret_ciphertext: null,
      }])
      .mockResolvedValueOnce([{ refunded_amount: '0' }])
      .mockImplementationOnce(async (sql, ...params) => {
        expect(sql).toContain('INSERT INTO payment_gateway_refunds');
        return [{
          id: 7, tenant_id: TENANT, provider: 'dry_run', status: 'initiated',
          billing_refund_id: 9, gateway_order_id: 21, amount: '150.00', currency: 'INR',
          provider_payment_id: 'pay_dry_9', provider_idempotency_key: params[6],
        }];
      })
      .mockImplementationOnce(async (sql, ...params) => {
        expect(sql).toContain('UPDATE payment_gateway_refunds');
        expect(sql).not.toContain("status = 'requires_reconciliation'");
        return [{
          id: 7, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
          billing_refund_id: 9, gateway_order_id: 21, amount: '150.00', currency: 'INR',
          provider_payment_id: 'pay_dry_9', provider_refund_id: params[0],
          provider_idempotency_key: params[4],
        }];
      });

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    });
    expect(result.replay).toBe(false);
    expect(result.id).toBe(7);
    // dry_run adapter derived the deterministic provider refund id.
    expect(result.provider_refund_id).toMatch(/^rfnd_dry_pgr-[a-f0-9]{32}$/);
    expect(result.provider_idempotency_key).toBeUndefined();
    const intentInsert = txQueryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO payment_gateway_refunds')
    ));
    expect(intentInsert[7]).toMatch(/^pgr_[0-9a-f]{32}$/);
    const sourceLookup = txQueryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('JOIN payment_gateway_provider_configs')
    ));
    expect(sourceLookup[0]).toContain('bp.reversed = false');
    expect(sourceLookup[0]).toContain('pc.enabled = true');
    expect(sourceLookup.slice(1)).toEqual([21, TENANT]);
    expect(setTenantTx).toHaveBeenCalledTimes(2);
  });

  it('parks an irreversible provider response whose payment, amount, or currency do not match the intent', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createRefundSpy = jest.spyOn(razorpayAdapter, 'createRefund').mockResolvedValueOnce({
      providerRefundId: 'rfnd_R_mismatch',
      providerPaymentId: 'pay_wrong',
      amountPaise: 14999,
      currency: 'USD',
      status: 'pending',
    });
    queryRawUnsafe.mockResolvedValueOnce([{
      ...enabledConfig,
      provider: 'razorpay',
      key_id: 'rzp_test',
      key_secret_ciphertext: 'test-key-secret',
      webhook_secret_ciphertext: 'test-webhook-secret',
    }]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'duplicate charge', approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'razorpay', environment: 'sandbox',
        provider_payment_id: 'pay_R9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        payment_invoice_id: 12, payment_patient_uid: ISSUED_INVOICE.patient_uid,
        payment_mode: 'UPI', config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: 'test-key-secret',
      }])
      .mockResolvedValueOnce([{ refunded_amount: '0' }])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 10, tenant_id: TENANT, provider: 'razorpay', status: 'initiated',
        billing_refund_id: 9, gateway_order_id: 21, amount: '150.00', currency: 'INR',
        provider_payment_id: 'pay_R9', provider_idempotency_key: params[6],
      }])
      .mockImplementationOnce(async (sql, ...params) => {
        expect(sql).toContain("status = 'requires_reconciliation'");
        return [{
          id: 10, tenant_id: TENANT, provider: 'razorpay',
          status: 'requires_reconciliation', billing_refund_id: 9,
          gateway_order_id: 21, amount: '150.00', currency: 'INR',
          provider_payment_id: 'pay_R9', provider_refund_id: params[0],
          provider_idempotency_key: params[4],
        }];
      });

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    });

    expect(result).toMatchObject({ status: 'requires_reconciliation' });
    expect(result.provider_idempotency_key).toBeUndefined();
    expect(createRefundSpy).toHaveBeenCalledTimes(1);
    createRefundSpy.mockRestore();
  });

  it('rejects a refund whose approved payer or mode differs from the selected payment', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'CASH',
        reason: 'dup charge', approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        payment_invoice_id: 12, payment_patient_uid: ISSUED_INVOICE.patient_uid,
        payment_mode: 'UPI', config_provider: 'dry_run', config_environment: 'sandbox',
      }]);
    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_SOURCE_MISMATCH' });
    expect(txQueryRawUnsafe.mock.calls.some(([sql]) => sql.includes('INSERT INTO payment_gateway_refunds')))
      .toBe(false);
  });

  it('rejects a cumulative refund that exceeds the capture by exactly one paisa', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '0.02',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'one paisa over', approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '100.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        payment_invoice_id: 12, payment_patient_uid: ISSUED_INVOICE.patient_uid,
        payment_mode: 'UPI', config_provider: 'dry_run', config_environment: 'sandbox',
      }])
      .mockResolvedValueOnce([{ refunded_amount: '99.99' }]);

    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_EXCEEDS_CAPTURE' });
    expect(txQueryRawUnsafe.mock.calls.some(([sql]) => sql.includes('INSERT INTO payment_gateway_refunds')))
      .toBe(false);
  });

  it('retries an initiated intent with its persisted request body and provider key', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createRefundSpy = jest.spyOn(razorpayAdapter, 'createRefund').mockRejectedValueOnce({
      code: 'PAYMENT_GATEWAY_REFUND_IN_PROGRESS', statusCode: 409,
    });
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '50.00', reason: 'partial', mode: 'UPI', approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([{
        id: 8, provider: 'razorpay', environment: 'sandbox', status: 'initiated',
        billing_refund_id: 9, gateway_order_id: 21, amount: '40.00',
        provider_payment_id: 'pay_R9', provider_idempotency_key: 'pgr-persisted-replay-key',
      }])
      .mockResolvedValueOnce([{
        id: 21, provider: 'razorpay', environment: 'sandbox', provider_payment_id: 'pay_R9',
        amount: '500.00', invoice_id: 12, patient_uid: ISSUED_INVOICE.patient_uid,
        payment_invoice_id: 12, payment_patient_uid: ISSUED_INVOICE.patient_uid,
        payment_mode: 'UPI', config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: null,
      }]);

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    });
    expect(result).toMatchObject({ id: 8, status: 'initiated', replay: true });
    expect(result.provider_idempotency_key).toBeUndefined();
    expect(createRefundSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerPaymentId: 'pay_R9',
      amountPaise: 4000,
      receipt: expect.stringMatching(/^pgr-[a-f0-9]{32}$/),
      notes: { billing_refund_id: '9' },
      idempotencyKey: 'pgr-persisted-replay-key',
    }));
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    createRefundSpy.mockRestore();
  });

  it('immediately finalizes billing when the provider create response is already processed', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createRefundSpy = jest.spyOn(razorpayAdapter, 'createRefund').mockResolvedValueOnce({
      providerRefundId: 'rfnd_Rprocessed',
      providerPaymentId: 'pay_R9',
      amountPaise: 15000,
      currency: 'INR',
      status: 'processed',
    });
    const intentRow = {
      id: 10,
      tenant_id: TENANT,
      provider: 'razorpay',
      environment: 'sandbox',
      status: 'initiated',
      billing_refund_id: 9,
      gateway_order_id: 21,
      amount: '150.00',
      currency: 'INR',
      provider_payment_id: 'pay_R9',
      provider_refund_id: null,
      provider_idempotency_key: 'pgr-immediate-processed-key',
    };
    queryRawUnsafe
      .mockResolvedValueOnce([{
        ...enabledConfig,
        provider: 'razorpay',
        key_id: 'rzp_test',
        key_secret_ciphertext: 'test-key-secret',
        webhook_secret_ciphertext: 'test-webhook-secret',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([intentRow])
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce([{
        ...intentRow,
        status: 'processed',
        provider_refund_id: 'rfnd_Rprocessed',
      }]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'immediate provider processing', approval_status: 'APPROVED',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'razorpay', environment: 'sandbox',
        provider_payment_id: 'pay_R9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        payment_invoice_id: 12, payment_patient_uid: ISSUED_INVOICE.patient_uid,
        payment_mode: 'UPI', config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: 'test-key-secret',
      }])
      .mockResolvedValueOnce([{ refunded_amount: '0' }])
      .mockResolvedValueOnce([intentRow]);

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
    });
    expect(result).toMatchObject({ status: 'processed', provider_refund_id: 'rfnd_Rprocessed' });
    expect(markGatewayRefundPaid).toHaveBeenCalledWith(9, expect.objectContaining({
      tenantId: TENANT,
      provider_refund_id: 'rfnd_Rprocessed',
    }));
    createRefundSpy.mockRestore();
  });
});

describe('refund.processed webhook', () => {
  it('never correlates a refund by provider payment id alone', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_unknown', payment_id: 'pay_shared_by_partial_refunds',
      } } } },
    });
    expect(result).toEqual({ outcome: 'ignored', reason: 'no matching gateway refund row' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });

  it('binds crash-window correlation to the billing refund note as well as payment id', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 6, status: 'processed', billing_refund_id: 9 }]);
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_late', payment_id: 'pay_shared', notes: { billing_refund_id: '9' },
      } } } },
    });
    expect(result.outcome).toBe('replay');
    expect(queryRawUnsafe.mock.calls[1][0]).toContain('billing_refund_id = $6::int');
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual([
      TENANT, 'dry_run', 'sandbox', 3, 'pay_shared', 9,
    ]);
  });

  it('drives the trusted gateway settlement path with exact provider evidence, then marks the leg processed', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ // gateway refund row by provider_refund_id
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
      }])
      .mockResolvedValueOnce([{ id: 6 }]); // processed UPDATE returning
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9', amount: 15000,
        currency: 'INR', status: 'processed', notes: { billing_refund_id: '9' },
      } } } },
    });
    expect(result.outcome).toBe('refund_processed');
    expect(markGatewayRefundPaid).toHaveBeenCalledWith(9, expect.objectContaining({
      tenantId: TENANT, gateway_refund_id: 6, provider_refund_id: 'rfnd_dry_pgr-9',
    }));
  });

  it.each([
    ['refund id', { id: 'rfnd_wrong' }],
    ['payment id', { payment_id: 'pay_wrong' }],
    ['amount', { amount: 14999 }],
    ['currency', { currency: 'USD' }],
  ])('parks a signed refund callback with mismatched %s without paying billing authority', async (_field, override) => {
    queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
      }])
      .mockResolvedValueOnce([{ id: 6 }]);
    const entity = {
      id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9', amount: 15000,
      currency: 'INR', status: 'processed', notes: { billing_refund_id: '9' },
      ...override,
    };

    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity } } },
    });

    expect(result).toMatchObject({ outcome: 'requires_reconciliation', gatewayRefundId: 6 });
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
    expect(queryRawUnsafe.mock.calls[1][0]).toContain("status = 'requires_reconciliation'");
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
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });
});

describe('refund.failed webhook', () => {
  const failedEntity = (overrides = {}) => ({
    id: 'rfnd_failed_9', payment_id: 'pay_dry_9', amount: 15000,
    currency: 'INR', status: 'failed', notes: { billing_refund_id: '9' },
    error_code: 'BAD_REQUEST_ERROR', error_description: 'provider rejected refund',
    ...overrides,
  });

  it('recovers the post-provider/pre-phase3 crash window by payment id plus billing refund note, then replays', async () => {
    const intent = {
      id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'initiated',
      billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
      provider_refund_id: null, amount: '150.00', currency: 'INR',
    };
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([intent])
      .mockResolvedValueOnce([{ id: 6 }])
      .mockResolvedValueOnce([{ ...intent, status: 'failed', provider_refund_id: 'rfnd_failed_9' }]);
    const input = {
      tenantId: TENANT, config: enabledConfig,
      event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: failedEntity() } } },
    };

    const first = await gateway.processWebhookEvent(input);
    const redelivery = await gateway.processWebhookEvent(input);

    expect(first).toMatchObject({ outcome: 'refund_failed_recorded', gatewayRefundId: 6 });
    expect(redelivery).toMatchObject({ outcome: 'replay', gatewayRefundId: 6 });
    expect(queryRawUnsafe.mock.calls[1][0]).toContain('billing_refund_id = $6::int');
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual([
      TENANT, 'dry_run', 'sandbox', 3, 'pay_dry_9', 9,
    ]);
    expect(queryRawUnsafe.mock.calls[2][0]).toContain("status = 'failed'");
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });

  it.each([
    ['refund id', { id: 'rfnd_wrong' }],
    ['payment id', { payment_id: 'pay_wrong' }],
    ['amount', { amount: 14999 }],
    ['currency', { currency: 'USD' }],
    ['billing refund id', { notes: { billing_refund_id: '10' } }],
    ['status', { status: 'processed' }],
  ])('parks signed failure evidence with mismatched %s for reconciliation', async (_field, override) => {
    queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_failed_9', amount: '150.00', currency: 'INR',
      }])
      .mockResolvedValueOnce([{ id: 6 }]);

    const result = await gateway.processWebhookEvent({
      tenantId: TENANT, config: enabledConfig,
      event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: failedEntity(override) } } },
    });

    expect(result).toMatchObject({ outcome: 'requires_reconciliation', gatewayRefundId: 6 });
    expect(queryRawUnsafe.mock.calls[1][0]).toContain("status = 'requires_reconciliation'");
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });
});
