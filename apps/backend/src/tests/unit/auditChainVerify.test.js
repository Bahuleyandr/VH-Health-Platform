// WS4 B4.6 / EPIC C4 — tamper-evident clinical audit hash chain.
//
// No-DB unit test for the chain VERIFY surface. The tamper-evident chain on
// clinical_audit_events is already implemented (migration 282): a global
// `chain_seq`, `prev_hash`, and `chain_hash = audit_chain_hash(row + prev_hash)`
// are computed by a BEFORE INSERT trigger under a per-tenant
// `pg_advisory_xact_lock`, so every write path is chained inside the same
// transaction as the insert (no JS hashing — the trigger cannot be forgotten).
// `verifyAuditChain` recomputes that chain with the SAME SQL function the
// trigger uses and reports the first broken link.
//
// The end-to-end behaviour (insert → chain → tamper → detect) is covered by
// src/tests/document-integrity.deep.test.js against a real DB. THIS file is a
// pure, mocked-prisma test of the verify helper's own logic — the verdict
// mapping (intact / breaks / first_break_*), the tail-window SQL shaping, and
// the `limit` input validation — with zero infrastructure.

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// Keep the module graph hermetic: documentIntegrityService imports the
// canonical service only for the signing path, which this test never exercises.
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
}));

const { verifyAuditChain } = await import('../../services/clinical/documentIntegrityService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('verifyAuditChain — verdict mapping (mocked prisma, no DB)', () => {
  test('an intact chain reports intact:true with the checked count and no break', async () => {
    // What the SQL aggregate returns when every recomputed hash matches and
    // every prev_hash links to its predecessor.
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 3, breaks: 0, first_break_seq: null, first_break_id: null },
    ]);

    const verdict = await verifyAuditChain({ tenantId: TENANT });

    expect(verdict).toEqual({
      tenant_id: TENANT,
      checked: 3,
      breaks: 0,
      intact: true,
      first_break_seq: null,
      first_break_id: null,
    });

    // Full-chain verify: tenant is the only bind param, no tail-window clause.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryUnsafeMock.mock.calls[0];
    expect(params).toEqual([TENANT]);
    expect(sql).toContain('audit_chain_hash(');
    expect(sql).toContain('recomputed = chain_hash');
    expect(sql).not.toContain('chain_seq >'); // no window when limit is null
  });

  test('a tampered row is DETECTED — intact:false, breaks>=1, first break surfaced', async () => {
    // Simulates the deep test's "edit a chained row" scenario: the row's
    // recomputed hash no longer equals its stored chain_hash, so the aggregate
    // returns a break with the offending seq + id.
    const brokenSeq = 42;
    const brokenId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 5, breaks: 1, first_break_seq: brokenSeq, first_break_id: brokenId },
    ]);

    const verdict = await verifyAuditChain({ tenantId: TENANT });

    expect(verdict.intact).toBe(false);
    expect(verdict.breaks).toBe(1);
    expect(verdict.first_break_seq).toBe(brokenSeq);
    expect(verdict.first_break_id).toBe(brokenId);
    expect(verdict.checked).toBe(5);
    expect(verdict.tenant_id).toBe(TENANT);
  });

  test('multiple broken links report the count and the EARLIEST break only', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 10, breaks: 3, first_break_seq: 7, first_break_id: 'first-break-id' },
    ]);

    const verdict = await verifyAuditChain({ tenantId: TENANT });

    expect(verdict.intact).toBe(false);
    expect(verdict.breaks).toBe(3);
    // first_break_* is the EARLIEST offending row (MIN(chain_seq) /
    // ARRAY_AGG ... ORDER BY chain_seq[1]) — the auditor's starting point.
    expect(verdict.first_break_seq).toBe(7);
    expect(verdict.first_break_id).toBe('first-break-id');
  });

  test('an empty tenant chain is vacuously intact (checked:0)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 0, breaks: 0, first_break_seq: null, first_break_id: null },
    ]);

    const verdict = await verifyAuditChain({ tenantId: TENANT });

    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBe(0);
    expect(verdict.breaks).toBe(0);
  });

  test('defaults to the platform default tenant when none is supplied', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 1, breaks: 0, first_break_seq: null, first_break_id: null },
    ]);

    const verdict = await verifyAuditChain();

    expect(verdict.tenant_id).toBe(TENANT);
    expect(queryUnsafeMock.mock.calls[0].slice(1)).toEqual([TENANT]);
  });

  test('numeric coercion is robust to bigint/string columns from the driver', async () => {
    // pg can hand back BIGINT counts as strings; the helper must coerce.
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: '4', breaks: '2', first_break_seq: '9', first_break_id: 'x' },
    ]);

    const verdict = await verifyAuditChain({ tenantId: TENANT });

    expect(verdict.checked).toBe(4);
    expect(verdict.breaks).toBe(2);
    expect(verdict.intact).toBe(false);
    expect(verdict.first_break_seq).toBe(9);
  });

  test('a missing/empty result row degrades to a clean zeroed verdict', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    const verdict = await verifyAuditChain({ tenantId: TENANT });

    expect(verdict).toEqual({
      tenant_id: TENANT,
      checked: 0,
      breaks: 0,
      intact: true,
      first_break_seq: null,
      first_break_id: null,
    });
  });
});

describe('verifyAuditChain — tail-window (limit) handling', () => {
  test('a positive limit adds the tail-window clause and binds the limit', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 50, breaks: 0, first_break_seq: null, first_break_id: null },
    ]);

    await verifyAuditChain({ tenantId: TENANT, limit: 50 });

    const [sql, ...params] = queryUnsafeMock.mock.calls[0];
    expect(params).toEqual([TENANT, 50]);
    // Tail window restricts to the newest N links by chain_seq.
    expect(sql).toContain('chain_seq >');
    expect(sql).toContain('$2::int');
  });

  test('a string limit is parsed to an integer bind param', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { checked: 25, breaks: 0, first_break_seq: null, first_break_id: null },
    ]);

    await verifyAuditChain({ tenantId: TENANT, limit: '25' });

    expect(queryUnsafeMock.mock.calls[0].slice(1)).toEqual([TENANT, 25]);
  });

  test.each([0, -1, 'abc', Number.NaN])(
    'rejects a non-positive / non-integer limit (%p) before touching the DB',
    async (badLimit) => {
      await expect(
        verifyAuditChain({ tenantId: TENANT, limit: badLimit }),
      ).rejects.toMatchObject({ code: 'CHAIN_BAD_LIMIT' });
      expect(queryUnsafeMock).not.toHaveBeenCalled();
    },
  );
});
