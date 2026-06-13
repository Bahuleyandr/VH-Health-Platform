import { jest } from '@jest/globals';

const usersFindMany = jest.fn();
const staffFindMany = jest.fn();
const staffAttendanceFindMany = jest.fn();
const queryRaw = jest.fn();

const __prismaDefaultMock = {
  users: { findMany: usersFindMany },
  staff: { findMany: staffFindMany },
  staff_attendance: { findMany: staffAttendanceFindMany },
  $queryRaw: queryRaw,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
  },
}));

const { getHRDashboardData } = await import('../../services/staff/hr/dashboardService.js');

describe('HR dashboard attendance overview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    staffFindMany.mockResolvedValue([]);
    queryRaw.mockResolvedValue([
      {
        total: 0,
        approved: 0,
        rejected: 0,
        pending: 0,
        currently_on_leave: 0,
      },
    ]);
  });

  it('uses current-day attendance rows instead of stale staff last_check_in fields', async () => {
    const now = new Date();
    const staleOpenCheckIn = new Date(now);
    staleOpenCheckIn.setDate(staleOpenCheckIn.getDate() - 3);
    const todaysLateCheckIn = new Date(now);
    todaysLateCheckIn.setHours(10, 5, 0, 0);

    usersFindMany
      .mockResolvedValueOnce([
        {
          id: 2,
          uid: '11111111-1111-4111-8111-111111111111',
          staff: [
            {
              id: 10,
              user_id: '11111111-1111-4111-8111-111111111111',
              is_active: true,
              hire_date: null,
              last_check_in: staleOpenCheckIn,
              last_check_out: null,
              salary: null,
              department: 'Nursing',
            },
          ],
        },
        {
          id: 5,
          uid: '22222222-2222-4222-8222-222222222222',
          staff: [
            {
              id: 20,
              user_id: '22222222-2222-4222-8222-222222222222',
              is_active: true,
              hire_date: null,
              last_check_in: null,
              last_check_out: null,
              salary: null,
              department: 'Medical',
            },
          ],
        },
      ])
      .mockResolvedValueOnce([]);
    staffAttendanceFindMany
      .mockResolvedValueOnce([
        {
          staff_id: 5,
          staff_uid: null,
          check_in_time: todaysLateCheckIn,
          check_out_time: null,
          attendance_status: 'late',
          minutes_late: 35,
        },
      ])
      .mockResolvedValueOnce([]);

    const dashboard = await getHRDashboardData();

    expect(usersFindMany.mock.calls[0][0].where.role.in).not.toEqual(
      expect.arrayContaining(['SUPER_ADMIN', 'ADMIN']),
    );
    expect(staffAttendanceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          check_in_time: {
            gte: expect.any(Date),
            lt: expect.any(Date),
          },
        },
      }),
    );
    expect(dashboard.overview).toMatchObject({
      active_staff: 2,
      present_today: 1,
      currently_checked_in: 1,
      late_arrivals_today: 1,
      attendance_rate: 50,
    });
    expect(dashboard.attendance).toMatchObject({
      presentToday: 1,
      currentlyCheckedIn: 1,
      lateArrivals: 1,
      absentees: 1,
      averageAttendanceRate: 50,
      source: 'staff_attendance_today',
    });
    expect(dashboard.departmentBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ department: 'Nursing', present_today: 0 }),
        expect.objectContaining({ department: 'Medical', present_today: 1 }),
      ]),
    );
  });
});
