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

import crypto from 'node:crypto';
import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_A = '11111111-1111-4111-8111-111111111111';
const STAFF_B = '22222222-2222-4222-8222-222222222222';
const HR_UID = '33333333-3333-4333-8333-333333333333';
const ADMIN_UID = '44444444-4444-4444-8444-444444444444';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const payrollSignatureUpdate = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafe,
  $executeRawUnsafe: executeRawUnsafe,
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
  getFileFromR2: jest.fn(),
  getSignedFileUrl: jest.fn(),
}));

jest.unstable_mockModule('../../utils/payslipPDF.js', () => ({
  generatePayslipPDF: null,
}));

// Migration 669 made issuance the moment a payslip becomes COLLECTABLE, so
// issuePayrollRun now queues one in-app "your payslip is available" intent per
// issued payslip (payrollService.js:2395) before returning. The outbox is a
// durable send-permission ledger, not a fire-and-forget call: `queue` opens its
// own RLS tenant-context probe against prisma, which this suite's SQL router
// cannot answer, so leaving it real made the controller throw and answer 500 —
// the reason the two issue-success cases below were red. Mock it at the module
// seam (as notificationDispatcher already is) and assert the intents instead,
// which pins strictly more of the new contract than was pinned before.
const outboxQueue = jest.fn().mockResolvedValue({ id: 1, status: 'PENDING' });
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: outboxQueue },
  default: { queue: outboxQueue },
}));

// The acknowledgement's audit trail — asserted on, so mocked at the seam.
const logAudit = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit }));

const { hrSignPayrollRun, adminSignPayrollRun, issuePayslips } =
  await import('../../controllers/staff/payrollController.js');

