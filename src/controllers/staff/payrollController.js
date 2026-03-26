// src/controllers/staff/payrollController.js
import db from '../../config/database.js';
import crypto from 'crypto';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { calculatePayslip, savePayslip, generateAnnualTaxSummary, calculateArrears } from '../../services/staff/payrollService.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { dispatch } from '../../utils/notifications/notificationDispatcher.js';

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

        // ─── FEATURE 3: Process advance deductions after saving ──────────
        if (calc._advances_to_process?.length > 0) {
          for (const adv of calc._advances_to_process) {
            await db.query(`
              UPDATE salary_advances SET
                total_deducted = total_deducted + $1,
                months_remaining = GREATEST(0, months_remaining - 1),
                status = CASE WHEN total_deducted + $1 >= amount THEN 'cleared' ELSE status END,
                fully_cleared_at = CASE WHEN total_deducted + $1 >= amount THEN NOW() ELSE NULL END,
                updated_at = NOW()
              WHERE id = $2
            `, [adv.amount, adv.id]);

            await db.query(`
              INSERT INTO advance_deductions (advance_id, payslip_id, staff_uid, month, year, amount_deducted, balance_after)
              VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [adv.id, saved.id, calc.staff_uid, calc.month, calc.year, adv.amount, adv.balanceAfter]);
          }
        }

        // ─── FEATURE 4: Mark arrears as paid after saving ────────────────
        if (calc.arrears_amount > 0) {
          await db.query(`
            UPDATE salary_arrears SET status='paid', paid_in_month=$1, paid_in_year=$2, payslip_id=$3
            WHERE staff_uid=$4 AND status='pending'
          `, [calc.month, calc.year, saved.id, calc.staff_uid]);
        }

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

    // ─── FEATURE 8: Send notifications to staff ──────────────────────────
    const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(month)-1];
    setImmediate(async () => {
      try {
        const issuedStaff = await db.query(`
          SELECT p.staff_uid, u.name, p.net_salary
          FROM payslips p JOIN users u ON p.staff_uid = u.uid
          WHERE p.month=$1 AND p.year=$2 AND p.status='issued'
        `, [month, year]);

        for (const staff of issuedStaff.rows) {
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
      const user = await db.query(
        'SELECT uid, name, role, phone FROM users WHERE uid = $1',
        [staffUid]
      );
      return success(res, user.rows[0] ? { ...user.rows[0], no_config: true } : null, 'No salary config found');
    }

    const row = config.rows[0];
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

    const allowed = [
      'basic_earned', 'hra_earned', 'da_earned', 'special_allowance_earned',
      'transport_allowance_earned', 'medical_allowance_earned', 'overtime_pay',
      'bonus_this_month', 'pf_employee', 'esi_employee', 'professional_tax',
      'tds', 'other_deductions', 'days_present', 'days_absent', 'days_leave',
      'overtime_hours',
    ];

    const fields = Object.keys(edits).filter(k => allowed.includes(k));
    if (fields.length === 0) return error(res, 'No valid editable fields provided', HTTP_STATUS.BAD_REQUEST);

    const setClauses = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => edits[f]);

    await db.query(`UPDATE payslips SET ${setClauses} WHERE id = $1`, [id, ...values]);

    await db.query(`
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

    let summary = await db.query(
      'SELECT * FROM annual_tax_summaries WHERE staff_uid=$1 AND financial_year=$2',
      [staffUid, financialYear]
    );

    if (summary.rows.length === 0) {
      const generated = await generateAnnualTaxSummary(staffUid, financialYear);
      return success(res, generated, 'Annual tax summary generated');
    }

    let pdfUrl = null;
    if (summary.rows[0].pdf_key) {
      pdfUrl = await getSignedFileUrl(summary.rows[0].pdf_key, 3600).catch(() => null);
    }
    success(res, { ...summary.rows[0], pdf_url: pdfUrl }, 'Annual tax summary fetched');
  } catch (err) {
    logger.error('Get Tax Summary Error:', err);
    error(res, err.message || 'Failed to fetch tax summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Admin: Generate/regenerate annual tax summary for all staff
export const generateAllTaxSummaries = async (req, res) => {
  try {
    const { financial_year } = req.body;
    if (!financial_year) return error(res, 'financial_year required (e.g. 2025-26)', HTTP_STATUS.BAD_REQUEST);

    const staffList = await db.query(
      `SELECT DISTINCT staff_uid FROM payslips WHERE status IN ('issued','viewed','downloaded')`
    );
    let generated = 0, failed = 0;

    for (const s of staffList.rows) {
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

    const result = await db.query(`
      INSERT INTO salary_advances (staff_uid, amount, reason, approved_by, approved_at, status,
        monthly_deduction, months_remaining, deduction_start_month, deduction_start_year, notes)
      VALUES ($1,$2,$3,$4,NOW(),'approved',$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      staff_uid, amount, reason, adminUid, monthly_deduction, months_remaining,
      deduction_start_month || new Date().getMonth() + 1,
      deduction_start_year || new Date().getFullYear(),
      notes || null,
    ]);

    success(res, result.rows[0], `Advance of ₹${amount} approved. ${months_remaining} monthly deductions of ₹${monthly_deduction}`);
  } catch (err) {
    logger.error('Create Advance Error:', err);
    error(res, 'Failed to create advance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Staff: Get my advances
export const getMyAdvances = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const advances = await db.query(`
      SELECT sa.*, u.name as approved_by_name,
             (sa.amount - sa.total_deducted) as balance_remaining
      FROM salary_advances sa
      LEFT JOIN users u ON sa.approved_by = u.uid
      WHERE sa.staff_uid = $1 ORDER BY sa.created_at DESC
    `, [staffUid]);
    success(res, advances.rows, 'Advances fetched');
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
    const advances = await db.query(`
      SELECT sa.*, u.name as staff_name, u.department,
             (sa.amount - sa.total_deducted) as balance_remaining
      FROM salary_advances sa JOIN users u ON sa.staff_uid = u.uid
      ${where} ORDER BY sa.created_at DESC
    `, params);
    success(res, advances.rows, 'Advances fetched');
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
    error(res, err.message, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── FEATURE 6: Payroll Summary Export ───────────────────────────────────────

export const exportPayrollSummary = async (req, res) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);

    const payslips = await db.query(`
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
    `, [month, year]);

    if (payslips.rows.length === 0) return error(res, 'No payslips found', HTTP_STATUS.NOT_FOUND);

    const headers = [
      'Employee Name','Employee ID','Designation','Department','Bank Account','IFSC',
      'Days Present','Days Absent','LOP Days','OT Hours',
      'Basic','HRA','DA','Special Allowance','Transport','Medical',
      'OT Pay','Bonus','Arrears','Gross',
      'PF','ESI','Prof Tax','TDS','Advance Deduction','Total Deductions','Net Pay','Status',
    ];

    const csvRows = [headers.join(',')];
    for (const r of payslips.rows) {
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

    const totals = payslips.rows.reduce((acc, r) => {
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

    const payslips = await db.query(`
      SELECT u.name, ss.pf_uan, ss.employee_id, p.basic_earned, p.pf_employee
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
      WHERE p.month=$1 AND p.year=$2
        AND p.pf_employee > 0
        AND p.status IN ('issued','viewed','downloaded')
      ORDER BY u.name
    `, [month, year]);

    const headers = '#,UAN,Member Name,Gross Wages,EPF Wages,EPS Wages,EDLI Wages,EPF Contribution,EPS Contribution,EPF EPS Diff,NCP Days,Refund of Advances';
    const rows = [headers];

    payslips.rows.forEach((r, i) => {
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

    const payslips = await db.query(`
      SELECT u.name, ss.employee_id, p.gross_salary, p.esi_employee,
             ROUND(p.gross_salary * 0.0325, 2) as esi_employer
      FROM payslips p
      JOIN users u ON p.staff_uid = u.uid
      JOIN staff_salary ss ON ss.staff_uid = p.staff_uid
      WHERE p.month=$1 AND p.year=$2
        AND p.esi_employee > 0
        AND p.status IN ('issued','viewed','downloaded')
      ORDER BY u.name
    `, [month, year]);

    const headers = 'Sr No,Employee Name,Employee Code,Gross Wages,Employee ESI (0.75%),Employer ESI (3.25%),Total ESI';
    const rows = [headers];

    payslips.rows.forEach((r, i) => {
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
