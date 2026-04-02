// src/services/staff/payrollService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

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
    'SELECT id, staff_uid, basic_salary, hra, special_allowance, total_ctc, is_active, effective_from FROM staff_salary WHERE staff_uid = $1 AND is_active = true',
    [staffUid]
  );
  if (salaryRes.rows.length === 0) {
    throw new Error(`No salary configuration found for staff ${staffUid}`);
  }
  const sal = salaryRes[0];

  // Total working days per month (standard 26 for Indian hospitals)
  const totalWorkingDays = 26;

  // Get attendance for this month (staff_attendance uses staff_uid UUID)
  const attRes = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*) FILTER (WHERE status IS NOT NULL) as days_present,
      SUM(COALESCE(overtime_hours, 0)) as total_overtime_hours
    FROM staff_attendance
    WHERE staff_uid = $1
      AND EXTRACT(MONTH FROM date) = $2
      AND EXTRACT(YEAR FROM date) = $3
  `, [staffUid, month, year]);

  const daysPresent = parseInt(attRes[0]?.days_present || 0);
  const overtimeHours = parseFloat(attRes[0]?.total_overtime_hours || 0);

  // Get approved leaves this month (leave_applications uses staff_uid UUID)
  const leaveRes = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(SUM(
      LEAST(to_date::date, (make_date($3::int, $2::int, 1) + INTERVAL '1 month - 1 day')::date)::date
      - GREATEST(from_date::date, make_date($3::int, $2::int, 1))::date
      + 1
    ), 0) as leave_days
    FROM leave_applications
    WHERE staff_uid = $1
      AND status = 'approved'
      AND from_date::date <= (make_date($3::int, $2::int, 1) + INTERVAL '1 month - 1 day')::date
      AND to_date::date >= make_date($3::int, $2::int, 1)
  `, [staffUid, month, year]).catch(() => ({ rows: [{ leave_days: 0 }] }));

  const leaveDays = parseInt(leaveRes[0]?.leave_days || 0);

  // Get approved overtime for this month
  // overtime_requests.staff_id is INTEGER - need users.id
  const userRes = await prisma.$queryRawUnsafe('SELECT id FROM users WHERE uid = $1', [staffUid]);
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
    `, [userId, month, year]).catch(() => ({ rows: [{ approved_overtime: 0 }] }));
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
    WHERE staff_uid = $1 AND status = 'pending'
  `, [staffUid]).catch(() => ({ rows: [{ total: 0 }] }));
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
  const advanceRes = await prisma.$queryRawUnsafe(`
    SELECT id, staff_uid, amount, deduction_month, deduction_year, status, created_at FROM salary_advances
    WHERE staff_uid = $1
      AND status = 'approved'
      AND deduction_start_year <= $3
      AND (deduction_start_year < $3 OR deduction_start_month <= $2)
      AND total_deducted < amount
    ORDER BY created_at ASC
  `, [staffUid, month, year]).catch(() => ({ rows: [] }));

  let totalAdvanceDeduction = 0;
  const advancesToProcess = [];
  for (const adv of advanceRes.rows) {
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
    WHERE sr.staff_uid = $1
      AND sr.status = 'applied'
      AND EXTRACT(MONTH FROM sr.effective_from::date) = $2
      AND EXTRACT(YEAR FROM sr.effective_from::date) = $3
    LIMIT 1
  `, [staffUid, month, year]).catch(() => ({ rows: [] }));

  let revisionNote = null;
  if (revisionCheck.rows.length > 0) {
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

/**
 * Save payslip to DB (upsert).
 */
export async function savePayslip(payrollRunId, data) {
  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO payslips (
      payroll_run_id, staff_uid, month, year,
      total_working_days, days_present, days_absent, days_leave,
      overtime_hours, overtime_rate,
      basic_earned, hra_earned, da_earned, special_allowance_earned,
      transport_allowance_earned, medical_allowance_earned, overtime_pay,
      arrears_amount, gross_salary, pf_employee, esi_employee, professional_tax, tds,
      total_deductions, advance_deduction, lop_days, lop_deduction, net_salary,
      revision_note, status
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,'draft'
    )
    ON CONFLICT (staff_uid, month, year) DO UPDATE SET
      total_working_days=$5, days_present=$6, days_absent=$7, days_leave=$8,
      overtime_hours=$9, overtime_rate=$10,
      basic_earned=$11, hra_earned=$12, da_earned=$13, special_allowance_earned=$14,
      transport_allowance_earned=$15, medical_allowance_earned=$16, overtime_pay=$17,
      arrears_amount=$18, gross_salary=$19, pf_employee=$20, esi_employee=$21, professional_tax=$22,
      tds=$23, total_deductions=$24, advance_deduction=$25, lop_days=$26, lop_deduction=$27,
      net_salary=$28, revision_note=$29,
      updated_at=NOW()
    RETURNING id, payroll_run_id, staff_uid, month, year, total_working_days, days_present, days_absent, days_leave, overtime_hours, overtime_rate, basic_earned, hra_earned, da_earned, special_allowance_earned, transport_allowance_earned, medical_allowance_earned, overtime_pay, arrears_amount, gross_salary, pf_employee, esi_employee, professional_tax, tds, total_deductions, advance_deduction, lop_days, lop_deduction, net_salary, revision_note, status, created_at, updated_at
  `, [
    payrollRunId, data.staff_uid, data.month, data.year,
    data.total_working_days, data.days_present, data.days_absent, data.days_leave,
    data.overtime_hours, data.overtime_rate,
    data.basic_earned, data.hra_earned, data.da_earned, data.special_allowance_earned,
    data.transport_allowance_earned, data.medical_allowance_earned, data.overtime_pay,
    data.arrears_amount || 0, data.gross_salary, data.pf_employee, data.esi_employee,
    data.professional_tax, data.tds, data.total_deductions,
    data.advance_deduction || 0, data.lop_days || 0, data.lop_deduction || 0,
    data.net_salary, data.revision_note || null,
  ]);
  return result[0];
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
    SELECT id, staff_uid, month, year, payroll_run_id, basic_salary, hra, special_allowance, total_earnings, pf_employee, pf_employer, esi, professional_tax, tds, total_deductions, net_salary, status, created_at FROM payslips
    WHERE staff_uid = $1
      AND status IN ('issued','viewed','downloaded')
      AND (
        (year = $2 AND month >= 4) OR
        (year = $3 AND month <= 3)
      )
    ORDER BY year, month
  `, [staffUid, startYear, endYear]);

  if (payslips.rows.length === 0) {
    throw new Error('No payslips found for this financial year');
  }

  const totals = payslips.rows.reduce((acc, p) => {
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
    months_included: payslips.rows.length,
  };

  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO annual_tax_summaries (
      staff_uid, financial_year, total_basic, total_hra, total_da,
      total_special_allowance, total_transport_allowance, total_medical_allowance,
      total_overtime, total_bonus, total_arrears, total_gross,
      total_pf, total_esi, total_professional_tax, total_tds, total_advance_deductions,
      total_deductions, total_net, taxable_income, tax_payable,
      months_included, generated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW()
    )
    ON CONFLICT (staff_uid, financial_year) DO UPDATE SET
      total_basic=$3, total_hra=$4, total_da=$5,
      total_special_allowance=$6, total_transport_allowance=$7, total_medical_allowance=$8,
      total_overtime=$9, total_bonus=$10, total_arrears=$11, total_gross=$12,
      total_pf=$13, total_esi=$14, total_professional_tax=$15, total_tds=$16,
      total_advance_deductions=$17, total_deductions=$18, total_net=$19,
      taxable_income=$20, tax_payable=$21, months_included=$22,
      generated_at=NOW(), updated_at=NOW()
    RETURNING id, staff_uid, financial_year, total_basic, total_hra, total_da, total_special_allowance, total_transport_allowance, total_medical_allowance, total_overtime, total_bonus, total_arrears, total_gross, total_pf, total_esi, total_professional_tax, total_tds, total_advance_deductions, total_deductions, total_net, taxable_income, tax_payable, months_included, generated_at, created_at, updated_at
  `, [
    summary.staff_uid, summary.financial_year, summary.total_basic, summary.total_hra, summary.total_da,
    summary.total_special_allowance, summary.total_transport_allowance, summary.total_medical_allowance,
    summary.total_overtime, summary.total_bonus, summary.total_arrears, summary.total_gross,
    summary.total_pf, summary.total_esi, summary.total_professional_tax, summary.total_tds,
    summary.total_advance_deductions, summary.total_deductions, summary.total_net,
    summary.taxable_income, summary.tax_payable, summary.months_included,
  ]);

  return result[0];
}

