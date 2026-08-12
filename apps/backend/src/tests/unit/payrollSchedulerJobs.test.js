import { jest } from '@jest/globals';

const TENANT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-222222222222';
const queryRawUnsafe = jest.fn();
const calculatePayslip = jest.fn();
const savePayslip = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId,
}));
jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  calculatePayslip,
  savePayslip,
  recordPayrollFailure: (failures, staffUid, err) => failures.push({
    staff_uid: staffUid,
    reason: err.message,
  }),
  summarizePayrollRunOutcome: ({ processed, failures, totalGross, totalNet, totalDeductions }) => ({
    status: failures.length ? 'completed_with_errors' : 'completed',
    total_staff: processed,
    total_gross: totalGross,
    total_net: totalNet,
    total_deductions: totalDeductions,
    failed_staff_count: failures.length,
    failed_staff: failures,
  }),
}));

const { runAnnualSalaryReviewForTenant, runMonthlyPayrollForTenant } =
  await import('../../utils/payrollSchedulerJobs.js');

beforeEach(() => {
  jest.clearAllMocks();
  calculatePayslip.mockResolvedValue({
    staff_uid: STAFF,
    month: 12,
    year: 2025,
    gross_salary: 100,
    net_salary: 80,
    total_deductions: 20,
  });
  savePayslip.mockResolvedValue({ id: 1 });
});

test('monthly payroll scopes every read and write to the requested tenant', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ staff_uid: STAFF }])
    .mockResolvedValueOnce([{ id: 91 }])
    .mockResolvedValueOnce([]);

  const result = await runMonthlyPayrollForTenant(TENANT, new Date('2026-01-05T00:00:00Z'));

  expect(result).toMatchObject({ month: 12, year: 2025, processed: 1, failures: 0 });
  expect(savePayslip).toHaveBeenCalledWith(91, expect.objectContaining({ staff_uid: STAFF }), TENANT);
  const calls = queryRawUnsafe.mock.calls;
  expect(calls[0][0]).toContain('WHERE tenant_id = $1::uuid');
  expect(calls[1][0]).toContain('WHERE ss.tenant_id = $1::uuid');
  expect(calls[2][0]).toContain('INSERT INTO payroll_runs (tenant_id, month, year, status)');
  expect(calls[3][0]).toContain('WHERE tenant_id = $8::uuid AND id = $9');
  for (const call of calls) expect(call).toContain(TENANT);
});

test('annual review inserts tenant identity and deduplicates within that tenant', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

  await expect(runAnnualSalaryReviewForTenant(TENANT, 2026)).resolves.toEqual({
    year: 2026,
    created: 2,
  });

  const [sql, tenantParam, yearParam] = queryRawUnsafe.mock.calls[0];
  expect(sql).toContain('(tenant_id, staff_uid, review_year, reminder_sent_at)');
  expect(sql).toContain('WHERE ss.tenant_id = $1::uuid');
  expect(sql).toContain('ON CONFLICT (tenant_id, staff_uid, review_year) DO NOTHING');
  expect(tenantParam).toBe(TENANT);
  expect(yearParam).toBe(2026);
});
