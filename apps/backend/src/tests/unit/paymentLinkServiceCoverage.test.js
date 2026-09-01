// Statement-coverage suite for src/services/billing/paymentLinkService.js
// (roadmap B3.2). A sibling file (paymentLinkService.test.js) covers a few
// validation gates only; this file is the comprehensive one, exercising every
// exported function plus the internal resolve/assert helpers and their
// AppError branches.
//
// Pure-unit: we mock the prisma singleton (the established convention, see
// paymentLinkTenantAuthorization.test.js), the two notification helpers, the
// logger, and collectPayment (from billingV2Service) so there is no DB or
// network. setTenant/setTenantTx delegate to the same mock client so any
// tenant-wrapped write still runs against our query/execute mocks.

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const sendEmailMock = jest.fn();
const sendWhatsAppMock = jest.fn();
const queuePatientSmsMock = jest.fn();
const collectPaymentMock = jest.fn();
const MERGE_STABILITY_LEASE = Object.freeze({ test: 'payment-link-merge-stability' });
const lockTenantPatientMergeStabilityMock = jest.fn(async () => MERGE_STABILITY_LEASE);
const loggerWarnMock = jest.fn();
const getTenantSettingsMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarnMock, error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../utils/notifications/sendEmailNotification.js', () => ({
  sendEmail: sendEmailMock,
}));

jest.unstable_mockModule('../../utils/notifications/sendWhatsAppNotification.js', () => ({
  sendWhatsApp: sendWhatsAppMock,
}));

jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queuePatientSms: queuePatientSmsMock,
}));

jest.unstable_mockModule('../../utils/patientMergeStabilityLock.js', () => ({
  lockTenantPatientMergeStability: lockTenantPatientMergeStabilityMock,
}));

jest.unstable_mockModule('../../services/billing/billingV2Service.js', () => ({
  collectPayment: collectPaymentMock,
  // Phase 4-3: paymentLinkService now also imports this for the enforce-mode
  // ledger-derive; provide it so ESM linking succeeds (unused under shadow).
  deriveInvoicePaymentStateFromLedgerTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getTenantSettings: getTenantSettingsMock,
  getPaymentGatewaySettings: async () => ({ enabled: false }),
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: async () => ({ mode: 'shadow', sameTx: false, postCommit: true, skip: false }),
  resolveLedgerModeForTenant: async () => 'shadow',
}));

const {
  buildUpiDeepLink,
  normalizePaymentLinkChannels,
  resolveTeleconsultPaymentLinkConfig,
  isWellFormedPaymentLinkToken,
  resolvePaymentLinkPublicState,
  getPublicPaymentLinkView,
  createPaymentLink,
  getPaymentLink,
  sendPaymentLink,
  markPaymentLinkPaid,
  cancelPaymentLink,
  expireStaleLinks,
  listPaymentLinks,
  createTeleconsultPostConsultPaymentLink,
} = await import('../../services/billing/paymentLinkService.js');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.HOSPITAL_UPI_VPA = 'hospital@upi';
  process.env.HOSPITAL_UPI_PAYEE_NAME = 'VH Hospital';
  delete process.env.HOSPITAL_NAME;
  delete process.env.HOSPITAL_PAY_BASE_URL;
  executeRawUnsafeMock.mockResolvedValue(1);
  getTenantSettingsMock.mockResolvedValue({});
});

describe('payment-link channel and teleconsult configuration', () => {
  it('normalizes, deduplicates, and falls back without admitting unknown channels', () => {
    expect(normalizePaymentLinkChannels([' SMS ', 'sms', 'EMAIL', 'push']))
      .toEqual(['sms', 'email']);
    expect(normalizePaymentLinkChannels([], ['email'])).toEqual(['email']);
    expect(normalizePaymentLinkChannels(null, null)).toEqual(['whatsapp']);
  });

  it('requires an explicit teleconsult enable and bounds invalid expiry to the default', () => {
    expect(resolveTeleconsultPaymentLinkConfig({})).toMatchObject({
      enabled: false, channels: ['whatsapp'], expiresInHours: 48,
    });
    expect(resolveTeleconsultPaymentLinkConfig({
      teleconsultPayments: { enabled: true, channels: ['SMS'], expires_in_hours: -1 },
    })).toEqual({ enabled: true, channels: ['sms'], expiresInHours: 48 });
  });
});

