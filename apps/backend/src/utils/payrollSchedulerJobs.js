import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { requireTenantId } from '../services/tenant/tenantService.js';
import {
  calculatePayslip,
  savePayslip,
  recordPayrollFailure,
  summarizePayrollRunOutcome,
} from '../services/staff/payrollService.js';

export async function runMonthlyPayrollForTenant(tenantId, now = new Date()) {
  const tid = requireTenantId(tenantId);
  let month = now.getMonth();
  let year = now.getFullYear();
  if (month === 0) {
    month = 12;
    year -= 1;
  }

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, status
       FROM payroll_runs
      WHERE tenant_id = $1::uuid AND month = $2 AND year = $3`,
    tid,
    month,
    year
  );
  if (existing[0]?.status === 'completed') {
    logger.info(`Payroll for tenant ${tid} and ${month}/${year} already completed`);
    return { skipped: true, month, year };
  }

  const staffList = await prisma.$queryRawUnsafe(
    `SELECT ss.staff_uid, u.name, u.role,
            COALESCE(s.department, ss.department) AS department
       FROM staff_salary ss
       JOIN users u
         ON u.uid = ss.staff_uid
        AND u.tenant_id = ss.tenant_id
       LEFT JOIN staff s
         ON s.user_id = u.uid
        AND s.tenant_id = ss.tenant_id
      WHERE ss.tenant_id = $1::uuid
        AND ss.is_active = true`,
    tid
  );

  const run = await prisma.$queryRawUnsafe(
    `INSERT INTO payroll_runs (tenant_id, month, year, status)
     VALUES ($1::uuid, $2, $3, 'processing')
     ON CONFLICT (tenant_id, month, year) DO UPDATE
       SET status = 'processing', failed_staff_count = 0, failed_staff = NULL,
           updated_at = NOW()
     RETURNING id`,
    tid,
    month,
    year
  );
  const runId = run[0].id;
  let processed = 0;
  const failures = [];
  let totalGross = 0;
  let totalNet = 0;
  let totalDeductions = 0;

  for (const staff of staffList) {
    try {
      const calculation = await calculatePayslip(staff.staff_uid, month, year);
      await savePayslip(runId, calculation, tid);
      totalGross += Number(calculation.gross_salary) || 0;
      totalNet += Number(calculation.net_salary) || 0;
      totalDeductions += Number(calculation.total_deductions) || 0;
      processed += 1;
    } catch (err) {
      logger.error(`Payroll calc failed for ${staff.staff_uid}: ${err.message}`);
      recordPayrollFailure(failures, staff.staff_uid, err);
    }
  }

  const outcome = summarizePayrollRunOutcome({
    processed,
    failures,
    totalGross,
    totalNet,
    totalDeductions,
  });
  await prisma.$queryRawUnsafe(
    `UPDATE payroll_runs
        SET status = $1, total_staff = $2, total_gross = $3, total_net = $4,
            total_deductions = $5, failed_staff_count = $6,
            failed_staff = $7::jsonb, updated_at = NOW()
      WHERE tenant_id = $8::uuid AND id = $9`,
    outcome.status,
    outcome.total_staff,
    outcome.total_gross,
    outcome.total_net,
    outcome.total_deductions,
    outcome.failed_staff_count,
    JSON.stringify(outcome.failed_staff),
    tid,
    runId
  );

  logger.info(
    `Monthly payroll for tenant ${tid}: ${processed} payslips written, ` +
    `${outcome.failed_staff_count} failed for ${month}/${year}`
  );
  return { skipped: false, month, year, processed, failures: outcome.failed_staff_count };
}

export async function runAnnualSalaryReviewForTenant(tenantId, year = new Date().getFullYear()) {
  const tid = requireTenantId(tenantId);
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO annual_review_reminders
       (tenant_id, staff_uid, review_year, reminder_sent_at)
     SELECT ss.tenant_id, ss.staff_uid, $2, NOW()
       FROM staff_salary ss
      WHERE ss.tenant_id = $1::uuid
        AND ss.is_active = true
        AND ss.date_of_joining IS NOT NULL
        AND ss.date_of_joining::date <= CURRENT_DATE - INTERVAL '11 months'
     ON CONFLICT (tenant_id, staff_uid, review_year) DO NOTHING
     RETURNING id`,
    tid,
    year
  );
  logger.info(`Annual review reminders for tenant ${tid}: ${inserted.length} created for ${year}`);
  return { year, created: inserted.length };
}

export default { runMonthlyPayrollForTenant, runAnnualSalaryReviewForTenant };
