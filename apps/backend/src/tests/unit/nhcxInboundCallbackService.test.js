import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const loadNHCXRuntimeConfigMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock, $executeRawUnsafe: executeUnsafeMock },
  prismaReadOnly: { $queryRawUnsafe: queryUnsafeMock },
  setTenant: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock, $executeRawUnsafe: executeUnsafeMock }),
  setTenantTx: async (_tenantId, fn) => fn({ $queryRawUnsafe: queryUnsafeMock, $executeRawUnsafe: executeUnsafeMock }),
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
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

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

function communicationRequestBundle(overrides = {}) {
  return {
    resourceType: 'Bundle',
    id: 'nhcx-communication-request-bundle',
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/CommunicationRequestBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'CommunicationRequest',
        id: 'communication-request-1',
        status: 'active',
        subject: { reference: 'Patient/11111111-1111-4111-8111-111111111111' },
        reasonCode: [{ text: 'Need itemized bill and discharge summary' }],
        payload: [{ contentString: 'Please upload the itemized final bill.' }],
        ...overrides,
      },
    }],
  };
}

function paymentNoticeBundle(overrides = {}) {
  return {
    resourceType: 'Bundle',
    id: 'nhcx-payment-notice-bundle',
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/PaymentNoticeBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [
      {
        resource: {
          resourceType: 'PaymentNotice',
          id: 'payment-notice-1',
          status: 'active',
          created: '2026-07-06T12:00:00.000Z',
          request: { reference: 'Claim/claim-88' },
          response: { reference: 'ClaimResponse/claim-response-88' },
          payment: { identifier: { value: 'STAR-UTR-9001' } },
          amount: { value: 42000, currency: 'INR' },
          ...overrides,
        },
      },
      {
        resource: {
          resourceType: 'PaymentReconciliation',
          id: 'payment-reconciliation-1',
          status: 'active',
          created: '2026-07-06T12:00:00.000Z',
          paymentAmount: { value: 42000, currency: 'INR' },
          detail: [{
            request: { reference: 'Claim/claim-88' },
            response: { reference: 'ClaimResponse/claim-response-88' },
            amount: { value: 42000, currency: 'INR' },
          }],
        },
      },
    ],
  };
}

function paymentNoticeArgs(bundle = paymentNoticeBundle()) {
  return {
    tenantId: TENANT,
    endpoint: 'paymentnotice/request',
    body: { payload: 'compact-jwe' },
    headers: {
      'x-hcx-recipient_code': 'VH-NHCX-PROVIDER',
      'x-hcx-sender_code': 'PAYER-NHCX-SAMPLE',
      'x-hcx-api_call_id': 'payment-notice-1',
      'x-hcx-correlation_id': 'claim-corr-1',
      'x-hcx-workflow_id': '7001',
    },
    participantCodeSelf: 'VH-NHCX-PROVIDER',
    signatureVerified: true,
    runtimeResolver: jest.fn(async () => ({ environment: 'sandbox' })),
    decryptPayload: jest.fn(async () => ({ bundle, protectedHeaders: {} })),
  };
}

