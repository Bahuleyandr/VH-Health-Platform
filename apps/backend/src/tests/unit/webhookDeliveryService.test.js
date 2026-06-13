/**
 * Phase A3 PR2 — webhookDeliveryService unit tests.
 *
 * Mocks prisma + the subscription / signing / log helpers so we can
 * drive every branch of the dispatcher (success / 5xx retryable /
 * 4xx non-retryable / network error / dead-after-N-attempts) without
 * a live HTTP endpoint.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const recordSuccessMock = jest.fn(async () => null);
const recordFailureMock = jest.fn(async () => null);
const writeLogMock = jest.fn(async () => null);
const signMock = jest.fn(() => ({
  signature: 'sig',
  header_value: 't=1,sig=abc,algo=hmac-sha256',
  algorithm: 'hmac-sha256',
  timestamp: 1,
}));

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../services/integrations/webhookSubscriptionService.js', () => ({
  recordSubscriptionFailure: recordFailureMock,
  recordSubscriptionSuccess: recordSuccessMock,
  signWebhookPayload: signMock,
}));
jest.unstable_mockModule('../../services/integrations/integrationService.js', () => ({
  writeIntegrationLog: writeLogMock,
}));

const {
  dispatchPendingDeliveries,
  enqueueDelivery,
  getDelivery,
  listDeliveries,
  markDeliveryDead,
  redriveDelivery,
  __testing__,
} = await import('../../services/integrations/webhookDeliveryService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordSuccessMock.mockReset();
  recordFailureMock.mockReset();
  writeLogMock.mockReset();
  signMock.mockClear();
  delete process.env.WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS;
  delete process.env.WEBHOOK_DELIVERY_HOST_ALLOWLIST;
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

// ---------------------------------------------------------------------------
// enqueueDelivery
// ---------------------------------------------------------------------------
describe('enqueueDelivery', () => {
  it('rejects empty event_type', async () => {
    await expect(enqueueDelivery({ tenantId: TENANT })).rejects.toThrow(/event_type/);
  });

  it('returns matched=0 when no active subscription matches', async () => {
    mockNext([]);
    const result = await enqueueDelivery({ tenantId: TENANT, eventType: 'patient.admitted' });
    expect(result).toEqual({ matched: 0, enqueued: [] });
  });

  it('halts gracefully when webhook_subscriptions is missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_subscriptions" does not exist'));
    const result = await enqueueDelivery({ tenantId: TENANT, eventType: 'patient.admitted' });
    expect(result.skipped_reason).toBe('webhook_subscriptions_unavailable');
    expect(result.matched).toBe(0);
  });

  it('inserts one delivery per matching subscription', async () => {
    mockNext([
      { id: 1, integration_id: 10, endpoint_url: 'https://a.example/h', signing_credential_id: 1, signing_algorithm: 'hmac-sha256' },
      { id: 2, integration_id: 11, endpoint_url: 'https://b.example/h', signing_credential_id: 2, signing_algorithm: 'none' },
    ]);
    mockNext([{ id: 100, subscription_id: 1, status: 'pending', attempt_number: 0 }]);
    mockNext([{ id: 101, subscription_id: 2, status: 'pending', attempt_number: 0 }]);

    const result = await enqueueDelivery({
      tenantId: TENANT, eventType: 'patient.admitted', payload: { patient_uid: 'X' },
    });
    expect(result.matched).toBe(2);
    expect(result.enqueued).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// dispatchPendingDeliveries
// ---------------------------------------------------------------------------
describe('dispatchPendingDeliveries — happy path', () => {
  it('marks delivery succeeded on HTTP 2xx + records subscription success', async () => {
    // 1. Claim batch — returns one delivery
    mockNext([{
      id: 100, subscription_id: 1, tenant_id: TENANT, event_outbox_id: null,
      event_type: 'patient.admitted', payload: { x: 1 }, attempt_number: 1,
      request_id: 'req-1',
    }]);
    // 2. Subscription fetch
    mockNext([{
      id: 1, integration_id: 10, tenant_id: TENANT,
      endpoint_url: 'https://8.8.8.8/hook',
      signing_credential_id: 5, signing_algorithm: 'hmac-sha256',
      credential_id: 5, ciphertext: 'whsec_abc',
    }]);
    // 3. markStatus — UPDATE webhook_deliveries (success)
    mockNext([]);
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => 'ok',
    }));

    const result = await dispatchPendingDeliveries({ batchSize: 5, fetchImpl: fetchMock });
    expect(result).toEqual({ dispatched: 1, succeeded: 1, failed: 0, dead: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://8.8.8.8/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['X-VHHealth-Signature']).toBe('t=1,sig=abc,algo=hmac-sha256');
    expect(init.headers['X-VHHealth-Event-Type']).toBe('patient.admitted');
    expect(recordSuccessMock).toHaveBeenCalledWith({ tenantId: TENANT, id: 1 });
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('halts on schema-missing without throwing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_deliveries" does not exist'));
    const result = await dispatchPendingDeliveries({});
    expect(result.halted).toBe(true);
    expect(result.reason).toBe('webhook_deliveries_unavailable');
  });
});

describe('dispatchPendingDeliveries — failure paths', () => {
  function setupSingleDelivery(attemptNumber = 1, signingAlgorithm = 'hmac-sha256') {
    mockNext([{
      id: 100, subscription_id: 1, tenant_id: TENANT, event_outbox_id: null,
      event_type: 'patient.admitted', payload: { x: 1 }, attempt_number: attemptNumber,
      request_id: 'req-1',
    }]);
    mockNext([{
      id: 1, integration_id: 10, tenant_id: TENANT,
      endpoint_url: 'https://8.8.8.8/hook',
      signing_credential_id: 5, signing_algorithm: signingAlgorithm,
      credential_id: 5, ciphertext: 'whsec_abc',
    }]);
    // markStatus update
    mockNext([]);
  }

  it('5xx → status=failed (retryable), schedules next_retry_at, increments subscription failure counter', async () => {
    setupSingleDelivery(1);
    const fetchMock = jest.fn(async () => ({ status: 503, text: async () => 'busy' }));
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(result).toEqual({ dispatched: 1, succeeded: 0, failed: 1, dead: 0 });
    expect(recordFailureMock).toHaveBeenCalledWith({ tenantId: TENANT, id: 1 });
    const updateCall = queryUnsafeMock.mock.calls.find((args) =>
      String(args[0]).includes('UPDATE webhook_deliveries') && args[1] === 'failed',
    );
    expect(updateCall).toBeTruthy();
  });

  it('4xx (404) → status=dead immediately, no retry', async () => {
    setupSingleDelivery(1);
    const fetchMock = jest.fn(async () => ({ status: 404, text: async () => 'not found' }));
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(result.dead).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('429 is retryable', async () => {
    setupSingleDelivery(1);
    const fetchMock = jest.fn(async () => ({ status: 429, text: async () => 'slow down' }));
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(result.failed).toBe(1);
    expect(result.dead).toBe(0);
  });

  it('attempt_number >= RETRY_LIMIT → marks dead even on 5xx', async () => {
    setupSingleDelivery(__testing__.RETRY_LIMIT);
    const fetchMock = jest.fn(async () => ({ status: 502, text: async () => 'bad gateway' }));
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(result.dead).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('network failure (no httpStatus) is retryable until limit', async () => {
    setupSingleDelivery(1);
    const fetchMock = jest.fn(async () => { throw new Error('fetch failed'); });
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(result.failed).toBe(1);
  });

  it('skips signing when algorithm=none', async () => {
    setupSingleDelivery(1, 'none');
    const fetchMock = jest.fn(async () => ({ status: 200, text: async () => 'ok' }));
    await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(signMock).not.toHaveBeenCalled();
  });

  it('does not fetch loopback endpoints even when a poisoned row is claimed', async () => {
    mockNext([{
      id: 100, subscription_id: 1, tenant_id: TENANT, event_outbox_id: null,
      event_type: 'patient.admitted', payload: { x: 1 }, attempt_number: 1,
      request_id: 'req-1',
    }]);
    mockNext([{
      id: 1, integration_id: 10, tenant_id: TENANT,
      endpoint_url: 'http://127.0.0.1/hook',
      signing_credential_id: 5, signing_algorithm: 'hmac-sha256',
      credential_id: 5, ciphertext: 'whsec_abc',
    }]);
    mockNext([]);
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const updateCall = queryUnsafeMock.mock.calls.find((args) =>
      String(args[0]).includes('UPDATE webhook_deliveries') && args[1] === 'failed',
    );
    expect(updateCall?.[4]).toMatch(/private|loopback|link-local|SSRF/i);
  });

  it('does not fetch when the signing credential is missing or cross-tenant', async () => {
    mockNext([{
      id: 100, subscription_id: 1, tenant_id: TENANT, event_outbox_id: null,
      event_type: 'patient.admitted', payload: { x: 1 }, attempt_number: 1,
      request_id: 'req-1',
    }]);
    mockNext([{
      id: 1, integration_id: 10, tenant_id: TENANT,
      endpoint_url: 'https://8.8.8.8/hook',
      signing_credential_id: 5, signing_algorithm: 'hmac-sha256',
      credential_id: null, ciphertext: null,
    }]);
    mockNext([]);
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signMock).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it('marks dead when subscription is missing', async () => {
    mockNext([{
      id: 100, subscription_id: 999, tenant_id: TENANT, event_outbox_id: null,
      event_type: 'patient.admitted', payload: {}, attempt_number: 1, request_id: 'req',
    }]);
    mockNext([]); // subscription fetch returns nothing
    mockNext([]); // markStatus
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock });
    expect(result.dead).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Backoff math
// ---------------------------------------------------------------------------
describe('backoff', () => {
  it('exposes the canonical schedule', () => {
    expect(__testing__.BACKOFF_SECONDS).toEqual([30, 120, 600, 1_800, 3_600, 14_400, 28_800]);
  });
  it('clamps negative + over-limit attempt numbers', () => {
    expect(__testing__.backoffSecondsForAttempt(-1)).toBe(30);
    expect(__testing__.backoffSecondsForAttempt(99)).toBe(28_800);
  });
  it('isRetryable matches the retry contract', () => {
    expect(__testing__.isRetryable(null)).toBe(true);
    expect(__testing__.isRetryable(200)).toBe(false);
    expect(__testing__.isRetryable(404)).toBe(false);
    expect(__testing__.isRetryable(408)).toBe(true);
    expect(__testing__.isRetryable(429)).toBe(true);
    expect(__testing__.isRetryable(500)).toBe(true);
    expect(__testing__.isRetryable(599)).toBe(true);
  });
  it('computeNextRetryAt returns a Date in the future', () => {
    const before = Date.now();
    const next = __testing__.computeNextRetryAt(0);
    expect(next).toBeInstanceOf(Date);
    expect(next.getTime()).toBeGreaterThanOrEqual(before + 30_000);
  });
});

// ---------------------------------------------------------------------------
// listDeliveries / getDelivery / mark-dead / redrive
// ---------------------------------------------------------------------------
describe('listDeliveries', () => {
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_deliveries" does not exist'));
    expect(await listDeliveries({ tenantId: TENANT })).toEqual({ deliveries: [], count: 0 });
  });
  it('rejects unknown status', async () => {
    await expect(listDeliveries({ tenantId: TENANT, status: 'weird' })).rejects.toThrow(/status must be one of/);
  });
});

describe('getDelivery', () => {
  it('throws 404 when missing', async () => {
    mockNext([]);
    await expect(getDelivery({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('markDeliveryDead', () => {
  it('throws 404 when not pending or failed', async () => {
    mockNext([]);
    await expect(markDeliveryDead({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('flips status + records reason', async () => {
    mockNext([{ id: 100, status: 'dead', error_message: 'manual' }]);
    const row = await markDeliveryDead({ tenantId: TENANT, id: 100, reason: 'manual' });
    expect(row.status).toBe('dead');
  });
});

describe('redriveDelivery', () => {
  it('throws 404 when not in eligible status', async () => {
    mockNext([]);
    await expect(redriveDelivery({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
  it('flips status to pending and writes a log', async () => {
    mockNext([{ id: 100, status: 'pending', subscription_id: 1, event_type: 'p.a' }]);
    const row = await redriveDelivery({ tenantId: TENANT, id: 100, redrivenBy: 'admin' });
    expect(row.status).toBe('pending');
    expect(writeLogMock).toHaveBeenCalled();
  });
});
