import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';

process.env.NHCX_ENABLED = 'true';

const queryUnsafeMock = jest.fn();
const runtimeMock = jest.fn();
const buildEligibilityMock = jest.fn();
const buildPreauthMock = jest.fn();
const buildClaimMock = jest.fn();
const buildTaskMock = jest.fn();
const buildCommunicationMock = jest.fn();
const persistEnvelopeMock = jest.fn();
const submitClaimMock = jest.fn();
const createCommunicationResponseMock = jest.fn();
const createTaskMock = jest.fn();

const loggerMock = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, callback) => callback(prismaMock),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock,
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask: createTaskMock,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  resolvePharmacyFundingPatientUidTx: jest.fn(async (_tx, { patientUid }) => String(patientUid)),
  lockPharmacyFundingAuthorityTx: jest.fn(),
  lockPharmacyFundingAdmissionTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/nhcx/nhcxTenantConfigService.js', () => ({
  loadNHCXRuntimeConfig: runtimeMock,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxFhirProfileService.js', () => ({
  buildClaimRequestBundle: buildClaimMock,
  buildClaimStatusTaskBundle: buildTaskMock,
  buildCommunicationResponseBundle: buildCommunicationMock,
  buildCoverageEligibilityRequestBundle: buildEligibilityMock,
  buildPreauthClaimRequestBundle: buildPreauthMock,
  persistOutboundNHCXEnvelope: persistEnvelopeMock,
}));

jest.unstable_mockModule('../../services/insurance/claimsService.js', () => ({
  submitClaim: submitClaimMock,
}));

jest.unstable_mockModule('../../services/nhcx/nhcxCommunicationService.js', () => ({
  createOutboundCommunicationResponse: createCommunicationResponseMock,
}));

