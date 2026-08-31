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
// The arrears lane also scopes reads through setTenant, so the factory below
// has to export it or the service fails to link. Same shape as setTenantTx:
// run the callback against the mock client rather than stubbing it away.
const setTenant = jest.fn(async (_tenantId, fn) => fn(txMock));
const requireTenantId = jest.fn((tenantId) => {
  if (!tenantId) {
    const error = new Error('Tenant context required');
    error.code = 'TENANT_CONTEXT_REQUIRED';
    throw error;
  }
  return tenantId;
});

// #940 made arrears a durable command: it refuses to run without a command
// identity, and claims its work item under an ACTIVE-tenant probe before it
// reads the revision. These fixtures supply both rather than relaxing either.
const ARREARS_COMMAND = {
  actorUid: '8f000000-0000-4000-8000-0000000000aa',
  commandKey: 'tax-arrears-tenant-scope-fixture',
  requestBodySha256: 'a'.repeat(64),
};

/** Find a recorded $queryRawUnsafe call by a fragment of its SQL. */
function callMatching(fragment) {
  return queryRawUnsafe.mock.calls.find(([sql]) => String(sql).includes(fragment));
}
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx,
  setTenant,
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

// NOTE — two cases that lived here were MOVED, not dropped:
//   'rejects a revision identity that is not visible in the resolved tenant'
//   'reads the revision and every payslip in one tenant transaction ...'
// They mocked $queryRawUnsafe and asserted the service's internal call ORDER.
// Arrears is now a durable command (admin-authority probe, command receipt,
// work-item claim, tenant-active check, revision-type validation) all ahead of
// the revision read, so that model no longer describes the lane and the cases
// could only be kept alive by mirroring the implementation.
// Both invariants are proven in src/tests/salary-revision-tenant.deep.test.js
// ('applies, replays and denies a cross-tenant arrears command') against a real
// database over HTTP: a foreign tenant's admin is denied and writes nothing,
// and the owning admin stamps exactly one salary_arrears row carrying its own
// tenant_id. That is strictly stronger than the mocks removed here.
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

});