/**
 * FEATURE 4: Calculate arrears when a salary revision is backdated.
 */
export async function calculateArrears(revisionId) {
  const revision = await prisma.$queryRawUnsafe(
    "SELECT id, staff_uid, revision_type, old_basic, new_basic, old_ctc, new_ctc, effective_from, status, created_at FROM salary_revisions WHERE id=$1 AND status='applied'",
    [revisionId]
  );
  if (revision.rows.length === 0) throw new Error('Revision not found or not applied');

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
  let d = new Date(effectiveDate);
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
      'SELECT id, staff_uid, month, year, payroll_run_id, basic_salary, hra, special_allowance, total_earnings, pf_employee, pf_employer, esi, professional_tax, tds, total_deductions, net_salary, status, created_at FROM payslips WHERE staff_uid=$1 AND month=$2 AND year=$3',
      [r.staff_uid, month, year]
    );
    if (payslip.rows.length > 0) {
      const p = payslip[0];
      const attendanceFactor = p.days_present / (p.total_working_days || 26);
      totalArrears += diffBasic * attendanceFactor;
    } else {
      totalArrears += diffBasic;
    }
  }

  const fromDate = arrearMonths[0];
  const toDate = arrearMonths[arrearMonths.length - 1];

  const insertResult = await prisma.$queryRawUnsafe(`
    INSERT INTO salary_arrears (staff_uid, revision_id, from_month, from_year, to_month, to_year, arrears_amount)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING
    RETURNING id, staff_uid, revision_id, from_month, from_year, to_month, to_year, arrears_amount, status, created_at
  `, [r.staff_uid, revisionId, fromDate.month, fromDate.year, toDate.month, toDate.year, Math.round(totalArrears * 100) / 100]);

  return { arrears_amount: Math.round(totalArrears * 100) / 100, months: arrearMonths.length, result: insertResult[0] };
}
