import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const salaryUpsert = jest.fn();

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
  calculateArrears: jest.fn(),
  editPayslipAndRegenerate: jest.fn(),
  executePayrollRun: jest.fn(),
  generateAnnualTaxSummary: jest.fn(),
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
