// apps/backend/src/tests/unit/bloodborneMarkerReconciliation.test.js
//
// Unit cover for the blood-borne marker reconciliation sweep (spec 2026-09-04
// §18). The database is stubbed, so what these cases pin is the SHAPE of the
// candidate query and the sweep's control flow — not whether Postgres agrees.
// The behavioural half (an active marker excludes a result, a voided one does
// not) lives in bloodborne-marker-reconciliation.deep.test.js against a real
// database, because a stubbed `$queryRawUnsafe` will happily "pass" a WHERE
// clause that Postgres would answer differently.
//
// Deliberately NOT mocked: bloodborneMarkerService.js and labAnalyteCodes.js.
// The whole point of the candidate query is that its status set and its
// analyte codes come from those two modules rather than from a list retyped in
// the sweep, so a mock of either would test the mock. Only prisma, the logger
// and the tenant fan-out are stubbed; `recordMarkersFromSignedResults` is
// displaced through the service's documented `recorder` seam instead.

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-0000000bc001';
const SIGNER = '00000000-0000-4000-8000-0000000bc0aa';
const PATIENT = '00000000-0000-4000-8000-0000000bc011';

const prismaMock = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };
const setTenant = jest.fn(async (_tenantId, fn) => fn(prismaMock));
const setTenantTx = jest.fn(async (_tenantId, fn) => fn(prismaMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenant,
  setTenantTx,
}));

const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const runForEachTenant = jest.fn();
const runFleetJob = jest.fn();
jest.unstable_mockModule('../../utils/tenantFanout.js', () => ({
  runForEachTenant,
  runFleetJob,
  default: { runForEachTenant, runFleetJob },
}));

const {
  BLOODBORNE_MARKER_ITEM_CODES,
  LAB_ANALYTE_ITEMS,
} = await import('../../services/lab/labAnalyteCodes.js');
const { scrubPhiDeep } = await import('../../utils/logMasking.js');
const { SIGNED_STATUSES, SIGN_OFF_DECISIONS } = await import(
  '../../services/clinical/bloodborneMarkerService.js'
);
const {
  DECISION_FOR_SIGNED_STATUS,
  DEFAULT_LIMIT,
  RECONCILIATION_JOB_LABEL,
  findUnreconciledSerologyResults,
  reconcileAllTenants,
  reconcileTenant,
} = await import('../../services/clinical/bloodborneMarkerReconciliationService.js');

// A lab_results row as the candidate query projects it.
function candidateRow({ id, testCode = 'HBSAG', status = 'final', signedBy = SIGNER }) {
  return {
    lab_result_id: id,
    patient_uid: PATIENT,
    test_code: testCode,
    loinc_code: null,
    status,
    signed_off_at: '2026-09-01T04:30:00.000Z',
    signed_off_by: signedBy,
  };
}

const emptyRecorderResult = { recorded: [], voided: 0, skipped: [], failed: [] };

beforeEach(() => {
  for (const mock of [
    prismaMock.$queryRawUnsafe, prismaMock.$executeRawUnsafe,
    setTenant, setTenantTx, runForEachTenant, runFleetJob,
    loggerMock.info, loggerMock.warn, loggerMock.error, loggerMock.debug,
  ]) mock.mockReset();
  setTenant.mockImplementation(async (_tenantId, fn) => fn(prismaMock));
  setTenantTx.mockImplementation(async (_tenantId, fn) => fn(prismaMock));
});

