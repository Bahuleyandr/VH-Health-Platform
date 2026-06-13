/**
 * Phase A3 PR1 — webhookSubscriptionService unit tests + signing helper
 * round-trip.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  createSubscription,
  deleteSubscription,
  encryptWebhookSigningSecret,
  getSubscription,
  listSubscriptions,
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  signWebhookPayload,
  updateSubscription,
  verifyWebhookSignature,
  __testing__,
} = await import('../../services/integrations/webhookSubscriptionService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  delete process.env.WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS;
  delete process.env.WEBHOOK_DELIVERY_HOST_ALLOWLIST;
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

// ---------------------------------------------------------------------------
// signWebhookPayload + verifyWebhookSignature round-trip
// ---------------------------------------------------------------------------
describe('signWebhookPayload / verifyWebhookSignature', () => {
  const payload = { event_type: 'patient.admitted', patient_uid: 'X' };
  const secret = 'whsec_secret_value';

  it('rejects empty secret on hmac signing', () => {
    expect(() => signWebhookPayload({ payload, secret: '' })).toThrow(/secret/);
  });
  it('rejects unknown algorithm', () => {
    expect(() => signWebhookPayload({ payload, secret, algorithm: 'sha256' })).toThrow(/signing_algorithm/);
  });
  it('returns empty signature when algorithm=none', () => {
    const signed = signWebhookPayload({ payload, secret, algorithm: 'none' });
    expect(signed).toEqual({ signature: '', header_value: '', algorithm: 'none', timestamp: null });
  });
  it('produces a header_value with t= and sig= and round-trips through verify', () => {
    const signed = signWebhookPayload({ payload, secret });
    expect(signed.header_value).toMatch(/^t=\d+,sig=[0-9a-f]+,algo=hmac-sha256$/);
    expect(verifyWebhookSignature({
      payload, headerValue: signed.header_value, secret,
    })).toBe(true);
  });
  it('rejects a tampered signature', () => {
    const signed = signWebhookPayload({ payload, secret });
    const tampered = signed.header_value.replace(/sig=([0-9a-f]+)/, 'sig=' + 'ff'.repeat(32));
    expect(verifyWebhookSignature({
      payload, headerValue: tampered, secret,
    })).toBe(false);
  });
  it('rejects a stale timestamp outside the tolerance window', () => {
    const signed = signWebhookPayload({ payload, secret, timestamp: 0 }); // 1970
    expect(verifyWebhookSignature({
      payload, headerValue: signed.header_value, secret,
    })).toBe(false);
  });
  it('rejects mismatched secret', () => {
    const signed = signWebhookPayload({ payload, secret });
    expect(verifyWebhookSignature({
      payload, headerValue: signed.header_value, secret: 'wrong',
    })).toBe(false);
  });
  it('verifies hmac-sha512 round-trip', () => {
    const signed = signWebhookPayload({ payload, secret, algorithm: 'hmac-sha512' });
    expect(signed.algorithm).toBe('hmac-sha512');
    expect(verifyWebhookSignature({
      payload, headerValue: signed.header_value, secret,
    })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
describe('createSubscription', () => {
  it('rejects bad URL', async () => {
    await expect(createSubscription({
      tenantId: TENANT, integrationId: 1, eventType: 'patient.admitted', endpointUrl: 'not-a-url',
    })).rejects.toThrow(/valid http/);
  });
  it('rejects ftp:// scheme', async () => {
    await expect(createSubscription({
      tenantId: TENANT, integrationId: 1, eventType: 'patient.admitted', endpointUrl: 'ftp://example.com/hook',
    })).rejects.toThrow(/valid http/);
  });
  it('requires signing_credential_id when algorithm != none', async () => {
    await expect(createSubscription({
      tenantId: TENANT, integrationId: 1,
      eventType: 'patient.admitted', endpointUrl: 'https://8.8.8.8/hook',
      signingAlgorithm: 'hmac-sha256',
    })).rejects.toThrow(/signing_credential_id/);
  });
  it('rejects loopback endpoint SSRF', async () => {
    await expect(createSubscription({
      tenantId: TENANT, integrationId: 1,
      eventType: 'patient.admitted', endpointUrl: 'http://127.0.0.1/hook',
      signingAlgorithm: 'none',
    })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it('rejects signing credentials not owned by this tenant integration', async () => {
    mockNext([{ id: 1 }]); // integration ownership
    mockNext([]); // credential ownership miss
    await expect(createSubscription({
      tenantId: TENANT, integrationId: 1,
      eventType: 'patient.admitted', endpointUrl: 'https://8.8.8.8/hook',
      signingCredentialId: 7,
    })).rejects.toMatchObject({ statusCode: 403, code: 'WEBHOOK_SIGNING_CREDENTIAL_FORBIDDEN' });
  });
  it('inserts when given a valid URL + signing setup', async () => {
    mockNext([{ id: 1 }]); // integration ownership
    mockNext([{ id: 7 }]); // signing credential ownership
    mockNext([{ id: 1, integration_id: 1, event_type: 'patient.admitted', signing_algorithm: 'hmac-sha256', is_active: true }]);
    const row = await createSubscription({
      tenantId: TENANT, integrationId: 1,
      eventType: 'patient.admitted', endpointUrl: 'https://8.8.8.8/hook',
      signingCredentialId: 7,
    });
    expect(row.id).toBe(1);
  });
  it('maps unique-violation to 409', async () => {
    mockNext([{ id: 1 }]); // integration ownership
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(createSubscription({
      tenantId: TENANT, integrationId: 1, eventType: 'patient.admitted',
      endpointUrl: 'https://8.8.8.8/hook', signingAlgorithm: 'none',
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('listSubscriptions', () => {
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "webhook_subscriptions" does not exist'));
    expect(await listSubscriptions({ tenantId: TENANT })).toEqual({ subscriptions: [], count: 0 });
  });
});

describe('getSubscription', () => {
  it('throws 404 when missing', async () => {
    mockNext([]);
    await expect(getSubscription({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('updateSubscription', () => {
  it('rejects bad URL', async () => {
    await expect(updateSubscription({
      tenantId: TENANT, id: 1, endpointUrl: 'javascript:alert(1)',
    })).rejects.toThrow(/valid http/);
  });
  it('builds an UPDATE with only the supplied columns', async () => {
    mockNext([{ id: 1, is_active: false }]);
    await updateSubscription({ tenantId: TENANT, id: 1, isActive: false });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE webhook_subscriptions[\s\S]*is_active = \$1/);
    expect(sql).not.toMatch(/endpoint_url = /);
  });
  it('returns the existing row when no fields given', async () => {
    mockNext([{ id: 1 }]);
    await updateSubscription({ tenantId: TENANT, id: 1 });
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SELECT/);
  });
  it('rejects update to loopback endpoint SSRF', async () => {
    await expect(updateSubscription({
      tenantId: TENANT, id: 1, endpointUrl: 'http://127.0.0.1/hook',
    })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
  it('rejects cross-tenant signing credential updates', async () => {
    mockNext([{ id: 1, integration_id: 1, signing_credential_id: null, signing_algorithm: 'none' }]);
    mockNext([]);
    await expect(updateSubscription({
      tenantId: TENANT, id: 1, signingCredentialId: 7,
    })).rejects.toMatchObject({ statusCode: 403, code: 'WEBHOOK_SIGNING_CREDENTIAL_FORBIDDEN' });
  });
  it('requires credential when switching to hmac signing', async () => {
    mockNext([{ id: 1, integration_id: 1, signing_credential_id: null, signing_algorithm: 'none' }]);
    await expect(updateSubscription({
      tenantId: TENANT, id: 1, signingAlgorithm: 'hmac-sha256',
    })).rejects.toThrow(/signing_credential_id/);
  });
});

describe('encryptWebhookSigningSecret', () => {
  it('encrypts the secret and stores only a deterministic hash companion', () => {
    const result = encryptWebhookSigningSecret('whsec_test');
    // Field-encryption envelope format (enc:v2: now; enc:v1: legacy still decrypts).
    expect(result.ciphertext).toMatch(/^enc:v\d+:/);
    expect(result.ciphertext).not.toBe('whsec_test');
    expect(result.ciphertext_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deleteSubscription', () => {
  it('throws 404 when missing', async () => {
    mockNext([]);
    await expect(deleteSubscription({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('recordSubscriptionFailure / recordSubscriptionSuccess', () => {
  it('failure increments counter and auto-pauses when cap exceeded', async () => {
    mockNext([{ id: 1, consecutive_failures: 10, max_consecutive_failures: 10, is_active: false }]);
    const row = await recordSubscriptionFailure({ tenantId: TENANT, id: 1 });
    expect(row.is_active).toBe(false);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/consecutive_failures = consecutive_failures \+ 1/);
  });
  it('success resets counter + stamps last_delivered_at', async () => {
    mockNext([{ id: 1, consecutive_failures: 0 }]);
    const row = await recordSubscriptionSuccess({ tenantId: TENANT, id: 1 });
    expect(row.consecutive_failures).toBe(0);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET consecutive_failures = 0/);
  });
  it('returns null gracefully on bogus id', async () => {
    expect(await recordSubscriptionFailure({ tenantId: TENANT, id: 'abc' })).toBeNull();
    expect(await recordSubscriptionSuccess({ tenantId: TENANT, id: 'abc' })).toBeNull();
  });
});

describe('isValidUrl', () => {
  it('accepts http and https only', () => {
    expect(__testing__.isValidUrl('https://x.example')).toBe(true);
    expect(__testing__.isValidUrl('http://x.example')).toBe(true);
    expect(__testing__.isValidUrl('ftp://x.example')).toBe(false);
    expect(__testing__.isValidUrl('javascript:alert(1)')).toBe(false);
    expect(__testing__.isValidUrl('not-a-url')).toBe(false);
  });
});
