// src/tests/unit/payrollSignAckFailedPayslips.test.js
//
// R7 (2026-08-10 audit): migration 644 introduced the terminal run status
// 'completed_with_errors', but the sign gate at payrollController still
// hard-required status === 'completed' — a month with one failed payslip could
// NEVER be signed, countersigned, or issued. The fix accepts such a run only
// behind an explicit acknowledgement:
//
//   * hr-sign / admin-sign / issue reject a run with failed payslips unless
//     the request carries `acknowledge_failed_payslips: true` (literal true);
//   * the rejection lists the failed staff (count + uids — never the internal
//     error text) so the signer sees what they are acknowledging;
//   * an acknowledged sign-off is recorded to audit_logs via logAudit;
//   * clean 'completed' runs sign exactly as before, no ack required.
//
// Prisma and logAudit are mocked; the controller under test is real.

import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_A = '11111111-1111-4111-8111-111111111111';
const STAFF_B = '22222222-2222-4222-8222-222222222222';
const HR_UID = '33333333-3333-4333-8333-333333333333';
const ADMIN_UID = '44444444-4444-4444-8444-444444444444';

const queryRawUnsafe = jest.fn();
const payrollRunsUpdate = jest.fn();
const payrollRunsUpdateMany = jest.fn();
const payslipsUpdateMany = jest.fn();
const payslipsUpdate = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
  payroll_runs: { update: payrollRunsUpdate, updateMany: payrollRunsUpdateMany },
  payslips: { updateMany: payslipsUpdateMany, update: payslipsUpdate },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn(),
}));

jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getSignedFileUrl: jest.fn(),
}));

jest.unstable_mockModule('../../utils/payslipPDF.js', () => ({
  generatePayslipPDF: null,
}));

// The acknowledgement's audit trail — asserted on, so mocked at the seam.
const logAudit = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit }));

const { hrSignPayrollRun, adminSignPayrollRun, issuePayslips } =
  await import('../../controllers/staff/payrollController.js');

// A completed_with_errors run, pre any signature.
function runWithFailures(overrides = {}) {
  return {
    id: 42,
    month: 3,
    year: 2026,
    status: 'completed_with_errors',
    generated_by: 'gen-uid',
    generated_at: new Date('2026-03-31T10:00:00Z'),
    hr_approved_by: null,
    hr_approved_at: null,
    admin_approved_by: null,
    admin_approved_at: null,
    total_gross: '100000.00',
    total_deductions: '10000.00',
    total_net: '90000.00',
    employee_count: 3,
    failed_staff_count: 2,
    failed_staff: [
      { staff_uid: STAFF_A, reason: 'Circuit breaker open' },
      { staff_uid: STAFF_B, reason: 'attendance lookup failed' },
    ],
    notes: null,
    created_at: new Date('2026-03-31T10:00:00Z'),
    updated_at: null,
    ...overrides,
  };
}

function cleanRun(overrides = {}) {
  return runWithFailures({
    status: 'completed',
    failed_staff_count: 0,
    failed_staff: [],
    ...overrides,
  });
}