describe('findUnreconciledSerologyResults — candidate query shape', () => {
  async function capture(args = {}) {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const rows = await findUnreconciledSerologyResults({ tenantId: TENANT, ...args });
    // The LAST call: a case that captures more than once would otherwise keep
    // re-reading the first one and pass whatever the later binds did.
    const { calls } = prismaMock.$queryRawUnsafe.mock;
    const [sql, ...params] = calls[calls.length - 1];
    return { rows, sql, params };
  }

  test('reads under a tenant context, never on the bare client', async () => {
    await capture();
    expect(setTenant).toHaveBeenCalledTimes(1);
    expect(setTenant.mock.calls[0][0]).toBe(TENANT);
  });

  test('only signed results are candidates, using the writer\'s own status set', async () => {
    const { sql, params } = await capture();
    expect(sql).toMatch(/signed_off_at\s+IS\s+NOT\s+NULL/i);
    // The set is imported, not retyped: if the writer ever stops accepting
    // 'amended' the sweep stops offering it the same instant.
    expect([...params[1]].sort()).toEqual([...SIGNED_STATUSES].sort());
    expect([...SIGNED_STATUSES].sort()).toEqual(['amended', 'corrected', 'final', 'verified']);
  });

  test('the analyte codes come from the shared code map, not a hand-written list', async () => {
    const { sql, params } = await capture();
    const fromMap = BLOODBORNE_MARKER_ITEM_CODES
      .flatMap((key) => LAB_ANALYTE_ITEMS[key].analyteCodes);
    expect([...params[2]].sort()).toEqual([...fromMap].sort());
    // Sanity on both directions: every serology alias is offered...
    expect(params[2]).toEqual(expect.arrayContaining(['HIV', 'HBSAG', 'HBS_AG', 'ANTI_HCV']));
    // ...and no quantitative analyte is, because those carry no marker.
    for (const code of ['HGB', 'PLT', 'CREA', 'K']) expect(params[2]).not.toContain(code);
    // The SQL normalises test_code the way labAnalyteCodes' normalizeCode does,
    // so 'HBs Ag' and 'Anti-HCV' reach the alias list rather than falling out.
    expect(sql).toMatch(/REGEXP_REPLACE/i);
  });

  test('excludes any result that already has an ACTIVE marker row', async () => {
    const { sql } = await capture();
    const antiJoin = /NOT\s+EXISTS\s*\(([\s\S]*?)\)\s*ORDER\s+BY/i.exec(sql);
    expect(antiJoin).not.toBeNull();
    expect(antiJoin[1]).toMatch(/patient_bloodborne_markers/i);
    expect(antiJoin[1]).toMatch(/lab_result_id\s*=\s*result\.id/i);
    // The clause that makes a VOIDED marker leave the result a candidate
    // again. Deleting it is the mutation the deep suite is calibrated against.
    expect(antiJoin[1]).toMatch(/voided_at\s+IS\s+NULL/i);
    // ...and the anti-join is tenant-scoped, so another tenant's marker row
    // can never suppress this tenant's repair.
    expect(antiJoin[1]).toMatch(/marker\.tenant_id\s*=\s*result\.tenant_id/i);
  });

  test('since is bound as an instant and is optional; limit defaults and is bounded', async () => {
    const bare = await capture();
    expect(bare.params[3]).toBeNull();
    expect(bare.params[4]).toBe(DEFAULT_LIMIT);
    expect(DEFAULT_LIMIT).toBe(500);

    const windowed = await capture({ since: '2026-08-01T00:00:00.000Z', limit: 25 });
    expect(windowed.params[3]).toBe('2026-08-01T00:00:00.000Z');
    expect(windowed.params[4]).toBe(25);
    // A Date is accepted and normalised to the same ISO instant, so the bind
    // never depends on the driver's session timezone.
    const asDate = await capture({ since: new Date('2026-08-01T00:00:00.000Z') });
    expect(asDate.params[3]).toBe('2026-08-01T00:00:00.000Z');
  });

  test('a nonsense since or limit is refused before any query is issued', async () => {
    await expect(findUnreconciledSerologyResults({ tenantId: TENANT, since: 'not-a-date' }))
      .rejects.toThrow(/since/i);
    await expect(findUnreconciledSerologyResults({ tenantId: TENANT, limit: 0 }))
      .rejects.toThrow(/limit/i);
    await expect(findUnreconciledSerologyResults({ tenantId: TENANT, limit: 10_000 }))
      .rejects.toThrow(/limit/i);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('the SQL pre-filter is coarse; markerForResult is the authority', async () => {
    // A row the normalised LIKE-list let through but the map does not claim is
    // dropped in JS, so the sweep can never hand the writer a non-serology id.
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11, testCode: 'HBSAG' }),
      candidateRow({ id: 12, testCode: 'HGB' }),
      candidateRow({ id: 13, testCode: 'Anti-HCV' }),
    ]);
    const rows = await findUnreconciledSerologyResults({ tenantId: TENANT });
    expect(rows.map((row) => row.lab_result_id)).toEqual([11, 13]);
  });

  test('returns the documented row shape', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([candidateRow({ id: 11 })]);
    const [row] = await findUnreconciledSerologyResults({ tenantId: TENANT });
    expect(row).toEqual({
      lab_result_id: 11,
      patient_uid: PATIENT,
      test_code: 'HBSAG',
      status: 'final',
      signed_off_at: '2026-09-01T04:30:00.000Z',
      // Carried beside the documented five because the repair call needs an
      // actor and re-reading the row to find one would be a second query.
      signed_off_by: SIGNER,
    });
  });
});

