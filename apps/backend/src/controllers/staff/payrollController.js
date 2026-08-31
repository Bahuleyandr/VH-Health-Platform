// src/controllers/staff/payrollController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  executePayrollRun,
  editPayslipAndRegenerate,
  issuePayrollRun,
  revealPayslipCredential,
  signPayrollRun,
  generateAnnualTaxSummary,
  calculateArrears,
} from '../../services/staff/payrollService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { escapeCsvField } from '../../utils/csv.js';
import { logAudit } from '../../utils/logAudit.js';
import { getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

// Shared return shape for full_final_settlements across create/approve/paid.
const FNF_DETAIL_SELECT = {
  id: true,
  staff_uid: true,
  separation_type: true,
  last_working_day: true,
  last_month_days_worked: true,
  last_month_basic: true,
  last_month_allowances: true,
  notice_period_days: true,
  notice_shortfall_days: true,
  notice_recovery_amount: true,
  years_of_service: true,
  gratuity_eligible: true,
  gratuity_amount: true,
  bonus_payable: true,
  other_deductions: true,
  other_deductions_reason: true,
  gross_payable: true,
  total_deductions: true,
  net_payable: true,
  status: true,
  hr_approved_by: true,
  hr_approved_at: true,
  admin_approved_by: true,
  admin_approved_at: true,
  payment_date: true,
  payment_reference: true,
  notes: true,
  created_at: true,
  updated_at: true,
};

// Shared return shape for investment_declarations (upsert + approve).
const DECLARATION_SELECT = {
  id: true,
  staff_uid: true,
  financial_year: true,
  ppf: true,
  epf_voluntary: true,
  elss: true,
  lic_premium: true,
  nsc: true,
  home_loan_principal: true,
  tuition_fees: true,
  other_80c: true,
  health_insurance_self: true,
  health_insurance_parents: true,
  education_loan_interest: true,
  rent_paid_monthly: true,
  rent_receipt_provided: true,
  home_loan_interest: true,
  nps_contribution: true,
  notes: true,
  status: true,
  submitted_at: true,
  approved_by: true,
  approved_at: true,
  created_at: true,
  updated_at: true,
};

// ─── Staff: Get my payslips (last N months) ───────────────────────────────────
export const getMyPayslips = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);
    const { months = 3 } = req.query;

    // Cast to ::uuid so Prisma's text binding of a JS string param matches
    // the UUID column (payslips.staff_uid is UUID).
    const payslips = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.month, p.year, p.gross_salary, p.net_salary,
             p.total_deductions, p.days_present, p.days_absent,
             p.status, p.issued_at, p.pdf_key,
             p.basic_earned, p.overtime_pay, p.pf_employee
      FROM payslips p
      WHERE p.tenant_id = $3::uuid AND p.staff_uid = $1::uuid
        AND p.status IN ('issued','viewed','downloaded')
      ORDER BY p.year DESC, p.month DESC
      LIMIT $2
    `, staffUid, Math.min(parseInt(months), 24), tenantId);

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
    const payslipId = Number.parseInt(id, 10);
    const staffUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);

    if (!Number.isInteger(payslipId) || payslipId <= 0) {
      return error(res, 'Invalid payslip id', HTTP_STATUS.BAD_REQUEST);
    }

    const payslip = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.staff_uid, p.month, p.year, p.payroll_run_id, p.basic_earned, p.hra_earned,
        p.da_earned, p.special_allowance_earned, p.transport_allowance_earned, p.medical_allowance_earned,
        p.overtime_pay, p.gross_salary, p.pf_employee, p.esi_employee,
        p.professional_tax, p.tds, p.total_deductions, p.net_salary, p.status,
        COALESCE(document.object_key, p.pdf_key) AS pdf_key,
        p.created_at, p.updated_at
      FROM payslips p
      LEFT JOIN payroll_runs AS run
        ON run.tenant_id = p.tenant_id AND run.id = p.payroll_run_id
      LEFT JOIN payroll_run_staff_results AS result
        ON result.tenant_id = run.tenant_id
       AND result.payroll_run_id = run.id
       AND result.attempt_token = run.attempt_token
       AND result.staff_uid = p.staff_uid
       AND result.payslip_id = p.id
       AND result.payslip_document_revision = p.document_revision
       AND result.outcome = 'succeeded' AND result.superseded_at IS NULL
      LEFT JOIN payslip_documents AS document
        ON document.tenant_id = result.tenant_id
       AND document.payroll_run_id = result.payroll_run_id
       AND document.attempt_token = result.attempt_token
       AND document.staff_uid = result.staff_uid
       AND document.payslip_id = result.payslip_id
       AND document.payslip_revision = result.payslip_document_revision
       AND document.status = 'notification_accepted'
      WHERE p.tenant_id = $3::uuid AND p.id = $1::int
        AND p.staff_uid = $2::uuid AND p.status IN ('issued','viewed','downloaded')
    `, payslipId, staffUid, tenantId);

    if (payslip.length === 0) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);

    const p = payslip[0];

    // Mark as viewed
    if (p.status === 'issued') {
      await prisma.$executeRawUnsafe(
        `UPDATE payslips SET status = 'viewed', viewed_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2 AND staff_uid = $3::uuid
            AND status = 'issued'`,
        tenantId, payslipId, staffUid,
      );
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

// ─── Staff: Download payslip PDF (302 redirect to signed R2 URL) ──────────────
// The admin /dashboard/my-payslips page calls this with `fetch(...).blob()`;
// fetch follows the 302 by default and resolves with the PDF bytes from R2.
// Keeps PDF streaming off our server — the R2 signed URL expires in 10 min,
// long enough for a browser to finish a small download.
export const downloadPayslip = async (req, res) => {
  try {
    const { id } = req.params;
    const staffUid = req.user?.uid;
    const tenantId = resolveTenantOrThrow(req);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT payslip.id, COALESCE(document.object_key, payslip.pdf_key) AS pdf_key,
              payslip.status
         FROM payslips AS payslip
         LEFT JOIN payroll_runs AS run
           ON run.tenant_id = payslip.tenant_id AND run.id = payslip.payroll_run_id
         LEFT JOIN payroll_run_staff_results AS result
           ON result.tenant_id = run.tenant_id
          AND result.payroll_run_id = run.id
          AND result.attempt_token = run.attempt_token
          AND result.staff_uid = payslip.staff_uid
          AND result.payslip_id = payslip.id
          AND result.payslip_document_revision = payslip.document_revision
          AND result.outcome = 'succeeded' AND result.superseded_at IS NULL
         LEFT JOIN payslip_documents AS document
           ON document.tenant_id = result.tenant_id
          AND document.payroll_run_id = result.payroll_run_id
          AND document.attempt_token = result.attempt_token
          AND document.staff_uid = result.staff_uid
          AND document.payslip_id = result.payslip_id
          AND document.payslip_revision = result.payslip_document_revision
          AND document.status = 'notification_accepted'
        WHERE payslip.tenant_id = $1::uuid AND payslip.id = $2
          AND payslip.staff_uid = $3::uuid
          AND payslip.status IN ('issued', 'viewed', 'downloaded')`,
      tenantId, Number(id), staffUid,
    );
    if (rows.length === 0) {
      return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);
    }
    const p = rows[0];
    if (!p.pdf_key) {
      return error(res, 'Payslip PDF not available', HTTP_STATUS.NOT_FOUND);
    }

    const pdfUrl = await getSignedFileUrl(p.pdf_key, 600).catch((e) => {
      logger.warn('getSignedFileUrl failed for payslip', { id, err: e?.message });
      return null;
    });
    if (!pdfUrl) {
      return error(res, 'Payslip PDF could not be signed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }

    // Mark downloaded on first successful fetch — mirrors getPayslipDetail's
    // issued→viewed bump, advancing one step further.
    if (p.status === 'issued' || p.status === 'viewed') {
      await prisma.$executeRawUnsafe(
        `UPDATE payslips SET status = 'downloaded', downloaded_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2 AND staff_uid = $3::uuid
            AND status IN ('issued', 'viewed')`,
        tenantId, Number(id), staffUid,
      );
    }

    return res.redirect(302, pdfUrl);
  } catch (err) {
    logger.error('Download Payslip Error:', err);
    return error(res, 'Failed to download payslip', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const revealPayslipPassword = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  try {
    const payslipId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(payslipId) || payslipId <= 0) {
      return error(res, 'Invalid payslip id', HTTP_STATUS.BAD_REQUEST);
    }
    const revealed = await revealPayslipCredential({
      tenantId: resolveTenantOrThrow(req),
      payslipId,
      staffUid: req.user?.uid,
    });
    if (!revealed) return error(res, 'Payslip password not available', HTTP_STATUS.NOT_FOUND);
    await logAudit(req, 'payslip-password-revealed', {
      payslip_id: payslipId,
      document_id: revealed.document_id,
    }, { resource: 'payslip', resourceId: payslipId });
    return success(res, { password: revealed.credential }, 'Payslip password revealed');
  } catch (err) {
    logger.error('Reveal Payslip Password Error:', err);
    return error(res, 'Failed to reveal payslip password', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Run payroll for a month ──────────────────────────────────────────
export const runPayroll = async (req, res) => {
  try {
    const adminUid = req.user?.uid;
    const { month, year, rerun = false } = req.body;
    const tenantId = resolveTenantOrThrow(req);

    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);
    if (month < 1 || month > 12) return error(res, 'month must be 1-12', HTTP_STATUS.BAD_REQUEST);

    const run = await executePayrollRun({
      tenantId,
      month,
      year,
      generatedBy: adminUid,
      rerunCompleted: rerun === true,
    });
    if (run.skipped) {
      if (run.reason === 'already_processing') {
        return error(
          res,
          'Payroll for this month is already processing',
          HTTP_STATUS.CONFLICT,
        );
      }
      if (run.reason === 'completed') {
        return error(
          res,
          'Payroll for this month is already complete; set rerun=true with a new Idempotency-Key to rerun it',
          HTTP_STATUS.CONFLICT,
        );
      }
      return error(res, 'Payroll for this month is signed or locked and cannot be rerun', HTTP_STATUS.FORBIDDEN);
    }
    const failed = run.failures;
    success(res, {
      run_id: run.run_id,
      processed: run.processed,
      failed,
      status: run.status,
      total_gross: run.total_gross,
      total_net: run.total_net,
    }, failed > 0
      ? `Payroll run completed with errors: ${run.processed} staff processed, ${failed} failed`
      : `Payroll run complete: ${run.processed} staff processed`);
  } catch (err) {
    logger.error('Run Payroll Error:', err);
    const status = err?.code === 'PAYSLIP_DOCUMENT_RECONCILIATION_REQUIRED'
      ? HTTP_STATUS.CONFLICT
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    error(res, 'Failed to run payroll', status);
  }
};

// ─── Admin: Issue payslips (make visible to staff) ───────────────────────────
export const issuePayslips = async (req, res) => {
  try {
    const { month, year } = req.body;
    if (!month || !year) return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);
    const issued = await issuePayrollRun({
      tenantId: resolveTenantOrThrow(req),
      month,
      year,
      acknowledgeFailedPayslips: hasFailedPayslipAck(req),
    });
    if (issued.reason === 'not_found') {
      return error(res, 'No payroll run found for this month. Run payroll first.', HTTP_STATUS.BAD_REQUEST);
    }
    if (issued.reason === 'hr_required') {
      return error(res, 'HR must sign the payroll run before payslips can be issued', HTTP_STATUS.FORBIDDEN);
    }
    if (issued.reason === 'admin_required') {
      return error(res, 'Admin must countersign the payroll run before payslips can be issued', HTTP_STATUS.FORBIDDEN);
    }
    if (issued.reason === 'invalid_status') {
      return error(res, 'Payroll run must be approved before payslips can be issued', HTTP_STATUS.CONFLICT);
    }
    if (issued.reason === 'manifest_changed') {
      return error(res, 'Payroll results changed after approval; issuance is blocked', HTTP_STATUS.CONFLICT);
    }
    if (issued.reason === 'ack_required') {
      return rejectUnacknowledgedFailedPayslips(res, issued.run, 'issue');
    }
    if (issued.reason === 'delivery_pending') {
      return error(
        res,
        'Payslip documents or their in-app delivery receipts are still pending',
        HTTP_STATUS.CONFLICT,
        {
          topLevel: { code: 'PAYSLIP_DELIVERY_PENDING' },
          pending_staff: issued.pendingDelivery.map(row => ({
            staff_uid: row.staff_uid,
            state: row.delivery_state,
          })),
        },
      );
    }
    if (issued.ackRequired) await auditFailedPayslipAck(req, issued.run, 'issue');
    success(res, { issued: issued.issued }, issued.ackRequired
      ? `${issued.issued} payslips issued to staff — ${issued.run.failed_staff_count} failed payslip(s) acknowledged as not issued`
      : `${issued.issued} payslips issued to staff`);
  } catch (err) {
    logger.error('Issue Payslips Error:', err);
    error(res, 'Failed to issue payslips', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Get payroll runs list ─────────────────────────────────────────────
export const getPayrollRuns = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    // Explicit columns (house rule: no SELECT *). `failed_staff_count` is
    // operator-facing and rendered in the admin runs list; `failed_staff` is
    // deliberately NOT selected raw — it holds internal error text, which
    // belongs in the DB and the logs, not in an API response. What IS surfaced
    // is `failed_staff_summary`: only the identity (uid + name) of each staff
    // member whose payslip failed, so a signer can see WHO is unpaid before
    // acknowledging a completed_with_errors run. The `reason` key is never
    // projected.
    const runs = await prisma.$queryRawUnsafe(`
      SELECT pr.id, pr.month, pr.year, pr.status, pr.total_staff,
             pr.failed_staff_count,
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'staff_uid', fs->>'staff_uid',
                        'name', fu.name))
                 FROM jsonb_array_elements(pr.failed_staff) fs
                 LEFT JOIN users fu
                   ON fu.tenant_id = pr.tenant_id
                  AND fu.uid = (fs->>'staff_uid')::uuid
             ), '[]'::jsonb) AS failed_staff_summary,
             pr.total_gross, pr.total_net, pr.total_deductions,
             pr.generated_by, pr.generated_at, pr.locked_by, pr.locked_at,
             pr.notes, pr.created_at, pr.updated_at, pr.employee_count,
             pr.hr_approved_by, pr.hr_approved_at, pr.hr_comment,
             pr.admin_approved_by, pr.admin_approved_at, pr.admin_comment,
             pr.approval_hash, pr.tenant_id,
             u.name as generated_by_name
      FROM payroll_runs pr
      LEFT JOIN users u
        ON u.tenant_id = pr.tenant_id AND pr.generated_by = u.uid
      WHERE pr.tenant_id = $1::uuid
      ORDER BY pr.year DESC, pr.month DESC
      LIMIT 24
    `, tenantId);
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
    const runIdNumber = Number.parseInt(runId, 10);
    const tenantId = resolveTenantOrThrow(req);

    if (!Number.isInteger(runIdNumber) || runIdNumber <= 0) {
      return error(res, 'Invalid payroll run id', HTTP_STATUS.BAD_REQUEST);
    }

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT p.id, p.payroll_run_id, p.staff_uid, p.month, p.year,
             p.total_working_days, p.days_present, p.days_absent, p.days_leave,
             p.days_half, p.overtime_hours, p.overtime_rate, p.basic_earned,
             p.hra_earned, p.da_earned, p.special_allowance_earned,
             p.transport_allowance_earned, p.medical_allowance_earned,
             p.overtime_pay, p.bonus_this_month, p.gross_salary, p.pf_employee,
             p.esi_employee, p.professional_tax, p.tds, p.other_deductions,
             p.total_deductions, p.net_salary, p.status, p.issued_at,
             p.lop_days, p.lop_deduction, p.arrears_amount,
             p.advance_deduction, p.revision_note, p.manually_edited,
             p.edit_reason, p.edited_by, p.edited_at,
             u.name as staff_name, u.email,
             COALESCE(s.department, ss.department) as department,
             u.role
      FROM payslips p
      JOIN users u ON u.tenant_id = p.tenant_id AND p.staff_uid = u.uid
      LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.user_id = u.uid
      LEFT JOIN staff_salary ss ON ss.tenant_id = u.tenant_id AND ss.staff_uid = u.uid
      WHERE p.tenant_id = $2::uuid AND p.payroll_run_id = $1::int
        AND p.status <> 'superseded'
      ORDER BY u.name
    `, runIdNumber, tenantId);

    const run = await prisma.$queryRawUnsafe(
      `SELECT id, month, year, status, generated_by, generated_at,
              hr_approved_by, hr_approved_at, admin_approved_by, admin_approved_at,
              total_gross, total_deductions, total_net, employee_count,
              notes, created_at, updated_at
       FROM payroll_runs
       WHERE tenant_id = $2::uuid AND id=$1::int`,
      runIdNumber, tenantId,
    );
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
    const tenantId = resolveTenantOrThrow(req);
    const { search, department } = req.query;
    const conditions = [
      'u.tenant_id = $1::uuid',
      'u.role NOT IN (\'PATIENT\', \'ADMIN\')',
    ];
    const params = [tenantId];
    let idx = 2;

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
      LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.user_id = u.uid
      LEFT JOIN staff_salary ss ON ss.tenant_id = u.tenant_id AND ss.staff_uid = u.uid
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
    const tenantId = resolveTenantOrThrow(req);

    const config = await prisma.$queryRawUnsafe(`
      SELECT ss.id, ss.staff_uid, ss.basic_salary, ss.hra_pct, ss.da_pct,
             ss.special_allowance, ss.transport_allowance, ss.medical_allowance,
             ss.pf_employee_pct, ss.pf_employer_pct, ss.esi_applicable,
             ss.professional_tax, ss.tds_monthly, ss.designation, ss.department,
             ss.employee_id, ss.date_of_joining, ss.pan_number, ss.pf_uan,
             ss.bank_account, ss.bank_name, ss.bank_ifsc, ss.effective_from,
             ss.is_active, ss.notice_period_days, ss.dob, ss.created_at, ss.updated_at,
             u.name, u.role, u.phone,
             COALESCE(s.department, ss.department) as dept
      FROM staff_salary ss
      JOIN users u ON u.tenant_id = ss.tenant_id AND u.uid = ss.staff_uid
      LEFT JOIN staff s ON s.tenant_id = ss.tenant_id AND s.user_id = u.uid
      WHERE ss.tenant_id = $2::uuid AND ss.staff_uid = $1::uuid
    `, staffUid, tenantId);

    if (config.length === 0) {
      const user = await prisma.$queryRawUnsafe(
        `SELECT uid, name, role, phone
           FROM users
          WHERE tenant_id = $2::uuid AND uid = $1::uuid`,
        staffUid,
        tenantId,
      );
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
    const tenantId = resolveTenantOrThrow(req);
    const {
      basic_salary, hra_pct, da_pct, special_allowance, transport_allowance, medical_allowance,
      pf_employee_pct, esi_applicable, professional_tax, tds_monthly,
      designation, department, employee_id, date_of_joining, pan_number, pf_uan,
      bank_account, bank_name, bank_ifsc,
    } = req.body;

    if (!basic_salary || parseFloat(basic_salary) <= 0) {
      return error(res, 'basic_salary is required and must be positive', HTTP_STATUS.BAD_REQUEST);
    }

    const userCheck = await prisma.$queryRawUnsafe(
      `SELECT uid, name
         FROM users
        WHERE tenant_id = $2::uuid AND uid = $1::uuid`,
      staffUid,
      tenantId,
    );
    if (userCheck.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    // Preserve the two COALESCE-with-NULLIF patterns from the old SQL:
    //   pan_number / bank_account: if caller sends '' or null, keep the
    //   existing DB value. This matches the UI behaviour where the masked
    //   form field sometimes submits the mask string rather than a value.
    const panUpdate =
      pan_number && String(pan_number).trim() !== '' ? { pan_number } : {};
    const bankAcctUpdate =
      bank_account && String(bank_account).trim() !== '' ? { bank_account } : {};

    const now = new Date();
    const sharedCreate = {
      tenant_id: tenantId,
      staff_uid: staffUid,
      basic_salary,
      hra_pct: hra_pct ?? 40,
      da_pct: da_pct ?? 10,
      special_allowance: special_allowance ?? 0,
      transport_allowance: transport_allowance ?? 0,
      medical_allowance: medical_allowance ?? 0,
      pf_employee_pct: pf_employee_pct ?? 12,
      esi_applicable: esi_applicable ?? false,
      professional_tax: professional_tax ?? 200,
      tds_monthly: tds_monthly ?? 0,
      designation: designation ?? null,
      department: department ?? null,
      employee_id: employee_id ?? null,
      date_of_joining: date_of_joining ? new Date(date_of_joining) : null,
      pan_number: pan_number ?? null,
      pf_uan: pf_uan ?? null,
      bank_account: bank_account ?? null,
      bank_name: bank_name ?? null,
      bank_ifsc: bank_ifsc ?? null,
      updated_at: now,
    };
    const result = await prisma.staff_salary.upsert({
      where: {
        tenant_id_staff_uid: {
          tenant_id: tenantId,
          staff_uid: staffUid,
        },
      },
      create: sharedCreate,
      update: {
        basic_salary,
        hra_pct: hra_pct ?? 40,
        da_pct: da_pct ?? 10,
        special_allowance: special_allowance ?? 0,
        transport_allowance: transport_allowance ?? 0,
        medical_allowance: medical_allowance ?? 0,
        pf_employee_pct: pf_employee_pct ?? 12,
        esi_applicable: esi_applicable ?? false,
        professional_tax: professional_tax ?? 200,
        tds_monthly: tds_monthly ?? 0,
        designation: designation ?? null,
        department: department ?? null,
        employee_id: employee_id ?? null,
        date_of_joining: date_of_joining ? new Date(date_of_joining) : null,
        ...panUpdate,
        pf_uan: pf_uan ?? null,
        ...bankAcctUpdate,
        bank_name: bank_name ?? null,
        bank_ifsc: bank_ifsc ?? null,
        updated_at: now,
      },
      select: {
        id: true,
        staff_uid: true,
        basic_salary: true,
        hra_pct: true,
        da_pct: true,
        special_allowance: true,
        transport_allowance: true,
        medical_allowance: true,
        pf_employee_pct: true,
        esi_applicable: true,
        professional_tax: true,
        tds_monthly: true,
        designation: true,
        department: true,
        employee_id: true,
        date_of_joining: true,
        pan_number: true,
        pf_uan: true,
        bank_account: true,
        bank_name: true,
        bank_ifsc: true,
        created_at: true,
        updated_at: true,
      },
    });

    const row = result;
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
    const updated = await editPayslipAndRegenerate({
      tenantId: resolveTenantOrThrow(req),
      payslipId: id,
      editorUid,
      editReason: edit_reason,
      edits,
    });
    if (!updated) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);
    success(res, updated, 'Payslip updated and its immutable PDF delivery was regenerated');
  } catch (err) {
    logger.error('Manual Edit Payslip Error:', err);
    if (err?.code === 'PAYSLIP_NOT_EDITABLE') {
      return error(res, err.message, HTTP_STATUS.FORBIDDEN);
    }
    if (err?.code === 'PAYSLIP_DOCUMENT_RECONCILIATION_REQUIRED') {
      return error(res, 'Payslip document delivery requires reconciliation before editing', HTTP_STATUS.CONFLICT);
    }
    error(res, 'Failed to edit payslip', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Failed-payslip acknowledgement (migration 644 follow-up) ────────────────
//
// A run that lost staff to calculation failures finishes 'completed_with_errors'
// (payrollService.summarizePayrollRunOutcome). Sign-off over such a run is
// allowed, but never silently: the signer must be shown which payslips failed
// and explicitly resubmit with `acknowledge_failed_payslips: true`. The
// acknowledgement itself is recorded to audit_logs alongside the signature
// columns the run row already carries.
//
// The predicate reads failed_staff_count (not just status) because adminSign
// moves the run to 'approved' and issue moves it to 'locked' — the count is the
// durable marker that payslips are missing at every later stage.
export const FAILED_PAYSLIP_ACK_FIELD = 'acknowledge_failed_payslips';

// Only the identity of the unpaid staff is surfaced — failed_staff also holds
// internal error text (mig 644), which stays in the DB and the logs.
function failedStaffUids(run) {
  const list = Array.isArray(run.failed_staff) ? run.failed_staff : [];
  return list.map((f) => f?.staff_uid).filter(Boolean);
}

function hasFailedPayslipAck(req) {
  return req.body?.[FAILED_PAYSLIP_ACK_FIELD] === true;
}

function rejectUnacknowledgedFailedPayslips(res, run, action) {
  const failedCount = Number(run.failed_staff_count || 0);
  return error(
    res,
    `This payroll run completed with ${failedCount} failed payslip(s) — those staff have no payslip. `
      + `Review the failed staff below and resubmit with ${FAILED_PAYSLIP_ACK_FIELD}: true to ${action} anyway.`,
    HTTP_STATUS.BAD_REQUEST,
    {
      topLevel: { code: 'FAILED_PAYSLIPS_ACK_REQUIRED' },
      failed_staff_count: failedCount,
      failed_staff_uids: failedStaffUids(run),
      acknowledgement_field: FAILED_PAYSLIP_ACK_FIELD,
    },
  );
}

async function auditFailedPayslipAck(req, run, action) {
  await logAudit(req, `payroll-${action}-failed-payslips-acknowledged`, {
    run_id: run.id,
    month: run.month,
    year: run.year,
    failed_staff_count: Number(run.failed_staff_count || 0),
    failed_staff_uids: failedStaffUids(run),
  }, { resource: 'payroll_run', resourceId: run.id });
}

// The published sign-off payload. `signPayrollRun` deliberately reads three
// extra columns — `attempt_token`, `result_manifest_hash`,
// `document_manifest_hash` — because it needs them INSIDE the transaction to
// prove the run's results and documents have not changed since finalization
// (migrations 664 / 669). They are internal integrity and attempt-claim
// artifacts with no consumer: the operator-facing integrity value is
// `approval_hash`, which stays. Returning the service row verbatim would
// publish them, which is exactly the leakage the `PayrollRun` schema forbids
// (`additionalProperties: false`, scripts/openapi/schemas/payroll.mjs:111) and
// the opposite of the direction the rest of this surface was tightened in
// (PayslipListItem / PayrollRunDetailHeader dropped tenant_id, pdf_key and
// friends for the same reason). Project to the typed contract instead.
const PUBLIC_PAYROLL_RUN_FIELDS = Object.freeze([
  'id', 'month', 'year', 'status', 'total_staff', 'total_gross', 'total_net',
  'total_deductions', 'generated_by', 'generated_at', 'employee_count',
  'hr_approved_by', 'hr_approved_at', 'hr_comment', 'admin_approved_by',
  'admin_approved_at', 'admin_comment', 'approval_hash', 'notes', 'created_at',
  'updated_at',
]);

function publicPayrollRun(run) {
  if (!run || typeof run !== 'object') return run;
  const projected = {};
  for (const field of PUBLIC_PAYROLL_RUN_FIELDS) {
    if (field in run) projected[field] = run[field];
  }
  return projected;
}

// ─── HR: Sign payroll run (first approval) ────────────────────────────────────
export const hrSignPayrollRun = async (req, res) => {
  try {
    const { runId } = req.params;
    const hrUid = req.user?.uid;
    const { comment } = req.body;

    const signed = await signPayrollRun({
      tenantId: resolveTenantOrThrow(req),
      payrollRunId: runId,
      signature: 'hr',
      signerUid: hrUid,
      comment,
      acknowledgeFailedPayslips: hasFailedPayslipAck(req),
    });
    if (signed.reason === 'not_found') {
      return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);
    }
    if (signed.reason === 'role_required') {
      return error(res, 'Only HR_STAFF may apply the HR payroll signature', HTTP_STATUS.FORBIDDEN);
    }
    if (signed.reason === 'invalid_status' || signed.reason === 'state_changed') {
      return error(res, 'Payroll run must be in completed state before signing', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.reason === 'manifest_changed') {
      return error(res, 'Payroll results or documents changed after finalization; regenerate the run', HTTP_STATUS.CONFLICT);
    }
    if (signed.reason === 'already_signed') {
      return error(res, 'HR has already signed this payroll run', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.reason === 'ack_required') {
      return rejectUnacknowledgedFailedPayslips(res, signed.run, 'sign');
    }

    if (signed.ackRequired) await auditFailedPayslipAck(req, signed.ackRun, 'hr-sign');
    success(res, publicPayrollRun(signed.run), signed.ackRequired
      ? `HR signature applied with ${signed.ackRun.failed_staff_count} failed payslip(s) acknowledged — awaiting Admin countersign`
      : 'HR signature applied — awaiting Admin countersign before payslips can be issued');
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

    const signed = await signPayrollRun({
      tenantId: resolveTenantOrThrow(req),
      payrollRunId: runId,
      signature: 'admin',
      signerUid: adminUid,
      comment,
      acknowledgeFailedPayslips: hasFailedPayslipAck(req),
    });
    if (signed.reason === 'not_found') {
      return error(res, 'Payroll run not found', HTTP_STATUS.NOT_FOUND);
    }
    if (signed.reason === 'role_required') {
      return error(res, 'Only ADMIN or SUPER_ADMIN may countersign payroll', HTTP_STATUS.FORBIDDEN);
    }
    if (signed.reason === 'invalid_status' || signed.reason === 'state_changed') {
      return error(res, 'Payroll run must be in completed state before countersign', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.reason === 'manifest_changed') {
      return error(res, 'Payroll results or documents changed after finalization; regenerate the run', HTTP_STATUS.CONFLICT);
    }
    if (signed.reason === 'hr_required') {
      return error(res, 'HR must sign before Admin countersign', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.reason === 'already_signed') {
      return error(res, 'Admin has already countersigned this payroll run', HTTP_STATUS.BAD_REQUEST);
    }
    if (signed.reason === 'same_signer') {
      return error(res, 'HR signer and Admin countersigner cannot be the same person', HTTP_STATUS.FORBIDDEN);
    }
    if (signed.reason === 'ack_required') {
      return rejectUnacknowledgedFailedPayslips(res, signed.run, 'countersign');
    }

    if (signed.ackRequired) await auditFailedPayslipAck(req, signed.ackRun, 'admin-sign');
    success(res, publicPayrollRun(signed.run), signed.ackRequired
      ? `Admin countersign complete with ${signed.ackRun.failed_staff_count} failed payslip(s) acknowledged — payslips can now be issued`
      : 'Admin countersign complete — payslips can now be issued to staff');
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

    const summary = await prisma.$queryRawUnsafe(`
      SELECT id, staff_uid, financial_year,
        total_gross AS total_income,
        total_basic, total_hra, total_da, total_special_allowance,
        total_transport_allowance, total_medical_allowance, total_overtime,
        total_bonus, total_arrears, total_gross, total_tds, total_pf,
        total_esi, total_professional_tax, total_advance_deductions,
        total_deductions, total_net, taxable_income, tax_payable,
        months_included, generated_at, pdf_key, status, created_at, updated_at
      FROM annual_tax_summaries
      WHERE staff_uid=$1::uuid AND financial_year=$2
    `, staffUid, financialYear);

    if (summary.length === 0) {
      try {
        const generated = await generateAnnualTaxSummary(staffUid, financialYear);
        return success(res, generated, 'Annual tax summary generated');
      } catch (generationErr) {
        if (/No payslips found/i.test(String(generationErr?.message || ''))) {
          return error(res, 'No issued payslips found for this financial year', HTTP_STATUS.NOT_FOUND);
        }
        throw generationErr;
      }
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
      WHERE sa.staff_uid = $1::uuid ORDER BY sa.created_at DESC
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
      SELECT sa.*, u.name as staff_name, ss.department,
             (sa.amount - sa.total_deducted) as balance_remaining
      FROM salary_advances sa
      JOIN users u ON sa.staff_uid = u.uid
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
      ${where} ORDER BY sa.created_at DESC
    `, ...params);
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
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);
    }

    const payslips = await prisma.$queryRawUnsafe(`
      SELECT
        u.name as employee_name,
        ss.employee_id, ss.designation, ss.department,
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
      // CAN-005: formula-neutralize + quote the user-influenceable text fields.
      const row = [
        escapeCsvField(r.employee_name || ''),
        escapeCsvField(r.employee_id || ''),
        escapeCsvField(r.designation || ''),
        escapeCsvField(r.department || ''),
        escapeCsvField(r.bank_account ? '****' + String(r.bank_account).slice(-4) : ''),
        escapeCsvField(r.bank_ifsc || ''),
        r.days_present, r.days_absent, r.lop_days || 0, r.overtime_hours || 0,
        r.basic_earned, r.hra_earned, r.da_earned, r.special_allowance_earned,
        r.transport_allowance_earned, r.medical_allowance_earned,
        r.overtime_pay, r.bonus, r.arrears, r.gross_salary,
        r.pf_employee, r.esi_employee, r.professional_tax, r.tds,
        r.advance_deduction, r.total_deductions, r.net_salary,
        escapeCsvField(r.status),
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
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);
    }

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
        escapeCsvField(r.pf_uan || ''),
        escapeCsvField(r.name),
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
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return error(res, 'month and year required', HTTP_STATUS.BAD_REQUEST);
    }

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
      rows.push(`${i + 1},${escapeCsvField(r.name)},${escapeCsvField(r.employee_id || '')},${parseFloat(r.gross_salary).toFixed(2)},${parseFloat(r.esi_employee).toFixed(2)},${parseFloat(r.esi_employer).toFixed(2)},${total.toFixed(2)}`);
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
        p.id, p.staff_uid, u.name, ss.employee_id, ss.designation, ss.department,
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
    const result = await prisma.full_final_settlements.create({
      data: {
        staff_uid,
        separation_type,
        last_working_day: new Date(last_working_day),
        last_month_days_worked: daysWorked,
        last_month_basic: lastMonthBasic,
        last_month_allowances: lastMonthAllowances,
        notice_period_days: s.notice_period_days || 30,
        notice_shortfall_days: shortfall,
        notice_recovery_amount: noticeRecovery,
        years_of_service: Math.round(yearsOfService * 100) / 100,
        gratuity_eligible: gratuityEligible,
        gratuity_amount: gratuityAmount,
        bonus_payable: parseFloat(bonus_payable) || 0,
        other_deductions: parseFloat(other_deductions) || 0,
        other_deductions_reason: other_deductions_reason || null,
        gross_payable: grossPayable,
        total_deductions: totalDedns,
        net_payable: netPayable,
        notes: notes || null,
        created_by: req.user?.uid,
      },
      select: FNF_DETAIL_SELECT,
    });
    success(res, result, `F&F calculated. Net payable: ₹${netPayable}`);
  } catch (err) { logger.error('CreateFnF:', err); error(res, 'Failed to create settlement', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getFnFList = async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE f.status = $1`; }
    const result = await prisma.$queryRawUnsafe(
      `SELECT f.*, u.name as staff_name, ss.department, ss.designation, ss.employee_id
       FROM full_final_settlements f
       JOIN users u ON f.staff_uid = u.uid
       LEFT JOIN staff_salary ss ON ss.staff_uid = f.staff_uid
       ${where} ORDER BY f.created_at DESC`, ...params);
    success(res, result, 'F&F list fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const approveFnF = async (req, res) => {
  try {
    const { id } = req.params;
    const role = req.user?.role; const uid = req.user?.uid;
    const fnf = await prisma.$queryRawUnsafe('SELECT id, staff_uid, last_working_day, gross_payable, total_deductions, net_payable, status, hr_approved_by, admin_approved_by, created_at, updated_at FROM full_final_settlements WHERE id=$1', id);
    if (!fnf.length) return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
    const f = fnf[0];
    let update;
    const now = new Date();
    if (role === 'HR' && f.status === 'draft') {
      update = await prisma.full_final_settlements.update({
        where: { id: Number(id) },
        data: { status: 'hr_approved', hr_approved_by: uid, hr_approved_at: now, updated_at: now },
        select: FNF_DETAIL_SELECT,
      });
    } else if (role === 'ADMIN' && f.status === 'hr_approved') {
      update = await prisma.full_final_settlements.update({
        where: { id: Number(id) },
        data: { status: 'admin_approved', admin_approved_by: uid, admin_approved_at: now, updated_at: now },
        select: FNF_DETAIL_SELECT,
      });
    } else return error(res, 'Cannot approve: wrong role or status', HTTP_STATUS.BAD_REQUEST);
    success(res, update, 'F&F approved');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const markFnFPaid = async (req, res) => {
  try {
    const { id } = req.params; const { payment_date, payment_reference } = req.body;
    // updateMany so the `status='admin_approved'` predicate is part of the
    // WHERE — matches the original "atomic transition only from the
    // approved state" contract. An ORM-side update() with a guard would
    // need a separate SELECT + update, introducing a race window.
    const { count } = await prisma.full_final_settlements.updateMany({
      where: { id: Number(id), status: 'admin_approved' },
      data: {
        status: 'paid',
        payment_date: payment_date ? new Date(payment_date) : null,
        payment_reference,
        updated_at: new Date(),
      },
    });
    if (count === 0) return error(res, 'Not found or not admin-approved', HTTP_STATUS.BAD_REQUEST);
    const result = await prisma.full_final_settlements.findUnique({
      where: { id: Number(id) },
      select: FNF_DETAIL_SELECT,
    });
    success(res, result, 'F&F marked as paid');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 2: Gratuity Status

export const getAllGratuityStatus = async (req, res) => {
  try {
    const staff = await prisma.$queryRawUnsafe(
      `SELECT u.uid, u.name, ss.department, ss.basic_salary, ss.date_of_joining, ss.designation, ss.employee_id
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

    // The old UPSERT used CASE expressions to preserve `status` and
    // `submitted_at` when the existing row was 'locked'. Prisma has no
    // ORM-side CASE — read the current row first so we can branch in JS.
    const existing = await prisma.investment_declarations.findUnique({
      where: { staff_uid_financial_year: { staff_uid: staffUid, financial_year } },
      select: { status: true, submitted_at: true },
    });
    const isLocked = existing?.status === 'locked';
    const now = new Date();

    const amounts = {
      ppf, epf_voluntary, elss, lic_premium, nsc,
      home_loan_principal, tuition_fees, other_80c,
      health_insurance_self, health_insurance_parents,
      education_loan_interest, rent_paid_monthly, rent_receipt_provided,
      home_loan_interest, nps_contribution,
      notes: notes || null,
    };

    const result = await prisma.investment_declarations.upsert({
      where: { staff_uid_financial_year: { staff_uid: staffUid, financial_year } },
      create: {
        staff_uid: staffUid,
        financial_year,
        ...amounts,
        status: 'submitted',
        submitted_at: now,
      },
      update: {
        ...amounts,
        // Locked rows: keep status + submitted_at unchanged (match the
        // old CASE-based UPSERT). Everything-else: flip to submitted
        // and refresh submitted_at.
        ...(isLocked ? {} : { status: 'submitted', submitted_at: now }),
        updated_at: now,
      },
      select: DECLARATION_SELECT,
    });
    success(res, result, 'Declaration saved');
  } catch (err) { logger.error('UpsertDeclaration:', err); error(res, 'Failed to save declaration', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getMyDeclarations = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT id, staff_uid, financial_year,
        ppf, epf_voluntary, elss, lic_premium, nsc,
        home_loan_principal, tuition_fees, other_80c,
        health_insurance_self, health_insurance_parents,
        education_loan_interest, rent_paid_monthly, rent_receipt_provided,
        home_loan_interest, nps_contribution, notes,
        status, submitted_at, approved_by, approved_at,
        proof_submitted, created_at, updated_at,
        (
          COALESCE(ppf, 0) + COALESCE(epf_voluntary, 0) + COALESCE(elss, 0) +
          COALESCE(lic_premium, 0) + COALESCE(nsc, 0) +
          COALESCE(home_loan_principal, 0) + COALESCE(tuition_fees, 0) +
          COALESCE(other_80c, 0)
        ) AS section_80c,
        (
          COALESCE(health_insurance_self, 0) + COALESCE(health_insurance_parents, 0)
        ) AS section_80d,
        rent_paid_monthly AS hra_exemption,
        0::numeric AS lta,
        (
          COALESCE(education_loan_interest, 0) +
          COALESCE(home_loan_interest, 0) +
          COALESCE(nps_contribution, 0)
        ) AS other_deductions
      FROM investment_declarations
      WHERE staff_uid=$1::uuid
      ORDER BY financial_year DESC
    `, req.user?.uid);
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
      `SELECT d.*, u.name as staff_name, ss.department, ss.designation, ss.employee_id
       FROM investment_declarations d
       JOIN users u ON d.staff_uid = u.uid
       LEFT JOIN staff_salary ss ON ss.staff_uid = d.staff_uid
       ${where} ORDER BY u.name`, ...params);
    success(res, result, 'Declarations fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const approveDeclaration = async (req, res) => {
  try {
    const now = new Date();
    try {
      const result = await prisma.investment_declarations.update({
        where: { id: Number(req.params.id) },
        data: {
          status: 'approved',
          approved_by: req.user?.uid,
          approved_at: now,
          updated_at: now,
        },
        select: DECLARATION_SELECT,
      });
      success(res, result, 'Declaration approved');
    } catch (err) {
      // P2025 = record not found — match the old "Not found" contract.
      if (err?.code === 'P2025') return error(res, 'Not found', HTTP_STATUS.NOT_FOUND);
      throw err;
    }
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
    const result = await prisma.leave_encashments.create({
      data: {
        staff_uid,
        encashment_type,
        leave_days: parseInt(leave_days),
        daily_rate: dailyRate,
        amount,
        financial_year: financial_year || null,
        approved_by: req.user?.uid,
        approved_at: new Date(),
        status: 'approved',
      },
      select: {
        id: true,
        staff_uid: true,
        encashment_type: true,
        leave_days: true,
        daily_rate: true,
        amount: true,
        financial_year: true,
        approved_by: true,
        approved_at: true,
        status: true,
        created_at: true,
      },
    });
    success(res, result, `${leave_days} days × ₹${dailyRate.toFixed(2)}/day = ₹${amount}`);
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
       ${where} ORDER BY le.created_at DESC`, ...params);
    success(res, result, 'Leave encashments fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

// Feature 6: Payslip Query System

export const raisePayslipQuery = async (req, res) => {
  try {
    const staffUid = req.user?.uid;
    const { payslip_id, subject, description, category } = req.body;
    if (!payslip_id || !subject || !description) return error(res, 'payslip_id, subject, description required', HTTP_STATUS.BAD_REQUEST);
    const payslip = await prisma.payslips.findFirst({
      where: { id: Number(payslip_id), staff_uid: staffUid },
      select: { id: true },
    });
    if (!payslip) return error(res, 'Payslip not found', HTTP_STATUS.NOT_FOUND);
    const result = await prisma.payslip_queries.create({
      data: {
        payslip_id: Number(payslip_id),
        staff_uid: staffUid,
        subject,
        description,
        category: category || 'general',
      },
      select: {
        id: true,
        payslip_id: true,
        staff_uid: true,
        subject: true,
        description: true,
        category: true,
        status: true,
        created_at: true,
      },
    });
    success(res, result, 'Query raised');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getMyPayslipQueries = async (req, res) => {
  try {
    const result = await prisma.$queryRawUnsafe(
      `SELECT pq.*, p.month, p.year, p.net_salary,
         (SELECT json_agg(r ORDER BY r.created_at) FROM payslip_query_replies r WHERE r.query_id=pq.id) as replies
       FROM payslip_queries pq
       JOIN payslips p ON pq.payslip_id=p.id
       WHERE pq.staff_uid=$1::uuid ORDER BY pq.created_at DESC`, req.user?.uid);
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
       ${where} ORDER BY pq.created_at DESC`, ...params);
    success(res, result, 'All queries fetched');
  } catch (_err) { error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const replyToPayslipQuery = async (req, res) => {
  try {
    const { id } = req.params; const { message, resolve } = req.body;
    if (!message) return error(res, 'message required', HTTP_STATUS.BAD_REQUEST);
    const now = new Date();
    await prisma.payslip_query_replies.create({
      data: {
        query_id: Number(id),
        author_uid: req.user?.uid,
        author_role: req.user?.role,
        message,
      },
      select: { id: true },
    });
    if (resolve) {
      await prisma.payslip_queries.update({
        where: { id: Number(id) },
        data: {
          status: 'resolved',
          resolved_by: req.user?.uid,
          resolved_at: now,
          resolution_note: message,
          updated_at: now,
        },
        select: { id: true },
      });
    } else {
      // The 'status=open' predicate must stay in the WHERE (atomic guard)
      // so updateMany is the right primitive — update() with a where
      // constraint would need a prior SELECT.
      await prisma.payslip_queries.updateMany({
        where: { id: Number(id), status: 'open' },
        data: { status: 'in_review', updated_at: now },
      });
    }
    const updated = await prisma.payslip_queries.findUnique({
      where: { id: Number(id) },
      select: {
        id: true,
        payslip_id: true,
        staff_uid: true,
        subject: true,
        description: true,
        category: true,
        status: true,
        resolved_by: true,
        resolved_at: true,
        resolution_note: true,
        created_at: true,
        updated_at: true,
      },
    });
    success(res, updated, resolve ? 'Query resolved' : 'Reply sent');
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
      `SELECT month,year FROM payroll_runs WHERE status IN ('approved','locked') AND year=$1`, year);
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
    if (target_type==='department') { countQuery+=` AND ss.department=$1`; params.push(target_value); }
    else if (target_type==='role') { countQuery+=` AND u.role=$1`; params.push(target_value); }
    else if (target_type==='designation') { countQuery+=` AND ss.designation=$1`; params.push(target_value); }
    const countResult=await prisma.$queryRawUnsafe(countQuery,...params);
    const staffCount=parseInt(countResult[0].cnt);
    if (staffCount===0) return error(res,`No active staff found for ${target_type}=${target_value}`,HTTP_STATUS.BAD_REQUEST);
    const job = await prisma.bulk_revision_jobs.create({
      data: {
        description,
        revision_type,
        target_type,
        target_value,
        increment_type,
        increment_value,
        bonus_amount,
        effective_from: new Date(effective_from),
        staff_count: staffCount,
        status: 'draft',
        created_by: req.user?.uid,
      },
      select: {
        id: true,
        description: true,
        revision_type: true,
        target_type: true,
        target_value: true,
        increment_type: true,
        increment_value: true,
        bonus_amount: true,
        effective_from: true,
        staff_count: true,
        status: true,
        created_by: true,
        created_at: true,
      },
    });
    success(res, job, `Bulk revision draft created. Will affect ${staffCount} staff.`);
  } catch (err) { logger.error('CreateBulkRev:', err); error(res,'Failed to create bulk revision',HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const approveBulkRevision = async (req, res) => {
  try {
    const { id } = req.params; const adminUid=req.user?.uid;
    const j = await prisma.bulk_revision_jobs.findUnique({
      where: { id: Number(id) },
      select: {
        id: true,
        status: true,
        target_type: true,
        target_value: true,
        revision_type: true,
        increment_type: true,
        increment_value: true,
        bonus_amount: true,
        effective_from: true,
        description: true,
        staff_count: true,
      },
    });
    if (!j) return error(res,'Not found',HTTP_STATUS.NOT_FOUND);
    if (j.status !== 'draft') return error(res,'Already processed',HTTP_STATUS.BAD_REQUEST);

    await prisma.bulk_revision_jobs.update({
      where: { id: Number(id) },
      data: { status: 'approved', approved_by: adminUid, approved_at: new Date() },
      select: { id: true },
    });

    setImmediate(async () => {
      try {
        // Staff targeting — still raw because the dynamic WHERE on users/
        // staff_salary with varying filter columns is awkward in ORM form,
        // and this is a read. Writes below are all typed.
        let staffQuery = `SELECT u.uid,ss.basic_salary FROM users u JOIN staff_salary ss ON ss.staff_uid=u.uid WHERE u.is_active=true`;
        const params = [];
        if (j.target_type === 'department') { staffQuery += ` AND ss.department=$1`; params.push(j.target_value); }
        else if (j.target_type === 'role') { staffQuery += ` AND u.role=$1`; params.push(j.target_value); }
        else if (j.target_type === 'designation') { staffQuery += ` AND ss.designation=$1`; params.push(j.target_value); }
        const staffList = await prisma.$queryRawUnsafe(staffQuery, ...params);

        let processed = 0;
        for (const s of staffList) {
          try {
            let proposed_basic = parseFloat(s.basic_salary);
            if (j.revision_type === 'increment') {
              proposed_basic = j.increment_type === 'percentage'
                ? proposed_basic * (1 + parseFloat(j.increment_value) / 100)
                : proposed_basic + parseFloat(j.increment_value);
            }
            const now = new Date();
            await prisma.salary_revisions.create({
              data: {
                staff_uid: s.uid,
                revision_number: `BULK-${id}-${s.uid.toString().slice(0, 6)}`,
                revision_type: j.revision_type,
                current_basic: s.basic_salary,
                proposed_basic: j.revision_type === 'increment'
                  ? Math.round(proposed_basic * 100) / 100
                  : s.basic_salary,
                bonus_amount: j.bonus_amount || 0,
                effective_from: new Date(j.effective_from),
                reason: j.description,
                status: 'applied',
                hr_signed_by: adminUid,
                hr_signed_at: now,
                admin_signed_by: adminUid,
                admin_signed_at: now,
                applied_at: now,
              },
              select: { id: true },
            });
            if (j.revision_type === 'increment') {
              await prisma.staff_salary.update({
                where: { staff_uid: s.uid },
                data: { basic_salary: Math.round(proposed_basic * 100) / 100, updated_at: now },
                select: { id: true },
              });
            }
            processed++;
          } catch (e) { logger.warn(`Bulk rev failed ${s.uid}: ${e.message}`); }
        }
        await prisma.bulk_revision_jobs.update({
          where: { id: Number(id) },
          data: { status: 'completed', processed_count: processed, completed_at: new Date() },
          select: { id: true },
        });
      } catch (e) {
        await prisma.bulk_revision_jobs.update({
          where: { id: Number(id) },
          data: { status: 'failed', error_log: e.message },
          select: { id: true },
        });
      }
    });

    success(res, { id, status: 'processing', staff_count: j.staff_count }, 'Bulk revision approved and processing');
  } catch (err) { logger.error('ApproveBulkRev:', err); error(res,'Failed to approve bulk revision',HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};

export const getBulkRevisions = async (req, res) => {
  try {
    const result=await prisma.$queryRawUnsafe(
      `SELECT b.*,u.name as created_by_name FROM bulk_revision_jobs b LEFT JOIN users u ON b.created_by=u.uid ORDER BY b.created_at DESC`);
    success(res,result,'Bulk revisions fetched');
  } catch (_err) { error(res,'Failed',HTTP_STATUS.INTERNAL_SERVER_ERROR); }
};
