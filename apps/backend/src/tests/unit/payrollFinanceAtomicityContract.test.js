import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../services/staff/payrollService.js', import.meta.url),
  'utf8',
);

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

test('calculation persists a finance plan without applying money effects', () => {
  const generate = between(
    'export async function generatePayslipForStaff',
    'export async function recordPayrollStaffFailure',
  );

  expect(generate).toContain('finance_effects = $10::jsonb');
  expect(generate).not.toContain('UPDATE salary_advances');
  expect(generate).not.toContain('UPDATE salary_arrears');
  expect(generate).not.toContain('INSERT INTO advance_deductions');
});

test('finance effects, outbox enqueue, and current-result success share one transaction', () => {
  const delivery = between(
    "if (prepared.status === 'uploaded')",
    'export async function reconcilePayslipDocumentProviderAcceptance',
  );
  const transaction = delivery.indexOf('setTenantTx(tid, async (tx) =>');
  const runFence = delivery.indexOf('FROM payroll_runs');
  const finance = delivery.indexOf('applyPayrollFinanceEffectsTx(tx,');
  const outbox = delivery.indexOf('notificationOutbox.queue(');
  const success = delivery.indexOf("SET outcome = 'succeeded'");

  expect(transaction).toBeGreaterThanOrEqual(0);
  expect(runFence).toBeGreaterThan(transaction);
  expect(finance).toBeGreaterThan(runFence);
  expect(outbox).toBeGreaterThan(finance);
  expect(success).toBeGreaterThan(outbox);
});

test('stale recovery reverses committed effects before superseding attempt ownership', () => {
  const recovery = between(
    'export async function beginPayrollRun',
    'export async function heartbeatPayrollRunAttempt',
  );
  const reverse = recovery.indexOf('reversePayrollFinanceEffectsTx(');
  const supersedeResults = recovery.indexOf('UPDATE payroll_run_staff_results');

  expect(reverse).toBeGreaterThanOrEqual(0);
  expect(supersedeResults).toBeGreaterThan(reverse);
  expect(recovery).toContain('AND result.payslip_id IS NOT NULL');
  expect(recovery).not.toContain("AND result.outcome = 'succeeded'\n                 AND result.payslip_id IS NOT NULL");
  expect(recovery).toContain('FOR UPDATE OF outbox');
  expect(recovery).toContain("noticeRows.some(row => row.status === 'SENT')");
  expect(recovery).toContain("if (existing.status !== 'processing')");
  expect(recovery).toContain('A completed payroll with an externally visible payslip notice cannot be rerun automatically');
  expect(recovery).toContain("!['PENDING', 'FAILED'].includes(row.status)");
});

test('nullable legacy advance totals remain atomic when delivery commits', () => {
  const apply = between(
    'async function applyPayrollFinanceEffectsTx',
    'export async function ensurePayslipDocumentReady',
  );

  expect(apply).toContain('total_deducted = COALESCE(total_deducted, 0) + $4::numeric');
  expect(apply).toContain('WHEN COALESCE(total_deducted, 0) + $4::numeric >= amount');
});
