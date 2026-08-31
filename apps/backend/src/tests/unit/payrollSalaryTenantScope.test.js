import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const salaryUpsert = jest.fn();
const calculateArrears = jest.fn();
const generateAnnualTaxSummary = jest.fn();

const prismaMock = {
  $queryRawUnsafe: queryRawUnsafe,
  staff_salary: {
    upsert: salaryUpsert,
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  // payrollController imports `setTenant` at module scope for its other
  // exports (the payslip and arrears paths). The three salary-config handlers
  // under test go straight through the default client, but the named export
  // still has to exist or the controller module will not load at all. Route it
  // to the same mock so any handler that does open a tenant transaction sees
  // the identical client — matching the sibling payroll suites.
  setTenant: jest.fn(async (_tenantId, fn) => fn(prismaMock)),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  calculateArrears,
  editPayslipAndRegenerate: jest.fn(),
  executePayrollRun: jest.fn(),
  generateAnnualTaxSummary,
  issuePayrollRun: jest.fn(),
  revealPayslipCredential: jest.fn(),
  signPayrollRun: jest.fn(),
  // Controller narrows on `err instanceof SalaryArrearsCommandError` to pick the
  // status code, so the mock has to be a real class, not a jest.fn().
  SalaryArrearsCommandError: class SalaryArrearsCommandError extends Error {
    constructor(message, statusCode = 409) {
      super(message);
      this.name = 'SalaryArrearsCommandError';
      this.statusCode = statusCode;
    }
  },
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getSignedFileUrl: jest.fn(),
}));

const {
  calculateRevisionArrears,
  createAdvance,
  generateAllTaxSummaries,
  getAllAdvances,
  getMyAdvances,
  getMyTaxSummary,
  getStaffForPayroll,
  getStaffSalaryConfig,
  upsertStaffSalaryConfig,
} = await import('../../controllers/staff/payrollController.js');