const {
  dispatchPendingNHCXMessages,
  enqueueClaimStatusCheck,
  enqueueClaimSubmit,
  enqueueCommunicationResponse,
  redriveNHCXMessage,
  retryAcceptedNHCXProjection,
  __testing__,
} = await import('../../services/nhcx/nhcxOutboundDispatcherService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const RECEIPT_HASH = 'a'.repeat(64);

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

function claimRow(overrides = {}) {
  return {
    ...preauthRow({
      cycle: 'claim',
      endpoint: 'claim/submit',
      hcx_api_call_id: 'claim-api-call-1',
      claim_id: 88,
      preauth_id: 77,
      ...overrides,
    }),
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

function builtClaim() {
  return {
    bundle: {
      resourceType: 'Bundle',
      id: 'claim-bundle-1',
      type: 'collection',
      meta: { profile: ['https://example.test/ClaimBundle'] },
      entry: [],
    },
    payloadHash: 'hash-claim-current',
    profileUrl: 'https://example.test/ClaimBundle',
    profileVersion: '7.0.0-design-target',
    domainResourceType: 'Claim',
    patientUid: '11111111-1111-4111-8111-111111111111',
    admissionId: 7001,
    policyId: 55,
    preauthId: 77,
    claimId: 88,
    workflowId: '7001',
  };
}

function builtTask() {
  return {
    ...builtClaim(),
    payloadHash: 'hash-task-current',
    profileUrl: 'https://example.test/TaskBundle',
    domainResourceType: 'Task',
  };
}

function builtCommunication() {
  return {
    ...builtClaim(),
    payloadHash: 'hash-communication-current',
    profileUrl: 'https://example.test/CommunicationBundle',
    domainResourceType: 'Communication',
    documentIds: [],
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  runtimeMock.mockReset();
  buildEligibilityMock.mockReset();
  buildPreauthMock.mockReset();
  buildClaimMock.mockReset();
  buildTaskMock.mockReset();
  buildCommunicationMock.mockReset();
  persistEnvelopeMock.mockReset();
  submitClaimMock.mockReset();
  createCommunicationResponseMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  createTaskMock.mockReset();
  createTaskMock.mockResolvedValue({
    id: 71,
    status: 'open',
    assigned_to_role: 'INSURANCE_COORDINATOR',
  });
  runtimeMock.mockResolvedValue(runtime());
  buildPreauthMock.mockResolvedValue(builtPreauth());
  buildClaimMock.mockResolvedValue(builtClaim());
  buildTaskMock.mockResolvedValue(builtTask());
  buildCommunicationMock.mockResolvedValue(builtCommunication());
  submitClaimMock.mockResolvedValue({ id: 88, status: 'submitted' });
  createCommunicationResponseMock.mockResolvedValue({
    correspondence: { id: 501, claim_id: 88 },
    documents: [],
    claimId: 88,
    preauthId: null,
    hcx: {
      apiCallId: 'communication-api-1',
      correlationId: 'claim-corr-1',
      workflowId: '7001',
    },
  });
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
  it('admits recovered non-payment rows only with exact applied I19 receipt proof', () => {
    const path = fileURLToPath(new URL(
      '../../services/nhcx/nhcxOutboundDispatcherService.js',
      import.meta.url,
    ));
    const source = fs.readFileSync(path, 'utf8');
    expect(source).toMatch(/recovery_disposition = 'manual_redrive_requested'/);
    expect(source).toMatch(/cycle <> 'payment_notice'/);
    expect(source).toMatch(/receipt\.source_kind = 'held_message_release'/);
    expect(source).toMatch(/receipt\.disposition = 'applied'/);
    expect(source).toMatch(/effect\.interface_family = 'I19'/);
    expect(source).toMatch(/effect\.nhcx_message_id = nhcx_messages\.id/);
  });

  it('encrypts the current preauth snapshot and marks gateway acceptance', async () => {
    const row = preauthRow();
    const accepted = {
      ...row,
      status: 'accepted',
      projection_status: 'pending',
      transport_accepted_at: new Date(),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
      transport_gateway_reference: 'GW-123',
    };
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-preauth-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 77,
      patient_uid: row.patient_uid,
      admission_id: row.admission_id,
      status: 'submitted',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 77, status: 'submitted', submission_channel: 'nhcx' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...accepted, projection_status: 'applied' }]);

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

  it('encrypts the current claim snapshot and marks gateway acceptance without posting ledger', async () => {
    const row = claimRow();
    const accepted = {
      ...row,
      status: 'accepted',
      projection_status: 'pending',
      transport_accepted_at: new Date(),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
    };
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-claim-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 88,
      patient_uid: row.patient_uid,
      admission_id: row.admission_id,
      status: 'submitted',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 88, status: 'submitted', submission_channel: 'nhcx' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...accepted, projection_status: 'applied' }]);

    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })),
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 1, failed: 0, dead: 0 });
    expect(buildClaimMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      claimId: 88,
    }));
    const claimProjectionCall = queryUnsafeMock.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE tpa_claims'));
    expect(claimProjectionCall[0]).not.toMatch(/ledger|INSURANCE_AR/i);
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

  it('encrypts the current Communication response snapshot and dispatches through communication/request', async () => {
    const row = claimRow({
      cycle: 'communication',
      endpoint: 'communication/request',
      hcx_api_call_id: 'communication-api-1',
    });
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-communication-current' }]);
    const accepted = {
      ...row,
      status: 'accepted',
      projection_status: 'pending',
      transport_accepted_at: new Date(),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
    };
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...accepted, projection_status: 'applied' }]);

    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 }));
    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: fetchMock,
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 1, failed: 0, dead: 0 });
    expect(buildCommunicationMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      hcxApiCallId: 'communication-api-1',
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://nhcx.example.test/v0.9/communication/request',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // `communication` is one of the four outbound cycles that own no local claim
  // or pre-auth row to project onto. Gateway acceptance must close the
  // projection out, not raise NHCX_GATEWAY_PROJECTION_TARGET_REQUIRED into a
  // coordinator task that no retry could ever clear.
  it('closes an accepted Communication cycle as projection-complete instead of demanding a local target', async () => {
    const row = claimRow({
      cycle: 'communication',
      endpoint: 'communication/request',
      hcx_api_call_id: 'communication-api-1',
    });
    const accepted = {
      ...row,
      status: 'accepted',
      projection_status: 'pending',
      transport_accepted_at: new Date(),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
    };
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-communication-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...accepted, projection_status: 'applied' }]);

    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })),
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 1, failed: 0, dead: 0 });

    const sqlText = queryUnsafeMock.mock.calls.map(([sql]) => String(sql));
    // No local workflow row was touched and no reconciliation owner was minted.
    expect(sqlText.some((sql) => sql.includes('UPDATE tpa_claims'))).toBe(false);
    expect(sqlText.some((sql) => sql.includes('UPDATE insurance_preauth'))).toBe(false);
    expect(sqlText.some((sql) => sql.includes("projection_status='reconciliation_required'"))).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();

    const appliedCall = queryUnsafeMock.mock.calls.find(([sql]) =>
      String(sql).includes("SET projection_status='applied'"));
    expect(appliedCall).toBeDefined();
    expect(appliedCall[1]).toBe(TENANT);
    expect(appliedCall[2]).toBe('10');
    expect(JSON.parse(appliedCall[3])).toEqual({
      contract: 'nhcx_gateway_projection_not_applicable_v1',
      transport_response_sha256: RECEIPT_HASH,
      cycle: 'communication',
      claim_id: 88,
      preauth_id: 77,
      projection: null,
      no_local_projection_target_reason: 'cycle_has_no_local_projection_target',
      task_id: null,
      completed_by: null,
    });
  });

  // A claim/pre-auth row already past its projectable window is the second
  // pre-receipt case that returned a benign null: warn and close, never raise.
  it('closes an accepted claim whose local row is past its projectable window', async () => {
    const row = claimRow();
    const accepted = {
      ...row,
      status: 'accepted',
      projection_status: 'pending',
      transport_accepted_at: new Date(),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
    };
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-claim-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    // The payer already adjudicated this claim, so it is no longer inside the
    // ('submitted','queried') window projectGatewayAcceptanceTargetTx can touch.
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 88,
      patient_uid: row.patient_uid,
      admission_id: row.admission_id,
      status: 'approved',
      submission_channel: 'nhcx',
      tpa_reference_id: 'GW-OLD',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...accepted, projection_status: 'applied' }]);

    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })),
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 1, failed: 0, dead: 0 });

    const sqlText = queryUnsafeMock.mock.calls.map(([sql]) => String(sql));
    expect(sqlText.some((sql) => sql.includes('UPDATE tpa_claims'))).toBe(false);
    expect(sqlText.some((sql) => sql.includes("projection_status='reconciliation_required'"))).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'NHCX gateway acceptance had no projectable local workflow row',
      expect.objectContaining({
        nhcx_message_id: '10',
        tenant_id: TENANT,
        cycle: 'claim',
        claim_id: 88,
        preauth_id: 77,
      }),
    );

    const appliedCall = queryUnsafeMock.mock.calls.find(([sql]) =>
      String(sql).includes("SET projection_status='applied'"));
    expect(appliedCall).toBeDefined();
    expect(JSON.parse(appliedCall[3])).toEqual({
      contract: 'nhcx_gateway_projection_not_applicable_v1',
      transport_response_sha256: RECEIPT_HASH,
      cycle: 'claim',
      claim_id: 88,
      preauth_id: 77,
      projection: null,
      no_local_projection_target_reason: 'local_target_not_in_projectable_state',
      task_id: null,
      completed_by: null,
    });
  });

  // The relaxation is scoped to cycles with no target. A claim that DOES own a
  // projectable local row and still cannot be projected keeps failing closed
  // onto a durable INSURANCE_COORDINATOR reconciliation task.
  it('still fails an accepted claim closed onto a reconciliation task when its local target will not project', async () => {
    const row = claimRow();
    const accepted = {
      ...row,
      status: 'accepted',
      projection_status: 'pending',
      transport_accepted_at: new Date(),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
    };
    queryUnsafeMock.mockResolvedValueOnce([row]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...row, payload_hash: 'hash-claim-current' }]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 88,
      patient_uid: row.patient_uid,
      admission_id: row.admission_id,
      status: 'submitted',
      submission_channel: 'tpa_portal',
      tpa_reference_id: null,
    }]);
    // The guarded UPDATE matches nothing: the row moved out from under the lock.
    queryUnsafeMock.mockResolvedValueOnce([]);
    // markGatewayProjectionReconciliation re-locks the message, then persists.
    queryUnsafeMock.mockResolvedValueOnce([accepted]);
    queryUnsafeMock.mockResolvedValueOnce([{
      ...accepted,
      projection_status: 'reconciliation_required',
      projection_task_id: 71,
    }]);

    const result = await dispatchPendingNHCXMessages({
      tenantId: TENANT,
      fetchImpl: jest.fn(async () => new Response(JSON.stringify({ status: 'accepted' }), { status: 202 })),
      allowDisabled: true,
    });

    expect(result).toEqual({ dispatched: 1, accepted: 1, failed: 0, dead: 0 });

    const sqlText = queryUnsafeMock.mock.calls.map(([sql]) => String(sql));
    expect(sqlText.some((sql) => sql.includes("SET projection_status='applied'"))).toBe(false);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Accepted NHCX response requires local projection reconciliation',
      expect.objectContaining({
        nhcx_message_id: '10',
        tenant_id: TENANT,
        transport_response_sha256: RECEIPT_HASH,
        error: 'The accepted NHCX response has no actionable local claim or pre-auth target',
      }),
    );
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      taskKind: 'review',
      relatedResourceType: 'nhcx_gateway_projection',
      relatedResourceId: '10',
      assignedToRole: 'INSURANCE_COORDINATOR',
      priority: 'high',
      metadata: expect.objectContaining({
        contract: 'nhcx_gateway_projection_reconciliation_v1',
        transport_response_sha256: RECEIPT_HASH,
        claim_id: 88,
        preauth_id: 77,
      }),
    }));

    const reconciliationCall = queryUnsafeMock.mock.calls.find(([sql]) =>
      String(sql).includes("SET projection_status='reconciliation_required'"));
    expect(reconciliationCall).toBeDefined();
    expect(reconciliationCall[1]).toBe(TENANT);
    expect(reconciliationCall[2]).toBe('10');
    expect(reconciliationCall[3])
      .toBe('The accepted NHCX response has no actionable local claim or pre-auth target');
    expect(JSON.parse(reconciliationCall[4])).toEqual({
      contract: 'nhcx_gateway_projection_reconciliation_v1',
      transport_response_sha256: RECEIPT_HASH,
      task_id: 71,
      error: 'The accepted NHCX response has no actionable local claim or pre-auth target',
    });
    expect(reconciliationCall[5]).toBe(71);
  });
});

