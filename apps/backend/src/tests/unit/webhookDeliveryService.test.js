import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';

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

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  circuitBreakerStatus: () => ({ open: false }),
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
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
  deriveWebhookHighWaterMark,
  dispatchPendingDeliveries,
  enqueueDelivery,
  getDelivery,
  listDeliveries,
  markDeliveryDead,
  redriveDelivery,
  reapStaleInFlightDeliveries,
  __testing__,
} = await import('../../services/integrations/webhookDeliveryService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-000000000002';
const LEASE_OWNER = '00000000-0000-4000-8000-000000000003';

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

function claimRow(overrides = {}) {
  return {
    id: 100,
    subscription_id: 1,
    tenant_id: TENANT,
    event_outbox_id: null,
    event_type: 'patient.admitted',
    payload: { x: 1 },
    attempt_number: 1,
    request_id: 'req-1',
    lease_owner: LEASE_OWNER,
    lease_expires_at: new Date(Date.now() + 60_000),
    prior_status: 'pending',
    ...overrides,
  };
}

function subscriptionRow(overrides = {}) {
  return {
    id: 1,
    integration_id: 10,
    endpoint_url: 'https://8.8.8.8/hook',
    signing_credential_id: null,
    signing_algorithm: 'none',
    is_active: true,
    event_filter: {},
    integration_status: 'active',
    credential_id: null,
    ciphertext: null,
    ...overrides,
  };
}

function terminalRow(status, attemptNumber = 1) {
  return {
    id: 100,
    subscription_id: 1,
    tenant_id: TENANT,
    status,
    attempt_number: attemptNumber,
  };
}

function setupDispatch({ claim = claimRow(), subscription = subscriptionRow() } = {}) {
  mockNext([]); // orphan sweep
  mockNext([claim]); // leased claim
  mockNext(subscription ? [subscription] : []); // fresh authorization/gate read
}

describe('enqueueDelivery', () => {
  it('rejects empty event_type and source-bridge impersonation', async () => {
    await expect(enqueueDelivery({ tenantId: TENANT })).rejects.toThrow(/event_type/);
    await expect(enqueueDelivery({ tenantId: TENANT, eventType: 'patient.admitted' }))
      .rejects.toThrow(/source_identity/);
    await expect(enqueueDelivery({
      tenantId: TENANT,
      eventType: 'patient.admitted',
      sourceIdentity: 'admin:test:1',
      eventOutboxId: '1',
    })).rejects.toMatchObject({ code: 'WEBHOOK_SOURCE_BRIDGE_INTERNAL_ONLY' });
  });

  it('returns no work when no active empty-filter subscription matches', async () => {
    mockNext([]);
    await expect(enqueueDelivery({ tenantId: TENANT, eventType: 'patient.admitted', sourceIdentity: 'admin:test:2' }))
      .resolves.toEqual({ matched: 0, enqueued: [] });
  });

  it('fails loudly when the required schema is unavailable', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_subscriptions" does not exist'));
    await expect(enqueueDelivery({ tenantId: TENANT, eventType: 'patient.admitted', sourceIdentity: 'admin:test:3' }))
      .rejects.toThrow(/does not exist/);
  });

  it('uses one set-based insert and verifies complete coverage', async () => {
    mockNext([{ id: 1 }, { id: 2 }]);
    mockNext([]);
    mockNext([
      { id: 100, subscription_id: 1, status: 'pending', attempt_number: 0, payload_sha256: __testing__.payloadSha256({ patient_uid: 'X' }) },
      { id: 101, subscription_id: 2, status: 'pending', attempt_number: 0, payload_sha256: __testing__.payloadSha256({ patient_uid: 'X' }) },
    ]);
    const result = await enqueueDelivery({
      tenantId: TENANT,
      eventType: 'patient.admitted',
      payload: { patient_uid: 'X' },
      sourceIdentity: 'admin:test:4',
    });
    expect(result).toMatchObject({ matched: 2 });
    expect(result.enqueued).toHaveLength(2);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO webhook_deliveries[\s\S]+SELECT/);
  });

  it('rolls back through the caller transaction when fan-out coverage is incomplete', async () => {
    mockNext([{ id: 1 }, { id: 2 }]);
    mockNext([]);
    mockNext([{ id: 100, subscription_id: 1, payload_sha256: __testing__.payloadSha256({}) }]);
    await expect(enqueueDelivery({ tenantId: TENANT, eventType: 'patient.admitted', sourceIdentity: 'admin:test:5' }))
      .rejects.toMatchObject({ code: 'WEBHOOK_ADHOC_SOURCE_IDENTITY_CONFLICT' });
  });
});

