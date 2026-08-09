import { jest } from '@jest/globals';

// M20: characterization tests for the admin dashboard handlers extracted from
// routes/admin/index.js into routes/admin/dashboardController.js. They lock in
// the response contracts the extraction touched: standard endpoints emit the
// success() envelope; the two *summary endpoints keep their bespoke top-level
// `links` block; error paths emit the error() 500 envelope with the specific
// (safe) message preserved.

// ESM static imports bind at link time, so the mock must expose EVERY name the
// controller imports (even ones these tests never call) or the import fails.
const SERVICE_NAMES = [
  'getUserStats', 'getDoctorStats', 'getDepartmentStats', 'getAppointmentStats',
  'getRecordStats', 'getEmergencyStats', 'getStaffStats', 'getQuickStats',
  'getAppointmentSummary', 'getRecentActivity', 'getSystemAlerts', 'getModuleHealth',
  'getSystemHealth', 'refreshDashboardCache', 'generateDashboardReport',
  'getAttendanceAnalytics', 'getAttendanceAnomalies', 'getLateArrivals',
  'getEarlyDepartures', 'getAbsentReport', 'getSosAnalytics', 'getAllAlerts',
  // The SOS mutators moved to services/sosService.js and updateSystemConfig was
  // deleted outright (audit F1), so this barrel no longer supplies them.
  'getEmergencyServices', 'getPerformanceReport', 'getUploadSummary',
  'listQuarantinedFiles', 'getHipaaAuditReport', 'rescanFile',
  'cleanupExpiredFiles', 'bulkUpdateHipaaProtection', 'purgeQuarantinedFiles',
];
const svc = Object.fromEntries(SERVICE_NAMES.map((n) => [n, jest.fn()]));
jest.unstable_mockModule('../../routes/admin/services/index.js', () => svc);
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const ctrl = await import('../../routes/admin/dashboardController.js');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    // success()/error() read res.req?.id for the requestId correlation field.
    req: { id: 'req-abc', originalUrl: '/api/v1/admin/x' },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('standard endpoints use the success() envelope', () => {
  it('statsUsers returns { success, message, data, requestId } from getUserStats', async () => {
    svc.getUserStats.mockResolvedValueOnce({ total: 7, active: 5 });
    const res = mockRes();
    await ctrl.statsUsers({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'User stats',
      data: { total: 7, active: 5 },
      requestId: 'req-abc',
    });
  });

  it('moduleHealth (no try/catch in the original) returns the success envelope', async () => {
    svc.getModuleHealth.mockResolvedValueOnce({ db: 'ok' });
    const res = mockRes();
    await ctrl.moduleHealth({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { db: 'ok' } });
  });
});

describe('bespoke-shape endpoints keep their top-level links block', () => {
  it('staffSummary returns { success, data, links } verbatim (not wrapped under data)', async () => {
    svc.getStaffStats.mockResolvedValueOnce({ total_staff: 12 });
    const res = mockRes();
    await ctrl.staffSummary({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ total_staff: 12 });
    // The links block stays at the TOP level — converting to success() would
    // have buried it under `data`, breaking the consumer contract.
    expect(res.body.links).toEqual({
      analytics: '/api/v1/staff/admin/analytics/attendance',
      hrDashboard: '/api/v1/staff/admin/dashboard',
      pendingActions: '/api/v1/staff/admin/hr/pending-reviews',
      attendance: '/api/v1/staff/admin/attendance/anomalies',
    });
  });

  it('appointmentsSummary keeps its links block', async () => {
    svc.getAppointmentSummary.mockResolvedValueOnce({ today: 3 });
    const res = mockRes();
    await ctrl.appointmentsSummary({}, res);
    expect(res.body.data).toEqual({ today: 3 });
    expect(res.body.links.noShows).toBe('/api/v1/admin/appointments/no-shows');
  });
});

describe('error path → error() 500 envelope with the specific message preserved', () => {
  it('statsUsers maps a service failure to a 500 with the safe specific message', async () => {
    svc.getUserStats.mockRejectedValueOnce(new Error('db boom'));
    const res = mockRes();
    await ctrl.statsUsers({}, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ success: false, message: 'Failed to get user stats' });
    // The raw error text never reaches the body.
    expect(JSON.stringify(res.body)).not.toContain('db boom');
  });
});