describe('public payment-link view', () => {
  const TOKEN = 'link-token-fixture-aaaaaaaaaaaa';
  const now = new Date('2026-08-17T00:00:00.000Z');

  it('rejects malformed bearer tokens before querying', async () => {
    expect(isWellFormedPaymentLinkToken('short')).toBe(false);
    expect(isWellFormedPaymentLinkToken(TOKEN)).toBe(true);
    await expect(getPublicPaymentLinkView({ link_token: '../bad' }, now)).resolves.toBeNull();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'paid' }, 'paid'],
    [{ status: 'cancelled' }, 'cancelled'],
    [{ status: 'sent', expires_at: '2026-08-16T00:00:00.000Z' }, 'expired'],
    [{ status: 'created', expires_at: '2026-08-18T00:00:00.000Z' }, 'payable'],
    [{ status: 'future' }, 'unavailable'],
  ])('derives fail-closed public state for %j', (row, expected) => {
    expect(resolvePaymentLinkPublicState(row, now)).toBe(expected);
  });

  it('returns only the public allowlist and suppresses a non-UPI stored link', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 5, tenant_id: TENANT, amount: '250.00', currency: 'INR', status: 'created',
      expires_at: '2026-08-18T00:00:00.000Z', paid_at: null,
      upi_deep_link: 'https://evil.example/pay', upi_payee_name: 'VH Hospital',
      invoice_number: 'INV-5', patient_uid: PATIENT_A,
    }]);
    const view = await getPublicPaymentLinkView({ link_token: TOKEN }, now);
    expect(view).toEqual(expect.objectContaining({
      state: 'payable', amount: 250, invoiceReference: 'INV-5', upiDeepLink: null,
      gateway: { enabled: false, provider: null, keyId: null, providerOrderId: null },
    }));
    expect(view).not.toHaveProperty('patient_uid');
  });
});

describe('teleconsult post-consult payment links', () => {
  it('validates the teleconsultation id before querying', async () => {
    await expect(createTeleconsultPostConsultPaymentLink({ tenantId: TENANT }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT, teleconsultation_id: 'not-an-id',
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns an honest tenant-not-configured result after resolving the subject', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 8, appointment_id: 9, patient_uid: PATIENT_A, status: 'completed',
    }]);
    await expect(createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT, teleconsultation_id: 8,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'tenant_not_configured' });
  });

  it('fails closed when a completed consult has no linked payable invoice', async () => {
    getTenantSettingsMock.mockResolvedValue({
      teleconsultPayments: { enabled: true, channels: ['email'], expiresInHours: 24 },
    });
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 8, appointment_id: 9, patient_uid: PATIENT_A, status: 'completed',
      }])
      .mockResolvedValueOnce([]);
    await expect(createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT, teleconsultation_id: 8,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'invoice_not_linked' });
  });
});

// ─── buildUpiDeepLink (pure) ───────────────────────────────────────────────
describe('buildUpiDeepLink', () => {
  it('returns null when any of vpa / name / amount is missing', () => {
    expect(buildUpiDeepLink({ name: 'X', amount: 10 })).toBeNull();
    expect(buildUpiDeepLink({ vpa: 'a@upi', amount: 10 })).toBeNull();
    expect(buildUpiDeepLink({ vpa: 'a@upi', name: 'X' })).toBeNull();
    expect(buildUpiDeepLink({})).toBeNull();
  });

  it('builds a spec-shaped intent link with formatted amount and INR currency', () => {
    const link = buildUpiDeepLink({ vpa: 'pay@upi', name: 'VH Hospital', amount: 2500 });
    expect(link.startsWith('upi://pay?')).toBe(true);
    const qs = new URLSearchParams(link.split('?')[1]);
    expect(qs.get('pa')).toBe('pay@upi');
    expect(qs.get('pn')).toBe('VH Hospital');
    expect(qs.get('am')).toBe('2500.00'); // Number(amount).toFixed(2)
    expect(qs.get('cu')).toBe('INR');
    expect(qs.get('tn')).toBeNull(); // omitted when no note
    expect(qs.get('tr')).toBeNull(); // omitted when no ref
  });

  it('includes optional note (tn) and transactionRef (tr) when provided', () => {
    const link = buildUpiDeepLink({
      vpa: 'pay@upi', name: 'VH', amount: 99.5, note: 'Invoice 7', transactionRef: 'VH-7-abc',
    });
    const qs = new URLSearchParams(link.split('?')[1]);
    expect(qs.get('am')).toBe('99.50');
    expect(qs.get('tn')).toBe('Invoice 7');
    expect(qs.get('tr')).toBe('VH-7-abc');
  });
});