describe('the status-to-decision map', () => {
  test('every signed status maps to a decision the writer accepts', () => {
    expect(Object.keys(DECISION_FOR_SIGNED_STATUS).sort()).toEqual([...SIGNED_STATUSES].sort());
    for (const decision of Object.values(DECISION_FOR_SIGNED_STATUS)) {
      expect(SIGN_OFF_DECISIONS).toContain(decision);
    }
  });

  test('a corrective status keeps its own decision rather than flattening to verified', () => {
    expect(DECISION_FOR_SIGNED_STATUS.corrected).toBe('corrected');
    expect(DECISION_FOR_SIGNED_STATUS.amended).toBe('amended');
    expect(DECISION_FOR_SIGNED_STATUS.final).toBe('verified');
    expect(DECISION_FOR_SIGNED_STATUS.verified).toBe('verified');
  });
});

describe('reconcileTenant', () => {
  test('a dry run reads candidates and writes nothing', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11 }), candidateRow({ id: 12 }),
    ]);
    const recorder = jest.fn();
    const summary = await reconcileTenant({ tenantId: TENANT, dryRun: true, recorder });
    expect(recorder).not.toHaveBeenCalled();
    expect(summary).toEqual({
      candidates: 2, recorded: 0, voided: 0, skipped: 0, failed: 0, examples: [11, 12],
    });
  });

  test('drives the writer once per candidate, in the hook\'s argument shape', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11 }),
      candidateRow({ id: 12, status: 'corrected' }),
    ]);
    const recorder = jest.fn(async () => emptyRecorderResult);
    await reconcileTenant({ tenantId: TENANT, recorder });
    expect(recorder).toHaveBeenNthCalledWith(1, {
      tenantId: TENANT, resultIds: [11], decision: 'verified', actorUid: SIGNER,
    });
    // The decision travels from the result's own status, so a corrective
    // sign-off's evidence.decision is not rewritten as 'verified' by the sweep.
    expect(recorder).toHaveBeenNthCalledWith(2, {
      tenantId: TENANT, resultIds: [12], decision: 'corrected', actorUid: SIGNER,
    });
  });

  test('aggregates the writer\'s own four counters', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11 }), candidateRow({ id: 12 }), candidateRow({ id: 13 }),
    ]);
    const recorder = jest.fn()
      .mockResolvedValueOnce({ recorded: [{ id: 1 }], voided: 1, skipped: [], failed: [] })
      .mockResolvedValueOnce({ recorded: [], voided: 0, skipped: [12], failed: [] })
      .mockResolvedValueOnce({
        recorded: [], voided: 0, skipped: [], failed: [{ lab_result_id: 13, reason: 'future_dated' }],
      });
    const summary = await reconcileTenant({ tenantId: TENANT, recorder });
    expect(summary).toEqual({
      candidates: 3, recorded: 1, voided: 1, skipped: 1, failed: 1, examples: [11, 12, 13],
    });
  });

  test('a failing candidate is logged with its id and does not stop the rest', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11 }), candidateRow({ id: 12 }), candidateRow({ id: 13 }),
    ]);
    const boom = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const recorder = jest.fn()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce({ recorded: [{ id: 2 }], voided: 0, skipped: [], failed: [] })
      .mockResolvedValueOnce({ recorded: [{ id: 3 }], voided: 0, skipped: [], failed: [] });

    // Not thrown past the loop...
    const summary = await reconcileTenant({ tenantId: TENANT, recorder });
    expect(summary.failed).toBe(1);
    expect(summary.recorded).toBe(2);
    expect(recorder).toHaveBeenCalledTimes(3);
    // ...and the failure names the one lab result it belongs to.
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('11'),
      expect.objectContaining({ tenantId: TENANT, labResultId: 11, code: '40P01' }),
    );
  });

  test('a candidate with no signing actor is a failure, not a crash', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11, signedBy: null }),
    ]);
    const recorder = jest.fn();
    const summary = await reconcileTenant({ tenantId: TENANT, recorder });
    // recorded_by is NOT NULL with an FK to users; there is nobody to attribute
    // the repair to, so it is reported rather than guessed at.
    expect(recorder).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 1, failed: 1, recorded: 0 });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('11'),
      expect.objectContaining({ labResultId: 11 }),
    );
  });

  test('examples name at most the first five candidates', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce(
      [11, 12, 13, 14, 15, 16, 17].map((id) => candidateRow({ id })),
    );
    const summary = await reconcileTenant({ tenantId: TENANT, dryRun: true });
    expect(summary.candidates).toBe(7);
    expect(summary.examples).toEqual([11, 12, 13, 14, 15]);
  });

  test('logs one summary line per tenant, carrying no PHI beyond ids', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([candidateRow({ id: 11 })]);
    await reconcileTenant({ tenantId: TENANT, dryRun: true });
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    const [, meta] = loggerMock.info.mock.calls[0];
    expect(meta).toMatchObject({ tenantId: TENANT, candidates: 1, dryRun: true });
    const serialised = JSON.stringify(loggerMock.info.mock.calls[0]);
    for (const phi of [PATIENT, 'HBSAG', 'Reactive']) expect(serialised).not.toContain(phi);
  });

  test('the summary line survives the global PHI scrubber intact', async () => {
    // logMasking's SENSITIVE_KEY_RE matches `record`, so a meta field named
    // `recorded` reaches the log as "[REDACTED]" — the sign-off hook's own
    // marker-sync line already loses its count that way. Every counter this
    // sweep reports must still be readable AFTER the winston format runs, or
    // the operator's only evidence of what was repaired is a redaction marker.
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      candidateRow({ id: 11 }), candidateRow({ id: 12 }),
    ]);
    const recorder = jest.fn(async () => ({
      recorded: [{ id: 1 }], voided: 1, skipped: [12], failed: [],
    }));
    await reconcileTenant({ tenantId: TENANT, recorder });

    const [, meta] = loggerMock.info.mock.calls[0];
    const scrubbed = Object.fromEntries(
      Object.entries(meta).map(([key, value]) => [key, scrubPhiDeep(value, 0, new WeakSet(), key)]),
    );
    for (const [key, value] of Object.entries(scrubbed)) {
      expect(`${key}=${JSON.stringify(value)}`).not.toContain('[REDACTED]');
    }
    expect(scrubbed).toMatchObject({
      candidates: 2, inserted: 2, voided: 2, unchanged: 2, failures: 0,
    });
    expect(scrubbed.examples).toEqual([11, 12]);
  });

  test('an empty tenant does no work and still reports', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);
    const recorder = jest.fn();
    const summary = await reconcileTenant({ tenantId: TENANT, recorder });
    expect(recorder).not.toHaveBeenCalled();
    expect(summary).toEqual({
      candidates: 0, recorded: 0, voided: 0, skipped: 0, failed: 0, examples: [],
    });
  });
});

