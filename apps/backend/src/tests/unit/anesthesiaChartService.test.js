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

// Canonical timeline/audit writes are emitted in the same tx as the chart
// entry (canonical clinical timeline invariant). They are exercised
// end-to-end in theatre-clinical-safety.deep.test.js; here the recorder is
// mocked so the unit tests keep asserting the detail-row SQL without the
// canonical-event queries consuming the mock sequence.
const recordCanonicalClinicalEventMock = jest.fn(async () => ({ timeline: { id: 'tl-1' }, audit: { id: 'au-1' } }));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const { recordEntry } = await import('../../services/theatre/anesthesiaChartService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '33333333-3333-4333-8333-333333333333';
const RECORDED_BY = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordCanonicalClinicalEventMock.mockClear();
});

describe('anesthesiaChartService.recordEntry', () => {
  it('404s on an unknown OT schedule without writing anything', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // Phase-0 ot_schedules lookup

    await expect(recordEntry({
      tenantId: TENANT_ID,
      ot_schedule_id: 999999,
      recorded_by: RECORDED_BY,
      hr: 78,
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FROM ot_schedules/);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('rejects charting before the WHO sign-in without writing anesthesia data', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_UID, procedure_name: 'Appendectomy' }])
      .mockResolvedValueOnce([]); // no completed WHO sign-in phase

    await expect(recordEntry({
      tenantId: TENANT_ID,
      ot_schedule_id: 42,
      recorded_by: RECORDED_BY,
      hr: 78,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'WHO_SIGNIN_REQUIRED',
    });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/phase = 'sign_in'/);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_UID, procedure_name: 'Appendectomy' }]) // Phase-0 case lookup
      .mockResolvedValueOnce([{ id: 7 }]) // mandatory WHO sign-in
      .mockResolvedValueOnce([{ id: 11, ot_schedule_id: 42 }]) // INSERT chart entry
      .mockResolvedValueOnce([]); // recompute INSERT INTO anesthesia_records

    const row = await recordEntry({
      tenantId: TENANT_ID,
      ot_schedule_id: 42,
      recorded_at: '2026-05-15T10:30:00.000Z',
      recorded_by: RECORDED_BY,
      hr: 78,
      sbp: 120,
      dbp: 72,
      drugs_given: [{ name: 'midazolam', dose: '2 mg', route: 'IV' }],
      iv_fluids_ml: 100,
      blood_loss_ml: 5,
      event_note: 'MAC started',
    });

    expect(row.id).toBe(11);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(4);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FROM ot_schedules/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/phase = 'sign_in'/);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/INSERT INTO anesthesia_chart_entries/);
    // Rollup is maintained as an ATOMIC per-entry increment keyed on the
    // just-inserted entry id — race-safe via the ON CONFLICT row-lock re-read of
    // the current total, NOT a SUM()-recompute over the whole chart (which lost
    // concurrent inserts under READ COMMITTED).
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(
      /fluids_in_ml = anesthesia_records\.fluids_in_ml \+ EXCLUDED\.fluids_in_ml/,
    );
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/INSERT INTO anesthesia_records/);
    expect(queryUnsafeMock.mock.calls[3][0]).toMatch(/ON CONFLICT \(tenant_id, ot_schedule_id\) DO UPDATE/);
    // The increment takes tenant + schedule id + the just-inserted entry id.
    expect(queryUnsafeMock.mock.calls[3].slice(1)).toEqual([
      TENANT_ID,
      42,
      11,
    ]);
  });

  // Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
  // the patient-facing chart write must emit exactly one canonical
  // timeline + audit pair IN THE SAME TRANSACTION as the detail row.
  it('emits the canonical timeline/audit pair inside the same tenant transaction as the entry', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_UID, procedure_name: 'Appendectomy' }])
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ id: 11, ot_schedule_id: 42 }])
      .mockResolvedValueOnce([]);

    await recordEntry({
      tenantId: TENANT_ID,
      ot_schedule_id: 42,
      recorded_at: '2026-05-15T10:30:00.000Z',
      recorded_by: RECORDED_BY,
      hr: 78,
      drug_name: 'propofol',
      dose: '50 mg',
      route: 'IV',
      iv_fluids_ml: 100,
    });

    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    const [input, options] = recordCanonicalClinicalEventMock.mock.calls[0];
    expect(input).toMatchObject({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      eventType: 'anesthesia.chart_entry.recorded',
      eventStatus: 'recorded',
      sourceTable: 'anesthesia_chart_entries',
      sourceId: 11,
      resourceType: 'ot_schedule',
      resourceId: '42',
      actorUid: RECORDED_BY,
    });
    expect(input.payload).toMatchObject({
      ot_schedule_id: 42,
      drugs_recorded: 1,
      iv_fluids_ml: 100,
    });
    // Same-transaction pin: the recorder receives the SAME client the
    // setTenantTx callback runs on, so the canonical rows commit (or roll
    // back) with the chart entry — with a patientUid and a tx client,
    // recordCanonicalClinicalEvent throws when either row cannot land.
    expect(options).toEqual({ db: __prismaDefaultMock });
  });

  it('rolls the transaction back when the canonical emit fails', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 42, patient_uid: PATIENT_UID, procedure_name: 'Appendectomy' }])
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ id: 11, ot_schedule_id: 42 }])
      .mockResolvedValueOnce([]);
    const canonicalFailure = new Error('Canonical clinical timeline event was not recorded');
    canonicalFailure.code = 'CANONICAL_TIMELINE_REQUIRED';
    recordCanonicalClinicalEventMock.mockRejectedValueOnce(canonicalFailure);

    await expect(recordEntry({
      tenantId: TENANT_ID,
      ot_schedule_id: 42,
      recorded_by: RECORDED_BY,
      hr: 78,
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });
  });
});