// ─── createPaymentLink ─────────────────────────────────────────────────────
describe('createPaymentLink', () => {
  it('rejects a non-positive amount before any DB call', async () => {
    await expect(createPaymentLink({ tenantId: TENANT, patient_uid: PATIENT_A, amount: 0 }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(createPaymentLink({ tenantId: TENANT, patient_uid: PATIENT_A, amount: -5 }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('requires patient_uid when no invoice_id given', async () => {
    await expect(createPaymentLink({ tenantId: TENANT, amount: 100 }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects upi_intent provider when UPI env config is missing', async () => {
    delete process.env.HOSPITAL_UPI_VPA;
    delete process.env.HOSPITAL_UPI_PAYEE_NAME;
    await expect(createPaymentLink({
      tenantId: TENANT, patient_uid: PATIENT_A, amount: 100,
    })).rejects.toMatchObject({ statusCode: 400 });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('falls back to HOSPITAL_NAME for the payee name', async () => {
    delete process.env.HOSPITAL_UPI_PAYEE_NAME;
    process.env.HOSPITAL_NAME = 'Fallback Hospital';
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_A }]) // assertPatientInTenant
      .mockResolvedValueOnce([{ id: 9, link_token: 'tok' }]); // INSERT RETURNING

    await createPaymentLink({ tenantId: TENANT, patient_uid: PATIENT_A, amount: 100 });

    const insertParams = queryRawUnsafeMock.mock.calls[1];
    // [sql, $1..$14]; $7 = upi_payee_name -> array index 7
    expect(insertParams[7]).toBe('Fallback Hospital');
  });

  it('creates an ad-hoc (patient-only) upi link; server owns the deep link + ref', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_A }]) // assertPatientInTenant found
      .mockResolvedValueOnce([{ id: 9, link_token: 'tok', patient_uid: PATIENT_A }]); // INSERT

    const row = await createPaymentLink({
      tenantId: TENANT, patient_uid: PATIENT_A, amount: 1500, created_by: PATIENT_B,
    });
    expect(row).toEqual({ id: 9, link_token: 'tok', patient_uid: PATIENT_A });

    // assertPatientInTenant scoped query came first
    const [assertSql, ...assertParams] = queryRawUnsafeMock.mock.calls[0];
    expect(assertSql).toContain('FROM users');
    expect(assertParams).toEqual([PATIENT_A, TENANT]);

    // INSERT call: deep link present, transaction ref is VH-AD-... for ad-hoc
    const insert = queryRawUnsafeMock.mock.calls[1];
    expect(insert[0]).toContain('INSERT INTO billing_payment_links');
    const transactionRef = insert[8]; // $8 = upi_transaction_ref
    const deepLink = insert[9]; // $9 = upi_deep_link
    expect(transactionRef).toMatch(/^VH-AD-/);
    expect(deepLink.startsWith('upi://pay?')).toBe(true);
    expect(deepLink).toContain('Hospital+bill'); // ad-hoc note, URL-encoded space
    expect(insert[13]).toBe(PATIENT_B); // created_by stringified
  });

  it('404s when the patient is not in the tenant (ad-hoc path)', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]); // assertPatientInTenant: empty
    await expect(createPaymentLink({ tenantId: TENANT, patient_uid: PATIENT_A, amount: 100 }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('resolves an invoice subject and builds an Invoice-N note + VH-<id> ref', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_A }]) // invoice lookup
      .mockResolvedValueOnce([{ id: 1, invoice_id: 42 }]); // INSERT

    await createPaymentLink({
      tenantId: TENANT, invoice_id: 42, amount: 3000, expires_in_hours: 12,
    });

    const [invSql, ...invParams] = queryRawUnsafeMock.mock.calls[0];
    expect(invSql).toContain('FROM billing_invoices');
    expect(invParams).toEqual([42, TENANT]);

    const insert = queryRawUnsafeMock.mock.calls[1];
    expect(insert[3]).toBe(PATIENT_A); // $3 patient_uid resolved from invoice
    expect(insert[8]).toMatch(/^VH-42-/); // transaction ref carries invoice id
    expect(insert[9]).toContain('Invoice+42'); // deep-link note references invoice
  });

  it('404s when the invoice is not found in tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]); // invoice lookup: empty
    await expect(createPaymentLink({ tenantId: TENANT, invoice_id: 999, amount: 100 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('forbids when supplied patient_uid contradicts the invoice owner', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_A }]);
    await expect(createPaymentLink({
      tenantId: TENANT, invoice_id: 42, patient_uid: PATIENT_B, amount: 100,
    })).rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_LINK_PATIENT_MISMATCH' });
  });

  it('accepts a matching patient_uid alongside the invoice (case-insensitive)', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_A.toUpperCase() }])
      .mockResolvedValueOnce([{ id: 1 }]);

    await expect(createPaymentLink({
      tenantId: TENANT, invoice_id: 42, patient_uid: PATIENT_A.toLowerCase(), amount: 100,
    })).resolves.toEqual({ id: 1 });
  });

  it('skips the deep link entirely for a non-upi provider', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_A }])
      .mockResolvedValueOnce([{ id: 7 }]);

    await createPaymentLink({
      tenantId: TENANT, patient_uid: PATIENT_A, amount: 100, provider: 'razorpay',
    });

    const insert = queryRawUnsafeMock.mock.calls[1];
    expect(insert[9]).toBeNull(); // deep_link null for non-upi
    expect(insert[10]).toBe('razorpay'); // provider passed through
  });

  it('inserts NULL upi payee fields for a non-upi provider with no UPI env set', async () => {
    delete process.env.HOSPITAL_UPI_VPA;
    delete process.env.HOSPITAL_UPI_PAYEE_NAME;
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_A }])
      .mockResolvedValueOnce([{ id: 7 }]);

    // non-upi provider skips the UPI-env requirement, so vpa/payeeName stay
    // undefined and the `|| null` fallbacks fire.
    await createPaymentLink({
      tenantId: TENANT, patient_uid: PATIENT_A, amount: 100, provider: 'manual',
    });

    const insert = queryRawUnsafeMock.mock.calls[1];
    expect(insert[6]).toBeNull(); // $6 upi_payee_vpa -> null
    expect(insert[7]).toBeNull(); // $7 upi_payee_name -> null
    expect(insert[9]).toBeNull(); // no deep link for non-upi
  });

  it('defaults tenant + currency + null created_by when omitted', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_A }])
      .mockResolvedValueOnce([{ id: 7 }]);

    await createPaymentLink({ patient_uid: PATIENT_A, amount: 100 });

    const insert = queryRawUnsafeMock.mock.calls[1];
    expect(insert[5]).toBe('INR'); // currency default
    expect(insert[14]).toBe('00000000-0000-4000-8000-000000000001'); // default tenant
    expect(insert[13]).toBeNull(); // created_by null when omitted
  });
});