describe('reconcileAllTenants', () => {
  test('fans out through the shared tenant helper under its own job label', async () => {
    runForEachTenant.mockImplementation(async (_label, perTenantFn) => {
      prismaMock.$queryRawUnsafe.mockResolvedValueOnce([candidateRow({ id: 11 })]);
      await perTenantFn(TENANT);
      return { runId: '77', tenantsDiscovered: 1, tenantsRun: 1, errors: 0 };
    });
    const out = await reconcileAllTenants({ dryRun: true });
    expect(runForEachTenant).toHaveBeenCalledWith(
      RECONCILIATION_JOB_LABEL, expect.any(Function), { lockKey: RECONCILIATION_JOB_LABEL },
    );
    expect(RECONCILIATION_JOB_LABEL).toBe('bloodborne-marker-reconciliation');
    expect(out).toMatchObject({
      run_id: '77',
      tenants_discovered: 1,
      tenants_run: 1,
      dry_run: true,
      candidates: 1,
    });
    expect(out.tenants).toEqual([expect.objectContaining({ tenant_id: TENANT, candidates: 1 })]);
  });

  test('totals sum the per-tenant rows', async () => {
    runForEachTenant.mockImplementation(async (_label, perTenantFn) => {
      prismaMock.$queryRawUnsafe
        .mockResolvedValueOnce([candidateRow({ id: 11 })])
        .mockResolvedValueOnce([candidateRow({ id: 21 }), candidateRow({ id: 22 })]);
      await perTenantFn(TENANT);
      await perTenantFn('00000000-0000-4000-8000-0000000bc002');
      return { runId: '78', tenantsDiscovered: 2, tenantsRun: 2, errors: 0 };
    });
    const out = await reconcileAllTenants({ dryRun: true });
    expect(out.candidates).toBe(3);
    expect(out.tenants).toHaveLength(2);
  });

  test('a fan-out failure still carries the partial per-tenant progress', async () => {
    // runForEachTenant is fail-closed: one bad tenant rejects the aggregate.
    // The rows gathered before that must not be lost with it.
    const aggregate = new AggregateError([new Error('tenant boom')], 'fan-out failed');
    runForEachTenant.mockImplementation(async (_label, perTenantFn) => {
      prismaMock.$queryRawUnsafe.mockResolvedValueOnce([candidateRow({ id: 11 })]);
      await perTenantFn(TENANT);
      throw aggregate;
    });
    await expect(reconcileAllTenants({ dryRun: true })).rejects.toBe(aggregate);
    expect(aggregate.result).toMatchObject({ candidates: 1 });
    expect(aggregate.result.tenants).toHaveLength(1);
  });
});
