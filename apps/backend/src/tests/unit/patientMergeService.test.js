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
import { readFileSync } from 'node:fs';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const setTenantTxMock = jest.fn();
const reassignIdentifiersMock = jest.fn();
const recordTimelineEventMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const lockTenantPatientMergeExecutionExclusiveMock = jest.fn();
const persistRevokeAllUserTokensMock = jest.fn();
const publishRevokeAllUserTokensMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();

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
  setTenantTx: setTenantTxMock,
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
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isSubjectDelegationRevoked: jest.fn().mockResolvedValue(false),
  persistRevokeAllUserTokens: persistRevokeAllUserTokensMock,
  publishRevokeAllUserTokens: publishRevokeAllUserTokensMock,
}));
jest.unstable_mockModule('../../utils/patientMergeStabilityLock.js', () => ({
  lockTenantPatientMergeExecutionExclusive: lockTenantPatientMergeExecutionExclusiveMock,
  PATIENT_MERGE_STABILITY_TIMEOUT_MS: 300_000,
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

// Raw catalog rows as discoverMergeSweepTargets now reads them: each carries
// its UPDATE triggers and the service classifies blocking functions itself.
const APPEND_ONLY_GUARD_SRC = `
BEGIN
  IF current_setting('app.audit_bypass', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'append-only';
END;`;
const TOUCH_TRIGGER_SRC = `
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;`;
const SWEEP_TARGETS = [
  { table_name: 'admissions', column_name: 'patient_uid', is_uuid: true, has_tenant_id: true, can_update: true, update_triggers: [] },
  { table_name: 'investigations', column_name: 'patient_id', is_uuid: false, has_tenant_id: true, can_update: true, update_triggers: [] },
  { table_name: 'investigations', column_name: 'patient_uid', is_uuid: true, has_tenant_id: true, can_update: true, update_triggers: [] },
  {
    table_name: 'pharmacy_patient_safety_versions', column_name: 'patient_id',
    is_uuid: false, has_tenant_id: true, can_update: true, update_triggers: [],
  },
  {
    table_name: 'clinical_timeline_events', column_name: 'patient_uid', is_uuid: true, has_tenant_id: true, can_update: true,
    update_triggers: [{ proname: 'audit_append_only_guard', prosrc: APPEND_ONLY_GUARD_SRC }],
  },
  {
    table_name: 'medical_records', column_name: 'patient_uid', is_uuid: true, has_tenant_id: false, can_update: true,
    update_triggers: [{ proname: 'touch_updated_at', prosrc: TOUCH_TRIGGER_SRC }],
  },
];
const NO_ACTIVE_ADMISSIONS = [{ primary_active: false, secondary_active: false }];

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset();
  transactionMock.mockReset();
  setTenantTxMock.mockReset();
  reassignIdentifiersMock.mockReset();
  recordTimelineEventMock.mockReset();
  recordClinicalAuditEventMock.mockReset();
  lockTenantPatientMergeExecutionExclusiveMock.mockReset();
  persistRevokeAllUserTokensMock.mockReset();
  publishRevokeAllUserTokensMock.mockReset();
  loggerWarnMock.mockReset();
  loggerErrorMock.mockReset();
  transactionMock.mockImplementation(async (cb) => cb(__prismaTxMock));
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => transactionMock(fn));
  executeUnsafeMock.mockResolvedValue(1);
  recordTimelineEventMock.mockResolvedValue({ id: 'tl-1' });
  recordClinicalAuditEventMock.mockResolvedValue({ id: 'audit-1' });
  persistRevokeAllUserTokensMock.mockResolvedValue(1_775_000_000);
  publishRevokeAllUserTokensMock.mockResolvedValue({ database: { persisted: true } });
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

  it('refuses to approve an unattributed request (NULL requested_by would void the two-person rule)', async () => {
    mockNext([{ id: 1, status: 'requested', requested_by: null }]);
    await expect(
      approveMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_REQUESTER_UNATTRIBUTED' });
    // No UPDATE was issued.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a continuity-sourced row: approval belongs to the treating-doctor-gated flow', async () => {
    mockNext([{
      id: 1, status: 'requested', requested_by: REQUESTER, continuity_disposition: 'proposed',
    }]);
    await expect(
      approveMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_CONTINUITY_WORKFLOW_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
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
    mockNext([]); // pre-select: row absent
    mockNext([]); // UPDATE matches nothing
    await expect(rejectMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips status to rejected with reason', async () => {
    mockNext([{ id: 1, status: 'requested', continuity_disposition: null }]);
    mockNext([{ id: 1, status: 'rejected', rejection_reason: 'Not the same patient' }]);
    const row = await rejectMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER, rejectionReason: 'Not the same patient' });
    expect(row.status).toBe('rejected');
    const args = queryUnsafeMock.mock.calls[1];
    expect(args[0]).toMatch(/SET status = 'rejected'/);
    expect(args.slice(1, 4)).toEqual([APPROVER, 'Not the same patient', 1]);
  });

  it('refuses a continuity-sourced row without touching it', async () => {
    mockNext([{ id: 1, status: 'requested', continuity_disposition: 'proposed' }]);
    await expect(rejectMerge({ tenantId: TENANT, id: 1, approverUid: APPROVER }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_CONTINUITY_WORKFLOW_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('cancelMerge', () => {
  it('throws 404 when not requested or approved', async () => {
    mockNext([]); // pre-select: row absent
    mockNext([]); // UPDATE matches nothing
    await expect(cancelMerge({ tenantId: TENANT, id: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips status to cancelled and updates metadata', async () => {
    mockNext([{ id: 1, status: 'requested', continuity_disposition: null }]);
    mockNext([{ id: 1, status: 'cancelled' }]);
    const row = await cancelMerge({ tenantId: TENANT, id: 1, cancelledBy: REQUESTER, reason: 'Re-checking with billing' });
    expect(row.status).toBe('cancelled');
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/SET status = 'cancelled'/);
  });

  it('refuses a continuity-sourced row without touching it', async () => {
    mockNext([{ id: 1, status: 'requested', continuity_disposition: 'proposed' }]);
    await expect(cancelMerge({ tenantId: TENANT, id: 1, cancelledBy: REQUESTER }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_CONTINUITY_WORKFLOW_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
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
    // 3. both-active-admissions guard
    mockNext(NO_ACTIVE_ADMISSIONS);
    // 4. catalog discovery + protected-history pre-flight
    mockNext(SWEEP_TARGETS);
    mockNext([{ uid: SECONDARY }]);
    mockNext([{ id: '202' }]);
    // 5. reassignIdentifiers
    reassignIdentifiersMock.mockResolvedValueOnce({
      reassigned: [
        { id: 21, identifier_type: 'mrn', identifier_value: 'VH-1' },
        { id: 22, identifier_type: 'mobile', identifier_value: '+91' },
      ],
      count: 2,
    });
  }

  function mockSafetyClockFold(version = '42') {
    mockNext([{ patient_id: '101', version }]);
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

  it('refuses a continuity-sourced row before anything mutates', async () => {
    mockNext([{
      id: 9, status: 'approved', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: null, approver_uid: APPROVER,
      continuity_disposition: 'approved',
    }]);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_CONTINUITY_WORKFLOW_REQUIRED' });
    expect(reassignIdentifiersMock).not.toHaveBeenCalled();
    expect(executeUnsafeMock).not.toHaveBeenCalled();
    expect(persistRevokeAllUserTokensMock).not.toHaveBeenCalled();
    expect(publishRevokeAllUserTokensMock).not.toHaveBeenCalled();
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

  it('refuses to execute when either patient record is inactive', async () => {
    mockNext([{
      id: 9, status: 'approved', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY, approver_uid: APPROVER,
    }]);
    const rows = livePatientRows();
    rows[1].is_active = false;
    mockNext(rows);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_TARGET_INACTIVE' });
    expect(reassignIdentifiersMock).not.toHaveBeenCalled();
  });

  it('rejects a merge of two simultaneously-admitted patients before anything mutates', async () => {
    mockNext([{
      id: 9, status: 'approved', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY, approver_uid: APPROVER,
    }]);
    mockNext(livePatientRows());
    mockNext([{ primary_active: true, secondary_active: true }]);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_BOTH_ACTIVE_ADMISSIONS' });
    // Nothing mutated: no identifier retarget, no sweep, no deactivation.
    expect(reassignIdentifiersMock).not.toHaveBeenCalled();
    expect(executeUnsafeMock).not.toHaveBeenCalled();
    expect(persistRevokeAllUserTokensMock).not.toHaveBeenCalled();
    expect(publishRevokeAllUserTokensMock).not.toHaveBeenCalled();
  });

  it('allows the merge when only one side holds an active admission', async () => {
    mockNext([{
      id: 9, status: 'approved', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY, approver_uid: APPROVER,
    }]);
    mockNext(livePatientRows());
    mockNext([{ primary_active: false, secondary_active: true }]);
    reassignIdentifiersMock.mockResolvedValueOnce({ reassigned: [], count: 0 });
    mockNext(SWEEP_TARGETS);
    mockNext([{ uid: SECONDARY }]);
    mockNext([{ id: '202' }]);
    mockSafetyClockFold();
    mockNext([{
      id: 9, status: 'executed', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY,
      executor_uid: EXECUTOR, execution_summary: {},
    }]);
    const row = await executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR });
    expect(row.status).toBe('executed');
  });

  it('sweeps discovered columns, deactivates the secondary, emits canonical events, marks executed', async () => {
    mockHappyPathUntilSweep();
    mockSafetyClockFold('57');
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
    expect(lockTenantPatientMergeExecutionExclusiveMock)
      .toHaveBeenCalledWith(__prismaTxMock, TENANT);
    expect(lockTenantPatientMergeExecutionExclusiveMock.mock.invocationCallOrder[0])
      .toBeLessThan(queryUnsafeMock.mock.invocationCallOrder[0]);
    expect(setTenantTxMock).toHaveBeenCalledWith(
      TENANT,
      expect.any(Function),
      { timeout: 300_000 },
    );

    const executeSqls = executeUnsafeMock.mock.calls.map((call) => call[0]);
    expect(executeSqls[0]).toMatch(/set_config\('app\.patient_merge_execution', 'on', true\)/);
    // Constraints deferred before the sweep so composite patient_uid FKs
    // check at COMMIT.
    expect(executeSqls).toContainEqual(expect.stringMatching(/SET CONSTRAINTS ALL DEFERRED/));
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
    // Trigger-blocked tables are never UPDATEd.
    expect(executeSqls.some((sql) => /UPDATE clinical_timeline_events/.test(sql))).toBe(false);
    // A table whose only UPDATE trigger cannot raise is still swept.
    expect(executeSqls.some((sql) => /UPDATE medical_records/.test(sql))).toBe(true);
    // Secondary deactivated in the same transaction.
    const deactivateCall = executeUnsafeMock.mock.calls.find(
      (call) => /UPDATE users/.test(call[0]) && /is_active = false/.test(call[0]),
    );
    expect(deactivateCall[0]).toMatch(/is_active = false/);
    expect(deactivateCall[0]).toMatch(/status = 'merged'/);
    expect(deactivateCall[0]).toMatch(/merged_into_uid = \$3::uuid/);
    // Chained merges: stored survivor pointers that named the secondary are
    // re-pointed at the final survivor, tenant-scoped, provenance intact.
    const chainUsersIndex = executeUnsafeMock.mock.calls.findIndex(
      (call) => /UPDATE users/.test(call[0]) && /WHERE tenant_id = \$2::uuid AND merged_into_uid = \$3::uuid/.test(call[0]),
    );
    const chainUsersCall = executeUnsafeMock.mock.calls[chainUsersIndex];
    expect(chainUsersCall.slice(1)).toEqual([PRIMARY, TENANT, SECONDARY]);
    expect(chainUsersCall[0]).not.toMatch(/merged_at/);
    const chainIdentifiersCall = executeUnsafeMock.mock.calls.find(
      (call) => /UPDATE patient_identifiers/.test(call[0]) && /merged_into_uid = \$3::uuid/.test(call[0]),
    );
    expect(chainIdentifiersCall.slice(1)).toEqual([PRIMARY, TENANT, SECONDARY]);
    expect(chainIdentifiersCall[0]).toMatch(/status = 'merged_into'/);
    expect(chainIdentifiersCall[0]).not.toMatch(/SET[\s\S]*patient_uid/);
    // Logical clocks are not swept. The helper locks the survivor plus every
    // merged-away predecessor and advances only the survivor via BIGINT SQL.
    const safetyFoldIndex = queryUnsafeMock.mock.calls.findIndex(
      (call) => /WITH involved_patient_ids AS MATERIALIZED/.test(call[0]),
    );
    const safetyFoldCall = queryUnsafeMock.mock.calls[safetyFoldIndex];
    expect(safetyFoldCall.slice(1)).toEqual([TENANT, [101, 202], 101]);
    expect(safetyFoldCall[0]).toMatch(/FOR UPDATE OF safety/);
    expect(safetyFoldCall[0]).toMatch(/COALESCE\(MAX\(locked\.version\), 1::bigint\)/);
    expect(safetyFoldCall[0]).toMatch(/ON CONFLICT \(tenant_id, patient_id\) DO UPDATE/);
    expect(safetyFoldCall[0]).not.toMatch(/DELETE FROM pharmacy_patient_safety_versions/);
    expect(safetyFoldCall[0]).not.toMatch(/clinical_verification_safety_version/);
    expect(safetyFoldCall[0]).not.toMatch(/session_replication_role/);
    expect(executeSqls.some(
      (sql) => /UPDATE pharmacy_patient_safety_versions\s+SET patient_id/.test(sql),
    )).toBe(false);
    expect(executeUnsafeMock.mock.invocationCallOrder[chainUsersIndex])
      .toBeLessThan(queryUnsafeMock.mock.invocationCallOrder[safetyFoldIndex]);
    expect(queryUnsafeMock.mock.invocationCallOrder[safetyFoldIndex])
      .toBeLessThan(recordTimelineEventMock.mock.invocationCallOrder[0]);
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
        afterState: expect.objectContaining({ patient_safety_version: '57' }),
      }),
      { db: expect.any(Object) },
    );
    // Durable revocation belongs to the merge transaction and only the
    // cache/WebSocket publication may run after commit.
    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledWith(SECONDARY, {
      client: __prismaTxMock,
      requireEvidence: true,
      reason: 'patient_merged',
    });
    expect(publishRevokeAllUserTokensMock).toHaveBeenCalledWith(
      SECONDARY,
      1_775_000_000,
      { reason: 'patient_merged' },
    );
    expect(persistRevokeAllUserTokensMock).not.toHaveBeenCalledWith(
      PRIMARY,
      expect.anything(),
    );
  });

  it('rolls back the merge when the durable secondary-token revocation cannot persist', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    persistRevokeAllUserTokensMock.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toThrow('durable store unavailable');

    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledWith(SECONDARY, {
      client: __prismaTxMock,
      requireEvidence: true,
      reason: 'patient_merged',
    });
    expect(publishRevokeAllUserTokensMock).not.toHaveBeenCalled();
  });

  it('keeps the committed merge successful and reports a post-commit publication failure', async () => {
    let committed = false;
    transactionMock.mockImplementationOnce(async (cb) => {
      const result = await cb(__prismaTxMock);
      committed = true;
      return result;
    });
    mockHappyPathUntilSweep({ candidateId: null });
    mockSafetyClockFold();
    mockNext([{
      id: 9, status: 'executed', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY,
      executor_uid: EXECUTOR, execution_summary: {},
    }]);
    publishRevokeAllUserTokensMock.mockImplementationOnce(async () => {
      expect(committed).toBe(true);
      throw new Error('websocket unavailable');
    });

    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .resolves.toMatchObject({ status: 'executed' });

    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
    expect(publishRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'patient merge token revocation publication failed',
      expect.objectContaining({
        mergeRequestId: 9,
        tenantId: TENANT,
        secondaryUid: SECONDARY,
        error: 'websocket unavailable',
      }),
    );
  });

  it('retries exactly after a durable-revocation rollback and never revokes the survivor', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    persistRevokeAllUserTokensMock.mockRejectedValueOnce(new Error('durable store unavailable'));

    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toThrow('durable store unavailable');

    mockHappyPathUntilSweep({ candidateId: null });
    mockSafetyClockFold();
    mockNext([{
      id: 9, status: 'executed', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY,
      executor_uid: EXECUTOR, execution_summary: {},
    }]);

    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .resolves.toMatchObject({ status: 'executed' });

    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledTimes(2);
    expect(persistRevokeAllUserTokensMock.mock.calls.map(([uid]) => uid))
      .toEqual([SECONDARY, SECONDARY]);
    expect(publishRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
  });

  it('fails the merge when the canonical timeline emit does not persist', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    mockSafetyClockFold();
    recordTimelineEventMock.mockResolvedValueOnce(null);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ code: 'PATIENT_MERGE_TIMELINE_REQUIRED' });
    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
    expect(publishRevokeAllUserTokensMock).not.toHaveBeenCalled();
  });

  it('fails the merge when the canonical audit emit does not persist', async () => {
    mockHappyPathUntilSweep({ candidateId: null });
    mockSafetyClockFold();
    recordClinicalAuditEventMock.mockResolvedValueOnce(null);
    await expect(executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ code: 'PATIENT_MERGE_AUDIT_REQUIRED' });
    expect(persistRevokeAllUserTokensMock).toHaveBeenCalledTimes(1);
    expect(publishRevokeAllUserTokensMock).not.toHaveBeenCalled();
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
    expect(persistRevokeAllUserTokensMock).not.toHaveBeenCalled();
    expect(publishRevokeAllUserTokensMock).not.toHaveBeenCalled();
  });
});

describe('foldPatientSafetyVersionForMerge', () => {
  it('deduplicates the resolved chain and returns exactly the survivor fold row', async () => {
    mockNext([{ patient_id: '101', version: '9007199254740995' }]);

    await expect(__testing__.foldPatientSafetyVersionForMerge(__prismaTxMock, {
      tenantId: TENANT,
      survivorPatientId: 101,
      mergedAwayPatientIds: [303, 202, 303],
    })).resolves.toEqual({ patient_id: '101', version: '9007199254740995' });

    const call = queryUnsafeMock.mock.calls[0];
    expect(call.slice(1)).toEqual([TENANT, [101, 202, 303], 101]);
    expect(call[0]).toMatch(/1::bigint/);
    expect(call[0]).toMatch(/EXCLUDED\.version - 1::bigint/);
    expect(call[0]).not.toMatch(/SET\s+patient_id\s*=/);
  });

  it('fails closed unless the upsert returns exactly one valid survivor row', async () => {
    mockNext([]);
    await expect(__testing__.foldPatientSafetyVersionForMerge(__prismaTxMock, {
      tenantId: TENANT,
      survivorPatientId: 101,
      mergedAwayPatientIds: [202],
    })).rejects.toMatchObject({ code: 'PATIENT_MERGE_SAFETY_CLOCK_REQUIRED' });

    mockNext([
      { patient_id: '101', version: '8' },
      { patient_id: '101', version: '9' },
    ]);
    await expect(__testing__.foldPatientSafetyVersionForMerge(__prismaTxMock, {
      tenantId: TENANT,
      survivorPatientId: 101,
      mergedAwayPatientIds: [202],
    })).rejects.toMatchObject({ code: 'PATIENT_MERGE_SAFETY_CLOCK_REQUIRED' });

    mockNext([{ patient_id: '202', version: '8' }]);
    await expect(__testing__.foldPatientSafetyVersionForMerge(__prismaTxMock, {
      tenantId: TENANT,
      survivorPatientId: 101,
      mergedAwayPatientIds: [202],
    })).rejects.toMatchObject({ code: 'PATIENT_MERGE_SAFETY_CLOCK_REQUIRED' });
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
      'pharmacy_patient_safety_versions',
    ]));
    expect(__testing__.MERGE_SWEEP_EXCLUDED_PREFIXES).toEqual(['clinical_continuity_']);
  });

  it('certifies the advance tables only alongside their merge-aware readers', () => {
    // Financial-lineage immutability means these rows stay on the pre-merge uid,
    // which is only safe while every patient-scoped read unions the merged
    // family. The set and the readers move together — adding a table here
    // without its reader is the failure this pins.
    const covered = [...__testing__.MERGE_READ_UNION_COVERED_TABLES];
    expect(covered).toContain('billing_advances');
    expect(covered).toContain('advance_deposits');
    const billing = readFileSync(
      new URL('../../services/billing/billingV2Service.js', import.meta.url), 'utf8',
    );
    expect(billing).toContain('mergedPatientUidsSubquery');
  });

  it('certifies ICU code-status history through its admission-derived read path', () => {
    expect([...__testing__.MERGE_ADMISSION_DERIVED_PROTECTED_TABLES]).toEqual([
      'icu_code_status_history',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Update-blocking trigger classification (validated against the live schema
// by patient-merge-execution.deep.test.js; these pin the predicate's shape)
// ---------------------------------------------------------------------------
describe('isUpdateBlockingTriggerSource', () => {
  const classify = __testing__.isUpdateBlockingTriggerSource;

  it('classifies an unconditional raise as blocking', () => {
    expect(classify(`
      BEGIN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'append-only';
      END;`)).toBe(true);
  });

  it('classifies a raise behind bypass-escape returns as blocking (audit_append_only_guard shape)', () => {
    expect(classify(`
      BEGIN
        IF current_setting('app.audit_bypass', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        IF COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        RAISE EXCEPTION 'audit table is append-only';
      END;`)).toBe(true);
  });

  it('classifies a GUC-engaged raise as safe (assert_external_recovery_effect_allowed shape)', () => {
    expect(classify(`
      BEGIN
        IF current_setting('app.external_recovery_effect_disposition', true) = 'late_pending_only' THEN
          RAISE EXCEPTION 'late external recovery cannot mutate';
        END IF;
        RETURN NEW;
      END;`)).toBe(false);
  });

  it('classifies a row-content-conditioned validator as safe', () => {
    expect(classify(`
      BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'sent' THEN
          RAISE EXCEPTION 'invalid transition';
        END IF;
        RETURN NEW;
      END;`)).toBe(false);
  });

  it('classifies any OLD.patient_uid / OLD.patient_id reference as blocking (identity pin)', () => {
    expect(classify(`
      BEGIN
        IF OLD.patient_uid IS DISTINCT FROM NEW.patient_uid THEN
          RAISE EXCEPTION 'identity is immutable';
        END IF;
        RETURN NEW;
      END;`)).toBe(true);
    expect(classify(`
      BEGIN
        IF OLD.patient_id IS DISTINCT FROM NEW.patient_id THEN
          RAISE EXCEPTION 'identity is immutable';
        END IF;
        RETURN NEW;
      END;`)).toBe(true);
  });

  it('accepts the migration 760 governed clinical-import history guard', () => {
    const migration = readFileSync(
      new URL('../../migrations/760_clinical_import_authority_custody_and_reconciliation.sql', import.meta.url),
      'utf8',
    );
    const functionBody = migration.match(
      /CREATE OR REPLACE FUNCTION clinical_import_history_immutable_755\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    )?.[1];
    expect(functionBody).toBeDefined();
    expect(classify(functionBody)).toBe(false);
  });

  it('treats TG_OP-only conditions as potentially firing for UPDATE (conservative)', () => {
    expect(classify(`
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION 'no updates';
        END IF;
        RETURN NEW;
      END;`)).toBe(true);
  });

  it('classifies raise-free triggers (updated_at touch) as safe', () => {
    expect(classify(`
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;`)).toBe(false);
  });

  it('ignores comments when hunting for raises', () => {
    expect(classify(`
      BEGIN
        -- RAISE EXCEPTION 'documented but disabled';
        RETURN NEW;
      END;`)).toBe(false);
  });
});