// ─── getPaymentLink ────────────────────────────────────────────────────────
describe('getPaymentLink', () => {
  it('returns the row when present', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, link_token: 'tok' }]);
    const row = await getPaymentLink({ tenantId: TENANT, link_token: 'tok' });
    expect(row).toEqual({ id: 1, link_token: 'tok' });
    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM billing_payment_links');
    expect(params).toEqual(['tok', TENANT]);
  });

  it('404s when the link is missing', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(getPaymentLink({ tenantId: TENANT, link_token: 'nope' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ─── sendPaymentLink ───────────────────────────────────────────────────────
describe('sendPaymentLink', () => {
  it('refuses to resend a paid or cancelled link', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, link_token: 'tok', status: 'paid', amount: '10' }]);
    await expect(sendPaymentLink({ tenantId: TENANT, link_token: 'tok', patient_phone: '+91999' }))
      .rejects.toMatchObject({ statusCode: 400 });

    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, link_token: 'tok', status: 'cancelled', amount: '10' }]);
    await expect(sendPaymentLink({ tenantId: TENANT, link_token: 'tok', patient_phone: '+91999' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('sends WhatsApp, stamps the timestamp, and uses the default base URL', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '2500' }]) // getPaymentLink
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'sent', amount: '2500' }]); // re-read
    sendWhatsAppMock.mockResolvedValueOnce(undefined);

    const out = await sendPaymentLink({
      tenantId: TENANT, link_token: 'tok', patient_phone: '+919999999999',
    });

    expect(sendWhatsAppMock).toHaveBeenCalledWith(expect.objectContaining({
      to: '+919999999999',
      body: expect.stringContaining('https://api.vhhealth.app/pay/tok'),
    }));
    // WA timestamp update executed exactly once
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock.mock.calls[0][0]).toContain('sent_via_whatsapp_at = NOW()');
    expect(out.status).toBe('sent');
  });

  it('swallows a WhatsApp failure (logs warn, no timestamp update)', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '2500' }])
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '2500' }]);
    sendWhatsAppMock.mockRejectedValueOnce(new Error('twilio down'));

    await sendPaymentLink({ tenantId: TENANT, link_token: 'tok', patient_phone: '+9199' });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'paymentLink WA send failed',
      expect.objectContaining({ error: 'twilio down' }),
    );
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  // Audit 2026-08-09 finding F7 — the SMS channel has no gateway.
  it('queues an outbox intent on the sms channel and never stamps sent_via_sms_at', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 5, link_token: 'tok', status: 'created', amount: '2500',
        patient_uid: PATIENT_A, invoice_id: 71,
      }])
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '2500' }]);
    queuePatientSmsMock.mockResolvedValueOnce({ queued: true, outboxId: 88 });

    const out = await sendPaymentLink({
      tenantId: TENANT, link_token: 'tok', channels: ['sms'],
      patient_phone: '+919999999999',
    });

    expect(queuePatientSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      recipientId: PATIENT_A,
      recipientPhone: '+919999999999',
      sourceEventKey: 'billing-payment-link:5',
      body: expect.stringContaining('https://api.vhhealth.app/pay/tok'),
    }));
    // The link-token is a bearer credential: it may appear in the message
    // body but must never be persisted in outbox payload metadata.
    expect(JSON.stringify(queuePatientSmsMock.mock.calls[0][0].data)).not.toContain('tok');
    // No delivery stamp and no status flip to 'sent' — nothing was delivered.
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(out.status).toBe('created');
  });

  it('sends email on the email channel and stamps the email timestamp', async () => {
    process.env.HOSPITAL_PAY_BASE_URL = 'https://pay.vhhealth.app/pay';
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'sent', amount: '2500' }])
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'sent', amount: '2500' }]);
    sendEmailMock.mockResolvedValueOnce(undefined);

    await sendPaymentLink({
      tenantId: TENANT, link_token: 'tok', channels: ['email'],
      patient_email: 'p@example.test',
    });

    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'p@example.test',
      subject: expect.stringContaining('₹2500.00'),
      html: expect.stringContaining('https://pay.vhhealth.app/pay/tok'),
    }));
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock.mock.calls[0][0]).toContain('sent_via_email_at = NOW()');
  });

  it('swallows an email failure (logs warn, no timestamp update)', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'sent', amount: '2500' }])
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'sent', amount: '2500' }]);
    sendEmailMock.mockRejectedValueOnce(new Error('smtp 550'));

    await sendPaymentLink({
      tenantId: TENANT, link_token: 'tok', channels: ['email'], patient_email: 'p@example.test',
    });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'paymentLink email send failed',
      expect.objectContaining({ error: 'smtp 550' }),
    );
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('sends over both channels and runs both timestamp updates', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '100' }])
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'sent', amount: '100' }]);
    sendWhatsAppMock.mockResolvedValueOnce(undefined);
    sendEmailMock.mockResolvedValueOnce(undefined);

    await sendPaymentLink({
      tenantId: TENANT, link_token: 'tok', channels: ['whatsapp', 'email'],
      patient_phone: '+9199', patient_email: 'p@example.test',
    });

    expect(sendWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('does nothing destination-wise when contact details are absent', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '100' }])
      .mockResolvedValueOnce([{ id: 5, link_token: 'tok', status: 'created', amount: '100' }]);

    await sendPaymentLink({ tenantId: TENANT, link_token: 'tok', channels: ['whatsapp', 'email'] });

    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });
});