const TENANT_ID = '8e000000-0000-4000-8000-000000000001';
const STAFF_UID = '8e000000-0000-4000-8000-000000000002';

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('payroll salary configuration tenant scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes the staff picker and both optional joins to the resolved tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const res = makeRes();
    await getStaffForPayroll({
      tenantId: TENANT_ID,
      query: { search: 'nurse', department: 'ward' },
    }, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      TENANT_ID,
      '%nurse%',
      '%ward%',
    );
    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('u.tenant_id = $1::uuid');
    expect(sql).toContain('s.tenant_id = u.tenant_id AND s.user_id = u.uid');
    expect(sql).toContain('ss.tenant_id = u.tenant_id AND ss.staff_uid = u.uid');
    expect(sql).toContain('u.name ILIKE $2');
    expect(sql).toContain('s.department ILIKE $3');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('scopes salary reads, user identity, and staff joins to the resolved tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 41,
      staff_uid: STAFF_UID,
      basic_salary: '85000.00',
      bank_account: '1234567890',
      pan_number: 'ABCDE1234F',
    }]);

    const res = makeRes();
    await getStaffSalaryConfig({
      tenantId: TENANT_ID,
      params: { staffUid: STAFF_UID },
    }, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.any(String),
      STAFF_UID,
      TENANT_ID,
    );
    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('ss.tenant_id = $2::uuid');
    expect(sql).toContain('u.tenant_id = ss.tenant_id AND u.uid = ss.staff_uid');
    expect(sql).toContain('s.tenant_id = ss.tenant_id AND s.user_id = u.uid');
    expect(sql).not.toContain('SELECT ss.*');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('does not fall back to a user from another tenant when no config exists', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = makeRes();
    await getStaffSalaryConfig({
      tenantId: TENANT_ID,
      params: { staffUid: STAFF_UID },
    }, res);

    expect(queryRawUnsafe.mock.calls[1]).toEqual([
      expect.stringContaining('tenant_id = $2::uuid AND uid = $1::uuid'),
      STAFF_UID,
      TENANT_ID,
    ]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: null }));
  });

  it('rejects a salary mutation when the staff identity is absent from the tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const res = makeRes();
    await upsertStaffSalaryConfig({
      tenantId: TENANT_ID,
      params: { staffUid: STAFF_UID },
      body: { basic_salary: 85000 },
    }, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = $2::uuid AND uid = $1::uuid'),
      STAFF_UID,
      TENANT_ID,
    );
    expect(salaryUpsert).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates and updates salary configuration only by tenant and staff identity', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ uid: STAFF_UID, name: 'Tenant Staff' }]);
    salaryUpsert.mockResolvedValueOnce({
      id: 41,
      staff_uid: STAFF_UID,
      basic_salary: '85000.00',
      bank_account: null,
      pan_number: null,
    });

    const res = makeRes();
    await upsertStaffSalaryConfig({
      tenantId: TENANT_ID,
      params: { staffUid: STAFF_UID },
      body: { basic_salary: 85000 },
    }, res);

    expect(salaryUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        tenant_id_staff_uid: {
          tenant_id: TENANT_ID,
          staff_uid: STAFF_UID,
        },
      },
      create: expect.objectContaining({
        tenant_id: TENANT_ID,
        staff_uid: STAFF_UID,
        basic_salary: 85000,
      }),
      update: expect.objectContaining({
        basic_salary: 85000,
      }),
    }));
    expect(salaryUpsert.mock.calls[0][0].update).not.toHaveProperty('tenant_id');
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('payroll tax, arrears, and advances controller tenant propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('tenant-binds the self tax-summary read and generation call', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    generateAnnualTaxSummary.mockResolvedValueOnce({
      id: 61,
      staff_uid: STAFF_UID,
      financial_year: '2026-27',
    });

    const res = makeRes();
    await getMyTaxSummary({
      tenantId: TENANT_ID,
      user: { uid: STAFF_UID },
      query: { fy: '2026-27' },
    }, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('tenant_id = $3::uuid'),
      STAFF_UID,
      '2026-27',
      TENANT_ID,
    );
    expect(generateAnnualTaxSummary).toHaveBeenCalledWith(
      STAFF_UID,
      '2026-27',
      TENANT_ID,
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns a conflict when the tenant-bound annual-summary upsert is rejected', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);
    generateAnnualTaxSummary.mockRejectedValueOnce(Object.assign(
      new Error('Annual tax summary could not be stored for this tenant'),
      { code: 'ANNUAL_TAX_SUMMARY_TENANT_CONFLICT' },
    ));

    const res = makeRes();
    await getMyTaxSummary({
      tenantId: TENANT_ID,
      user: { uid: STAFF_UID },
      query: { fy: '2026-27' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('tenant-binds mass summary enumeration and every generation call', async () => {
    const secondStaffUid = '8e000000-0000-4000-8000-000000000003';
    queryRawUnsafe.mockResolvedValueOnce([
      { staff_uid: STAFF_UID },
      { staff_uid: secondStaffUid },
    ]);
    generateAnnualTaxSummary.mockResolvedValue({ id: 61 });

    const res = makeRes();
    await generateAllTaxSummaries({
      tenantId: TENANT_ID,
      body: { financial_year: '2026-27' },
    }, res);

    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = $1::uuid'),
      TENANT_ID,
    );
    expect(generateAnnualTaxSummary).toHaveBeenNthCalledWith(
      1,
      STAFF_UID,
      '2026-27',
      TENANT_ID,
    );
    expect(generateAnnualTaxSummary).toHaveBeenNthCalledWith(
      2,
      secondStaffUid,
      '2026-27',
      TENANT_ID,
    );
  });

  it('passes the resolved tenant to arrears calculation', async () => {
    calculateArrears.mockResolvedValueOnce({ arrears_amount: 5000, months: 1 });

    const res = makeRes();
    await calculateRevisionArrears({
      tenantId: TENANT_ID,
      params: { revisionId: '41' },
    }, res);

    // The arrears command now takes a third options argument carrying the
    // idempotency/command evidence. The invariant this test exists for is
    // unchanged: the RESOLVED tenant is what gets passed, in position two.
    expect(calculateArrears).toHaveBeenCalledWith(41, TENANT_ID, expect.any(Object));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns not found for a revision outside the resolved tenant', async () => {
    calculateArrears.mockRejectedValueOnce(Object.assign(
      new Error('Revision not found or not applied'),
      { code: 'SALARY_REVISION_NOT_FOUND' },
    ));

    const res = makeRes();
    await calculateRevisionArrears({
      tenantId: TENANT_ID,
      params: { revisionId: '41' },
    }, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('creates an advance only from a staff identity in the resolved tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 71,
      staff_uid: STAFF_UID,
      amount: '10000.00',
      monthly_deduction: '1000.00',
    }]);

    const res = makeRes();
    await createAdvance({
      tenantId: TENANT_ID,
      user: { uid: '8e000000-0000-4000-8000-000000000004' },
      body: {
        staff_uid: STAFF_UID,
        amount: 10000,
        monthly_deduction: 1000,
        reason: 'Emergency advance',
      },
    }, res);

    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('tenant_id)');
    expect(sql).toContain('WHERE u.tenant_id = $10::uuid AND u.uid = $1::uuid');
    expect(params[0]).toBe(STAFF_UID);
    expect(params[9]).toBe(TENANT_ID);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects an advance when the staff identity is absent from the resolved tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const res = makeRes();
    await createAdvance({
      tenantId: TENANT_ID,
      user: { uid: '8e000000-0000-4000-8000-000000000004' },
      body: {
        staff_uid: STAFF_UID,
        amount: 10000,
        monthly_deduction: 1000,
        reason: 'Emergency advance',
      },
    }, res);

    expect(queryRawUnsafe.mock.calls[0][0]).toContain(
      'WHERE u.tenant_id = $10::uuid AND u.uid = $1::uuid',
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('tenant-binds self and administrative advance listings', async () => {
    queryRawUnsafe.mockResolvedValue([]);

    const selfRes = makeRes();
    await getMyAdvances({
      tenantId: TENANT_ID,
      user: { uid: STAFF_UID },
      query: {},
    }, selfRes);
    const [selfSql, ...selfParams] = queryRawUnsafe.mock.calls[0];
    expect(selfSql).toContain('WHERE sa.tenant_id = $2::uuid AND sa.staff_uid = $1::uuid');
    expect(selfSql).toContain('u.tenant_id = sa.tenant_id');
    expect(selfSql).not.toContain('SELECT sa.*');
    expect(selfParams).toEqual([STAFF_UID, TENANT_ID]);

    const adminRes = makeRes();
    await getAllAdvances({
      tenantId: TENANT_ID,
      query: { status: 'approved' },
    }, adminRes);
    const [adminSql, ...adminParams] = queryRawUnsafe.mock.calls[1];
    expect(adminSql).toContain('WHERE sa.tenant_id = $1::uuid');
    expect(adminSql).toContain('ss.tenant_id = sa.tenant_id');
    expect(adminSql).not.toContain('SELECT sa.*');
    expect(adminParams).toEqual([TENANT_ID, 'approved']);
  });
});
