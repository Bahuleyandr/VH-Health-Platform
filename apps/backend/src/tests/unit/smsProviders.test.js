// src/tests/unit/smsProviders.test.js
//
// The SMS provider layer behind the sendSMS seam (migrations 699/700):
//   * resolution is config-gated DEFAULT OFF — kill switch, tenant settings
//     gate, tenant config row, env fallback, dry-run fallback in that order;
//   * the DLT template gate is fail-closed: no active registration for the
//     outbox template key ⇒ terminal rejection `dlt_template_not_registered`
//     and the provider HTTP call is never made;
//   * the MSG91 adapter classifies accepted / provider-rejected / transport-
//     uncertain honestly (an HTTP 200 with a request id is acknowledged
//     ACCEPTANCE evidence, not delivery — the DLR refines it later);
//   * the Twilio adapter does the same through the SDK.

import crypto from 'node:crypto';
import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000021';
const TEMPLATE_KEY = 'sms.investigation_booking_confirmed.v1';

const getSmsSettingsMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const decryptFieldMock = jest.fn();
const twilioCreateMock = jest.fn();
const twilioClientMock = jest.fn(() => ({ messages: { create: twilioCreateMock } }));
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getSmsSettings: getSmsSettingsMock,
}));
jest.unstable_mockModule('../../utils/fieldEncryption.js', () => ({
  decryptField: decryptFieldMock,
}));
jest.unstable_mockModule('twilio', () => ({
  default: twilioClientMock,
  validateRequest: jest.fn(),
}));

const { resolveSmsProviderContext, sendThroughResolvedProvider } = await import(
  '../../utils/notifications/smsProviders/index.js'
);
const { sendSMS } = await import('../../services/smsService.js');
const { sendViaMsg91 } = await import('../../utils/notifications/smsProviders/msg91Provider.js');
const { sendViaTwilioSms } = await import(
  '../../utils/notifications/smsProviders/twilioSmsProvider.js'
);
const { isTerminalRejectionCode } = await import(
  '../../utils/notifications/terminalRejectionCodes.js'
);

const realFetch = global.fetch;
let fetchMock;

function configRow(overrides = {}) {
  return {
    id: 7,
    tenant_id: TENANT_ID,
    provider: 'msg91',
    enabled: true,
    sender_id: 'VHHLTH',
    dlt_entity_id: '110100001234567890',
    auth_key_ciphertext: 'enc:authkey',
    callback_token_ciphertext: 'enc:callback-token',
    account_sid: null,
    ...overrides,
  };
}

function registrationRow(overrides = {}) {
  return {
    id: 31,
    provider_config_id: 7,
    dlt_template_id: '1107100000000012345',
    provider_template_id: null,
    ...overrides,
  };
}

function expectedEnvTwilioCallbackToken(tenantId, accountSid, authToken) {
  const mac = crypto.createHmac('sha256', authToken)
    .update(`vhhealth:twilio-status:v1:${tenantId}:${accountSid}`)
    .digest('base64url');
  return `env.${tenantId}.${mac}`;
}

