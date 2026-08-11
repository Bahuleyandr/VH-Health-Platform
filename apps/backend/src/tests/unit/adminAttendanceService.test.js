import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

const tableExistsMock = jest.fn(async () => true);
const safeQueryMock = jest.fn();

jest.unstable_mockModule('../../routes/admin/services/common.js', () => ({
  tableExists: tableExistsMock,
  safeQuery: safeQueryMock,
}));

const {
  getEarlyDepartures,
  getLateArrivals,
} = await import('../../routes/admin/services/attendanceService.js');

function rejectUnsupportedInterval(sql, alias) {
  if (!String(sql).includes(`)::text AS ${alias}`)) {
    const error = new Error("Failed to deserialize column of type 'interval'");
    error.code = 'P2010';
    throw error;
  }
}

describe('admin attendance interval projections', () => {
  beforeEach(() => {
    tableExistsMock.mockClear();
    safeQueryMock.mockReset();
  });

  test('returns a supported text duration for late arrivals', async () => {
    safeQueryMock.mockImplementation(async (sql) => {
      rejectUnsupportedInterval(sql, 'late_by');
      return [{ name: 'Nurse One', late_by: '00:45:00' }];
    });

    await expect(getLateArrivals('2026-08-11')).resolves.toEqual({
      date: '2026-08-11',
      lateArrivals: [{ name: 'Nurse One', late_by: '00:45:00' }],
      total: 1,
    });
    expect(safeQueryMock.mock.calls[0][1]).toEqual(['2026-08-11']);
  });

  test('returns a supported text duration for early departures', async () => {
    safeQueryMock.mockImplementation(async (sql) => {
      rejectUnsupportedInterval(sql, 'left_early_by');
      return [{ name: 'Nurse One', left_early_by: '01:15:00' }];
    });

    await expect(getEarlyDepartures('2026-08-11', 'ICU')).resolves.toEqual({
      date: '2026-08-11',
      earlyDepartures: [{ name: 'Nurse One', left_early_by: '01:15:00' }],
      total: 1,
    });
    expect(safeQueryMock.mock.calls[0][1]).toEqual(['2026-08-11', 'ICU']);
  });

  test('propagates attendance query faults', async () => {
    safeQueryMock.mockRejectedValueOnce(new Error('attendance database unavailable'));

    await expect(getLateArrivals('2026-08-11'))
      .rejects.toThrow('attendance database unavailable');
  });

  test('casts duration projections on both admin attendance path families', () => {
    const sources = [
      '../../routes/admin/services/attendanceService.js',
      '../../controllers/staff/staffAdminAttendanceController.js',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));

    for (const source of sources) {
      expect(source).toMatch(/\(a\.check_in_time::time - '09:30:00'::time\)::text AS late_by/i);
      expect(source).toMatch(/\('17:00:00'::time - a\.check_out_time::time\)::text AS left_early_by/i);
    }
  });
});