describe('dispatchPendingDeliveries', () => {
  it('does not claim or send source-held paper deliveries', async () => {
    mockNext([]); // orphan sweep
    mockNext([]); // no live-authorized claim
    const fetchMock = jest.fn();

    const result = await dispatchPendingDeliveries({
      fetchImpl: fetchMock,
      leaseOwner: LEASE_OWNER,
    });

    expect(queryUnsafeMock.mock.calls[1][0]).toContain("delivery.send_authority = 'live_authorized'");
    expect(result.dispatched).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fences a successful delivery and records subscription success only after CAS', async () => {
    setupDispatch();
    mockNext([terminalRow('succeeded')]);
    const fetchMock = jest.fn(async () => ({ status: 200, text: async () => 'ok' }));

    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock, leaseOwner: LEASE_OWNER });

    expect(result).toEqual({
      dispatched: 1,
      succeeded: 1,
      failed: 0,
      dead: 0,
      parked: 0,
      lost_fence: 0,
      orphaned: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['X-VHHealth-Delivery-Id']).toBe('100');
    expect(recordSuccessMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      id: 1,
      tx: prismaMock,
    }));
  });

  it('does not credit success when a stale worker loses its lease fence', async () => {
    setupDispatch();
    mockNext([]);
    const result = await dispatchPendingDeliveries({
      fetchImpl: jest.fn(async () => ({ status: 204, text: async () => '' })),
      leaseOwner: LEASE_OWNER,
    });
    expect(result.succeeded).toBe(0);
    expect(result.lost_fence).toBe(1);
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it.each([
    [503, 1, 'failed'],
    [429, 1, 'failed'],
    [404, 1, 'dead'],
    [502, __testing__.RETRY_LIMIT, 'dead'],
    [502, __testing__.RETRY_LIMIT + 1, 'dead'],
  ])('maps HTTP %s at attempt %s to %s', async (httpStatus, attemptNumber, expectedStatus) => {
    setupDispatch({ claim: claimRow({ attempt_number: attemptNumber }) });
    mockNext([terminalRow(expectedStatus, attemptNumber)]);
    const result = await dispatchPendingDeliveries({
      fetchImpl: jest.fn(async () => ({ status: httpStatus, text: async () => 'response' })),
      leaseOwner: LEASE_OWNER,
    });
    expect(result[expectedStatus === 'dead' ? 'dead' : 'failed']).toBe(1);
    expect(recordFailureMock).toHaveBeenCalledWith(expect.objectContaining({ tx: prismaMock }));
  });

  it('parks a claim without fetching when the subscription or parent integration is inactive', async () => {
    setupDispatch({ subscription: subscriptionRow({ integration_status: 'inactive' }) });
    mockNext([{ id: 100 }]);
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock, leaseOwner: LEASE_OWNER });
    expect(result.parked).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const update = queryUnsafeMock.mock.calls[3];
    expect(update[0]).toMatch(/SET status = \$6::text/);
    expect(update[6]).toBe('pending');
  });

  it('parks poisoned non-empty-filter rows without inventing filter semantics', async () => {
    setupDispatch({ subscription: subscriptionRow({ event_filter: { patient_uid: 'X' } }) });
    mockNext([{ id: 100 }]);
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock, leaseOwner: LEASE_OWNER });
    expect(result.parked).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dead-letters missing subscriptions without outbound fetch', async () => {
    setupDispatch({ subscription: null });
    mockNext([terminalRow('dead')]);
    const fetchMock = jest.fn();
    const result = await dispatchPendingDeliveries({ fetchImpl: fetchMock, leaseOwner: LEASE_OWNER });
    expect(result.dead).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('halts explicitly when delivery schema is unavailable', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_deliveries" does not exist'));
    await expect(dispatchPendingDeliveries({ leaseOwner: LEASE_OWNER })).resolves.toEqual({
      halted: true,
      reason: 'webhook_deliveries_unavailable',
    });
  });
});

