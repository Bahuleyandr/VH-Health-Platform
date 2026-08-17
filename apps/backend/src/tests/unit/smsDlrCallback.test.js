// src/tests/unit/smsDlrCallback.test.js
//
// The public /webhooks/sms DLR mount (migrations 699/700) — the contract:
//   * fail-closed tenant resolution: unknown/malformed URL token → 401 and
//     NOTHING is written (never a default tenant on a pre-RLS mount);
//   * Twilio deliveries additionally require a valid X-Twilio-Signature —
//     any missing verification input (auth token, signature, public URL,
//     SDK) fails CLOSED;
//   * only TERMINAL statuses are persisted (delivered → acknowledged,
//     failed/undelivered/rejected/expired → rejected); intermediate and
//     unrecognized statuses are 200-acked with no write, protecting the
//     one-receipt-per-(attempt, source) unique for the terminal report;
//   * receipts are recorded through recordProviderReceiptTx inside
//     setTenantTx with receipt_source='provider_status_callback';
//   * an unknown provider reference is 200-acked with no write;
//   * outbox status and delivery cursors are NEVER touched from a DLR.

import crypto from 'node:crypto';
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT_ID = '00000000-0000-4000-8000-000000000031';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz01';

const resolveSmsConfigByCallbackTokenMock = jest.fn();
const recordProviderReceiptTxMock = jest.fn();
const setTenantTxMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const decryptFieldMock = jest.fn();
const validateRequestMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

function envTwilioCallbackToken(tenantId, accountSid, authToken) {
  const mac = crypto.createHmac('sha256', authToken)
    .update(`vhhealth:twilio-status:v1:${tenantId}:${accountSid}`)
    .digest('base64url');
  return `env.${tenantId}.${mac}`;
}

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/notification/smsProviderConfigService.js', () => ({
  resolveSmsConfigByCallbackToken: resolveSmsConfigByCallbackTokenMock,
}));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  recordProviderReceiptTx: recordProviderReceiptTxMock,
}));
jest.unstable_mockModule('../../utils/fieldEncryption.js', () => ({
  decryptField: decryptFieldMock,
}));
// Mock shaped like the REAL twilio CJS module under ESM interop: the package
// exposes `validateRequest` as a property of module.exports (the default
// export) and NOT as a top-level named export. Deliberately no named
// `validateRequest` here — code that reads it off the import namespace
// (the pre-fix bug) finds undefined and fails these suites.
jest.unstable_mockModule('twilio', () => ({
  default: Object.assign(() => ({}), { validateRequest: validateRequestMock }),
}));

const { default: dlrRouter } = await import('../../routes/webhooks/smsDlrRoutes.js');
const { __testing__: dlrInternals } = await import(
  '../../services/notification/smsDeliveryStatusService.js'
);

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(express.urlencoded({ extended: true }));
  instance.use('/webhooks/sms', dlrRouter);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback({
    $queryRawUnsafe: txQueryRawUnsafeMock,
  }));
  txQueryRawUnsafeMock.mockResolvedValue([
    { attempt_id: 'aaaaaaaa-0000-4000-8000-000000000001', notification_outbox_id: 555 },
  ]);
  recordProviderReceiptTxMock.mockResolvedValue({
    receipt_id: 'bbbbbbbb-0000-4000-8000-000000000002',
  });
  resolveSmsConfigByCallbackTokenMock.mockImplementation(async (_token, provider) => ({
    id: 7,
    tenant_id: TENANT_ID,
    provider,
    auth_key_ciphertext: 'enc:key',
    callback_token_hash: 'f'.repeat(64),
  }));
  decryptFieldMock.mockReturnValue('twilio-auth-token');
});

