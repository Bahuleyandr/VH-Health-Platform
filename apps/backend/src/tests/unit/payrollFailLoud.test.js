// src/tests/unit/payrollFailLoud.test.js
//
// Audit F2 (money path). Two invariants, both previously violated:
//
//   1. calculatePayslip must THROW when one of its lookups fails. It used to
//      swallow six query failures into zeros, which produced a payable payslip
//      with attendanceFactor ≈ 0 — near-zero basic/HRA/DA plus a full month of
//      LOP — and saved it as an ordinary row. The failure mode is silent by
//      construction: nothing distinguishes "genuinely absent all month" from
//      "the database was unreachable for 30 seconds".
//
//   2. A run that loses staff members must not record itself as 'completed'.
//      Both entry points share summarizePayrollRunOutcome so the persisted row
//      carries the failed count and the 'completed_with_errors' status.
//
// Prisma is mocked, so these are pure unit tests — but calculatePayslip itself
// is the REAL implementation, so test 1 fails if any `.catch(() => zeros)` is
// ever reintroduced.

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const STAFF_OK = '11111111-1111-4111-8111-111111111111';
const STAFF_BAD = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafe = jest.fn();
const payrollRunsFindFirst = jest.fn();
const payrollRunsUpdate = jest.fn();
const payrollRunsCreate = jest.fn();
const payslipInsert = jest.fn();
const payslipsUpdate = jest.fn();
const salaryAdvancesUpdate = jest.fn();
const salaryAdvancesUpdateMany = jest.fn();
const advanceDeductionsCreate = jest.fn();
const salaryArrearsUpdateMany = jest.fn();
const payrollFinalize = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
  payroll_runs: {
    findFirst: payrollRunsFindFirst,
    update: payrollRunsUpdate,
    create: payrollRunsCreate,
  },
  payslips: { update: payslipsUpdate },
  salary_advances: { update: salaryAdvancesUpdate, updateMany: salaryAdvancesUpdateMany },
  advance_deductions: { create: advanceDeductionsCreate },
  salary_arrears: { updateMany: salaryArrearsUpdateMany },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const loggerError = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: loggerError, debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT,
  requireTenantId: (tenantId) => tenantId || TENANT,
}));

jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(),
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getFileFromR2: jest.fn(),
  getSignedFileUrl: jest.fn(),
}));

// PDF generation is a best-effort side path guarded by its own try/catch; keep
// it out of the way so a failure there can never be mistaken for a calc failure.
jest.unstable_mockModule('../../utils/payslipPDF.js', () => ({
  generatePayslipPDF: null,
}));

const { calculatePayslip, summarizePayrollRunOutcome, recordPayrollFailure } =
  await import('../../services/staff/payrollService.js');

const SALARY_ROW = {
  id: 1,
  staff_uid: STAFF_OK,
  basic_salary: 26000,
  hra_pct: 40,
  da_pct: 10,
  special_allowance: 2000,
  transport_allowance: 1600,
  medical_allowance: 1250,
  pf_employee_pct: 12,
  esi_applicable: false,
  tds_monthly: 0,
  is_active: true,
  effective_from: '2026-01-01',
};

