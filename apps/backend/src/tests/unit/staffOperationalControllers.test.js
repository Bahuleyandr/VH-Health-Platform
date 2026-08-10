import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const usersFindUnique = jest.fn();
const usersFindMany = jest.fn();
const staffFindMany = jest.fn();
const staffAttendanceFindMany = jest.fn();
const generateAnnualTaxSummary = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
  users: {
    findUnique: usersFindUnique,
    findMany: usersFindMany,
  },
  staff: {
    findMany: staffFindMany,
  },
  staff_attendance: {
    findMany: staffAttendanceFindMany,
  },
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
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/staff/attendanceService.js', () => ({}));

jest.unstable_mockModule('../../services/auth/staffAuthService.js', () => ({
  StaffAuthService: {
    authenticateStaff: jest.fn(),
    authenticateStaffWithPin: jest.fn(),
    registerStaffDevice: jest.fn(),
    quickLogin: jest.fn(),
    setupPin: jest.fn(),
    toggleBiometric: jest.fn(),
    refreshStaffSession: jest.fn(),
    logoutStaff: jest.fn(),
    listStaffDevices: jest.fn(),
    removeDevice: jest.fn(),
    markAttendance: jest.fn(),
    getAttendanceStatus: jest.fn(),
    checkDeviceStatus: jest.fn(),
  },
}));

// The factory must mirror every named export payrollController imports, or the
// controller's import fails to link. Run-accounting behaviour is covered in
// src/tests/unit/payrollFailLoud.test.js; nothing here exercises runPayroll.
jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  calculateArrears: jest.fn(),
  calculatePayslip: jest.fn(),
  generateAnnualTaxSummary,
  savePayslip: jest.fn(),
  recordPayrollFailure: jest.fn(),
  summarizePayrollRunOutcome: jest.fn(),
}));

jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(),
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getSignedFileUrl: jest.fn(),
  uploadFileToR2: jest.fn(),
}));

jest.unstable_mockModule('../../utils/payslipPDF.js', () => ({
  generatePayslipPDF: jest.fn(),
}));

