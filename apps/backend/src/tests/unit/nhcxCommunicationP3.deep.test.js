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
  processNHCXCallback,
} = await import('../../services/nhcx/nhcxInboundCallbackService.js');
const {
  createOutboundCommunicationResponse,
  validateCommunicationDocuments,
} = await import('../../services/nhcx/nhcxCommunicationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function communicationRequestBundle(overrides = {}) {
  return {
    resourceType: 'Bundle',
    id: 'p3-communication-request-bundle',
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/CommunicationRequestBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'CommunicationRequest',
        id: 'p3-communication-request',
        status: 'active',
        subject: { reference: 'Patient/11111111-1111-4111-8111-111111111111' },
        reasonCode: [{ text: 'Need discharge summary' }],
        payload: [{ contentString: 'Upload the signed discharge summary.' }],
        ...overrides,
      },
    }],
  };
}

function callbackArgs(bundle = communicationRequestBundle()) {
  return {
    tenantId: TENANT,
    endpoint: 'communication/request',
    body: { payload: 'compact-jwe' },
    headers: {
      'x-hcx-recipient_code': 'VH-NHCX-PROVIDER',
      'x-hcx-sender_code': 'PAYER-NHCX-MOCK',
      'x-hcx-api_call_id': 'p3-communication-request-1',
      'x-hcx-correlation_id': 'p3-correlation-1',
      'x-hcx-workflow_id': '7001',
    },
    participantCodeSelf: 'VH-NHCX-PROVIDER',
    signatureVerified: true,
    runtimeResolver: jest.fn(async () => ({ environment: 'sandbox' })),
    decryptPayload: jest.fn(async () => ({ bundle, protectedHeaders: {} })),
  };
}

function outboundContext() {
  return {
    claim_id: 88,
    preauth_id: 77,
    policy_id: 55,
    patient_uid: '11111111-1111-4111-8111-111111111111',
    admission_id: 7001,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
  loadNHCXRuntimeConfigMock.mockReset();
  delete process.env.NHCX_COMM_ATTACHMENT_ALLOWED_MIME_TYPES;
});

