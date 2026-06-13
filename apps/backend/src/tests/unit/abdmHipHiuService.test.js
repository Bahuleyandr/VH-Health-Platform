/**
 * Phase D1 — abdmHipHiuService unit tests.
 *
 * Covers validation, sandbox/production environment isolation,
 * consent-request state machine, idempotency-aware webhook intake,
 * and lifecycle helpers (revoke / expire artifacts, transition data
 * transfers). Mocks prisma.$queryRawUnsafe.
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
  createConsentRequest,
  createDataTransfer,
  expireConsentArtifacts,
  getAbhaProfileByAbhaId,
  linkCareContext,
  listAbhaProfiles,
  listCareContexts,
  listConsentArtifacts,
  listDataTransfers,
  listFacilityMappings,
  listPractitionerMappings,
  listWebhookEvents,
  markWebhookProcessed,
  recordConsentArtifact,
  recordWebhookEvent,
  revokeConsentArtifact,
  transitionConsentRequest,
  transitionDataTransfer,
  unlinkCareContext,
  upsertAbhaProfile,
  upsertFacilityMapping,
  upsertPractitionerMapping,
  __testing__,
} = await import('../../services/abdmFull/abdmHipHiuService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// ---------------------------------------------------------------------------
// ABHA profiles
// ---------------------------------------------------------------------------

describe('upsertAbhaProfile', () => {
  it('rejects missing patient_uid', async () => {
    await expect(upsertAbhaProfile({ tenantId: TENANT, abhaId: '12-3456-7890-1234' }))
      .rejects.toThrow(/patient_uid is required/);
  });

  it('rejects missing abha_id', async () => {
    await expect(upsertAbhaProfile({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toThrow(/abha_id is required/);
  });

  it('rejects unknown kyc_method', async () => {
    await expect(upsertAbhaProfile({
      tenantId: TENANT, patientUid: PATIENT, abhaId: '12-3456-7890-1234',
      kycMethod: 'palm_scan',
    })).rejects.toThrow(/kyc_method must be one of/);
  });

  it('inserts an active profile', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, abha_id: '12-3456-7890-1234', kyc_verified: true,
    }]);
    const row = await upsertAbhaProfile({
      tenantId: TENANT, patientUid: PATIENT, abhaId: '12-3456-7890-1234',
      kycVerified: true, kycMethod: 'aadhaar_otp',
    });
    expect(row.id).toBe(1);
  });
});

describe('listAbhaProfiles + getAbhaProfileByAbhaId', () => {
  it('listAbhaProfiles degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abha_profiles" does not exist'));
    expect(await listAbhaProfiles({ tenantId: TENANT })).toEqual({ profiles: [], count: 0 });
  });

  it('getAbhaProfileByAbhaId returns null when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    expect(await getAbhaProfileByAbhaId({ tenantId: TENANT, abhaId: 'X' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HFR / HPR mappings
// ---------------------------------------------------------------------------

describe('upsertFacilityMapping + upsertPractitionerMapping', () => {
  it('upsertFacilityMapping rejects missing hfr_id', async () => {
    await expect(upsertFacilityMapping({ tenantId: TENANT, facilityName: 'X' }))
      .rejects.toThrow(/hfr_id is required/);
  });

  it('upsertFacilityMapping rejects unknown ownership_kind', async () => {
    await expect(upsertFacilityMapping({
      tenantId: TENANT, hfrId: 'HFR-1', facilityName: 'X', ownershipKind: 'co-op-trust',
    })).rejects.toThrow(/ownership_kind must be one of/);
  });

  it('upsertFacilityMapping inserts/upserts a mapping', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, hfr_id: 'HFR-1', registration_status: 'verified',
    }]);
    const row = await upsertFacilityMapping({
      tenantId: TENANT, hfrId: 'HFR-1', facilityName: 'Apollo Bangalore',
      ownershipKind: 'private', registrationStatus: 'verified',
    });
    expect(row.registration_status).toBe('verified');
  });

  it('upsertPractitionerMapping rejects bad registration_year', async () => {
    await expect(upsertPractitionerMapping({
      tenantId: TENANT, hprId: 'HPR-1', fullName: 'Dr X',
      registrationYear: 1700,
    })).rejects.toThrow(/registration_year must be 1900..2100/);
  });

  it('listFacilityMappings degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abdm_facility_mappings" does not exist'));
    expect(await listFacilityMappings({ tenantId: TENANT })).toEqual({ mappings: [], count: 0 });
  });

  it('listPractitionerMappings degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abdm_practitioner_mappings" does not exist'));
    expect(await listPractitionerMappings({ tenantId: TENANT })).toEqual({ mappings: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Care contexts
// ---------------------------------------------------------------------------

describe('linkCareContext + unlinkCareContext', () => {
  it('rejects missing reference_id', async () => {
    await expect(linkCareContext({
      tenantId: TENANT, patientUid: PATIENT, hiType: 'OPConsultation',
    })).rejects.toThrow(/reference_id is required/);
  });

  it('rejects unknown hi_type', async () => {
    await expect(linkCareContext({
      tenantId: TENANT, patientUid: PATIENT,
      referenceId: 'CTX-1', hiType: 'RandomNote',
    })).rejects.toThrow(/hi_type must be one of/);
  });

  it('inserts a linked context', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'linked', hi_type: 'OPConsultation', reference_id: 'CTX-1',
    }]);
    const row = await linkCareContext({
      tenantId: TENANT, patientUid: PATIENT,
      referenceId: 'CTX-1', hiType: 'OPConsultation', display: 'Follow-up Apr 2026',
    });
    expect(row.status).toBe('linked');
  });

  it('unlinkCareContext flips to unlinked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'unlinked', unlinked_at: new Date(),
    }]);
    const row = await unlinkCareContext({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('unlinked');
  });

  it('unlinkCareContext throws 404 when not linked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(unlinkCareContext({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('listCareContexts degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abdm_care_contexts" does not exist'));
    expect(await listCareContexts({ tenantId: TENANT })).toEqual({ care_contexts: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Consent requests
// ---------------------------------------------------------------------------

describe('createConsentRequest + transitionConsentRequest', () => {
  it('rejects missing request_id', async () => {
    await expect(createConsentRequest({
      tenantId: TENANT, hiTypes: ['OPConsultation'], permissionKind: 'view',
    })).rejects.toThrow(/request_id is required/);
  });

  it('rejects unknown hi_type entry', async () => {
    await expect(createConsentRequest({
      tenantId: TENANT, requestId: 'R1', hiTypes: ['MagicalNote'],
    })).rejects.toThrow(/hi_types entries must be one of/);
  });

  it('rejects unknown purpose_code', async () => {
    await expect(createConsentRequest({
      tenantId: TENANT, requestId: 'R1', hiTypes: ['OPConsultation'],
      purposeCode: 'SHOPPING',
    })).rejects.toThrow(/purpose_code must be one of/);
  });

  it('inserts a sandbox request', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'requested', environment: 'sandbox',
    }]);
    const row = await createConsentRequest({
      tenantId: TENANT, requestId: 'R1', hiTypes: ['OPConsultation'],
      purposeCode: 'CAREMGT',
    });
    expect(row.environment).toBe('sandbox');
  });

  it('REQUEST_TRANSITIONS map: requested allows granted/denied/revoked/expired/failed', () => {
    expect(__testing__.REQUEST_TRANSITIONS.requested).toEqual(
      expect.arrayContaining(['granted', 'denied', 'revoked', 'expired', 'failed']),
    );
    expect(__testing__.REQUEST_TRANSITIONS.granted).toContain('revoked');
    expect(__testing__.REQUEST_TRANSITIONS.denied).toEqual([]);
  });

  it('transitionConsentRequest rejects illegal transition (denied -> granted)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'denied' }]);
    await expect(transitionConsentRequest({
      tenantId: TENANT, id: 1, nextStatus: 'granted',
    })).rejects.toThrow(/transition/i);
  });

  it('transitionConsentRequest stamps decided_at when leaving requested', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'requested' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'granted' }]);
    await transitionConsentRequest({ tenantId: TENANT, id: 1, nextStatus: 'granted' });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/decided_at = \$\d::timestamptz/);
  });

  it('transitionConsentRequest captures notification_failure on failed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'requested' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'failed' }]);
    await transitionConsentRequest({
      tenantId: TENANT, id: 1, nextStatus: 'failed',
      notificationFailure: 'gateway timeout',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('gateway timeout');
  });

  it('transitionConsentRequest 404 when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(transitionConsentRequest({
      tenantId: TENANT, id: 999, nextStatus: 'granted',
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Consent artifacts
// ---------------------------------------------------------------------------

describe('recordConsentArtifact + revoke + expire', () => {
  it('rejects missing artifact_id', async () => {
    await expect(recordConsentArtifact({
      tenantId: TENANT, hiTypes: ['OPConsultation'], permissionKind: 'view',
    })).rejects.toThrow(/artifact_id is required/);
  });

  it('rejects missing permission_kind', async () => {
    await expect(recordConsentArtifact({
      tenantId: TENANT, artifactId: 'A1', hiTypes: ['OPConsultation'],
    })).rejects.toThrow(/permission_kind is required/);
  });

  it('inserts an active artifact', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'active' }]);
    const row = await recordConsentArtifact({
      tenantId: TENANT, artifactId: 'A1', hiTypes: ['OPConsultation'],
      permissionKind: 'view',
    });
    expect(row.status).toBe('active');
  });

  it('revokeConsentArtifact flips to revoked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'revoked' }]);
    const row = await revokeConsentArtifact({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('revoked');
  });

  it('revokeConsentArtifact 404 when not active', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(revokeConsentArtifact({ tenantId: TENANT, id: 1 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('expireConsentArtifacts returns count of expired rows', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const result = await expireConsentArtifacts({ tenantId: TENANT });
    expect(result.expired_count).toBe(3);
  });

  it('expireConsentArtifacts degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abdm_consent_artifacts" does not exist'));
    expect(await expireConsentArtifacts({ tenantId: TENANT })).toEqual({ expired_count: 0 });
  });

  it('listConsentArtifacts filters by environment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listConsentArtifacts({ tenantId: TENANT, environment: 'production' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/environment = \$\d/);
  });
});

// ---------------------------------------------------------------------------
// Data transfers
// ---------------------------------------------------------------------------

describe('createDataTransfer + transitionDataTransfer', () => {
  it('rejects missing transaction_id', async () => {
    await expect(createDataTransfer({
      tenantId: TENANT, direction: 'out',
    })).rejects.toThrow(/transaction_id is required/);
  });

  it('rejects negative payload size', async () => {
    await expect(createDataTransfer({
      tenantId: TENANT, transactionId: 'TXN-1', payloadSizeBytes: -1,
    })).rejects.toThrow(/payload_size_bytes must be >= 0/);
  });

  it('inserts a pending out-bound transfer', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', direction: 'out', transaction_id: 'TXN-1',
    }]);
    const row = await createDataTransfer({
      tenantId: TENANT, transactionId: 'TXN-1', direction: 'out',
      hiTypes: ['DiagnosticReport'], encryptionKind: 'ecdh_aes_256_gcm',
    });
    expect(row.status).toBe('pending');
  });

  it('transitionDataTransfer to in_flight stamps started_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_flight' }]);
    await transitionDataTransfer({
      tenantId: TENANT, id: 1, nextStatus: 'in_flight', attemptIncrement: true,
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/started_at = \$\d::timestamptz/);
    expect(sql).toMatch(/attempt_count = attempt_count \+ 1/);
  });

  it('transitionDataTransfer to failed stamps completed_at + reason', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'failed' }]);
    await transitionDataTransfer({
      tenantId: TENANT, id: 1, nextStatus: 'failed', failureReason: 'timeout',
    });
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toContain('timeout');
  });

  it('listDataTransfers degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abdm_data_transfers" does not exist'));
    expect(await listDataTransfers({ tenantId: TENANT })).toEqual({ transfers: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Webhook events (idempotency)
// ---------------------------------------------------------------------------

describe('recordWebhookEvent — idempotency', () => {
  it('rejects missing external_event_id', async () => {
    await expect(recordWebhookEvent({
      tenantId: TENANT, eventType: 'consent.granted',
    })).rejects.toThrow(/external_event_id is required/);
  });

  it('returns duplicate=true when event already exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, external_event_id: 'EVT-1', status: 'processed',
    }]);
    const result = await recordWebhookEvent({
      tenantId: TENANT, externalEventId: 'EVT-1', eventType: 'consent.granted',
    });
    expect(result.duplicate).toBe(true);
    expect(result.event.id).toBe(1);
  });

  it('inserts when event is new', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // dedup lookup
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 2, external_event_id: 'EVT-2', status: 'pending',
    }]);
    const result = await recordWebhookEvent({
      tenantId: TENANT, externalEventId: 'EVT-2', eventType: 'consent.granted',
    });
    expect(result.duplicate).toBe(false);
    expect(result.event.id).toBe(2);
  });

  it('handles race condition (concurrent insert) by returning existing row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // dedup empty
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    queryUnsafeMock.mockResolvedValueOnce([{ id: 3, status: 'pending' }]); // recovery lookup
    const result = await recordWebhookEvent({
      tenantId: TENANT, externalEventId: 'EVT-3', eventType: 'consent.granted',
    });
    expect(result.duplicate).toBe(true);
    expect(result.event.id).toBe(3);
  });
});

describe('markWebhookProcessed', () => {
  it('rejects unknown status', async () => {
    await expect(markWebhookProcessed({
      tenantId: TENANT, id: 1, status: 'magic',
    })).rejects.toThrow(/status must be one of/);
  });

  it('flips to processed with related FKs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'processed' }]);
    const row = await markWebhookProcessed({
      tenantId: TENANT, id: 1, status: 'processed',
      relatedRequestId: 5, relatedArtifactId: 6,
    });
    expect(row.status).toBe('processed');
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/related_request_id = \$\d/);
    expect(sql).toMatch(/related_artifact_id = \$\d/);
  });

  it('throws 404 when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(markWebhookProcessed({ tenantId: TENANT, id: 999 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('listWebhookEvents', () => {
  it('filters by event_type + environment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listWebhookEvents({
      tenantId: TENANT, eventType: 'consent.granted', environment: 'production',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/event_type = \$\d/);
    expect(sql).toMatch(/environment = \$\d/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "abdm_webhook_events" does not exist'));
    expect(await listWebhookEvents({ tenantId: TENANT })).toEqual({ events: [], count: 0 });
  });
});
