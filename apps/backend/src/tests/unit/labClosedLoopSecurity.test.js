import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const txExecuteRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  $transaction: transactionMock,
};
const __prismaTxMock = {
  $queryRawUnsafe: txQueryRawUnsafeMock,
  $executeRawUnsafe: txExecuteRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaTxMock),
  setTenant: async (_tenantId, fn) => fn(__prismaTxMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaTxMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
  recordClinicalAuditEvent: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  assertSupportedOruEnvelope: jest.fn(),
  ingestOruMessage: jest.fn(),
  notifyCreatedCriticalLabAlerts: jest.fn(),
  resolveTrustedOruChannel: jest.fn(),
}));

const {
  getSpecimenLabel,
  scanReceiveSpecimen,
  ingestInterfaceMessage,
  listInterfaceMessages,
} = await import('../../services/lab/labClosedLoopService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';

describe('labClosedLoopService tenant scoping', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    transactionMock.mockReset();
    txQueryRawUnsafeMock.mockReset();
    txExecuteRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockResolvedValue(1);
    txExecuteRawUnsafeMock.mockResolvedValue(1);
    transactionMock.mockImplementation(async (callback) => callback({
      $queryRawUnsafe: txQueryRawUnsafeMock,
      $executeRawUnsafe: txExecuteRawUnsafeMock,
    }));
  });

  it('loads and marks specimen labels within the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 77,
      tenant_id: TENANT_ID,
      specimen_uid: '33333333-3333-4333-8333-333333333333',
      patient_uid: '44444444-4444-4444-8444-444444444444',
      booking_id: 12,
      accession_number: 'ACC-77',
      barcode: 'ACC-77',
      specimen_type: 'blood',
      container_type: 'edta',
      priority: 'routine',
      status: 'ordered',
      collected_at: null,
      received_at: null,
      label_printed_at: null,
      patient_name: 'Patient One',
    }]);

    const label = await getSpecimenLabel(77, { actorUid: ACTOR_UID, tenantId: TENANT_ID });

    expect(label.specimen_id).toBe(77);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/s\.tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(77);
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
    expect(executeRawUnsafeMock.mock.calls[0][0]).toMatch(/tenant_id = \$3::uuid/);
    expect(executeRawUnsafeMock.mock.calls[0][3]).toBe(TENANT_ID);
  });

  it('lists interface messages only inside the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listInterfaceMessages({ tenantId: TENANT_ID, status: 'failed', limit: 25 });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/WHERE tenant_id = \$1::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT_ID);
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('failed');
    expect(queryRawUnsafeMock.mock.calls[0][3]).toBe(25);
  });

  it('receives scanned specimens only inside the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 77,
      tenant_id: TENANT_ID,
      specimen_uid: '33333333-3333-4333-8333-333333333333',
      patient_uid: '44444444-4444-4444-8444-444444444444',
      booking_id: 12,
      accession_number: 'ACC-77',
      barcode: 'ACC-77',
      specimen_type: 'blood',
      container_type: 'edta',
      priority: 'routine',
      status: 'collected',
      collected_at: null,
      received_at: null,
      label_printed_at: null,
      patient_name: 'Patient One',
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{ id: 77, tenant_id: TENANT_ID, status: 'received' }]);

    await scanReceiveSpecimen({
      barcode: 'ACC-77',
      actorUid: ACTOR_UID,
      tenantId: TENANT_ID,
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/UPPER\(s\.barcode\) = UPPER\(\$1\) AND s\.tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
    expect(txQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/WHERE id = \$1::int AND tenant_id = \$3::uuid/);
    expect(txQueryRawUnsafeMock.mock.calls[0][3]).toBe(TENANT_ID);
  });

  it('rejects ASTM ingestion before any write when no authenticated actor is supplied', async () => {
    await expect(ingestInterfaceMessage({
      protocol: 'astm_e1394',
      analyzerCode: 'ANALYZER-1',
      rawMessage: [
        'H|\\^&|||Analyzer',
        'O|1|ACC-77||^^^GLU|R',
        'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
        'L|1|N',
      ].join('\r'),
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_INTERFACE_ACTOR_REQUIRED',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(txQueryRawUnsafeMock).not.toHaveBeenCalled();
    expect(txExecuteRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects HL7 on the generic interface before any receipt or clinical write', async () => {
    await expect(ingestInterfaceMessage({
      protocol: 'hl7v2',
      analyzerCode: 'ANALYZER-1',
      rawMessage: 'MSH|^~\\&|ANALYZER-1|LAB|VH|VH||||ORU^R01|MSG-1|P|2.5',
      tenantId: TENANT_ID,
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'ADMIN',
      actorRoles: ['ADMIN'],
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_INTERFACE_HL7_ROUTE_REQUIRED',
    });

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(txQueryRawUnsafeMock).not.toHaveBeenCalled();
    expect(txExecuteRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('requires the specimen owner to resolve as an active patient before clinical writes', async () => {
    const analyzer = {
      id: 501,
      analyzer_code: 'ANALYZER-1',
      display_name: 'Analyzer One',
      interface_kind: 'astm',
      status: 'active',
      metadata: {
        astm_sender_aliases: ['Analyzer'],
        astm_manual_import_actor_uids: [ACTOR_UID],
      },
    };
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'ADMIN' }])
      .mockResolvedValueOnce([analyzer])
      .mockResolvedValueOnce([{ id: 901, status: 'received' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'ADMIN' }])
      .mockResolvedValueOnce([analyzer])
      .mockResolvedValueOnce([{ id: 902 }]);

    await expect(ingestInterfaceMessage({
      protocol: 'astm_e1394',
      analyzerCode: 'ANALYZER-1',
      rawMessage: [
        'H|\\^&|||Analyzer',
        'O|1|ACC-STAFF||^^^GLU|R',
        'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
        'L|1|N',
      ].join('\r'),
      tenantId: TENANT_ID,
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'ADMIN',
      actorRoles: ['ADMIN'],
    })).rejects.toMatchObject({ statusCode: 404 });

    const sourceQuery = txQueryRawUnsafeMock.mock.calls[3][0];
    expect(sourceQuery).toMatch(/UPPER\(patient\.role\) = 'PATIENT'/);
    expect(sourceQuery).toMatch(/patient\.is_active = TRUE/);
    expect(sourceQuery).toMatch(/patient\.status = 'active'/);
    expect(sourceQuery).toMatch(/patient\.is_deleted = FALSE/);
    expect(txQueryRawUnsafeMock.mock.calls.some(
      ([sql]) => /INSERT INTO lab_results/.test(sql),
    )).toBe(false);
  });

  it('does not fall back to a manual actor when a supplied API client is unbound', async () => {
    const analyzer = {
      id: 501,
      analyzer_code: 'ANALYZER-1',
      display_name: 'Analyzer One',
      interface_kind: 'astm',
      status: 'active',
      metadata: {
        astm_sender_aliases: ['Analyzer'],
        astm_api_client_ids: ['123'],
        astm_manual_import_actor_uids: [ACTOR_UID],
      },
    };
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'ADMIN' }])
      .mockResolvedValueOnce([analyzer])
      .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'ADMIN' }])
      .mockResolvedValueOnce([analyzer]);

    await expect(ingestInterfaceMessage({
      protocol: 'astm_e1394',
      analyzerCode: 'ANALYZER-1',
      rawMessage: [
        'H|\\^&|||Analyzer',
        'O|1|ACC-77||^^^GLU|R',
        'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
        'L|1|N',
      ].join('\r'),
      tenantId: TENANT_ID,
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'ADMIN',
      actorRoles: ['ADMIN'],
      apiClientId: 999,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_ASTM_ANALYZER_UNTRUSTED',
    });

    expect(txQueryRawUnsafeMock.mock.calls.some(
      ([sql]) => /INSERT INTO (lab_interface_messages|lab_results)/.test(sql),
    )).toBe(false);
  });

  it('rejects a DB API client tenant mismatch before actor or receipt access', async () => {
    await expect(ingestInterfaceMessage({
      protocol: 'astm_e1394',
      analyzerCode: 'ANALYZER-1',
      rawMessage: [
        'H|\\^&|||Analyzer',
        'O|1|ACC-77||^^^GLU|R',
        'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
        'L|1|N',
      ].join('\r'),
      tenantId: TENANT_ID,
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'ADMIN',
      actorRoles: ['ADMIN'],
      apiClientId: 123,
      apiClientTenantId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_INTERFACE_API_CLIENT_TENANT_MISMATCH',
    });

    expect(txQueryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects conflicting API-client and manual-actor analyzer bindings', async () => {
    const apiAnalyzer = {
      id: 501,
      analyzer_code: 'ANALYZER-1',
      display_name: 'Analyzer One',
      interface_kind: 'astm',
      status: 'active',
      metadata: {
        astm_sender_aliases: ['Analyzer'],
        astm_api_client_ids: ['123'],
      },
    };
    const actorAnalyzer = {
      id: 502,
      analyzer_code: 'ANALYZER-2',
      display_name: 'Analyzer Two',
      interface_kind: 'astm',
      status: 'active',
      metadata: { astm_manual_import_actor_uids: [ACTOR_UID] },
    };
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'ADMIN' }])
      .mockResolvedValueOnce([apiAnalyzer, actorAnalyzer])
      .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'ADMIN' }])
      .mockResolvedValueOnce([apiAnalyzer, actorAnalyzer]);

    await expect(ingestInterfaceMessage({
      protocol: 'astm_e1394',
      analyzerCode: 'ANALYZER-1',
      rawMessage: [
        'H|\\^&|||Analyzer',
        'O|1|ACC-77||^^^GLU|R',
        'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
        'L|1|N',
      ].join('\r'),
      tenantId: TENANT_ID,
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'ADMIN',
      actorRoles: ['ADMIN'],
      apiClientId: 123,
      apiClientTenantId: TENANT_ID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'LAB_ASTM_ANALYZER_UNTRUSTED',
    });

    expect(txQueryRawUnsafeMock.mock.calls.some(
      ([sql]) => /INSERT INTO (lab_interface_messages|lab_results)/.test(sql),
    )).toBe(false);
  });
});
