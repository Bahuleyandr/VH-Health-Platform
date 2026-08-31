import { jest } from '@jest/globals';

const TENANT_ID = '8f000000-0000-4000-8000-000000000001';
const STAFF_UID = '8f000000-0000-4000-8000-000000000002';

const queryRawUnsafe = jest.fn();
const salaryArrearsCreate = jest.fn();
const txMock = {
  $queryRawUnsafe: queryRawUnsafe,
  salary_arrears: { create: salaryArrearsCreate },
};
const prismaMock = {};
const setTenantTx = jest.fn(async (_tenantId, fn) => fn(txMock));
const requireTenantId = jest.fn((tenantId) => {
  if (!tenantId) {
    const error = new Error('Tenant context required');
    error.code = 'TENANT_CONTEXT_REQUIRED';
    throw error;
  }
  return tenantId;
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId,
}));

jest.unstable_mockModule('../../utils/payslipPDF.js', () => ({
  generatePayslipPDF: jest.fn(),
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getFileFromR2: jest.fn(),
  uploadFileToR2: jest.fn(),
}));

const { calculateArrears, generateAnnualTaxSummary } =
  await import('../../services/staff/payrollService.js');

const ISSUED_PAYSLIP = {
  id: 11,
  staff_uid: STAFF_UID,
  month: 4,
  year: 2026,
  basic_earned: '100000.00',
  hra_earned: '40000.00',
  gross_salary: '150000.00',
  pf_employee: '12000.00',
  professional_tax: '200.00',
  advance_deduction: '5000.00',
  total_deductions: '20000.00',
  net_salary: '130000.00',
  status: 'issued',
};

describe('payroll annual tax summary tenant scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fails before opening a Prisma transaction when tenant context is absent', async () => {
    await expect(generateAnnualTaxSummary(STAFF_UID, '2026-27')).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_REQUIRED',
    });

    expect(setTenantTx).not.toHaveBeenCalled();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('reads and upserts the summary under one explicitly tenant-bound transaction', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([ISSUED_PAYSLIP])
      .mockResolvedValueOnce([{
        id: 21,
        staff_uid: STAFF_UID,
        financial_year: '2026-27',
        total_advance_deductions: '5000.00',
        months_included: 1,
      }]);

    const result = await generateAnnualTaxSummary(STAFF_UID, '2026-27', TENANT_ID);

    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(setTenantTx.mock.calls[0][0]).toBe(TENANT_ID);
    const [payslipSql, ...payslipParams] = queryRawUnsafe.mock.calls[0];
    expect(payslipSql).toContain('WHERE tenant_id = $1::uuid');
    expect(payslipSql).toContain('advance_deduction');
    expect(payslipParams).toEqual([TENANT_ID, STAFF_UID, 2026, 2027]);

    const [upsertSql, ...upsertParams] = queryRawUnsafe.mock.calls[1];
    expect(upsertSql).toContain('INSERT INTO annual_tax_summaries');
    expect(upsertSql).toContain('tenant_id, staff_uid, financial_year');
    expect(upsertSql).toContain('WHERE annual_tax_summaries.tenant_id = EXCLUDED.tenant_id');
    expect(upsertParams.slice(0, 3)).toEqual([TENANT_ID, STAFF_UID, '2026-27']);
    expect(result).toMatchObject({ id: 21, financial_year: '2026-27' });
  });

  it('rejects an upsert identity already owned by another tenant', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([ISSUED_PAYSLIP])
      .mockResolvedValueOnce([]);

    await expect(
      generateAnnualTaxSummary(STAFF_UID, '2026-27', TENANT_ID),
    ).rejects.toMatchObject({
      code: 'ANNUAL_TAX_SUMMARY_TENANT_CONFLICT',
      statusCode: 409,
    });
  });
});

describe('salary arrears tenant scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fails before opening a Prisma transaction when tenant context is absent', async () => {
    await expect(calculateArrears(41)).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_REQUIRED',
    });

    expect(setTenantTx).not.toHaveBeenCalled();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects a revision identity that is not visible in the resolved tenant', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    await expect(calculateArrears(41, TENANT_ID)).rejects.toMatchObject({
      code: 'SALARY_REVISION_NOT_FOUND',
      statusCode: 404,
    });

    const [revisionSql, ...revisionParams] = queryRawUnsafe.mock.calls[0];
    expect(revisionSql).toContain('WHERE tenant_id = $1::uuid AND id = $2');
    expect(revisionParams).toEqual([TENANT_ID, 41]);
    expect(salaryArrearsCreate).not.toHaveBeenCalled();
  });

  it('reads the revision and every payslip in one tenant transaction and stamps the arrears row', async () => {
    queryRawUnsafe.mockImplementation(async (sql) => {
      if (sql.includes('FROM salary_revisions')) {
        return [{
          id: 41,
          staff_uid: STAFF_UID,
          current_basic: '40000.00',
          proposed_basic: '45000.00',
          effective_from: new Date('2026-01-01T00:00:00.000Z'),
          applied_at: new Date('2026-04-15T00:00:00.000Z'),
          status: 'applied',
        }];
      }
      if (sql.includes('FROM payslips')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });
    salaryArrearsCreate.mockResolvedValueOnce({
      id: 51,
      staff_uid: STAFF_UID,
      revision_id: 41,
      arrears_amount: '15000.00',
      status: 'pending',
    });

    const result = await calculateArrears(41, TENANT_ID);

    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(setTenantTx.mock.calls[0][0]).toBe(TENANT_ID);
    const payslipCalls = queryRawUnsafe.mock.calls.filter(([sql]) => sql.includes('FROM payslips'));
    expect(payslipCalls).toHaveLength(3);
    for (const [sql, tenantId, staffUid] of payslipCalls) {
      expect(sql).toContain('WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid');
      expect(tenantId).toBe(TENANT_ID);
      expect(staffUid).toBe(STAFF_UID);
    }
    expect(salaryArrearsCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenant_id: TENANT_ID,
        staff_uid: STAFF_UID,
        revision_id: 41,
        arrears_amount: 15000,
      }),
    }));
    expect(result).toMatchObject({ arrears_amount: 15000, months: 3 });
  });
});
