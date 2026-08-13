import { jest } from '@jest/globals';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const executePayrollRun = jest.fn();

jest.unstable_mockModule('../../services/staff/payrollService.js', () => ({
  executePayrollRun,
  editPayslipAndRegenerate: jest.fn(),
  issuePayrollRun: jest.fn(),
  revealPayslipCredential: jest.fn(),
  signPayrollRun: jest.fn(),
  generateAnnualTaxSummary: jest.fn(),
  calculateArrears: jest.fn(),
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: tenantId => tenantId,
  resolveTenantOrThrow: req => req.tenantId,
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  getSignedFileUrl: jest.fn(),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit: jest.fn() }));

const { runPayroll } = await import('../../controllers/staff/payrollController.js');
const { runMonthlyPayrollForTenant } = await import('../../utils/payrollSchedulerJobs.js');

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

beforeEach(() => {
  jest.clearAllMocks();
  executePayrollRun.mockResolvedValue({
    skipped: false,
    run_id: 42,
    status: 'completed',
    processed: 1,
    failures: 0,
    total_gross: '100.00',
    total_net: '90.00',
  });
});

test('manual and cron entry points delegate to the same durable workflow', async () => {
  const res = makeRes();
  await runPayroll({
    tenantId: TENANT,
    user: { uid: ADMIN },
    body: { month: 12, year: 2025 },
  }, res);
  await runMonthlyPayrollForTenant(TENANT, new Date('2026-01-05T00:00:00Z'));

  expect(executePayrollRun).toHaveBeenNthCalledWith(1, {
    tenantId: TENANT,
    month: 12,
    year: 2025,
    generatedBy: ADMIN,
    rerunCompleted: false,
  });
  expect(executePayrollRun).toHaveBeenNthCalledWith(2, {
    tenantId: TENANT,
    month: 12,
    year: 2025,
    rerunCompleted: false,
  });
  expect(res.json.mock.calls[0][0]).toMatchObject({
    success: true,
    data: { run_id: 42, processed: 1, failed: 0 },
  });
});

test('manual rerun is an explicit controller signal', async () => {
  const res = makeRes();
  await runPayroll({
    tenantId: TENANT,
    user: { uid: ADMIN },
    body: { month: 11, year: 2025, rerun: true },
  }, res);

  expect(executePayrollRun).toHaveBeenCalledWith({
    tenantId: TENANT,
    month: 11,
    year: 2025,
    generatedBy: ADMIN,
    rerunCompleted: true,
  });
});
