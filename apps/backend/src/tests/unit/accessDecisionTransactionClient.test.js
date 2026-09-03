import { jest } from '@jest/globals';

const globalDb = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};
const warnMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: globalDb,
  setTenantTx: async (_tenantId, fn) => fn(globalDb),
  setTenant: async (_tenantId, fn) => fn(globalDb),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(globalDb),
  pickTenantClient: () => globalDb,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  ACCESS_POLICY_CODES,
  authorizeClinicalImportReconciliationAccessBatchRequest,
  authorizePatientAccessRequest,
  resolvePatientForAccess,
} = await import('../../services/security/accessDecisionService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function patientUid(index) {
  return `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
}

function reconciliationItemUid(index) {
  return `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
}

function medicalRecordsRequest() {
  const req = requestForPatient();
  req.originalUrl = '/api/v1/documents/import/reconciliation';
  req.user.role = 'MEDICAL_RECORDS';
  req.user.rawRole = 'MEDICAL_RECORDS';
  return req;
}

function batchEntries(count) {
  return Array.from({ length: count }, (_, index) => {
    const decisionKey = reconciliationItemUid(index + 1);
    return {
      decisionKey,
      patient: { id: index + 1, uid: patientUid(index + 1) },
      resourceContext: {
        resourceType: 'clinical_import_reconciliation',
        resourceId: decisionKey,
      },
    };
  });
}

function requestForPatient() {
  return {
    id: 'req-transaction-client',
    method: 'GET',
    originalUrl: '/api/v1/records?patient_id=15',
    params: {},
    query: { patient_id: '15' },
    body: {},
    user: {
      id: 9,
      uid: ACTOR_UID,
      role: 'CNO',
      rawRole: 'CNO',
      tenant_id: TENANT_ID,
    },
  };
}

beforeEach(() => {
  globalDb.$queryRawUnsafe.mockReset();
  globalDb.$executeRawUnsafe.mockReset();
  warnMock.mockReset();
});