function stubDb({ configs = [], templates = [] } = {}) {
  queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
    if (/FROM sms_provider_configs/.test(sql) && /enabled = true/.test(sql)) {
      return configs.filter(config => config.enabled === true);
    }
    if (/FROM sms_provider_configs/.test(sql)) {
      return configs.filter(config => !params[1] || config.provider === params[1]);
    }
    if (/FROM sms_template_registrations/.test(sql)) return templates;
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SMS_PROVIDER;
  delete process.env.MSG91_AUTH_KEY;
  delete process.env.MSG91_SENDER_ID;
  delete process.env.MSG91_DLT_ENTITY_ID;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_FROM;
  delete process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
  getSmsSettingsMock.mockResolvedValue({ enabled: true });
  decryptFieldMock.mockImplementation(value => (
    value === 'enc:callback-token'
      ? 'tok_abcdefghijklmnopqrstuvwxyz01'
      : 'decrypted-auth-key'
  ));
  stubDb();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterAll(() => {
  global.fetch = realFetch;
});

describe('provider resolution (config-gated DEFAULT OFF)', () => {
  it('resolves dry_run when the tenant settings gate is closed (the default)', async () => {
    getSmsSettingsMock.mockResolvedValue({ enabled: false });
    stubDb({ configs: [configRow()] });
    const resolved = await resolveSmsProviderContext(TENANT_ID);
    expect(resolved).toMatchObject({ provider: 'dry_run', reason: 'tenant_disabled' });
  });

  it('SMS_PROVIDER=logger is a deployment-wide kill switch that beats tenant config', async () => {
    process.env.SMS_PROVIDER = 'logger';
    stubDb({ configs: [configRow()] });
    const resolved = await resolveSmsProviderContext(TENANT_ID);
    expect(resolved).toMatchObject({ provider: 'dry_run', source: 'env', reason: 'env_kill_switch' });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('prefers the tenant enabled config row over env fallback', async () => {
    process.env.SMS_PROVIDER = 'msg91';
    process.env.MSG91_AUTH_KEY = 'env-key';
    process.env.MSG91_SENDER_ID = 'ENVSND';
    process.env.MSG91_DLT_ENTITY_ID = 'env-entity';
    stubDb({ configs: [configRow({ provider: 'twilio', account_sid: 'AC123' })] });
    const resolved = await resolveSmsProviderContext(TENANT_ID);
    expect(resolved).toMatchObject({ provider: 'twilio', source: 'tenant_config' });
  });

  it('falls back to complete env credentials when the tenant has no config row', async () => {
    process.env.SMS_PROVIDER = 'msg91';
    process.env.MSG91_AUTH_KEY = 'env-key';
    process.env.MSG91_SENDER_ID = 'ENVSND';
    process.env.MSG91_DLT_ENTITY_ID = 'env-entity';
    const resolved = await resolveSmsProviderContext(TENANT_ID);
    expect(resolved).toMatchObject({ provider: 'msg91', source: 'env' });
  });

  it('keeps env Twilio credentials independent of a stale disabled database config', async () => {
    process.env.SMS_PROVIDER = 'twilio';
    process.env.TWILIO_ACCOUNT_SID = 'AC-env';
    process.env.TWILIO_AUTH_TOKEN = 'env-auth';
    process.env.TWILIO_SMS_FROM = 'VHHLTH';
    stubDb({ configs: [configRow({ provider: 'twilio', enabled: false, account_sid: null })] });
    const resolved = await resolveSmsProviderContext(TENANT_ID);
    expect(resolved).toMatchObject({ provider: 'twilio', source: 'env', config: null });
  });

  it('an env provider with incomplete credentials stays dry_run', async () => {
    process.env.SMS_PROVIDER = 'msg91';
    process.env.MSG91_AUTH_KEY = 'env-key';
    const resolved = await resolveSmsProviderContext(TENANT_ID);
    expect(resolved).toMatchObject({ provider: 'dry_run', reason: 'env_credentials_incomplete' });
  });

  it('resolves dry_run without a tenant id (never a cross-tenant guess)', async () => {
    const resolved = await resolveSmsProviderContext(null);
    expect(resolved).toMatchObject({ provider: 'dry_run', reason: 'tenant_unresolved' });
  });
});

describe('dry-run default through the seam', () => {
  it('classifies as rejected(sms_gateway_not_configured) and never claims a delivery', async () => {
    getSmsSettingsMock.mockResolvedValue({ enabled: false });
    const result = await sendSMS('9876543210', 'Patient Alice has an appointment', {
      tenantId: TENANT_ID, templateVersion: TEMPLATE_KEY, outboxId: 12,
    });
    expect(result).toMatchObject({
      outcome: 'rejected',
      providerCode: 'sms_gateway_not_configured',
    });
    expect(result.evidence).toMatchObject({ dry_run: true, reason: 'tenant_disabled' });
    const logs = JSON.stringify(loggerMock.info.mock.calls);
    expect(logs).not.toContain('9876543210');
    expect(logs).not.toContain('Patient Alice');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unresolvable phone as phone_missing before any provider work', async () => {
    const result = await sendSMS('12345', 'Hello', { tenantId: TENANT_ID });
    expect(result).toMatchObject({ outcome: 'rejected', providerCode: 'phone_missing' });
    expect(getSmsSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects foreign E.164 numbers instead of rewriting their last ten digits as Indian', async () => {
    const result = await sendSMS('+14155552671', 'Hello', { tenantId: TENANT_ID });
    expect(result).toMatchObject({ outcome: 'rejected', providerCode: 'phone_missing' });
    expect(getSmsSettingsMock).not.toHaveBeenCalled();
  });

  it('keeps the provider adapters fail-closed when invoked directly with foreign E.164', async () => {
    await expect(sendViaMsg91({
      authKey: 'key', senderId: 'VHHLTH', dltTemplateId: 'dlt-1',
      phone: '+14155552671', message: 'Hello',
    })).resolves.toMatchObject({ outcome: 'rejected', providerCode: 'phone_missing' });
    await expect(sendViaTwilioSms({
      accountSid: 'AC1', authToken: 'key', from: 'VHHLTH',
      phone: '+14155552671', message: 'Hello',
      statusCallback: 'https://api.vhhealth.app/webhooks/sms/twilio-status/test_token_abcdefghijklmnop',
    })).resolves.toMatchObject({ outcome: 'rejected', providerCode: 'phone_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(twilioCreateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['98765 43210', '919876543210'],
    ['09876543210', '919876543210'],
    ['+91-98765-43210', '919876543210'],
  ])('normalizes supported Indian SMS format %s without changing identity', async (input, output) => {
    stubDb({ configs: [configRow()], templates: [registrationRow()] });
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ type: 'success', message: 'req-normalized' }),
    });
    await sendSMS(input, 'Hello', { tenantId: TENANT_ID, templateVersion: TEMPLATE_KEY });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sms[0].to).toEqual([output]);
  });
});

describe('DLT template gate (fail-closed)', () => {
  it('requires the registration to belong to the exact resolved provider config', async () => {
    stubDb({ configs: [configRow({ id: 7 })], templates: [] });
    await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 12,
    });
    const lookup = queryRawUnsafeMock.mock.calls.find(([sql]) => /sms_template_registrations/.test(sql));
    expect(lookup[0]).toMatch(/r\.provider_config_id = \$3::integer/);
    expect(lookup[0]).toMatch(/c\.provider = \$4::text/);
    expect(lookup.slice(1)).toEqual([TENANT_ID, TEMPLATE_KEY, 7, 'msg91']);
  });

  it('terminally rejects a template kind with no active registration — no HTTP call', async () => {
    stubDb({ configs: [configRow()], templates: [] });
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: 'sms.unregistered_kind.v1', outboxId: 13,
    });
    expect(result).toMatchObject({
      outcome: 'rejected',
      providerCode: 'dlt_template_not_registered',
    });
    expect(result.evidence).toMatchObject({ template_key: 'sms.unregistered_kind.v1' });
    expect(fetchMock).not.toHaveBeenCalled();
    // Terminal per-row: dead-letters without wedging the channel cursor.
    expect(isTerminalRejectionCode('dlt_template_not_registered')).toBe(true);
  });

  it('a missing template key (ad-hoc SMS) fails the same closed way', async () => {
    stubDb({ configs: [configRow()], templates: [registrationRow()] });
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: null, outboxId: 14,
    });
    expect(result).toMatchObject({ outcome: 'rejected', providerCode: 'dlt_template_not_registered' });
  });
});