// A completed_with_errors run, pre any signature.
function runWithFailures(overrides = {}) {
  const run = {
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
    total_staff: 3,
    attempt_token: '55555555-5555-4555-8555-555555555555',
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
  const resultRows = (run.failed_staff || []).map(failure => ({
    staff_uid: failure.staff_uid,
    outcome: 'failed',
    payslip_id: null,
    payslip_document_revision: null,
    gross_salary: null,
    net_salary: null,
    total_deductions: null,
    failure_reason: failure.reason,
  }));
  const normalizedResults = resultRows.map(row => ({
    staff_uid: String(row.staff_uid),
    outcome: row.outcome,
    payslip_id: null,
    payslip_document_revision: null,
    gross_salary: null,
    net_salary: null,
    total_deductions: null,
    failure_reason: String(row.failure_reason),
  }));
  run.result_manifest_hash = crypto.createHash('sha256')
    .update(JSON.stringify(normalizedResults))
    .digest('hex');
  run.document_manifest_hash = crypto.createHash('sha256')
    .update('[]')
    .digest('hex');
  run._resultRows = resultRows;
  return run;
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
  queryRawUnsafe.mockImplementation(async (sql, ...params) => {
    if (sql.includes('SELECT role') && sql.includes('FROM users')) {
      return [{ role: params[1] === ADMIN_UID ? 'ADMIN' : 'HR_STAFF' }];
    }
    if (sql.includes('FROM payroll_run_staff_results AS result')
        && sql.includes('LEFT JOIN payslip_documents')) return [];
    if (sql.includes('FROM payroll_run_staff_results')
        && !sql.includes('JOIN payslip_documents')) return runRow?._resultRows || [];
    if (sql.includes('FROM payslip_documents AS document')) return [];
    if (sql.includes('FROM payroll_runs') && sql.includes('FOR UPDATE')) {
      return runRow ? [runRow] : [];
    }
    if (sql.includes('UPDATE payroll_runs') && sql.includes('hr_approved_by =')) {
      payrollSignatureUpdate(sql, ...params);
      return [{
        ...runRow,
        hr_approved_by: params[2],
        hr_approved_at: new Date('2026-04-01T09:00:00Z'),
        hr_comment: params[3],
      }];
    }
    if (sql.includes('UPDATE payroll_runs') && sql.includes('admin_approved_by =')) {
      payrollSignatureUpdate(sql, ...params);
      return [{
        ...runRow,
        status: 'approved',
        admin_approved_by: params[2],
        admin_approved_at: new Date('2026-04-01T10:00:00Z'),
        admin_comment: params[3],
        approval_hash: params[4],
      }];
    }
    if (sql.includes('UPDATE payslips AS payslip')) {
      return Array.from({ length: Number(runRow?.total_staff || 0) }, (_, index) => ({ id: index + 1 }));
    }
    if (sql.includes('FROM payroll_runs WHERE month=$1')) return runRow ? [runRow] : [];
    throw new Error(`Unrouted SQL in test: ${String(sql).slice(0, 120)}`);
  });
  executeRawUnsafe.mockResolvedValue(1);
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function makeReq(body = {}, uid = HR_UID, role = 'HR_STAFF') {
  return {
    tenantId: TENANT_ID,
    user: { uid, role },
    params: { runId: '42' },
    body,
    headers: {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('hrSignPayrollRun failed-payslip acknowledgement', () => {
  it('signs a clean completed run without any ack (unchanged behaviour)', async () => {
    installQueryRouter({ runRow: cleanRun() });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({ comment: 'ok' }), res);

    expect(payrollSignatureUpdate).toHaveBeenCalledTimes(1);
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
    expect(payrollSignatureUpdate).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('requires the literal boolean true — a truthy string is not an acknowledgement', async () => {
    installQueryRouter({ runRow: runWithFailures() });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({ acknowledge_failed_payslips: 'true' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payrollSignatureUpdate).not.toHaveBeenCalled();
  });

  it('signs a completed_with_errors run WITH the ack and audit-logs the acknowledgement', async () => {
    installQueryRouter({ runRow: runWithFailures() });
    const res = makeRes();
    const req = makeReq({ comment: 'reviewed', acknowledge_failed_payslips: true });

    await hrSignPayrollRun(req, res);

    expect(payrollSignatureUpdate).toHaveBeenCalledTimes(1);
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
    expect(payrollSignatureUpdate).not.toHaveBeenCalled();
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

    await adminSignPayrollRun(makeReq({}, ADMIN_UID, 'ADMIN'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('FAILED_PAYSLIPS_ACK_REQUIRED');
    expect(body.details.failed_staff_uids).toEqual([STAFF_A, STAFF_B]);
    expect(payrollSignatureUpdate).not.toHaveBeenCalled();
  });

  it('countersigns WITH the ack, moves the run to approved, and audit-logs', async () => {
    installQueryRouter({ runRow: hrSigned() });
    const res = makeRes();

    await adminSignPayrollRun(makeReq({ acknowledge_failed_payslips: true }, ADMIN_UID, 'ADMIN'), res);

    expect(payrollSignatureUpdate).toHaveBeenCalledTimes(1);
    expect(payrollSignatureUpdate.mock.calls[0][0]).toContain("status = 'approved'");
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][1]).toBe('payroll-admin-sign-failed-payslips-acknowledged');
  });

  it('countersigns a clean run without any ack (unchanged behaviour)', async () => {
    installQueryRouter({ runRow: hrSigned({ status: 'completed', failed_staff_count: 0, failed_staff: [] }) });
    const res = makeRes();

    await adminSignPayrollRun(makeReq({}, ADMIN_UID, 'ADMIN'), res);

    expect(payrollSignatureUpdate).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('payroll signature role segregation', () => {
  it('rejects an admin attempting the HR signature', async () => {
    installQueryRouter({ runRow: cleanRun() });
    const res = makeRes();

    await hrSignPayrollRun(makeReq({}, ADMIN_UID, 'ADMIN'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payrollSignatureUpdate).not.toHaveBeenCalled();
  });

  it('rejects HR staff attempting the admin countersign', async () => {
    installQueryRouter({
      runRow: cleanRun({
        hr_approved_by: HR_UID,
        hr_approved_at: new Date('2026-04-01T09:00:00Z'),
      }),
    });
    const res = makeRes();

    await adminSignPayrollRun(makeReq({}, STAFF_A, 'HR_STAFF'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payrollSignatureUpdate).not.toHaveBeenCalled();
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
    expect(queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('UPDATE payslips AS payslip')))
      .toBe(false);
  });

  it('issues WITH the ack and audit-logs the acknowledgement', async () => {
    installQueryRouter({ runRow: approvedWithFailures() });
    const res = makeRes();

    await issuePayslips(issueReq({ acknowledge_failed_payslips: true }), res);

    expect(queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('UPDATE payslips AS payslip')))
      .toBe(true);
    expect(executeRawUnsafe.mock.calls.some(([sql]) => sql.includes("SET status = 'locked'")))
      .toBe(true);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.issued).toBe(3);
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][1]).toBe('payroll-issue-failed-payslips-acknowledged');
    // Issuance is what makes a payslip collectable, so every issued payslip
    // gets its own in-app intent — enqueued on the same transaction, strictly.
    expect(outboxQueue).toHaveBeenCalledTimes(3);
    for (const [intent, opts] of outboxQueue.mock.calls) {
      expect(intent).toMatchObject({
        channel: 'inapp',
        type: 'payslip_ready',
        data: expect.objectContaining({ collectable: 'true', stage: 'issued' }),
      });
      expect(opts).toMatchObject({ strict: true });
      expect(opts.tx).toBeDefined();
    }
  });

  it('issues a clean run without any ack (unchanged behaviour)', async () => {
    installQueryRouter({
      runRow: approvedWithFailures({ failed_staff_count: 0, failed_staff: [] }),
    });
    const res = makeRes();

    await issuePayslips(issueReq(), res);

    expect(queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('UPDATE payslips AS payslip')))
      .toBe(true);
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(logAudit).not.toHaveBeenCalled();
    expect(outboxQueue).toHaveBeenCalledTimes(3);
  });

  // Migration 669's other half. A payslip is only collectable once its document
  // exists AND the in-app notification telling the staff member about it has an
  // acknowledged provider receipt; until then issue refuses with 409 and names
  // who is still waiting. Without this case the suite's SQL router answers the
  // delivery probe with an empty set on every path, so the gate is satisfied by
  // construction and never exercised.
  it('refuses to issue while a payslip document delivery is still pending', async () => {
    installQueryRouter({ runRow: approvedWithFailures({ failed_staff_count: 0, failed_staff: [] }) });
    // Re-point ONLY the delivery probe at a pending row; every other route stays.
    const routed = queryRawUnsafe.getMockImplementation();
    queryRawUnsafe.mockImplementation(async (sql, ...params) => {
      if (sql.includes('FROM payroll_run_staff_results AS result')
          && sql.includes('LEFT JOIN payslip_documents')) {
        return [{ staff_uid: STAFF_A, delivery_state: 'notification_pending' }];
      }
      return routed(sql, ...params);
    });
    const res = makeRes();

    await issuePayslips(issueReq(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.code).toBe('PAYSLIP_DELIVERY_PENDING');
    expect(body.details.pending_staff).toEqual([
      { staff_uid: STAFF_A, state: 'notification_pending' },
    ]);
    // Nothing was issued, locked, or announced.
    expect(queryRawUnsafe.mock.calls.some(([sql]) => sql.includes('UPDATE payslips AS payslip')))
      .toBe(false);
    expect(executeRawUnsafe.mock.calls.some(([sql]) => sql.includes("SET status = 'locked'")))
      .toBe(false);
    expect(outboxQueue).not.toHaveBeenCalled();
  });
});