// ─── markPaymentLinkPaid ───────────────────────────────────────────────────
describe('markPaymentLinkPaid', () => {
  it('rejects an already-paid link', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'paid', link_token: 'tok' }]);
    await expect(markPaymentLinkPaid({ tenantId: TENANT, link_token: 'tok' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(collectPaymentMock).not.toHaveBeenCalled();
  });

  it('rejects a cancelled or expired link', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'cancelled', link_token: 'tok' }]);
    await expect(markPaymentLinkPaid({ tenantId: TENANT, link_token: 'tok' }))
      .rejects.toMatchObject({ statusCode: 400 });

    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'expired', link_token: 'tok' }]);
    await expect(markPaymentLinkPaid({ tenantId: TENANT, link_token: 'tok' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('collects a payment, marks the link paid, and returns both', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 1, status: 'sent', link_token: 'tok', invoice_id: 42,
        patient_uid: PATIENT_A, amount: '2500', upi_transaction_ref: 'VH-42-x',
      }]) // initial getPaymentLink
      .mockResolvedValueOnce([{ id: 1, status: 'paid', link_token: 'tok' }]); // re-read
    collectPaymentMock.mockResolvedValueOnce({ id: 777 });

    const result = await markPaymentLinkPaid({
      tenantId: TENANT, link_token: 'tok', paid_via: 'card',
      paid_reference: 'REF-9', performed_by: PATIENT_B,
    });

    // collectPayment received the mapped mode (card -> CARD) + link details
    expect(collectPaymentMock).toHaveBeenCalledWith(expect.objectContaining({
      invoice_id: 42,
      patient_uid: PATIENT_A,
      amount: '2500',
      mode: 'CARD',
      reference: 'REF-9',
      collected_by: PATIENT_B,
    }), { tx: __prismaDefaultMock, mergeStabilityLease: MERGE_STABILITY_LEASE });
    expect(lockTenantPatientMergeStabilityMock)
      .toHaveBeenCalledWith(__prismaDefaultMock, TENANT);
    expect(lockTenantPatientMergeStabilityMock).toHaveBeenCalledTimes(1);
    expect(lockTenantPatientMergeStabilityMock.mock.invocationCallOrder[0])
      .toBeLessThan(queryRawUnsafeMock.mock.invocationCallOrder[0]);
    // status flip persisted with linked_payment_id
    const upd = executeRawUnsafeMock.mock.calls[0];
    expect(upd[0]).toContain("status = 'paid'");
    expect(upd[1]).toBe('card'); // paid_via
    expect(upd[2]).toBe('REF-9'); // paid_reference
    expect(upd[3]).toBe(777); // linked payment id
    expect(upd[4]).toBe(1); // link id
    expect(result).toEqual({
      link: { id: 1, status: 'paid', link_token: 'tok' },
      payment: { id: 777 },
    });
  });

  it('defaults paid_via to upi, maps unknown modes to UPI, and falls back to the upi ref', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 2, status: 'created', link_token: 'tok2', invoice_id: null,
        patient_uid: PATIENT_A, amount: '500', upi_transaction_ref: 'VH-AD-y',
      }])
      .mockResolvedValueOnce([{ id: 2, status: 'paid', link_token: 'tok2' }]);
    collectPaymentMock.mockResolvedValueOnce({ id: 888 });

    await markPaymentLinkPaid({ tenantId: TENANT, link_token: 'tok2' });

    expect(collectPaymentMock).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'UPI', // default paid_via 'upi' -> UPI
      reference: 'VH-AD-y', // falls back to upi_transaction_ref
      collected_by: undefined,
    }), expect.anything()); // 2nd arg: { tx }
    const upd = executeRawUnsafeMock.mock.calls[0];
    expect(upd[1]).toBe('upi'); // default paid_via
    expect(upd[2]).toBeNull(); // no paid_reference
  });

  it('maps the netbanking / wallet / other aliases (case-insensitive)', async () => {
    const cases = [
      ['netbanking', 'NETBANKING'],
      ['wallet', 'WALLET'],
      ['other', 'UPI'],
      ['CARD', 'CARD'],
      ['totally-unknown', 'UPI'],
    ];
    for (const [paid_via, expected] of cases) {
      jest.clearAllMocks();
      executeRawUnsafeMock.mockResolvedValue(1);
      queryRawUnsafeMock
        .mockResolvedValueOnce([{
          id: 3, status: 'sent', link_token: 't', invoice_id: 1,
          patient_uid: PATIENT_A, amount: '10', upi_transaction_ref: 'r',
        }])
        .mockResolvedValueOnce([{ id: 3, status: 'paid' }]);
      collectPaymentMock.mockResolvedValueOnce({ id: 1 });

      await markPaymentLinkPaid({ tenantId: TENANT, link_token: 't', paid_via });
      expect(collectPaymentMock).toHaveBeenCalledWith(expect.objectContaining({ mode: expected }), expect.anything());
    }
  });
});

