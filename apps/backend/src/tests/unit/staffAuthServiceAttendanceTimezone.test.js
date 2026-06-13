import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    $executeRawUnsafe: executeRawUnsafe,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  generateToken: jest.fn(() => 'test-token'),
  verifyToken: jest.fn(),
}));

jest.unstable_mockModule('../../utils/loginAnomalyDetector.js', () => ({
  trackFailedLogin: jest.fn(),
}));

jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({
  logSecurityEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: jest.fn(),
}));

jest.unstable_mockModule('../../services/auth/userActiveSession.js', () => ({
  getUserSessionDeviceType: jest.fn(),
}));

const { StaffAuthService } = await import('../../services/auth/staffAuthService.js');

beforeEach(() => {
  queryRawUnsafe.mockReset();
  executeRawUnsafe.mockReset();
});

describe('StaffAuthService attendance timezone handling', () => {
  it('counts UTC-stored check-ins inside the local staff day', async () => {
    const staffUid = '93fc7713-e23c-40b8-8d2e-174a13faa2ce';
    queryRawUnsafe.mockResolvedValueOnce([
      {
        id: 2,
        staff_id: 22,
        staff_uid: null,
        check_in_time: new Date('2026-06-12T19:41:01.771Z'),
        check_out_time: null,
        local_check_in_time: '2026-06-13T01:11:01.771',
        local_check_out_time: null,
        recorded_at: '2026-06-13T01:11:01.771',
      },
    ]);

    const result = await StaffAuthService.getTodayAttendance(staffUid);

    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain("AT TIME ZONE 'UTC'");
    expect(sql).toContain('CURRENT_DATE');
    expect(queryRawUnsafe.mock.calls[0][1]).toBe(staffUid);
    expect(result).toMatchObject({
      id: 2,
      staff_id: 22,
      checkInTime: '2026-06-13T01:11:01.771',
      checkOutTime: null,
      isCheckedIn: true,
      status: 'checked-in',
    });
  });

  it('applies date range filters as local-day UTC bounds for history', async () => {
    const staffUid = '93fc7713-e23c-40b8-8d2e-174a13faa2ce';
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);

    await StaffAuthService.getAttendanceHistory(staffUid, {
      startDate: '2026-06-13',
      endDate: '2026-06-13',
      page: 1,
      limit: 30,
    });

    const historySql = queryRawUnsafe.mock.calls[0][0];
    expect(historySql).toContain("AT TIME ZONE 'UTC'");
    expect(historySql).toContain("$2::date");
    expect(historySql).toContain("$3::date + INTERVAL '1 day'");
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual([
      staffUid,
      '2026-06-13',
      '2026-06-13',
      30,
      0,
    ]);
  });
});