describe('MSG91 adapter classification', () => {
  beforeEach(() => {
    stubDb({ configs: [configRow()], templates: [registrationRow()] });
  });

  it('acknowledges an accepted send and keeps the request id as the DLR correlation reference', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ type: 'success', message: 'req-abc-123' }),
    });
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Your booking is confirmed.',
      tenantId: TENANT_ID, templateVersion: TEMPLATE_KEY, outboxId: 15,
    });
    expect(result).toMatchObject({
      outcome: 'acknowledged',
      providerReference: 'req-abc-123',
      providerCode: 'accepted',
    });
    expect(decryptFieldMock).toHaveBeenCalledWith('enc:authkey');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.msg91.com/api/v2/sendsms');
    expect(init.headers).toMatchObject({ authkey: 'decrypted-auth-key' });
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      sender: 'VHHLTH',
      route: '4',
      DLT_TE_ID: '1107100000000012345',
    });
    expect(body.sms).toEqual([{ message: 'Your booking is confirmed.', to: ['919876543210'] }]);
  });

  it('classifies a provider-side error as rejected with the provider code', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        type: 'error', code: '311', message: 'Invalid number +919876543210 for Patient Alice',
      }),
    });
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 16,
    });
    expect(result).toMatchObject({ outcome: 'rejected', providerCode: 'msg91_311' });
    expect(JSON.stringify(result.evidence)).not.toContain('9876543210');
    expect(JSON.stringify(result.evidence)).not.toContain('Patient Alice');
  });

  it('classifies an HTTP 401 as rejected (retrying the same credentials cannot succeed)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 17,
    });
    expect(result).toMatchObject({ outcome: 'rejected', providerCode: 'msg91_http_401' });
  });

  it('classifies a network fault as uncertain — the send may have been accepted', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 18,
    });
    expect(result).toMatchObject({ outcome: 'uncertain', providerCode: 'msg91_transport_failure' });
  });

  it('classifies a 5xx as uncertain, never rejected', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 19,
    });
    expect(result).toMatchObject({ outcome: 'uncertain', providerCode: 'msg91_no_acceptance_unresolved' });
  });
});

