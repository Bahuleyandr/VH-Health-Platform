import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { detectCriticalsForResults, recordResultManual } = await import('../../services/lab/labResultsService.js');

describe('labResultsService critical detection', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
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
      expect.stringContaining('UPDATE lab_results SET is_critical = true'),
      37,
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
    executeRawUnsafeMock.mockResolvedValue(1);
  });

  it('resolves investigation_id from booking_id when caller omits it, and advances investigations.status', async () => {
    // Sequence of $queryRawUnsafe calls inside recordResultManual for a
    // non-numeric value with no critical threshold and a booking_id:
    //   1) lab_critical_thresholds probe (non-numeric branch) → empty
    //   2) investigation_bookings lookup → resolveInvestigationIdForBooking
    //   3) lab_results INSERT
    // detectCriticalsForResults short-circuits when value_numeric is null.
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ investigation_id: 42 }])
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
      result: {
        booking_id: 7,
        patient_uid: patientUid,
        test_code: 'CBC',
        test_name: 'Complete Blood Count',
        value_text: 'No growth at 48 hours',
      },
    });

    expect(result.investigation_id).toBe(42);

    // INSERT (call 3) carries investigation_id=42 as $2.
    const insertCall = queryRawUnsafeMock.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO lab_results/);
    expect(insertCall[0]).toMatch(/investigation_id/);
    expect(insertCall[2]).toBe(42);

    // investigations.status advance happens via $executeRawUnsafe.
    const statusAdvance = executeRawUnsafeMock.mock.calls
      .find((args) => /UPDATE investigations/.test(args[0]));
    expect(statusAdvance).toBeDefined();
    expect(statusAdvance[1]).toBe(42);
    expect(statusAdvance[2]).toEqual(
      expect.arrayContaining(['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED']),
    );
    expect(statusAdvance[0]).toMatch(/SET status = 'IN_PROGRESS'/);
  });

  it('skips the investigation status advance when no investigation is linked', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 102,
        tenant_id: tenantId,
        booking_id: null,
        investigation_id: null,
        patient_uid: patientUid,
        test_code: 'BLDCULT',
        test_name: 'Blood culture',
        value_text: 'No growth',
        value_numeric: null,
        status: 'preliminary',
      }]);

    await recordResultManual({
      tenantId,
      performed_by: 'lab-tech-uid',
      result: {
        patient_uid: patientUid,
        test_code: 'BLDCULT',
        test_name: 'Blood culture',
        value_text: 'No growth',
      },
    });

    const statusAdvance = executeRawUnsafeMock.mock.calls
      .find((args) => /UPDATE investigations/.test(args[0]));
    expect(statusAdvance).toBeUndefined();
  });
});
