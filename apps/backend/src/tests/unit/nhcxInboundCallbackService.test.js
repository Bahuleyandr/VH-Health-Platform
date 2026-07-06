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
  mapClaimResponseToClaimDecision,
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

function finalClaimResponseBundle(overrides = {}) {
  return claimResponseBundle({
    use: 'claim',
    request: { reference: 'Claim/claim-88' },
    ...overrides,
  });
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

function claimArgs(bundle = finalClaimResponseBundle()) {
  return {
    tenantId: TENANT,
    endpoint: 'claim/on_submit',
    body: { payload: 'compact-jwe' },
    headers: {
      'x-hcx-recipient_code': 'VH-NHCX-PROVIDER',
      'x-hcx-sender_code': 'PAYER-NHCX-SAMPLE',
      'x-hcx-api_call_id': 'claim-response-1',
      'x-hcx-correlation_id': 'claim-corr-1',
      'x-hcx-workflow_id': '7001',
    },
    participantCodeSelf: 'VH-NHCX-PROVIDER',
    signatureVerified: true,
    runtimeResolver: jest.fn(async () => ({ environment: 'sandbox' })),
    decryptPayload: jest.fn(async () => ({ bundle, protectedHeaders: {} })),
    getClaimImpl: jest.fn(async () => ({ id: 88, status: 'submitted', claimed_amount: 50000 })),
    recordClaimDecisionImpl: jest.fn(async () => ({ id: 88, status: 'partially_approved' })),
  };
}

function taskStatusBundle() {
  return {
    resourceType: 'Bundle',
    id: 'nhcx-claim-status-task-bundle',
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/TaskBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Task',
        id: 'claim-status-88',
        status: 'completed',
        intent: 'order',
        code: { text: 'NHCX claim status check' },
        for: { reference: 'Patient/11111111-1111-4111-8111-111111111111' },
        authoredOn: new Date(0).toISOString(),
      },
    }],
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

describe('mapClaimResponseToClaimDecision', () => {
  it('maps a lower adjudicated amount to partial approval with disallowed balance', () => {
    const mapped = mapClaimResponseToClaimDecision(finalClaimResponseBundle({
      outcome: 'complete',
      total: [{ amount: { value: 42000, currency: 'INR' } }],
    }).entry[0].resource, {
      participantCodeCounterparty: 'PAYER-NHCX-SAMPLE',
      claim: { claimed_amount: 50000 },
    });

    expect(mapped).toMatchObject({
      decision: 'partially_approved',
      approved_amount: 42000,
      disallowed_amount: 8000,
      raw_response: { insurer: 'PAYER-NHCX-SAMPLE' },
    });
  });

  it('maps payer information requests to queried instead of guessing an adjudication', () => {
    const mapped = mapClaimResponseToClaimDecision(finalClaimResponseBundle({
      outcome: 'queued',
      disposition: 'Additional information requested',
      total: [],
      processNote: [{ text: 'Please upload itemized bill' }],
    }).entry[0].resource, {
      claim: { claimed_amount: 50000 },
    });

    expect(mapped).toMatchObject({
      decision: 'queried',
      query_text: 'Please upload itemized bill',
    });
  });
});

describe('processNHCXCallback', () => {
  it('records an inbound preauth ClaimResponse once and applies the domain mutation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      claim_id: null,
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
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: null, preauth_id: 77 }]);
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

  it('records final ClaimResponse decisions through recordClaimDecision with ledger shifts disabled', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      claim_id: 88,
      preauth_id: 77,
      policy_id: 55,
      patient_uid: '11111111-1111-4111-8111-111111111111',
      admission_id: 7001,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '30', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '30', status: 'processed' }]);

    const args = claimArgs(finalClaimResponseBundle({
      outcome: 'complete',
      total: [{ amount: { value: 42000, currency: 'INR' } }],
    }));
    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({ duplicate: false, processed: true });
    expect(args.recordClaimDecisionImpl).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      id: 88,
      decision: 'partially_approved',
      approved_amount: 42000,
      disallowed_amount: 8000,
      correspondence_channel: 'nhcx',
      skip_ledger_shift: true,
    }));
  });

  it('treats duplicate final ClaimResponse envelopes as no-op callbacks', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: 88 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '31', inserted: false, status: 'processed' }]);

    const args = claimArgs();
    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({ duplicate: true, processed: false });
    expect(args.recordClaimDecisionImpl).not.toHaveBeenCalled();
  });

  it('records invalid claim transitions on the envelope for manual review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: 88 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '32', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '32', status: 'manual_review' }]);

    const args = claimArgs();
    args.recordClaimDecisionImpl.mockRejectedValue(Object.assign(new Error('Invalid transition paid -> denied'), {
      statusCode: 409,
      code: 'INVALID_TRANSITION',
    }));

    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
  });

  it('does not let a tenant A callback mutate a tenant B claim', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '33', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '33', status: 'manual_review' }]);

    const args = claimArgs();
    args.getClaimImpl.mockRejectedValue(Object.assign(new Error('Claim not found'), {
      statusCode: 404,
      code: 'CLAIM_NOT_FOUND',
    }));

    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(args.recordClaimDecisionImpl).not.toHaveBeenCalled();
    expect(result.envelope.status).toBe('manual_review');
  });

  it('persists claim status Task responses without mutating workflow state', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: 88, policy_id: 55 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '34', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '34', status: 'processed' }]);

    const args = {
      ...claimArgs(taskStatusBundle()),
      endpoint: 'claim/on_status',
    };
    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({
      duplicate: false,
      processed: true,
      domainResult: { statusOnly: true, workflowMutation: false },
    });
    expect(args.getClaimImpl).not.toHaveBeenCalled();
    expect(args.recordClaimDecisionImpl).not.toHaveBeenCalled();
  });
});
