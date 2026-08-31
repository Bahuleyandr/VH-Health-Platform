import { jest } from '@jest/globals';

const TENANT = '11111111-1111-4111-8111-111111111111';
const queryRawUnsafe = jest.fn();
const executePayrollRun = jest.fn();

const prismaMock = { $queryRawUnsafe: queryRawUnsafe };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  // The annual-review job reaches the reminder INSERT through
  // `setTenant(tid, tx => tx.$queryRawUnsafe(...))`, so the stand-in has to
  // actually run the callback against a client carrying the same spy —
  // otherwise the tenant-scoping assertions below would inspect a call that
  // never happened.
  setTenant: jest.fn(async (_tenantId, fn) => fn(prismaMock)),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => tenantId,
}));
jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  executePayrollRun,
}));

const { runAnnualSalaryReviewForTenant, runMonthlyPayrollForTenant } =
  await import('../../utils/payrollSchedulerJobs.js');

beforeEach(() => {
  jest.clearAllMocks();
  executePayrollRun.mockResolvedValue({
    run_id: 91,
    status: 'completed',
    skipped: false,
    processed: 1,
    failures: 0,
  });
});

test('monthly payroll uses the shared tenant-scoped workflow', async () => {
  const result = await runMonthlyPayrollForTenant(TENANT, new Date('2026-01-05T00:00:00Z'));

  expect(result).toMatchObject({
    run_id: 91, month: 12, year: 2025, processed: 1, failures: 0,
  });
  expect(executePayrollRun).toHaveBeenCalledWith({
    tenantId: TENANT,
    month: 12,
    year: 2025,
    rerunCompleted: false,
  });
  expect(queryRawUnsafe).not.toHaveBeenCalled();
});

test('monthly payroll preserves completed and locked runs without generating staff', async () => {
  executePayrollRun.mockResolvedValue({
    id: 91, status: 'locked', skipped: true, reason: 'locked',
  });

  await expect(runMonthlyPayrollForTenant(TENANT, new Date('2026-01-05T00:00:00Z')))
    .resolves.toMatchObject({ skipped: true, reason: 'locked', month: 12, year: 2025 });

  expect(queryRawUnsafe).not.toHaveBeenCalled();
  expect(executePayrollRun).toHaveBeenCalledTimes(1);
});

test('annual review inserts tenant identity and deduplicates within that tenant', async () => {
  queryRawUnsafe.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

  await expect(runAnnualSalaryReviewForTenant(TENANT, 2026)).resolves.toEqual({
    year: 2026,
    created: 2,
  });

  const [sql, tenantParam, yearParam] = queryRawUnsafe.mock.calls[0];
  // Migration 754 put a RESTRICTIVE policy on annual_review_reminders
  // (annual_review_reminders_reconciled_only) that only admits rows whose
  // tenant_reconciliation_required is false and whose tenant_id is set, so the
  // job now writes both reconciliation columns explicitly rather than leaning
  // on their column defaults. Pin the whole column list and the values fed to
  // it: that keeps the original four columns pinned AND additionally proves
  // the scheduler files these as ordinary tenant-owned rows, never as
  // reconciliation rows.
  const normalisedSql = sql.replace(/\s+/g, ' ');
  expect(normalisedSql).toContain(
    '(tenant_id, staff_uid, review_year, reminder_sent_at, '
    + 'tenant_reconciliation_required, tenant_reconciliation_evidence)',
  );
  expect(normalisedSql).toContain(
    "SELECT ss.tenant_id, ss.staff_uid, $2, NOW(), false, '{}'::jsonb",
  );
  expect(sql).toContain('WHERE ss.tenant_id = $1::uuid');
  expect(sql).toContain('ON CONFLICT (tenant_id, staff_uid, review_year) DO NOTHING');
  expect(tenantParam).toBe(TENANT);
  expect(yearParam).toBe(2026);
});