describe('retryAcceptedNHCXProjection', () => {
  it('replays one durable local projection without a second target mutation', async () => {
    const message = claimRow({
      status: 'accepted',
      projection_status: 'reconciliation_required',
      projection_task_id: 71,
      transport_accepted_at: new Date('2026-08-29T08:00:00.000Z'),
      transport_http_status: 202,
      transport_response_sha256: RECEIPT_HASH,
      transport_gateway_reference: 'GW-42',
    });
    const actorUid = '22222222-2222-4222-8222-222222222222';
    let projected = false;
    let completedReceipt = null;
    let targetMutations = 0;
    queryUnsafeMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('SELECT * FROM nhcx_messages') && text.includes('FOR UPDATE')) {
        return [{ ...message, projection_status: projected ? 'applied' : 'reconciliation_required' }];
      }
      if (text.includes('FROM users')) {
        return [{ uid: actorUid, role: 'INSURANCE_COORDINATOR' }];
      }
      if (text.includes('SELECT * FROM nhcx_projection_commands')) {
        return completedReceipt ? [completedReceipt] : [];
      }
      if (text.includes('FROM tpa_claims') && text.includes('FOR UPDATE')) {
        return [{
          id: 88,
          patient_uid: message.patient_uid,
          admission_id: message.admission_id,
          status: 'submitted',
        }];
      }
      if (text.includes('FROM tasks') && text.includes('FOR UPDATE')) {
        return [{ id: 71, status: 'open', assigned_to_role: 'INSURANCE_COORDINATOR' }];
      }
      if (text.includes('INSERT INTO nhcx_projection_commands')) {
        return [{
          id: '501',
          tenant_id: TENANT,
          nhcx_message_id: message.id,
          task_id: 71,
          actor_uid: actorUid,
          actor_role: 'INSURANCE_COORDINATOR',
          command_key_sha256: 'b'.repeat(64),
          request_sha256: expect.anything(),
          transport_response_sha256: RECEIPT_HASH,
          status: 'IN_PROGRESS',
        }];
      }
      if (text.includes('UPDATE tpa_claims')) {
        targetMutations += 1;
        return [{ id: 88, status: 'submitted', submission_channel: 'nhcx' }];
      }
      if (text.includes('UPDATE tasks')) {
        return [{ id: 71, status: 'completed', assigned_to_role: 'INSURANCE_COORDINATOR' }];
      }
      if (text.includes('UPDATE nhcx_messages')) {
        projected = true;
        return [{ ...message, projection_status: 'applied', projection_task_id: null }];
      }
      if (text.includes('UPDATE nhcx_projection_commands')) return [{ id: '501' }];
      throw new Error(`Unexpected retry query: ${text}`);
    });

    const first = await retryAcceptedNHCXProjection({
      tenantId: TENANT,
      messageId: 10,
      expectedTransportResponseSha256: RECEIPT_HASH,
      actorUid,
      commandKeySha256: 'b'.repeat(64),
    });
    completedReceipt = {
      id: '501',
      tenant_id: TENANT,
      nhcx_message_id: message.id,
      task_id: 71,
      actor_uid: actorUid,
      command_key_sha256: 'b'.repeat(64),
      request_sha256: __testing__.projectionRequestSha256({
        messageId: message.id,
        transportResponseSha256: RECEIPT_HASH,
      }),
      transport_response_sha256: RECEIPT_HASH,
      status: 'COMPLETE',
      response: first,
    };
    const replay = await retryAcceptedNHCXProjection({
      tenantId: TENANT,
      messageId: 10,
      expectedTransportResponseSha256: RECEIPT_HASH,
      actorUid,
      commandKeySha256: 'b'.repeat(64),
    });

    expect(replay).toEqual(first);
    expect(targetMutations).toBe(1);
  });
});

