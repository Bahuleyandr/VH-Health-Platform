import { jest } from '@jest/globals';

process.env.NHCX_ENABLED = 'true';

const queryUnsafeMock = jest.fn();
const runtimeMock = jest.fn();
const buildEligibilityMock = jest.fn();
const buildPreauthMock = jest.fn();
const persistEnvelopeMock = jest.fn();

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxTenantConfigService.js', () => ({
  loadNHCXRuntimeConfig: runtimeMock,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxFhirProfileService.js', () => ({
  buildCoverageEligibilityRequestBundle: buildEligibilityMock,
  buildPreauthClaimRequestBundle: buildPreauthMock,
  persistOutboundNHCXEnvelope: persistEnvelopeMock,
}));

const {
  dispatchPendingNHCXMessages,
  redriveNHCXMessage,
  __testing__,
} = await import('../../services/nhcx/nhcxOutboundDispatcherService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function runtime() {
  return {
    enabled: true,
    effectiveEnabled: true,
    environment: 'sandbox',
    participantCode: 'VH-NHCX-PROVIDER',
    counterpartyParticipantCode: 'PAYER-NHCX-SAMPLE',
    gatewayBaseUrl: 'https://nhcx.example.test/v0.9',
    credentials: {
      apiToken: 'test-api-token',
      jwePrivateKey: 'test-jwe-secret-32-byte-minimum',
      callbackSecret: 'test-callback-secret',
    },
    missing: [],
  };
}

function preauthRow(overrides = {}) {
  return {
    id: '10',
    tenant_id: TENANT,
    environment: 'sandbox',
    direction: 'outbound',
    cycle: 'preauth',
    endpoint: 'preauth/submit',
    participant_code_self: 'VH-NHCX-PROVIDER',
    participant_code_counterparty: 'PAYER-NHCX-SAMPLE',
    hcx_api_call_id: 'api-call-1',
    hcx_correlation_id: 'corr-1',
    hcx_workflow_id: '7001',
    preauth_id: 77,
    policy_id: 55,
    patient_uid: '11111111-1111-4111-8111-111111111111',
    admission_id: 7001,
    attempt_count: 1,
    ...overrides,
  };
}

function builtPreauth() {
  return {
    bundle: {
      resourceType: 'Bundle',
      id: 'bundle-1',
      type: 'collection',
      meta: { profile: ['https://example.test/ClaimBundle'] },
      entry: [],
    },
    payloadHash: 'hash-preauth-current',
    profileUrl: 'https://example.test/ClaimBundle',
    profileVersion: '7.0.0-design-target',
    domainResourceType: 'Claim',
    patientUid: '11111111-1111-4111-8111-111111111111',
    admissionId: 7001,
    policyId: 55,
    preauthId: 77,
    workflowId: '7001',
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  runtimeMock.mockReset();
  buildEligibilityMock.mockReset();
  buildPreauthMock.mockReset();
  persistEnvelopeMock.mockReset();
  runtimeMock.mockResolvedValue(runtime());
  buildPreauthMock.mockResolvedValue(builtPreauth());
});

describe('nhcxOutboundDispatcherService JWE helpers', () => {
  it('creates compact JWE with HCX protected headers', async () => {
    const protectedHeaders = __testing__.hcxHeaders({
      hcxApiCallId: 'api-call-1',
      hcxCorrelationId: 'corr-1',
      hcxWorkflowId: '7001',
      participantCodeSelf: 'VH-NHCX-PROVIDER',
      participantCodeCounterparty: 'PAYER-NHCX-SAMPLE',
    });

    const encrypted = await __testing__.encryptBundleAsJWE({
      bundle: { resourceType: 'Bundle', type: 'collection', entry: [] },
      protectedHeaders,
      runtime: runtime(),
    });

    expect(encrypted.ciphertext.split('.')).toHaveLength(5);
    const header = JSON.parse(Buffer.from(encrypted.ciphertext.split('.')[0], 'base64url').toString('utf8'));
    expect(header).toMatchObject({
      alg: 'dir',
      enc: 'A256GCM',
      typ: 'JWE',
      cty: 'application/fhir+json',
      'x-hcx-api_call_id': 'api-call-1',
      'x-hcx-correlation_id': 'corr-1',
      sender_code: 'VH-NHCX-PROVIDER',
      recipient_code: 'PAYER-NHCX-SAMPLE',
    });
  });

  it('builds gateway endpoint URLs below the configured version base', () => {
    expect(__testing__.endpointUrl('https://nhcx.example.test/v0.9', 'preauth/submit'))
      .toBe('https://nhcx.example.test/v0.9/preauth/submit');
  });

  it('uses the seven-attempt retry ladder', () => {
    expect(__testing__.backoffSecondsForAttempt(0)).toBe(30);
    expect(__testing__.backoffSecondsForAttempt(99)).toBe(28_800);
    expect(__testing__.isRetryable(503)).toBe(true);
    expect(__testing__.isRetryable(400)).toBe(false);
  });
});

describe('dispatchPendingNHCXMessages', () => {
  it('encrypts the current preauth snapshot and marks gateway acceptance', async () => {
    const row = preauthRow();
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-preauth-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 77, status: 'submitted', submission_channel: 'nhcx' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, status: 'accepted' }]);

    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.payload.split('.')).toHaveLength(5);
      expect(options.headers.Authorization).toBe('Bearer test-api-token');
      expect(options.headers['x-hcx-api_call_id']).toBe('api-call-1');
      return new Response(JSON.stringify({ status: 'accepted', reference_id: 'GW-123' }), {
        status: 202,
        headers: { 'x-hcx-status': 'accepted' },
      });
    });

    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 1, failed: 0, dead: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://nhcx.example.test/v0.9/preauth/submit',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(buildPreauthMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      preauthId: 77,
      participantCodeSelf: 'VH-NHCX-PROVIDER',
      participantCodeCounterparty: 'PAYER-NHCX-SAMPLE',
    }));
  });

  it('backs off retryable gateway failures', async () => {
    const row = preauthRow();
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-preauth-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, status: 'failed' }]);

    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => new Response('gateway overloaded', { status: 503 })),
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 0, failed: 1, dead: 0 });
    const markFailedCall = queryUnsafeMock.mock.calls[2];
    expect(markFailedCall[2]).toBe('failed');
    expect(markFailedCall[3]).toBe('HTTP_503');
    expect(markFailedCall[5]).toBeInstanceOf(Date);
  });
});

describe('redriveNHCXMessage', () => {
  it('regenerates the current bundle hash and clears stale ciphertext', async () => {
    const row = preauthRow({ status: 'dead', attempt_count: 7 });
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, status: 'pending', payload_hash: 'hash-preauth-current' }]);

    const result = await redriveNHCXMessage({
      tenantId: TENANT,
      id: 10,
      allowDisabled: true,
    });

    expect(result.status).toBe('pending');
    expect(buildPreauthMock).toHaveBeenCalledTimes(1);
    const redriveSql = queryUnsafeMock.mock.calls[1][0];
    expect(redriveSql).toContain('payload_ciphertext = NULL');
    expect(redriveSql).toContain('attempt_count = 0');
    expect(queryUnsafeMock.mock.calls[1][3]).toBe('hash-preauth-current');
  });
});
