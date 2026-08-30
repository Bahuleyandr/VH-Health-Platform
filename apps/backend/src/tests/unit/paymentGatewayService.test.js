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
const REFUND_RAISER = '11111111-1111-4111-8111-111111111111';
const REFUND_APPROVER = '22222222-2222-4222-8222-222222222222';
const REFUND_INITIATOR = '33333333-3333-4333-8333-333333333333';
const REFUND_APPROVED_AT = new Date('2026-08-20T08:00:00.000Z');
const REFUND_INITIATED_AT = new Date('2026-08-20T08:01:00.000Z');

const approvedRefundAuthority = {
  raised_by: REFUND_RAISER,
  approved_by: REFUND_APPROVER,
  approved_at: REFUND_APPROVED_AT,
  initiator_tenant_valid: true,
};

const storedInitiatorAuthority = {
  initiated_by: REFUND_INITIATOR,
  initiated_at: REFUND_INITIATED_AT,
  stored_initiator_tenant_valid: true,
};

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn(async () => 1);
const txQueryRawUnsafe = jest.fn();
const txExecuteRawUnsafe = jest.fn(async () => 1);
const tx = { $queryRawUnsafe: txQueryRawUnsafe, $executeRawUnsafe: txExecuteRawUnsafe };
const setTenantTx = jest.fn(async (_tenant, fn) => fn(tx));

const collectPayment = jest.fn(async () => ({ id: 77, amount: 500, mode: 'UPI' }));
const markGatewayRefundPaid = jest.fn(async () => ({
  id: 9,
  gateway_authority_transitioned: true,
}));
const deriveInvoicePaymentStateFromLedgerTx = jest.fn(async () => {});
const lockBillingRefundFundingAuthorityTx = jest.fn();
const getPaymentGatewaySettings = jest.fn(async () => ({ enabled: true }));
const resolveLedgerWiring = jest.fn(async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }));
const postPaymentEntry = jest.fn(async () => ({ entryId: 1 }));
const ensureGatewayRefundRecoveryObligation = jest.fn(async () => ({}));
const ensureGatewayRefundRecoveryObligationTx = jest.fn(async () => ({ row: {} }));
const projectGatewayRefundRecoveryTerminal = jest.fn(async () => ({}));
const requeueGatewayRefundAuthorityBlockedTx = jest.fn(async () => []);
const notificationQueue = jest.fn(async () => ({ id: 901 }));
const MERGE_STABILITY_LEASE = Object.freeze({ test: 'gateway-merge-stability' });
const lockTenantPatientMergeStability = jest.fn(async () => MERGE_STABILITY_LEASE);

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
  lockBillingRefundFundingAuthorityTx,
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
jest.unstable_mockModule('../../services/billing/gatewayRefundRecoveryService.js', () => ({
  ensureGatewayRefundRecoveryObligation,
  ensureGatewayRefundRecoveryObligationTx,
  projectGatewayRefundRecoveryTerminal,
  requeueGatewayRefundAuthorityBlockedTx,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: notificationQueue },
}));
jest.unstable_mockModule('../../utils/patientMergeStabilityLock.js', () => ({
  lockTenantPatientMergeStability,
}));

const gateway = await import('../../services/billing/paymentGatewayService.js');
const { getCurrentTenantId } = await import('../../lib/tenantContext.js');

const enabledConfig = {
  id: 3, tenant_id: TENANT, provider: 'dry_run', environment: 'sandbox',
  enabled: true, key_id: null, key_secret_ciphertext: null,
  webhook_secret_ciphertext: null, accepted_methods: ['upi', 'card'],
  metadata: { webhook_token: 'test-webhook-token-000000000000' },
};

