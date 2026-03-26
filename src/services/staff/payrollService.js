// src/services/staff/payrollService.js
import db from '../../config/database.js';
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
  const salaryRes = await db.query(
    'SELECT * FROM staff_salary WHERE staff_uid = $1 AND is_active = true',
    [staffUid]
  );
  if (salaryRes.rows.length === 0) {
    throw new Error(`No salary configuration found for staff ${staffUid}`);
  }
  const sal = salaryRes.rows[0];

  // Total working days per month (standard 26 for Indian hospitals)
  const totalWorkingDays = 26;

  // Get attendance for this month (staff_attendance uses staff_uid UUID)
  const attRes = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IS NOT NULL) as days_present,
      SUM(COALESCE(overtime_hours, 0)) as total_overtime_hours
    FROM staff_attendance
    WHERE staff_uid = $1
      AND EXTRACT(MONTH FROM date) = $2
      AND EXTRACT(YEAR FROM date) = $3
  `, [staffUid, month, year]);

  const daysPresent = parseInt(attRes.rows[0]?.days_present || 0);
  const overtimeHours = parseFloat(attRes.rows[0]?.total_overtime_hours || 0);

  // Get approved leaves this month (leave_applications uses staff_uid UUID)
  const leaveRes = await db.query(`
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

  const leaveDays = parseInt(leaveRes.rows[0]?.leave_days || 0);

  // Get approved overtime for this month
  // overtime_requests.staff_id is INTEGER - need users.id
  const userRes = await db.query('SELECT id FROM users WHERE uid = $1', [staffUid]);
  const userId = userRes.rows[0]?.id;

  let approvedOT = overtimeHours;
  if (userId) {
    const otRes = await db.query(`
      SELECT COALESCE(SUM(extra_hours), 0) as approved_overtime
      FROM overtime_requests
      WHERE staff_id = $1
        AND status = 'approved'
        AND EXTRACT(MONTH FROM date::date) = $2
        AND EXTRACT(YEAR FROM date::date) = $3
    `, [userId, month, year]).catch(() => ({ rows: [{ approved_overtime: 0 }] }));
    approvedOT = parseFloat(otRes.rows[0]?.approved_overtime || overtimeHours);
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

  const grossSalary = basicEarned + hraEarned + daEarned + specialEarned +
    transportEarned + medicalEarned + overtimePay;

  // ─── Calculate deductions ────────────────────────────────────────────────
  const pfEmployee = Math.round(basicEarned * (sal.pf_employee_pct / 100) * 100) / 100;
  const esiEmployee = calcESI(grossSalary, sal.esi_applicable);
  const professionalTax = calcProfessionalTax(grossSalary);
  const tds = parseFloat(sal.tds_monthly || 0);
  const totalDeductions = pfEmployee + esiEmployee + professionalTax + tds;
  const netSalary = Math.round((grossSalary - totalDeductions) * 100) / 100;

  return {
    staff_uid: staffUid,
    month, year,
    total_working_days: totalWorkingDays,
    days_present: daysPresent,
    days_absent: Math.max(0, totalWorkingDays - daysPresent - leaveDays),
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
    gross_salary: Math.round(grossSalary * 100) / 100,
    pf_employee: pfEmployee,
    esi_employee: esiEmployee,
    professional_tax: professionalTax,
    tds,
    total_deductions: Math.round(totalDeductions * 100) / 100,
    net_salary: netSalary,
    salary_config: sal,
    attendance_factor: Math.round(attendanceFactor * 100) / 100,
  };
}

/**
 * Save payslip to DB (upsert).
 */
export async function savePayslip(payrollRunId, data) {
  const result = await db.query(`
    INSERT INTO payslips (
      payroll_run_id, staff_uid, month, year,
      total_working_days, days_present, days_absent, days_leave,
      overtime_hours, overtime_rate,
      basic_earned, hra_earned, da_earned, special_allowance_earned,
      transport_allowance_earned, medical_allowance_earned, overtime_pay,
      gross_salary, pf_employee, esi_employee, professional_tax, tds,
      total_deductions, net_salary, status
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'draft'
    )
    ON CONFLICT (staff_uid, month, year) DO UPDATE SET
      total_working_days=$5, days_present=$6, days_absent=$7, days_leave=$8,
      overtime_hours=$9, overtime_rate=$10,
      basic_earned=$11, hra_earned=$12, da_earned=$13, special_allowance_earned=$14,
      transport_allowance_earned=$15, medical_allowance_earned=$16, overtime_pay=$17,
      gross_salary=$18, pf_employee=$19, esi_employee=$20, professional_tax=$21,
      tds=$22, total_deductions=$23, net_salary=$24,
      updated_at=NOW()
    RETURNING *
  `, [
    payrollRunId, data.staff_uid, data.month, data.year,
    data.total_working_days, data.days_present, data.days_absent, data.days_leave,
    data.overtime_hours, data.overtime_rate,
    data.basic_earned, data.hra_earned, data.da_earned, data.special_allowance_earned,
    data.transport_allowance_earned, data.medical_allowance_earned, data.overtime_pay,
    data.gross_salary, data.pf_employee, data.esi_employee, data.professional_tax,
    data.tds, data.total_deductions, data.net_salary,
  ]);
  return result.rows[0];
}