// ─── cancelPaymentLink ─────────────────────────────────────────────────────
describe('cancelPaymentLink', () => {
  it('refuses to cancel a paid link', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'paid', link_token: 'tok' }]);
    await expect(cancelPaymentLink({ tenantId: TENANT, link_token: 'tok' }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('cancels with a reason appended to notes', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 1, status: 'sent', link_token: 'tok' }])
      .mockResolvedValueOnce([{ id: 1, status: 'cancelled', link_token: 'tok' }]);

    const out = await cancelPaymentLink({ tenantId: TENANT, link_token: 'tok', reason: 'duplicate' });

    const upd = executeRawUnsafeMock.mock.calls[0];
    expect(upd[0]).toContain("status = 'cancelled'");
    expect(upd[1]).toBe('\n[cancelled] duplicate');
    expect(upd[2]).toBe(1); // link id
    expect(out.status).toBe('cancelled');
  });

  it('cancels without a reason using the bare marker', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 1, status: 'created', link_token: 'tok' }])
      .mockResolvedValueOnce([{ id: 1, status: 'cancelled' }]);

    await cancelPaymentLink({ tenantId: TENANT, link_token: 'tok' });

    expect(executeRawUnsafeMock.mock.calls[0][1]).toBe('\n[cancelled]');
  });
});

