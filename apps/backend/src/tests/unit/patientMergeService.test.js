/**
 * Phase A2 PR2 — patientMergeService unit tests.
 *
 * Drives the request → approve → execute happy path plus all the
 * forbidden / not-found / state-machine edges. Execution (reworked by the
 * 2026-08-07 Phase-3 deep review) is catalog-discovered: the sweep target
 * list, secondary deactivation, canonical timeline/audit emits and token
 * revocation are all asserted here against mocks; the end-to-end behavior
 * runs against a real schema in
 * src/tests/patient-merge-execution.deep.test.js.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const reassignIdentifiersMock = jest.fn();
const recordTimelineEventMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const revokeAllUserTokensMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock,
  $transaction: transactionMock,
};
const __prismaTxMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => transactionMock(fn),
  setTenant: async (_tenantId, fn) => fn(__prismaTxMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaTxMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  reassignIdentifiersForMerge: reassignIdentifiersMock,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordTimelineEvent: recordTimelineEventMock,
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  revokeAllUserTokens: revokeAllUserTokensMock,
}));

const {
  approveMerge,
  cancelMerge,
  executeMerge,
  getMergeRequest,
  listMergeRequests,
  rejectMerge,
  requestMerge,
  __testing__,
} = await import('../../services/patient/patientMergeService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PRIMARY = '11111111-1111-4111-8111-111111111111';
const SECONDARY = '22222222-2222-4222-8222-222222222222';
const REQUESTER = '33333333-3333-4333-8333-333333333333';
const APPROVER = '44444444-4444-4444-8444-444444444444';
const EXECUTOR = '55555555-5555-4555-8555-555555555555';

function livePatientRows({ primaryMerged = null, secondaryMerged = null } = {}) {
  return [
    {
      id: 101, uid: PRIMARY, role: 'PATIENT', is_active: true, status: 'active',
      merged_into_uid: primaryMerged, is_deleted: false,
    },
    {
      id: 202, uid: SECONDARY, role: 'PATIENT', is_active: true, status: 'active',
      merged_into_uid: secondaryMerged, is_deleted: false,
    },
  ];
}

const SWEEP_TARGETS = [
  { table_name: 'admissions', column_name: 'patient_uid', is_uuid: true, has_tenant_id: true, append_only: false },
  { table_name: 'investigations', column_name: 'patient_id', is_uuid: false, has_tenant_id: true, append_only: false },
  { table_name: 'investigations', column_name: 'patient_uid', is_uuid: true, has_tenant_id: true, append_only: false },
  { table_name: 'clinical_timeline_events', column_name: 'patient_uid', is_uuid: true, has_tenant_id: true, append_only: true },
  { table_name: 'medical_records', column_name: 'patient_uid', is_uuid: true, has_tenant_id: false, append_only: false },
];

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
  transactionMock.mockReset();
  reassignIdentifiersMock.mockReset();
  recordTimelineEventMock.mockReset();
  recordClinicalAuditEventMock.mockReset();
  revokeAllUserTokensMock.mockReset();
  transactionMock.mockImplementation(async (cb) => cb(__prismaTxMock));
  executeUnsafeMock.mockResolvedValue(1);
  recordTimelineEventMock.mockResolvedValue({ id: 'tl-1' });
  recordClinicalAuditEventMock.mockResolvedValue({ id: 'audit-1' });
  revokeAllUserTokensMock.mockResolvedValue({});
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

// ---------------------------------------------------------------------------
// requestMerge
// ---------------------------------------------------------------------------
describe('requestMerge', () => {
  it('rejects same primary + secondary', async () => {
    await expect(
      requestMerge({ tenantId: TENANT, primaryUid: PRIMARY, secondaryUid: PRIMARY }),
    ).rejects.toThrow(/must differ/);
  });

  it('rejects missing UIDs', async () => {
    await expect(requestMerge({ tenantId: TENANT })).rejects.toThrow(/required/);
  });

  it('rejects when either patient does not exist in the tenant', async () => {
    mockNext([livePatientRows()[0]]); // only the primary comes back
    await expect(requestMerge({
      tenantId: TENANT, primaryUid: PRIMARY, secondaryUid: SECONDARY, requestedBy: REQUESTER,
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a non-PATIENT target', async () => {
    const rows = livePatientRows();
    rows[1].role = 'NURSE';
    mockNext(rows);
    await expect(requestMerge({
      tenantId: TENANT, primaryUid: PRIMARY, secondaryUid: SECONDARY, requestedBy: REQUESTER,
    })).rejects.toThrow(/must reference a PATIENT/);
  });

  it('rejects a secondary that was already merged away', async () => {
    mockNext(livePatientRows({ secondaryMerged: PRIMARY }));
    await expect(requestMerge({
      tenantId: TENANT, primaryUid: PRIMARY, secondaryUid: SECONDARY, requestedBy: REQUESTER,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('inserts with status=requested + records the requester', async () => {
    mockNext(livePatientRows());
    mockNext([{ id: 1, status: 'requested', primary_uid: PRIMARY, secondary_uid: SECONDARY, requested_by: REQUESTER }]);
    const row = await requestMerge({
      tenantId: TENANT,
      primaryUid: PRIMARY,
      secondaryUid: SECONDARY,
      requestedBy: REQUESTER,
      requesterNote: 'Same MRN + ABHA',
      candidateId: 7,
    });
    expect(row.id).toBe(1);
    const args = queryUnsafeMock.mock.calls[1];
    expect(args[0]).toMatch(/INSERT INTO patient_merge_requests/);
    // tenant, candidate_id, primary, secondary, requestedBy, note, metadata
    expect(args.slice(1, 6)).toEqual([TENANT, 7, PRIMARY, SECONDARY, REQUESTER]);
    expect(args[6]).toBe('Same MRN + ABHA');
  });
});

// ---------------------------------------------------------------------------
// approveMerge — two-person rule
// ---------------------------------------------------------------------------
describe('approveMerge', () => {
  it('throws 404 when merge request missing', async () => {
    mockNext([]);
    await expect(approveMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws when the request is not in requested status', async () => {
    mockNext([{ id: 1, status: 'approved', requested_by: REQUESTER }]);
    await expect(approveMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER })).rejects.toThrow(/must be in 'requested'/);
  });

  it('forbids the requester from approving their own merge', async () => {
    mockNext([{ id: 1, status: 'requested', requested_by: REQUESTER }]);
    await expect(
      approveMerge({ tenantId: TENANT, id: 1, approverUid: REQUESTER }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('approves when a different user approves', async () => {
    mockNext([{ id: 1, status: 'requested', requested_by: REQUESTER }]);
    mockNext([{ id: 1, status: 'approved', approver_uid: APPROVER }]);
    const row = await approveMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER, approverNote: 'OK' });
    expect(row.status).toBe('approved');
  });

  it('rejects empty approver_uid', async () => {
    await expect(approveMerge({ tenantId: TENANT, id: 1 })).rejects.toThrow(/approver_uid/);
  });
});

// ---------------------------------------------------------------------------
// rejectMerge / cancelMerge
// ---------------------------------------------------------------------------
describe('rejectMerge', () => {
  it('throws 404 when no requested row matches', async () => {
    mockNext([]);
    await expect(rejectMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips status to rejected with reason', async () => {
    mockNext([{ id: 1, status: 'rejected', rejection_reason: 'Not the same patient' }]);
    const row = await rejectMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER, rejectionReason: 'Not the same patient' });
    expect(row.status).toBe('rejected');
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[0]).toMatch(/SET status = 'rejected'/);
    expect(args.slice(1, 4)).toEqual([APPROVER, 'Not the same patient', 1]);
  });
});

describe('cancelMerge', () => {
  it('throws 404 when not requested or approved', async () => {
    mockNext([]);
    await expect(cancelMerge({ tenantId: TENANT, id: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips status to cancelled and updates metadata', async () => {
    mockNext([{ id: 1, status: 'cancelled' }]);
    const row = await cancelMerge({ tenantId: TENANT, id: 1, cancelledBy: REQUESTER, reason: 'Re-checking with billing' });
    expect(row.status).toBe('cancelled');
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET status = 'cancelled'/);
  });
});

// ---------------------------------------------------------------------------
// executeMerge
// ---------------------------------------------------------------------------
describe('executeMerge', () => {
  function mockHappyPathUntilSweep({ candidateId = 5 } = {}) {
    // 1. SELECT merge request FOR UPDATE
    mockNext([{
      id: 9, status: 'approved', candidate_id: candidateId,
      primary_uid: PRIMARY, secondary_uid: SECONDARY, approver_uid: APPROVER,
    }]);
    // 2. loadMergePatients FOR UPDATE
    mockNext(livePatientRows());
    // 3. reassignIdentifiers
    reassignIdentifiersMock.mockResolvedValueOnce({
      reassigned: [
        { id: 21, identifier_type: 'mrn', identifier_value: 'VH-1' },
        { id: 22, identifier_type: 'mobile', identifier_value: '+91' },
      ],
      count: 2,
    });
    // 4. catalog discovery
    mockNext(SWEEP_TARGETS);
  }

  it('rejects empty executor_uid', async () => {
    await expect(executeMerge({ tenantId: TENANT, id: 1 })).rejects.toThrow(/executor_uid/);
  });

  it('throws when merge request is not approved', async () => {
    mockNext([{ id: 1, status: 'requested', primary_uid: PRIMARY, secondary_uid: SECONDARY }]);
    await expect(executeMerge({ tenantId: TENANT, id: 1, executorUid: EXECUTOR })).rejects.toThrow(/must be in 'approved'/);
  });

  it('throws 404 when merge request missing', async () => {
    mockNext([]);
    await expect(executeMerge({ tenantId: TENANT, id: 1, executorUid: EXECUTOR })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses to execute against an already-merged secondary', async () => {
    mockNext([{
      id: 9, status: 'approved', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY, approver_uid: APPROVER,
    }]);
    mockNext(livePatientRows({ secondaryMerged: PRIMARY }));
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR })).rejects.toMatchObject({ statusCode: 409 });
    expect(reassignIdentifiersMock).not.toHaveBeenCalled();
  });

  it('sweeps discovered columns, deactivates the secondary, emits canonical events, marks executed', async () => {
    mockHappyPathUntilSweep();
    // final UPDATE merge request → executed
    mockNext([{
      id: 9, status: 'executed', candidate_id: 5,
      primary_uid: PRIMARY, secondary_uid: SECONDARY,
      executor_uid: EXECUTOR, execution_summary: {},
    }]);
    // UPDATE candidate row
    mockNext([]);

    const row = await executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR });
    expect(row.status).toBe('executed');
    expect(reassignIdentifiersMock).toHaveBeenCalledWith(
      expect.any(Object),
      { tenantId: TENANT, primaryUid: PRIMARY, secondaryUid: SECONDARY, mergeRequestId: 9 },
    );

    const executeSqls = executeUnsafeMock.mock.calls.map((call) => call[0]);
    // Constraints deferred before the sweep so composite patient_uid FKs
    // check at COMMIT.
    expect(executeSqls[0]).toMatch(/SET CONSTRAINTS ALL DEFERRED/);
    // uuid sweep carries a tenant predicate + uuid params.
    const admissionsCall = executeUnsafeMock.mock.calls.find((call) => /UPDATE admissions/.test(call[0]));
    expect(admissionsCall[0]).toMatch(/tenant_id = \$3::uuid/);
    expect(admissionsCall.slice(1)).toEqual([PRIMARY, SECONDARY, TENANT]);
    // investigations swept on BOTH columns readers actually query.
    const investigationsIntCall = executeUnsafeMock.mock.calls.find(
      (call) => /UPDATE investigations/.test(call[0]) && /patient_id = \$2::int/.test(call[0]),
    );
    expect(investigationsIntCall.slice(1)).toEqual([101, 202, TENANT]);
    const investigationsUuidCall = executeUnsafeMock.mock.calls.find(
      (call) => /UPDATE investigations/.test(call[0]) && /patient_uid = \$2::uuid/.test(call[0]),
    );
    expect(investigationsUuidCall.slice(1)).toEqual([PRIMARY, SECONDARY, TENANT]);
    // A table without tenant_id sweeps without the tenant predicate.
    const medicalRecordsCall = executeUnsafeMock.mock.calls.find((call) => /UPDATE medical_records/.test(call[0]));
    expect(medicalRecordsCall[0]).not.toMatch(/tenant_id/);
    // Append-only tables are never UPDATEd.
    expect(executeSqls.some((sql) => /UPDATE clinical_timeline_events/.test(sql))).toBe(false);
    // Secondary deactivated in the same transaction.
    const deactivateCall = executeUnsafeMock.mock.calls.find((call) => /UPDATE users/.test(call[0]));
    expect(deactivateCall[0]).toMatch(/is_active = false/);
    expect(deactivateCall[0]).toMatch(/status = 'merged'/);
    expect(deactivateCall[0]).toMatch(/merged_into_uid = \$3::uuid/);
    // Canonical pair emitted inside the tx with insert-once keys.
    expect(recordTimelineEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patientUid: PRIMARY,
        eventType: 'patient.merge.executed',
        idempotencyKey: 'patient_merge_requests:9:executed',
      }),
      { db: expect.any(Object) },
    );
    expect(recordClinicalAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'patient.merge.executed',
        idempotencyKey: 'patient_merge_requests:9:executed',
      }),
      { db: expect.any(Object) },
    );
    // Post-commit best-effort token revocation for the merged-away record.
    expect(revokeAllUserTokensMock).toHaveBeenCalledWith(SECONDARY);
  });

  it('fails the merge when the canonical timeline emit does not persist', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    recordTimelineEventMock.mockResolvedValueOnce(null);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ code: 'PATIENT_MERGE_TIMELINE_REQUIRED' });
    expect(revokeAllUserTokensMock).not.toHaveBeenCalled();
  });

  it('fails the merge when the canonical audit emit does not persist', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    recordClinicalAuditEventMock.mockResolvedValueOnce(null);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ code: 'PATIENT_MERGE_AUDIT_REQUIRED' });
  });

  it('translates data conflicts (unique/FK violations) into a 409', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    executeUnsafeMock.mockReset();
    executeUnsafeMock.mockResolvedValueOnce(1); // SET CONSTRAINTS
    executeUnsafeMock.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "abha_profiles_tenant_id_patient_uid_key"'),
    );
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_DATA_CONFLICT' });
    expect(revokeAllUserTokensMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listMergeRequests / getMergeRequest
// ---------------------------------------------------------------------------
describe('listMergeRequests', () => {
  it('rejects unknown status', async () => {
    await expect(listMergeRequests({ tenantId: TENANT, status: 'weird' })).rejects.toThrow(/status must be one of/);
  });
  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_merge_requests" does not exist'));
    expect(await listMergeRequests({ tenantId: TENANT })).toEqual({ merge_requests: [], count: 0 });
  });
});

describe('getMergeRequest', () => {
  it('throws 404 when missing', async () => {
    mockNext([]);
    await expect(getMergeRequest({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Sweep exclusions sanity
// ---------------------------------------------------------------------------
describe('merge sweep exclusions', () => {
  it('never sweeps identity/bookkeeping tables or continuity prefixes', () => {
    expect([...__testing__.MERGE_SWEEP_EXCLUDED_TABLES]).toEqual(expect.arrayContaining([
      'users', 'patient_identifiers', 'patient_merge_requests', 'patient_duplicate_candidates',
    ]));
    expect(__testing__.MERGE_SWEEP_EXCLUDED_PREFIXES).toEqual(['clinical_continuity_']);
  });
});