describe('MSG91 DLR — token auth is the whole authentication', () => {
  it('returns 500 without logging the callback bearer when processing throws', async () => {
    resolveSmsConfigByCallbackTokenMock.mockRejectedValueOnce(
      Object.assign(new Error('database failure containing callback bearer'), { code: 'DB_DOWN' }),
    );

    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-log-redaction', status: 'delivered' });

    expect(res.status).toBe(500);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain('database failure');
  });

  it('provider-binds token resolution and rejects a Twilio config on the MSG91 path', async () => {
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue({
      id: 7, tenant_id: TENANT_ID, provider: 'twilio', auth_key_ciphertext: 'enc:key',
    });
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-cross-provider', status: 'delivered' });
    expect(res.status).toBe(401);
    expect(resolveSmsConfigByCallbackTokenMock).toHaveBeenCalledWith(TOKEN, 'msg91');
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('401s an unknown token and writes nothing', async () => {
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue(null);
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-1', status: 'delivered' });
    expect(res.status).toBe(401);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('records a delivered report as an acknowledged provider_status_callback receipt', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-123', status: 'delivered' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['recorded']);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(resolveSmsConfigByCallbackTokenMock).toHaveBeenCalledWith(TOKEN, 'msg91');
    expect(txQueryRawUnsafeMock.mock.calls[0][3]).toBe('msg91');
    expect(recordProviderReceiptTxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tenantId: TENANT_ID,
      attemptId: 'aaaaaaaa-0000-4000-8000-000000000001',
      outboxId: 555,
      channel: 'sms',
      outcome: 'acknowledged',
      receiptSource: 'provider_status_callback',
      providerReference: 'req-abc-123',
      providerCode: 'dlr_delivered',
    }));
  });

  it('maps a terminal failure (with operator code) to a rejected receipt', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-124', status: 'failed', code: 'DND' });
    expect(res.status).toBe(200);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'rejected',
      providerCode: 'dlr_failed_DND',
      receiptSource: 'provider_status_callback',
    }));
  });

  it('maps the documented MSG91 numeric codes (1=delivered)', async () => {
    await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-125', status: 1 });
    expect(recordProviderReceiptTxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'acknowledged',
      providerCode: 'dlr_delivered',
    }));
  });

  it('acks an intermediate status WITHOUT writing (protects the terminal unique)', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-126', status: 'queued' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['ignored_intermediate']);
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('acks an unrecognized status without writing (append-once safety)', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-127', status: 'weird-new-status' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['ignored_unknown_status']);
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('acks an unknown provider reference without writing (late/foreign DLR)', async () => {
    txQueryRawUnsafeMock.mockResolvedValue([]);
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-unknown', status: 'delivered' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['unknown_reference']);
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('acks a report with no reference without writing', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ status: 'delivered' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['ignored_no_reference']);
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('handles the batched report shape', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send([
        { requestId: 'req-b-1', report: [{ status: 'delivered' }] },
        { requestId: 'req-b-2', report: [{ status: 'failed', desc: 'ABSENT_SUBSCRIBER' }] },
      ]);
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['recorded', 'recorded']);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledTimes(2);
    expect(recordProviderReceiptTxMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'rejected',
      providerCode: 'dlr_failed_ABSENT_SUBSCRIBER',
    }));
  });

  it('decodes the real MSG91 form data field and processes every report', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .type('form')
      .send({
        data: JSON.stringify([{
          requestId: 'req-form-1',
          report: [{ status: 'delivered' }, { status: 'failed', code: 'DND' }],
        }]),
      });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['recorded', 'recorded']);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed authenticated form data instead of silently ACKing it', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .type('form')
      .send({ data: '[{"requestId":' });
    expect(res.status).toBe(400);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('rejects an authenticated batch over 50 before writing any partial receipt', async () => {
    const entries = Array.from({ length: 51 }, (_, i) => ({
      requestId: `req-overflow-${i}`,
      status: 'delivered',
    }));
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .type('form')
      .send({ data: JSON.stringify(entries) });
    expect(res.status).toBe(413);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('authenticates before decoding an oversized batch', async () => {
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue(null);
    const entries = Array.from({ length: 51 }, (_, i) => ({
      requestId: `req-unknown-${i}`,
      status: 'delivered',
    }));
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .type('form')
      .send({ data: JSON.stringify(entries) });
    expect(res.status).toBe(401);
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('never persists the recipient MSISDN into receipt evidence (allowlisted fields only)', async () => {
    const res = await request(app())
      .post(`/webhooks/sms/dlr/${TOKEN}`)
      .send([{
        requestId: 'req-phi-1',
        number: '919876543210',
        mobile: '+919876543210',
        code: '919876543210',
        report: [{ status: 'failed', desc: 'DND_919876543210', number: '919876543210' }],
      }]);
    expect(res.status).toBe(200);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledTimes(1);
    const { evidence } = recordProviderReceiptTxMock.mock.calls[0][1];
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('req-phi-1');
    expect(serialized).not.toContain('DND_');
  });

  it('a replayed terminal DLR is 200-acked (the receipt unique collapses it server-side)', async () => {
    // recordProviderReceiptTx resolves the EXISTING receipt on conflict — the
    // service treats both first-write and replay identically.
    await request(app()).post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-123', status: 'delivered' });
    const replay = await request(app()).post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-123', status: 'delivered' });
    expect(replay.status).toBe(200);
    expect(replay.body.data.results).toEqual(['recorded']);
  });

  it('never touches outbox status or cursors — only the receipt insert path runs', async () => {
    await request(app()).post(`/webhooks/sms/dlr/${TOKEN}`)
      .send({ requestId: 'req-abc-123', status: 'failed' });
    const sql = txQueryRawUnsafeMock.mock.calls.map(([q]) => q).join('\n');
    expect(sql).not.toMatch(/UPDATE\s+notification_outbox/i);
    expect(sql).not.toMatch(/notification_delivery_cursors/i);
  });
});

describe('Twilio status callback — token AND signature, fail-closed', () => {
  const form = { MessageSid: 'SM900', MessageStatus: 'delivered' };

  function postTwilio(overrides = {}) {
    const req = request(app())
      .post(`/webhooks/sms/twilio-status/${overrides.token ?? TOKEN}`)
      .type('form');
    if (overrides.signature !== null) {
      req.set('X-Twilio-Signature', overrides.signature ?? 'sig-ok');
    }
    return req.send(overrides.form ?? form);
  }

  it('returns 500 without logging the callback bearer when processing throws', async () => {
    resolveSmsConfigByCallbackTokenMock.mockRejectedValueOnce(
      Object.assign(new Error('database failure containing callback bearer'), { code: 'DB_DOWN' }),
    );
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';

    const res = await postTwilio();

    expect(res.status).toBe(500);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(loggerMock.error.mock.calls)).not.toContain('database failure');
  });

  it('401s an unknown token', async () => {
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue(null);
    const res = await postTwilio();
    expect(res.status).toBe(401);
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('provider-binds token resolution and rejects an MSG91 config on the Twilio path', async () => {
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue({
      id: 7, tenant_id: TENANT_ID, provider: 'msg91', auth_key_ciphertext: 'enc:key',
    });
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    const res = await postTwilio();
    expect(res.status).toBe(401);
    expect(resolveSmsConfigByCallbackTokenMock).toHaveBeenCalledWith(TOKEN, 'twilio');
    expect(validateRequestMock).not.toHaveBeenCalled();
  });

  it('fails closed when PUBLIC_BASE_URL is not configured', async () => {
    const res = await postTwilio();
    expect(res.status).toBe(401);
    expect(validateRequestMock).not.toHaveBeenCalled();
  });

  it('fails closed on a missing signature header', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    const res = await postTwilio({ signature: null });
    expect(res.status).toBe(401);
  });

  it('401s an invalid signature', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    validateRequestMock.mockReturnValue(false);
    const res = await postTwilio();
    expect(res.status).toBe(401);
    expect(validateRequestMock).toHaveBeenCalledWith(
      'twilio-auth-token',
      'sig-ok',
      `https://api.vhhealth.app/webhooks/sms/twilio-status/${TOKEN}`,
      expect.objectContaining({ MessageSid: 'SM900' }),
    );
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('records a verified delivered status as acknowledged', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    validateRequestMock.mockReturnValue(true);
    const res = await postTwilio();
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['recorded']);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'acknowledged',
      providerReference: 'SM900',
      providerCode: 'dlr_delivered',
      receiptSource: 'provider_status_callback',
    }));
  });

  it('records a verified undelivered status as rejected with the Twilio error code', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    validateRequestMock.mockReturnValue(true);
    const res = await postTwilio({
      form: { MessageSid: 'SM901', MessageStatus: 'undelivered', ErrorCode: '30003' },
    });
    expect(res.status).toBe(200);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      outcome: 'rejected',
      providerCode: 'dlr_undelivered_30003',
    }));
  });

  it('never persists Twilio destination or phone-like error fields as evidence', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    validateRequestMock.mockReturnValue(true);
    const res = await postTwilio({
      form: {
        MessageSid: 'SM903', MessageStatus: 'undelivered',
        ErrorCode: '919876543210', To: '+919876543210',
      },
    });
    expect(res.status).toBe(200);
    const call = recordProviderReceiptTxMock.mock.calls[0][1];
    expect(call.providerCode).toBe('dlr_undelivered');
    expect(JSON.stringify(call.evidence)).not.toContain('9876543210');
    expect(JSON.stringify(call.evidence)).not.toContain('SM903');
  });

  it('acks a verified intermediate status without writing', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    validateRequestMock.mockReturnValue(true);
    const res = await postTwilio({ form: { MessageSid: 'SM902', MessageStatus: 'sent' } });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual(['ignored_intermediate']);
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });

  it('resolves validateRequest from the twilio DEFAULT export (CJS interop) — the namespace has no named export', async () => {
    // Regression: the real twilio package has no named `validateRequest`
    // under ESM interop; reading it off the import namespace makes every
    // legitimate DLR fail closed with 401. The mock above mirrors the real
    // shape (default-only), so this test fails with the namespace bug.
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    validateRequestMock.mockReturnValue(true);
    const res = await postTwilio();
    expect(res.status).toBe(200);
    expect(validateRequestMock).toHaveBeenCalledTimes(1);
    expect(recordProviderReceiptTxMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a database callback token whose config has no bound auth ciphertext', async () => {
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue({
      id: 8, tenant_id: TENANT_ID, provider: 'twilio', auth_key_ciphertext: null,
    });
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    process.env.TWILIO_AUTH_TOKEN = 'env-twilio-token';
    validateRequestMock.mockReturnValue(true);
    const res = await postTwilio();
    expect(res.status).toBe(401);
    expect(validateRequestMock).not.toHaveBeenCalled();
  });

  it('verifies an env-minted callback with the env send secret despite a stale disabled DB config', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    process.env.TWILIO_ACCOUNT_SID = 'AC-current-env';
    process.env.TWILIO_AUTH_TOKEN = 'current-env-auth';
    resolveSmsConfigByCallbackTokenMock.mockResolvedValue({
      id: 8, tenant_id: TENANT_ID, provider: 'twilio', enabled: false,
      auth_key_ciphertext: 'enc:stale-db-auth',
    });
    decryptFieldMock.mockReturnValue('stale-db-auth');
    validateRequestMock.mockReturnValue(true);
    const token = envTwilioCallbackToken(
      TENANT_ID, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN,
    );

    const res = await postTwilio({ token });

    expect(res.status).toBe(200);
    expect(resolveSmsConfigByCallbackTokenMock).not.toHaveBeenCalled();
    expect(decryptFieldMock).not.toHaveBeenCalled();
    expect(validateRequestMock).toHaveBeenCalledWith(
      'current-env-auth', 'sig-ok',
      `https://api.vhhealth.app/webhooks/sms/twilio-status/${token}`,
      expect.objectContaining({ MessageSid: 'SM900' }),
    );
  });

  it('rejects an env callback token minted under a different auth source without consulting DB config', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    process.env.TWILIO_ACCOUNT_SID = 'AC-current-env';
    process.env.TWILIO_AUTH_TOKEN = 'current-env-auth';
    const staleToken = envTwilioCallbackToken(
      TENANT_ID, process.env.TWILIO_ACCOUNT_SID, 'stale-env-auth',
    );

    const res = await postTwilio({ token: staleToken });

    expect(res.status).toBe(401);
    expect(resolveSmsConfigByCallbackTokenMock).not.toHaveBeenCalled();
    expect(validateRequestMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptTxMock).not.toHaveBeenCalled();
  });
});

