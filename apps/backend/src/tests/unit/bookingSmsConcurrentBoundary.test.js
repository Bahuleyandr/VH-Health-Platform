import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { jest } from '@jest/globals';
import twilio from 'twilio';
import { getCurrentTenantContext, runInTenantContext } from '../../lib/tenantContext.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000021';
const PATIENT_UID = '00000000-0000-4000-8000-000000000022';
const TEMPLATE = 'sms.investigation_booking_confirmed.v1';
const events = [];
const receiptMock = jest.fn(async input => ({ ...input, receipt_id: 'receipt' }));
const settingsMock = jest.fn();
const queryMock = jest.fn();
const authorityQuery = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryMock },
  setTenant: jest.fn(),
  setTenantTx: async (tenantId, work) => runInTenantContext(tenantId, async () => {
    events.push('authority begin');
    const result = await work({ $queryRawUnsafe: authorityQuery });
    events.push('authority commit');
    return result;
  }, { inSetTenant: true }),
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({ disconnectRedis: jest.fn() }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getTenantSettings: async () => ({}), getSmsSettings: settingsMock,
}));
jest.unstable_mockModule('../../utils/fieldEncryption.js', () => ({
  decryptField: value => {
    expect(getCurrentTenantContext()).toEqual({ tenantId: TENANT_ID, superAdmin: false, inSetTenant: false });
    return value === 'callback' ? 'synthetic_callback_token_123456789' : 'synthetic-auth';
  },
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({ dispatch: jest.fn() }));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({ sendPushNotification: jest.fn() }));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  beginProviderAttempts: async () => {
    events.push('attempt committed');
    return [{ state: 'ready', channel: 'sms', attempt_id: 'attempt' }];
  },
  recordProviderReceipt: receiptMock,
  applyProviderReceiptToCursor: jest.fn(),
}));

const { deliverNotificationOutboxRow } = await import('../../utils/notifications/notificationOutboxDelivery.js');
const { prepareTwilioSms } = await import('../../utils/notifications/smsProviders/twilioSmsProvider.js');
const { prepareMsg91Sms } = await import('../../utils/notifications/smsProviders/msg91Provider.js');

const adapterInput = {
  accountSid: `AC${'0'.repeat(32)}`, authToken: 'synthetic-auth', from: 'VHHLTH',
  phone: '9000000001', message: 'Synthetic test message',
  statusCallback: 'https://callback.invalid/synthetic', boundedTransport: true,
};
let server;
let requestSpy;
let respond;
let requests;
let responseClosed;
const sockets = new Set();
const timers = new Set();
const savedEnvironment = new Map();

beforeAll(async () => {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy',
    'all_proxy', 'TWILIO_CA_BUNDLE', 'TWILIO_LOG_LEVEL', 'SMS_PROVIDER', 'PUBLIC_BASE_URL']) {
    savedEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.PUBLIC_BASE_URL = 'https://callback.invalid';
  server = http.createServer((request, response) => {
    requests += 1;
    expect(request.headers.authorization).toBeUndefined();
    request.resume();
    response.on('close', () => responseClosed.resolve());
    respond(response);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = twilio.RequestClient.prototype.request;
  requestSpy = jest.spyOn(twilio.RequestClient.prototype, 'request').mockImplementation(function (options) {
    expect(options.uri).toBe(`https://api.twilio.com/2010-04-01/Accounts/${adapterInput.accountSid}/Messages.json`);
    expect(this.autoRetry).toBe(false);
    events.push('transport');
    const headers = { ...options.headers };
    delete headers.Authorization;
    delete headers.authorization;
    return original.call(this, {
      ...options, headers, username: undefined, password: undefined, authStrategy: undefined,
      uri: `http://127.0.0.1:${server.address().port}/synthetic-sms`, allowRedirects: false,
    });
  });
});

beforeEach(() => {
  events.length = 0;
  requests = 0;
  responseClosed = Promise.withResolvers();
  receiptMock.mockClear();
  requestSpy.mockClear();
  settingsMock.mockImplementation(async () => {
    expect(getCurrentTenantContext()).toEqual({ tenantId: TENANT_ID, superAdmin: false, inSetTenant: false });
    events.push('settings');
    return { enabled: true };
  });
  queryMock.mockImplementation(async sql => {
    expect(getCurrentTenantContext()).toEqual({ tenantId: TENANT_ID, superAdmin: false, inSetTenant: false });
    if (sql.includes('FROM sms_provider_configs')) {
      events.push('config');
      return [{ id: 7, provider: 'twilio', enabled: true, sender_id: 'VHHLTH',
        account_sid: adapterInput.accountSid, auth_key_ciphertext: 'auth', callback_token_ciphertext: 'callback' }];
    }
    expect(sql).toContain('FROM sms_template_registrations');
    events.push('template');
    return [{ dlt_template_id: 'synthetic-dlt' }];
  });
  authorityQuery.mockImplementation(async sql => {
    expect(getCurrentTenantContext().inSetTenant).toBe(true);
    if (sql.includes('set_config')) return [];
    expect(sql).toContain('FOR SHARE');
    events.push(sql.includes('FROM users') ? 'patient lock' : 'booking lock');
    return [{ patient_id: '42', patient_uid: PATIENT_UID, phone: '9000000001' }];
  });
  respond = response => {
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ sid: 'SM-synthetic', status: 'queued' }));
  };
});

