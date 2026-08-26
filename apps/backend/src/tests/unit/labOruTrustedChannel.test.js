import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const tx = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: tx,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(tx),
  setTenant: async (_tenantId, fn) => fn(tx),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(tx),
  pickTenantClient: () => tx,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
  recordClinicalAuditEvent: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitCriticalLabAlertAcknowledged: jest.fn(),
}));

jest.unstable_mockModule('../../services/emr/inpatientPathwayDomainService.js', () => ({
  linkPendingResultOwnerActionsForGenerationTx: jest.fn(),
  publishInpatientDiagnosticResourceLinkedTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labCriticalAlertService.js', () => ({
  materializeLabCriticalAlertGeneration: jest.fn(),
  supersedeCriticalAlertWithDiagnosticGenerationTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labThresholdExceptionService.js', () => ({
  applyLabThresholdAssessmentTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labResultIngestCommandService.js', () => ({
  claimLabResultIngestCommand: jest.fn(),
  completeLabResultIngestCommand: jest.fn(),
  finaliseHttpIdempotencyInTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/results/resultsInboxResourceLock.js', () => ({
  lockResultsInboxResourceTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION: 2,
  acknowledgeTask: jest.fn(),
  acknowledgeLabCriticalAlertTaskFromTrustedWorkflow: jest.fn(),
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitLabEvent: jest.fn(),
}));

const {
  parseOruOrderIdentity,
  resolveTrustedOruChannel,
} = await import('../../services/lab/labResultsService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';
const GENERIC_ACTOR = '33333333-3333-4333-8333-333333333333';

const ANALYZERS = [
  {
    id: 10,
    analyzer_code: 'ANALYZER-A',
    metadata: {
      hl7_actor_uids: [ACTOR_A],
      hl7_api_client_ids: ['71'],
    },
  },
  {
    id: 20,
    analyzer_code: 'ANALYZER-B',
    metadata: {
      hl7_actor_uids: [ACTOR_B],
      hl7_api_client_ids: ['72'],
    },
  },
];

function primeChannel(actorUid, analyzers = ANALYZERS) {
  queryRawUnsafeMock
    .mockResolvedValueOnce([{ uid: actorUid, role: 'LAB_STAFF' }])
    .mockResolvedValueOnce(analyzers);
}

function resolveChannel({
  actorUid = ACTOR_A,
  apiClientId = null,
  apiClientTenantId = null,
  sendingApp = 'ANALYZER-A',
} = {}) {
  return resolveTrustedOruChannel({
    tx,
    tenantId: TENANT_ID,
    sendingApp,
    actorUid,
    actorRole: 'LAB_STAFF',
    actorRoles: ['LAB_STAFF'],
    apiClient: apiClientId == null ? 'shared' : `client-${apiClientId}`,
    apiClientId,
    apiClientTenantId,
  });
}

describe('ORU analyzer principal binding', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
  });

  it('rejects an Analyzer-B DB credential even when the actor is bound to the Analyzer-A sender', async () => {
    primeChannel(ACTOR_A);

    await expect(resolveChannel({
      actorUid: ACTOR_A,
      apiClientId: 72,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_ORU_ANALYZER_UNTRUSTED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects an unbound DB credential instead of falling back to an actor binding', async () => {
    primeChannel(ACTOR_A);

    await expect(resolveChannel({
      actorUid: ACTOR_A,
      apiClientId: 99,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_ORU_ANALYZER_UNTRUSTED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects an exact Analyzer-A DB credential when the actor is explicitly bound to Analyzer B', async () => {
    primeChannel(ACTOR_B);

    await expect(resolveChannel({
      actorUid: ACTOR_B,
      apiClientId: 71,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_ORU_ANALYZER_UNTRUSTED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('allows an unbound generic ingest actor only when the DB credential exactly binds the sender', async () => {
    primeChannel(GENERIC_ACTOR);

    await expect(resolveChannel({
      actorUid: GENERIC_ACTOR,
      apiClientId: 71,
      apiClientTenantId: TENANT_ID,
    })).resolves.toMatchObject({
      bindingMode: 'api_client',
      bindingIdentity: '71',
      databaseActorRole: 'LAB_STAFF',
      authenticatedActorRoles: ['LAB_STAFF'],
      analyzer: { id: 10, analyzer_code: 'ANALYZER-A' },
    });
  });

  it('requires an exact actor binding when no DB credential is present', async () => {
    primeChannel(ACTOR_A);

    await expect(resolveChannel({ actorUid: ACTOR_A })).resolves.toMatchObject({
      bindingMode: 'actor_uid',
      bindingIdentity: ACTOR_A,
      analyzer: { id: 10, analyzer_code: 'ANALYZER-A' },
    });

    const actorQuery = queryRawUnsafeMock.mock.calls[0][0];
    expect(actorQuery).toContain('actor.is_active = true');
    expect(actorQuery).toContain("actor.status = 'active'");
    expect(actorQuery).toContain('actor.is_deleted = false');
  });
});

describe('ORU local order namespace parser', () => {
  it('maps only a canonical VHINV identifier to the investigations table', () => {
    expect(parseOruOrderIdentity('VHINV-42')).toEqual({
      kind: 'investigation',
      investigationId: 42,
      externalOrderId: null,
    });
  });

  it.each([
    '42',
    '0',
    '-1',
    '1.5',
    '1e3',
    'VHINV-0',
    'VHINV-01',
    'VHINV-2147483648',
    'VHINV-',
    'VHINV_42',
    'VHINV 42',
    'VHINV+42',
    'VHINV123',
    'vhinv-42',
    'VHBOOK-42',
    'VHBOOK_42',
  ])('rejects ambiguous or malformed reserved identifier %s', (value) => {
    expect(() => parseOruOrderIdentity(value)).toThrow(expect.objectContaining({
      statusCode: 400,
      code: 'LAB_ORU_ORDER_NAMESPACE_REQUIRED',
    }));
  });

  it('keeps absent and genuinely external alphanumeric identifiers unlinked', () => {
    expect(parseOruOrderIdentity('')).toEqual({
      kind: 'external',
      investigationId: null,
      externalOrderId: null,
    });
    expect(parseOruOrderIdentity('EXT-LAB-42')).toEqual({
      kind: 'external',
      investigationId: null,
      externalOrderId: 'EXT-LAB-42',
    });
  });
});