// Route each raw query by its SQL text rather than by call order — the order is
// an implementation detail, and an order-coupled mock would mask a real change.
// `overrides` maps a logical query name to a handler that may reject.
function installQueryRouter(overrides = {}) {
  queryRawUnsafe.mockImplementation(async (sql, ...params) => {
    const uid = params[1] || params[0];
    const run = (name, fallback) =>
      overrides[name] ? overrides[name](uid, ...params) : fallback;

    // Controller's staff enumeration (aliased `ss`) — matched before the
    // single-staff salary lookup, which selects FROM staff_salary unaliased.
    if (sql.includes('INSERT INTO payslips')) {
      payslipInsert(sql, ...params);
      return [{ id: 99, tenant_id: params[0], payroll_run_id: params[1], staff_uid: params[2] }];
    }
    if (sql.includes('INSERT INTO payroll_runs')) {
      return [{ id: 42, status: 'processing', generated_at: params[4] }];
    }
    if (sql.includes('UPDATE payroll_runs') && sql.includes('failed_staff = $10::jsonb')) {
      payrollFinalize({
        tenant_id: params[0],
        id: params[1],
        status: params[3],
        total_staff: params[4],
        total_gross: params[5],
        total_net: params[6],
        total_deductions: params[7],
        failed_staff_count: params[8],
        failed_staff: JSON.parse(params[9]),
      });
      return [{ id: params[1], status: params[3] }];
    }
    if (sql.includes('UPDATE payroll_runs')) return [{ id: 42, status: 'processing' }];
    if (sql.includes('FROM payroll_runs')) return [{ id: 42, status: 'processing' }];
    if (sql.includes('FROM staff_salary ss')) return run('staffList', []);
    if (sql.includes('FROM staff_salary')) {
      return run('salaryConfig', [{ ...SALARY_ROW, staff_uid: uid }]);
    }
    if (sql.includes('FROM staff_attendance')) {
      return run('attendance', [{ days_present: 26, total_overtime_hours: 0 }]);
    }
    if (sql.includes('FROM leave_applications')) return run('leave', [{ leave_days: 0 }]);
    if (sql.includes('SELECT id FROM users WHERE tenant_id')) return run('userId', [{ id: 7 }]);
    if (sql.includes('FROM overtime_requests')) return run('overtime', [{ approved_overtime: 0 }]);
    if (sql.includes('FROM payslips')) return [];
    // Bonus payables are claimed from their own table and joined back to
    // salary_revisions, so this must be matched on `salary_revision_payables`
    // before the plain `salary_revisions` increment lookup below.
    if (sql.includes('FROM salary_revision_payables')) return run('bonusPayables', []);
    if (sql.includes('FROM salary_arrears')) return run('arrears', []);
    if (sql.includes('FROM salary_advances')) return run('advances', []);
    if (sql.includes('FROM salary_revisions')) return run('revisions', []);
    throw new Error(`Unrouted SQL in test: ${String(sql).slice(0, 120)}`);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installQueryRouter();
  payrollRunsUpdate.mockResolvedValue({ id: 42 });
  payrollRunsCreate.mockResolvedValue({ id: 42 });
  payrollRunsFindFirst.mockResolvedValue(null);
});

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('calculatePayslip fails loudly instead of fabricating zeros', () => {
  const DB_DOWN = () => Promise.reject(new Error('Circuit breaker open'));

  // One case per catch removed in this packet. Each previously degraded to a
  // zero/empty fallback that still produced a saved, payable payslip.
  it.each([
    ['attendance', 'staff_attendance'],
    ['leave', 'leave_applications'],
    ['overtime', 'overtime_requests'],
    ['arrears', 'salary_arrears'],
    ['advances', 'salary_advances'],
    ['revisions', 'salary_revisions'],
    // The bonus-payable claim was added after this packet; it has no catch
    // either, and a swallowed failure here would pay a payslip that silently
    // drops every earned bonus, so it belongs to the same contract.
    ['bonusPayables', 'salary_revision_payables'],
  ])('rejects when the %s query fails (%s)', async (queryName) => {
    installQueryRouter({ [queryName]: DB_DOWN });

    await expect(calculatePayslip(STAFF_OK, 3, 2026, TENANT)).rejects.toThrow('Circuit breaker open');
  });

  it('still computes a normal payslip when every lookup succeeds', async () => {
    const calc = await calculatePayslip(STAFF_OK, 3, 2026, TENANT);

    // 26/26 days present — a full attendance factor, not the ~0 the swallowed
    // failure used to produce.
    expect(calc.attendance_factor).toBe(1);
    expect(calc.days_present).toBe(26);
    expect(calc.basic_earned).toBe(26000);
    expect(calc.lop_days).toBe(0);
    expect(calc.net_salary).toBeGreaterThan(0);
  });

  it('a failed attendance lookup does not degrade to a zeroed payslip', async () => {
    // The regression this packet exists to prevent: before the fix this call
    // resolved with days_present 0, attendance_factor 0 and 26 LOP days.
    installQueryRouter({ attendance: DB_DOWN });

    await expect(calculatePayslip(STAFF_OK, 3, 2026, TENANT)).rejects.toThrow();
    expect(payslipInsert).not.toHaveBeenCalled();
  });
});

describe('summarizePayrollRunOutcome', () => {
  it('reports completed only when nothing failed', () => {
    const outcome = summarizePayrollRunOutcome({
      processed: 3, failures: [], totalGross: 100, totalNet: 90, totalDeductions: 10,
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.failed_staff_count).toBe(0);
    expect(outcome.failed_staff).toEqual([]);
    expect(outcome.total_staff).toBe(3);
  });

  it('reports completed_with_errors and the failed count when any staff failed', () => {
    const failures = [];
    recordPayrollFailure(failures, STAFF_BAD, new Error('Circuit breaker open'));

    const outcome = summarizePayrollRunOutcome({ processed: 2, failures });

    expect(outcome.status).toBe('completed_with_errors');
    expect(outcome.failed_staff_count).toBe(1);
    expect(outcome.failed_staff).toEqual([
      { staff_uid: STAFF_BAD, reason: 'Circuit breaker open' },
    ]);
    // total_staff stays the number actually paid — the failed staffer is not
    // silently folded into the processed count.
    expect(outcome.total_staff).toBe(2);
  });

  it('bounds a persisted failure reason', () => {
    const failures = [];
    recordPayrollFailure(failures, STAFF_BAD, new Error('x'.repeat(5000)));

    expect(failures[0].reason).toHaveLength(500);
  });

  it("status fits payroll_runs.status, widened to VARCHAR(32) by migration 644", () => {
    const outcome = summarizePayrollRunOutcome({ processed: 0, failures: [{ staff_uid: STAFF_BAD, reason: 'x' }] });

    // 'completed_with_errors' is 21 chars and does not fit the original
    // VARCHAR(20); a regression here surfaces as a 22001 at run finalization.
    expect(outcome.status.length).toBeLessThanOrEqual(32);
    expect(outcome.status.length).toBeGreaterThan(20);
  });
});

describe('runPayroll persists per-run failures', () => {
  it('does not select the internal failure text in the runs list', async () => {
    const { getPayrollRuns } = await import('../../controllers/staff/payrollController.js');
    queryRawUnsafe.mockResolvedValueOnce([]);

    await getPayrollRuns({ user: { uid: 'admin-uid' }, query: {} }, makeRes());

    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).toContain('pr.failed_staff_count');
    expect(sql).not.toContain('pr.failed_staff,');
    expect(sql).not.toContain('pr.*');
    // The R7 failed_staff_summary projection surfaces WHO failed (uid + name)
    // for the sign-off acknowledgement UI, but must never project the
    // internal `reason` error text out of the failed_staff jsonb.
    expect(sql).toContain('failed_staff_summary');
    expect(sql).not.toContain("'reason'");
    expect(sql).toContain('WHERE pr.tenant_id = $1::uuid');
    expect(sql).toContain('fu.tenant_id = pr.tenant_id');
    expect(queryRawUnsafe.mock.calls[0][1]).toBe(TENANT);
  });

  it('scopes run detail and every staff join to the authoritative tenant', async () => {
    const { getPayrollRunDetail } = await import('../../controllers/staff/payrollController.js');
    queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await getPayrollRunDetail({
      tenantId: TENANT,
      user: { uid: 'admin-uid' },
      params: { runId: '42' },
    }, makeRes());

    const detailSql = queryRawUnsafe.mock.calls[0][0];
    const runSql = queryRawUnsafe.mock.calls[1][0];
    expect(detailSql).not.toContain('p.*');
    expect(detailSql).toContain('p.tenant_id = $2::uuid');
    expect(detailSql).toContain('u.tenant_id = p.tenant_id');
    expect(detailSql).toContain('s.tenant_id = u.tenant_id');
    expect(detailSql).toContain('ss.tenant_id = u.tenant_id');
    expect(runSql).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual([42, TENANT]);
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual([42, TENANT]);
  });
});