describe('access-decision transaction client', () => {
  it('authorizes 25 exact active patient pairs with one verification query and one bulk audit insert', async () => {
    const entries = batchEntries(25);
    const transactionDb = {
      $queryRawUnsafe: jest.fn(async (_sql, tenantId, encodedEntries) => {
        expect(tenantId).toBe(TENANT_ID);
        return JSON.parse(encodedEntries).map(entry => ({
          decision_key: entry.decision_key,
          id: entry.patient_id,
          uid: entry.patient_uid,
        }));
      }),
      $executeRawUnsafe: jest.fn(async () => 25),
    };

    const decisions = await authorizeClinicalImportReconciliationAccessBatchRequest(
      medicalRecordsRequest(),
      {
        db: transactionDb,
        entries,
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
        recordType: 'MEDICAL_RECORD',
        requireResolvedPatient: true,
      },
    );

    expect(decisions).toHaveLength(25);
    expect(decisions.every(({ decision }) => decision.allowed === true)).toBe(true);
    expect(transactionDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(transactionDb.$queryRawUnsafe.mock.calls[0][0]).toMatch(/patient\.tenant_id=\$1::uuid[\s\S]*patient\.id=request\.patient_id[\s\S]*patient\.uid=request\.patient_uid[\s\S]*patient\.is_active=TRUE[\s\S]*patient\.merged_into_uid IS NULL/);
    expect(transactionDb.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const auditRows = JSON.parse(transactionDb.$executeRawUnsafe.mock.calls[0][1]);
    expect(auditRows).toHaveLength(25);
    expect(auditRows.map(row => row.metadata.resource_id))
      .toEqual(entries.map(entry => entry.decisionKey));
    expect(globalDb.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(globalDb.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('denies an exact pair omitted by tenant verification and audits both decisions in bulk', async () => {
    const entries = batchEntries(2);
    const transactionDb = {
      $queryRawUnsafe: jest.fn(async () => [{
        decision_key: entries[0].decisionKey,
        id: entries[0].patient.id,
        uid: entries[0].patient.uid,
      }]),
      $executeRawUnsafe: jest.fn(async () => 2),
    };

    const decisions = await authorizeClinicalImportReconciliationAccessBatchRequest(
      medicalRecordsRequest(),
      {
        db: transactionDb,
        entries,
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
        recordType: 'MEDICAL_RECORD',
        requireResolvedPatient: true,
      },
    );

    expect(decisions.map(({ decision }) => decision.allowed)).toEqual([true, false]);
    expect(decisions[1].decision.reason).toMatch(/exact tenant-scoped batch pair/);
    expect(JSON.parse(transactionDb.$executeRawUnsafe.mock.calls[0][1])).toHaveLength(2);
  });

  it('fails closed outside the exact Medical Records upload batch contract', async () => {
    const transactionDb = {
      $queryRawUnsafe: jest.fn(),
      $executeRawUnsafe: jest.fn(),
    };

    await expect(authorizeClinicalImportReconciliationAccessBatchRequest(
      requestForPatient(),
      {
        db: transactionDb,
        entries: batchEntries(1),
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
        recordType: 'MEDICAL_RECORD',
        requireResolvedPatient: true,
      },
    )).rejects.toThrow(/restricted to Medical Records clinical-import reconciliation/);
    expect(transactionDb.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a patient decision whose audit resource is not bound to the same item', async () => {
    const transactionDb = {
      $queryRawUnsafe: jest.fn(),
      $executeRawUnsafe: jest.fn(),
    };
    const entries = batchEntries(1);
    entries[0].resourceContext.resourceId = reconciliationItemUid(2);

    await expect(authorizeClinicalImportReconciliationAccessBatchRequest(
      medicalRecordsRequest(),
      {
        db: transactionDb,
        entries,
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
        recordType: 'MEDICAL_RECORD',
        requireResolvedPatient: true,
      },
    )).rejects.toThrow(/item-bound resource context/);
    expect(transactionDb.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rethrows a bulk patient-access audit failure to abort the caller transaction', async () => {
    const entries = batchEntries(1);
    const auditFailure = new Error('bulk patient-access audit failed');
    const transactionDb = {
      $queryRawUnsafe: jest.fn(async () => [{
        decision_key: entries[0].decisionKey,
        id: entries[0].patient.id,
        uid: entries[0].patient.uid,
      }]),
      $executeRawUnsafe: jest.fn(async () => { throw auditFailure; }),
    };

    await expect(authorizeClinicalImportReconciliationAccessBatchRequest(
      medicalRecordsRequest(),
      {
        db: transactionDb,
        entries,
        policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
        recordType: 'MEDICAL_RECORD',
        requireResolvedPatient: true,
      },
    )).rejects.toBe(auditFailure);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('keeps patient resolution, relationship probes, and audit persistence on the supplied client', async () => {
    const transactionDb = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }])
        .mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
    globalDb.$queryRawUnsafe.mockRejectedValue(new Error('global DB query escaped transaction'));
    globalDb.$executeRawUnsafe.mockRejectedValue(new Error('global DB audit escaped transaction'));

    const decision = await authorizePatientAccessRequest(requestForPatient(), {
      db: transactionDb,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
    });

    expect(decision).toMatchObject({
      allowed: false,
      patient_id: 15,
      patient_uid: PATIENT_UID,
    });
    expect(transactionDb.$queryRawUnsafe.mock.calls.length).toBeGreaterThan(1);
    expect(transactionDb.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(globalDb.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(globalDb.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps exported patient resolution on the global client when no context is supplied', async () => {
    globalDb.$queryRawUnsafe.mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }]);

    await expect(resolvePatientForAccess(requestForPatient(), { id: 15 }))
      .resolves.toEqual({ id: 15, uid: PATIENT_UID });
    expect(globalDb.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('rejects a supplied-client audit failure so the caller transaction cannot commit silently', async () => {
    const auditFailure = new Error('transaction audit insert failed');
    const transactionDb = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }])
        .mockResolvedValue([]),
      $executeRawUnsafe: jest.fn().mockRejectedValue(auditFailure),
    };

    await expect(authorizePatientAccessRequest(requestForPatient(), {
      db: transactionDb,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
    })).rejects.toBe(auditFailure);

    expect(transactionDb.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(globalDb.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(globalDb.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('retains the durable file fallback for a default-client audit failure', async () => {
    const auditFailure = new Error('global audit insert failed');
    globalDb.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 15, uid: PATIENT_UID }])
      .mockResolvedValue([]);
    globalDb.$executeRawUnsafe.mockRejectedValue(auditFailure);

    await expect(authorizePatientAccessRequest(requestForPatient(), {
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'MEDICAL_RECORD',
      patient: { id: 15 },
    })).resolves.toMatchObject({
      allowed: false,
      patient_id: 15,
      patient_uid: PATIENT_UID,
    });

    expect(globalDb.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      'Patient access audit file fallback:',
      expect.objectContaining({
        tenant_id: TENANT_ID,
        patient_uid: PATIENT_UID,
        actor_uid: ACTOR_UID,
        access_decision: 'deny',
        error: auditFailure.message,
      }),
    );
  });
});