const { getGeofenceBreaches, getTodayBreaks, requestRegularization } = await import('../../controllers/staff/attendanceController.js');
const { getHealthStatus } = await import('../../controllers/auth/staffAuthController.js');
const {
  getAttendanceAuditDashboard,
  getAttendanceHRActivity,
  getAttendanceSLAReport,
  getLeaveAuditTrail,
} = await import('../../controllers/staff/attendanceAuditController.js');
const { getMyOvertimeRequests } = await import('../../controllers/staff/overtimeController.js');
const { getAuditDashboard, getAdminActivityReport, getReportAuditTrail } = await import('../../controllers/staff/reportAuditController.js');
const {
  getAttendanceAnomalies,
  getLateArrivals,
} = await import('../../controllers/staff/staffAdminAttendanceController.js');
const {
  getEfficiencyReport,
  getOvertimeReport,
  getPerformanceAnalytics,
} = await import('../../controllers/staff/staffAdminAnalyticsController.js');
const { getStaffAdminDashboard } = await import('../../controllers/staff/staffAdminDashboardController.js');
const {
  getAllLeaveRequests,
  getLeavePatterns,
} = await import('../../controllers/staff/staffAdminLeaveController.js');
const { getOnboardingStatus } = await import('../../controllers/staff/staffAdminHRController.js');
const { advancedStaffSearch } = await import('../../controllers/staff/staffAdminOperationsController.js');
const {
  getAllAdvances,
  getPayslipDetail,
  getPayrollRunDetail,
  getStaffSalaryConfig,
  getMyAdvances,
  getMyDeclarations,
  getMyPayslipQueries,
  getMyTaxSummary,
} = await import('../../controllers/staff/payrollController.js');
const { getRevisionDetail } = await import('../../controllers/staff/salaryRevisionController.js');
const { generateStaffReport } = await import('../../services/staff/hr/reportingService.js');
const { getStaffByDepartment, getStaffByShift, getStaffStatistics } = await import('../../services/staff/staffService.js');

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('staff operational endpoint drift guards', () => {
  const staffUid = '930cc1d5-0bd2-4739-86ad-844f59ea439d';

  beforeEach(() => {
    jest.clearAllMocks();
    usersFindUnique.mockResolvedValue({ id: 5, uid: staffUid });
  });

  it('reads staff breaks by integer users.id after resolving the JWT uid', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { user: { uid: staffUid }, params: {}, query: {} };
    const res = makeRes();

    await getTodayBreaks(req, res);

    expect(usersFindUnique).toHaveBeenCalledWith({
      where: { uid: staffUid },
      select: { id: true, uid: true },
    });
    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('FROM staff_breaks');
    expect(sql).toContain('DATE(b.break_start)=$2::date');
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), 5, expect.any(String));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reads overtime requests by integer users.id after resolving the JWT uid', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { user: { uid: staffUid }, params: {}, query: {} };
    const res = makeRes();

    await getMyOvertimeRequests(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE o.staff_id = $1'),
      5
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('casts salary advance staff uid parameters to uuid', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { user: { uid: staffUid }, query: {} };
    const res = makeRes();

    await getMyAdvances(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE sa.staff_uid = $1::uuid'),
      staffUid
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns current investment declaration fields plus legacy aggregate aliases', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { user: { uid: staffUid }, query: {} };
    const res = makeRes();

    await getMyDeclarations(req, res);

    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('ppf');
    expect(sql).toContain('AS section_80c');
    expect(sql).toContain('WHERE staff_uid=$1::uuid');
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), staffUid);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('spreads payroll list filters instead of passing parameter arrays', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { query: { status: 'approved' } };
    const res = makeRes();

    await getAllAdvances(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      'approved'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('casts payslip query staff uid parameters to uuid', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { user: { uid: staffUid }, query: {} };
    const res = makeRes();

    await getMyPayslipQueries(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE pq.staff_uid=$1::uuid'),
      staffUid
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns a clean no-data tax summary when no issued payslips exist', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    generateAnnualTaxSummary.mockRejectedValueOnce(new Error('No payslips found for this financial year'));

    const req = { user: { uid: staffUid }, query: { fy: '2025-26' } };
    const res = makeRes();

    await getMyTaxSummary(req, res);

    expect(generateAnnualTaxSummary).toHaveBeenCalledWith(staffUid, '2025-26');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      staff_uid: staffUid,
      financial_year: '2025-26',
      months_included: 0,
      status: 'unavailable',
    });
  });

  it('maps attendance anomalies to existing CTE columns', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const res = makeRes();

    await getAttendanceAnomalies({}, res);

    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('id as staff_id');
    expect(sql).toContain('0 as absent_days');
    expect(sql).toContain('missing_checkout_days');
    expect(sql).not.toContain('staff_uid, name, late_days, early_leave_days, absent_days');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('spreads staff admin attendance report filters and casts dates', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { query: { date: '2026-05-04', department: 'nursing' } };
    const res = makeRes();

    await getLateArrivals(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('a.check_in_time::date = $1::date'),
      '2026-05-04',
      'nursing'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('uses current performance review table in staff admin dashboard', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ staff: {}, attendance: {}, hr_actions: {} }])
      .mockResolvedValueOnce([]);

    const res = makeRes();

    await getStaffAdminDashboard({}, res);

    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('FROM staff_performance_reviews');
    expect(sql).toContain('WHERE review_date IS NULL');
    expect(sql).not.toContain('FROM performance_reviews');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('uses current performance review table and spread params for admin analytics', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { query: { department: 'nursing', timeframe: 'monthly' } };
    const res = makeRes();

    await getPerformanceAnalytics(req, res);

    expect(queryRawUnsafe.mock.calls[0][0]).toContain('ROUND(AVG(pr.rating)::numeric, 2)');
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM staff_performance_reviews pr'),
      'nursing'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('spreads efficiency and overtime report parameters', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await getEfficiencyReport(
      { query: { start_date: '2026-05-01', end_date: '2026-05-04', department: 'lab' } },
      makeRes()
    );
    await getOvertimeReport(
      { query: { month: '5', year: '2026', department: 'lab' } },
      makeRes()
    );

    expect(queryRawUnsafe.mock.calls[0]).toEqual([
      expect.stringContaining('LEFT JOIN staff_performance_reviews pr'),
      '2026-05-01',
      '2026-05-04',
      'lab',
    ]);
    expect(queryRawUnsafe.mock.calls[1]).toEqual([
      expect.stringContaining('EXTRACT(MONTH FROM a.check_in_time)::int = $1::int'),
      '5',
      '2026',
      'lab',
    ]);
  });

  it('spreads leave report filters and casts the year', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await getLeavePatterns({ query: { year: '2026', department: 'nursing' } }, makeRes());
    await getAllLeaveRequests({ query: { status: 'pending', department: 'nursing' } }, makeRes());

    expect(queryRawUnsafe.mock.calls[0]).toEqual([
      expect.stringContaining('EXTRACT(YEAR FROM la.start_date)::int = $1::int'),
      '2026',
      'nursing',
    ]);
    expect(queryRawUnsafe.mock.calls[1]).toEqual([
      expect.any(String),
      'pending',
      'nursing',
    ]);
  });

  it('builds advanced staff search with safe performance table, sort whitelist, and count subquery', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);

    const req = {
      query: {
        department: 'nursing',
        attendance_rate_min: '80',
        sort_by: 'name; DROP TABLE users',
        order: 'desc',
        page: '2',
        limit: '10',
      },
    };
    const res = makeRes();

    await advancedStaffSearch(req, res);

    const searchSql = queryRawUnsafe.mock.calls[0][0];
    const countSql = queryRawUnsafe.mock.calls[1][0];
    expect(searchSql).toContain('FROM staff_performance_reviews');
    expect(searchSql).toContain('ORDER BY u.name DESC');
    expect(searchSql).not.toContain('DROP TABLE');
    expect(countSql).toContain('SELECT COUNT(*) as count FROM (');
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual(['nursing', 80, 10, 10]);
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual(['nursing', 80]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('normalizes BigInt shift counts before attendance-rate math', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{
        total_staff: 2n,
        active_staff: 2n,
        inactive_staff: 0n,
        average_salary: null,
        currently_checked_in: 1n,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ shift: 'morning', count: 2n, checked_in_count: 1n }])
      .mockResolvedValueOnce([{ staff_with_attendance: 0n, total_attendance_records: 0n, avg_daily_hours: null }]);

    const result = await getStaffStatistics('ADMIN', 'monthly');

    expect(result.shifts[0]).toMatchObject({
      count: 2,
      checked_in_count: 1,
      attendance_rate: 50,
    });
  });

  it('casts geofence breach filters and clamps limits', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const req = { query: { limit: '999', staff_id: '4' } };
    const res = makeRes();

    await getGeofenceBreaches(req, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('gb.staff_id = $2::int'),
      200,
      4
    );
    expect(queryRawUnsafe.mock.calls[0][0]).toContain('LIMIT $1::int');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('casts regularization route params before inserting', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ id: 1, staff_id: 2 }]);
    const res = makeRes();

    await requestRegularization({
      params: { id: '2' },
      body: {
        date: '2026-05-04',
        reason: 'Forgot checkout',
        check_in_time: '2026-05-04T09:00:00Z',
      },
    }, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('VALUES ($1::int, $2::date'),
      2,
      '2026-05-04',
      'Forgot checkout',
      '2026-05-04T09:00:00Z',
      null,
    );
    expect(queryRawUnsafe.mock.calls[0][0]).toContain('requested_check_in=$4::timestamptz');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('spreads department and shift staff lookup params and joins attendance by users.id', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await getStaffByDepartment('nursing', null, false, 'ADMIN');
    await getStaffByShift('morning', null, '2026-05-04', 'ADMIN');

    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual(['nursing', expect.any(Array)]);
    expect(queryRawUnsafe.mock.calls[1][0]).toContain('u.id = att.staff_id');
    expect(queryRawUnsafe.mock.calls[1][0]).toContain('DATE(att.check_in_time) = $3::date');
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual(['morning', expect.any(Array), '2026-05-04']);
  });

  it('casts detail route ids and UUID params for payroll and audit details', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await getPayslipDetail({ params: { id: '1' }, user: { uid: staffUid } }, makeRes());
    await getPayrollRunDetail({ params: { runId: '1' } }, makeRes());
    await getStaffSalaryConfig({ params: { staffUid } }, makeRes());
    await getRevisionDetail({ params: { id: '1' } }, makeRes());
    await getReportAuditTrail({ params: { type: 'incident', id: '1' } }, makeRes());
    await getLeaveAuditTrail({ params: { id: '1' } }, makeRes());

    expect(queryRawUnsafe.mock.calls[0]).toEqual([
      expect.stringContaining('p.id = $1::int'),
      1,
      staffUid,
    ]);
    expect(queryRawUnsafe.mock.calls[1]).toEqual([
      expect.stringContaining('p.payroll_run_id = $1::int'),
      1,
    ]);
    expect(queryRawUnsafe.mock.calls[2]).toEqual([
      expect.stringContaining('FROM payroll_runs'),
      1,
    ]);
    expect(queryRawUnsafe.mock.calls[3]).toEqual([
      expect.stringContaining('ss.staff_uid = $1::uuid'),
      staffUid,
    ]);
    expect(queryRawUnsafe.mock.calls[4]).toEqual([
      expect.stringContaining('users WHERE uid = $1::uuid'),
      staffUid,
    ]);
    expect(queryRawUnsafe.mock.calls[5]).toEqual([
      expect.stringContaining('sr.id = $1::int'),
      1,
    ]);
    expect(queryRawUnsafe.mock.calls[6]).toEqual([
      expect.stringContaining('ir.id = $1::int'),
      1,
    ]);
    expect(queryRawUnsafe.mock.calls[7]).toEqual([
      expect.stringContaining('lr.id = $1::int'),
      1,
    ]);
  });

  it('masks anonymous report sender identity in audit trail responses for HR', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 1,
          report_number: 'INC-20260504-a1b2c3d4',
          reporter_id: staffUid,
          reporter_name: 'Clinical Staff One',
          reporter_dept: 'Nursing',
          actual_reporter_name: 'Clinical Staff One',
          actual_reporter_dept: 'Nursing',
          is_anonymous: true,
          severity: 'moderate',
          status: 'submitted',
          created_at: new Date().toISOString(),
          resolved_at: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const res = makeRes();
    await getReportAuditTrail(
      { params: { type: 'incident', id: '1' }, user: { role: 'HR_STAFF' } },
      res
    );

    const report = res.json.mock.calls[0][0].data.report;
    expect(report.reporter_name).toBe('Anonymous');
    expect(report.reporter_dept).toBeNull();
    expect(report.reporter_id).toBeNull();
    expect(report.anonymous_reporter_name).toBeUndefined();
    expect(report.actual_reporter_name).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('reveals anonymous report sender identity in audit trail responses for admin tier', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        {
          id: 1,
          grievance_number: 'GRV-20260504-e5f6a7b8',
          reporter_id: staffUid,
          reporter_name: 'Anonymous',
          reporter_dept: null,
          actual_reporter_name: 'Clinical Staff One',
          actual_reporter_dept: 'Nursing',
          is_anonymous: true,
          priority: 'normal',
          status: 'submitted',
          created_at: new Date().toISOString(),
          resolved_at: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const res = makeRes();
    await getReportAuditTrail(
      { params: { type: 'grievance', id: '1' }, user: { role: 'ADMIN' } },
      res
    );

    const report = res.json.mock.calls[0][0].data.report;
    expect(report.reporter_name).toBe('Anonymous');
    expect(report.anonymous_reporter_name).toBe('Clinical Staff One');
    expect(report.anonymous_reporter_department).toBe('Nursing');
    expect(report.anonymous_reporter_uid).toBe(staffUid);
    expect(report.actual_reporter_name).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns staff auth health without calling a missing service method', async () => {
    const res = makeRes();

    await getHealthStatus({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toMatchObject({
      service: 'staff-auth',
      status: 'healthy',
    });
  });

  it('uses the current staff onboarding task table', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    const res = makeRes();

    await getOnboardingStatus({}, res);

    expect(queryRawUnsafe.mock.calls[0][0]).toContain('LEFT JOIN staff_onboarding_tasks ot');
    expect(queryRawUnsafe.mock.calls[0][0]).not.toContain('LEFT JOIN onboarding_tasks');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('joins report audit UUID foreign keys through users.uid', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    const res = makeRes();

    await getAuditDashboard({}, res);
    await getAdminActivityReport({ query: { days: '30' } }, res);

    const combinedSql = queryRawUnsafe.mock.calls.map(([sql]) => sql).join('\n');
    expect(combinedSql).toContain('ir.assigned_to = u.uid');
    expect(combinedSql).toContain('ru.author_id = u.uid');
    expect(combinedSql).toContain('sg.assigned_to = u.uid');
    expect(combinedSql).not.toContain('ru.author_id = u.id');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('uses leave_applications and reports attendance audit query failures honestly', async () => {
    queryRawUnsafe.mockRejectedValue(new Error('missing relation'));
    const dashboardRes = makeRes();
    const activityRes = makeRes();
    const slaRes = makeRes();

    await getAttendanceAuditDashboard({}, dashboardRes);
    await getAttendanceHRActivity({ query: { days: '30' } }, activityRes);
    await getAttendanceSLAReport({ query: { days: '30' } }, slaRes);

    const combinedSql = queryRawUnsafe.mock.calls.map(([sql]) => sql).join('\n');
    expect(combinedSql).toContain('FROM leave_applications');
    expect(combinedSql).not.toContain('FROM leave_requests');
    expect(dashboardRes.status).toHaveBeenCalledWith(500);
    expect(activityRes.status).toHaveBeenCalledWith(500);
    expect(slaRes.status).toHaveBeenCalledWith(500);
  });

  it('accepts the legacy type query alias for HR staff reports', async () => {
    staffFindMany.mockResolvedValueOnce([]);

    const report = await generateStaffReport({
      type: 'payroll',
      generatedBy: staffUid,
    });

    expect(report.report_type).toBe('payroll');
    expect(staffFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { is_active: true },
    }));
  });
});