describe('backoff and retry contract', () => {
  it('keeps the canonical bounded schedule', () => {
    expect(__testing__.BACKOFF_SECONDS).toEqual([30, 120, 600, 1_800, 3_600, 14_400, 28_800]);
    expect(__testing__.backoffSecondsForAttempt(-1)).toBe(30);
    expect(__testing__.backoffSecondsForAttempt(99)).toBe(28_800);
  });

  it('retries only transport, timeout, throttle, and server failures', () => {
    expect(__testing__.isRetryable(null)).toBe(true);
    expect(__testing__.isRetryable(404)).toBe(false);
    expect(__testing__.isRetryable(408)).toBe(true);
    expect(__testing__.isRetryable(429)).toBe(true);
    expect(__testing__.isRetryable(500)).toBe(true);
  });
});

describe('subscriber acknowledgement contract', () => {
  it('never treats an HTTP response as acknowledgement while the contract is unclassified', () => {
    expect(__testing__.acknowledgementForResponse({
      contract: 'unclassified',
      config: {},
      responseBody: 'accepted',
    })).toEqual({ state: 'unclassified', evidence: null });
  });

  it('advances only through ordered positive acknowledgement evidence', async () => {
    mockNext([
      { id: 1, source_position: '41', source_identity: 'event_outbox:41', payload_sha256: 'a'.repeat(64), acknowledgement_state: 'positive' },
      { id: 2, source_position: '42', source_identity: 'event_outbox:42', payload_sha256: 'b'.repeat(64), acknowledgement_state: 'pending' },
      { id: 3, source_position: '43', source_identity: 'event_outbox:43', payload_sha256: 'c'.repeat(64), acknowledgement_state: 'positive' },
    ]);
    await expect(deriveWebhookHighWaterMark({
      tenantId: TENANT,
      subscriptionId: 7,
      currentPosition: '40',
      cutoffPosition: '43',
    })).resolves.toEqual({
      partition: 'webhook-subscription:7:outbound',
      current_position: '40',
      cutoff_position: '43',
      high_water_position: '41',
      high_water_token: `event_outbox:41:${'a'.repeat(64)}`,
      complete_through_cutoff: false,
      blocked: {
        delivery_id: 2,
        source_position: '42',
        acknowledgement_state: 'pending',
      },
    });
  });

  it('requires exact owner-configured response evidence for a positive acknowledgement', () => {
    const expected = 'subscriber-accepted';
    const expectedSha = createHash('sha256').update(expected).digest('hex');
    expect(__testing__.acknowledgementForResponse({
      contract: 'response_header_sha256',
      config: { header_name: 'x-subscriber-ack', expected_sha256: expectedSha },
      responseHeaders: { get: () => expected },
      responseBody: '',
    })).toMatchObject({ state: 'positive' });
    expect(__testing__.acknowledgementForResponse({
      contract: 'response_header_sha256',
      config: { header_name: 'x-subscriber-ack', expected_sha256: expectedSha },
      responseHeaders: { get: () => 'different' },
      responseBody: '',
    })).toMatchObject({ state: 'negative' });
  });
});

