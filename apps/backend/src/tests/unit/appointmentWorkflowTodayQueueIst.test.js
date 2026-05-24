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
      user: {},
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
});