// Routes the controller's raw SQL by text, like payrollFailLoud.test.js.
function installQueryRouter({ runRow }) {
  queryRawUnsafe.mockImplementation(async (sql) => {
    if (sql.includes('FROM payroll_runs WHERE id = $1')) return runRow ? [runRow] : [];
    if (sql.includes('FROM payroll_runs WHERE month=$1')) return runRow ? [runRow] : [];
    if (sql.includes('JOIN staff_salary ss ON')) return []; // edited-payslip PDF regen scan
    if (sql.includes('FROM payslips p JOIN users u')) return []; // post-issue notification scan
    throw new Error(`Unrouted SQL in test: ${String(sql).slice(0, 120)}`);
  });
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function makeReq(body = {}, uid = HR_UID) {
  return {
    tenantId: TENANT_ID,
    user: { uid, role: 'ADMIN' },
    params: { runId: '42' },
    body,
    headers: {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  payrollRunsUpdate.mockResolvedValue({ id: 42, status: 'approved' });
  payrollRunsUpdateMany.mockResolvedValue({ count: 1 });
  payslipsUpdateMany.mockResolvedValue({ count: 3 });
});

describe('hrSignPayrollRun failed-payslip acknowledgement', () => {
  it('signs a clean completed run without any ack (unchanged behaviour)', async () => {
    installQueryRouter({ runRow: cleanRun() });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({ comment: 'ok' }), res);

    expect(payrollRunsUpdate).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('rejects a completed_with_errors run without the ack, listing the failed payslips', async () => {
    installQueryRouter({ runRow: runWithFailures() });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({ comment: 'ok' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.code).toBe('FAILED_PAYSLIPS_ACK_REQUIRED');
    expect(body.details.failed_staff_count).toBe(2);
    expect(body.details.failed_staff_uids).toEqual([STAFF_A, STAFF_B]);
    expect(body.details.acknowledgement_field).toBe('acknowledge_failed_payslips');
    // The internal error text never leaves the DB/logs.
    expect(JSON.stringify(body)).not.toContain('Circuit breaker open');
    expect(payrollRunsUpdate).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('requires the literal boolean true — a truthy string is not an acknowledgement', async () => {
    installQueryRouter({ runRow: runWithFailures() });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({ acknowledge_failed_payslips: 'true' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payrollRunsUpdate).not.toHaveBeenCalled();
  });

  it('signs a completed_with_errors run WITH the ack and audit-logs the acknowledgement', async () => {
    installQueryRouter({ runRow: runWithFailures() });
    const res = makeRes();
    const req = makeReq({ comment: 'reviewed', acknowledge_failed_payslips: true });

    await hrSignPayrollRun(req, res);

    expect(payrollRunsUpdate).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const [auditReq, action, metadata, options] = logAudit.mock.calls[0];
    expect(auditReq).toBe(req);
    expect(action).toBe('payroll-hr-sign-failed-payslips-acknowledged');
    expect(metadata).toMatchObject({
      run_id: 42,
      month: 3,
      year: 2026,
      failed_staff_count: 2,
      failed_staff_uids: [STAFF_A, STAFF_B],
    });
    expect(options).toEqual({ resource: 'payroll_run', resourceId: 42 });
  });

  it('still rejects statuses outside completed/completed_with_errors', async () => {
    installQueryRouter({ runRow: runWithFailures({ status: 'draft', failed_staff_count: 0, failed_staff: [] }) });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({ acknowledge_failed_payslips: true }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toMatch(/completed state/);
    expect(payrollRunsUpdate).not.toHaveBeenCalled();
  });
});

describe('adminSignPayrollRun failed-payslip acknowledgement', () => {
  const hrSigned = (overrides = {}) => runWithFailures({
    hr_approved_by: HR_UID,
    hr_approved_at: new Date('2026-04-01T09:00:00Z'),
    ...overrides,
  });

  it('rejects countersign of a completed_with_errors run without its own ack', async () => {
    installQueryRouter({ runRow: hrSigned() });
    const res = makeRes();

    await adminSignPayrollRun(makeReq({}, ADMIN_UID), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('FAILED_PAYSLIPS_ACK_REQUIRED');
    expect(body.details.failed_staff_uids).toEqual([STAFF_A, STAFF_B]);
    expect(payrollRunsUpdate).not.toHaveBeenCalled();
  });

  it('countersigns WITH the ack, moves the run to approved, and audit-logs', async () => {
    installQueryRouter({ runRow: hrSigned() });
    const res = makeRes();

    await adminSignPayrollRun(makeReq({ acknowledge_failed_payslips: true }, ADMIN_UID), res);

    expect(payrollRunsUpdate).toHaveBeenCalledTimes(1);
    expect(payrollRunsUpdate.mock.calls[0][0].data.status).toBe('approved');
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][1]).toBe('payroll-admin-sign-failed-payslips-acknowledged');
  });

  it('countersigns a clean run without any ack (unchanged behaviour)', async () => {
    installQueryRouter({ runRow: hrSigned({ status: 'completed', failed_staff_count: 0, failed_staff: [] }) });
    const res = makeRes();

    await adminSignPayrollRun(makeReq({}, ADMIN_UID), res);

    expect(payrollRunsUpdate).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('issuePayslips failed-payslip acknowledgement', () => {
  // At issue time adminSign has already moved status to 'approved' — the
  // durable marker for missing payslips is failed_staff_count.
  const approvedWithFailures = (overrides = {}) => runWithFailures({
    status: 'approved',
    hr_approved_by: HR_UID,
    hr_approved_at: new Date('2026-04-01T09:00:00Z'),
    admin_approved_by: ADMIN_UID,
    admin_approved_at: new Date('2026-04-01T10:00:00Z'),
    ...overrides,
  });

  const issueReq = (body = {}) => ({
    tenantId: TENANT_ID,
    user: { uid: ADMIN_UID, role: 'ADMIN' },
    params: {},
    body: { month: 3, year: 2026, ...body },
    headers: {},
  });

  it('rejects issuing when the run has failed payslips and no ack', async () => {
    installQueryRouter({ runRow: approvedWithFailures() });
    const res = makeRes();

    await issuePayslips(issueReq(), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('FAILED_PAYSLIPS_ACK_REQUIRED');
    expect(body.details.failed_staff_count).toBe(2);
    expect(body.details.failed_staff_uids).toEqual([STAFF_A, STAFF_B]);
    expect(payslipsUpdateMany).not.toHaveBeenCalled();
    expect(payrollRunsUpdateMany).not.toHaveBeenCalled();
  });

  it('issues WITH the ack and audit-logs the acknowledgement', async () => {
    installQueryRouter({ runRow: approvedWithFailures() });
    const res = makeRes();

    await issuePayslips(issueReq({ acknowledge_failed_payslips: true }), res);

    expect(payslipsUpdateMany).toHaveBeenCalledTimes(1);
    expect(payrollRunsUpdateMany).toHaveBeenCalledWith({
      where: { month: 3, year: 2026 },
      data: { status: 'locked' },
    });
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.issued).toBe(3);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][1]).toBe('payroll-issue-failed-payslips-acknowledged');
  });

  it('issues a clean run without any ack (unchanged behaviour)', async () => {
    installQueryRouter({
      runRow: approvedWithFailures({ failed_staff_count: 0, failed_staff: [] }),
    });
    const res = makeRes();

    await issuePayslips(issueReq(), res);

    expect(payslipsUpdateMany).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
