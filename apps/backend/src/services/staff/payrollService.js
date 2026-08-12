// src/services/staff/payrollService.js
import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

// Overtime rate: (basic / 26 working days / 8 hours) * 2 (double rate)
function calcOvertimeRate(basicMonthly) {
  return (basicMonthly / 26 / 8) * 2;
}

// ESI: applicable if gross < 21000, employee contributes 0.75%
function calcESI(gross, applicable) {
  if (!applicable || gross >= 21000) return 0;
  return Math.round(gross * 0.0075 * 100) / 100;
}

// Professional tax slab (Tamil Nadu / general)
function calcProfessionalTax(grossMonthly) {
  if (grossMonthly <= 21000) return 0;
  if (grossMonthly <= 30000) return 135;
  return 200;
}

/**
 * Calculate payslip for one staff member for a given month.
 * Pulls attendance, approved overtime, approved leaves from DB.
 * staffUid = users.uid (UUID)
 */
export async function calculatePayslip(staffUid, month, year) {
  // Get salary config
  const salaryRes = await prisma.$queryRawUnsafe(
    'SELECT id, staff_uid, basic_salary, hra_pct, da_pct, special_allowance, transport_allowance, medical_allowance, pf_employee_pct, esi_applicable, tds_monthly, is_active, effective_from FROM staff_salary WHERE staff_uid = $1::uuid AND is_active = true',
    staffUid
  );
  if (salaryRes.length === 0) {
    throw new Error(`No salary configuration found for staff ${staffUid}`);
  }
  const sal = salaryRes[0];

  // Total working days per month (standard 26 for Indian hospitals)
  const totalWorkingDays = 26;

  // Get attendance for this month (staff_attendance uses staff_uid UUID).
  // The table has no `status`/`date` columns — the marked-attendance flag is
  // `attendance_status` and the event time is check_in_time (falling back to the
  // generic `timestamp` column), mirroring attendanceController's date derivation.
  //
  // No `.catch()` here (nor on any query below). A swallowed failure used to
  // yield days_present = 0, which silently prorated the whole payslip to ~zero
  // and applied a full month of LOP — a fabricated, payable, wrong number. Any
  // query failure (including the 30s circuit-breaker-open window in
  // lib/prisma.js) must abort this payslip so the caller records it as failed.
  const attRes = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*) FILTER (WHERE attendance_status IS NOT NULL) as days_present,
      SUM(COALESCE(overtime_hours, 0)) as total_overtime_hours
    FROM staff_attendance
    WHERE staff_uid = $1::uuid
      AND EXTRACT(MONTH FROM COALESCE(check_in_time, "timestamp")) = $2
      AND EXTRACT(YEAR FROM COALESCE(check_in_time, "timestamp")) = $3
  `, staffUid, month, year);

  const daysPresent = parseInt(attRes[0]?.days_present || 0);
  const overtimeHours = parseFloat(attRes[0]?.total_overtime_hours || 0);

  // Get approved leaves this month. leave_applications has NO staff_uid; the FK
  // is staff_id INTEGER → users.id, and the date columns are start_date/end_date
  // (NOT from_date/to_date). calculatePayslip is called with staffUid = users.uid
  // (a UUID), so bridge uid→id in the WHERE. status values are lowercase
  // ('approved' on review) — LOWER() for safety.
  const leaveRes = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(SUM(
      LEAST(end_date::date, (make_date($3::int, $2::int, 1) + INTERVAL '1 month - 1 day')::date)::date
      - GREATEST(start_date::date, make_date($3::int, $2::int, 1))::date
      + 1
    ), 0) as leave_days
    FROM leave_applications
    WHERE staff_id = (SELECT id FROM users WHERE uid = $1::uuid)
      AND LOWER(status) = 'approved'
      AND start_date::date <= (make_date($3::int, $2::int, 1) + INTERVAL '1 month - 1 day')::date
      AND end_date::date >= make_date($3::int, $2::int, 1)
  `, staffUid, month, year);

  const leaveDays = parseInt(leaveRes[0]?.leave_days || 0);

  // Get approved overtime for this month
  // overtime_requests.staff_id is INTEGER - need users.id
  const userRes = await prisma.$queryRawUnsafe('SELECT id FROM users WHERE uid = $1', staffUid);
  const userId = userRes[0]?.id;

  let approvedOT = overtimeHours;
  if (userId) {
    const otRes = await prisma.$queryRawUnsafe(`
      SELECT COALESCE(SUM(extra_hours), 0) as approved_overtime
      FROM overtime_requests
      WHERE staff_id = $1
        AND status = 'approved'
        AND EXTRACT(MONTH FROM date::date) = $2
        AND EXTRACT(YEAR FROM date::date) = $3
    `, userId, month, year);
    approvedOT = parseFloat(otRes[0]?.approved_overtime || overtimeHours);
  }

  // ─── Calculate earnings ──────────────────────────────────────────────────
  const effectiveDays = Math.min(daysPresent + leaveDays, totalWorkingDays);
  const attendanceFactor = effectiveDays / totalWorkingDays;

  const basicEarned = Math.round(sal.basic_salary * attendanceFactor * 100) / 100;
  const hraEarned   = Math.round(basicEarned * (sal.hra_pct / 100) * 100) / 100;
  const daEarned    = Math.round(basicEarned * (sal.da_pct / 100) * 100) / 100;
  const specialEarned    = Math.round(sal.special_allowance * attendanceFactor * 100) / 100;
  const transportEarned  = Math.round(sal.transport_allowance * attendanceFactor * 100) / 100;
  const medicalEarned    = Math.round(sal.medical_allowance * attendanceFactor * 100) / 100;

  const otRate = calcOvertimeRate(sal.basic_salary);
  const overtimePay = Math.round(approvedOT * otRate * 100) / 100;

  // ─── FEATURE 4: Check for pending arrears ───────────────────────────────
  const arrearsRes = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(SUM(arrears_amount), 0) as total FROM salary_arrears
    WHERE staff_uid = $1::uuid AND status = 'pending'
  `, staffUid);
  const arrearsAmount = parseFloat(arrearsRes[0]?.total || 0);

  const grossSalary = basicEarned + hraEarned + daEarned + specialEarned +
    transportEarned + medicalEarned + overtimePay + arrearsAmount;

  // ─── Calculate deductions ────────────────────────────────────────────────
  const pfEmployee = Math.round(basicEarned * (sal.pf_employee_pct / 100) * 100) / 100;
  const esiEmployee = calcESI(grossSalary, sal.esi_applicable);
  const professionalTax = calcProfessionalTax(grossSalary);
  const tds = parseFloat(sal.tds_monthly || 0);
  const totalDeductions = pfEmployee + esiEmployee + professionalTax + tds;

  // ─── FEATURE 5: Explicit LOP calculation ────────────────────────────────
  // LOP = days absent (not covered by approved leave) × (basic/26)
  const daysAbsent = Math.max(0, totalWorkingDays - daysPresent - leaveDays);
  const lopDays = daysAbsent; // already implicitly in basicEarned prorating, but explicit here
  const lopDailyRate = sal.basic_salary / 26;
  const lopDeduction = Math.round(lopDays * lopDailyRate * 100) / 100;

  // ─── FEATURE 3: Check for active salary advances to deduct ──────────────
  // SELECT the columns the deduction loop actually reads (monthly_deduction,
  // total_deducted) — the table has no deduction_month/deduction_year columns;
  // the schedule columns are deduction_start_month/deduction_start_year.
  const advanceRes = await prisma.$queryRawUnsafe(`
    SELECT id, staff_uid, amount, monthly_deduction, total_deducted, status, created_at FROM salary_advances
    WHERE staff_uid = $1::uuid
      AND status = 'approved'
      AND deduction_start_year <= $3
      AND (deduction_start_year < $3 OR deduction_start_month <= $2)
      AND total_deducted < amount
    ORDER BY created_at ASC
  `, staffUid, month, year);

  let totalAdvanceDeduction = 0;
  const advancesToProcess = [];
  for (const adv of advanceRes) {
    const remaining = parseFloat(adv.amount) - parseFloat(adv.total_deducted);
    const deductThis = Math.min(parseFloat(adv.monthly_deduction), remaining);
    totalAdvanceDeduction += deductThis;
    advancesToProcess.push({ id: adv.id, amount: deductThis, balanceAfter: remaining - deductThis });
  }

  const netSalary = Math.round((grossSalary - totalDeductions - totalAdvanceDeduction) * 100) / 100;

  // ─── FEATURE 2: Check for salary revision note ──────────────────────────
  const revisionCheck = await prisma.$queryRawUnsafe(`
    SELECT sr.revision_number, sr.revision_type,
           sr.current_basic, sr.proposed_basic,
           sr.bonus_amount, sr.increment_pct, sr.effective_from
    FROM salary_revisions sr
    WHERE sr.staff_uid = $1::uuid
      AND sr.status = 'applied'
      AND EXTRACT(MONTH FROM sr.effective_from::date) = $2
      AND EXTRACT(YEAR FROM sr.effective_from::date) = $3
    LIMIT 1
  `, staffUid, month, year);

  let revisionNote = null;
  if (revisionCheck.length > 0) {
    const r = revisionCheck[0];
    if (r.revision_type === 'increment' && r.current_basic && r.proposed_basic) {
      revisionNote = `Increment applied (${r.revision_number}): ₹${Number(r.current_basic).toLocaleString('en-IN')} → ₹${Number(r.proposed_basic).toLocaleString('en-IN')} effective ${new Date(r.effective_from).toLocaleDateString('en-IN')}`;
    } else if (r.revision_type === 'bonus') {
      revisionNote = `Bonus paid (${r.revision_number}): ₹${Number(r.bonus_amount).toLocaleString('en-IN')}`;
    }
  }

  return {
    staff_uid: staffUid,
    month, year,
    total_working_days: totalWorkingDays,
    days_present: daysPresent,
    days_absent: daysAbsent,
    days_leave: leaveDays,
    overtime_hours: approvedOT,
    overtime_rate: Math.round(otRate * 100) / 100,
    basic_earned: basicEarned,
    hra_earned: hraEarned,
    da_earned: daEarned,
    special_allowance_earned: specialEarned,
    transport_allowance_earned: transportEarned,
    medical_allowance_earned: medicalEarned,
    overtime_pay: overtimePay,
    arrears_amount: arrearsAmount,
    gross_salary: Math.round(grossSalary * 100) / 100,
    pf_employee: pfEmployee,
    esi_employee: esiEmployee,
    professional_tax: professionalTax,
    tds,
    total_deductions: Math.round(totalDeductions * 100) / 100,
    advance_deduction: totalAdvanceDeduction,
    lop_days: lopDays,
    lop_deduction: lopDeduction,
    net_salary: netSalary,
    revision_note: revisionNote,
    salary_config: sal,
    attendance_factor: Math.round(attendanceFactor * 100) / 100,
    _advances_to_process: advancesToProcess, // internal, used after saving payslip
  };
}

// Cap on a persisted failure reason. The reason is an internal error string, so
// it is bounded before it ever reaches a column; the runs-list endpoint does not
// select it (see payrollController.getPayrollRuns).
const FAILURE_REASON_MAX = 500;

/**
 * Record one staff member's payroll failure onto a run's failure list.
 * Reason is the internal error text — kept server-side for operators, never
 * returned by the runs-list endpoint.
 */
export function recordPayrollFailure(failures, staffUid, err) {
  const reason = String(err?.message || err || 'Unknown error').slice(0, FAILURE_REASON_MAX);
  failures.push({ staff_uid: staffUid, reason });
  return failures;
}

/**
 * Collapse a payroll run's per-staff outcomes into the columns persisted on
 * payroll_runs.
 *
 * Both entry points call this — the admin-triggered run
 * (payrollController.runPayroll) and the monthly cron (utils/scheduler.js) — so
 * neither can record a partially-failed run as a clean 'completed'. A run with
 * any failed staff member ends 'completed_with_errors' and carries the failed
 * count, which is what tells an operator that payslips are missing rather than
 * that nobody was owed anything. `status` is VARCHAR(32) as of migration 644;
 * 'completed_with_errors' is 21 chars and does not fit the original VARCHAR(20).
 */
export function summarizePayrollRunOutcome({
  processed,
  failures = [],
  totalGross = 0,
  totalNet = 0,
  totalDeductions = 0,
}) {
  return {
    status: failures.length === 0 ? 'completed' : 'completed_with_errors',
    total_staff: processed,
    failed_staff_count: failures.length,
    // Always an array, never null: a re-run that now succeeds must overwrite a
    // previous attempt's failure list rather than leave it standing, and an
    // empty array writes cleanly through both Prisma and raw jsonb (a bare
    // `null` on a Json column needs Prisma.DbNull and would silently no-op).
    failed_staff: failures,
    total_gross: totalGross.toFixed(2),
    total_net: totalNet.toFixed(2),
    total_deductions: totalDeductions.toFixed(2),
  };
}

// Columns returned by savePayslip — kept separate so the upsert create/update
// branches (and downstream callers like runPayroll) stay consistent.
/**
 * Save payslip to DB (upsert).
 */
export async function savePayslip(payrollRunId, data, tenantId) {
  const tid = requireTenantId(tenantId);
  const payload = {
    total_working_days: data.total_working_days,
    days_present: data.days_present,
    days_absent: data.days_absent,
    days_leave: data.days_leave,
    overtime_hours: data.overtime_hours,
    overtime_rate: data.overtime_rate,
    basic_earned: data.basic_earned,
    hra_earned: data.hra_earned,
    da_earned: data.da_earned,
    special_allowance_earned: data.special_allowance_earned,
    transport_allowance_earned: data.transport_allowance_earned,
    medical_allowance_earned: data.medical_allowance_earned,
    overtime_pay: data.overtime_pay,
    arrears_amount: data.arrears_amount || 0,
    gross_salary: data.gross_salary,
    pf_employee: data.pf_employee,
    esi_employee: data.esi_employee,
    professional_tax: data.professional_tax,
    tds: data.tds,
    total_deductions: data.total_deductions,
    advance_deduction: data.advance_deduction || 0,
    lop_days: data.lop_days || 0,
    lop_deduction: data.lop_deduction || 0,
    net_salary: data.net_salary,
    revision_note: data.revision_note || null,
  };

  const rows = await prisma.$queryRawUnsafe(
    `WITH input AS (
       SELECT (jsonb_populate_record(NULL::payslips, $6::jsonb)).*
     )
     INSERT INTO payslips (
       tenant_id, payroll_run_id, staff_uid, month, year, status,
       total_working_days, days_present, days_absent, days_leave,
       overtime_hours, overtime_rate, basic_earned, hra_earned, da_earned,
       special_allowance_earned, transport_allowance_earned,
       medical_allowance_earned, overtime_pay, arrears_amount, gross_salary,
       pf_employee, esi_employee, professional_tax, tds, total_deductions,
       advance_deduction, lop_days, lop_deduction, net_salary, revision_note
     )
     SELECT $1::uuid, $2::integer, $3::uuid, $4::integer, $5::integer, 'draft',
       total_working_days, days_present, days_absent, days_leave,
       overtime_hours, overtime_rate, basic_earned, hra_earned, da_earned,
       special_allowance_earned, transport_allowance_earned,
       medical_allowance_earned, overtime_pay, arrears_amount, gross_salary,
       pf_employee, esi_employee, professional_tax, tds, total_deductions,
       advance_deduction, lop_days, lop_deduction, net_salary, revision_note
       FROM input
     ON CONFLICT (tenant_id, staff_uid, month, year) DO UPDATE SET
       payroll_run_id = EXCLUDED.payroll_run_id,
       total_working_days = EXCLUDED.total_working_days,
       days_present = EXCLUDED.days_present,
       days_absent = EXCLUDED.days_absent,
       days_leave = EXCLUDED.days_leave,
       overtime_hours = EXCLUDED.overtime_hours,
       overtime_rate = EXCLUDED.overtime_rate,
       basic_earned = EXCLUDED.basic_earned,
       hra_earned = EXCLUDED.hra_earned,
       da_earned = EXCLUDED.da_earned,
       special_allowance_earned = EXCLUDED.special_allowance_earned,
       transport_allowance_earned = EXCLUDED.transport_allowance_earned,
       medical_allowance_earned = EXCLUDED.medical_allowance_earned,
       overtime_pay = EXCLUDED.overtime_pay,
       arrears_amount = EXCLUDED.arrears_amount,
       gross_salary = EXCLUDED.gross_salary,
       pf_employee = EXCLUDED.pf_employee,
       esi_employee = EXCLUDED.esi_employee,
       professional_tax = EXCLUDED.professional_tax,
       tds = EXCLUDED.tds,
       total_deductions = EXCLUDED.total_deductions,
       advance_deduction = EXCLUDED.advance_deduction,
       lop_days = EXCLUDED.lop_days,
       lop_deduction = EXCLUDED.lop_deduction,
       net_salary = EXCLUDED.net_salary,
       revision_note = EXCLUDED.revision_note,
       updated_at = NOW()
     RETURNING id, payroll_run_id, staff_uid, month, year,
       total_working_days, days_present, days_absent, days_leave,
       overtime_hours, overtime_rate, basic_earned, hra_earned, da_earned,
       special_allowance_earned, transport_allowance_earned,
       medical_allowance_earned, overtime_pay, arrears_amount, gross_salary,
       pf_employee, esi_employee, professional_tax, tds, total_deductions,
       advance_deduction, lop_days, lop_deduction, net_salary, revision_note,
       status, created_at, updated_at, tenant_id`,
    tid,
    payrollRunId,
    data.staff_uid,
    data.month,
    data.year,
    JSON.stringify(payload),
  );
  return rows[0];
}

/**
 * FEATURE 1: Generate annual tax summary for a staff member for a financial year.
 * Financial year in India: April to March. E.g., FY 2025-26 = Apr 2025 to Mar 2026.
 */
export async function generateAnnualTaxSummary(staffUid, financialYear) {
  const [startYearStr] = financialYear.split('-');
  const startYear = parseInt(startYearStr);
  const endYear = startYear + 1;

  const payslips = await prisma.$queryRawUnsafe(`
    SELECT id, staff_uid, month, year, payroll_run_id, basic_earned, hra_earned, da_earned, special_allowance_earned, transport_allowance_earned, medical_allowance_earned, overtime_pay, bonus_this_month, arrears_amount, gross_salary, pf_employee, esi_employee, professional_tax, tds, total_deductions, net_salary, status, created_at FROM payslips
    WHERE staff_uid = $1::uuid
      AND status IN ('issued','viewed','downloaded')
      AND (
        (year = $2 AND month >= 4) OR
        (year = $3 AND month <= 3)
      )
    ORDER BY year, month
  `, staffUid, startYear, endYear);

  if (payslips.length === 0) {
    throw new Error('No payslips found for this financial year');
  }

  const totals = payslips.reduce((acc, p) => {
    acc.basic       += parseFloat(p.basic_earned || 0);
    acc.hra         += parseFloat(p.hra_earned || 0);
    acc.da          += parseFloat(p.da_earned || 0);
    acc.special     += parseFloat(p.special_allowance_earned || 0);
    acc.transport   += parseFloat(p.transport_allowance_earned || 0);
    acc.medical     += parseFloat(p.medical_allowance_earned || 0);
    acc.overtime    += parseFloat(p.overtime_pay || 0);
    acc.bonus       += parseFloat(p.bonus_this_month || 0);
    acc.arrears     += parseFloat(p.arrears_amount || 0);
    acc.gross       += parseFloat(p.gross_salary || 0);
    acc.pf          += parseFloat(p.pf_employee || 0);
    acc.esi         += parseFloat(p.esi_employee || 0);
    acc.pt          += parseFloat(p.professional_tax || 0);
    acc.tds         += parseFloat(p.tds || 0);
    acc.advances    += parseFloat(p.advance_deduction || 0);
    acc.deductions  += parseFloat(p.total_deductions || 0);
    acc.net         += parseFloat(p.net_salary || 0);
    return acc;
  }, {
    basic:0, hra:0, da:0, special:0, transport:0, medical:0,
    overtime:0, bonus:0, arrears:0, gross:0,
    pf:0, esi:0, pt:0, tds:0, advances:0, deductions:0, net:0
  });

  // Taxable income = Gross - PF - PT - Standard deduction (₹50,000)
  const standardDeduction = 50000;
  const taxableIncome = Math.max(0, totals.gross - totals.pf - totals.pt - standardDeduction);

  // New regime tax calculation (FY 2025-26 slabs)
  let taxPayable = 0;
  if (taxableIncome > 300000) {
    const slabs = [
      [300000, 700000, 0.05],
      [700000, 1000000, 0.10],
      [1000000, 1200000, 0.15],
      [1200000, 1500000, 0.20],
      [1500000, Infinity, 0.30],
    ];
    for (const [low, high, rate] of slabs) {
      if (taxableIncome > low) {
        taxPayable += (Math.min(taxableIncome, high) - low) * rate;
      }
    }
    // 4% health and education cess
    taxPayable *= 1.04;
  }

  const summary = {
    staff_uid: staffUid,
    financial_year: financialYear,
    total_basic: Math.round(totals.basic * 100) / 100,
    total_hra: Math.round(totals.hra * 100) / 100,
    total_da: Math.round(totals.da * 100) / 100,
    total_special_allowance: Math.round(totals.special * 100) / 100,
    total_transport_allowance: Math.round(totals.transport * 100) / 100,
    total_medical_allowance: Math.round(totals.medical * 100) / 100,
    total_overtime: Math.round(totals.overtime * 100) / 100,
    total_bonus: Math.round(totals.bonus * 100) / 100,
    total_arrears: Math.round(totals.arrears * 100) / 100,
    total_gross: Math.round(totals.gross * 100) / 100,
    total_pf: Math.round(totals.pf * 100) / 100,
    total_esi: Math.round(totals.esi * 100) / 100,
    total_professional_tax: Math.round(totals.pt * 100) / 100,
    total_tds: Math.round(totals.tds * 100) / 100,
    total_advance_deductions: Math.round(totals.advances * 100) / 100,
    total_deductions: Math.round(totals.deductions * 100) / 100,
    total_net: Math.round(totals.net * 100) / 100,
    taxable_income: Math.round(taxableIncome * 100) / 100,
    tax_payable: Math.round(taxPayable * 100) / 100,
    months_included: payslips.length,
  };

  const now = new Date();
  const payload = {
    total_basic: summary.total_basic,
    total_hra: summary.total_hra,
    total_da: summary.total_da,
    total_special_allowance: summary.total_special_allowance,
    total_transport_allowance: summary.total_transport_allowance,
    total_medical_allowance: summary.total_medical_allowance,
    total_overtime: summary.total_overtime,
    total_bonus: summary.total_bonus,
    total_arrears: summary.total_arrears,
    total_gross: summary.total_gross,
    total_pf: summary.total_pf,
    total_esi: summary.total_esi,
    total_professional_tax: summary.total_professional_tax,
    total_tds: summary.total_tds,
    total_advance_deductions: summary.total_advance_deductions,
    total_deductions: summary.total_deductions,
    total_net: summary.total_net,
    taxable_income: summary.taxable_income,
    tax_payable: summary.tax_payable,
    months_included: summary.months_included,
    generated_at: now,
  };

  return prisma.annual_tax_summaries.upsert({
    where: {
      staff_uid_financial_year: {
        staff_uid: summary.staff_uid,
        financial_year: summary.financial_year,
      },
    },
    create: {
      staff_uid: summary.staff_uid,
      financial_year: summary.financial_year,
      ...payload,
    },
    update: {
      ...payload,
      updated_at: now,
    },
    select: {
      id: true,
      staff_uid: true,
      financial_year: true,
      total_basic: true,
      total_hra: true,
      total_da: true,
      total_special_allowance: true,
      total_transport_allowance: true,
      total_medical_allowance: true,
      total_overtime: true,
      total_bonus: true,
      total_arrears: true,
      total_gross: true,
      total_pf: true,
      total_esi: true,
      total_professional_tax: true,
      total_tds: true,
      total_advance_deductions: true,
      total_deductions: true,
      total_net: true,
      taxable_income: true,
      tax_payable: true,
      months_included: true,
      generated_at: true,
      created_at: true,
      updated_at: true,
    },
  });
}

/**
 * FEATURE 4: Calculate arrears when a salary revision is backdated.
 */
export async function calculateArrears(revisionId) {
  const revision = await prisma.$queryRawUnsafe(
    "SELECT id, staff_uid, revision_type, current_basic, proposed_basic, current_gross, proposed_gross, effective_from, applied_at, status, created_at FROM salary_revisions WHERE id=$1 AND status='applied'",
    revisionId
  );
  if (revision.length === 0) throw new Error('Revision not found or not applied');

  const r = revision[0];
  if (!r.proposed_basic || !r.current_basic) throw new Error('No basic salary change in this revision');

  const effectiveDate = new Date(r.effective_from);
  const now = new Date();

  // Check if revision was applied after effective_from (backdated)
  if (effectiveDate >= new Date(r.applied_at || now)) {
    return { arrears_amount: 0, message: 'No backdated arrears — revision applied before or on effective date' };
  }

  // Months where old salary was paid but new salary should have applied
  const arrearMonths = [];
  const d = new Date(effectiveDate);
  d.setDate(1);
  const appliedMonth = new Date(r.applied_at || now);
  appliedMonth.setDate(1);

  while (d < appliedMonth) {
    arrearMonths.push({ month: d.getMonth() + 1, year: d.getFullYear() });
    d.setMonth(d.getMonth() + 1);
  }

  if (arrearMonths.length === 0) return { arrears_amount: 0, message: 'No arrear months found' };

  const diffBasic = parseFloat(r.proposed_basic) - parseFloat(r.current_basic);
  let totalArrears = 0;

  for (const { month, year } of arrearMonths) {
    const payslip = await prisma.$queryRawUnsafe(
      'SELECT id, staff_uid, month, year, payroll_run_id, basic_earned, hra_earned, da_earned, special_allowance_earned, transport_allowance_earned, medical_allowance_earned, overtime_pay, gross_salary, pf_employee, esi_employee, professional_tax, tds, total_deductions, net_salary, status, days_present, total_working_days, created_at FROM payslips WHERE staff_uid=$1::uuid AND month=$2 AND year=$3',
      r.staff_uid, month, year
    );
    if (payslip.length > 0) {
      const p = payslip[0];
      const attendanceFactor = p.days_present / (p.total_working_days || 26);
      totalArrears += diffBasic * attendanceFactor;
    } else {
      totalArrears += diffBasic;
    }
  }

  const fromDate = arrearMonths[0];
  const toDate = arrearMonths[arrearMonths.length - 1];

  // salary_arrears has no unique constraint — the old `ON CONFLICT DO NOTHING`
  // was a defensive no-op that never fired (autoincrement PK). Plain create.
  const created = await prisma.salary_arrears.create({
    data: {
      staff_uid: r.staff_uid,
      revision_id: revisionId,
      from_month: fromDate.month,
      from_year: fromDate.year,
      to_month: toDate.month,
      to_year: toDate.year,
      arrears_amount: Math.round(totalArrears * 100) / 100,
    },
    select: {
      id: true,
      staff_uid: true,
      revision_id: true,
      from_month: true,
      from_year: true,
      to_month: true,
      to_year: true,
      arrears_amount: true,
      status: true,
      calculated_at: true,
    },
  });

  return { arrears_amount: Math.round(totalArrears * 100) / 100, months: arrearMonths.length, result: created };
}
