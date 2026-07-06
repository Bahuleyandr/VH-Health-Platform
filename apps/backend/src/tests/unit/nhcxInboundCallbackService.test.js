import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const loadNHCXRuntimeConfigMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: queryUnsafeMock },
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock }),
}));

jest.unstable_mockModule('../../services/nhcx/nhcxTenantConfigService.js', () => ({
  loadNHCXRuntimeConfig: loadNHCXRuntimeConfigMock,
}));

const {
  mapClaimResponseToPreauthResponse,
  processNHCXCallback,
} = await import('../../services/nhcx/nhcxInboundCallbackService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function claimResponseBundle(overrides = {}) {
  return {
    resourceType: 'Bundle',
    id: 'nhcx-claim-response-bundle',
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimResponseBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'ClaimResponse',
          id: 'claim-response-1',
          status: 'active',
          outcome: 'complete',
          disposition: 'Approved by payer',
          request: { reference: 'Claim/preauth-77' },
          total: [{ amount: { value: 50000, currency: 'INR' } }],
          ...overrides,
        },
      },
    ],
  };
}

function baseArgs(bundle = claimResponseBundle()) {
  return {
    tenantId: TENANT,
    endpoint: 'preauth/on_submit',
    body: { payload: 'compact-jwe' },
    headers: {
      'x-hcx-recipient_code': 'VH-NHCX-PROVIDER',
      'x-hcx-sender_code': 'PAYER-NHCX-SAMPLE',
      'x-hcx-api_call_id': 'api-response-1',
      'x-hcx-correlation_id': 'corr-1',
      'x-hcx-workflow_id': '7001',
    },
    participantCodeSelf: 'VH-NHCX-PROVIDER',
    signatureVerified: true,
    runtimeResolver: jest.fn(async () => ({ environment: 'sandbox' })),
    decryptPayload: jest.fn(async () => ({ bundle, protectedHeaders: {} })),
    recordPreauthResponseImpl: jest.fn(async () => ({ preauth: { id: 77, status: 'approved' } })),
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  loadNHCXRuntimeConfigMock.mockReset();
});

describe('mapClaimResponseToPreauthResponse', () => {
  it('maps approved ClaimResponse payloads into claimsService preauth responses', () => {
    const mapped = mapClaimResponseToPreauthResponse(claimResponseBundle().entry[0].resource, {
      participantCodeCounterparty: 'PAYER-NHCX-SAMPLE',
    });

    expect(mapped).toMatchObject({
      response_type: 'approved',
      sanctioned_amount: 50000,
      raw_response: {
        insurer: 'PAYER-NHCX-SAMPLE',
      },
    });
  });
});

describe('processNHCXCallback', () => {
  it('records an inbound preauth ClaimResponse once and applies the domain mutation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      preauth_id: 77,
      policy_id: 55,
      patient_uid: '11111111-1111-4111-8111-111111111111',
      admission_id: 7001,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '20', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '20', status: 'processed' }]);

    const args = baseArgs();
    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({ duplicate: false, processed: true });
    expect(args.recordPreauthResponseImpl).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      preauth_id: 77,
      response_type: 'approved',
      sanctioned_amount: 50000,
      decided_by_tpa_user: 'PAYER-NHCX-SAMPLE',
    }));
  });

  it('treats duplicate inbound envelopes as no-op accepted callbacks', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ preauth_id: 77 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '20', inserted: false, status: 'processed' }]);

    const result = await processNHCXCallback(baseArgs());

    expect(result).toMatchObject({ duplicate: true, processed: false });
  });

  it('routes profile warnings to manual review without mutating preauth state', async () => {
    const invalid = claimResponseBundle();
    invalid.entry = [];
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '21', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '21', status: 'manual_review' }]);

    const args = baseArgs(invalid);
    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(args.recordPreauthResponseImpl).not.toHaveBeenCalled();
  });
});