describe('enqueueClaimSubmit', () => {
  it('validates the Claim bundle, reuses claimsService.submitClaim, then persists an outbound envelope', async () => {
    persistEnvelopeMock.mockResolvedValue({ envelope: { id: '30', cycle: 'claim' }, payloadHash: 'hash-claim-current' });

    const result = await enqueueClaimSubmit({
      tenantId: TENANT,
      claimId: 88,
      documentIds: [10, 11],
      submittedBy: '22222222-2222-4222-8222-222222222222',
      hcxApiCallId: 'claim-api-1',
      hcxCorrelationId: 'claim-corr-1',
      allowDisabled: true,
    });

    expect(result.envelope.cycle).toBe('claim');
    expect(buildClaimMock).toHaveBeenCalledTimes(2);
    expect(submitClaimMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      id: 88,
      submission_channel: 'nhcx',
    }));
    expect(persistEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      cycle: 'claim',
      endpoint: 'claim/submit',
      claimId: 88,
      domainResourceType: 'Claim',
    }));
  });

  it('does not submit or enqueue when strict Claim bundle validation fails', async () => {
    buildClaimMock.mockRejectedValueOnce(Object.assign(new Error('invalid bundle'), { code: 'NHCX_FHIR_PROFILE_INVALID' }));

    await expect(enqueueClaimSubmit({
      tenantId: TENANT,
      claimId: 88,
      allowDisabled: true,
    })).rejects.toMatchObject({ code: 'NHCX_FHIR_PROFILE_INVALID' });

    expect(submitClaimMock).not.toHaveBeenCalled();
    expect(persistEnvelopeMock).not.toHaveBeenCalled();
  });
});

