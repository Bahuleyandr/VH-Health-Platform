import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const usersFindUnique = jest.fn();
const generateAnnualTaxSummary = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafe,
    users: {
      findUnique: usersFindUnique,
    },
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/staff/attendanceService.js', () => ({}));

jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  calculateArrears: jest.fn(),
  calculatePayslip: jest.fn(),
  generateAnnualTaxSummary,
  savePayslip: jest.fn(),
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

const { getTodayBreaks } = await import('../../controllers/staff/attendanceController.js');
const { getMyOvertimeRequests } = await import('../../controllers/staff/overtimeController.js');
const {
  getAllAdvances,
  getMyAdvances,
  getMyDeclarations,
  getMyPayslipQueries,
  getMyTaxSummary,
} = await import('../../controllers/staff/payrollController.js');

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
});
