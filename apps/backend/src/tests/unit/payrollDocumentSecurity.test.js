import { readFileSync } from 'node:fs';
import { generatePayslipPDF } from '../../utils/payslipPDF.js';
import { isGenericCleanupEligible } from '../../utils/r2CleanupJob.js';

const hrRoutes = readFileSync(new URL('../../routes/staff/hrRoutes.js', import.meta.url), 'utf8');
const staffAdminRoutes = readFileSync(
  new URL('../../routes/staff/staffAdminRoutes.js', import.meta.url),
  'utf8',
);

const PAYSLIP = {
  month: 8,
  year: 2096,
  total_working_days: 26,
  days_present: 26,
  days_absent: 0,
  days_leave: 0,
  overtime_hours: 0,
  basic_earned: 100,
  hra_earned: 0,
  da_earned: 0,
  special_allowance_earned: 0,
  transport_allowance_earned: 0,
  medical_allowance_earned: 0,
  overtime_pay: 0,
  bonus_this_month: 0,
  arrears_amount: 0,
  gross_salary: 100,
  pf_employee: 0,
  esi_employee: 0,
  professional_tax: 0,
  tds: 0,
  total_deductions: 0,
  net_salary: 100,
};

test('payslip PDFs use the PDFKit AES-256 security dictionary', async () => {
  process.env.PDF_OWNER_PASSWORD = 'fin-v3-unit-owner-password';
  const { buffer, userPassword } = await generatePayslipPDF(PAYSLIP, {
    name: 'FIN v3 Security Test',
  });
  const pdf = buffer.toString('latin1');

  expect(userPassword.length).toBeGreaterThanOrEqual(12);
  expect(pdf).toMatch(/\/V 5\b/);
  expect(pdf).toMatch(/\/Length 256\b/);
  expect(pdf).toMatch(/\/CFM \/AESV3\b/);
});

test('generic object cleanup excludes payroll retention-managed objects', () => {
  expect(isGenericCleanupEligible('payroll/tenant/2096/08/1/r1/v1.pdf')).toBe(false);
  expect(isGenericCleanupEligible('/payroll/tenant/2096/08/1/r1/v1.pdf')).toBe(false);
  expect(isGenericCleanupEligible('documents/old.pdf')).toBe(true);
});

test('credential reveal is POST-only so service workers cannot cache the secret response', () => {
  const getRoutes = hrRoutes.slice(hrRoutes.indexOf('get: ['), hrRoutes.indexOf('post: ['));
  const postRoutes = hrRoutes.slice(hrRoutes.indexOf('post: ['));
  expect(getRoutes).not.toContain('payslips/:id/password');
  expect(postRoutes).toContain('payslips/:id/password');
  expect(hrRoutes).toContain("['/payslips/:id/password', guardPayslipView, payrollController.revealPayslipPassword]");
  expect(hrRoutes).toContain("['/payroll/my-payslips/:id/password', guardPayslipView, payrollController.revealPayslipPassword]");
});

test('manual payroll generation requires request-level idempotency', () => {
  expect(staffAdminRoutes).toMatch(
    /'\/payroll\/run',[\s\S]*?requireIdempotencyKey\(\{ required: true, scope: 'payroll_run' \}\)/,
  );
});