describe('enqueueClaimStatusCheck', () => {
  it('queues a Task envelope and does not mutate claim workflow state', async () => {
    persistEnvelopeMock.mockResolvedValue({ envelope: { id: '31', cycle: 'task' }, payloadHash: 'hash-task-current' });

    await enqueueClaimStatusCheck({
      tenantId: TENANT,
      claimId: 88,
      allowDisabled: true,
    });

    expect(buildTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      claimId: 88,
    }));
    expect(submitClaimMock).not.toHaveBeenCalled();
    expect(persistEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({
      cycle: 'task',
      endpoint: 'claim/status',
      claimId: 88,
      domainResourceType: 'Task',
    }));
  });
});

describe('enqueueCommunicationResponse', () => {
  it('queues a text-only Communication response from inbound correspondence', async () => {
    persistEnvelopeMock.mockResolvedValue({ envelope: { id: '50', cycle: 'communication' }, payloadHash: 'hash-communication-current' });

    const result = await enqueueCommunicationResponse({
      tenantId: TENANT,
      inboundCorrespondenceId: 500,
      responseText: 'Attached documents are not required; answer is text-only.',
      documentIds: [],
      recordedBy: '22222222-2222-4222-8222-222222222222',
      hcxApiCallId: 'communication-api-1',
      allowDisabled: true,
    });

    expect(result.envelope.cycle).toBe('communication');
    expect(createCommunicationResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      inboundCorrespondenceId: 500,
      responseText: 'Attached documents are not required; answer is text-only.',
      documentIds: [],
      recordedBy: '22222222-2222-4222-8222-222222222222',
      hcxApiCallId: 'communication-api-1',
    }));
    expect(buildCommunicationMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      hcxApiCallId: 'communication-api-1',
    }));
    expect(persistEnvelopeMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      cycle: 'communication',
      endpoint: 'communication/request',
      claimId: 88,
      domainResourceType: 'Communication',
    }));
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
