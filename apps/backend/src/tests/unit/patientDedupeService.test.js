/**
 * Phase A2 PR2 — patientDedupeService unit tests.
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
  confidenceForIdentifierType,
  detectIdentifierCollisions,
  getDuplicateCandidate,
  listDuplicateCandidates,
  markCandidateNotDuplicate,
  __testing__,
} = await import('../../services/patient/patientDedupeService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PRIMARY = '11111111-1111-4111-8111-111111111111';
const SECONDARY = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

// ---------------------------------------------------------------------------
// confidenceForIdentifierType
// ---------------------------------------------------------------------------
describe('confidenceForIdentifierType', () => {
  it('scores government-issued unique identifiers highest', () => {
    expect(confidenceForIdentifierType('abha')).toBe(95);
    expect(confidenceForIdentifierType('aadhaar_token')).toBe(95);
    expect(confidenceForIdentifierType('national_id')).toBe(92);
    expect(confidenceForIdentifierType('passport')).toBe(90);
  });
  it('scores hospital-issued identifiers in the middle', () => {
    expect(confidenceForIdentifierType('mrn')).toBe(88);
    expect(confidenceForIdentifierType('uhid')).toBe(88);
  });
  it('scores reusable identifiers lower', () => {
    expect(confidenceForIdentifierType('mobile')).toBe(70);
    expect(confidenceForIdentifierType('tpa_card')).toBe(75);
  });
  it('falls back to 60 for unknown types', () => {
    expect(confidenceForIdentifierType('totally-made-up')).toBe(60);
  });
  it('is case-insensitive', () => {
    expect(confidenceForIdentifierType('ABHA')).toBe(95);
  });
});

// ---------------------------------------------------------------------------
// detectIdentifierCollisions
// ---------------------------------------------------------------------------
describe('detectIdentifierCollisions', () => {
  it('returns halted on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_identifiers" does not exist'));
    const result = await detectIdentifierCollisions({ tenantId: TENANT });
    expect(result.halted).toBe(true);
    expect(result.reason).toBe('patient_identifiers_unavailable');
  });

  it('returns 0 candidates when no collisions found', async () => {
    mockNext([]);
    const result = await detectIdentifierCollisions({ tenantId: TENANT });
    expect(result.scanned_pairs).toBe(0);
    expect(result.candidates_inserted).toBe(0);
  });

  it('aggregates per-pair signals across multiple matching identifier types', async () => {
    // Two collision rows for the same (primary, secondary) pair: one on
    // ABHA, one on mobile. The detector should produce ONE candidate
    // with the higher confidence (95 from abha) and both signals.
    mockNext([
      { identifier_type: 'abha', identifier_value: 'ABHA-123', primary_uid: PRIMARY, secondary_uid: SECONDARY, hit_count: 1n },
      { identifier_type: 'mobile', identifier_value: '+91999', primary_uid: PRIMARY, secondary_uid: SECONDARY, hit_count: 1n },
    ]);
    // The single upsert call returns the inserted row.
    mockNext([{ id: 7, status: 'open' }]);

    const result = await detectIdentifierCollisions({ tenantId: TENANT });
    expect(result.scanned_pairs).toBe(1);
    expect(result.candidates_inserted).toBe(1);
    expect(result.candidates_skipped).toBe(0);
    const upsertCall = queryUnsafeMock.mock.calls[1];
    expect(upsertCall[0]).toMatch(/INSERT INTO patient_duplicate_candidates/);
    // confidence should be max (95)
    expect(upsertCall[4]).toBe(95);
    // signals payload contains both identifier types
    const signals = JSON.parse(upsertCall[5]);
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ identifier_type: 'abha' }),
      expect.objectContaining({ identifier_type: 'mobile' }),
    ]));
  });

  it('counts candidates skipped when ON CONFLICT WHERE clause excludes the row (status != open)', async () => {
    // One collision found, but the upsert returns no rows because the
    // existing candidate is in status='rejected_not_duplicate'.
    mockNext([
      { identifier_type: 'mrn', identifier_value: 'VH-1', primary_uid: PRIMARY, secondary_uid: SECONDARY, hit_count: 1 },
    ]);
    mockNext([]); // empty RETURNING
    const result = await detectIdentifierCollisions({ tenantId: TENANT });
    expect(result.candidates_inserted).toBe(0);
    expect(result.candidates_skipped).toBe(1);
  });

  it('halts when patient_duplicate_candidates table is missing', async () => {
    mockNext([
      { identifier_type: 'mrn', identifier_value: 'VH-1', primary_uid: PRIMARY, secondary_uid: SECONDARY, hit_count: 1 },
    ]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_duplicate_candidates" does not exist'));
    const result = await detectIdentifierCollisions({ tenantId: TENANT });
    expect(result.halted).toBe(true);
    expect(result.reason).toBe('patient_duplicate_candidates_unavailable');
  });
});

// ---------------------------------------------------------------------------
// listDuplicateCandidates
// ---------------------------------------------------------------------------
describe('listDuplicateCandidates', () => {
  it('rejects unknown status', async () => {
    await expect(listDuplicateCandidates({ tenantId: TENANT, status: 'frozen' })).rejects.toThrow(/status must be one of/);
  });

  it('returns empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_duplicate_candidates" does not exist'));
    const result = await listDuplicateCandidates({ tenantId: TENANT });
    expect(result).toEqual({ candidates: [], count: 0 });
  });

  it('passes filters into the WHERE clause', async () => {
    mockNext([{ id: 1 }, { id: 2 }]);
    const runId = '33333333-3333-4333-8333-333333333333';
    const result = await listDuplicateCandidates({
      tenantId: TENANT,
      status: 'open',
      detectionRunId: runId,
      minConfidence: 80,
      limit: 25,
    });
    expect(result.count).toBe(2);
    const args = queryUnsafeMock.mock.calls[0];
    expect(args.slice(1)).toEqual([TENANT, 'open', runId, 80, 25]);
  });
});

// ---------------------------------------------------------------------------
// getDuplicateCandidate / markCandidateNotDuplicate
// ---------------------------------------------------------------------------
describe('getDuplicateCandidate', () => {
  it('throws 404 when no row matches', async () => {
    mockNext([]);
    await expect(getDuplicateCandidate({ tenantId: TENANT, id: 9 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('markCandidateNotDuplicate', () => {
  it('throws 404 when no open candidate exists', async () => {
    mockNext([]);
    await expect(markCandidateNotDuplicate({ tenantId: TENANT, id: 5 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('flips status to rejected_not_duplicate and records decided_by + note', async () => {
    mockNext([{ id: 5, status: 'rejected_not_duplicate', decision_note: 'Different patients' }]);
    const row = await markCandidateNotDuplicate({
      tenantId: TENANT,
      id: 5,
      decidedBy: 'admin-uid',
      decisionNote: 'Different patients',
    });
    expect(row.status).toBe('rejected_not_duplicate');
    const args = queryUnsafeMock.mock.calls[0];
    expect(args[0]).toMatch(/SET status = 'rejected_not_duplicate'/);
    expect(args.slice(1)).toEqual([5, TENANT, 'admin-uid', 'Different patients']);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
describe('CANDIDATE_STATUSES', () => {
  it('matches the migration CHECK list', () => {
    expect(__testing__.CANDIDATE_STATUSES).toEqual(['open', 'merged', 'rejected_not_duplicate', 'expired']);
  });
});
