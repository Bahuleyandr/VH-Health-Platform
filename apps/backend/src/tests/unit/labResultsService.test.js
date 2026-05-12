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

const { detectCriticalsForResults } = await import('../../services/lab/labResultsService.js');

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
});
