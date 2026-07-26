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

const { recordEntry } = await import('../../services/theatre/anesthesiaChartService.js');

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('anesthesiaChartService.recordEntry', () => {
  it('rejects charting before the WHO sign-in without writing anesthesia data', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await expect(recordEntry({
      tenantId: '00000000-0000-4000-8000-000000000001',
      ot_schedule_id: 42,
      recorded_by: '22222222-2222-4222-8222-222222222222',
      hr: 78,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'WHO_SIGNIN_REQUIRED',
    });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/phase = 'sign_in'/);
  });

  // The chart-entry INSERT and the case-record rollup recompute now run in
  // ONE setTenantTx transaction, and the rollup is recomputed deterministically
  // from the chart rows via SUM()/jsonb_agg (audit 2026-06-18 §3 fix #5) — no
  // incremental accumulator params. The numeric correctness of the SUM rollup
  // under concurrency is proven against the real DB in
  // theatre-clinical-safety.deep.test.js; here we assert the two statements
  // run in order inside the tx.
  it('creates the chart row then atomically increments the case anesthesia record rollup in one tx', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 7 }]) // mandatory WHO sign-in
      .mockResolvedValueOnce([{ id: 11, ot_schedule_id: 42 }]) // INSERT chart entry
      .mockResolvedValueOnce([]); // recompute INSERT INTO anesthesia_records

    const row = await recordEntry({
      tenantId: '00000000-0000-4000-8000-000000000001',
      ot_schedule_id: 42,
      recorded_at: '2026-05-15T10:30:00.000Z',
      recorded_by: '22222222-2222-4222-8222-222222222222',
      hr: 78,
      sbp: 120,
      dbp: 72,
      drugs_given: [{ name: 'midazolam', dose: '2 mg', route: 'IV' }],
      iv_fluids_ml: 100,
      blood_loss_ml: 5,
      event_note: 'MAC started',
    });

    expect(row.id).toBe(11);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/phase = 'sign_in'/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO anesthesia_chart_entries/);
    // Rollup is maintained as an ATOMIC per-entry increment keyed on the
    // just-inserted entry id — race-safe via the ON CONFLICT row-lock re-read of
    // the current total, NOT a SUM()-recompute over the whole chart (which lost
    // concurrent inserts under READ COMMITTED).
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(
      /fluids_in_ml = anesthesia_records\.fluids_in_ml \+ EXCLUDED\.fluids_in_ml/,
    );
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO anesthesia_records/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/ON CONFLICT \(tenant_id, ot_schedule_id\) DO UPDATE/);
    // The increment takes tenant + schedule id + the just-inserted entry id.
    expect(queryUnsafeMock.mock.calls[2].slice(1)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      42,
      11,
    ]);
  });
});