describe('status classification table', () => {
  it.each([
    ['0', 'intermediate', 'sent'],
    ['1', 'acknowledged', 'delivered'],
    ['2', 'rejected', 'failed'],
    ['9', 'rejected', 'ndnc'],
    ['16', 'rejected', 'rejected'],
    ['17', 'rejected', 'blocked'],
    ['20', 'rejected', 'blocked'],
    ['25', 'rejected', 'rejected'],
  ])('maps documented MSG91 numeric status %s to %s/%s', (raw, kind, status) => {
    expect(dlrInternals.classifyDlrStatus(raw)).toEqual({ kind, status });
  });

  it.each([
    ['delivered', 'acknowledged'],
    ['DELIVERED', 'acknowledged'],
    ['failed', 'rejected'],
    ['undelivered', 'rejected'],
    ['rejected', 'rejected'],
    ['expired', 'rejected'],
    ['queued', 'intermediate'],
    ['sent', 'intermediate'],
    ['submitted', 'intermediate'],
    ['0', 'intermediate'],
    ['9', 'rejected'],
    ['16', 'rejected'],
    ['17', 'rejected'],
    ['20', 'rejected'],
    ['25', 'rejected'],
    ['2', 'rejected'],
    ['', 'unknown'],
  ])('classifies %s as %s', (status, kind) => {
    expect(dlrInternals.classifyDlrStatus(status).kind).toBe(kind);
  });
});