describe('NHCX P3 Communication deep seams', () => {
  it('payor query creates correspondence, records envelope audit headers, and moves claim to queried only from allowed status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([outboundContext()]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '60', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 88, status: 'submitted' }]);
    executeUnsafeMock.mockResolvedValueOnce(1);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 701, claim_id: 88, direction: 'inbound', channel: 'nhcx' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '60', status: 'processed' }]);

    const result = await processNHCXCallback(callbackArgs());

    expect(result).toMatchObject({
      processed: true,
      domainResult: { claimId: 88, status: 'queried' },
    });
    expect(executeUnsafeMock.mock.calls[0][0]).toContain("SET status = 'queried'");
    const envelopeInsert = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO nhcx_messages'));
    expect(envelopeInsert[3]).toBe('communication');
    expect(envelopeInsert[4]).toBe('communication/request');
    expect(envelopeInsert[7]).toBe('p3-communication-request-1');
    expect(envelopeInsert[8]).toBe('p3-correlation-1');
    const protectedHeaders = JSON.parse(envelopeInsert[19]);
    expect(protectedHeaders).toMatchObject({
      'x-hcx-api_call_id': 'p3-communication-request-1',
      'x-hcx-correlation_id': 'p3-correlation-1',
      sender_code: 'PAYER-NHCX-MOCK',
      recipient_code: 'VH-NHCX-PROVIDER',
    });
    const correspondenceInsert = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO tpa_claim_correspondence'));
    const audit = JSON.parse(correspondenceInsert[6]);
    expect(audit[0].nhcx).toMatchObject({
      endpoint: 'communication/request',
      api_call_id: 'p3-communication-request-1',
      correlation_id: 'p3-correlation-1',
      workflow_id: '7001',
      message_id: '60',
    });
  });

  it('illegal query transition routes to manual review and does not create correspondence', async () => {
    queryUnsafeMock.mockResolvedValueOnce([outboundContext()]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '61', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 88, status: 'paid' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '61', status: 'manual_review' }]);

    const result = await processNHCXCallback(callbackArgs());

    expect(result).toMatchObject({ processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(executeUnsafeMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock.mock.calls.some((call) => String(call[0]).includes('INSERT INTO tpa_claim_correspondence'))).toBe(false);
  });

  it('selected attachments must belong to the same tenant and same claim/preauth', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(validateCommunicationDocuments({
      tenantId: TENANT,
      claimId: 88,
      documentIds: [10],
    })).rejects.toMatchObject({ code: 'NHCX_ATTACHMENT_OWNERSHIP_INVALID' });

    queryUnsafeMock.mockResolvedValueOnce([{
      id: 10,
      claim_id: 99,
      preauth_id: null,
      tenant_id: TENANT,
      mime_type: 'application/pdf',
      file_size_bytes: 1024,
      file_name: 'other-claim.pdf',
    }]);
    await expect(validateCommunicationDocuments({
      tenantId: TENANT,
      claimId: 88,
      documentIds: [10],
    })).rejects.toMatchObject({ code: 'NHCX_ATTACHMENT_OWNERSHIP_INVALID' });
  });

  it('duplicate CommunicationRequest callback creates no duplicate correspondence', async () => {
    queryUnsafeMock.mockResolvedValueOnce([outboundContext()]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '62', inserted: false, status: 'processed' }]);

    const result = await processNHCXCallback(callbackArgs());

    expect(result).toMatchObject({ duplicate: true, processed: false });
    expect(executeUnsafeMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock.mock.calls.some((call) => String(call[0]).includes('INSERT INTO tpa_claim_correspondence'))).toBe(false);
  });

  it('unsupported inbound attachment type routes the envelope to manual review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([outboundContext()]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '63', inserted: true, status: 'accepted' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: '63', status: 'manual_review' }]);

    const result = await processNHCXCallback(callbackArgs(communicationRequestBundle({
      payload: [{
        contentAttachment: {
          contentType: 'application/x-msdownload',
          title: 'unsupported.exe',
          size: 512,
        },
      }],
    })));

    expect(result).toMatchObject({ processed: false });
    expect(result.envelope.status).toBe('manual_review');
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('outbound text-only Communication response is valid with zero selected documents', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 701,
      claim_id: 88,
      preauth_id: null,
      subject: 'Need discharge summary',
      body: 'Upload the signed discharge summary.',
      attachments: [{
        nhcx: {
          api_call_id: 'p3-communication-request-1',
          correlation_id: 'p3-correlation-1',
          workflow_id: '7001',
        },
      }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 702,
      claim_id: 88,
      preauth_id: null,
      direction: 'outbound',
      channel: 'nhcx',
    }]);

    const result = await createOutboundCommunicationResponse({
      tenantId: TENANT,
      inboundCorrespondenceId: 701,
      responseText: 'The requested details are in the claim note; no attachment is needed.',
      documentIds: [],
      recordedBy: '22222222-2222-4222-8222-222222222222',
      hcxApiCallId: 'p3-communication-response-1',
    });

    expect(result).toMatchObject({
      claimId: 88,
      preauthId: null,
      hcx: {
        apiCallId: 'p3-communication-response-1',
        correlationId: 'p3-correlation-1',
        workflowId: '7001',
      },
    });
    const outboundInsert = queryUnsafeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO tpa_claim_correspondence'));
    const audit = JSON.parse(outboundInsert[6]);
    expect(audit[0].document_ids).toEqual([]);
    expect(audit[0].nhcx).toMatchObject({
      endpoint: 'communication/request',
      in_response_to_api_call_id: 'p3-communication-request-1',
      in_response_to_correspondence_id: 701,
      version_lock: expect.stringContaining('NRCeS 7.0.0 design target'),
    });
  });
});