// ─── expireStaleLinks ──────────────────────────────────────────────────────
describe('expireStaleLinks', () => {
  it('issues an idempotent UPDATE and returns the affected count', async () => {
    executeRawUnsafeMock.mockResolvedValueOnce(4);
    const out = await expireStaleLinks();
    expect(out).toEqual({ expired: 4 });
    const sql = executeRawUnsafeMock.mock.calls[0][0];
    expect(sql).toContain("status = 'expired'");
    expect(sql).toContain("status IN ('created', 'sent')");
    expect(sql).toContain('expires_at < NOW()');
  });
});

// ─── listPaymentLinks ──────────────────────────────────────────────────────
describe('listPaymentLinks', () => {
  it('lists tenant-scoped with default limit and no extra filters', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    const rows = await listPaymentLinks({ tenantId: TENANT });
    expect(rows).toEqual([{ id: 1 }]);

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).not.toContain('SELECT *'); // explicit columns only
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(params).toEqual([TENANT, 100]); // tenant + default limit
  });

  it('appends patient / status / invoice filters with incrementing placeholders', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await listPaymentLinks({
      tenantId: TENANT, patient_uid: PATIENT_A, status: 'paid', invoice_id: 42, limit: 25,
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('patient_uid = $2::uuid');
    expect(sql).toContain('status = $3');
    expect(sql).toContain('invoice_id = $4::int');
    expect(sql).toContain('LIMIT $5::int');
    expect(params).toEqual([TENANT, PATIENT_A, 'paid', 42, 25]);
  });

  it('keeps placeholder numbering correct when only some filters are present', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await listPaymentLinks({ tenantId: TENANT, status: 'sent' });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('status = $2');
    expect(sql).toContain('LIMIT $3::int');
    expect(params).toEqual([TENANT, 'sent', 100]);
  });
});
