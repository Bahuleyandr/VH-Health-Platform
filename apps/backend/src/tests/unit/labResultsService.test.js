import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const emitCriticalLabAlertAcknowledgedMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  // recordResultManual / signOffResults run their Phase-1 writes (detail row
  // + canonical pair) inside prisma.$transaction — passthrough to the same
  // mock client so the call sequences below stay observable.
  $transaction: async (fn) => fn(__prismaDefaultMock),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

// labResultsService emits the canonical timeline/audit pair in-transaction;
// mock the canonical layer so the raw-call sequences stay lab-SQL-only and
// the emission itself is assertable. Factory exports the union of names the
// loaded import graph pulls from this module (ESM mock-graph law).
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordTimelineEvent: jest.fn().mockResolvedValue(null),
  recordClinicalAuditEvent: jest.fn().mockResolvedValue(null),
  startWorkflowSla: jest.fn().mockResolvedValue(null),
  completeWorkflowSla: jest.fn().mockResolvedValue(null),
  isSchemaMissing: jest.fn(() => false),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitCriticalLabAlertAcknowledged: emitCriticalLabAlertAcknowledgedMock,
}));

const {
  detectCriticalsForResults,
  recordResultManual,
  listLabWorklist,
  listIpdLabWorklist,
  signOffResults,
  acknowledgeAlert,
} = await import('../../services/lab/labResultsService.js');

describe('labResultsService critical detection', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    emitCriticalLabAlertAcknowledgedMock.mockReset();
    executeRawUnsafeMock.mockResolvedValue(1);
  });

  it('maps TROPI / LOINC 10839-9 to the Troponin-I critical threshold', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const result = {
      id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
      loinc_code: '10839-9',
      test_code: 'TROPI',
      test_name: 'Troponin I',
      value_text: '0.85',
      value_numeric: '0.85',
      unit: 'ng/mL',
      is_critical: false,
    };

    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        critical_low: null,
        critical_high: '0.04',
        test_name: 'Troponin I',
        unit: 'ng/mL',
      }])
      .mockResolvedValueOnce([{
        id: 91,
        result_id: 37,
        patient_uid: result.patient_uid,
        threshold_breached: 'high',
      }])
      .mockResolvedValueOnce([]);

    const alerts = await detectCriticalsForResults({ tenantId, results: [result] });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].result_id).toBe(37);
    expect(result.is_critical).toBe(true);

    const thresholdLookup = queryRawUnsafeMock.mock.calls[0];
    expect(thresholdLookup[1]).toBe(tenantId);
    expect(thresholdLookup[2]).toEqual(expect.arrayContaining(['10839-9', '6598-7']));
    expect(thresholdLookup[3]).toEqual(expect.arrayContaining(['TROPI', 'TROP']));

    expect(executeRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE lab_results[\s\S]*SET is_critical = true/),
      37,
      tenantId,
    );
  });

  it('normalizes per-uL CBC counts before comparing x10^3/uL critical thresholds', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const patientUid = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';
    const results = [
      {
        id: 29,
        patient_uid: patientUid,
        loinc_code: null,
        test_code: 'WBC',
        test_name: 'White blood cell count',
        value_text: '8200',
        value_numeric: '8200',
        unit: '/uL',
        is_critical: false,
      },
      {
        id: 30,
        patient_uid: patientUid,
        loinc_code: null,
        test_code: 'PLT',
        test_name: 'Platelet count',
        value_text: '245000',
        value_numeric: '245000',
        unit: '/uL',
        is_critical: false,
      },
    ];

    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        critical_low: '2',
        critical_high: '30',
        test_name: 'White blood cell count',
        unit: '10^3/uL',
      }])
      .mockResolvedValueOnce([{
        critical_low: '30',
        critical_high: '1000',
        test_name: 'Platelet count',
        unit: '10^3/uL',
      }]);

    const alerts = await detectCriticalsForResults({ tenantId, results });

    expect(alerts).toHaveLength(0);
    expect(results[0].is_critical).toBe(false);
    expect(results[1].is_critical).toBe(false);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('labResultsService recordResultManual — investigation linkage', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = 'aaaa1111-2222-4333-8444-555555555555';

  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    emitCriticalLabAlertAcknowledgedMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset();
    recordCanonicalClinicalEventMock.mockResolvedValue({ timeline: null, audit: null });
    executeRawUnsafeMock.mockResolvedValue(1);
  });

  it('resolves investigation_id from booking_id when caller omits it, and advances investigations.status', async () => {
    // Sequence of $queryRawUnsafe calls inside recordResultManual for a
    // non-numeric value with no critical threshold and a booking_id:
    //   1) lab_critical_thresholds probe (non-numeric branch) → empty
    //   2) investigation_bookings lookup → resolveInvestigationIdForBooking
    //   3) lab_results dup-analyte probe (no prior finalised row) → empty
    //   4) lab_results INSERT
    // detectCriticalsForResults short-circuits when value_numeric is null.
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ investigation_id: 42 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 101,
        tenant_id: tenantId,
        booking_id: 7,
        investigation_id: 42,
        patient_uid: patientUid,
        test_code: 'CBC',
        test_name: 'Complete Blood Count',
        value_text: 'No growth at 48 hours',
        value_numeric: null,
        unit: null,
        status: 'preliminary',
      }]);

    const { result } = await recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      performed_by_role: 'LAB_TECHNICIAN',
      result: {
        booking_id: 7,
        patient_uid: patientUid,
        test_code: 'CBC',
        test_name: 'Complete Blood Count',
        value_text: 'No growth at 48 hours',
      },
    });

    expect(result.investigation_id).toBe(42);

    // Canonical pair emitted in-transaction with actor attribution.
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    const canonicalInput = recordCanonicalClinicalEventMock.mock.calls[0][0];
    expect(canonicalInput.eventType).toBe('lab.result_recorded');
    expect(canonicalInput.patientUid).toBe(patientUid);
    expect(canonicalInput.actorUid).toBe('lab-tech-uid');
    expect(canonicalInput.actorRole).toBe('LAB_TECHNICIAN');
    expect(canonicalInput.sourceTable).toBe('lab_results');
    expect(recordCanonicalClinicalEventMock.mock.calls[0][1]).toMatchObject({ db: __prismaDefaultMock });

    // INSERT (call 4 — call 3 is the dup-analyte probe added 2026-05-23)
    // carries investigation_id=42 as $2.
    const insertCall = queryRawUnsafeMock.mock.calls[3];
    expect(insertCall[0]).toMatch(/INSERT INTO lab_results/);
    expect(insertCall[0]).toMatch(/investigation_id/);
    expect(insertCall[2]).toBe(42);

    // The dup-analyte probe should also have happened (call 3).
    const dupProbe = queryRawUnsafeMock.mock.calls[2];
    expect(dupProbe[0]).toMatch(/FROM lab_results/);
    expect(dupProbe[0]).toMatch(/status IN/);
    expect(dupProbe[0]).toMatch(/tenant_id = \$3::uuid/);
    expect(dupProbe[3]).toBe(tenantId);

    // investigations.status advance happens via $executeRawUnsafe.
    const statusAdvance = executeRawUnsafeMock.mock.calls
      .find((args) => /UPDATE investigations/.test(args[0]));
    expect(statusAdvance).toBeDefined();
    expect(statusAdvance[1]).toBe(42);
    expect(statusAdvance[2]).toEqual(
      expect.arrayContaining(['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED']),
    );
    expect(statusAdvance[3]).toBe(tenantId);
    expect(statusAdvance[0]).toMatch(/SET status = 'IN_PROGRESS'/);
    expect(statusAdvance[0]).toMatch(/tenant_id = \$3::uuid/);
  });

  it('rejects manual result creation when no order or booking link exists', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([]);

    await expect(recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        patient_uid: patientUid,
        test_code: 'BLDCULT',
        test_name: 'Blood culture',
        value_text: 'No growth',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_ORDER_LINK_REQUIRED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects pathologist sign-off for unlinked lab results', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 102,
      patient_uid: patientUid,
      booking_id: null,
      investigation_id: null,
    }]);

    await expect(signOffResults({
      tenantId,
      signed_off_by: '33333333-3333-4333-8333-333333333333',
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [102],
      decision: 'rejected',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_RESULT_ORDER_LINK_REQUIRED',
      details: { result_ids: [102] },
    });
  });
});

