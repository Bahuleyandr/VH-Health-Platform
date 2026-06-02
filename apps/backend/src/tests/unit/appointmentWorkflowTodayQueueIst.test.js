import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { getTodayQueue } = await import('../../controllers/appointment/appointmentWorkflowController.js');

afterEach(() => {
  queryUnsafeMock.mockReset();
  jest.useRealTimers();
});

describe('appointmentWorkflowController.getTodayQueue IST date handling', () => {
  it('uses the IST clinic date for the doctor queue and ED same-day join', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-21T20:00:00Z'));
    queryUnsafeMock.mockResolvedValueOnce([]);
    const res = {
      req: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await getTodayQueue({
      query: { doctor_id: '9' },
      params: {},
      user: { id: 20, role: 'RECEPTIONIST' },
    }, res);

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, today, doctorId] = queryUnsafeMock.mock.calls[0];
    expect(today).toBe('2026-05-22');
    expect(doctorId).toBe(9);
    expect(sql).toContain('a.appointment_date::date = $1::date');
    expect(sql).toContain("DATE(arrival_at AT TIME ZONE 'Asia/Kolkata') = $1::date");
    expect(sql).not.toContain('CURRENT_DATE');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('constrains doctor callers to their own appointment queue', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ department: 'General Medicine' }])
      .mockResolvedValueOnce([]);
    const res = {
      req: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await getTodayQueue({
      query: { doctor_id: '99' },
      params: {},
      user: { id: 11, role: 'DOCTOR' },
    }, res);

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    const [sql, _today, doctorId, department] = queryUnsafeMock.mock.calls[1];
    expect(doctorId).toBe(11);
    expect(department).toBe('General Medicine');
    expect(sql).toContain('a.doctor_id=$2');
    expect(sql).toContain('a.doctor_id IS NULL');
    expect(sql).toContain("LOWER(COALESCE(a.department, '')) = LOWER($3)");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects broad queue access for unsupported roles', async () => {
    const res = {
      req: {},
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await getTodayQueue({
      query: {},
      params: {},
      user: { id: 12, role: 'HOUSEKEEPING_STAFF' },
    }, res);

    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: 'OP appointment queue is not available for this role',
      }),
    );
  });
});