function communicationArgs(bundle = communicationRequestBundle()) {
  return {
    tenantId: TENANT,
    endpoint: 'communication/request',
    body: { payload: 'compact-jwe' },
    headers: {
      'x-hcx-recipient_code': 'VH-NHCX-PROVIDER',
      'x-hcx-sender_code': 'PAYER-NHCX-SAMPLE',
      'x-hcx-api_call_id': 'communication-request-1',
      'x-hcx-correlation_id': 'claim-corr-1',
      'x-hcx-workflow_id': '7001',
    },
    participantCodeSelf: 'VH-NHCX-PROVIDER',
    signatureVerified: true,
    runtimeResolver: jest.fn(async () => ({ environment: 'sandbox' })),
    decryptPayload: jest.fn(async () => ({ bundle, protectedHeaders: {} })),
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
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
    const insertCall = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO nhcx_messages'));
    expect(insertCall[0]).toContain('inbound_claim_token');
    expect(insertCall[24]).toBe('processing');
    expect(insertCall[25]).toEqual(expect.any(String));
    const terminalCall = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('inbound_completed_at'));
    expect(terminalCall[6]).toBe(insertCall[25]);
  });

  it('treats duplicate inbound envelopes as no-op accepted callbacks', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: null, preauth_id: 77 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '20', inserted: false, status: 'processed' }]);

    const result = await processNHCXCallback(baseArgs());

    expect(result).toMatchObject({ duplicate: true, processed: false });
  });

  it('surfaces a duplicate processing envelope for owner recovery without rerunning the domain', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: null, preauth_id: 77 }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: '20',
      inserted: false,
      status: 'processing',
      inbound_claim_token: '11111111-1111-4111-8111-111111111111',
    }]);

    const args = baseArgs();
    const result = await processNHCXCallback(args);

    expect(result).toMatchObject({
      duplicate: true,
      processed: false,
      recoveryRequired: true,
    });
    expect(args.recordPreauthResponseImpl).not.toHaveBeenCalled();
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
    const insertCall = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO nhcx_messages'));
    expect(insertCall[24]).toBe('manual_review');
    expect(insertCall[25]).toBeNull();
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

  it('records inbound CommunicationRequest correspondence and moves the claim to queried through the legal transition', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      claim_id: 88,
      preauth_id: 77,
      policy_id: 55,
      patient_uid: PATIENT_UID,
      admission_id: 7001,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '40', inserted: true, status: 'accepted' }]);
    // recordInboundCommunicationRequest now takes pharmacy funding authority
    // before it touches the claim, so the queue has to carry that whole
    // sequence. In order: the claim's funding identity, the one active tenant
    // patient it resolves to, the funding advisory, the admission advisory the
    // admission lock re-takes, the admission row itself, and only then the
    // claim row the transition reads. The claim row must echo the SAME
    // patient/admission the identity read returned — the service refuses with
    // PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH if it drifted under the lock.
    queryUnsafeMock.mockResolvedValueOnce([{ patient_uid: PATIENT_UID, admission_id: 7001 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: 'true' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ lock_acquired: 'true' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7001, patient_uid: PATIENT_UID, status: 'admitted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 88, status: 'submitted', patient_uid: PATIENT_UID, admission_id: 7001,
    }]);
    executeUnsafeMock.mockResolvedValueOnce(1);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 501, claim_id: 88, direction: 'inbound', channel: 'nhcx' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '40', status: 'processed' }]);

    const result = await processNHCXCallback(communicationArgs());

    expect(result).toMatchObject({
      duplicate: false,
      processed: true,
      domainResult: {
        claimId: 88,
        preauthId: null,
        status: 'queried',
      },
    });
    expect(executeUnsafeMock.mock.calls[0][0]).toContain('UPDATE tpa_claims');
    const insertCall = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO tpa_claim_correspondence'));
    expect(insertCall).toBeTruthy();
    expect(insertCall[4]).toBe('Need itemized bill and discharge summary');
    expect(insertCall[5]).toContain('Please upload the itemized final bill.');
  });

  it('treats duplicate CommunicationRequest callbacks as no-op callbacks', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: 88 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '41', inserted: false, status: 'processed' }]);

    const result = await processNHCXCallback(communicationArgs());

    expect(result).toMatchObject({ duplicate: true, processed: false });
    expect(executeUnsafeMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock.mock.calls.some((call) => String(call[0]).includes('INSERT INTO tpa_claim_correspondence'))).toBe(false);
  });

  it('routes unmappable CommunicationRequest callbacks to manual review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '42', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '42', status: 'manual_review' }]);

    const result = await processNHCXCallback(communicationArgs());

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('routes unsupported inbound CommunicationRequest attachments to manual review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: 88 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '43', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '43', status: 'manual_review' }]);

    const result = await processNHCXCallback(communicationArgs(communicationRequestBundle({
      payload: [{
        contentAttachment: {
          contentType: 'application/x-msdownload',
          title: 'payer-tool.exe',
          size: 100,
        },
      }],
    })));

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('captures PaymentNotice as review evidence without changing claim status or ledger state', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      claim_id: 88,
      preauth_id: 77,
      policy_id: 55,
      patient_uid: '11111111-1111-4111-8111-111111111111',
      admission_id: 7001,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '50', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 88,
      claim_number: 'CLM-88',
      status: 'approved',
      claimed_amount: '50000',
      approved_amount: '50000',
      paid_amount: null,
      patient_uid: '11111111-1111-4111-8111-111111111111',
      policy_id: 55,
      preauth_id: 77,
      invoice_id: 900,
      admission_id: 7001,
      policy_number: 'POL-1',
      payer_name: 'Star Health',
      tpa_name: 'Mock TPA',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '50', status: 'manual_review', validation_issues: [] }]);

    const result = await processNHCXCallback(paymentNoticeArgs());

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
    const insertCall = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO nhcx_messages'));
    expect(insertCall[24]).toBe('manual_review');
    expect(insertCall[25]).toBeNull();
    expect(executeUnsafeMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock.mock.calls.some((call) => /UPDATE\s+tpa_claims/i.test(String(call[0])))).toBe(false);
    expect(queryUnsafeMock.mock.calls.some((call) => /ledger_entries|ledger_postings/i.test(String(call[0])))).toBe(false);
  });

  it('treats duplicate PaymentNotice callbacks as idempotent no-ops', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ claim_id: 88 }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '51', inserted: false, status: 'manual_review' }]);

    const result = await processNHCXCallback(paymentNoticeArgs());

    expect(result).toMatchObject({ duplicate: true, processed: false });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('keeps unresolvable PaymentNotice callbacks in manual review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '52', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '52', status: 'manual_review', validation_issues: [] }]);

    const result = await processNHCXCallback(paymentNoticeArgs(paymentNoticeBundle({
      request: { reference: 'Claim/claim-999' },
    })));

    expect(result).toMatchObject({ duplicate: false, processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });
});
