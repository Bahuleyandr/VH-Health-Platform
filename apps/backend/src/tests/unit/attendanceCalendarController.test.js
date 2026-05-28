import { jest } from '@jest/globals';

const attendanceFindMany = jest.fn();
const leaveFindMany = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    staff_attendance: { findMany: attendanceFindMany },
    leave_applications: { findMany: leaveFindMany },
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const { getAttendanceCalendar } = await import(
  '../../controllers/staff/attendanceController.js'
);

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('getAttendanceCalendar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds the calendar using typed Prisma model reads', async () => {
    attendanceFindMany.mockResolvedValueOnce([
      {
        check_in_time: new Date('2026-05-04T09:20:00.000Z'),
        check_out_time: new Date('2026-05-04T17:20:00.000Z'),
      },
    ]);
    leaveFindMany.mockResolvedValueOnce([
      {
        start_date: new Date('2026-05-05T00:00:00.000Z'),
        end_date: new Date('2026-05-05T00:00:00.000Z'),
        leave_type: 'casual',
      },
    ]);

    const req = { params: { id: '8' }, query: { month: '5', year: '2026' } };
    const res = makeRes();

    await getAttendanceCalendar(req, res);

    expect(attendanceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staff_id: 8 }),
        select: { check_in_time: true, check_out_time: true },
      })
    );
    expect(leaveFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          staff_id: 8,
          status: { in: ['approved', 'APPROVED'] },
        }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);

    const body = res.json.mock.calls[0][0];
    expect(body.data.summary).toEqual({ present: 1, absent: 19, leave: 1 });
    expect(body.data.days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: '2026-05-04',
          status: 'present',
          hoursWorked: '8.0',
          isLate: true,
        }),
        expect.objectContaining({
          date: '2026-05-05',
          status: 'leave',
          leaveType: 'casual',
        }),
      ])
    );
  });

  it('rejects non-numeric staff ids before hitting the database', async () => {
    const req = { params: { id: 'not-a-number' }, query: {} };
    const res = makeRes();

    await getAttendanceCalendar(req, res);

    expect(attendanceFindMany).not.toHaveBeenCalled();
    expect(leaveFindMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: false,
      message: 'Valid staff id is required',
    });
  });
});