describe('listLabWorklist STAT ordering (D45)', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    emitCriticalLabAlertAcknowledgedMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([]);
  });

  it('orders STAT/URGENT bucket NEWEST-first within priority bucket', async () => {
    await listLabWorklist({ tenantId });
    const sql = queryRawUnsafeMock.mock.calls[0][0];
    // The STAT/URGENT branch sorts requested_at DESC so a fresh ER
    // STAT troponin lands above a stale never-cancelled STAT row from
    // a previous shift.
    expect(sql).toMatch(/IN \('STAT', 'URGENT'\)[\s\S]*requested_at\s*\n?\s*END DESC NULLS LAST/);
    // Non-STAT priority buckets keep oldest-first (fair FIFO) so
    // routine work still drains in arrival order.
    expect(sql).toMatch(/i\.requested_at ASC\s+LIMIT/);
    // Priority bucket ordering is preserved (STAT/URGENT = 1).
    expect(sql).toMatch(/WHEN 'STAT' THEN 1/);
    expect(sql).toMatch(/i\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/u\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/a\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/ev\.tenant_id = \$1::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([tenantId, 100]);
  });

  it('scopes IPD worklist joins to the caller tenant', async () => {
    await listIpdLabWorklist({ tenantId, limit: 25 });

    const [sql, boundTenant, boundLimit] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/i\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/u\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/a\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/b\.tenant_id = \$1::uuid/);
    expect(boundTenant).toBe(tenantId);
    expect(boundLimit).toBe(25);
  });

  it('acknowledges critical alerts by id only inside the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 7,
      tenant_id: tenantId,
      result_id: 37,
      patient_uid: '5e89c1aa-df0c-4d19-9e7e-40af85486f24',
    }]);

    await acknowledgeAlert(7, {
      tenantId,
      acknowledged_by: '33333333-3333-4333-8333-333333333333',
    });

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toMatch(/WHERE id = \$5::int[\s\S]*tenant_id = \$6::uuid/);
    expect(call[5]).toBe(7);
    expect(call[6]).toBe(tenantId);
  });
});