const ISSUED_INVOICE = { id: 12, patient_uid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'ISSUED', amount_due: '500.00' };
const LOCKED_GATEWAY_PAYMENT = {
  id: 77,
  invoice_id: 12,
  patient_uid: ISSUED_INVOICE.patient_uid,
  amount: '500.00',
  mode: 'UPI',
  reference: 'pay_dry_9',
  reversed: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks() clears call records but does NOT drain queued
  // mockResolvedValueOnce values; without an explicit reset an unconsumed
  // once-value from one test leaks into the shared raw-query queue and is
  // returned to the next test. Reset the raw-query mocks and re-apply the
  // executeRawUnsafe defaults so every test starts from a clean queue.
  queryRawUnsafe.mockReset();
  txQueryRawUnsafe.mockReset();
  executeRawUnsafe.mockReset().mockImplementation(async () => 1);
  txExecuteRawUnsafe.mockReset().mockImplementation(async () => 1);
  process.env.PAYMENT_GATEWAY_ENABLED = 'true';
  getPaymentGatewaySettings.mockResolvedValue({ enabled: true });
  resolveLedgerWiring.mockResolvedValue({ mode: 'shadow', sameTx: false, postCommit: true, skip: false });
  collectPayment.mockResolvedValue({ id: 77, amount: 500, mode: 'UPI' });
  // The billing finalizer default has to survive the once-queue drain: reset
  // it back to the atomic gateway-authority contract rather than a bare id,
  // or every settlement below degrades to a replay.
  markGatewayRefundPaid.mockReset().mockResolvedValue({
    id: 9,
    gateway_authority_transitioned: true,
  });
  lockBillingRefundFundingAuthorityTx.mockReset().mockImplementation(async (
    fundingTx,
    { tenantId, refundId },
  ) => {
    const rows = await fundingTx.$queryRawUnsafe(
      `SELECT *
         FROM billing_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tenantId,
      Number(refundId),
    );
    const refund = rows[0];
    return {
      refund,
      parent: {
        id: refund?.invoice_id ?? refund?.advance_id,
        patient_uid: refund?.patient_uid,
      },
      storedPatientUid: refund?.patient_uid,
      fundingPatientUid: refund?.patient_uid,
    };
  });
  ensureGatewayRefundRecoveryObligation.mockReset().mockResolvedValue({});
  ensureGatewayRefundRecoveryObligationTx.mockReset().mockResolvedValue({ row: {} });
  projectGatewayRefundRecoveryTerminal.mockReset().mockResolvedValue({});
  requeueGatewayRefundAuthorityBlockedTx.mockReset().mockResolvedValue([]);
  notificationQueue.mockResolvedValue({ id: 901 });
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

  it('preserves tenant context across the public provider-config and order lookups', async () => {
    const observed = [];
    queryRawUnsafe
      .mockImplementationOnce(async (sql) => {
        observed.push(['config', getCurrentTenantId(), sql]);
        return [enabledConfig];
      })
      .mockImplementationOnce(async (sql) => {
        observed.push(['order', getCurrentTenantId(), sql]);
        return [{ provider_order_id: 'order_dry_public_1' }];
      });

    await expect(gateway.getPublicGatewayViewForLink({
      tenantId: TENANT,
      paymentLinkId: 41,
    })).resolves.toEqual({
      enabled: true,
      provider: 'dry_run',
      keyId: null,
      providerOrderId: 'order_dry_public_1',
    });
    expect(observed.map(([stage, tenant]) => [stage, tenant])).toEqual([
      ['config', TENANT],
      ['order', TENANT],
    ]);
    expect(observed[0][2]).toContain('payment_gateway_provider_configs');
    expect(observed[1][2]).toContain('payment_gateway_orders');
    expect(getCurrentTenantId()).toBeNull();
  });
});

describe('gateway refund reconciliation notification recovery', () => {
  const parked = {
    id: 31,
    billing_refund_id: 9,
    provider: 'dry_run',
    provider_payment_id: 'pay_dry_9',
    provider_refund_id: 'rfnd_dry_9',
    amount: '150.00',
    currency: 'INR',
    failure_code: 'billing_refund_finalize_failed',
    failure_reason: 'Provider succeeded but billing finalization failed',
    updated_at: new Date('2026-08-28T10:30:00.123Z'),
    notification_generation: '1787913000123',
  };

  it('queues one localized actionable intent for the active platform admin', async () => {
    txQueryRawUnsafe
      .mockResolvedValueOnce([parked])
      .mockResolvedValueOnce([{
        id: 71,
        uid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        role: 'SUPER_ADMIN',
        preferred_language: 'ml-IN',
      }]);

    const result = await gateway.sweepGatewayRefundReconciliationNotifications({
      tenantId: TENANT,
      limit: 25,
    });

    expect(result).toEqual({ scanned: 1, queued: 1, unassigned: 0 });
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain("outbox.recipient_id IS NOT NULL");
    expect(notificationQueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      type: 'GATEWAY_REFUND_RECONCILIATION',
      channel: 'inapp',
      recipientId: 71,
      sourceEventKey: 'gateway-refund-reconciliation:31:1787913000123',
      templateVersion: 'gateway-refund-reconciliation.v1',
      title: 'ദാതൃ റീഫണ്ടിന് പൊരുത്തപ്പെടുത്തൽ ആവശ്യമാണ്',
      data: expect.objectContaining({
        gateway_refund_id: 31,
        billing_refund_id: 9,
        route: '/billing/gateway-refund-reconciliation?refund_id=31',
        deep_link: '/billing/gateway-refund-reconciliation?refund_id=31',
        action_label_key: 'med03.notification.gateway_refund_reconciliation.action',
        recipient_role: 'SUPER_ADMIN',
        coverage_gap: false,
        presentation_locale: 'ml',
        presentations: expect.objectContaining({
          en: expect.any(Object),
          hi: expect.any(Object),
          ta: expect.any(Object),
          te: expect.any(Object),
          ml: expect.any(Object),
        }),
      }),
    }), { tx, strict: true });
  });

  it('persists a fail-visible unassigned intent when no administrator exists', async () => {
    txQueryRawUnsafe
      .mockResolvedValueOnce([parked])
      .mockResolvedValueOnce([]);

    await expect(gateway.sweepGatewayRefundReconciliationNotifications({
      tenantId: TENANT,
    })).resolves.toEqual({ scanned: 1, queued: 1, unassigned: 1 });
    expect(notificationQueue).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: null,
      data: expect.objectContaining({
        coverage_gap: true,
        delivery_coverage: 'unassigned',
        recipient_uid: null,
        recipient_role: null,
      }),
    }), { tx, strict: true });
  });

  it('does not query recipients or enqueue when no parked generation is missing', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([]);

    await expect(gateway.sweepGatewayRefundReconciliationNotifications({
      tenantId: TENANT,
    })).resolves.toEqual({ scanned: 0, queued: 0, unassigned: 0 });
    expect(txQueryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(notificationQueue).not.toHaveBeenCalled();
  });
});

describe('bounded gateway-order expiry sweep', () => {
  it('invokes only the parameterless owner routine and preserves the count contract', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ expired: 3 }]);

    await expect(gateway.expireStaleGatewayOrders()).resolves.toEqual({ expired: 3 });

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT public.sweep_expired_payment_gateway_orders() AS expired',
    );
    expect(executeRawUnsafe).not.toHaveBeenCalled();
    expect(setTenantTx).not.toHaveBeenCalled();
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

  it('requeues authority-blocked refunds when config is repaired even if the global sweep is inactive', async () => {
    process.env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED = 'false';
    txQueryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([enabledConfig]);

    try {
      await gateway.upsertGatewayConfig({
        tenantId: TENANT,
        provider: 'dry_run',
        environment: 'sandbox',
        enabled: true,
        created_by: REFUND_APPROVER,
      });

      expect(requeueGatewayRefundAuthorityBlockedTx).toHaveBeenCalledWith({
        tx,
        tenantId: TENANT,
        provider: 'dry_run',
        environment: 'sandbox',
        actorUid: REFUND_APPROVER,
      });
    } finally {
      delete process.env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED;
    }
  });

  it('rolls config enablement back when the same-transaction authority requeue fails', async () => {
    txQueryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([enabledConfig]);
    requeueGatewayRefundAuthorityBlockedTx.mockRejectedValueOnce(
      new Error('strict outbox unavailable'),
    );

    await expect(gateway.upsertGatewayConfig({
      tenantId: TENANT,
      provider: 'dry_run',
      environment: 'sandbox',
      enabled: true,
      created_by: REFUND_APPROVER,
    })).rejects.toThrow('strict outbox unavailable');

    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(requeueGatewayRefundAuthorityBlockedTx).toHaveBeenCalledWith(
      expect.objectContaining({ tx, tenantId: TENANT }),
    );
  });
});

describe('late webhook intent binding', () => {
  it('binds a refund callback to the exact config, payment, billing refund, and nonterminal state', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([{ id: 7 }]);
    const allowed = await gateway.hasBoundNonterminalWebhookIntent({
      config: { ...enabledConfig, enabled: false },
      payload: { payload: { refund: { entity: {
        id: 'rfnd_R7',
        payment_id: 'pay_R9',
        notes: { billing_refund_id: '9' },
      } } } },
    });
    expect(allowed).toBe(true);
    const [sql, ...params] = txQueryRawUnsafe.mock.calls[0];
    expect(sql).toContain('o.provider_config_id = $4::int');
    expect(sql).toContain("r.status IN ('initiated', 'pending', 'requires_reconciliation')");
    expect(params).toEqual([
      TENANT, 'dry_run', 'sandbox', 3, 'rfnd_R7', 'pay_R9', 9, null, null,
    ]);
  });

  it('binds a retired secret only to the exact pre-rotation credential version', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([{ id: 7 }]);
    const retiredAt = new Date('2026-08-17T07:00:00.000Z');
    const allowed = await gateway.hasBoundNonterminalWebhookIntent({
      config: { ...enabledConfig, enabled: true, webhook_credential_version: 4 },
      credential: { current: false, version: 3, retiredAt },
      payload: { payload: { payment: { entity: { order_id: 'order_bound' } } } },
    });
    expect(allowed).toBe(true);
    const [sql, ...params] = txQueryRawUnsafe.mock.calls[0];
    expect(sql).toContain('webhook_credential_version = $6::int');
    expect(sql).toContain('created_at <= $7::timestamptz');
    expect(params).toEqual([
      TENANT, 'dry_run', 'sandbox', 3, 'order_bound', 3, retiredAt.toISOString(),
    ]);
  });

  it('rejects an uncorrelated payment callback', async () => {
    txQueryRawUnsafe.mockResolvedValueOnce([]);
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

  it('rejects exactly one paisa above the invoice due', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])
      .mockResolvedValueOnce([ISSUED_INVOICE]);
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12, amount: 500.01 }))
      .rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_AMOUNT_EXCEEDS_DUE' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('rejects sub-paisa order amounts before persisting an intent', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])
      .mockResolvedValueOnce([ISSUED_INVOICE]);
    await expect(gateway.createGatewayOrder({ tenantId: TENANT, invoice_id: 12, amount: 100.001 }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PAYMENT_GATEWAY_BAD_AMOUNT' });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('preserves a legitimate two-decimal partial payment', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])
      .mockResolvedValueOnce([ISSUED_INVOICE])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 22, provider: 'dry_run', environment: 'sandbox',
        provider_config_id: 3, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '123.45', currency: 'INR', receipt: params[8],
        provider_order_id: null, inserted: true, status: 'created',
        invoice_id: 12, payment_link_id: null,
        created_by: params[10], webhook_credential_version: params[11],
        expires_at: new Date(),
      }])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 22, provider: 'dry_run', environment: 'sandbox',
        provider_config_id: 3, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '123.45', currency: 'INR', receipt: 'pg-partial',
        provider_order_id: params[0], status: 'created', invoice_id: 12,
        payment_link_id: null, expires_at: new Date(),
      }]);

    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: 12, amount: 123.45,
      created_by: ISSUED_INVOICE.patient_uid,
    });
    expect(order.amount).toBe(123.45);
    expect(queryRawUnsafe.mock.calls[2][8]).toBe(123.45);
  });

  it('accepts harmless numeric representation dust at the whole-paisa boundary', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([enabledConfig])
      .mockResolvedValueOnce([ISSUED_INVOICE])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 23, provider: 'dry_run', environment: 'sandbox',
        provider_config_id: 3, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '0.30', currency: 'INR', receipt: params[8],
        provider_order_id: null, inserted: true, status: 'created',
        invoice_id: 12, payment_link_id: null,
        created_by: params[10], webhook_credential_version: params[11],
        expires_at: new Date(),
      }])
      .mockImplementationOnce(async (_sql, ...params) => [{
        id: 23, provider: 'dry_run', environment: 'sandbox',
        provider_config_id: 3, patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '0.30', currency: 'INR', receipt: 'pg-dust',
        provider_order_id: params[0], status: 'created', invoice_id: 12,
        payment_link_id: null, expires_at: new Date(),
      }]);

    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: 12, amount: 0.1 + 0.2,
      created_by: ISSUED_INVOICE.patient_uid,
    });
    expect(order.amount).toBe(0.3);
    expect(queryRawUnsafe.mock.calls[2][8]).toBe(0.3);
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
    // collectPayment joins the merge-stable gateway transaction.
    expect(collectPayment).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      invoice_id: 12,
      amount: 500,
      mode: 'UPI',
      reference: 'pay_dry_9',
    }), { tx, mergeStabilityLease: MERGE_STABILITY_LEASE });
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

describe('gateway refund source selection', () => {
  it('returns only exact paid, enabled-provider sources with enough remaining capture', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9,
        invoice_id: 12,
        patient_uid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        amount: '125.00',
        mode: 'UPI',
        approval_status: 'APPROVED',
        payout_rail: null,
      }])
      .mockResolvedValueOnce([{
        gateway_order_id: 71,
        provider: 'dry_run',
        environment: 'sandbox',
        method: 'upi',
        amount: '500.00',
        refundable_amount: '375.00',
      }]);

    await expect(gateway.listGatewayRefundCandidates({
      tenantId: TENANT,
      billing_refund_id: 9,
    })).resolves.toEqual([expect.objectContaining({
      gateway_order_id: 71,
      refundable_amount: '375.00',
    })]);

    const [sql, ...params] = txQueryRawUnsafe.mock.calls[1];
    expect(sql).toContain("orders.status = 'paid'");
    expect(sql).toContain('config.enabled = TRUE');
    expect(sql).toContain('payments.reversed = FALSE');
    expect(sql).toContain('UPPER(payments.mode) = UPPER($4::text)');
    expect(sql).toContain('HAVING GREATEST');
    expect(params).toEqual([
      TENANT,
      12,
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'UPI',
      125,
    ]);
  });

  it('does not offer a gateway source after manual payout has claimed the refund', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe.mockResolvedValueOnce([{
      id: 9,
      invoice_id: 12,
      patient_uid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      amount: '125.00',
      mode: 'UPI',
      approval_status: 'APPROVED',
      payout_rail: 'manual',
    }]);

    await expect(gateway.listGatewayRefundCandidates({
      tenantId: TENANT,
      billing_refund_id: 9,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PAYMENT_GATEWAY_REFUND_PAYOUT_RAIL_CONFLICT',
    });
    expect(txQueryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('gateway refund reconciliation decisions', () => {
  const base = {
    tenantId: TENANT,
    id: 9,
    note: 'Provider support supplied attributable reconciliation evidence',
    evidence_reference: 'provider-case-9911',
    resolved_by: ISSUED_INVOICE.patient_uid,
  };

  it('requires an explicit terminal disposition', async () => {
    await expect(gateway.resolveGatewayRefundReconciliation(base)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_GATEWAY_REFUND_RECONCILIATION_DISPOSITION_REQUIRED',
    });
    expect(setTenantTx).not.toHaveBeenCalled();
  });

  it('requires a recovery path when the provider confirmed no refund', async () => {
    await expect(gateway.resolveGatewayRefundReconciliation({
      ...base,
      disposition: 'provider_not_refunded',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_GATEWAY_REFUND_RECOVERY_PATH_REQUIRED',
    });
    expect(setTenantTx).not.toHaveBeenCalled();
  });

  it('rejects the manual electronic payout escape hatch before any mutation', async () => {
    await expect(gateway.resolveGatewayRefundReconciliation({
      ...base,
      disposition: 'provider_not_refunded',
      recovery_path: 'manual_payout',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PAYMENT_GATEWAY_REFUND_MANUAL_PAYOUT_FORBIDDEN',
    });
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(txQueryRawUnsafe).not.toHaveBeenCalled();
    expect(txExecuteRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('refund initiation (double-execution guard)', () => {
  it('enforces the stacked 747+752 four-eyes contract before any provider call', async () => {
    const { default: dryRunAdapter } = await import(
      '../../services/billing/gatewayProviders/dryRunAdapter.js'
    );
    const createRefundSpy = jest.spyOn(dryRunAdapter, 'createRefund');
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe.mockResolvedValueOnce([{
      id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
      patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
      reason: 'independence check', approval_status: 'APPROVED',
      ...approvedRefundAuthority,
    }]);

    try {
      await expect(gateway.initiateGatewayRefund({
        tenantId: TENANT,
        billing_refund_id: 9,
        gateway_order_id: 21,
        initiated_by: REFUND_APPROVER,
      })).rejects.toMatchObject({
        code: 'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER',
      });
      expect(txQueryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(txQueryRawUnsafe.mock.calls[0][0]).not.toContain('FOR UPDATE');
      expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('approved_by');
      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(txQueryRawUnsafe.mock.calls.some(([sql]) => (
        sql.includes('INSERT INTO payment_gateway_refunds')
      ))).toBe(false);
    } finally {
      createRefundSpy.mockRestore();
    }
  });

  it('short-circuits to the existing live execution leg WITHOUT re-calling the provider or inserting', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]); // gate: enabled config
    txQueryRawUnsafe
      .mockResolvedValueOnce([{ // billing_refunds discovery
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: null, approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([{ // unlocked existing live execution discovery
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, gateway_order_id: 21, amount: '150.00',
        provider_refund_id: 'rfnd_dry_pgr-9',
        ...storedInitiatorAuthority,
      }])
      .mockResolvedValueOnce([{ // paid gateway order + config preflight
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'dry_run', config_environment: 'sandbox',
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, gateway_order_id: 21, amount: '150.00',
        provider_refund_id: 'rfnd_dry_pgr-9',
        ...storedInitiatorAuthority,
      }])
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, gateway_order_id: 21, amount: '150.00',
        provider_refund_id: 'rfnd_dry_pgr-9',
        ...storedInitiatorAuthority,
      }])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: null, approval_status: 'APPROVED', payout_rail: 'gateway',
        gateway_refund_id: 6,
        ...approvedRefundAuthority,
      }]);

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
    });
    expect(result.replay).toBe(true);
    expect(result.id).toBe(6);
    // A completed provider leg never re-enters provider execution.
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(txQueryRawUnsafe.mock.calls[0][0]).not.toContain('FOR UPDATE');
    const gatewayLock = txQueryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('FROM payment_gateway_refunds') && sql.includes('FOR UPDATE')
    ));
    expect(gatewayLock).toBeDefined();
    const insertCall = txQueryRawUnsafe.mock.calls.find(([sql]) => sql.includes('INSERT INTO payment_gateway_refunds'));
    expect(insertCall).toBeUndefined();
  });

  it('commits a durable intent before provider execution, then records provider evidence separately', async () => {
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{ // billing_refunds discovery
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'dup charge', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([]) // no live execution leg
      .mockResolvedValueOnce([{ // paid gateway order + config preflight
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'dry_run', config_environment: 'sandbox',
        key_id: null, key_secret_ciphertext: null,
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([]) // no serialized execution after the creation lock
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'dup charge', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([LOCKED_GATEWAY_PAYMENT])
      .mockResolvedValueOnce([{ refunded_amount: '0' }])
      .mockImplementationOnce(async (sql, ...params) => {
        expect(sql).toContain('INSERT INTO payment_gateway_refunds');
        return [{
          id: 7, tenant_id: TENANT, provider: 'dry_run', status: 'initiated',
          billing_refund_id: 9, gateway_order_id: 21, amount: '150.00', currency: 'INR',
          provider_payment_id: 'pay_dry_9', provider_idempotency_key: params[6],
          initiated_by: REFUND_INITIATOR, initiated_at: REFUND_INITIATED_AT,
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
          recovery_claim_token: '44444444-4444-4444-8444-444444444444',
          recovery_claimed_at: new Date('2026-08-20T08:02:00.000Z'),
          recovery_lease_expires_at: new Date('2026-08-20T08:07:00.000Z'),
        }];
      });

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
    });
    expect(result.replay).toBe(false);
    expect(result.id).toBe(7);
    // dry_run adapter derived the deterministic provider refund id.
    expect(result.provider_refund_id).toMatch(/^rfnd_dry_pgr-[a-f0-9]{32}$/);
    expect(result.provider_idempotency_key).toBeUndefined();
    expect(result.provider_request_replay_authorized).toBeUndefined();
    expect(result.recovery_claim_token).toBeUndefined();
    expect(result.recovery_claimed_at).toBeUndefined();
    expect(result.recovery_lease_expires_at).toBeUndefined();
    const intentInsert = txQueryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO payment_gateway_refunds')
    ));
    expect(intentInsert[7]).toMatch(/^pgr_[0-9a-f]{32}$/);
    expect(intentInsert[0]).toMatch(/provider_request_replay_authorized\)\s*VALUES[\s\S]*TRUE\)/);
    const sourceLookup = txQueryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('JOIN payment_gateway_provider_configs')
    ));
    expect(sourceLookup[0]).toContain('bp.reversed = false');
    expect(sourceLookup[0]).toContain('pc.enabled = true');
    expect(sourceLookup[0]).not.toContain('payment_invoice_id');
    expect(sourceLookup[0]).not.toContain('payment_patient_uid');
    expect(sourceLookup[0]).not.toContain('payment_mode');
    expect(sourceLookup.slice(1)).toEqual([21, TENANT]);
    const paymentLockIndex = txQueryRawUnsafe.mock.calls.findIndex(([sql]) => (
      sql.includes('FROM billing_payments') && sql.includes('FOR UPDATE')
    ));
    expect(paymentLockIndex).toBeGreaterThanOrEqual(0);
    expect(txQueryRawUnsafe.mock.calls[paymentLockIndex][0]).toContain('reversed = FALSE');
    expect(txQueryRawUnsafe.mock.calls[paymentLockIndex].slice(1)).toEqual([
      TENANT, 77, 12, ISSUED_INVOICE.patient_uid, 'UPI',
    ]);
    expect(lockBillingRefundFundingAuthorityTx.mock.invocationCallOrder[0])
      .toBeLessThan(txQueryRawUnsafe.mock.invocationCallOrder[paymentLockIndex]);
    expect(setTenantTx).toHaveBeenCalledTimes(2);
  });

  it('rejects when reversal invalidates the payment after gateway preflight but before intent creation', async () => {
    const { default: dryRunAdapter } = await import(
      '../../services/billing/gatewayProviders/dryRunAdapter.js'
    );
    const createRefundSpy = jest.spyOn(dryRunAdapter, 'createRefund');
    queryRawUnsafe.mockResolvedValueOnce([enabledConfig]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'reversal race', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'dry_run', config_environment: 'sandbox',
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'reversal race', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([]); // reversePayment committed before this exact row lock

    try {
      await expect(gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
        initiated_by: REFUND_INITIATOR,
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'PAYMENT_GATEWAY_REFUND_SOURCE_MISMATCH',
      });

      const paymentLockIndex = txQueryRawUnsafe.mock.calls.findIndex(([sql]) => (
        sql.includes('FROM billing_payments') && sql.includes('FOR UPDATE')
      ));
      const fundingRowLockIndex = txQueryRawUnsafe.mock.calls.findIndex(([sql]) => (
        sql.includes('FROM billing_refunds') && sql.includes('FOR UPDATE')
      ));
      expect(fundingRowLockIndex).toBeGreaterThanOrEqual(0);
      expect(paymentLockIndex).toBeGreaterThan(fundingRowLockIndex);
      expect(txQueryRawUnsafe.mock.calls[paymentLockIndex][0]).toContain(
        'tenant_id = $1::uuid AND id = $2::int',
      );
      expect(txQueryRawUnsafe.mock.calls[paymentLockIndex][0]).toContain(
        'invoice_id = $3::int AND patient_uid = $4::uuid',
      );
      expect(txQueryRawUnsafe.mock.calls[paymentLockIndex][0]).toContain(
        'UPPER(mode) = UPPER($5) AND reversed = FALSE',
      );
      expect(txQueryRawUnsafe.mock.calls[paymentLockIndex].slice(1)).toEqual([
        TENANT, 77, 12, ISSUED_INVOICE.patient_uid, 'UPI',
      ]);
      expect(createRefundSpy).not.toHaveBeenCalled();
      expect(txQueryRawUnsafe.mock.calls.some(([sql]) => (
        sql.includes('INSERT INTO payment_gateway_refunds')
      ))).toBe(false);
    } finally {
      createRefundSpy.mockRestore();
    }
  });

  it('parks an irreversible provider response whose payment, amount, or currency do not match the intent', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createRefundSpy = jest.spyOn(razorpayAdapter, 'createRefund').mockResolvedValueOnce({
      providerRefundId: 'rfnd_Rmismatch',
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
    const intentRow = {
      id: 10, tenant_id: TENANT, provider: 'razorpay', status: 'initiated',
      billing_refund_id: 9, gateway_order_id: 21, amount: '150.00', currency: 'INR',
      provider_payment_id: 'pay_R9', provider_idempotency_key: 'pgr-mismatch-key',
      initiated_by: REFUND_INITIATOR, initiated_at: REFUND_INITIATED_AT,
    };
    txQueryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('FROM billing_refunds')) return [{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'duplicate charge', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }];
      if (sql.includes('FROM payment_gateway_refunds refund')) return [];
      if (sql.includes('vh:payment_gateway_refund_creation:')) {
        return [{ lock_acquired: '1' }];
      }
      if (sql.includes('FROM payment_gateway_refunds execution')) return [];
      if (sql.includes('FROM payment_gateway_orders o')) return [{
        id: 21, provider: 'razorpay', environment: 'sandbox',
        provider_config_id: 3,
        provider_payment_id: 'pay_R9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: 'test-key-secret',
      }];
      if (sql.includes('FROM billing_payments')) {
        return [{ ...LOCKED_GATEWAY_PAYMENT, reference: 'pay_R9' }];
      }
      if (sql.includes('SELECT COALESCE(SUM(amount)')) return [{ refunded_amount: '0' }];
      if (sql.includes('INSERT INTO payment_gateway_refunds')) {
        return [{ ...intentRow, provider_idempotency_key: params[6] }];
      }
      throw new Error(`Unexpected refund initiation SQL: ${sql}`);
    });
    ensureGatewayRefundRecoveryObligation.mockResolvedValueOnce({
      ...intentRow,
      status: 'requires_reconciliation',
      provider_refund_id: 'rfnd_Rmismatch',
      failure_code: 'provider_evidence_mismatch',
      recovery_task_id: 41,
      recovery_sla_instance_id: '44444444-4444-4444-8444-444444444444',
    });

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
    });

    expect(result).toMatchObject({ status: 'requires_reconciliation' });
    expect(result.provider_idempotency_key).toBeUndefined();
    expect(ensureGatewayRefundRecoveryObligation).toHaveBeenCalledWith({
      tenantId: TENANT,
      gatewayRefundId: 10,
      parkFailure: {
        providerRefundId: 'rfnd_Rmismatch',
        code: 'provider_evidence_mismatch',
        reason: expect.stringContaining('payment_id, amount, currency'),
      },
      claimToken: null,
    });
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
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'dry_run', config_environment: 'sandbox',
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'CASH',
        reason: 'dup charge', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([]); // exact locked payment no longer matches the refund mode
    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
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
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'dry_run', environment: 'sandbox',
        provider_payment_id: 'pay_dry_9', amount: '100.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'dry_run', config_environment: 'sandbox',
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '0.02',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'one paisa over', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([{ ...LOCKED_GATEWAY_PAYMENT, amount: '100.00' }])
      .mockResolvedValueOnce([{ refunded_amount: '99.99' }]);

    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
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
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([{
        id: 8, provider: 'razorpay', environment: 'sandbox', status: 'initiated',
        billing_refund_id: 9, gateway_order_id: 21, amount: '40.00',
        provider_payment_id: 'pay_R9', provider_idempotency_key: 'pgr-persisted-replay-key',
        ...storedInitiatorAuthority,
      }])
      .mockResolvedValueOnce([{
        id: 21, provider: 'razorpay', environment: 'sandbox', provider_payment_id: 'pay_R9',
        amount: '500.00', invoice_id: 12, patient_uid: ISSUED_INVOICE.patient_uid,
        billing_payment_id: 77,
        config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: null,
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([{
        id: 8, provider: 'razorpay', environment: 'sandbox', status: 'initiated',
        billing_refund_id: 9, gateway_order_id: 21, amount: '40.00',
        provider_payment_id: 'pay_R9', provider_idempotency_key: 'pgr-persisted-replay-key',
        ...storedInitiatorAuthority,
      }])
      .mockResolvedValueOnce([{
        id: 8, provider: 'razorpay', environment: 'sandbox', status: 'initiated',
        billing_refund_id: 9, gateway_order_id: 21, amount: '40.00',
        provider_payment_id: 'pay_R9', provider_idempotency_key: 'pgr-persisted-replay-key',
        ...storedInitiatorAuthority,
      }])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null,
        patient_uid: ISSUED_INVOICE.patient_uid,
        amount: '50.00', reason: 'partial', mode: 'UPI', approval_status: 'APPROVED',
        payout_rail: 'gateway', gateway_refund_id: 8,
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([{ ...LOCKED_GATEWAY_PAYMENT, reference: 'pay_R9' }]);
    ensureGatewayRefundRecoveryObligation.mockResolvedValueOnce({
      id: 8,
      provider: 'razorpay',
      environment: 'sandbox',
      status: 'initiated',
      billing_refund_id: 9,
      gateway_order_id: 21,
      amount: '40.00',
      recovery_task_id: 73,
      recovery_sla_instance_id: '55555555-5555-4555-8555-555555555555',
    });

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
    });
    expect(result).toMatchObject({
      id: 8,
      status: 'initiated',
      replay: true,
      recovery_task_id: 73,
      recovery_sla_instance_id: '55555555-5555-4555-8555-555555555555',
    });
    expect(result.provider_idempotency_key).toBeUndefined();
    expect(createRefundSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerPaymentId: 'pay_R9',
      amountPaise: 4000,
      receipt: expect.stringMatching(/^pgr-[a-f0-9]{32}$/),
      notes: { billing_refund_id: '9' },
      idempotencyKey: 'pgr-persisted-replay-key',
    }));
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(ensureGatewayRefundRecoveryObligationTx).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      tenantId: TENANT,
      gatewayRefundId: 8,
    }));
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
      initiated_by: REFUND_INITIATOR,
      initiated_at: REFUND_INITIATED_AT,
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
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'razorpay', environment: 'sandbox',
        provider_config_id: 3,
        provider_payment_id: 'pay_R9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: 'test-key-secret',
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'immediate provider processing', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([{ ...LOCKED_GATEWAY_PAYMENT, reference: 'pay_R9' }])
      .mockResolvedValueOnce([{ refunded_amount: '0' }])
      .mockResolvedValueOnce([intentRow])
      .mockResolvedValueOnce([{
        ...intentRow,
        provider_refund_id: 'rfnd_Rprocessed',
      }])
      .mockResolvedValueOnce([{
        id: 9,
        approval_status: 'PAID',
        payout_rail: 'gateway',
        gateway_refund_id: 10,
        reference: 'rfnd_Rprocessed',
      }])
      .mockResolvedValueOnce([{
        ...intentRow,
        status: 'processed',
        provider_refund_id: 'rfnd_Rprocessed',
        processed_at: new Date('2026-08-27T10:00:00.000Z'),
      }]);

    const result = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
      initiated_by: REFUND_INITIATOR,
    });
    expect(result).toMatchObject({ status: 'processed', provider_refund_id: 'rfnd_Rprocessed' });
    expect(markGatewayRefundPaid).toHaveBeenCalledWith(9, expect.objectContaining({
      tenantId: TENANT,
      provider_refund_id: 'rfnd_Rprocessed',
    }));
    const sourceLookup = txQueryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('JOIN payment_gateway_provider_configs')
    ));
    expect(sourceLookup[0]).toContain('o.provider_config_id');
    const fallbackCorrelation = queryRawUnsafe.mock.calls.find(([sql]) => (
      sql.includes('refunds.provider_payment_id = $5')
    ));
    expect(fallbackCorrelation.slice(1)).toEqual([
      TENANT, 'razorpay', 'sandbox', 3, 'pay_R9', 9,
    ]);
    createRefundSpy.mockRestore();
  });

  it('parks a processed provider response when exact durable-intent correlation is unavailable', async () => {
    const { default: razorpayAdapter } = await import(
      '../../services/billing/gatewayProviders/razorpayAdapter.js'
    );
    const createRefundSpy = jest.spyOn(razorpayAdapter, 'createRefund').mockResolvedValueOnce({
      providerRefundId: 'rfnd_Runmatched',
      providerPaymentId: 'pay_R9',
      amountPaise: 15000,
      currency: 'INR',
      status: 'processed',
    });
    const intentRow = {
      id: 11, tenant_id: TENANT, provider: 'razorpay', environment: 'sandbox',
      status: 'initiated', billing_refund_id: 9, gateway_order_id: 21,
      amount: '150.00', currency: 'INR', provider_payment_id: 'pay_R9',
      provider_refund_id: null, provider_idempotency_key: 'pgr-unmatched-processed-key',
      initiated_by: REFUND_INITIATOR, initiated_at: REFUND_INITIATED_AT,
    };
    const parkedRow = {
      ...intentRow,
      status: 'requires_reconciliation',
      provider_refund_id: 'rfnd_Runmatched',
      failure_code: 'billing_refund_finalize_failed',
      recovery_task_id: 41,
      recovery_sla_instance_id: '44444444-4444-4444-8444-444444444444',
    };
    ensureGatewayRefundRecoveryObligation.mockResolvedValueOnce(parkedRow);
    queryRawUnsafe
      .mockResolvedValueOnce([{
        ...enabledConfig, provider: 'razorpay', key_id: 'rzp_test',
        key_secret_ciphertext: 'test-key-secret', webhook_secret_ciphertext: 'test-webhook-secret',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'provider success without correlation', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 21, provider: 'razorpay', environment: 'sandbox', provider_config_id: 3,
        provider_payment_id: 'pay_R9', amount: '500.00', invoice_id: 12,
        patient_uid: ISSUED_INVOICE.patient_uid, billing_payment_id: 77,
        config_provider: 'razorpay', config_environment: 'sandbox',
        key_id: 'rzp_test', key_secret_ciphertext: 'test-key-secret',
      }])
      .mockResolvedValueOnce([{ lock_acquired: '1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 9, invoice_id: 12, advance_id: null, amount: '150.00',
        patient_uid: ISSUED_INVOICE.patient_uid, mode: 'UPI',
        reason: 'provider success without correlation', approval_status: 'APPROVED',
        ...approvedRefundAuthority,
      }])
      .mockResolvedValueOnce([{ ...LOCKED_GATEWAY_PAYMENT, reference: 'pay_R9' }])
      .mockResolvedValueOnce([{ refunded_amount: '0' }])
      .mockResolvedValueOnce([intentRow]);

    try {
      const result = await gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: 9, gateway_order_id: 21,
        initiated_by: REFUND_INITIATOR,
      });
      expect(result).toMatchObject({
        id: 11,
        status: 'requires_reconciliation',
        provider_refund_id: 'rfnd_Runmatched',
        failure_code: 'billing_refund_finalize_failed',
        recovery_task_id: 41,
        recovery_sla_instance_id: '44444444-4444-4444-8444-444444444444',
      });
      expect(markGatewayRefundPaid).not.toHaveBeenCalled();
      expect(ensureGatewayRefundRecoveryObligation).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          gatewayRefundId: 11,
          parkFailure: expect.objectContaining({
            providerRefundId: 'rfnd_Runmatched',
            code: 'billing_refund_finalize_failed',
            reason: expect.stringContaining('PAYMENT_GATEWAY_REFUND_CORRELATION_FAILED'),
          }),
        }),
      );
    } finally {
      createRefundSpy.mockRestore();
    }
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
      .mockResolvedValueOnce([{
        id: 6,
        status: 'processed',
        billing_refund_id: 9,
        provider_refund_id: 'rfnd_late',
        processed_at: new Date('2026-08-27T10:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        approval_status: 'PAID', payout_rail: 'gateway',
        gateway_refund_id: 6, reference: 'rfnd_late',
      }]);
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
    const claimToken = '55555555-5555-4555-8555-555555555555';
    queryRawUnsafe
      .mockResolvedValueOnce([{ // gateway refund row by provider_refund_id
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
        recovery_state: 'claimed', recovery_claim_token: claimToken,
      }]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'processed',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
        processed_at: new Date('2026-08-27T10:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: 9, approval_status: 'PAID', payout_rail: 'gateway',
        gateway_refund_id: 6, reference: 'rfnd_dry_pgr-9',
      }])
      .mockResolvedValueOnce([{ id: 6, status: 'processed' }]);
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig, claimToken,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9', amount: 15000,
        currency: 'INR', status: 'processed', notes: { billing_refund_id: '9' },
      } } } },
    });
    expect(result.outcome).toBe('refund_processed');
    // Pinned to the exact merged-service payload: settleGatewayRefundProcessedEvidence
    // passes these four keys and nothing else. The recovery claim token rides into
    // the atomic billing finalizer instead of a service-side fenced UPDATE, so this
    // is the assertion that proves the claim fence reaches billing authority.
    expect(markGatewayRefundPaid).toHaveBeenCalledWith(9, {
      tenantId: TENANT,
      gateway_refund_id: 6,
      provider_refund_id: 'rfnd_dry_pgr-9',
      recovery_claim_token: claimToken,
    });
    expect(txQueryRawUnsafe.mock.calls[2][0]).toContain("AND status = 'processed'");
    expect(txQueryRawUnsafe.mock.calls[2][0]).toContain('AND provider_refund_id = $1::varchar');
    expect(txQueryRawUnsafe.mock.calls[2][0]).not.toContain("status IN ('initiated'");
    // The recovery claim fence owns the terminal flip: the claim token rides
    // into the atomic billing finalizer (asserted above) and the service never
    // writes the processed status itself, outside that fence.
    expect([...queryRawUnsafe.mock.calls, ...txQueryRawUnsafe.mock.calls].some(([sql]) => (
      sql.includes("SET status = 'processed'")
    ))).toBe(false);
  });

  it('reports replay when the atomic billing finalizer observes exact already-processed authority', async () => {
    markGatewayRefundPaid.mockResolvedValueOnce({ id: 9 });
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
      billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
      provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
    }]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'processed',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
        processed_at: new Date('2026-08-27T10:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: 9, approval_status: 'PAID', payout_rail: 'gateway',
        gateway_refund_id: 6, reference: 'rfnd_dry_pgr-9',
      }])
      .mockResolvedValueOnce([{ id: 6, status: 'processed' }]);

    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9', amount: 15000,
        currency: 'INR', status: 'processed', notes: { billing_refund_id: '9' },
      } } } },
    });

    expect(result.outcome).toBe('replay');
    expect(txQueryRawUnsafe.mock.calls[2][0]).toContain("AND status = 'processed'");
  });

  it('atomically parks a payout-rail conflict through the recovery obligation service', async () => {
    const gatewayRefund = {
      id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'pending',
      billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
      provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
    };
    queryRawUnsafe
      .mockResolvedValueOnce([gatewayRefund])
      // Post-failure authority read: the execution row joined to the billing
      // authority it lost, in both the aliased and the bare projection.
      .mockResolvedValueOnce([{
        ...gatewayRefund,
        approval_status: 'PAID', payout_rail: 'manual', gateway_refund_id: null,
        reference: 'manual-refund-reference',
        authority_approval_status: 'PAID', authority_payout_rail: 'manual',
        authority_gateway_refund_id: null, authority_reference: 'manual-refund-reference',
      }]);
    markGatewayRefundPaid.mockRejectedValueOnce({
      code: 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT',
    });
    ensureGatewayRefundRecoveryObligation.mockResolvedValueOnce({
      ...gatewayRefund,
      status: 'requires_reconciliation',
      failure_code: 'payout_rail_conflict',
      recovery_task_id: 41,
      recovery_sla_instance_id: '44444444-4444-4444-8444-444444444444',
    });

    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config: enabledConfig,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9', amount: 15000,
        currency: 'INR', status: 'processed', notes: { billing_refund_id: '9' },
      } } } },
    });

    expect(result).toMatchObject({
      outcome: 'requires_reconciliation', gatewayRefundId: 6,
      billingRefundId: 9, reason: 'payout_rail_conflict',
    });
    expect(ensureGatewayRefundRecoveryObligation).toHaveBeenCalledWith({
      tenantId: TENANT,
      gatewayRefundId: 6,
      parkFailure: {
        providerRefundId: 'rfnd_dry_pgr-9',
        code: 'payout_rail_conflict',
        reason: 'Provider processed this refund but a different payout execution owns the billing refund',
      },
      claimToken: null,
    });
    expect(queryRawUnsafe.mock.calls.some(([sql]) => (
      sql.includes("SET status = 'requires_reconciliation'")
    ))).toBe(false);
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
      }]);
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
    expect(ensureGatewayRefundRecoveryObligation).toHaveBeenCalledWith({
      tenantId: TENANT,
      gatewayRefundId: 6,
      parkFailure: expect.objectContaining({
        code: 'provider_evidence_mismatch',
        reason: expect.stringContaining('Provider refund evidence mismatch'),
      }),
      claimToken: null,
    });
  });

  it('supersedes a manual reconciliation only after exact processed evidence and settles billing', async () => {
    queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('SELECT refunds.*')) return [{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'requires_reconciliation',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
        reconciled_at: new Date('2026-08-17T08:00:00.000Z'),
        reconciliation_note: 'Provider portal previously showed pending',
        reconciled_by: ISSUED_INVOICE.patient_uid,
      }];
      // Exact provider evidence supersedes the operator reconciliation first
      // (the only prisma-level write on this path); the terminal flip then runs
      // inside the settlement tx against txQueryRawUnsafe, not here.
      if (sql.includes('reconciled_at = NULL')) return [{ id: 6 }];
      throw new Error(`Unexpected processed-refund SQL: ${sql}`);
    });
    txQueryRawUnsafe
      .mockResolvedValueOnce([{
        id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'processed',
        billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
        provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
        processed_at: new Date('2026-08-27T10:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{
        id: 9, approval_status: 'PAID', payout_rail: 'gateway',
        gateway_refund_id: 6, reference: 'rfnd_dry_pgr-9',
      }])
      .mockResolvedValueOnce([{ id: 6, status: 'processed' }]);

    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: {
        id: 'rfnd_dry_pgr-9', payment_id: 'pay_dry_9', amount: 15000,
        currency: 'INR', status: 'processed', notes: { billing_refund_id: '9' },
      } } } },
    });

    expect(result.outcome).toBe('refund_processed');
    // calls[0] is the webhook correlation SELECT; calls[1] is the only other
    // prisma write on this path — reopenRefundReconciliationForExactProviderEvidence,
    // which appends the superseded operator reconciliation before billing settles.
    expect(queryRawUnsafe.mock.calls[1][0])
      .toContain('provider_evidence_superseded_reconciliations');
    expect(markGatewayRefundPaid).toHaveBeenCalledWith(9, expect.objectContaining({
      tenantId: TENANT, gateway_refund_id: 6, provider_refund_id: 'rfnd_dry_pgr-9',
      recovery_claim_token: null,
    }));
    expect(projectGatewayRefundRecoveryTerminal).toHaveBeenCalledWith({
      tenantId: TENANT, gatewayRefundId: 6, outcome: 'succeeded', claimToken: null,
    });
  });

  it('an already-processed execution row is a replay — billing authority untouched', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 6, tenant_id: TENANT, provider: 'dry_run', status: 'processed',
      billing_refund_id: 9, provider_refund_id: 'rfnd_dry_pgr-9',
      processed_at: new Date('2026-08-27T10:00:00.000Z'),
    }]).mockResolvedValueOnce([{
      approval_status: 'PAID', payout_rail: 'gateway',
      gateway_refund_id: 6, reference: 'rfnd_dry_pgr-9',
    }]);
    const result = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT, config: enabledConfig,
      payload: { payload: { refund: { entity: { id: 'rfnd_dry_pgr-9' } } } },
    });
    expect(result.outcome).toBe('replay');
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });
});

describe('recovery-claim fence on the non-terminal provider status projection', () => {
  // Re-anchored home of the refund lane's SQL-level claim-fence assertions.
  // The lane asserted `recovery_claim_token = $4::uuid` (and the token at
  // parameter position 4) on the processed UPDATE the webhook settlement path
  // used to issue through prisma. The merged service no longer writes that flip
  // itself — markGatewayRefundPaid owns it, and the token is asserted riding
  // into that call above — so the surviving service-side `$4::uuid` fence is the
  // recovery worker's non-terminal pending projection, asserted here at the same
  // parameter index.
  const claimToken = '55555555-5555-4555-8555-555555555555';
  const claimedIntent = {
    id: 6, tenant_id: TENANT, provider: 'dry_run', environment: 'sandbox',
    status: 'initiated', billing_refund_id: 9, provider_payment_id: 'pay_dry_9',
    provider_refund_id: 'rfnd_dry_pgr-9', amount: '150.00', currency: 'INR',
    recovery_state: 'claimed', recovery_claim_token: claimToken,
  };
  const pendingEvidence = {
    providerRefundId: 'rfnd_dry_pgr-9', providerPaymentId: 'pay_dry_9',
    amountPaise: 15000, currency: 'INR', status: 'pending', billingRefundId: 9,
  };

  it('projects the pending provider status only under the held claim lease', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([claimedIntent])
      .mockResolvedValueOnce([{ id: 6 }]);

    const result = await gateway.applyGatewayRefundProviderEvidence({
      tenantId: TENANT, config: enabledConfig, claimToken, evidence: pendingEvidence,
    });

    expect(result).toEqual({ outcome: 'refund_pending', gatewayRefundId: 6 });
    // calls[0] is the correlation SELECT; calls[1] is the fenced projection.
    expect(queryRawUnsafe.mock.calls[1][0]).toContain('recovery_claim_token = $4::uuid');
    expect(queryRawUnsafe.mock.calls[1][0]).toContain("recovery_state = 'claimed'");
    expect(queryRawUnsafe.mock.calls[1][4]).toBe(claimToken);
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });

  it('does not claim a projection when the lease has moved to another worker', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([claimedIntent])
      .mockResolvedValueOnce([]);

    const result = await gateway.applyGatewayRefundProviderEvidence({
      tenantId: TENANT, config: enabledConfig, claimToken, evidence: pendingEvidence,
    });

    expect(result).toEqual({ outcome: 'replay', gatewayRefundId: 6 });
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
    expect(projectGatewayRefundRecoveryTerminal).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce([{ ...intent, status: 'failed', provider_refund_id: 'rfnd_failed_9' }]);
    txQueryRawUnsafe
      .mockResolvedValueOnce([intent])
      .mockResolvedValueOnce([{
        id: 9, approval_status: 'APPROVED', payout_rail: 'gateway',
        gateway_refund_id: 6, reference: null,
      }])
      .mockResolvedValueOnce([{ id: 6 }])
      .mockResolvedValueOnce([{ ...intent, status: 'failed', provider_refund_id: 'rfnd_failed_9' }])
      .mockResolvedValueOnce([{
        id: 9, approval_status: 'APPROVED', payout_rail: 'gateway',
        gateway_refund_id: 6, reference: null,
      }]);
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
    expect(txQueryRawUnsafe.mock.calls[2][0]).toContain("status = 'failed'");
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
      }]);

    const result = await gateway.processWebhookEvent({
      tenantId: TENANT, config: enabledConfig,
      event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: failedEntity(override) } } },
    });

    expect(result).toMatchObject({ outcome: 'requires_reconciliation', gatewayRefundId: 6 });
    expect(ensureGatewayRefundRecoveryObligation).toHaveBeenCalledWith({
      tenantId: TENANT,
      gatewayRefundId: 6,
      parkFailure: expect.objectContaining({
        code: 'provider_evidence_mismatch',
        reason: expect.stringContaining('Provider refund evidence mismatch'),
      }),
      claimToken: null,
    });
    expect(markGatewayRefundPaid).not.toHaveBeenCalled();
  });
});
