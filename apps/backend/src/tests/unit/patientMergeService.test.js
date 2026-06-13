/**
 * Phase A2 PR2 — patientMergeService unit tests.
 *
 * Drives the request → approve → execute happy path plus all the
 * forbidden / not-found / state-machine edges.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const reassignIdentifiersMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $transaction: transactionMock,
};
const __prismaTxMock = { $queryRawUnsafe: queryUnsafeMock };
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

beforeEach(() => {
  queryUnsafeMock.mockReset();
  transactionMock.mockReset();
  reassignIdentifiersMock.mockReset();
  transactionMock.mockImplementation(async (cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
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

  it('inserts with status=requested + records the requester', async () => {
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
    const args = queryUnsafeMock.mock.calls[0];
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
// executeMerge — happy path
// ---------------------------------------------------------------------------
describe('executeMerge', () => {
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

  it('reassigns identifiers + sweeps every FK_TABLE then marks executed', async () => {
    // 1. SELECT existing row
    mockNext([{
      id: 9, status: 'approved', candidate_id: 5,
      primary_uid: PRIMARY, secondary_uid: SECONDARY, approver_uid: APPROVER,
    }]);
    // 2. reassignIdentifiers returns 2 rows
    reassignIdentifiersMock.mockResolvedValueOnce({
      reassigned: [
        { id: 21, identifier_type: 'mrn', identifier_value: 'VH-1' },
        { id: 22, identifier_type: 'mobile', identifier_value: '+91' },
      ],
      count: 2,
    });
    // 3. FK sweep: each table returns N moved rows
    for (let i = 0; i < __testing__.FK_TABLES.length; i += 1) {
      mockNext(Array.from({ length: 1 }, (_, j) => ({ moved: i + j })));
    }
    // 4. UPDATE merge request → executed
    mockNext([{
      id: 9, status: 'executed', candidate_id: 5,
      primary_uid: PRIMARY, secondary_uid: SECONDARY,
      executor_uid: EXECUTOR, execution_summary: { total_rows_moved: 15 },
    }]);
    // 5. UPDATE candidate row
    mockNext([]);

    const row = await executeMerge({ tenantId: TENANT, id: 9, executorUid: EXECUTOR });
    expect(row.status).toBe('executed');
    expect(reassignIdentifiersMock).toHaveBeenCalledWith(
      expect.any(Object),
      { tenantId: TENANT, primaryUid: PRIMARY, secondaryUid: SECONDARY },
    );
    expect(transactionMock).toHaveBeenCalled();
  });

  it('records skipped status for tables that are missing', async () => {
    mockNext([{
      id: 10, status: 'approved', candidate_id: null,
      primary_uid: PRIMARY, secondary_uid: SECONDARY,
    }]);
    reassignIdentifiersMock.mockResolvedValueOnce({ reassigned: [], count: 0 });
    // First FK table errors with relation-missing; subsequent tables return 0 moves.
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "appointments" does not exist'));
    for (let i = 1; i < __testing__.FK_TABLES.length; i += 1) {
      mockNext([]);
    }
    mockNext([{
      id: 10, status: 'executed', primary_uid: PRIMARY, secondary_uid: SECONDARY,
      execution_summary: { table_summary: { appointments: { skipped: 'schema_unavailable' } } },
    }]);

    const row = await executeMerge({ tenantId: TENANT, id: 10, executorUid: EXECUTOR });
    expect(row.status).toBe('executed');
    expect(row.execution_summary.table_summary.appointments.skipped).toBe('schema_unavailable');
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
// FK_TABLES sanity
// ---------------------------------------------------------------------------
describe('FK_TABLES', () => {
  it('lists at least the core patient FK tables', () => {
    const names = __testing__.FK_TABLES.map(([t]) => t);
    expect(names).toEqual(expect.arrayContaining([
      'appointments', 'prescriptions', 'investigations', 'consultations',
      'admissions', 'diagnoses',
    ]));
  });
});