describe('Twilio adapter classification', () => {
  beforeEach(() => {
    stubDb({
      configs: [configRow({ provider: 'twilio', account_sid: 'AC0011' })],
      templates: [registrationRow({ provider_template_id: 'HX-content-sid' })],
    });
  });

  it('acknowledges an accepted message with the sid as the correlation reference', async () => {
    twilioCreateMock.mockResolvedValue({ sid: 'SM123', status: 'queued' });
    process.env.TWILIO_SMS_FROM = '+15005550006';
    process.env.PUBLIC_BASE_URL = 'https://api.vhhealth.app';
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 20,
    });
    // Tenant config supplies sid + auth token; from falls back to the config
    // sender_id (VHHLTH is not E.164, but Twilio alphanumeric senders are
    // legal in India via DLT) — the adapter passes it through untouched.
    expect(result).toMatchObject({
      outcome: 'acknowledged',
      providerReference: 'SM123',
      providerCode: 'accepted',
    });
    expect(twilioCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      to: '+919876543210',
      statusCallback: 'https://api.vhhealth.app/webhooks/sms/twilio-status/tok_abcdefghijklmnopqrstuvwxyz01',
    }));
  });

  it('mints the env callback from the exact env account/auth source, never a disabled DB token', async () => {
    process.env.SMS_PROVIDER = 'twilio';
    process.env.TWILIO_ACCOUNT_SID = 'AC-current-env';
    process.env.TWILIO_AUTH_TOKEN = 'current-env-auth';
    process.env.TWILIO_SMS_FROM = '+15005550006';
    stubDb({
      configs: [configRow({
        provider: 'twilio', enabled: false, account_sid: 'AC-stale-db',
        auth_key_ciphertext: 'enc:stale-db-auth',
        callback_token_ciphertext: 'enc:callback-token',
      })],
      templates: [registrationRow({ provider_template_id: 'HX-content-sid' })],
    });
    twilioCreateMock.mockResolvedValue({ sid: 'SM-env', status: 'queued' });

    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 24,
    });

    expect(result.outcome).toBe('acknowledged');
    const token = expectedEnvTwilioCallbackToken(
      TENANT_ID, process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN,
    );
    expect(twilioCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      statusCallback: `https://api.vhhealth.app/webhooks/sms/twilio-status/${token}`,
    }));
    expect(twilioClientMock).toHaveBeenCalledWith('AC-current-env', 'current-env-auth');
    expect(decryptFieldMock).not.toHaveBeenCalledWith('enc:callback-token');
    expect(decryptFieldMock).not.toHaveBeenCalledWith('enc:stale-db-auth');
  });

  it('fails closed before sending when a verifiable status callback cannot be constructed', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 23,
    });
    expect(result).toMatchObject({
      outcome: 'rejected', providerCode: 'sms_config_credentials_unreadable',
    });
    expect(twilioCreateMock).not.toHaveBeenCalled();
  });

  it('classifies a Twilio 4xx REST error as rejected with the Twilio code', async () => {
    twilioCreateMock.mockRejectedValue(Object.assign(new Error('not a mobile number +919876543210'), {
      status: 400, code: 21614,
    }));
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 21,
    });
    expect(result).toMatchObject({ outcome: 'rejected', providerCode: 'twilio_21614' });
    expect(JSON.stringify(result.evidence)).not.toContain('9876543210');
  });

  it('classifies a Twilio 5xx as uncertain', async () => {
    twilioCreateMock.mockRejectedValue(Object.assign(new Error('service unavailable'), {
      status: 503,
    }));
    const result = await sendThroughResolvedProvider({
      phone: '919876543210', message: 'Hi', tenantId: TENANT_ID,
      templateVersion: TEMPLATE_KEY, outboxId: 22,
    });
    expect(result).toMatchObject({ outcome: 'uncertain', providerCode: 'twilio_transport_failure' });
  });
});
