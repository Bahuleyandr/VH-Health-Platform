// src/controllers/staff/payrollController.js
import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { calculatePayslip, savePayslip, generateAnnualTaxSummary, calculateArrears } from '../../services/staff/payrollService.js';
import { dispatch } from '../../utils/notifications/notificationDispatcher.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

// Try to import PDF generator — graceful fallback
let generatePayslipPDF = null;
try {
  const m = await import('../../utils/payslipPDF.js');
  generatePayslipPDF = m.generatePayslipPDF;
} catch (e) {
  logger.warn('payslipPDF not loaded (PDF generation disabled):', e.message);
}

// ─── Staff: Get my payslips (last N months) ───────────────────────────────────
export const getMyPayslips = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const { months = 3 } = req.query;

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.month, p.year, p.gross_salary, p.net_salary,
             p.total_deductions, p.days_present, p.days_absent,
             p.status, p.issued_at, p.pdf_key,
             p.basic_earned, p.overtime_pay, p.pf_employee
      FROM payslips p
      WHERE p.staff_uid = $1 AND p.status IN ('issued','viewed','downloaded')
      ORDER BY p.year DESC, p.month DESC
      LIMIT $2
    `, staffUid, Math.min(parseInt(months), 24));

    success(res, payslips, 'Payslips fetched');
  } catch (err) {
    logger.error('Get My Payslips Error:', err);
    error(res, 'Failed to fetch payslips', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Staff: Get payslip detail + signed PDF URL ──────────────────────────────
export const getPayslipDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const staffUid = req.user?.uid;

    const payslip = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.staff_uid, p.month, p.year, p.payroll_run_id, p.basic_salary, p.hra,
        p.special_allowance, p.total_earnings, p.pf_employee, p.pf_employer, p.esi,
        p.professional_tax, p.tds, p.total_deductions, p.net_salary, p.status, p.pdf_url,
        p.created_at, p.updated_at
      FROM payslips p
      WHERE p.id = $1 AND p.staff_uid = $2 AND p.status IN ('issued','viewed','downloaded')
    `, id, staffUid);

    if (payslip.length === 0) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);

    const p = payslip[0];

    // Mark as viewed
    if (p.status === 'issued') {
      await prisma.$queryRawUnsafe('UPDATE payslips SET status=$1, viewed_at=NOW() WHERE id=$2', 'viewed', id);
    }

    // Generate signed URL if PDF exists
    let pdfUrl = null;
    if (p.pdf_key) {
      pdfUrl = await getSignedFileUrl(p.pdf_key, 3600).catch(() => null);
    }

    success(res, { ...p, pdf_url: pdfUrl }, 'Payslip detail fetched');
  } catch (err) {
    logger.error('Get Payslip Detail Error:', err);
    error(res, 'Failed to fetch payslip', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Run payroll for a month ──────────────────────────────────────────
export const runPayroll = async (req, res) => {
  try {
    const adminUid = req.user?.uid;
    const { month, year } = req.body;

    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);
    if (month < 1 || month > 12) return error(res, 'month must be 1-12', HTTP_STATUS.BAD_REQUEST);

    // Create or get payroll run
    const run = await prisma.$queryRawUnsafe(
      'SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE month=$1 AND year=$2', month, year);

    let runId;
    if (run.length === 0) {
      const newRun = await prisma.$queryRawUnsafe(
        `INSERT INTO payroll_runs (month, year, status, generated_by, generated_at)
         VALUES ($1,$2,'processing',$3,NOW()) RETURNING id, month, year, status, generated_by, total_gross, total_deductions, total_net, employee_count, created_at, updated_at`, month, year, adminUid);
      runId = newRun[0].id;
    } else if (run[0].status === 'locked') {
      return error(res, 'Payroll for this month is locked and cannot be rerun', HTTP_STATUS.FORBIDDEN);
    } else {
      runId = run[0].id;
      await prisma.$queryRawUnsafe(
        `UPDATE payroll_runs SET status='processing', generated_by=$1, generated_at=NOW() WHERE id=$2`, adminUid, runId);
    }

    // Get all staff with salary config
    const staffList = await prisma.$queryRawUnsafe(`
      SELECT ss.staff_uid, u.name, u.role, u.email,
             COALESCE(s.department, ss.department) as department
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      WHERE ss.is_active = true
    `);

    let processed = 0, failed = 0;
    let totalGross = 0, totalNet = 0, totalDeductions = 0;

    for (const staff of staffList) {
      try {
        const calc = await calculatePayslip(staff.staff_uid, month, year);
        const saved = await savePayslip(runId, calc);

        // ─── FEATURE 3: Process advance deductions after saving ──────────
        if (calc._advances_to_process?.length > 0) {
          for (const adv of calc._advances_to_process) {
            await prisma.$queryRawUnsafe(`
              UPDATE salary_advances SET
                total_deducted = total_deducted + $1,
                months_remaining = GREATEST(0, months_remaining - 1),
                status = CASE WHEN total_deducted + $1 >= amount THEN 'cleared' ELSE status END,
                fully_cleared_at = CASE WHEN total_deducted + $1 >= amount THEN NOW() ELSE NULL END,
                updated_at = NOW()
              WHERE id = $2
            `, adv.amount, adv.id);

            await prisma.$queryRawUnsafe(`
              INSERT INTO advance_deductions (advance_id, payslip_id, staff_uid, month, year, amount_deducted, balance_after)
              VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, adv.id, saved.id, calc.staff_uid, calc.month, calc.year, adv.amount, adv.balanceAfter);
          }
        }

        // ─── FEATURE 4: Mark arrears as paid after saving ────────────────
        if (calc.arrears_amount > 0) {
          await prisma.$queryRawUnsafe(`
            UPDATE salary_arrears SET status='paid', paid_in_month=$1, paid_in_year=$2, payslip_id=$3
            WHERE staff_uid=$4 AND status='pending'
          `, calc.month, calc.year, saved.id, calc.staff_uid);
        }

        // Generate and upload PDF
        if (generatePayslipPDF) {
          try {
            const pdfBuf = await generatePayslipPDF(calc, staff);
            const pdfKey = `payroll/${year}/${String(month).padStart(2, '0')}/payslip_${staff.staff_uid}_${year}_${String(month).padStart(2, '0')}.pdf`;
            await uploadFileToR2(pdfBuf, pdfKey, 'application/pdf');
            await prisma.$queryRawUnsafe(
              'UPDATE payslips SET pdf_key=$1, pdf_generated_at=NOW() WHERE id=$2', pdfKey, saved.id);
          } catch (pdfErr) {
            logger.warn(`PDF generation failed for staff ${staff.staff_uid}: ${pdfErr.message}`);
          }
        }

        totalGross += parseFloat(calc.gross_salary) || 0;
        totalNet += parseFloat(calc.net_salary) || 0;
        totalDeductions += parseFloat(calc.total_deductions) || 0;
        processed++;
      } catch (e) {
        logger.warn(`Payroll calc failed for staff ${staff.staff_uid}: ${e.message}`);
        failed++;
      }
    }

    // Update run summary
    await prisma.$queryRawUnsafe(`
      UPDATE payroll_runs SET
        status='completed', total_staff=$1, total_gross=$2, total_net=$3, total_deductions=$4
      WHERE id=$5
    `, processed, totalGross.toFixed(2), totalNet.toFixed(2), totalDeductions.toFixed(2), runId);

    success(res, {
      run_id: runId, processed, failed,
      total_gross: totalGross.toFixed(2),
      total_net: totalNet.toFixed(2),
    }, `Payroll run complete: ${processed} staff processed`);
  } catch (err) {
    logger.error('Run Payroll Error:', err);
    error(res, 'Failed to run payroll', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Issue payslips (make visible to staff) ───────────────────────────
export const issuePayslips = async (req, res) => {
  try {
    const { month, year } = req.body;
    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);

    // Require both HR and Admin signatures before issuing
    const run = await prisma.$queryRawUnsafe(
      `SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE month=$1 AND year=$2`, month, year);

    if (run.length === 0) {
      return error(res, 'No payroll run found for this month. Run payroll first.', HTTP_STATUS.BAD_REQUEST);
    }

    const r = run[0];
    if (!r.hr_approved_at) {
      return error(res, 'HR must sign the payroll run before payslips can be issued', HTTP_STATUS.FORBIDDEN);
    }
    if (!r.admin_approved_at) {
      return error(res, 'Admin must countersign the payroll run before payslips can be issued', HTTP_STATUS.FORBIDDEN);
    }

    // Regenerate PDFs for any manually-edited payslips
    const editedPayslips = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.staff_uid, p.month, p.year, p.payroll_run_id, p.basic_salary, p.hra,
        p.special_allowance, p.total_earnings, p.pf_employee, p.pf_employer, p.esi,
        p.professional_tax, p.tds, p.total_deductions, p.net_salary, p.status, p.pdf_url,
        p.created_at, p.updated_at,
        ss.id as salary_id, ss.basic_salary as ss_basic, ss.hra as ss_hra,
        ss.special_allowance as ss_special, ss.total_ctc, ss.is_active, ss.effective_from
       FROM payslips p
       JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
       WHERE p.month=$1 AND p.year=$2 AND p.manually_edited=true AND p.pdf_key IS NULL`, month, year);

    if (generatePayslipPDF && editedPayslips.length > 0) {
      for (const p of editedPayslips) {
        try {
          const staffRes = await prisma.$queryRawUnsafe('SELECT uid, name, email, phone, role, department, employee_id FROM users WHERE uid=$1', p.staff_uid);
          const pdfBuf = await generatePayslipPDF(p, staffRes[0] || {});
          const pdfKey = `payroll/${year}/${String(month).padStart(2,'0')}/payslip_${p.staff_uid}_${year}_${String(month).padStart(2,'0')}.pdf`;
          await uploadFileToR2(pdfBuf, pdfKey, 'application/pdf');
          await prisma.$queryRawUnsafe('UPDATE payslips SET pdf_key=$1, pdf_generated_at=NOW() WHERE id=$2', pdfKey, p.id);
        } catch (pdfErr) {
          logger.warn(`PDF regen failed for payslip ${p.id}: ${pdfErr.message}`);
        }
      }
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE payslips SET status='issued', issued_at=NOW()
      WHERE month=$1 AND year=$2 AND status='draft'
      RETURNING id
    `, month, year);

    // Lock the run
    await prisma.$queryRawUnsafe(`UPDATE payroll_runs SET status='locked' WHERE month=$1 AND year=$2`, month, year);

    // ─── FEATURE 8: Send notifications to staff ──────────────────────────
    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(month)-1];
    setImmediate(async () => {
      try {
        const issuedStaff = await prisma.$queryRawUnsafe(`
          SELECT p.staff_uid, u.name, p.net_salary
          FROM payslips p JOIN users u ON p.staff_uid = u.uid
          WHERE p.month=$1 AND p.year=$2 AND p.status='issued'
        `, month, year);

        for (const staff of issuedStaff) {
          try {
            await dispatch({
              userId: staff.staff_uid,
              title: `Payslip Ready — ${monthName} ${year}`,
              body: `Your payslip for ${monthName} ${year} is available. Net Pay: ₹${Math.round(staff.net_salary).toLocaleString('en-IN')}`,
              channels: ['push', 'inapp'],
              data: { type: 'payslip', month: String(month), year: String(year) },
              type: 'payslip',
            });
          } catch (e) {
            logger.warn(`Payslip notification failed for ${staff.staff_uid}: ${e.message}`);
          }
        }
      } catch (e) {
        logger.warn('Payslip notification batch failed:', e.message);
      }
    });

    success(res, { issued: result.length }, `${result.length} payslips issued to staff`);
  } catch (err) {
    logger.error('Issue Payslips Error:', err);
    error(res, 'Failed to issue payslips', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get payroll runs list ─────────────────────────────────────────────
export const getPayrollRuns = async (req, res) => {
  try {
    const runs = await prisma.$queryRawUnsafe(`
      SELECT pr.*, u.name as generated_by_name
      FROM payroll_runs pr
      LEFT JOIN users u ON pr.generated_by = u.uid
      ORDER BY pr.year DESC, pr.month DESC
      LIMIT 24
    `);
    success(res, runs, 'Payroll runs fetched');
  } catch (err) {
    logger.error('Get Payroll Runs Error:', err);
    error(res, 'Failed to fetch payroll runs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get all payslips for a run ───────────────────────────────────────
export const getPayrollRunDetail = async (req, res) => {
  try {
    const { runId } = req.params;

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT p.*, u.name as staff_name, u.email,
             COALESCE(s.department, ss.department) as department,
             u.role
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
      WHERE p.payroll_run_id = $1
      ORDER BY u.name
    `, runId);

    const run = await prisma.$queryRawUnsafe('SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE id=$1', runId);
    if (run.length === 0) return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);

    success(res, { run: run[0], payslips: payslips }, 'Payroll run detail fetched');
  } catch (err) {
    logger.error('Get Payroll Run Detail Error:', err);
    error(res, 'Failed to fetch run detail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get staff list for salary config search ──────────────────────────
export const getStaffForPayroll = async (req, res) => {
  try {
    const { search, department } = req.query;
    const conditions = ['u.role NOT IN (\'PATIENT\', \'ADMIN\')'];
    const params = [];
    let idx = 1;

    if (search) {
      conditions.push(`(u.name ILIKE $${idx} OR u.phone ILIKE $${idx} OR ss.employee_id ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (department) {
      conditions.push(`(s.department ILIKE $${idx} OR ss.department ILIKE $${idx})`);
      params.push(`%${department}%`);
      idx++;
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const staffList = await prisma.$queryRawUnsafe(
      `
      SELECT u.uid, u.name, u.role, u.phone,
             COALESCE(s.department, ss.department) as department,
             COALESCE(s.employee_id, ss.employee_id) as employee_id,
             CASE WHEN ss.id IS NOT NULL THEN true ELSE false END as has_salary_config,
             ss.basic_salary, ss.designation
      FROM users u
      LEFT JOIN staff s ON s.user_id = u.id
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
      ${where}
      ORDER BY u.name
      LIMIT 50
    `,
      ...params,
    );

    success(res, staffList, 'Staff fetched');
  } catch (err) {
    logger.error('Get Staff For Payroll Error:', err);
    error(res, 'Failed to fetch staff', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get staff salary config ──────────────────────────────────────────
export const getStaffSalaryConfig = async (req, res) => {
  try {
    const { staffUid } = req.params;

    const config = await prisma.$queryRawUnsafe(`
      SELECT ss.*, u.name, u.role, u.phone,
             COALESCE(s.department, ss.department) as dept
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      WHERE ss.staff_uid = $1
    `, staffUid);

    if (config.length === 0) {
      const user = await prisma.$queryRawUnsafe(
        'SELECT uid, name, role, phone FROM users WHERE uid = $1', staffUid);
      return success(res, user[0] ? { ...user[0], no_config: true } : null, 'No salary config found');
    }

    const row = config[0];
    if (row.bank_account) {
      row.bank_account = '****' + String(row.bank_account).slice(-4);
    }
    if (row.pan_number) {
      row.pan_number = row.pan_number.substring(0, 2) + '***' + row.pan_number.slice(-3);
    }

    success(res, row, 'Salary config fetched');
  } catch (err) {
    logger.error('Get Salary Config Error:', err);
    error(res, 'Failed to fetch salary config', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Create/update staff salary config ─────────────────────────────────
export const upsertStaffSalaryConfig = async (req, res) => {
  try {
    const { staffUid } = req.params;
    const {
      basic_salary, hra_pct, da_pct, special_allowance, transport_allowance, medical_allowance,
      pf_employee_pct, esi_applicable, professional_tax, tds_monthly,
      designation, department, employee_id, date_of_joining, pan_number, pf_uan,
      bank_account, bank_name, bank_ifsc,
    } = req.body;

    if (!basic_salary || parseFloat(basic_salary) <= 0) {
      return error(res, 'basic_salary is required and must be positive', HTTP_STATUS.BAD_REQUEST);
    }

    const userCheck = await prisma.$queryRawUnsafe('SELECT uid, name FROM users WHERE uid = $1', staffUid);
    if (userCheck.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO staff_salary (
        staff_uid, basic_salary, hra_pct, da_pct, special_allowance, transport_allowance, medical_allowance,
        pf_employee_pct, esi_applicable, professional_tax, tds_monthly,
        designation, department, employee_id, date_of_joining, pan_number, pf_uan,
        bank_account, bank_name, bank_ifsc, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
      ON CONFLICT (staff_uid) DO UPDATE SET
        basic_salary=$2, hra_pct=$3, da_pct=$4, special_allowance=$5, transport_allowance=$6, medical_allowance=$7,
        pf_employee_pct=$8, esi_applicable=$9, professional_tax=$10, tds_monthly=$11,
        designation=$12, department=$13, employee_id=$14, date_of_joining=$15,
        pan_number=COALESCE(NULLIF($16,''), staff_salary.pan_number),
        pf_uan=$17,
        bank_account=COALESCE(NULLIF($18,''), staff_salary.bank_account),
        bank_name=$19, bank_ifsc=$20, updated_at=NOW()
      RETURNING id, staff_uid, basic_salary, hra_pct, da_pct, special_allowance, transport_allowance, medical_allowance, pf_employee_pct, esi_applicable, professional_tax, tds_monthly, designation, department, employee_id, date_of_joining, pan_number, pf_uan, bank_account, bank_name, bank_ifsc, created_at, updated_at
    `, staffUid, basic_salary, hra_pct ?? 40, da_pct ?? 10, special_allowance ?? 0, transport_allowance ?? 0, medical_allowance ?? 0, pf_employee_pct ?? 12, esi_applicable ?? false, professional_tax ?? 200, tds_monthly ?? 0, designation ?? null, department ?? null, employee_id ?? null, date_of_joining ?? null, pan_number ?? null, pf_uan ?? null, bank_account ?? null, bank_name ?? null, bank_ifsc ?? null);

    const row = result[0];
    if (row.bank_account) row.bank_account = '****' + String(row.bank_account).slice(-4);
    if (row.pan_number) row.pan_number = row.pan_number.substring(0, 2) + '***' + row.pan_number.slice(-3);

    success(res, row, 'Salary config saved');
  } catch (err) {
    logger.error('Upsert Salary Config Error:', err);
    error(res, 'Failed to save salary config', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Manually edit a payslip component before issuing ─────────────────
export const manualEditPayslip = async (req, res) => {
  try {
    const { id } = req.params;
    const editorUid = req.user?.uid;
    const { edit_reason, ...edits } = req.body;

    if (!edit_reason) return error(res, 'edit_reason is required for manual edits', HTTP_STATUS.BAD_REQUEST);

    const payslip = await prisma.$queryRawUnsafe(`
      SELECT p.*, pr.hr_approved_at, pr.admin_approved_at
      FROM payslips p
      JOIN payroll_runs pr ON p.payroll_run_id = pr.id
      WHERE p.id = $1
    `, id);

    if (payslip.length === 0) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);
    if (payslip[0].hr_approved_at || payslip[0].admin_approved_at) {
      return error(res, 'Cannot edit a payslip after HR or Admin has signed the payroll run', HTTP_STATUS.FORBIDDEN);
    }
    if (payslip[0].status === 'issued') {
      return error(res, 'Cannot edit an already-issued payslip', HTTP_STATUS.FORBIDDEN);
    }

    const allowed = [
      'basic_earned', 'hra_earned', 'da_earned', 'special_allowance_earned',
      'transport_allowance_earned', 'medical_allowance_earned', 'overtime_pay',
      'bonus_this_month', 'pf_employee', 'esi_employee', 'professional_tax',
      'tds', 'other_deductions', 'days_present', 'days_absent', 'days_leave',
      'overtime_hours',
    ];

    const fields = Object.keys(edits).filter(k => allowed.includes(k));
    if (fields.length === 0) return error(res, 'No valid editable fields provided', HTTP_STATUS.BAD_REQUEST);

    // Validate all payroll values are finite numbers (prevents NaN/Infinity injection)
    const values = fields.map(f => {
      const v = Number(edits[f]);
      if (!Number.isFinite(v)) throw new Error(`Invalid numeric value for field: ${f}`);
      return v;
    });
    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');

    await prisma.$queryRawUnsafe(`UPDATE payslips SET ${setClauses} WHERE id = $1`, id, ...values);

    await prisma.$queryRawUnsafe(`
      UPDATE payslips SET
        gross_salary = basic_earned + hra_earned + da_earned + special_allowance_earned
                     + transport_allowance_earned + medical_allowance_earned
                     + overtime_pay + COALESCE(bonus_this_month, 0) + COALESCE(arrears_amount, 0),
        total_deductions = pf_employee + esi_employee + professional_tax + tds
                         + COALESCE(other_deductions, 0),
        net_salary = (basic_earned + hra_earned + da_earned + special_allowance_earned
                    + transport_allowance_earned + medical_allowance_earned
                    + overtime_pay + COALESCE(bonus_this_month, 0) + COALESCE(arrears_amount, 0))
                   - (pf_employee + esi_employee + professional_tax + tds + COALESCE(other_deductions, 0)
                      + COALESCE(advance_deduction, 0)),
        manually_edited = true,
        edit_reason = $1,
        edited_by = $2,
        edited_at = NOW(),
        updated_at = NOW(),
        pdf_key = NULL,
        pdf_generated_at = NULL
      WHERE id = $3
    `, edit_reason, editorUid, id);

    const updated = await prisma.$queryRawUnsafe('SELECT id, staff_uid, month, year, payroll_run_id, basic_salary, hra, special_allowance, total_earnings, pf_employee, pf_employer, esi, professional_tax, tds, total_deductions, net_salary, status, pdf_url, created_at, updated_at FROM payslips WHERE id = $1', id);
    success(res, updated[0], 'Payslip updated — PDF will regenerate on issue');
  } catch (err) {
    logger.error('Manual Edit Payslip Error:', err);
    error(res, 'Failed to edit payslip', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── HR: Sign payroll run (first approval) ────────────────────────────────────
export const hrSignPayrollRun = async (req, res) => {
  try {
    const { runId } = req.params;
    const hrUid = req.user?.uid;
    const { comment } = req.body;

    const run = await prisma.$queryRawUnsafe('SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE id = $1', runId);
    if (run.length === 0) return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);
    if (run[0].status !== 'completed') {
      return error(res, 'Payroll run must be in completed state before signing', HTTP_STATUS.BAD_REQUEST);
    }
    if (run[0].hr_approved_at) {
      return error(res, 'HR has already signed this payroll run', HTTP_STATUS.BAD_REQUEST);
    }

    await prisma.$queryRawUnsafe(`
      UPDATE payroll_runs SET
        hr_approved_by = $1, hr_approved_at = NOW(), hr_comment = $2
      WHERE id = $3
    `, hrUid, comment || null, runId);

    const updated = await prisma.$queryRawUnsafe('SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE id = $1', runId);
    success(res, updated[0], 'HR signature applied — awaiting Admin countersign before payslips can be issued');
  } catch (err) {
    logger.error('HR Sign Payroll Run Error:', err);
    error(res, 'Failed to sign payroll run', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Countersign payroll run (second/final approval) ───────────────────
export const adminSignPayrollRun = async (req, res) => {
  try {
    const { runId } = req.params;
    const adminUid = req.user?.uid;
    const { comment } = req.body;

    const run = await prisma.$queryRawUnsafe('SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE id = $1', runId);
    if (run.length === 0) return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);
    if (!run[0].hr_approved_at) {
      return error(res, 'HR must sign before Admin countersign', HTTP_STATUS.BAD_REQUEST);
    }
    if (run[0].admin_approved_at) {
      return error(res, 'Admin has already countersigned this payroll run', HTTP_STATUS.BAD_REQUEST);
    }
    if (run[0].hr_approved_by === adminUid) {
      return error(res, 'HR signer and Admin countersigner cannot be the same person', HTTP_STATUS.FORBIDDEN);
    }

    const hash = crypto
      .createHash('sha256')
      .update(`${runId}:${run[0].month}:${run[0].year}:${run[0].total_gross}:${run[0].hr_approved_by}:${adminUid}`)
      .digest('hex');

    await prisma.$queryRawUnsafe(`
      UPDATE payroll_runs SET
        admin_approved_by = $1, admin_approved_at = NOW(), admin_comment = $2,
        approval_hash = $3, status = 'approved'
      WHERE id = $4
    `, adminUid, comment || null, hash, runId);

    const updated = await prisma.$queryRawUnsafe('SELECT id, month, year, status, generated_by, generated_at, approved_by, approved_at, total_gross, total_deductions, total_net, employee_count, notes, created_at, updated_at FROM payroll_runs WHERE id = $1', runId);
    success(res, updated[0], 'Admin countersign complete — payslips can now be issued to staff');
  } catch (err) {
    logger.error('Admin Sign Payroll Run Error:', err);
    error(res, 'Failed to countersign payroll run', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── FEATURE 1: Annual Tax Summary ───────────────────────────────────────────

// Staff: Get my annual tax summary
export const getMyTaxSummary = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const { fy } = req.query;
    const now = new Date();
    const financialYear = fy || (now.getMonth() >= 3
      ? `${now.getFullYear()}-${String(now.getFullYear() + 1).slice(-2)}`
      : `${now.getFullYear() - 1}-${String(now.getFullYear()).slice(-2)}`);

    const summary = await prisma.$queryRawUnsafe(
      'SELECT id, staff_uid, financial_year, total_income, total_tds, total_pf, total_esi, created_at FROM annual_tax_summaries WHERE staff_uid=$1 AND financial_year=$2', staffUid, financialYear);

    if (summary.length === 0) {
      const generated = await generateAnnualTaxSummary(staffUid, financialYear);
      return success(res, generated, 'Annual tax summary generated');
    }

    let pdfUrl = null;
    if (summary[0].pdf_key) {
      pdfUrl = await getSignedFileUrl(summary[0].pdf_key, 3600).catch(() => null);
    }
    success(res, { ...summary[0], pdf_url: pdfUrl }, 'Annual tax summary fetched');
  } catch (err) {
    logger.error('Get Tax Summary Error:', err);
    error(res, 'Failed to fetch tax summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Generate/regenerate annual tax summary for all staff
export const generateAllTaxSummaries = async (req, res) => {
  try {
    const { financial_year } = req.body;
    if (!financial_year) return error(res, 'financial_year required (e.g. 2025-26)', HTTP_STATUS.BAD_REQUEST);

    const staffList = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT staff_uid FROM payslips WHERE status IN ('issued','viewed','downloaded')`
    );
    let generated = 0, failed = 0;

    for (const s of staffList) {
      try {
        await generateAnnualTaxSummary(s.staff_uid, financial_year);
        generated++;
      } catch (e) {
        logger.warn(`Tax summary failed for ${s.staff_uid}: ${e.message}`);
        failed++;
      }
    }

    success(res, { generated, failed }, `Tax summaries generated: ${generated} staff`);
  } catch (err) {
    logger.error('Generate All Tax Summaries Error:', err);
    error(res, 'Failed to generate tax summaries', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── FEATURE 3: Salary Advances ──────────────────────────────────────────────

// Admin: Create advance/loan for staff
export const createAdvance = async (req, res) => {
  try {
    const adminUid = req.user?.uid;
    const { staff_uid, amount, reason, monthly_deduction, deduction_start_month, deduction_start_year, notes } = req.body;

    if (!staff_uid || !amount || !monthly_deduction || !reason) {
      return error(res, 'staff_uid, amount, monthly_deduction, and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const months_remaining = Math.ceil(parseFloat(amount) / parseFloat(monthly_deduction));

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO salary_advances (staff_uid, amount, reason, approved_by, approved_at, status,
        monthly_deduction, months_remaining, deduction_start_month, deduction_start_year, notes)
      VALUES ($1,$2,$3,$4,NOW(),'approved',$5,$6,$7,$8,$9)
      RETURNING id, staff_uid, amount, reason, approved_by, approved_at, status, monthly_deduction, months_remaining, total_deducted, deduction_start_month, deduction_start_year, notes, created_at
    `, staff_uid, amount, reason, adminUid, monthly_deduction, months_remaining, deduction_start_month || new Date().getMonth() + 1, deduction_start_year || new Date().getFullYear(), notes || null);

    success(res, result[0], `Advance of ₹${amount} approved. ${months_remaining} monthly deductions of ₹${monthly_deduction}`);
  } catch (err) {
    logger.error('Create Advance Error:', err);
    error(res, 'Failed to create advance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Staff: Get my advances
export const getMyAdvances = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const advances = await prisma.$queryRawUnsafe(`
      SELECT sa.*, u.name as approved_by_name,
             (sa.amount - sa.total_deducted) as balance_remaining
      FROM salary_advances sa
      LEFT JOIN users u ON sa.approved_by = u.uid
      WHERE sa.staff_uid = $1 ORDER BY sa.created_at DESC
    `, staffUid);
    success(res, advances, 'Advances fetched');
  } catch (err) {
    logger.error('Get My Advances Error:', err);
    error(res, 'Failed to fetch advances', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Get all advances
export const getAllAdvances = async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) {
      where = 'WHERE sa.status = $1';
      params.push(status);
    }
    const advances = await prisma.$queryRawUnsafe(`
      SELECT sa.*, u.name as staff_name, u.department,
             (sa.amount - sa.total_deducted) as balance_remaining
      FROM salary_advances sa JOIN users u ON sa.staff_uid = u.uid
      ${where} ORDER BY sa.created_at DESC
    `, params);
    success(res, advances, 'Advances fetched');
  } catch (err) {
    logger.error('Get All Advances Error:', err);
    error(res, 'Failed to fetch advances', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── FEATURE 4: Arrears ──────────────────────────────────────────────────────

// Admin: Calculate arrears for a revision
export const calculateRevisionArrears = async (req, res) => {
  try {
    const { revisionId } = req.params;
    const result = await calculateArrears(parseInt(revisionId));
    success(res, result, result.message || `Arrears calculated: ₹${result.arrears_amount}`);
  } catch (err) {
    logger.error('Calculate Arrears Error:', err);
    error(res, 'Failed to calculate arrears', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── FEATURE 6: Payroll Summary Export ───────────────────────────────────────

export const exportPayrollSummary = async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT
        u.name as employee_name,
        ss.employee_id, ss.designation, u.department,
        ss.bank_account, ss.bank_ifsc,
        p.days_present, p.days_absent,
        COALESCE(p.lop_days, 0) as lop_days,
        p.overtime_hours,
        p.basic_earned, p.hra_earned, p.da_earned, p.special_allowance_earned,
        p.transport_allowance_earned, p.medical_allowance_earned,
        p.overtime_pay,
        COALESCE(p.bonus_this_month, 0) as bonus,
        COALESCE(p.arrears_amount, 0) as arrears,
        p.gross_salary, p.pf_employee, p.esi_employee, p.professional_tax, p.tds,
        COALESCE(p.advance_deduction, 0) as advance_deduction,
        p.total_deductions, p.net_salary, p.status
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      LEFT JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
      WHERE p.month = $1 AND p.year = $2
      ORDER BY u.name
    `, month, year);

    if (payslips.length === 0) return error(res, 'No payslips found', HTTP_STATUS.NOT_FOUND);

    const headers = [
      'Employee Name','Employee ID','Designation','Department','Bank Account','IFSC',
      'Days Present','Days Absent','LOP Days','OT Hours',
      'Basic','HRA','DA','Special Allowance','Transport','Medical',
      'OT Pay','Bonus','Arrears','Gross',
      'PF','ESI','Prof Tax','TDS','Advance Deduction','Total Deductions','Net Pay','Status',
    ];

    const csvRows = [headers.join(',')];
    for (const r of payslips) {
      const row = [
        `"${r.employee_name || ''}"`,
        `"${r.employee_id || ''}"`,
        `"${r.designation || ''}"`,
        `"${r.department || ''}"`,
        `"${r.bank_account ? '****' + String(r.bank_account).slice(-4) : ''}"`,
        `"${r.bank_ifsc || ''}"`,
        r.days_present, r.days_absent, r.lop_days || 0, r.overtime_hours || 0,
        r.basic_earned, r.hra_earned, r.da_earned, r.special_allowance_earned,
        r.transport_allowance_earned, r.medical_allowance_earned,
        r.overtime_pay, r.bonus, r.arrears, r.gross_salary,
        r.pf_employee, r.esi_employee, r.professional_tax, r.tds,
        r.advance_deduction, r.total_deductions, r.net_salary,
        `"${r.status}"`,
      ];
      csvRows.push(row.join(','));
    }

    const totals = payslips.reduce((acc, r) => {
      acc.gross += parseFloat(r.gross_salary || 0);
      acc.pf += parseFloat(r.pf_employee || 0);
      acc.tds += parseFloat(r.tds || 0);
      acc.net += parseFloat(r.net_salary || 0);
      return acc;
    }, { gross: 0, pf: 0, tds: 0, net: 0 });

    csvRows.push(`"TOTAL","","","","","","","","","","","","","","","","","","","${totals.gross.toFixed(2)}","${totals.pf.toFixed(2)}","","","${totals.tds.toFixed(2)}","","","${totals.net.toFixed(2)}",""`);

    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(month)-1];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${monthName}_${year}.csv"`);
    res.send(csvRows.join('\n'));
  } catch (err) {
    logger.error('Export Payroll Error:', err);
    error(res, 'Failed to export payroll', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── FEATURE 7: PF/ESI Registers ─────────────────────────────────────────────

// PF ECR (Electronic Challan cum Return) format
export const exportPFRegister = async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT u.name, ss.pf_uan, ss.employee_id, p.basic_earned, p.pf_employee
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
      WHERE p.month=$1 AND p.year=$2
        AND p.pf_employee > 0
        AND p.status IN ('issued','viewed','downloaded')
      ORDER BY u.name
    `, month, year);

    const headers = '#,UAN,Member Name,Gross Wages,EPF Wages,EPS Wages,EDLI Wages,EPF Contribution,EPS Contribution,EPF EPS Diff,NCP Days,Refund of Advances';
    const rows = [headers];

    payslips.forEach((r, i) => {
      const epfWages = Math.min(parseFloat(r.basic_earned), 15000);
      const epsWages = Math.min(parseFloat(r.basic_earned), 15000);
      const epfContrib = Math.round(epfWages * 0.12 * 100) / 100;
      const epsContrib = Math.round(epsWages * 0.0833 * 100) / 100;
      const epfEpsDiff = Math.round((epfContrib - epsContrib) * 100) / 100;

      rows.push([
        i + 1,
        r.pf_uan || '',
        `"${r.name}"`,
        parseFloat(r.basic_earned).toFixed(2),
        epfWages.toFixed(2),
        epsWages.toFixed(2),
        epfWages.toFixed(2),
        epfContrib.toFixed(2),
        epsContrib.toFixed(2),
        epfEpsDiff.toFixed(2),
        0, 0,
      ].join(','));
    });

    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(month)-1];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="PF_ECR_${monthName}_${year}.csv"`);
    res.send(rows.join('\n'));
  } catch (err) {
    logger.error('Export PF Register Error:', err);
    error(res, 'Failed to export PF register', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ESI register
export const exportESIRegister = async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT u.name, ss.employee_id, p.gross_salary, p.esi_employee,
             ROUND(p.gross_salary * 0.0325, 2) as esi_employer
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
      WHERE p.month=$1 AND p.year=$2
        AND p.esi_employee > 0
        AND p.status IN ('issued','viewed','downloaded')
      ORDER BY u.name
    `, month, year);

    const headers = 'Sr No,Employee Name,Employee Code,Gross Wages,Employee ESI (0.75%),Employer ESI (3.25%),Total ESI';
    const rows = [headers];

    payslips.forEach((r, i) => {
      const total = parseFloat(r.esi_employee) + parseFloat(r.esi_employer);
      rows.push(`${i+1},"${r.name}","${r.employee_id || ''}",${parseFloat(r.gross_salary).toFixed(2)},${parseFloat(r.esi_employee).toFixed(2)},${parseFloat(r.esi_employer).toFixed(2)},${total.toFixed(2)}`);
    });

    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(month)-1];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ESI_Register_${monthName}_${year}.csv"`);
    res.send(rows.join('\n'));
  } catch (err) {
    logger.error('Export ESI Register Error:', err);
    error(res, 'Failed to export ESI register', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get payroll comparison data for a staff member or all staff across multiple months.
 * Returns: { staff: [{ name, id, payslips: [{ month, year, basic, hra, da, ... }] }] }
 */
export const getPayrollComparison = async (req, res) => {
  try {
    const { staff_uid, from_month, from_year, to_month, to_year } = req.query;

    if (!from_month || !from_year || !to_month || !to_year) {
      return error(res, 'from_month, from_year, to_month, to_year required', HTTP_STATUS.BAD_REQUEST);
    }

    // Build month range
    const fromDate = new Date(parseInt(from_year), parseInt(from_month) - 1, 1);
    const toDate = new Date(parseInt(to_year), parseInt(to_month) - 1, 1);

    const months = [];
    for (let d = new Date(fromDate); d <= toDate; d.setMonth(d.getMonth() + 1)) {
      months.push({ month: d.getMonth() + 1, year: d.getFullYear() });
    }

    // Fetch payslips for the date range
    let query = `
      SELECT
        p.id, p.staff_uid, u.name, ss.employee_id, ss.designation, u.department,
        p.month, p.year,
        p.days_present, p.days_absent, p.lop_days, p.overtime_hours,
        p.basic_earned, p.hra_earned, p.da_earned,
        p.special_allowance_earned, p.transport_allowance_earned, p.medical_allowance_earned,
        p.overtime_pay, p.bonus_this_month, p.arrears_amount,
        p.gross_salary,
        p.pf_employee, p.esi_employee, p.professional_tax, p.tds,
        p.advance_deduction, p.total_deductions, p.net_salary,
        p.status, p.created_at
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      LEFT JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
      WHERE p.status IN ('issued', 'viewed', 'downloaded')
    `;

    const params = [];
    if (staff_uid) {
      query += ` AND p.staff_uid = $${params.length + 1}`;
      params.push(staff_uid);
    }

    // Filter by date range
    query += ` AND (
      (p.year > $${params.length + 1} OR (p.year = $${params.length + 1} AND p.month >= $${params.length + 2}))
      AND (p.year < $${params.length + 3} OR (p.year = $${params.length + 3} AND p.month <= $${params.length + 4}))
    )`;
    params.push(parseInt(from_year), parseInt(from_month), parseInt(to_year), parseInt(to_month));

    query += ` ORDER BY p.staff_uid, p.year, p.month`;

    const payslips = await prisma.$queryRawUnsafe(query, ...params);

    // Group by staff
    const staffMap = {};
    for (const p of payslips) {
      if (!staffMap[p.staff_uid]) {
        staffMap[p.staff_uid] = {
          staff_uid: p.staff_uid,
          name: p.name,
          employee_id: p.employee_id,
          designation: p.designation,
          department: p.department,
          payslips: [],
        };
      }

      staffMap[p.staff_uid].payslips.push({
        month: p.month,
        year: p.year,
        days_present: p.days_present,
        days_absent: p.days_absent,
        lop_days: p.lop_days,
        overtime_hours: p.overtime_hours,
        basic_earned: parseFloat(p.basic_earned),
        hra_earned: parseFloat(p.hra_earned),
        da_earned: parseFloat(p.da_earned),
        special_allowance: parseFloat(p.special_allowance_earned),
        transport_allowance: parseFloat(p.transport_allowance_earned),
        medical_allowance: parseFloat(p.medical_allowance_earned),
        overtime_pay: parseFloat(p.overtime_pay),
        bonus: parseFloat(p.bonus_this_month || 0),
        arrears: parseFloat(p.arrears_amount || 0),
        gross_salary: parseFloat(p.gross_salary),
        pf: parseFloat(p.pf_employee),
        esi: parseFloat(p.esi_employee),
        professional_tax: parseFloat(p.professional_tax),
        tds: parseFloat(p.tds),
        advance_deduction: parseFloat(p.advance_deduction || 0),
        total_deductions: parseFloat(p.total_deductions),
        net_salary: parseFloat(p.net_salary),
        status: p.status,
      });
    }

    const staffList = Object.values(staffMap);

    success(res, {
      month_range: months,
      staff: staffList,
      total_staff: staffList.length,
      total_payslips: payslips.length,
    }, 'Payroll comparison fetched');
  } catch (err) {
    logger.error('Get Payroll Comparison Error:', err);
    error(res, 'Failed to fetch payroll comparison', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── COMPLIANCE FEATURES ─────────────────────────────────────────────────────
// Feature 1: F&F Settlement

export const createFnF = async (req, res) => {
  try {
    const { staff_uid, separation_type, last_working_day, notice_shortfall_days, bonus_payable, other_deductions, other_deductions_reason, notes } = req.body;
    if (!staff_uid || !separation_type || !last_working_day) return error(res, 'staff_uid, separation_type, last_working_day required', HTTP_STATUS.BAD_REQUEST);
    const staffData = await prisma.$queryRawUnsafe(`SELECT u.*, ss.basic_salary, ss.notice_period_days, ss.date_of_joining FROM users u LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid WHERE u.uid = $1`, staff_uid);
    if (!staffData.length) return error(res, 'Staff not found', HTTP_STATUS.NOT_FOUND);
    const s = staffData[0];
    const lastDay = new Date(last_working_day);
    const joinDate = s.date_of_joining ? new Date(s.date_of_joining) : null;
    const yearsOfService = joinDate ? (lastDay - joinDate) / (365.25 * 24 * 60 * 60 * 1000) : 0;
    const gratuityEligible = yearsOfService >= 5;
    const gratuityAmount = gratuityEligible && s.basic_salary ? Math.round((15/26) * parseFloat(s.basic_salary) * Math.floor(yearsOfService) * 100) / 100 : 0;
    const lastMonth = lastDay.getMonth() + 1;
    const lastYear = lastDay.getFullYear();
    const daysInMonth = new Date(lastYear, lastMonth, 0).getDate();
    const daysWorked = lastDay.getDate();
    const lastMonthBasic = s.basic_salary ? Math.round((parseFloat(s.basic_salary) / daysInMonth) * daysWorked * 100) / 100 : 0;
    const lastMonthAllowances = Math.round(lastMonthBasic * 0.65 * 100) / 100;
    const dailyRate = s.basic_salary ? parseFloat(s.basic_salary) / 26 : 0;
    const shortfall = Math.max(0, notice_shortfall_days || 0);
    const noticeRecovery = Math.round(shortfall * dailyRate * 100) / 100;
    const grossPayable = lastMonthBasic + lastMonthAllowances + gratuityAmount + (parseFloat(bonus_payable) || 0);
    const totalDedns = noticeRecovery + (parseFloat(other_deductions) || 0);
    const netPayable = grossPayable - totalDedns;
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO full_final_settlements (staff_uid,separation_type,last_working_day,last_month_days_worked,last_month_basic,last_month_allowances,notice_period_days,notice_shortfall_days,notice_recovery_amount,years_of_service,gratuity_eligible,gratuity_amount,bonus_payable,other_deductions,other_deductions_reason,gross_payable,total_deductions,net_payable,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, staff_uid, separation_type, last_working_day, last_month_days_worked, last_month_basic, last_month_allowances, notice_period_days, notice_shortfall_days, notice_recovery_amount, years_of_service, gratuity_eligible, gratuity_amount, bonus_payable, other_deductions, other_deductions_reason, gross_payable, total_deductions, net_payable, status, notes, created_at`, staff_uid, separation_type, last_working_day, daysWorked, lastMonthBasic, lastMonthAllowances, s.notice_period_days||30, shortfall, noticeRecovery, Math.round(yearsOfService*100)/100, gratuityEligible, gratuityAmount, parseFloat(bonus_payable)||0, parseFloat(other_deductions)||0, other_deductions_reason||null, grossPayable, totalDedns, netPayable, notes||null, req.user?.uid);
    success(res, result[0], `F&F calculated. Net payable: ₹${netPayable}`);
  } catch (err) { logger.error('CreateFnF:', err); error(res, 'Failed to create settlement', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getFnFList = async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE f.status = $1`; }
    const result = await prisma.$queryRawUnsafe(
      `SELECT f.*, u.name as staff_name, u.department, ss.designation, ss.employee_id
       FROM full_final_settlements f
       JOIN users u ON f.staff_uid = u.uid
       LEFT JOIN staff_salary ss ON ss.staff_uid = f.staff_uid
       ${where} ORDER BY f.created_at DESC`, params);
    success(res, result, 'F&F list fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const approveFnF = async (req, res) => {
  try {
    const { id } = req.params;
    const role = req.user?.role; const uid = req.user?.uid;
    const fnf = await prisma.$queryRawUnsafe('SELECT id, staff_uid, settlement_date, last_working_day, total_dues, total_deductions, net_payable, status, approved_by, created_at, updated_at FROM full_final_settlements WHERE id=$1', id);
    if (!fnf.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    const f = fnf[0];
    let update;
    if (role === 'HR' && f.status === 'draft') {
      update = await prisma.$queryRawUnsafe('UPDATE full_final_settlements SET status=$1,hr_approved_by=$2,hr_approved_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING id, staff_uid, separation_type, last_working_day, gross_payable, total_deductions, net_payable, status, hr_approved_by, hr_approved_at, admin_approved_by, admin_approved_at, created_at, updated_at', 'hr_approved', uid, id);
    } else if (role === 'ADMIN' && f.status === 'hr_approved') {
      update = await prisma.$queryRawUnsafe('UPDATE full_final_settlements SET status=$1,admin_approved_by=$2,admin_approved_at=NOW(),updated_at=NOW() WHERE id=$3 RETURNING id, staff_uid, separation_type, last_working_day, gross_payable, total_deductions, net_payable, status, hr_approved_by, hr_approved_at, admin_approved_by, admin_approved_at, created_at, updated_at', 'admin_approved', uid, id);
    } else return error(res, 'Cannot approve: wrong role or status', HTTP_STATUS.BAD_REQUEST);
    success(res, update[0], 'F&F approved');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const markFnFPaid = async (req, res) => {
  try {
    const { id } = req.params; const { payment_date, payment_reference } = req.body;
    const result = await prisma.$queryRawUnsafe('UPDATE full_final_settlements SET status=$1,payment_date=$2,payment_reference=$3,updated_at=NOW() WHERE id=$4 AND status=$5 RETURNING id, staff_uid, separation_type, last_working_day, gross_payable, total_deductions, net_payable, status, payment_date, payment_reference, created_at, updated_at', 'paid', payment_date, payment_reference, id, 'admin_approved');
    if (!result.length) return error(res, 'Not found or not admin-approved', HTTP_STATUS.BAD_REQUEST);
    success(res, result[0], 'F&F marked as paid');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 2: Gratuity Status

export const getAllGratuityStatus = async (req, res) => {
  try {
    const staff = await prisma.$queryRawUnsafe(
      `SELECT u.uid, u.name, u.department, ss.basic_salary, ss.date_of_joining, ss.designation, ss.employee_id
       FROM users u LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
       WHERE u.is_active=true AND ss.date_of_joining IS NOT NULL ORDER BY ss.date_of_joining`);
    const now = new Date();
    const result = staff.map(s => {
      const joinDate = new Date(s.date_of_joining);
      const yos = (now - joinDate) / (365.25*24*60*60*1000);
      const eligible = yos >= 5;
      const fiveYearDate = new Date(joinDate); fiveYearDate.setFullYear(fiveYearDate.getFullYear()+5);
      return {
        staff_uid: s.uid, name: s.name, employee_id: s.employee_id, designation: s.designation,
        department: s.department, date_of_joining: s.date_of_joining,
        years_of_service: Math.round(yos*100)/100,
        gratuity_eligible: eligible,
        projected_gratuity: s.basic_salary ? Math.round((15/26)*parseFloat(s.basic_salary)*Math.floor(yos)*100)/100 : 0,
        days_to_five_years: eligible ? 0 : Math.max(0, Math.ceil((fiveYearDate-now)/(24*60*60*1000)))
      };
    });
    success(res, result, 'Gratuity status fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 3: Investment Declarations

export const upsertDeclaration = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const {
      financial_year, ppf=0, epf_voluntary=0, elss=0, lic_premium=0, nsc=0,
      home_loan_principal=0, tuition_fees=0, other_80c=0, health_insurance_self=0,
      health_insurance_parents=0, education_loan_interest=0, rent_paid_monthly=0,
      rent_receipt_provided=false, home_loan_interest=0, nps_contribution=0, notes
    } = req.body;
    if (!financial_year) return error(res, 'financial_year required', HTTP_STATUS.BAD_REQUEST);
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO investment_declarations
         (staff_uid,financial_year,ppf,epf_voluntary,elss,lic_premium,nsc,home_loan_principal,tuition_fees,other_80c,health_insurance_self,health_insurance_parents,education_loan_interest,rent_paid_monthly,rent_receipt_provided,home_loan_interest,nps_contribution,notes,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'submitted',NOW())
       ON CONFLICT (staff_uid,financial_year) DO UPDATE SET
         ppf=$3,epf_voluntary=$4,elss=$5,lic_premium=$6,nsc=$7,home_loan_principal=$8,
         tuition_fees=$9,other_80c=$10,health_insurance_self=$11,health_insurance_parents=$12,
         education_loan_interest=$13,rent_paid_monthly=$14,rent_receipt_provided=$15,
         home_loan_interest=$16,nps_contribution=$17,notes=$18,
         status=CASE WHEN investment_declarations.status='locked' THEN 'locked' ELSE 'submitted' END,
         submitted_at=CASE WHEN investment_declarations.status='locked' THEN investment_declarations.submitted_at ELSE NOW() END,
         updated_at=NOW()
       RETURNING id, staff_uid, financial_year, ppf, epf_voluntary, elss, lic_premium, nsc, home_loan_principal, tuition_fees, other_80c, health_insurance_self, health_insurance_parents, education_loan_interest, rent_paid_monthly, rent_receipt_provided, home_loan_interest, nps_contribution, notes, status, submitted_at, created_at, updated_at`, staffUid, financial_year, ppf, epf_voluntary, elss, lic_premium, nsc, home_loan_principal, tuition_fees, other_80c, health_insurance_self, health_insurance_parents, education_loan_interest, rent_paid_monthly, rent_receipt_provided, home_loan_interest, nps_contribution, notes||null);
    success(res, result[0], 'Declaration saved');
  } catch (err) { logger.error('UpsertDeclaration:', err); error(res, 'Failed to save declaration', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getMyDeclarations = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe('SELECT id, staff_uid, financial_year, section_80c, section_80d, hra_exemption, lta, other_deductions, status, created_at, updated_at FROM investment_declarations WHERE staff_uid=$1 ORDER BY financial_year DESC', req.user?.uid);
    success(res, result, 'Declarations fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getAllDeclarations = async (req, res) => {
  try {
    const { financial_year, status } = req.query;
    let where = 'WHERE 1=1'; const params = [];
    if (financial_year) { params.push(financial_year); where += ` AND d.financial_year=$${params.length}`; }
    if (status) { params.push(status); where += ` AND d.status=$${params.length}`; }
    const result = await prisma.$queryRawUnsafe(
      `SELECT d.*, u.name as staff_name, u.department, ss.designation, ss.employee_id
       FROM investment_declarations d
       JOIN users u ON d.staff_uid = u.uid
       LEFT JOIN staff_salary ss ON ss.staff_uid = d.staff_uid
       ${where} ORDER BY u.name`, params);
    success(res, result, 'Declarations fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const approveDeclaration = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe(
      `UPDATE investment_declarations SET status='approved',approved_by=$1,approved_at=NOW(),updated_at=NOW() WHERE id=$2 RETURNING id, staff_uid, financial_year, status, approved_by, approved_at, created_at, updated_at`, req.user?.uid, req.params.id);
    if (!result.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    success(res, result[0], 'Declaration approved');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 4: Leave Encashment

export const calculateLeaveEncashment = async (req, res) => {
  try {
    const { staff_uid, leave_days, encashment_type, financial_year } = req.body;
    if (!staff_uid || !leave_days || !encashment_type) return error(res, 'staff_uid, leave_days, encashment_type required', HTTP_STATUS.BAD_REQUEST);
    const staffData = await prisma.$queryRawUnsafe('SELECT ss.basic_salary FROM staff_salary ss WHERE ss.staff_uid=$1', staff_uid);
    if (!staffData.length || !staffData[0].basic_salary) return error(res, 'Salary config not found', HTTP_STATUS.BAD_REQUEST);
    const dailyRate = parseFloat(staffData[0].basic_salary) / 26;
    const amount = Math.round(dailyRate * parseInt(leave_days) * 100) / 100;
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO leave_encashments (staff_uid,encashment_type,leave_days,daily_rate,amount,financial_year,approved_by,approved_at,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),'approved') RETURNING id, staff_uid, encashment_type, leave_days, daily_rate, amount, financial_year, approved_by, approved_at, status, created_at`, staff_uid, encashment_type, leave_days, dailyRate, amount, financial_year||null, req.user?.uid);
    success(res, result[0], `${leave_days} days × ₹${dailyRate.toFixed(2)}/day = ₹${amount}`);
  } catch (err) { logger.error('LeaveEncashment:', err); error(res, 'Failed to process leave encashment', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getLeaveEncashments = async (req, res) => {
  try {
    const { staff_uid } = req.query;
    const params = [];
    let where = '';
    if (staff_uid) { params.push(staff_uid); where = `WHERE le.staff_uid=$1`; }
    const result = await prisma.$queryRawUnsafe(
      `SELECT le.*, u.name as staff_name, ss.employee_id
       FROM leave_encashments le
       JOIN users u ON le.staff_uid = u.uid
       LEFT JOIN staff_salary ss ON ss.staff_uid = le.staff_uid
       ${where} ORDER BY le.created_at DESC`, params);
    success(res, result, 'Leave encashments fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 6: Payslip Query System

export const raisePayslipQuery = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const { payslip_id, subject, description, category } = req.body;
    if (!payslip_id || !subject || !description) return error(res, 'payslip_id, subject, description required', HTTP_STATUS.BAD_REQUEST);
    const payslip = await prisma.$queryRawUnsafe('SELECT id, staff_uid, month, year, payroll_run_id, basic_salary, hra, special_allowance, total_earnings, pf_employee, pf_employer, esi, professional_tax, tds, total_deductions, net_salary, status, pdf_url, created_at, updated_at FROM payslips WHERE id=$1 AND staff_uid=$2', payslip_id, staffUid);
    if (!payslip.length) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO payslip_queries (payslip_id,staff_uid,subject,description,category) VALUES ($1,$2,$3,$4,$5) RETURNING id, payslip_id, staff_uid, subject, description, category, status, created_at`, payslip_id, staffUid, subject, description, category||'general');
    success(res, result[0], 'Query raised');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getMyPayslipQueries = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT pq.*, p.month, p.year, p.net_salary,
         (SELECT json_agg(r ORDER BY r.created_at) FROM payslip_query_replies r WHERE r.query_id=pq.id) as replies
       FROM payslip_queries pq
       JOIN payslips p ON pq.payslip_id=p.id
       WHERE pq.staff_uid=$1 ORDER BY pq.created_at DESC`, req.user?.uid);
    success(res, result, 'Queries fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getAllPayslipQueries = async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE pq.status=$1`; }
    const result = await prisma.$queryRawUnsafe(
      `SELECT pq.*, p.month, p.year, p.net_salary, u.name as staff_name, ss.employee_id,
         (SELECT json_agg(r ORDER BY r.created_at) FROM payslip_query_replies r WHERE r.query_id=pq.id) as replies
       FROM payslip_queries pq
       JOIN payslips p ON pq.payslip_id=p.id
       JOIN users u ON pq.staff_uid=u.uid
       LEFT JOIN staff_salary ss ON ss.staff_uid=pq.staff_uid
       ${where} ORDER BY pq.created_at DESC`, params);
    success(res, result, 'All queries fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const replyToPayslipQuery = async (req, res) => {
  try {
    const { id } = req.params; const { message, resolve } = req.body;
    if (!message) return error(res, 'message required', HTTP_STATUS.BAD_REQUEST);
    await prisma.$queryRawUnsafe('INSERT INTO payslip_query_replies (query_id,author_uid,author_role,message) VALUES ($1,$2,$3,$4)', id, req.user?.uid, req.user?.role, message);
    if (resolve) {
      await prisma.$queryRawUnsafe(`UPDATE payslip_queries SET status='resolved',resolved_by=$1,resolved_at=NOW(),resolution_note=$2,updated_at=NOW() WHERE id=$3`, req.user?.uid, message, id);
    } else {
      await prisma.$queryRawUnsafe(`UPDATE payslip_queries SET status='in_review',updated_at=NOW() WHERE id=$1 AND status='open'`, id);
    }
    const updated = await prisma.$queryRawUnsafe('SELECT id, payslip_id, staff_uid, query_type, description, status, resolution, resolved_by, created_at, resolved_at FROM payslip_queries WHERE id=$1', id);
    success(res, updated[0], resolve ? 'Query resolved' : 'Reply sent');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 7: Compliance Calendar

export const getComplianceCalendar = async (req, res) => {
  try {
    const now = new Date(); const year = now.getFullYear(); const month = now.getMonth()+1;
    const pfDueMonth = month===12?1:month+1; const pfDueYear = month===12?year+1:year;
    const pfDue = new Date(pfDueYear, pfDueMonth-1, 15);
    const tdsQuarterDue = [
      { months:[4,5,6], due: new Date(year,6,31), label:'Q1 TDS Return (Apr-Jun)' },
      { months:[7,8,9], due: new Date(year,9,31), label:'Q2 TDS Return (Jul-Sep)' },
      { months:[10,11,12], due: new Date(year+1,0,31), label:'Q3 TDS Return (Oct-Dec)' },
      { months:[1,2,3], due: new Date(year,4,31), label:'Q4 TDS Return (Jan-Mar)' },
    ];
    const activeTds = tdsQuarterDue.find(q=>q.months.includes(month));
    const ecrs = await prisma.$queryRawUnsafe(
      `SELECT month,year FROM payroll_runs WHERE status IN ('approved','locked') AND year=$1`, year).catch(() => []);
    const ecrGenerated = ecrs.map(r=>`${r.year}-${String(r.month).padStart(2,'0')}`);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const deadlines = [
      {
        label:`PF ECR — ${monthNames[month-1]} ${year}`,
        due_date:pfDue.toISOString().split('T')[0],
        due_in_days:Math.ceil((pfDue-now)/(24*60*60*1000)),
        status:ecrGenerated.includes(`${year}-${String(month).padStart(2,'0')}`)? 'ready':'pending',
        type:'pf'
      },
      {
        label:`ESI Register — ${monthNames[month-1]} ${year}`,
        due_date:pfDue.toISOString().split('T')[0],
        due_in_days:Math.ceil((pfDue-now)/(24*60*60*1000)),
        status:ecrGenerated.includes(`${year}-${String(month).padStart(2,'0')}`)? 'ready':'pending',
        type:'esi'
      },
    ];
    if (activeTds) deadlines.push({
      label:activeTds.label, due_date:activeTds.due.toISOString().split('T')[0],
      due_in_days:Math.ceil((activeTds.due-now)/(24*60*60*1000)),
      status:'manual', type:'tds', note:'File via TRACES portal'
    });
    const annualReturn = new Date(year,4,31);
    if (annualReturn>now) deadlines.push({
      label:`Annual TDS Return (Form 24Q) FY ${year-1}-${String(year).slice(-2)}`,
      due_date:annualReturn.toISOString().split('T')[0],
      due_in_days:Math.ceil((annualReturn-now)/(24*60*60*1000)),
      status:'manual', type:'annual_tds'
    });
    const form16 = new Date(year,5,15);
    if (form16>now) deadlines.push({
      label:`Form 16 Issue Deadline FY ${year-1}-${String(year).slice(-2)}`,
      due_date:form16.toISOString().split('T')[0],
      due_in_days:Math.ceil((form16-now)/(24*60*60*1000)),
      status:'manual', type:'form16'
    });
    deadlines.sort((a,b)=>new Date(a.due_date).getTime()-new Date(b.due_date).getTime());
    success(res, { deadlines, current_month:month, current_year:year }, 'Compliance calendar fetched');
  } catch (err) { logger.error('ComplianceCal:', err); error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 8: Bulk Salary Revision

export const createBulkRevision = async (req, res) => {
  try {
    const { description, revision_type, target_type, target_value, increment_type, increment_value, bonus_amount, effective_from } = req.body;
    if (!description||!revision_type||!target_type||!effective_from) return error(res,'description,revision_type,target_type,effective_from required',HTTP_STATUS.BAD_REQUEST);
    let countQuery=`SELECT COUNT(*) as cnt FROM users u JOIN staff_salary ss ON ss.staff_uid=u.uid WHERE u.is_active=true`;
    const params=[];
    if (target_type==='department') { countQuery+=` AND u.department=$1`; params.push(target_value); }
    else if (target_type==='role') { countQuery+=` AND u.role=$1`; params.push(target_value); }
    else if (target_type==='designation') { countQuery+=` AND ss.designation=$1`; params.push(target_value); }
    const countResult=await prisma.$queryRawUnsafe(countQuery,...params);
    const staffCount=parseInt(countResult[0].cnt);
    if (staffCount===0) return error(res,`No active staff found for ${target_type}=${target_value}`,HTTP_STATUS.BAD_REQUEST);
    const job=await prisma.$queryRawUnsafe(
      `INSERT INTO bulk_revision_jobs (description,revision_type,target_type,target_value,increment_type,increment_value,bonus_amount,effective_from,staff_count,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING id, description, revision_type, target_type, target_value, increment_type, increment_value, bonus_amount, effective_from, staff_count, status, created_by, created_at`, description, revision_type, target_type, target_value, increment_type, increment_value, bonus_amount, effective_from, staffCount, req.user?.uid);
    success(res,job[0],`Bulk revision draft created. Will affect ${staffCount} staff.`);
  } catch (err) { logger.error('CreateBulkRev:', err); error(res,'Failed to create bulk revision',HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const approveBulkRevision = async (req, res) => {
  try {
    const { id } = req.params; const adminUid=req.user?.uid;
    const job=await prisma.$queryRawUnsafe('SELECT id, status, total, processed, failed, started_at, completed_at, created_by, created_at FROM bulk_revision_jobs WHERE id=$1', id);
    if (!job.length) return error(res,'Not found',HTTP_STATUS.NOT_FOUND);
    const j=job[0];
    if (j.status!=='draft') return error(res,'Already processed',HTTP_STATUS.BAD_REQUEST);
    await prisma.$queryRawUnsafe(`UPDATE bulk_revision_jobs SET status='approved',approved_by=$1,approved_at=NOW() WHERE id=$2`, adminUid, id);
    setImmediate(async()=>{
      try {
        let staffQuery=`SELECT u.uid,ss.basic_salary FROM users u JOIN staff_salary ss ON ss.staff_uid=u.uid WHERE u.is_active=true`;
        const params=[];
        if (j.target_type==='department'){staffQuery+=` AND u.department=$1`;params.push(j.target_value);}
        else if (j.target_type==='role'){staffQuery+=` AND u.role=$1`;params.push(j.target_value);}
        else if (j.target_type==='designation'){staffQuery+=` AND ss.designation=$1`;params.push(j.target_value);}
        const staffList=await prisma.$queryRawUnsafe(staffQuery,...params);
        let processed=0;
        for (const s of staffList) {
          try {
            let proposed_basic=parseFloat(s.basic_salary);
            if (j.revision_type==='increment') {
              proposed_basic=j.increment_type==='percentage'
                ?proposed_basic*(1+parseFloat(j.increment_value)/100)
                :proposed_basic+parseFloat(j.increment_value);
            }
            await prisma.$queryRawUnsafe(
              `INSERT INTO salary_revisions (staff_uid,revision_number,revision_type,current_basic,proposed_basic,bonus_amount,effective_from,reason,status,hr_approved_by,hr_approved_at,admin_approved_by,admin_approved_at,applied_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'applied',$9,NOW(),$9,NOW(),NOW())`, s.uid, `BULK-${id}-${s.uid.toString().slice(0,6)}`, j.revision_type, s.basic_salary, j.revision_type==='increment'?Math.round(proposed_basic*100)/100:s.basic_salary, j.bonus_amount||0, j.effective_from, j.description, adminUid);
            if (j.revision_type==='increment') {
              await prisma.$queryRawUnsafe('UPDATE staff_salary SET basic_salary=$1,updated_at=NOW() WHERE staff_uid=$2', Math.round(proposed_basic*100)/100, s.uid);
            }
            processed++;
          } catch(e){ logger.warn(`Bulk rev failed ${s.uid}: ${e.message}`); }
        }
        await prisma.$queryRawUnsafe(`UPDATE bulk_revision_jobs SET status='completed',processed_count=$1,completed_at=NOW() WHERE id=$2`, processed, id);
      } catch(e){ await prisma.$queryRawUnsafe(`UPDATE bulk_revision_jobs SET status='failed',error_log=$1 WHERE id=$2`, e.message, id); }
    });
    success(res,{id,status:'processing',staff_count:j.staff_count},'Bulk revision approved and processing');
  } catch (err) { logger.error('ApproveBulkRev:', err); error(res,'Failed to approve bulk revision',HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getBulkRevisions = async (req, res) => {
  try {
    const result=await prisma.$queryRawUnsafe(
      `SELECT b.*,u.name as created_by_name FROM bulk_revision_jobs b LEFT JOIN users u ON b.created_by=u.uid ORDER BY b.created_at DESC`);
    success(res,result,'Bulk revisions fetched');
  } catch (_err) { error(res,'Failed',HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};