describe('tenant-scoped reads and audited operator mutations', () => {
  it('validates list filters and tolerates a legacy missing read schema', async () => {
    await expect(listDeliveries({ tenantId: TENANT, status: 'weird' }))
      .rejects.toThrow(/status must be one of/);
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_deliveries" does not exist'));
    await expect(listDeliveries({ tenantId: TENANT })).resolves.toEqual({ deliveries: [], count: 0 });
  });

  it('does not disclose a missing delivery', async () => {
    mockNext([]);
    await expect(getDelivery({ tenantId: TENANT, id: 99 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('requires reason and server-derived actor context before mark-dead', async () => {
    await expect(markDeliveryDead({ tenantId: TENANT, id: 100 }))
      .rejects.toThrow(/reason is required/);
    await expect(markDeliveryDead({ tenantId: TENANT, id: 100, reason: 'Operator decision' }))
      .rejects.toThrow(/actor uid/);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('marks only pending/failed rows dead and writes the audit in the same transaction', async () => {
    mockNext([{
      id: 100, subscription_id: 1, status: 'failed', attempt_number: 2,
      error_message: 'retry exhausted soon', redrive_count: 0,
    }]);
    mockNext([{
      id: 100, subscription_id: 1, tenant_id: TENANT, event_outbox_id: '7',
      event_type: 'patient.admitted', status: 'dead', attempt_number: 2, redrive_count: 0,
    }]);
    mockNext([]);
    const row = await markDeliveryDead({
      tenantId: TENANT,
      id: 100,
      reason: 'Endpoint permanently retired',
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      requestId: 'request-1',
    });
    expect(row.status).toBe('dead');
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO audit_logs/);
    expect(queryUnsafeMock.mock.calls[2][4]).toBe('WEBHOOK_DELIVERY_MARKED_DEAD');
  });

  it('redrives dead only, resets retry state, and increments redrive_count with audit', async () => {
    mockNext([{
      id: 100, subscription_id: 1, status: 'dead', attempt_number: 7,
      error_message: 'terminal', redrive_count: 2,
    }]);
    mockNext([{
      id: 100, subscription_id: 1, tenant_id: TENANT, event_outbox_id: '7',
      event_type: 'patient.admitted', status: 'pending', attempt_number: 0, redrive_count: 3,
    }]);
    mockNext([]);
    const row = await redriveDelivery({
      tenantId: TENANT,
      id: 100,
      reason: 'Endpoint owner confirmed recovery',
      actorUid: ACTOR,
      actorRole: 'SUPER_ADMIN',
      requestId: 'request-2',
    });
    expect(row).toMatchObject({ status: 'pending', attempt_number: 0, redrive_count: 3 });
    expect(queryUnsafeMock.mock.calls[2][4]).toBe('WEBHOOK_DELIVERY_REDRIVEN');
  });

  it('rejects redrive from any state other than dead', async () => {
    mockNext([{
      id: 100, subscription_id: 1, status: 'failed', attempt_number: 2,
      error_message: 'retryable', redrive_count: 0,
    }]);
    await expect(redriveDelivery({
      tenantId: TENANT,
      id: 100,
      reason: 'Too early',
      actorUid: ACTOR,
      actorRole: 'ADMIN',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('reapStaleInFlightDeliveries', () => {
  it('uses the lease expiry fence and reports terminal rows separately', async () => {
    mockNext([
      { id: 10, tenant_id: TENANT, status: 'failed', attempt_number: 2 },
      { id: 11, tenant_id: TENANT, status: 'dead', attempt_number: 7 },
    ]);
    const result = await reapStaleInFlightDeliveries({ limit: 25 });
    expect(result).toMatchObject({ reaped: 2, dead: 1 });
    const [sql, limit, retryLimit] = queryUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/lease_expires_at <= NOW\(\)/);
    expect(sql).toMatch(/delivery\.lease_owner = stale\.lease_owner/);
    expect(limit).toBe(25);
    expect(retryLimit).toBe(__testing__.RETRY_LIMIT);
  });
});
