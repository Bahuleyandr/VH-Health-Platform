import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { requireTenantId } from '../services/tenant/tenantService.js';
import { executePayrollRun } from '../services/staff/payrollService.js';

export async function runMonthlyPayrollForTenant(tenantId, now = new Date()) {
  const tid = requireTenantId(tenantId);
  let month = now.getMonth();
  let year = now.getFullYear();
  if (month === 0) {
    month = 12;
    year -= 1;
  }

  const run = await executePayrollRun({
    tenantId: tid,
    month,
    year,
    rerunCompleted: false,
  });
  if (run.skipped) {
    logger.info(`Payroll for tenant ${tid} and ${month}/${year} skipped (${run.reason})`);
    return { skipped: true, reason: run.reason, month, year };
  }

  logger.info(
    `Monthly payroll for tenant ${tid}: ${run.processed} payslips written, ` +
    `${run.failures} failed for ${month}/${year}`
  );
  return {
    skipped: false,
    month,
    year,
    processed: run.processed,
    failures: run.failures,
    run_id: run.run_id,
  };
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