afterEach(() => {
  for (const timer of timers) clearInterval(timer);
  timers.clear();
  for (const socket of sockets) socket.destroy();
});

afterAll(async () => {
  requestSpy?.mockRestore();
  await new Promise(resolve => server.close(resolve));
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('uses the actual prepared Twilio SDK after scoped preparation and both recipient locks', async () => {
  const result = await deliverNotificationOutboxRow({
    id: 1, tenant_id: TENANT_ID, type: 'sms', recipient_id: '42', recipient_phone: '9000000001',
    template_version: TEMPLATE, source_event_key: 'investigation-booking-confirmed:17',
    payload: { type: 'investigation_confirmed', booking_id: '17' }, body: 'Synthetic test message',
  });
  expect(result.outcome).toBe('acknowledged');
  expect(events).toEqual(['attempt committed', 'settings', 'config', 'template', 'authority begin',
    'patient lock', 'booking lock', 'transport', 'authority commit']);
  expect(requests).toBe(1);
  expect(receiptMock).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'acknowledged', providerReference: 'SM-synthetic',
  }));
});

test('cancels the real SDK request during a trickling body and never retries it', async () => {
  respond = response => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"sid":"');
    const timer = setInterval(() => response.write('x'), 20);
    timers.add(timer);
    response.on('close', () => clearInterval(timer));
  };
  const prepared = await prepareTwilioSms(adapterInput);
  expect(prepared.send).toEqual(expect.any(Function));
  const result = await prepared.send({ signal: AbortSignal.timeout(200), startBefore: performance.now() + 1000 });
  expect(result).toMatchObject({ outcome: 'uncertain', providerCode: 'twilio_transport_failure' });
  await responseClosed.promise;
  expect(requests).toBe(1);
  expect(requestSpy).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(adapterInput.phone);
});

test('does not retry a real SDK 429 rejection', async () => {
  respond = response => {
    response.writeHead(429, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 20429, message: 'Synthetic rate limit' }));
  };
  const prepared = await prepareTwilioSms(adapterInput);
  expect(await prepared.send({ signal: AbortSignal.timeout(1000), startBefore: performance.now() + 1000 }))
    .toMatchObject({ outcome: 'rejected', providerCode: 'twilio_20429' });
  expect(requests).toBe(1);
  expect(requestSpy).toHaveBeenCalledTimes(1);
});

test.each(['expired admission', 'already cancelled'])('does not dispatch the real SDK request with %s', async reason => {
  const prepared = await prepareTwilioSms(adapterInput);
  const controller = new AbortController();
  if (reason === 'already cancelled') controller.abort();
  const result = await prepared.send({
    signal: controller.signal, startBefore: performance.now() + (reason === 'expired admission' ? -1 : 1000),
  });
  expect(result).toMatchObject({ outcome: 'uncertain', providerCode: 'twilio_transport_failure' });
  expect(requests).toBe(0);
});

test('MSG91 cancellation after headers remains uncertain and its body read is not retried', async () => {
  const originalFetch = global.fetch;
  const controller = new AbortController();
  const bodyRead = jest.fn(() => new Promise((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Synthetic abort')), { once: true });
    controller.abort();
  }));
  global.fetch = jest.fn(async (_url, input) => {
    expect(input.signal).toBe(controller.signal);
    return { ok: true, status: 200, json: bodyRead };
  });
  try {
    const prepared = prepareMsg91Sms({ authKey: 'synthetic', senderId: 'VHHLTH',
      dltEntityId: 'synthetic-entity', dltTemplateId: 'synthetic-template', phone: '9000000001', message: 'Synthetic' });
    expect(await prepared.send({ signal: controller.signal, startBefore: performance.now() + 1000 }))
      .toMatchObject({ outcome: 'uncertain', providerCode: 'msg91_transport_failure' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(bodyRead).toHaveBeenCalledTimes(1);
  } finally {
    global.fetch = originalFetch;
  }
});

test.each(['expired admission', 'already cancelled'])('MSG91 does not dispatch with %s', async reason => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn();
  const controller = new AbortController();
  if (reason === 'already cancelled') controller.abort();
  try {
    const prepared = prepareMsg91Sms({ authKey: 'synthetic', senderId: 'VHHLTH',
      dltEntityId: 'synthetic-entity', dltTemplateId: 'synthetic-template', phone: '9000000001', message: 'Synthetic' });
    expect(await prepared.send({ signal: controller.signal,
      startBefore: performance.now() + (reason === 'expired admission' ? -1 : 1000) }))
      .toMatchObject({ outcome: 'uncertain', providerCode: 'msg91_transport_failure' });
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    global.fetch = originalFetch;
  }
});
