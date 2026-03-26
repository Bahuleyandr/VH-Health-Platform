// src/controllers/staff/payrollController.js
import db from '../../config/database.js';
import crypto from 'crypto';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { calculatePayslip, savePayslip } from '../../services/staff/payrollService.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';

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

    const payslips = await db.query(`
      SELECT p.id, p.month, p.year, p.gross_salary, p.net_salary,
             p.total_deductions, p.days_present, p.days_absent,
             p.status, p.issued_at, p.pdf_key,
             p.basic_earned, p.overtime_pay, p.pf_employee
      FROM payslips p
      WHERE p.staff_uid = $1 AND p.status IN ('issued','viewed','downloaded')
      ORDER BY p.year DESC, p.month DESC
      LIMIT $2
    `, [staffUid, Math.min(parseInt(months), 24)]);

    success(res, payslips.rows, 'Payslips fetched');
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

    const payslip = await db.query(`
      SELECT p.* FROM payslips p
      WHERE p.id = $1 AND p.staff_uid = $2 AND p.status IN ('issued','viewed','downloaded')
    `, [id, staffUid]);

    if (payslip.rows.length === 0) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);

    const p = payslip.rows[0];

    // Mark as viewed
    if (p.status === 'issued') {
      await db.query('UPDATE payslips SET status=$1, viewed_at=NOW() WHERE id=$2', ['viewed', id]);
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
    let run = await db.query(
      'SELECT * FROM payroll_runs WHERE month=$1 AND year=$2',
      [month, year]
    );

    let runId;
    if (run.rows.length === 0) {
      const newRun = await db.query(
        `INSERT INTO payroll_runs (month, year, status, generated_by, generated_at)
         VALUES ($1,$2,'processing',$3,NOW()) RETURNING *`,
        [month, year, adminUid]
      );
      runId = newRun.rows[0].id;
    } else if (run.rows[0].status === 'locked') {
      return error(res, 'Payroll for this month is locked and cannot be rerun', HTTP_STATUS.FORBIDDEN);
    } else {
      runId = run.rows[0].id;
      await db.query(
        `UPDATE payroll_runs SET status='processing', generated_by=$1, generated_at=NOW() WHERE id=$2`,
        [adminUid, runId]
      );
    }

    // Get all staff with salary config
    const staffList = await db.query(`
      SELECT ss.staff_uid, u.name, u.role, u.email,
             COALESCE(s.department, ss.department) as department
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      WHERE ss.is_active = true
    `);

    let processed = 0, failed = 0;
    let totalGross = 0, totalNet = 0, totalDeductions = 0;

    for (const staff of staffList.rows) {
      try {
        const calc = await calculatePayslip(staff.staff_uid, month, year);
        const saved = await savePayslip(runId, calc);

        // Generate and upload PDF
        if (generatePayslipPDF) {
          try {
            const pdfBuf = await generatePayslipPDF(calc, staff);
            const pdfKey = `payroll/${year}/${String(month).padStart(2, '0')}/payslip_${staff.staff_uid}_${year}_${String(month).padStart(2, '0')}.pdf`;
            await uploadFileToR2(pdfBuf, pdfKey, 'application/pdf');
            await db.query(
              'UPDATE payslips SET pdf_key=$1, pdf_generated_at=NOW() WHERE id=$2',
              [pdfKey, saved.id]
            );
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
    await db.query(`
      UPDATE payroll_runs SET
        status='completed', total_staff=$1, total_gross=$2, total_net=$3, total_deductions=$4
      WHERE id=$5
    `, [processed, totalGross.toFixed(2), totalNet.toFixed(2), totalDeductions.toFixed(2), runId]);

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
    const run = await db.query(
      `SELECT * FROM payroll_runs WHERE month=$1 AND year=$2`,
      [month, year]
    );

    if (run.rows.length === 0) {
      return error(res, 'No payroll run found for this month. Run payroll first.', HTTP_STATUS.BAD_REQUEST);
    }

    const r = run.rows[0];
    if (!r.hr_approved_at) {
      return error(res, 'HR must sign the payroll run before payslips can be issued', HTTP_STATUS.FORBIDDEN);
    }
    if (!r.admin_approved_at) {
      return error(res, 'Admin must countersign the payroll run before payslips can be issued', HTTP_STATUS.FORBIDDEN);
    }

    // Regenerate PDFs for any manually-edited payslips
    const editedPayslips = await db.query(
      `SELECT p.*, ss.* FROM payslips p
       JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
       WHERE p.month=$1 AND p.year=$2 AND p.manually_edited=true AND p.pdf_key IS NULL`,
      [month, year]
    );

    if (generatePayslipPDF && editedPayslips.rows.length > 0) {
      for (const p of editedPayslips.rows) {
        try {
          const staffRes = await db.query('SELECT * FROM users WHERE uid=$1', [p.staff_uid]);
          const pdfBuf = await generatePayslipPDF(p, staffRes.rows[0] || {});
          const pdfKey = `payroll/${year}/${String(month).padStart(2,'0')}/payslip_${p.staff_uid}_${year}_${String(month).padStart(2,'0')}.pdf`;
          await uploadFileToR2(pdfBuf, pdfKey, 'application/pdf');
          await db.query('UPDATE payslips SET pdf_key=$1, pdf_generated_at=NOW() WHERE id=$2', [pdfKey, p.id]);
        } catch (pdfErr) {
          logger.warn(`PDF regen failed for payslip ${p.id}: ${pdfErr.message}`);
        }
      }
    }

    const result = await db.query(`
      UPDATE payslips SET status='issued', issued_at=NOW()
      WHERE month=$1 AND year=$2 AND status='draft'
      RETURNING id
    `, [month, year]);

    // Lock the run
    await db.query(`UPDATE payroll_runs SET status='locked' WHERE month=$1 AND year=$2`, [month, year]);

    success(res, { issued: result.rowCount }, `${result.rowCount} payslips issued to staff`);
  } catch (err) {
    logger.error('Issue Payslips Error:', err);
    error(res, 'Failed to issue payslips', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get payroll runs list ─────────────────────────────────────────────
export const getPayrollRuns = async (req, res) => {
  try {
    const runs = await db.query(`
      SELECT pr.*, u.name as generated_by_name
      FROM payroll_runs pr
      LEFT JOIN users u ON pr.generated_by = u.uid
      ORDER BY pr.year DESC, pr.month DESC
      LIMIT 24
    `);
    success(res, runs.rows, 'Payroll runs fetched');
  } catch (err) {
    logger.error('Get Payroll Runs Error:', err);
    error(res, 'Failed to fetch payroll runs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get all payslips for a run ───────────────────────────────────────
export const getPayrollRunDetail = async (req, res) => {
  try {
    const { runId } = req.params;

    const payslips = await db.query(`
      SELECT p.*, u.name as staff_name, u.email,
             COALESCE(s.department, ss.department) as department,
             u.role
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
      WHERE p.payroll_run_id = $1
      ORDER BY u.name
    `, [runId]);

    const run = await db.query('SELECT * FROM payroll_runs WHERE id=$1', [runId]);
    if (run.rows.length === 0) return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);

    success(res, { run: run.rows[0], payslips: payslips.rows }, 'Payroll run detail fetched');
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
    const staffList = await db.query(`
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
    `, params);

    success(res, staffList.rows, 'Staff fetched');
  } catch (err) {
    logger.error('Get Staff For Payroll Error:', err);
    error(res, 'Failed to fetch staff', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get staff salary config ──────────────────────────────────────────
export const getStaffSalaryConfig = async (req, res) => {
  try {
    const { staffUid } = req.params;

    const config = await db.query(`
      SELECT ss.*, u.name, u.role, u.phone,
             COALESCE(s.department, ss.department) as dept
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.id
      WHERE ss.staff_uid = $1
    `, [staffUid]);

    if (config.rows.length === 0) {
      // Return user info without salary config
      const user = await db.query(
        'SELECT uid, name, role, phone FROM users WHERE uid = $1',
        [staffUid]
      );
      return success(res, user.rows[0] ? { ...user.rows[0], no_config: true } : null, 'No salary config found');
    }

    const row = config.rows[0];
    // Mask sensitive data
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

    // Verify staff exists
    const userCheck = await db.query('SELECT uid, name FROM users WHERE uid = $1', [staffUid]);
    if (userCheck.rows.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    const result = await db.query(`
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
      RETURNING *
    `, [
      staffUid, basic_salary,
      hra_pct ?? 40, da_pct ?? 10,
      special_allowance ?? 0, transport_allowance ?? 0, medical_allowance ?? 0,
      pf_employee_pct ?? 12, esi_applicable ?? false, professional_tax ?? 200, tds_monthly ?? 0,
      designation ?? null, department ?? null, employee_id ?? null, date_of_joining ?? null,
      pan_number ?? null, pf_uan ?? null,
      bank_account ?? null, bank_name ?? null, bank_ifsc ?? null,
    ]);

    const row = result.rows[0];
    // Mask on return
    if (row.bank_account) row.bank_account = '****' + String(row.bank_account).slice(-4);
    if (row.pan_number) row.pan_number = row.pan_number.substring(0, 2) + '***' + row.pan_number.slice(-3);

    success(res, row, 'Salary config saved');
  } catch (err) {
    logger.error('Upsert Salary Config Error:', err);
    error(res, 'Failed to save salary config', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Manually edit a payslip component before issuing ─────────────────
// Allows corrections to individual payslip lines before dual sign-off
export const manualEditPayslip = async (req, res) => {
  try {
    const { id } = req.params;
    const editorUid = req.user?.uid;
    const { edit_reason, ...edits } = req.body;

    if (!edit_reason) return error(res, 'edit_reason is required for manual edits', HTTP_STATUS.BAD_REQUEST);

    // Only allow edits before the run is HR/Admin approved
    const payslip = await db.query(`
      SELECT p.*, pr.hr_approved_at, pr.admin_approved_at
      FROM payslips p
      JOIN payroll_runs pr ON p.payroll_run_id = pr.id
      WHERE p.id = $1
    `, [id]);

    if (payslip.rows.length === 0) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);
    if (payslip.rows[0].hr_approved_at || payslip.rows[0].admin_approved_at) {
      return error(res, 'Cannot edit a payslip after HR or Admin has signed the payroll run', HTTP_STATUS.FORBIDDEN);
    }
    if (payslip.rows[0].status === 'issued') {
      return error(res, 'Cannot edit an already-issued payslip', HTTP_STATUS.FORBIDDEN);
    }

    // Allowed editable fields
    const allowed = [
      'basic_earned', 'hra_earned', 'da_earned', 'special_allowance_earned',
      'transport_allowance_earned', 'medical_allowance_earned', 'overtime_pay',
      'bonus_this_month', 'pf_employee', 'esi_employee', 'professional_tax',
      'tds', 'other_deductions', 'days_present', 'days_absent', 'days_leave',
      'overtime_hours',
    ];

    const fields = Object.keys(edits).filter(k => allowed.includes(k));
    if (fields.length === 0) return error(res, 'No valid editable fields provided', HTTP_STATUS.BAD_REQUEST);

    // Recalculate gross and net from edits
    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => edits[f]);

    // Apply the field edits first
    await db.query(`UPDATE payslips SET ${setClauses} WHERE id = $1`, [id, ...values]);

    // Recalculate gross / total_deductions / net
    await db.query(`
      UPDATE payslips SET
        gross_salary = basic_earned + hra_earned + da_earned + special_allowance_earned
                     + transport_allowance_earned + medical_allowance_earned
                     + overtime_pay + COALESCE(bonus_this_month, 0),
        total_deductions = pf_employee + esi_employee + professional_tax + tds
                         + COALESCE(other_deductions, 0),
        net_salary = (basic_earned + hra_earned + da_earned + special_allowance_earned
                    + transport_allowance_earned + medical_allowance_earned
                    + overtime_pay + COALESCE(bonus_this_month, 0))
                   - (pf_employee + esi_employee + professional_tax + tds + COALESCE(other_deductions, 0)),
        manually_edited = true,
        edit_reason = $1,
        edited_by = $2,
        edited_at = NOW(),
        updated_at = NOW(),
        -- Invalidate old PDF — will regenerate on issue
        pdf_key = NULL,
        pdf_generated_at = NULL
      WHERE id = $3
    `, [edit_reason, editorUid, id]);

    const updated = await db.query('SELECT * FROM payslips WHERE id = $1', [id]);
    success(res, updated.rows[0], 'Payslip updated — PDF will regenerate on issue');
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

    const run = await db.query('SELECT * FROM payroll_runs WHERE id = $1', [runId]);
    if (run.rows.length === 0) return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);
    if (run.rows[0].status !== 'completed') {
      return error(res, 'Payroll run must be in completed state before signing', HTTP_STATUS.BAD_REQUEST);
    }
    if (run.rows[0].hr_approved_at) {
      return error(res, 'HR has already signed this payroll run', HTTP_STATUS.BAD_REQUEST);
    }

    await db.query(`
      UPDATE payroll_runs SET
        hr_approved_by = $1, hr_approved_at = NOW(), hr_comment = $2
      WHERE id = $3
    `, [hrUid, comment || null, runId]);

    const updated = await db.query('SELECT * FROM payroll_runs WHERE id = $1', [runId]);
    success(res, updated.rows[0], 'HR signature applied — awaiting Admin countersign before payslips can be issued');
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

    const run = await db.query('SELECT * FROM payroll_runs WHERE id = $1', [runId]);
    if (run.rows.length === 0) return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);
    if (!run.rows[0].hr_approved_at) {
      return error(res, 'HR must sign before Admin countersign', HTTP_STATUS.BAD_REQUEST);
    }
    if (run.rows[0].admin_approved_at) {
      return error(res, 'Admin has already countersigned this payroll run', HTTP_STATUS.BAD_REQUEST);
    }
    if (run.rows[0].hr_approved_by === adminUid) {
      return error(res, 'HR signer and Admin countersigner cannot be the same person', HTTP_STATUS.FORBIDDEN);
    }

    // Compute integrity hash over the payslip totals
    const hash = crypto
      .createHash('sha256')
      .update(`${runId}:${run.rows[0].month}:${run.rows[0].year}:${run.rows[0].total_gross}:${run.rows[0].hr_approved_by}:${adminUid}`)
      .digest('hex');

    await db.query(`
      UPDATE payroll_runs SET
        admin_approved_by = $1, admin_approved_at = NOW(), admin_comment = $2,
        approval_hash = $3, status = 'approved'
      WHERE id = $4
    `, [adminUid, comment || null, hash, runId]);

    const updated = await db.query('SELECT * FROM payroll_runs WHERE id = $1', [runId]);
    success(res, updated.rows[0], 'Admin countersign complete — payslips can now be issued to staff');
  } catch (err) {
    logger.error('Admin Sign Payroll Run Error:', err);
    error(res, 'Failed to countersign payroll run', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
