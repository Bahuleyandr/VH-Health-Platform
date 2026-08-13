// src/services/staff/payrollService.js
import crypto from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { decryptField, encryptField, getKeyId } from '../../utils/fieldEncryption.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { generatePayslipPDF } from '../../utils/payslipPDF.js';
import { getFileFromR2, uploadFileToR2 } from '../../utils/r2Storage.js';
import { loadTenantKekIntoProvider, tenantKeyId } from '../security/tenantKekProvider.js';
import { requireTenantId } from '../tenant/tenantService.js';

const PAYROLL_ATTEMPT_STALE_HOURS = 4;
const PAYSLIP_DOCUMENT_PREPARE_STALE_MINUTES = 10;
export const PAYROLL_RUN_ATTEMPT_LOST = 'PAYROLL_RUN_ATTEMPT_LOST';
export const PAYROLL_STAFF_IDENTITY_AMBIGUOUS = 'PAYROLL_STAFF_IDENTITY_AMBIGUOUS';

const PERSISTED_PAYSLIP_DECIMAL_FIELDS = [
  'overtime_hours',
  'overtime_rate',
  'basic_earned',
  'hra_earned',
  'da_earned',
  'special_allowance_earned',
  'transport_allowance_earned',
  'medical_allowance_earned',
  'overtime_pay',
  'bonus_this_month',
  'arrears_amount',
  'gross_salary',
  'pf_employee',
  'esi_employee',
  'professional_tax',
  'tds',
  'other_deductions',
  'total_deductions',
  'advance_deduction',
  'lop_days',
  'lop_deduction',
  'net_salary',
];

function normalizePersistedPayslip(row) {
  const normalized = { ...row };
  for (const field of PERSISTED_PAYSLIP_DECIMAL_FIELDS) {
    if (normalized[field] != null) normalized[field] = Number(normalized[field]);
  }
  return normalized;
}

function requireAttemptStartedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('attemptStartedAt must be a valid timestamp');
  return date;
}

function payrollRunAttemptLost(payrollRunId) {
  const err = new Error(`Payroll run ${payrollRunId} is no longer owned by this attempt`);
  err.code = PAYROLL_RUN_ATTEMPT_LOST;
  return err;
}

function requireAttemptToken(value) {
  const token = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error('attemptToken must be a UUID');
  }
  return token;
}

function payrollStaffIdentityAmbiguous(message) {
  const err = new Error(message);
  err.code = PAYROLL_STAFF_IDENTITY_AMBIGUOUS;
  return err;
}

export function isPayrollRunAttemptLostError(err) {
  return err?.code === PAYROLL_RUN_ATTEMPT_LOST;
}

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
async function calculatePayslipTx(client, staffUid, month, year, tenantId) {
  const tid = requireTenantId(tenantId);
  // Get salary config
  // FOR UPDATE is the per-staff serialization point for both manual and cron
  // generation. staff_salary.staff_uid is unique, so every writer for this
  // employee queues behind the same row before reading any mutable money state.
  const salaryRes = await client.$queryRawUnsafe(
    `SELECT id, staff_uid, basic_salary, hra_pct, da_pct, special_allowance,
            transport_allowance, medical_allowance, pf_employee_pct,
            esi_applicable, tds_monthly, is_active, effective_from
       FROM staff_salary
      WHERE tenant_id = $1::uuid
        AND staff_uid = $2::uuid
        AND is_active = true
      FOR UPDATE`,
    tid,
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
  const attRes = await client.$queryRawUnsafe(`
    SELECT
      COUNT(*) FILTER (WHERE attendance_status IS NOT NULL) as days_present,
      SUM(COALESCE(overtime_hours, 0)) as total_overtime_hours
    FROM staff_attendance
    WHERE tenant_id = $1::uuid
      AND staff_uid = $2::uuid
      AND EXTRACT(MONTH FROM COALESCE(check_in_time, "timestamp")) = $3
      AND EXTRACT(YEAR FROM COALESCE(check_in_time, "timestamp")) = $4
  `, tid, staffUid, month, year);

  const daysPresent = parseInt(attRes[0]?.days_present || 0);
  const overtimeHours = parseFloat(attRes[0]?.total_overtime_hours || 0);

  // Get approved leaves this month. leave_applications has NO staff_uid; the FK
  // is staff_id INTEGER → users.id, and the date columns are start_date/end_date
  // (NOT from_date/to_date). calculatePayslip is called with staffUid = users.uid
  // (a UUID), so bridge uid→id in the WHERE. status values are lowercase
  // ('approved' on review) — LOWER() for safety.
  const leaveRes = await client.$queryRawUnsafe(`
    SELECT COALESCE(SUM(
      LEAST(end_date::date, (make_date($4::int, $3::int, 1) + INTERVAL '1 month - 1 day')::date)::date
      - GREATEST(start_date::date, make_date($4::int, $3::int, 1))::date
      + 1
    ), 0) as leave_days
    FROM leave_applications
    WHERE tenant_id = $1::uuid
      AND staff_id = (
        SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid
      )
      AND LOWER(status) = 'approved'
      AND start_date::date <= (make_date($4::int, $3::int, 1) + INTERVAL '1 month - 1 day')::date
      AND end_date::date >= make_date($4::int, $3::int, 1)
  `, tid, staffUid, month, year);

  const leaveDays = parseInt(leaveRes[0]?.leave_days || 0);

  // Get approved overtime for this month
  // overtime_requests.staff_id is INTEGER - need users.id
  const userRes = await client.$queryRawUnsafe(
    'SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid',
    tid,
    staffUid,
  );
  const userId = userRes[0]?.id;

  let approvedOT = overtimeHours;
  if (userId) {
    const otRes = await client.$queryRawUnsafe(`
      SELECT COALESCE(SUM(extra_hours), 0) as approved_overtime
      FROM overtime_requests
      WHERE tenant_id = $1::uuid
        AND staff_id = $2
        AND status = 'approved'
        AND EXTRACT(MONTH FROM date::date) = $3
        AND EXTRACT(YEAR FROM date::date) = $4
    `, tid, userId, month, year);
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

  const existingPayslipRows = await client.$queryRawUnsafe(
    `SELECT id
       FROM payslips
      WHERE tenant_id = $1::uuid
        AND staff_uid = $2::uuid
        AND month = $3
        AND year = $4
      FOR UPDATE`,
    tid,
    staffUid,
    month,
    year,
  );
  const existingPayslipId = existingPayslipRows[0]?.id ?? null;

  // Include pending arrears plus arrears already closed into this exact
  // payslip. That makes a retry reproduce the same gross pay while only the
  // pending IDs are eligible for a state transition later in this transaction.
  const arrearsRes = await client.$queryRawUnsafe(`
    SELECT id, arrears_amount, status, payslip_id
      FROM salary_arrears
     WHERE tenant_id = $1::uuid
       AND staff_uid = $2::uuid
       AND (
         status = 'pending'
         OR (status = 'paid' AND payslip_id = $3::integer)
       )
     ORDER BY id
     FOR UPDATE
  `, tid, staffUid, existingPayslipId);
  const arrearsAmount = arrearsRes.reduce(
    (total, row) => total + parseFloat(row.arrears_amount || 0),
    0,
  );
  const pendingArrearIds = arrearsRes
    .filter((row) => row.status === 'pending')
    .map((row) => Number(row.id));

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
  const advanceRes = await client.$queryRawUnsafe(`
    SELECT a.id, a.staff_uid, a.amount, a.monthly_deduction,
           a.total_deducted, a.status, a.created_at,
           ad.id AS existing_deduction_id,
           ad.payslip_id AS existing_deduction_payslip_id,
           ad.amount_deducted AS existing_deduction_amount,
           ad.balance_after AS existing_balance_after
      FROM salary_advances a
      LEFT JOIN advance_deductions ad
        ON ad.tenant_id = a.tenant_id
       AND ad.advance_id = a.id
       AND ad.staff_uid = $2::uuid
       AND ad.month = $3
       AND ad.year = $4
     WHERE a.tenant_id = $1::uuid
       AND a.staff_uid = $2::uuid
       AND (
         (
           a.status = 'approved'
           AND a.deduction_start_year <= $4
           AND (a.deduction_start_year < $4 OR a.deduction_start_month <= $3)
           AND COALESCE(a.total_deducted, 0) < a.amount
         )
         OR ad.id IS NOT NULL
       )
     ORDER BY a.created_at ASC, a.id ASC
     FOR UPDATE OF a
  `, tid, staffUid, month, year);

  let totalAdvanceDeduction = 0;
  const advancesToProcess = [];
  const seenAdvanceIds = new Set();
  for (const adv of advanceRes) {
    const advanceId = Number(adv.id);
    if (!Number.isInteger(advanceId) || advanceId <= 0) {
      throw new Error(`Invalid salary advance identity for staff ${staffUid}`);
    }
    if (seenAdvanceIds.has(advanceId)) {
      throw new Error(`Duplicate advance deduction identity for advance ${adv.id} in ${month}/${year}`);
    }
    seenAdvanceIds.add(advanceId);

    const alreadyApplied = adv.existing_deduction_id != null;
    const advanceAmount = Number(adv.amount);
    const totalDeducted = Number(adv.total_deducted ?? 0);
    if (!Number.isFinite(advanceAmount) || advanceAmount <= 0
        || !Number.isFinite(totalDeducted) || totalDeducted < 0
        || totalDeducted > advanceAmount) {
      throw new Error(`Invalid balance for salary advance ${advanceId}`);
    }

    let deductThis;
    let balanceAfter;
    if (alreadyApplied) {
      deductThis = Number(adv.existing_deduction_amount);
      balanceAfter = Number(adv.existing_balance_after);
      if (!Number.isFinite(deductThis) || deductThis <= 0
          || !Number.isFinite(balanceAfter) || balanceAfter < 0) {
        throw new Error(`Invalid deduction ledger for salary advance ${advanceId}`);
      }
      if (existingPayslipId == null
          || Number(adv.existing_deduction_payslip_id) !== Number(existingPayslipId)) {
        throw new Error(`Deduction ledger for salary advance ${advanceId} is linked to another payslip`);
      }
    } else {
      const monthlyDeduction = Number(adv.monthly_deduction);
      if (!Number.isFinite(monthlyDeduction) || monthlyDeduction <= 0) {
        throw new Error(`Invalid monthly deduction for salary advance ${advanceId}`);
      }
      const remaining = advanceAmount - totalDeducted;
      deductThis = Math.min(monthlyDeduction, remaining);
      balanceAfter = remaining - deductThis;
    }
    totalAdvanceDeduction += deductThis;
    advancesToProcess.push({
      id: advanceId,
      amount: deductThis,
      balanceAfter,
      alreadyApplied,
    });
  }

  const netSalary = Math.round((grossSalary - totalDeductions - totalAdvanceDeduction) * 100) / 100;

  // ─── FEATURE 2: Check for salary revision note ──────────────────────────
  const revisionCheck = await client.$queryRawUnsafe(`
    SELECT sr.revision_number, sr.revision_type,
           sr.current_basic, sr.proposed_basic,
           sr.bonus_amount, sr.increment_pct, sr.effective_from
    FROM salary_revisions sr
    WHERE sr.tenant_id = $1::uuid
      AND sr.staff_uid = $2::uuid
      AND sr.status = 'applied'
      AND EXTRACT(MONTH FROM sr.effective_from::date) = $3
      AND EXTRACT(YEAR FROM sr.effective_from::date) = $4
    LIMIT 1
  `, tid, staffUid, month, year);

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
    _advances_to_process: advancesToProcess,
    _pending_arrear_ids: pendingArrearIds,
    _arrears_to_process: arrearsRes.map(row => ({
      id: Number(row.id),
      amount: Number(row.arrears_amount),
    })),
  };
}

export async function calculatePayslip(staffUid, month, year, tenantId) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => calculatePayslipTx(tx, staffUid, month, year, tid), {
    maxWait: 10000,
    timeout: 30000,
  });
}

async function reversePayrollFinanceEffectsTx(tx, tenantId, payrollRunId, attemptToken) {
  const payslips = await tx.$queryRawUnsafe(
    `SELECT payslip.id, payslip.status
       FROM payroll_run_staff_results AS result
       JOIN payslips AS payslip
         ON payslip.tenant_id = result.tenant_id
        AND payslip.id = result.payslip_id
      WHERE result.tenant_id = $1::uuid
        AND result.payroll_run_id = $2
        AND result.attempt_token = $3::uuid
        AND result.outcome = 'succeeded'
        AND result.superseded_at IS NULL
      FOR UPDATE OF payslip`,
    tenantId, Number(payrollRunId), attemptToken,
  );
  if (payslips.some(row => ['issued', 'viewed', 'downloaded'].includes(row.status))) {
    throw new Error(`Payroll run ${payrollRunId} has issued financial effects and cannot be recovered`);
  }
  const payslipIds = payslips.map(row => Number(row.id));
  if (payslipIds.length === 0) return;

  const advances = await tx.$queryRawUnsafe(
    `SELECT advance.id
       FROM salary_advances AS advance
      WHERE advance.tenant_id = $1::uuid
        AND EXISTS (
          SELECT 1
            FROM advance_deductions AS deduction
           WHERE deduction.tenant_id = advance.tenant_id
             AND deduction.advance_id = advance.id
             AND deduction.payslip_id = ANY($2::integer[])
        )
      FOR UPDATE OF advance`,
    tenantId, payslipIds,
  );
  await tx.$executeRawUnsafe(
    `DELETE FROM advance_deductions
      WHERE tenant_id = $1::uuid AND payslip_id = ANY($2::integer[])`,
    tenantId, payslipIds,
  );
  for (const row of advances) {
    await tx.$executeRawUnsafe(
      `UPDATE salary_advances AS advance
          SET total_deducted = ledger.total_deducted,
              months_remaining = CASE
                WHEN COALESCE(advance.monthly_deduction, 0) > 0
                  THEN CEIL(GREATEST(advance.amount - ledger.total_deducted, 0)
                            / advance.monthly_deduction)::integer
                ELSE advance.months_remaining
              END,
              status = CASE
                WHEN ledger.total_deducted >= advance.amount THEN 'cleared'
                ELSE 'approved'
              END,
              fully_cleared_at = CASE
                WHEN ledger.total_deducted >= advance.amount THEN advance.fully_cleared_at
                ELSE NULL
              END,
              updated_at = clock_timestamp()
         FROM (
           SELECT COALESCE(sum(amount_deducted), 0) AS total_deducted
             FROM advance_deductions
            WHERE tenant_id = $1::uuid AND advance_id = $2
         ) AS ledger
        WHERE advance.tenant_id = $1::uuid AND advance.id = $2`,
      tenantId, Number(row.id),
    );
  }
  await tx.$executeRawUnsafe(
    `UPDATE salary_arrears
        SET status = 'pending', paid_in_month = NULL, paid_in_year = NULL,
            payslip_id = NULL
      WHERE tenant_id = $1::uuid
        AND payslip_id = ANY($2::integer[])
        AND status = 'paid'`,
    tenantId, payslipIds,
  );
}

export async function beginPayrollRun({
  tenantId,
  month,
  year,
  generatedBy = null,
  skipCompleted = true,
}) {
  const tid = requireTenantId(tenantId);
  const attemptStartedAt = new Date();
  const attemptToken = crypto.randomUUID();
  return setTenantTx(tid, async (tx) => {
    // One period-wide advisory lock covers the initial no-row case as well as
    // stale recovery.  It avoids relying on a unique-index race to decide who
    // owns the attempt and lets the supersession ledger change atomically.
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
      `${tid}:${year}:${month}`,
    );

    const existingRows = await tx.$queryRawUnsafe(
      `SELECT id, status, attempt_token, generated_at, updated_at,
              hr_approved_at, admin_approved_at,
              COALESCE(updated_at, generated_at, '-infinity')
                < clock_timestamp() - make_interval(hours => $4) AS is_stale
         FROM payroll_runs
        WHERE tenant_id = $1::uuid AND month = $2 AND year = $3
        FOR UPDATE`,
      tid, month, year, PAYROLL_ATTEMPT_STALE_HOURS,
    );
    const existing = existingRows[0] || null;
    if (existing) {
      const stale = existing.status === 'processing' && existing.is_stale === true;
      const completed = existing.status === 'completed' || existing.status === 'completed_with_errors';
      const signed = existing.status === 'approved' || existing.status === 'locked'
        || existing.hr_approved_at != null || existing.admin_approved_at != null;

      if (signed || (existing.status === 'processing' && !stale) || (skipCompleted && completed)) {
        return {
          id: Number(existing.id),
          status: existing.status,
          skipped: true,
          reason: existing.status === 'processing'
            ? 'already_processing'
            : completed && !signed
              ? 'completed'
              : 'signed_or_locked',
        };
      }

      const previousAttemptToken = existing.attempt_token;
      const noticeRows = await tx.$queryRawUnsafe(
        `SELECT outbox.id, outbox.status
           FROM payslip_documents AS document
           JOIN notification_outbox AS outbox
             ON outbox.tenant_id = document.tenant_id
            AND outbox.id = document.notification_outbox_id
          WHERE document.tenant_id = $1::uuid
            AND document.payroll_run_id = $2
            AND document.attempt_token = $3::uuid
          FOR UPDATE OF outbox`,
        tid, Number(existing.id), previousAttemptToken,
      );
      const reconciliationNotice = noticeRows.find(
        row => ['CLAIMED', 'RECONCILIATION_REQUIRED'].includes(row.status),
      );
      if (reconciliationNotice) {
        throw payslipDocumentReconciliationRequired(
          `Payroll recovery requires notification reconciliation for outbox ${reconciliationNotice.id}`,
        );
      }
      if (noticeRows.some(row => row.status === 'SENT')) {
        if (existing.status !== 'processing') {
          throw payslipDocumentReconciliationRequired(
            'A completed payroll with an externally visible payslip notice cannot be rerun automatically',
          );
        }
        const resumedRows = await tx.$queryRawUnsafe(
          `UPDATE payroll_runs
              SET generated_by = COALESCE($4::uuid, generated_by),
                  updated_at = clock_timestamp()
            WHERE tenant_id = $1::uuid AND id = $2
              AND attempt_token = $3::uuid AND status = 'processing'
            RETURNING id, generated_at, attempt_token`,
          tid, Number(existing.id), previousAttemptToken, generatedBy,
        );
        if (resumedRows.length !== 1) throw payrollRunAttemptLost(existing.id);
        const frozenStaff = await tx.$queryRawUnsafe(
          `SELECT result.staff_uid, users.name, users.role, users.email,
                  COALESCE(directory.department, salary.department) AS department
             FROM payroll_run_staff_results AS result
             JOIN users
               ON users.tenant_id = result.tenant_id
              AND users.uid = result.staff_uid
             LEFT JOIN staff AS directory
               ON directory.tenant_id = result.tenant_id
              AND directory.user_id = result.staff_uid
             LEFT JOIN staff_salary AS salary
               ON salary.tenant_id = result.tenant_id
              AND salary.staff_uid = result.staff_uid
            WHERE result.tenant_id = $1::uuid
              AND result.payroll_run_id = $2
              AND result.attempt_token = $3::uuid
              AND result.superseded_at IS NULL
            ORDER BY result.staff_uid`,
          tid, Number(existing.id), previousAttemptToken,
        );
        return {
          id: Number(existing.id),
          status: 'processing',
          skipped: false,
          resumed: true,
          reason: 'delivery_already_externally_visible',
          attempt_started_at: resumedRows[0].generated_at,
          attempt_token: resumedRows[0].attempt_token,
          staff: frozenStaff,
        };
      }
      const unsupportedNotice = noticeRows.find(
        row => !['PENDING', 'FAILED'].includes(row.status),
      );
      if (unsupportedNotice) {
        throw payslipDocumentReconciliationRequired(
          `Payroll recovery found unsupported outbox ${unsupportedNotice.id} state ${unsupportedNotice.status}`,
        );
      }
      const suppressedNoticeCount = await tx.$executeRawUnsafe(
        `UPDATE notification_outbox AS outbox
            SET status = 'SUPPRESSED', failure_reason = 'payroll_attempt_superseded',
                last_attempt_at = clock_timestamp()
           FROM payslip_documents AS document
          WHERE document.tenant_id = $1::uuid
            AND document.payroll_run_id = $2
            AND document.attempt_token = $3::uuid
            AND outbox.tenant_id = document.tenant_id
            AND outbox.id = document.notification_outbox_id
            AND outbox.status IN ('PENDING', 'FAILED')`,
        tid, Number(existing.id), previousAttemptToken,
      );
      if (Number(suppressedNoticeCount) !== noticeRows.length) {
        throw payslipDocumentReconciliationRequired(
          'Payroll recovery could not suppress every locked attempt notification',
        );
      }
      await reversePayrollFinanceEffectsTx(
        tx,
        tid,
        Number(existing.id),
        previousAttemptToken,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payslip_documents
            SET status = 'superseded', superseded_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid
            AND payroll_run_id = $2
            AND attempt_token = $3::uuid
            AND status <> 'superseded'`,
        tid, Number(existing.id), previousAttemptToken,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payslips AS payslip
            SET status = 'superseded', pdf_key = NULL, pdf_generated_at = NULL,
                updated_at = clock_timestamp()
          WHERE payslip.tenant_id = $1::uuid
            AND payslip.id IN (
              SELECT result.payslip_id
                FROM payroll_run_staff_results AS result
               WHERE result.tenant_id = $1::uuid
                 AND result.payroll_run_id = $2
                 AND result.attempt_token = $3::uuid
                 AND result.payslip_id IS NOT NULL
            )
            AND payslip.status NOT IN ('issued', 'viewed', 'downloaded')`,
        tid, Number(existing.id), previousAttemptToken,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payroll_run_staff_results
            SET superseded_at = clock_timestamp(),
                superseded_by_attempt_token = $4::uuid,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid
            AND payroll_run_id = $2
            AND attempt_token = $3::uuid
            AND superseded_at IS NULL`,
        tid, Number(existing.id), previousAttemptToken, attemptToken,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payroll_run_attempts
            SET status = 'superseded', superseded_at = clock_timestamp(),
                superseded_by_attempt_token = $4::uuid,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid
            AND payroll_run_id = $2
            AND attempt_token = $3::uuid
            AND status <> 'superseded'`,
        tid, Number(existing.id), previousAttemptToken, attemptToken,
      );
    }

    const runRows = existing
      ? await tx.$queryRawUnsafe(
        `UPDATE payroll_runs
            SET status = 'processing',
                generated_by = COALESCE($4::uuid, generated_by),
                generated_at = $5::timestamptz,
                attempt_token = $6::uuid,
                total_staff = 0, total_gross = 0, total_net = 0,
                total_deductions = 0, employee_count = 0,
                failed_staff_count = 0, failed_staff = '[]'::jsonb,
                result_manifest_hash = NULL, document_manifest_hash = NULL,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND month = $2 AND year = $3
          RETURNING id, generated_at, attempt_token`,
        tid, month, year, generatedBy, attemptStartedAt, attemptToken,
      )
      : await tx.$queryRawUnsafe(
        `INSERT INTO payroll_runs
           (tenant_id, month, year, status, generated_by, generated_at,
            attempt_token, failed_staff_count, failed_staff, updated_at)
         VALUES ($1::uuid, $2, $3, 'processing', $4::uuid, $5::timestamptz,
                 $6::uuid, 0, '[]'::jsonb, clock_timestamp())
         RETURNING id, generated_at, attempt_token`,
        tid, month, year, generatedBy, attemptStartedAt, attemptToken,
      );
    if (runRows.length !== 1) throw new Error(`Unable to prepare payroll run for ${month}/${year}`);
    const runId = Number(runRows[0].id);

    await tx.$executeRawUnsafe(
      `INSERT INTO payroll_run_attempts
         (tenant_id, payroll_run_id, attempt_token, started_at, status)
       VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, 'processing')`,
      tid, runId, attemptToken, attemptStartedAt,
    );

    const staff = await tx.$queryRawUnsafe(
      `SELECT u.uid AS staff_uid, u.name, u.role, u.email,
              COALESCE(directory.department, salary.department) AS department
         FROM users AS u
         JOIN staff_salary AS salary
           ON salary.tenant_id = u.tenant_id
          AND salary.staff_uid = u.uid
         LEFT JOIN staff AS directory
           ON directory.tenant_id = u.tenant_id
          AND directory.user_id = u.uid
        WHERE u.tenant_id = $1::uuid
          AND u.is_active = true
          AND salary.is_active = true
        ORDER BY u.uid`,
      tid,
    );
    const staffUids = staff.map(row => String(row.staff_uid));
    if (new Set(staffUids).size !== staffUids.length) {
      throw payrollStaffIdentityAmbiguous(
        `Payroll staff enumeration returned duplicate tenant-user identities for tenant ${tid}`,
      );
    }

    if (staffUids.length > 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO payroll_run_staff_results
           (tenant_id, payroll_run_id, attempt_token, staff_uid, outcome)
         SELECT $1::uuid, $2, $3::uuid, staff_uid, 'pending'
           FROM unnest($4::uuid[]) AS staff_uid`,
        tid, runId, attemptToken, staffUids,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE payroll_run_attempts
          SET expected_staff_count = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid`,
      tid, runId, attemptToken, staffUids.length,
    );
    await tx.$executeRawUnsafe(
      `UPDATE payroll_runs
          SET employee_count = $4, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2 AND attempt_token = $3::uuid`,
      tid, runId, attemptToken, staffUids.length,
    );

    return {
      id: runId,
      status: 'processing',
      skipped: false,
      attempt_started_at: runRows[0].generated_at,
      attempt_token: runRows[0].attempt_token,
      staff,
    };
  }, {
    isolationLevel: 'Serializable',
    maxWait: 10000,
    timeout: 30000,
  });
}

export async function heartbeatPayrollRunAttempt({
  tenantId,
  payrollRunId,
  attemptStartedAt,
  attemptToken,
}) {
  const tid = requireTenantId(tenantId);
  const attempt = requireAttemptStartedAt(attemptStartedAt);
  const token = requireAttemptToken(attemptToken);
  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `UPDATE payroll_runs
        SET updated_at = clock_timestamp()
      WHERE tenant_id = $1::uuid
        AND id = $2
        AND generated_at = $3::timestamptz
        AND attempt_token = $4::uuid
        AND status = 'processing'
        AND hr_approved_at IS NULL
        AND admin_approved_at IS NULL
      RETURNING id`,
    tid,
    Number(payrollRunId),
    attempt,
    token,
  ), {
    maxWait: 10000,
    timeout: 30000,
  });
  if (rows.length !== 1) throw payrollRunAttemptLost(payrollRunId);
  return rows[0];
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

async function computePayrollAttemptManifests(tx, tenantId, payrollRunId, attemptToken) {
  const results = await tx.$queryRawUnsafe(
    `SELECT staff_uid, outcome, payslip_id, payslip_document_revision,
            gross_salary, net_salary, total_deductions, failure_reason
       FROM payroll_run_staff_results
      WHERE tenant_id = $1::uuid AND payroll_run_id = $2
        AND attempt_token = $3::uuid AND superseded_at IS NULL
      ORDER BY staff_uid`,
    tenantId, Number(payrollRunId), attemptToken,
  );
  const documents = await tx.$queryRawUnsafe(
    `SELECT document.id, document.object_token, document.staff_uid,
            document.payslip_id, document.payslip_revision, document.version,
            document.object_key, document.content_sha256,
            document.notification_outbox_id
       FROM payslip_documents AS document
       JOIN payroll_run_staff_results AS result
         ON result.tenant_id = document.tenant_id
        AND result.payroll_run_id = document.payroll_run_id
        AND result.attempt_token = document.attempt_token
        AND result.staff_uid = document.staff_uid
        AND result.payslip_id = document.payslip_id
        AND result.payslip_document_revision = document.payslip_revision
        AND result.outcome = 'succeeded'
        AND result.superseded_at IS NULL
      WHERE document.tenant_id = $1::uuid
        AND document.payroll_run_id = $2
        AND document.attempt_token = $3::uuid
        AND document.status IN ('delivery_queued', 'notification_accepted')
      ORDER BY document.staff_uid`,
    tenantId, Number(payrollRunId), attemptToken,
  );
  const succeededCount = results.filter(row => row.outcome === 'succeeded').length;
  if (documents.length !== succeededCount) {
    throw new Error(`Payroll run ${payrollRunId} does not have one current delivery document per success`);
  }
  const normalizedResults = results.map(row => ({
    staff_uid: String(row.staff_uid),
    outcome: row.outcome,
    payslip_id: row.payslip_id == null ? null : Number(row.payslip_id),
    payslip_document_revision: row.payslip_document_revision == null
      ? null
      : Number(row.payslip_document_revision),
    gross_salary: row.gross_salary == null ? null : String(row.gross_salary),
    net_salary: row.net_salary == null ? null : String(row.net_salary),
    total_deductions: row.total_deductions == null ? null : String(row.total_deductions),
    failure_reason: row.failure_reason == null ? null : String(row.failure_reason),
  }));
  const normalizedDocuments = documents.map(row => ({
    id: String(row.id),
    object_token: String(row.object_token),
    staff_uid: String(row.staff_uid),
    payslip_id: Number(row.payslip_id),
    payslip_revision: Number(row.payslip_revision),
    version: Number(row.version),
    object_key: String(row.object_key),
    content_sha256: String(row.content_sha256),
    notification_outbox_id: Number(row.notification_outbox_id),
  }));
  return {
    resultManifestHash: crypto.createHash('sha256')
      .update(JSON.stringify(normalizedResults))
      .digest('hex'),
    documentManifestHash: crypto.createHash('sha256')
      .update(JSON.stringify(normalizedDocuments))
      .digest('hex'),
  };
}

export async function finalizePayrollRun({
  tenantId,
  payrollRunId,
  attemptStartedAt,
  attemptToken,
}) {
  const tid = requireTenantId(tenantId);
  const attempt = requireAttemptStartedAt(attemptStartedAt);
  const token = requireAttemptToken(attemptToken);
  const rows = await setTenantTx(tid, async (tx) => {
    const pending = await tx.$queryRawUnsafe(
      `SELECT staff_uid, outcome
         FROM payroll_run_staff_results
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid
          AND outcome NOT IN ('succeeded', 'failed')
        LIMIT 1`,
      tid, Number(payrollRunId), token,
    );
    if (pending.length > 0) {
      throw new Error(`Payroll run ${payrollRunId} still has non-terminal staff results`);
    }

    const summaries = await tx.$queryRawUnsafe(
      `SELECT count(*) FILTER (WHERE result.outcome = 'succeeded')::integer AS succeeded_count,
              count(*) FILTER (WHERE result.outcome = 'failed')::integer AS failed_count,
              COALESCE(sum(result.gross_salary) FILTER (WHERE result.outcome = 'succeeded'), 0) AS total_gross,
              COALESCE(sum(result.net_salary) FILTER (WHERE result.outcome = 'succeeded'), 0) AS total_net,
              COALESCE(sum(result.total_deductions) FILTER (WHERE result.outcome = 'succeeded'), 0) AS total_deductions,
              COALESCE(jsonb_agg(
                jsonb_build_object('staff_uid', result.staff_uid, 'reason', result.failure_reason)
                ORDER BY result.staff_uid
              ) FILTER (WHERE result.outcome = 'failed'), '[]'::jsonb) AS failed_staff
         FROM payroll_run_staff_results AS result
        WHERE result.tenant_id = $1::uuid
          AND result.payroll_run_id = $2
          AND result.attempt_token = $3::uuid
          AND result.superseded_at IS NULL`,
      tid, Number(payrollRunId), token,
    );
    const summary = summaries[0];
    const failedCount = Number(summary.failed_count || 0);
    const terminalCount = Number(summary.succeeded_count || 0) + failedCount;
    const attemptRows = await tx.$queryRawUnsafe(
      `SELECT expected_staff_count
         FROM payroll_run_attempts
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid
        FOR UPDATE`,
      tid, Number(payrollRunId), token,
    );
    if (attemptRows.length !== 1
        || terminalCount !== Number(attemptRows[0].expected_staff_count)) {
      throw new Error(`Payroll run ${payrollRunId} result count does not match its frozen staff cohort`);
    }
    const status = failedCount === 0 ? 'completed' : 'completed_with_errors';
    const manifests = await computePayrollAttemptManifests(tx, tid, payrollRunId, token);

    const updatedAttempts = await tx.$queryRawUnsafe(
      `UPDATE payroll_run_attempts
          SET status = $4::text,
              succeeded_staff_count = $5,
              failed_staff_count = $6,
              finalized_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND status = 'processing'
        RETURNING payroll_run_id`,
      tid, Number(payrollRunId), token, status,
      Number(summary.succeeded_count || 0), failedCount,
    );
    if (updatedAttempts.length !== 1) throw payrollRunAttemptLost(payrollRunId);

    return tx.$queryRawUnsafe(
      `UPDATE payroll_runs
          SET status = $5,
              total_staff = $6,
              total_gross = $7,
              total_net = $8,
              total_deductions = $9,
              failed_staff_count = $10,
              failed_staff = $11::jsonb,
              result_manifest_hash = $12::char(64),
              document_manifest_hash = $13::char(64),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND id = $2
          AND generated_at = $3::timestamptz
          AND attempt_token = $4::uuid
          AND status = 'processing'
          AND hr_approved_at IS NULL
          AND admin_approved_at IS NULL
        RETURNING id, status, total_staff, failed_staff_count,
                  total_gross, total_net, total_deductions`,
      tid, Number(payrollRunId), attempt, token, status,
      Number(summary.succeeded_count || 0), summary.total_gross,
      summary.total_net, summary.total_deductions, failedCount,
      JSON.stringify(summary.failed_staff || []),
      manifests.resultManifestHash, manifests.documentManifestHash,
    );
  }, {
    maxWait: 10000,
    timeout: 30000,
  });
  if (rows.length !== 1) throw payrollRunAttemptLost(payrollRunId);
  return rows[0];
}

const PAYROLL_RUN_SIGNATURE_COLUMNS = `
  id, month, year, status, total_staff, total_gross, total_net,
  total_deductions, generated_by, generated_at, employee_count,
  hr_approved_by, hr_approved_at, hr_comment, admin_approved_by,
  admin_approved_at, admin_comment, approval_hash, notes, created_at,
  updated_at, attempt_token, result_manifest_hash, document_manifest_hash`;
const PAYROLL_RUN_SIGNATURE_READ_COLUMNS = `${PAYROLL_RUN_SIGNATURE_COLUMNS},
  failed_staff_count, failed_staff`;

function payrollRunNeedsFailureAck(run) {
  return run.status === 'completed_with_errors' || Number(run.failed_staff_count || 0) > 0;
}

/**
 * Apply one payroll signature while holding the run row lock used by generation
 * and rerun claims. The controller maps the returned reason to its existing HTTP
 * contract; no caller can split the state check from the signature write.
 */
export async function signPayrollRun({
  tenantId,
  payrollRunId,
  signature,
  signerUid,
  comment = null,
  acknowledgeFailedPayslips = false,
}) {
  const tid = requireTenantId(tenantId);
  const runId = Number(payrollRunId);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('payrollRunId must be a positive integer');
  if (signature !== 'hr' && signature !== 'admin') throw new Error('signature must be hr or admin');

  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${PAYROLL_RUN_SIGNATURE_READ_COLUMNS}
         FROM payroll_runs
        WHERE tenant_id = $1::uuid AND id = $2
        FOR UPDATE`,
      tid,
      runId,
    );
    if (rows.length === 0) return { ok: false, reason: 'not_found' };

    const signerRows = await tx.$queryRawUnsafe(
      `SELECT role
         FROM users
        WHERE tenant_id = $1::uuid AND uid = $2::uuid AND is_active = true`,
      tid, signerUid,
    );
    const signerRole = String(signerRows[0]?.role || '').trim().toUpperCase();
    if (signature === 'hr' && signerRole !== 'HR_STAFF') {
      return { ok: false, reason: 'role_required', required_role: 'HR_STAFF' };
    }
    if (signature === 'admin' && !['ADMIN', 'SUPER_ADMIN'].includes(signerRole)) {
      return { ok: false, reason: 'role_required', required_role: 'ADMIN' };
    }

    const run = rows[0];
    if (run.status !== 'completed' && run.status !== 'completed_with_errors') {
      return { ok: false, reason: 'invalid_status', run };
    }
    const manifests = await computePayrollAttemptManifests(tx, tid, runId, run.attempt_token);
    if (run.result_manifest_hash !== manifests.resultManifestHash
        || run.document_manifest_hash !== manifests.documentManifestHash) {
      return { ok: false, reason: 'manifest_changed', run };
    }

    if (signature === 'hr') {
      if (run.hr_approved_at != null) return { ok: false, reason: 'already_signed', run };
      if (run.admin_approved_at != null) return { ok: false, reason: 'invalid_status', run };
      const ackRequired = payrollRunNeedsFailureAck(run);
      if (ackRequired && acknowledgeFailedPayslips !== true) {
        return { ok: false, reason: 'ack_required', run, ackRequired };
      }

      const updated = await tx.$queryRawUnsafe(
        `UPDATE payroll_runs
            SET hr_approved_by = $3::uuid,
                hr_approved_at = clock_timestamp(),
                hr_comment = $4,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid
            AND id = $2
            AND status IN ('completed', 'completed_with_errors')
            AND hr_approved_at IS NULL
            AND admin_approved_at IS NULL
          RETURNING ${PAYROLL_RUN_SIGNATURE_COLUMNS}`,
        tid,
        runId,
        signerUid,
        comment || null,
      );
      if (updated.length !== 1) return { ok: false, reason: 'state_changed', run };
      return { ok: true, run: updated[0], ackRun: run, ackRequired };
    }

    if (run.hr_approved_at == null) return { ok: false, reason: 'hr_required', run };
    if (run.admin_approved_at != null) return { ok: false, reason: 'already_signed', run };
    if (run.hr_approved_by === signerUid) return { ok: false, reason: 'same_signer', run };
    const ackRequired = payrollRunNeedsFailureAck(run);
    if (ackRequired && acknowledgeFailedPayslips !== true) {
      return { ok: false, reason: 'ack_required', run, ackRequired };
    }

    const hash = crypto
      .createHash('sha256')
      .update([
        runId, run.month, run.year, run.total_gross, run.total_net,
        run.total_deductions, run.hr_approved_by, signerUid,
        manifests.resultManifestHash, manifests.documentManifestHash,
      ].join(':'))
      .digest('hex');
    const updated = await tx.$queryRawUnsafe(
      `UPDATE payroll_runs
          SET admin_approved_by = $3::uuid,
              admin_approved_at = clock_timestamp(),
              admin_comment = $4,
              approval_hash = $5,
              status = 'approved',
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND id = $2
          AND status IN ('completed', 'completed_with_errors')
          AND hr_approved_at IS NOT NULL
          AND admin_approved_at IS NULL
        RETURNING ${PAYROLL_RUN_SIGNATURE_COLUMNS}`,
      tid,
      runId,
      signerUid,
      comment || null,
      hash,
    );
    if (updated.length !== 1) return { ok: false, reason: 'state_changed', run };
    return { ok: true, run: updated[0], ackRun: run, ackRequired };
  }, {
    maxWait: 10000,
    timeout: 30000,
  });
}

// Columns returned by savePayslip — kept separate so the upsert create/update
// branches (and downstream callers like runPayroll) stay consistent.
/**
 * Save payslip to DB (upsert).
 */
async function savePayslipTx(client, payrollRunId, data, tenantId, attemptToken = null) {
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

  const rows = await client.$queryRawUnsafe(
    `WITH input AS (
       SELECT (jsonb_populate_record(NULL::payslips, $6::jsonb)).*
     )
     INSERT INTO payslips (
       tenant_id, payroll_run_id, generation_attempt_token,
       staff_uid, month, year, status,
       total_working_days, days_present, days_absent, days_leave,
       overtime_hours, overtime_rate, basic_earned, hra_earned, da_earned,
       special_allowance_earned, transport_allowance_earned,
       medical_allowance_earned, overtime_pay, arrears_amount, gross_salary,
       pf_employee, esi_employee, professional_tax, tds, total_deductions,
       advance_deduction, lop_days, lop_deduction, net_salary, revision_note
     )
     SELECT $1::uuid, $2::integer, COALESCE($7::uuid, (
              SELECT attempt_token FROM payroll_runs
               WHERE tenant_id = $1::uuid AND id = $2::integer
            )), $3::uuid, $4::integer, $5::integer, 'draft',
       total_working_days, days_present, days_absent, days_leave,
       overtime_hours, overtime_rate, basic_earned, hra_earned, da_earned,
       special_allowance_earned, transport_allowance_earned,
       medical_allowance_earned, overtime_pay, arrears_amount, gross_salary,
       pf_employee, esi_employee, professional_tax, tds, total_deductions,
       advance_deduction, lop_days, lop_deduction, net_salary, revision_note
       FROM input
     ON CONFLICT (tenant_id, staff_uid, month, year)
       WHERE status IS DISTINCT FROM 'superseded'
     DO UPDATE SET
        payroll_run_id = EXCLUDED.payroll_run_id,
        generation_attempt_token = EXCLUDED.generation_attempt_token,
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
        status = 'draft',
        pdf_key = NULL,
        pdf_generated_at = NULL,
        document_revision = payslips.document_revision + 1,
        updated_at = NOW()
      WHERE payslips.status NOT IN ('issued', 'viewed', 'downloaded')
     RETURNING id, payroll_run_id, generation_attempt_token, document_revision,
       staff_uid, month, year,
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
     attemptToken == null ? null : requireAttemptToken(attemptToken),
  );
  if (rows.length !== 1) {
    throw new Error(`Payslip for staff ${data.staff_uid} is no longer editable`);
  }
  return rows[0];
}

export async function savePayslip(payrollRunId, data, tenantId) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, (tx) => savePayslipTx(tx, payrollRunId, data, tid), {
    maxWait: 10000,
    timeout: 30000,
  });
}

/**
 * Generate one staff member's payslip and apply every related money effect in
 * one tenant-scoped transaction. The staff_salary row lock in
 * calculatePayslipTx serializes retries from the manual and scheduled paths.
 */
export async function generatePayslipForStaff({
  tenantId,
  payrollRunId,
  attemptStartedAt,
  attemptToken,
  staffUid,
  month,
  year,
}) {
  const tid = requireTenantId(tenantId);
  const runId = Number(payrollRunId);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('payrollRunId must be a positive integer');
  const attempt = requireAttemptStartedAt(attemptStartedAt);
  const token = requireAttemptToken(attemptToken);

  return setTenantTx(tid, async (tx) => {
    // The heartbeat is also the attempt CAS and run-row lock. It makes every
    // staff transaction contend with rerun claims and signatures before any
    // financial state is read or written.
    const payrollRuns = await tx.$queryRawUnsafe(
      `UPDATE payroll_runs
          SET updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid
          AND id = $2
          AND month = $3
          AND year = $4
          AND generated_at = $5::timestamptz
          AND attempt_token = $6::uuid
          AND status = 'processing'
          AND hr_approved_at IS NULL
          AND admin_approved_at IS NULL
        RETURNING id, status, hr_approved_at, admin_approved_at`,
      tid,
      runId,
      month,
      year,
      attempt,
      token,
    );
    if (payrollRuns.length === 0) {
      throw payrollRunAttemptLost(runId);
    }

    const ownedResults = await tx.$queryRawUnsafe(
      `SELECT result.outcome, result.payslip_id, result.finance_effects,
              payslip.id, payslip.payroll_run_id, payslip.generation_attempt_token,
              payslip.document_revision, payslip.staff_uid, payslip.month, payslip.year,
              payslip.total_working_days, payslip.days_present, payslip.days_absent,
              payslip.days_leave, payslip.overtime_hours, payslip.overtime_rate,
              payslip.basic_earned, payslip.hra_earned, payslip.da_earned,
              payslip.special_allowance_earned, payslip.transport_allowance_earned,
              payslip.medical_allowance_earned, payslip.overtime_pay,
              payslip.bonus_this_month, payslip.arrears_amount, payslip.gross_salary,
              payslip.pf_employee, payslip.esi_employee, payslip.professional_tax,
              payslip.tds, payslip.other_deductions, payslip.total_deductions,
              payslip.advance_deduction, payslip.lop_days, payslip.lop_deduction,
              payslip.net_salary, payslip.revision_note, payslip.status,
              jsonb_build_object(
                'employee_id', salary.employee_id,
                'designation', salary.designation,
                'department', salary.department,
                'date_of_joining', salary.date_of_joining,
                'pf_uan', salary.pf_uan,
                'pan_number', salary.pan_number,
                'bank_account', salary.bank_account,
                'bank_name', salary.bank_name
              ) AS salary_config
         FROM payroll_run_staff_results AS result
         LEFT JOIN payslips AS payslip
           ON payslip.tenant_id = result.tenant_id
          AND payslip.id = result.payslip_id
         LEFT JOIN staff_salary AS salary
           ON salary.tenant_id = result.tenant_id
          AND salary.staff_uid = result.staff_uid
        WHERE result.tenant_id = $1::uuid AND result.payroll_run_id = $2
          AND result.attempt_token = $3::uuid AND result.staff_uid = $4::uuid
          AND result.superseded_at IS NULL
        FOR UPDATE OF result`,
      tid, runId, token, staffUid,
    );
    if (ownedResults.length !== 1) {
      throw new Error(`No payroll result belongs to staff ${staffUid} in this attempt`);
    }
    const ownedResult = ownedResults[0];
    if (ownedResult.outcome === 'calculated' || ownedResult.outcome === 'succeeded') {
      const { outcome: _outcome, payslip_id: _payslipId, ...persistedPayslip } = ownedResult;
      const savedPayslip = normalizePersistedPayslip(persistedPayslip);
      return {
        calculation: savedPayslip,
        payslip: savedPayslip,
        effects: { advances_applied: 0, advances_reused: 0, arrears_closed: 0 },
        resumed: true,
      };
    }
    if (ownedResult.outcome !== 'pending') {
      throw new Error(`Payroll result for staff ${staffUid} is already ${ownedResult.outcome}`);
    }
    await tx.$executeRawUnsafe(
      `UPDATE payroll_run_staff_results
          SET started_at = COALESCE(started_at, clock_timestamp()),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND staff_uid = $4::uuid
          AND outcome = 'pending' AND superseded_at IS NULL`,
      tid, runId, token, staffUid,
    );

    const calculation = await calculatePayslipTx(tx, staffUid, month, year, tid);
    const payslip = await savePayslipTx(tx, runId, calculation, tid, token);
    const financeEffects = {
      advances: calculation._advances_to_process.map(advance => ({
        id: Number(advance.id),
        amount: Number(advance.amount),
        balance_after: Number(advance.balanceAfter),
      })),
      arrears: calculation._arrears_to_process.map(arrear => ({
        id: Number(arrear.id),
        amount: Number(arrear.amount),
      })),
    };

    const finalizedResults = await tx.$queryRawUnsafe(
      `UPDATE payroll_run_staff_results
          SET outcome = 'calculated', payslip_id = $5,
              payslip_document_revision = $9,
              gross_salary = $6::numeric, net_salary = $7::numeric,
              total_deductions = $8::numeric, finance_effects = $10::jsonb,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND staff_uid = $4::uuid
          AND outcome = 'pending' AND superseded_at IS NULL
        RETURNING staff_uid`,
      tid, runId, token, staffUid, Number(payslip.id),
      calculation.gross_salary, calculation.net_salary, calculation.total_deductions,
      Number(payslip.document_revision), JSON.stringify(financeEffects),
    );
    if (finalizedResults.length !== 1) {
      throw new Error(`Payroll result changed before success was recorded for staff ${staffUid}`);
    }

    return {
      calculation,
      payslip,
      effects: {
        advances_planned: financeEffects.advances.length,
        arrears_planned: financeEffects.arrears.length,
      },
    };
  }, {
    maxWait: 10000,
    timeout: 30000,
  });
}

export async function recordPayrollStaffFailure({
  tenantId,
  payrollRunId,
  attemptStartedAt,
  attemptToken,
  staffUid,
  error: staffError,
}) {
  const tid = requireTenantId(tenantId);
  const runId = Number(payrollRunId);
  const attempt = requireAttemptStartedAt(attemptStartedAt);
  const token = requireAttemptToken(attemptToken);
  const reason = String(staffError?.message || staffError || 'Unknown error').slice(0, FAILURE_REASON_MAX);
  const rows = await setTenantTx(tid, async (tx) => {
    const owned = await tx.$queryRawUnsafe(
      `UPDATE payroll_runs
          SET updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2
          AND generated_at = $3::timestamptz AND attempt_token = $4::uuid
          AND status = 'processing' AND hr_approved_at IS NULL
          AND admin_approved_at IS NULL
        RETURNING id`,
      tid, runId, attempt, token,
    );
    if (owned.length !== 1) throw payrollRunAttemptLost(runId);

    const results = await tx.$queryRawUnsafe(
      `SELECT outcome, payslip_id
         FROM payroll_run_staff_results
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND staff_uid = $4::uuid
          AND superseded_at IS NULL
        FOR UPDATE`,
      tid, runId, token, staffUid,
    );
    if (results.length !== 1) return [];
    if (results[0].outcome === 'succeeded' || results[0].outcome === 'failed') {
      return [{ staff_uid: staffUid, outcome: results[0].outcome }];
    }

    const noticeRows = await tx.$queryRawUnsafe(
      `SELECT outbox.id, outbox.status
         FROM payslip_documents AS document
         JOIN notification_outbox AS outbox
           ON outbox.tenant_id = document.tenant_id
          AND outbox.id = document.notification_outbox_id
        WHERE document.tenant_id = $1::uuid
          AND document.payroll_run_id = $2
          AND document.attempt_token = $3::uuid
          AND document.staff_uid = $4::uuid
        FOR UPDATE OF outbox`,
      tid, runId, token, staffUid,
    );
    const unsafeNotice = noticeRows.find(row => !['PENDING', 'FAILED'].includes(row.status));
    if (unsafeNotice) {
      const reconciliationError = new Error(
        `Payroll failure recovery requires notification reconciliation for outbox ${unsafeNotice.id}`,
      );
      reconciliationError.code = 'PAYSLIP_DOCUMENT_RECONCILIATION_REQUIRED';
      throw reconciliationError;
    }
    const suppressedNoticeCount = await tx.$executeRawUnsafe(
      `UPDATE notification_outbox AS outbox
          SET status = 'SUPPRESSED', failure_reason = 'payroll_staff_result_failed',
              last_attempt_at = clock_timestamp()
         FROM payslip_documents AS document
        WHERE document.tenant_id = $1::uuid
          AND document.payroll_run_id = $2
          AND document.attempt_token = $3::uuid
          AND document.staff_uid = $4::uuid
          AND outbox.tenant_id = document.tenant_id
          AND outbox.id = document.notification_outbox_id
          AND outbox.status IN ('PENDING', 'FAILED')`,
      tid, runId, token, staffUid,
    );
    if (Number(suppressedNoticeCount) !== noticeRows.length) {
      throw payslipDocumentReconciliationRequired(
        'Payroll failure recovery could not suppress every locked staff notification',
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE payslip_documents
          SET status = 'superseded', superseded_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND staff_uid = $4::uuid
          AND status <> 'superseded'`,
      tid, runId, token, staffUid,
    );
    if (results[0].payslip_id != null) {
      await tx.$executeRawUnsafe(
        `UPDATE payslips
            SET status = 'superseded', pdf_key = NULL, pdf_generated_at = NULL,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2
            AND payroll_run_id = $3 AND generation_attempt_token = $4::uuid
            AND status NOT IN ('issued', 'viewed', 'downloaded')`,
        tid, Number(results[0].payslip_id), runId, token,
      );
    }
    return tx.$queryRawUnsafe(
      `UPDATE payroll_run_staff_results
          SET outcome = 'failed', failure_reason = $5,
              payslip_id = NULL, payslip_document_revision = NULL,
              finance_effects = NULL,
              gross_salary = NULL, net_salary = NULL, total_deductions = NULL,
              finalized_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND staff_uid = $4::uuid
          AND outcome IN ('pending', 'calculated') AND superseded_at IS NULL
        RETURNING staff_uid, outcome`,
      tid, runId, token, staffUid, reason,
    );
  });
  if (rows.length !== 1) {
    throw new Error(`No current payroll result belongs to staff ${staffUid} in this attempt`);
  }
  return rows[0];
}

function payslipDocumentObjectKey({ tenantId, year, month, payslipId, revision, version, documentId }) {
  return [
    'payroll', tenantId, String(year), String(month).padStart(2, '0'),
    String(payslipId), `r${revision}`, `v${version}-${documentId}.pdf`,
  ].join('/');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function encryptPayslipCredential(tenantId, password) {
  await loadTenantKekIntoProvider(tenantId);
  const ciphertext = encryptField(password, { tenantId });
  if (getKeyId(ciphertext) !== tenantKeyId(tenantId)) {
    throw new Error(`Tenant KEK is not active for payroll document encryption (${tenantId})`);
  }
  return ciphertext;
}

function payslipDocumentReconciliationRequired(message, cause = null) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = 'PAYSLIP_DOCUMENT_RECONCILIATION_REQUIRED';
  return err;
}

function payslipDocumentInProgress(message) {
  const err = new Error(message);
  err.code = 'PAYSLIP_DOCUMENT_IN_PROGRESS';
  return err;
}

function normalizeFinanceEffects(value) {
  const effects = typeof value === 'string' ? JSON.parse(value) : value;
  if (!effects || typeof effects !== 'object'
      || !Array.isArray(effects.advances) || !Array.isArray(effects.arrears)) {
    throw new Error('Payroll finance effect plan is missing or invalid');
  }
  const advances = effects.advances.map((advance) => ({
    id: Number(advance.id),
    amount: Number(advance.amount),
    balanceAfter: Number(advance.balance_after),
  }));
  const arrears = effects.arrears.map((arrear) => ({
    id: Number(arrear.id),
    amount: Number(arrear.amount),
  }));
  if (advances.some(advance => !Number.isInteger(advance.id) || advance.id <= 0
      || !Number.isFinite(advance.amount) || advance.amount <= 0
      || !Number.isFinite(advance.balanceAfter) || advance.balanceAfter < 0)
      || arrears.some(arrear => !Number.isInteger(arrear.id) || arrear.id <= 0
        || !Number.isFinite(arrear.amount) || arrear.amount <= 0)
      || new Set(advances.map(advance => advance.id)).size !== advances.length
      || new Set(arrears.map(arrear => arrear.id)).size !== arrears.length) {
    throw new Error('Payroll finance effect plan contains invalid or duplicate identities');
  }
  return { advances, arrears };
}

function sameMoney(left, right) {
  return Math.round(Number(left) * 100) === Math.round(Number(right) * 100);
}

async function applyPayrollFinanceEffectsTx(tx, {
  tenantId,
  staffUid,
  payslipId,
  month,
  year,
  financeEffects,
  expectedAdvanceDeduction,
  expectedArrearsAmount,
}) {
  const plan = normalizeFinanceEffects(financeEffects);
  const plannedAdvanceTotal = plan.advances.reduce((sum, row) => sum + row.amount, 0);
  const plannedArrearsTotal = plan.arrears.reduce((sum, row) => sum + row.amount, 0);
  if (!sameMoney(plannedAdvanceTotal, expectedAdvanceDeduction)
      || !sameMoney(plannedArrearsTotal, expectedArrearsAmount)) {
    throw new Error(`Payroll finance effect plan no longer matches payslip ${payslipId}`);
  }

  let advancesApplied = 0;
  let advancesReused = 0;
  for (const planned of plan.advances) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT advance.id, advance.amount, advance.total_deducted,
              advance.months_remaining, advance.status,
              deduction.id AS deduction_id,
              deduction.payslip_id AS deduction_payslip_id,
              deduction.amount_deducted, deduction.balance_after
         FROM salary_advances AS advance
         LEFT JOIN advance_deductions AS deduction
           ON deduction.tenant_id = advance.tenant_id
          AND deduction.advance_id = advance.id
          AND deduction.staff_uid = $3::uuid
          AND deduction.month = $4
          AND deduction.year = $5
        WHERE advance.tenant_id = $1::uuid AND advance.id = $2
          AND advance.staff_uid = $3::uuid
        FOR UPDATE OF advance`,
      tenantId, planned.id, staffUid, month, year,
    );
    if (rows.length !== 1) {
      throw new Error(`Salary advance ${planned.id} is missing or has an ambiguous deduction ledger`);
    }
    const advance = rows[0];
    if (advance.deduction_id != null) {
      if (Number(advance.deduction_payslip_id) !== payslipId
          || !sameMoney(advance.amount_deducted, planned.amount)
          || !sameMoney(advance.balance_after, planned.balanceAfter)) {
        throw new Error(`Salary advance ${planned.id} was applied to a different payroll identity`);
      }
      advancesReused += 1;
      continue;
    }

    const expectedBalance = Number(advance.amount) - Number(advance.total_deducted || 0)
      - planned.amount;
    if (advance.status !== 'approved' || expectedBalance < 0
        || !sameMoney(expectedBalance, planned.balanceAfter)) {
      throw new Error(`Salary advance ${planned.id} changed before document delivery`);
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE salary_advances
          SET total_deducted = COALESCE(total_deducted, 0) + $4::numeric,
              months_remaining = GREATEST(COALESCE(months_remaining, 0) - 1, 0),
              status = CASE
                WHEN COALESCE(total_deducted, 0) + $4::numeric >= amount THEN 'cleared'
                ELSE status
              END,
              fully_cleared_at = CASE
                WHEN COALESCE(total_deducted, 0) + $4::numeric >= amount
                  THEN COALESCE(fully_cleared_at, clock_timestamp())
                ELSE fully_cleared_at
              END,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2 AND staff_uid = $3::uuid
          AND status = 'approved'
        RETURNING amount - total_deducted AS balance_after`,
      tenantId, planned.id, staffUid, planned.amount,
    );
    if (updated.length !== 1 || !sameMoney(updated[0].balance_after, planned.balanceAfter)) {
      throw new Error(`Salary advance ${planned.id} changed before payroll deduction`);
    }
    const deduction = await tx.$queryRawUnsafe(
      `INSERT INTO advance_deductions
         (tenant_id, advance_id, payslip_id, staff_uid, month, year,
          amount_deducted, balance_after)
       SELECT $1::uuid, $2, $3, $4::uuid, $5, $6, $7::numeric, $8::numeric
        WHERE NOT EXISTS (
          SELECT 1 FROM advance_deductions
           WHERE tenant_id = $1::uuid AND advance_id = $2
             AND staff_uid = $4::uuid AND month = $5 AND year = $6
        )
       RETURNING id`,
      tenantId, planned.id, payslipId, staffUid, month, year,
      planned.amount, planned.balanceAfter,
    );
    if (deduction.length !== 1) {
      throw new Error(`Salary advance ${planned.id} already has a deduction for ${month}/${year}`);
    }
    advancesApplied += 1;
  }

  let arrearsClosed = 0;
  let arrearsReused = 0;
  if (plan.arrears.length > 0) {
    const arrearIds = plan.arrears.map(row => row.id);
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, arrears_amount, status, payslip_id
         FROM salary_arrears
        WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
          AND id = ANY($3::integer[])
        ORDER BY id
        FOR UPDATE`,
      tenantId, staffUid, arrearIds,
    );
    if (rows.length !== plan.arrears.length) {
      throw new Error(`Salary arrears changed before document delivery for staff ${staffUid}`);
    }
    const plannedById = new Map(plan.arrears.map(row => [row.id, row]));
    const pendingIds = [];
    for (const row of rows) {
      const planned = plannedById.get(Number(row.id));
      if (!planned || !sameMoney(row.arrears_amount, planned.amount)) {
        throw new Error(`Salary arrears ${row.id} changed before document delivery`);
      }
      if (row.status === 'paid' && Number(row.payslip_id) === payslipId) {
        arrearsReused += 1;
      } else if (row.status === 'pending' && row.payslip_id == null) {
        pendingIds.push(Number(row.id));
      } else {
        throw new Error(`Salary arrears ${row.id} belongs to another payroll identity`);
      }
    }
    if (pendingIds.length > 0) {
      const closed = await tx.$queryRawUnsafe(
        `UPDATE salary_arrears
            SET status = 'paid', paid_in_month = $4, paid_in_year = $5,
                payslip_id = $6
          WHERE tenant_id = $1::uuid AND staff_uid = $2::uuid
            AND id = ANY($3::integer[]) AND status = 'pending'
            AND payslip_id IS NULL
          RETURNING id`,
        tenantId, staffUid, pendingIds, month, year, payslipId,
      );
      if (closed.length !== pendingIds.length) {
        throw new Error(`Salary arrears changed during closure for staff ${staffUid}`);
      }
      arrearsClosed = closed.length;
    }
  }
  return { advancesApplied, advancesReused, arrearsClosed, arrearsReused };
}

/**
 * Prepare one immutable PDF and persist a non-secret in-app notice.  The
 * password stays encrypted in payslip_documents and is revealed only through
 * the authenticated owner path after issue.  A retry reuses the same prepared
 * bytes/credential identity and never overwrites an object key.
 */
export async function ensurePayslipDocumentReady({
  tenantId,
  payrollRunId,
  attemptToken,
  staffUid,
  calculation,
  payslip,
  staff,
  generatePdf = generatePayslipPDF,
  upload = uploadFileToR2,
  read = getFileFromR2,
}) {
  const tid = requireTenantId(tenantId);
  const runId = Number(payrollRunId);
  const token = requireAttemptToken(attemptToken);
  const payslipId = Number(payslip?.id);
  const revision = Number(payslip?.document_revision || 1);
  if (!Number.isInteger(payslipId) || payslipId <= 0) throw new Error('payslip.id is required');
  if (!Number.isInteger(revision) || revision <= 0) throw new Error('payslip.document_revision is invalid');

  let prepared = await setTenantTx(tid, async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, object_token, version, object_key, credential_ciphertext, content_sha256,
              status, uploaded_at, storage_verified_at, notification_outbox_id
         FROM payslip_documents
        WHERE tenant_id = $1::uuid AND payslip_id = $2
          AND payslip_revision = $3
          AND status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted')
        FOR UPDATE`,
      tid, payslipId, revision,
    );
    if (existing.length > 0) return existing[0];

    const result = await tx.$queryRawUnsafe(
      `SELECT result.staff_uid, payslip.month, payslip.year,
              payslip.payroll_run_id, payslip.generation_attempt_token
         FROM payroll_run_staff_results AS result
         JOIN payslips AS payslip
           ON payslip.tenant_id = result.tenant_id
          AND payslip.id = result.payslip_id
        WHERE result.tenant_id = $1::uuid
          AND result.payroll_run_id = $2
          AND result.attempt_token = $3::uuid
          AND result.staff_uid = $4::uuid
          AND result.outcome = 'calculated'
          AND result.superseded_at IS NULL
          AND payslip.id = $5
          AND payslip.generation_attempt_token = $3::uuid
          AND payslip.document_revision = $6
        FOR UPDATE OF result, payslip`,
      tid, runId, token, staffUid, payslipId, revision,
    );
    if (result.length !== 1) throw payrollRunAttemptLost(runId);
    return null;
  });

  if (!prepared) {
    if (typeof generatePdf !== 'function') throw new Error('Payslip PDF generation is unavailable');
    let generatedDocument;
    try {
      generatedDocument = await generatePdf(calculation, staff);
    } catch (cause) {
      const err = new Error('Payslip PDF generation failed', { cause });
      err.code = 'PAYSLIP_PDF_GENERATION_FAILED';
      throw err;
    }
    const { buffer, userPassword } = generatedDocument;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Payslip PDF generator returned no bytes');
    const credentialCiphertext = await encryptPayslipCredential(tid, userPassword);
    const documentToken = crypto.randomUUID();
    prepared = await setTenantTx(tid, async (tx) => {
      const ownsAttempt = await tx.$queryRawUnsafe(
        `SELECT 1
           FROM payroll_runs AS run
           JOIN payroll_run_staff_results AS result
             ON result.tenant_id = run.tenant_id
            AND result.payroll_run_id = run.id
            AND result.attempt_token = run.attempt_token
           JOIN payslips AS payslip
             ON payslip.tenant_id = result.tenant_id
            AND payslip.id = result.payslip_id
          WHERE run.tenant_id = $1::uuid AND run.id = $2
            AND run.attempt_token = $3::uuid AND run.status = 'processing'
            AND result.staff_uid = $4::uuid AND result.outcome = 'calculated'
            AND result.superseded_at IS NULL AND payslip.id = $5
            AND payslip.generation_attempt_token = $3::uuid
            AND payslip.document_revision = $6
          FOR UPDATE OF run, result, payslip`,
        tid, runId, token, staffUid, payslipId, revision,
      );
      if (ownsAttempt.length !== 1) throw payrollRunAttemptLost(runId);
      const versionRows = await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM payslip_documents
          WHERE tenant_id = $1::uuid AND payslip_id = $2`,
        tid, payslipId,
      );
      const version = Number(versionRows[0]?.version || 1);
      const objectKey = payslipDocumentObjectKey({
        tenantId: tid,
        year: payslip.year,
        month: payslip.month,
        payslipId,
        revision,
        version,
        documentId: documentToken,
      });
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO payslip_documents
           (object_token, tenant_id, payslip_id, payroll_run_id, attempt_token,
            staff_uid, payslip_revision, version, object_key, credential_ciphertext,
            content_sha256, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8, $9,
                 $10, $11::char(64), 'prepared')
         ON CONFLICT (tenant_id, payslip_id, payslip_revision)
           WHERE status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted')
         DO NOTHING
         RETURNING id, object_token, version, object_key, credential_ciphertext,
                   content_sha256, status, uploaded_at, storage_verified_at, notification_outbox_id`,
        documentToken, tid, payslipId, runId, token, staffUid, revision, version,
        objectKey, credentialCiphertext, sha256Buffer(buffer),
      );
      if (rows.length > 0) return { ...rows[0], buffer };
      const winner = await tx.$queryRawUnsafe(
        `SELECT id, object_token, version, object_key, credential_ciphertext, content_sha256,
                status, uploaded_at, storage_verified_at, notification_outbox_id
           FROM payslip_documents
          WHERE tenant_id = $1::uuid AND payslip_id = $2
            AND payslip_revision = $3
            AND status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted')`,
        tid, payslipId, revision,
      );
      return winner[0];
    });

    if (prepared.buffer) {
      let existingObject = null;
      try {
        existingObject = Buffer.from(await read(prepared.object_key));
      } catch (err) {
        if (err?.code !== 'NoSuchKey') {
          throw payslipDocumentReconciliationRequired(
            `Cannot prove that immutable payroll object ${prepared.object_key} is absent`,
            err,
          );
        }
      }
      if (existingObject && sha256Buffer(existingObject) !== String(prepared.content_sha256)) {
        throw payslipDocumentReconciliationRequired(
          `Immutable payroll object ${prepared.object_key} already exists with different bytes`,
        );
      }
      if (!existingObject) {
        try {
          await upload(prepared.buffer, prepared.object_key, 'application/pdf');
        } catch (uploadError) {
          try {
            const recovered = Buffer.from(await read(prepared.object_key));
            if (sha256Buffer(recovered) !== String(prepared.content_sha256)) {
              throw payslipDocumentReconciliationRequired(
                `Payroll upload outcome for ${prepared.object_key} has a different content hash`,
                uploadError,
              );
            }
          } catch (readError) {
            if (readError?.code === 'PAYSLIP_DOCUMENT_RECONCILIATION_REQUIRED') throw readError;
            if (readError?.code === 'NoSuchKey') throw uploadError;
            throw payslipDocumentReconciliationRequired(
              `Payroll upload outcome for ${prepared.object_key} is unknown`,
              uploadError,
            );
          }
        }
      }
    }
  }

  if (prepared.status === 'prepared') {
    let remote = null;
    try {
      remote = Buffer.from(await read(prepared.object_key));
    } catch (err) {
      if (err?.code !== 'NoSuchKey') {
        logger.warn('Payslip document storage verification failed:', err.message);
        throw payslipDocumentReconciliationRequired(
          `Payroll storage verification is inconclusive for ${prepared.object_key}`,
          err,
        );
      }
    }
    if (!remote && !prepared.buffer) {
      const reserved = await setTenantTx(tid, tx => tx.$queryRawUnsafe(
        `SELECT created_at
           FROM payslip_documents
          WHERE tenant_id = $1::uuid AND id = $2`,
        tid, prepared.id,
      ));
      const staleBefore = Date.now() - PAYSLIP_DOCUMENT_PREPARE_STALE_MINUTES * 60 * 1000;
      if (!reserved[0] || new Date(reserved[0].created_at).getTime() >= staleBefore) {
        throw payslipDocumentInProgress('Payslip document preparation is already in progress');
      }
      const abandoned = await setTenantTx(tid, tx => tx.$queryRawUnsafe(
        `UPDATE payslip_documents
            SET status = 'failed', failure_reason = 'confirmed_missing_after_reservation',
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2 AND status = 'prepared'
            AND payroll_run_id = $3 AND attempt_token = $4::uuid
          RETURNING id`,
        tid, prepared.id, runId, token,
      ));
      if (abandoned.length !== 1) throw payrollRunAttemptLost(runId);
      return ensurePayslipDocumentReady({
        tenantId: tid,
        payrollRunId: runId,
        attemptToken: token,
        staffUid,
        calculation,
        payslip,
        staff,
        generatePdf,
        upload,
        read,
      });
    }

    if (!remote) {
      throw payslipDocumentReconciliationRequired(
        `Payroll object ${prepared.object_key} was not readable after upload`,
      );
    }
    if (sha256Buffer(remote) !== String(prepared.content_sha256)) {
      throw payslipDocumentReconciliationRequired(
        'Payslip document storage hash does not match its reserved identity',
      );
    }
    const uploaded = await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE payslip_documents AS document
            SET status = 'uploaded', uploaded_at = clock_timestamp(),
                storage_verified_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE document.tenant_id = $1::uuid AND document.id = $2
            AND document.status = 'prepared'
            AND document.payroll_run_id = $3
            AND document.attempt_token = $4::uuid
            AND document.staff_uid = $5::uuid
            AND document.payslip_revision = $6
            AND EXISTS (
              SELECT 1 FROM payroll_runs AS run
               WHERE run.tenant_id = document.tenant_id
                 AND run.id = document.payroll_run_id
                 AND run.attempt_token = document.attempt_token
                 AND run.status = 'processing'
            )
          RETURNING id, object_token, version, object_key, content_sha256,
                    status, uploaded_at, storage_verified_at`,
        tid, prepared.id, runId, token, staffUid, revision,
      );
      if (rows.length !== 1) throw payrollRunAttemptLost(runId);
      return rows[0];
    });
    prepared = uploaded;
  }

  if (prepared.status === 'uploaded') {
    const queued = await setTenantTx(tid, async (tx) => {
      const currentRuns = await tx.$queryRawUnsafe(
        `SELECT id
           FROM payroll_runs
          WHERE tenant_id = $1::uuid AND id = $2
            AND attempt_token = $3::uuid AND status = 'processing'
            AND hr_approved_at IS NULL AND admin_approved_at IS NULL
          FOR UPDATE`,
        tid, runId, token,
      );
      if (currentRuns.length !== 1) throw payrollRunAttemptLost(runId);
      const effectRows = await tx.$queryRawUnsafe(
        `SELECT result.finance_effects, payslip.advance_deduction,
                payslip.arrears_amount, payslip.month, payslip.year
           FROM payroll_run_staff_results AS result
           JOIN payslips AS payslip
             ON payslip.tenant_id = result.tenant_id
            AND payslip.id = result.payslip_id
          WHERE result.tenant_id = $1::uuid
            AND result.payroll_run_id = $2
            AND result.attempt_token = $3::uuid
            AND result.staff_uid = $4::uuid
            AND result.outcome = 'calculated'
            AND result.payslip_id = $5
            AND result.payslip_document_revision = $6
            AND result.superseded_at IS NULL
            AND payslip.generation_attempt_token = result.attempt_token
          FOR UPDATE OF result, payslip`,
        tid, runId, token, staffUid, payslipId, revision,
      );
      if (effectRows.length !== 1) throw payrollRunAttemptLost(runId);
      const effects = await applyPayrollFinanceEffectsTx(tx, {
        tenantId: tid,
        staffUid,
        payslipId,
        month: Number(effectRows[0].month),
        year: Number(effectRows[0].year),
        financeEffects: effectRows[0].finance_effects,
        expectedAdvanceDeduction: effectRows[0].advance_deduction,
        expectedArrearsAmount: effectRows[0].arrears_amount,
      });
      // This notice is queued while the run is still `processing` and both
      // approvals are NULL (the FOR UPDATE guard above asserts exactly that).
      // Its delivery receipt is what `issuePayrollRun` waits on before it
      // locks the run, so the row has to exist here — but the payslip is a
      // draft, `revealPayslipCredential` refuses anything that is not
      // `issued`/`viewed`/`downloaded`, and there is nothing for the staff
      // member to collect yet. The copy therefore states the pending state
      // and offers no action; the collectable "available" notice is queued
      // by `issuePayrollRun` after owner approval and issuance.
      const outbox = await notificationOutbox.queue({
        tenantId: tid,
        recipientId: staffUid,
        title: `Payslip ${String(payslip.month).padStart(2, '0')}/${payslip.year} is being prepared`,
        body: 'Your payslip is awaiting HR and admin approval. It cannot be opened yet — '
          + 'we will notify you when it has been issued.',
        channel: 'inapp',
        type: 'payslip_ready',
        sourceEventKey: `payslip-document:${prepared.object_token}`,
        templateVersion: 'payslip_pending_issue.v1',
        data: {
          payslip_id: payslipId,
          document_id: String(prepared.id),
          month: String(payslip.month),
          year: String(payslip.year),
          collectable: 'false',
          stage: 'pending_issue',
        },
      }, { tx, strict: true });
      const rows = await tx.$queryRawUnsafe(
        `UPDATE payslip_documents AS document
            SET status = 'delivery_queued',
                notification_outbox_id = $3, delivery_queued_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE document.tenant_id = $1::uuid AND document.id = $2
            AND document.status = 'uploaded' AND document.payroll_run_id = $4
            AND document.attempt_token = $5::uuid AND document.staff_uid = $6::uuid
            AND document.payslip_revision = $7
            AND EXISTS (
              SELECT 1 FROM payroll_runs AS run
               WHERE run.tenant_id = document.tenant_id
                 AND run.id = document.payroll_run_id
                 AND run.attempt_token = document.attempt_token
                 AND run.status = 'processing'
            )
          RETURNING id, version, object_key, content_sha256, status,
                    notification_outbox_id, uploaded_at`,
        tid, prepared.id, Number(outbox.id), runId, token, staffUid, revision,
      );
      if (rows.length !== 1) throw new Error('Payslip document state changed before delivery enqueue');
      const projected = await tx.$queryRawUnsafe(
        `UPDATE payslips
            SET pdf_key = $3, pdf_generated_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2
            AND payroll_run_id = $4 AND generation_attempt_token = $5::uuid
            AND staff_uid = $6::uuid AND document_revision = $7
          RETURNING id`,
        tid, payslipId, prepared.object_key, runId, token, staffUid, revision,
      );
      if (projected.length !== 1) throw payrollRunAttemptLost(runId);
      const completed = await tx.$queryRawUnsafe(
        `UPDATE payroll_run_staff_results
            SET outcome = 'succeeded', finalized_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND payroll_run_id = $2
            AND attempt_token = $3::uuid AND staff_uid = $4::uuid
            AND outcome = 'calculated' AND payslip_id = $5
            AND superseded_at IS NULL
          RETURNING staff_uid`,
        tid, runId, token, staffUid, payslipId,
      );
      if (completed.length !== 1) throw payrollRunAttemptLost(runId);
      return { ...rows[0], effects };
    });
    return queued;
  }

  return prepared;
}

export async function reconcilePayslipDocumentProviderAcceptance({ tenantId, documentId }) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE payslip_documents AS document
          SET status = 'notification_accepted',
              notification_accepted_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE document.tenant_id = $1::uuid
          AND document.id = $2
          AND document.status = 'delivery_queued'
          AND EXISTS (
            SELECT 1 FROM notification_provider_receipts AS receipt
             WHERE receipt.tenant_id = document.tenant_id
               AND receipt.notification_outbox_id = document.notification_outbox_id
               AND receipt.outcome = 'acknowledged'
          )
        RETURNING document.id, document.status, document.notification_accepted_at`,
      tid, documentId,
    );
    return rows[0] || null;
  });
}

export async function issuePayrollRun({
  tenantId,
  month,
  year,
  acknowledgeFailedPayslips = false,
}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    const runs = await tx.$queryRawUnsafe(
      `SELECT id, month, year, status, attempt_token,
              result_manifest_hash, document_manifest_hash,
              hr_approved_by, hr_approved_at, admin_approved_by, admin_approved_at,
              total_staff, total_gross, total_deductions, total_net,
              failed_staff_count, failed_staff
         FROM payroll_runs
        WHERE tenant_id = $1::uuid AND month = $2 AND year = $3
        FOR UPDATE`,
      tid, month, year,
    );
    if (runs.length === 0) return { ok: false, reason: 'not_found' };
    const run = runs[0];
    if (!run.hr_approved_at) return { ok: false, reason: 'hr_required', run };
    if (!run.admin_approved_at) return { ok: false, reason: 'admin_required', run };
    if (run.status !== 'approved' && run.status !== 'locked') {
      return { ok: false, reason: 'invalid_status', run };
    }
    const ackRequired = payrollRunNeedsFailureAck(run);
    if (ackRequired && acknowledgeFailedPayslips !== true) {
      return { ok: false, reason: 'ack_required', run, ackRequired };
    }
    const manifests = await computePayrollAttemptManifests(
      tx,
      tid,
      Number(run.id),
      run.attempt_token,
    );
    if (run.result_manifest_hash !== manifests.resultManifestHash
        || run.document_manifest_hash !== manifests.documentManifestHash) {
      return { ok: false, reason: 'manifest_changed', run };
    }

    const pendingDelivery = await tx.$queryRawUnsafe(
      `SELECT result.staff_uid,
              CASE
                WHEN document.id IS NULL THEN 'document_missing'
                WHEN document.status NOT IN ('delivery_queued', 'notification_accepted') THEN document.status
                WHEN NOT EXISTS (
                  SELECT 1
                    FROM notification_provider_receipts AS receipt
                   WHERE receipt.tenant_id = document.tenant_id
                     AND receipt.notification_outbox_id = document.notification_outbox_id
                     AND receipt.channel = 'inapp'
                     AND receipt.outcome = 'acknowledged'
                ) THEN 'notification_pending'
                ELSE NULL
              END AS delivery_state
         FROM payroll_run_staff_results AS result
         LEFT JOIN payslip_documents AS document
           ON document.tenant_id = result.tenant_id
          AND document.payroll_run_id = result.payroll_run_id
          AND document.attempt_token = result.attempt_token
          AND document.staff_uid = result.staff_uid
          AND document.payslip_id = result.payslip_id
          AND document.payslip_revision = result.payslip_document_revision
          AND document.status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted')
        WHERE result.tenant_id = $1::uuid
          AND result.payroll_run_id = $2
          AND result.attempt_token = $3::uuid
          AND result.outcome = 'succeeded'
          AND result.superseded_at IS NULL
          AND (
            document.id IS NULL
            OR document.status NOT IN ('delivery_queued', 'notification_accepted')
            OR NOT EXISTS (
              SELECT 1
                FROM notification_provider_receipts AS receipt
               WHERE receipt.tenant_id = document.tenant_id
                 AND receipt.notification_outbox_id = document.notification_outbox_id
                 AND receipt.channel = 'inapp'
                 AND receipt.outcome = 'acknowledged'
            )
          )
        ORDER BY result.staff_uid`,
      tid, Number(run.id), run.attempt_token,
    );
    if (pendingDelivery.length > 0) {
      return { ok: false, reason: 'delivery_pending', run, pendingDelivery };
    }

    await tx.$executeRawUnsafe(
      `UPDATE payslip_documents AS document
          SET status = 'notification_accepted',
              notification_accepted_at = COALESCE(document.notification_accepted_at, clock_timestamp()),
              updated_at = clock_timestamp()
        WHERE document.tenant_id = $1::uuid
          AND document.payroll_run_id = $2
          AND document.attempt_token = $3::uuid
          AND document.status = 'delivery_queued'
          AND EXISTS (
            SELECT 1
              FROM notification_provider_receipts AS receipt
             WHERE receipt.tenant_id = document.tenant_id
               AND receipt.notification_outbox_id = document.notification_outbox_id
               AND receipt.channel = 'inapp'
               AND receipt.outcome = 'acknowledged'
          )`,
      tid, Number(run.id), run.attempt_token,
    );

    const issuedRows = await tx.$queryRawUnsafe(
      `UPDATE payslips AS payslip
          SET status = CASE WHEN payslip.status = 'draft' THEN 'issued' ELSE payslip.status END,
              issued_at = COALESCE(payslip.issued_at, clock_timestamp()),
              updated_at = clock_timestamp()
         FROM payroll_run_staff_results AS result
         JOIN payslip_documents AS document
           ON document.tenant_id = result.tenant_id
          AND document.payroll_run_id = result.payroll_run_id
          AND document.attempt_token = result.attempt_token
          AND document.staff_uid = result.staff_uid
          AND document.payslip_id = result.payslip_id
          AND document.payslip_revision = result.payslip_document_revision
          AND document.status = 'notification_accepted'
        WHERE result.tenant_id = $1::uuid
          AND result.payroll_run_id = $2
          AND result.attempt_token = $3::uuid
          AND result.outcome = 'succeeded'
          AND result.superseded_at IS NULL
          AND payslip.tenant_id = result.tenant_id
          AND payslip.id = result.payslip_id
          AND payslip.payroll_run_id = result.payroll_run_id
          AND payslip.generation_attempt_token = result.attempt_token
          AND payslip.document_revision = result.payslip_document_revision
          AND payslip.status IN ('draft', 'issued', 'viewed', 'downloaded')
        RETURNING payslip.id, payslip.staff_uid::text AS staff_uid,
                  payslip.month, payslip.year, payslip.document_revision`,
      tid, Number(run.id), run.attempt_token,
    );
    if (issuedRows.length !== Number(run.total_staff || 0)) {
      throw new Error(`Payroll run ${run.id} current-success manifest changed before issue`);
    }
    await tx.$executeRawUnsafe(
      `UPDATE payroll_runs
          SET status = 'locked', locked_at = COALESCE(locked_at, clock_timestamp()),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2
          AND attempt_token = $3::uuid AND status IN ('approved', 'locked')`,
      tid, Number(run.id), run.attempt_token,
    );

    // Only now is the payslip actually collectable: it is `issued`, its
    // document is `notification_accepted`, and revealPayslipCredential will
    // hand over the PDF password. This is the first user-visible message that
    // tells staff to go and open it. Re-running issue on an already-locked run
    // re-queues the same intent, which the outbox dedupes on
    // ux_notification_outbox_delivery_intent.
    for (const issued of issuedRows) {
      await notificationOutbox.queue({
        tenantId: tid,
        recipientId: issued.staff_uid,
        title: `Payslip ${String(issued.month).padStart(2, '0')}/${issued.year} available`,
        body: 'Your password-protected payslip has been approved and issued. '
          + 'Open the VH Health staff app to view it.',
        channel: 'inapp',
        type: 'payslip_ready',
        sourceEventKey: `payslip-issued:${issued.id}:${issued.document_revision}`,
        templateVersion: 'payslip_issued.v1',
        data: {
          payslip_id: String(issued.id),
          month: String(issued.month),
          year: String(issued.year),
          collectable: 'true',
          stage: 'issued',
        },
      }, { tx, strict: true });
    }

    return {
      ok: true,
      issued: issuedRows.length,
      run,
      ackRequired,
    };
  }, {
    isolationLevel: 'Serializable',
    maxWait: 10000,
    timeout: 30000,
  });
}

export async function revealPayslipCredential({ tenantId, payslipId, staffUid }) {
  const tid = requireTenantId(tenantId);
  await loadTenantKekIntoProvider(tid);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT document.id, document.credential_ciphertext
         FROM payslips AS payslip
         JOIN payroll_runs AS run
           ON run.tenant_id = payslip.tenant_id
          AND run.id = payslip.payroll_run_id
         JOIN payroll_run_staff_results AS result
           ON result.tenant_id = run.tenant_id
          AND result.payroll_run_id = run.id
          AND result.attempt_token = run.attempt_token
          AND result.staff_uid = payslip.staff_uid
          AND result.payslip_id = payslip.id
          AND result.payslip_document_revision = payslip.document_revision
          AND result.outcome = 'succeeded'
          AND result.superseded_at IS NULL
         JOIN payslip_documents AS document
           ON document.tenant_id = result.tenant_id
          AND document.payroll_run_id = result.payroll_run_id
          AND document.attempt_token = result.attempt_token
          AND document.staff_uid = result.staff_uid
          AND document.payslip_id = result.payslip_id
          AND document.payslip_revision = result.payslip_document_revision
          AND document.status = 'notification_accepted'
        WHERE payslip.tenant_id = $1::uuid
          AND payslip.id = $2
          AND payslip.staff_uid = $3::uuid
          AND payslip.status IN ('issued', 'viewed', 'downloaded')
        FOR UPDATE OF document`,
      tid, Number(payslipId), staffUid,
    );
    if (rows.length !== 1) return null;
    const credential = decryptField(rows[0].credential_ciphertext);
    await tx.$executeRawUnsafe(
      `UPDATE payslip_documents
          SET credential_revealed_at = COALESCE(credential_revealed_at, clock_timestamp()),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2
          AND status = 'notification_accepted'`,
      tid, rows[0].id,
    );
    return { document_id: String(rows[0].id), credential };
  });
}

/**
 * Shared manual/cron payroll workflow.  Both entry points consume the frozen
 * cohort returned by beginPayrollRun and use the same calculation, document,
 * failure, heartbeat, and finalization state machine.
 */
export async function executePayrollRun({
  tenantId,
  month,
  year,
  generatedBy = null,
  rerunCompleted = false,
  documentDependencies = {},
}) {
  const tid = requireTenantId(tenantId);
  await loadTenantKekIntoProvider(tid);
  const run = await beginPayrollRun({
    tenantId: tid,
    month,
    year,
    generatedBy,
    skipCompleted: !rerunCompleted,
  });
  if (run.skipped) return { ...run, month, year };

  const failures = [];
  for (const staff of run.staff) {
    try {
      const generated = await generatePayslipForStaff({
        tenantId: tid,
        payrollRunId: run.id,
        attemptStartedAt: run.attempt_started_at,
        attemptToken: run.attempt_token,
        staffUid: staff.staff_uid,
        month,
        year,
      });
      await ensurePayslipDocumentReady({
        tenantId: tid,
        payrollRunId: run.id,
        attemptToken: run.attempt_token,
        staffUid: staff.staff_uid,
        calculation: generated.calculation,
        payslip: generated.payslip,
        staff,
        ...documentDependencies,
      });
    } catch (err) {
      if (isPayrollRunAttemptLostError(err)
          || err?.code === 'PAYSLIP_DOCUMENT_RECONCILIATION_REQUIRED'
          || err?.code === 'PAYSLIP_DOCUMENT_IN_PROGRESS') {
        throw err;
      }
      logger.error(`Payroll failed for staff ${staff.staff_uid}: ${err.message}`);
      const recorded = await recordPayrollStaffFailure({
        tenantId: tid,
        payrollRunId: run.id,
        attemptStartedAt: run.attempt_started_at,
        attemptToken: run.attempt_token,
        staffUid: staff.staff_uid,
        error: err,
      });
      if (recorded.outcome === 'failed') {
        recordPayrollFailure(failures, staff.staff_uid, err);
      }
    }
    await heartbeatPayrollRunAttempt({
      tenantId: tid,
      payrollRunId: run.id,
      attemptStartedAt: run.attempt_started_at,
      attemptToken: run.attempt_token,
    });
  }

  const finalized = await finalizePayrollRun({
    tenantId: tid,
    payrollRunId: run.id,
    attemptStartedAt: run.attempt_started_at,
    attemptToken: run.attempt_token,
  });
  return {
    ...finalized,
    run_id: run.id,
    attempt_token: run.attempt_token,
    skipped: false,
    month,
    year,
    processed: Number(finalized.total_staff || 0),
    failures: Number(finalized.failed_staff_count || 0),
  };
}

const PAYSLIP_EDITABLE_FIELDS = new Set([
  'basic_earned', 'hra_earned', 'da_earned', 'special_allowance_earned',
  'transport_allowance_earned', 'medical_allowance_earned', 'overtime_pay',
  'bonus_this_month', 'pf_employee', 'esi_employee', 'professional_tax',
  'tds', 'other_deductions', 'days_present', 'days_absent', 'days_leave',
  'overtime_hours',
]);

export async function editPayslipAndRegenerate({
  tenantId,
  payslipId,
  editorUid,
  editReason,
  edits,
  documentDependencies = {},
}) {
  const tid = requireTenantId(tenantId);
  const id = Number(payslipId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('payslipId must be a positive integer');
  const editEntries = Object.entries(edits || {}).filter(([field]) => PAYSLIP_EDITABLE_FIELDS.has(field));
  if (editEntries.length === 0) throw new Error('No valid editable fields provided');
  const editPayload = {};
  for (const [field, raw] of editEntries) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid numeric value for field: ${field}`);
    editPayload[field] = value;
  }
  await loadTenantKekIntoProvider(tid);

  const prepared = await setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT payslip.id, payslip.staff_uid, payslip.payroll_run_id,
              payslip.generation_attempt_token, payslip.document_revision,
              payslip.status, run.generated_at, run.status AS run_status,
              run.hr_approved_at, run.admin_approved_at, result.outcome
         FROM payslips AS payslip
         JOIN payroll_runs AS run
           ON run.tenant_id = payslip.tenant_id AND run.id = payslip.payroll_run_id
         JOIN payroll_run_staff_results AS result
           ON result.tenant_id = run.tenant_id
          AND result.payroll_run_id = run.id
          AND result.attempt_token = run.attempt_token
          AND result.staff_uid = payslip.staff_uid
          AND result.payslip_id = payslip.id
          AND result.payslip_document_revision = payslip.document_revision
          AND result.superseded_at IS NULL
        WHERE payslip.tenant_id = $1::uuid AND payslip.id = $2
        FOR UPDATE OF payslip, run, result`,
      tid, id,
    );
    if (rows.length === 0) return null;
    const current = rows[0];
    if (current.hr_approved_at || current.admin_approved_at
        || !['completed', 'completed_with_errors', 'processing'].includes(current.run_status)) {
      const err = new Error('Cannot edit a payslip after payroll signing has started');
      err.code = 'PAYSLIP_NOT_EDITABLE';
      throw err;
    }
    if (!['succeeded', 'calculated'].includes(current.outcome)
        || ['issued', 'viewed', 'downloaded'].includes(current.status)) {
      const err = new Error('Payslip is not in an editable current-result state');
      err.code = 'PAYSLIP_NOT_EDITABLE';
      throw err;
    }

    const noticeRows = await tx.$queryRawUnsafe(
      `SELECT outbox.id, outbox.status
         FROM payslip_documents AS document
         JOIN notification_outbox AS outbox
           ON outbox.tenant_id = document.tenant_id
          AND outbox.id = document.notification_outbox_id
        WHERE document.tenant_id = $1::uuid AND document.payslip_id = $2
          AND document.attempt_token = $3::uuid
          AND document.status IN ('prepared', 'uploaded', 'delivery_queued', 'notification_accepted')
        FOR UPDATE OF outbox`,
      tid, id, current.generation_attempt_token,
    );
    const unsafeNotice = noticeRows.find(row => !['PENDING', 'FAILED'].includes(row.status));
    if (unsafeNotice) {
      throw payslipDocumentReconciliationRequired(
        `Payslip edit requires notification reconciliation for outbox ${unsafeNotice.id}`,
      );
    }
    const suppressedNoticeCount = await tx.$executeRawUnsafe(
      `UPDATE notification_outbox AS outbox
          SET status = 'SUPPRESSED', failure_reason = 'payslip_revision_superseded',
              last_attempt_at = clock_timestamp()
         FROM payslip_documents AS document
        WHERE document.tenant_id = $1::uuid AND document.payslip_id = $2
          AND document.attempt_token = $3::uuid
          AND outbox.tenant_id = document.tenant_id
          AND outbox.id = document.notification_outbox_id
          AND outbox.status IN ('PENDING', 'FAILED')`,
      tid, id, current.generation_attempt_token,
    );
    if (Number(suppressedNoticeCount) !== noticeRows.length) {
      throw payslipDocumentReconciliationRequired(
        'Payslip edit could not suppress every locked document notification',
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE payslip_documents
          SET status = 'superseded', superseded_at = clock_timestamp(),
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payslip_id = $2
          AND attempt_token = $3::uuid AND status <> 'superseded'`,
      tid, id, current.generation_attempt_token,
    );

    const setFields = Object.keys(editPayload).map(field => `${field} = edit.${field}`).join(', ');
    await tx.$executeRawUnsafe(
      `WITH edit AS (
         SELECT (jsonb_populate_record(NULL::payslips, $3::jsonb)).*
       )
       UPDATE payslips AS payslip
          SET ${setFields}, updated_at = clock_timestamp()
         FROM edit
        WHERE payslip.tenant_id = $1::uuid AND payslip.id = $2`,
      tid, id, JSON.stringify(editPayload),
    );
    const editedRows = await tx.$queryRawUnsafe(
      `SELECT basic_earned, hra_earned, da_earned, special_allowance_earned,
              transport_allowance_earned, medical_allowance_earned, overtime_pay,
              bonus_this_month, arrears_amount, pf_employee, esi_employee,
              professional_tax, tds, other_deductions, advance_deduction
         FROM payslips
        WHERE tenant_id = $1::uuid AND id = $2`,
      tid, id,
    );
    const edited = editedRows[0];
    const num = value => Number(value || 0);
    const gross = num(edited.basic_earned) + num(edited.hra_earned) + num(edited.da_earned)
      + num(edited.special_allowance_earned) + num(edited.transport_allowance_earned)
      + num(edited.medical_allowance_earned) + num(edited.overtime_pay)
      + num(edited.bonus_this_month) + num(edited.arrears_amount);
    const totalDeductions = num(edited.pf_employee) + num(edited.esi_employee)
      + num(edited.professional_tax) + num(edited.tds) + num(edited.other_deductions);
    const net = gross - totalDeductions - num(edited.advance_deduction);
    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE payslips
          SET gross_salary = $3::numeric, total_deductions = $4::numeric,
              net_salary = $5::numeric, manually_edited = true,
              edit_reason = $6, edited_by = $7::uuid,
              edited_at = clock_timestamp(), status = 'draft',
              pdf_key = NULL, pdf_generated_at = NULL,
              document_revision = document_revision + 1,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING id, payroll_run_id, generation_attempt_token, document_revision,
                  staff_uid, month, year, total_working_days, days_present,
                  days_absent, days_leave, overtime_hours, overtime_rate,
                  basic_earned, hra_earned, da_earned, special_allowance_earned,
                  transport_allowance_earned, medical_allowance_earned,
                  overtime_pay, bonus_this_month, arrears_amount, gross_salary,
                  pf_employee, esi_employee, professional_tax, tds,
                  other_deductions, total_deductions, advance_deduction,
                  lop_days, lop_deduction, net_salary, revision_note, status,
                  manually_edited, edit_reason, edited_by, edited_at`,
      tid, id, gross.toFixed(2), totalDeductions.toFixed(2), net.toFixed(2),
      editReason, editorUid,
    );
    const updated = updatedRows[0];
    const resultRows = await tx.$queryRawUnsafe(
      `UPDATE payroll_run_staff_results
          SET outcome = 'calculated', payslip_document_revision = $5,
              gross_salary = $6::numeric, net_salary = $7::numeric,
              total_deductions = $8::numeric, failure_reason = NULL,
              finalized_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND payroll_run_id = $2
          AND attempt_token = $3::uuid AND staff_uid = $4::uuid
          AND outcome IN ('succeeded', 'calculated') AND superseded_at IS NULL
        RETURNING staff_uid`,
      tid, Number(updated.payroll_run_id), updated.generation_attempt_token,
      updated.staff_uid, Number(updated.document_revision), updated.gross_salary,
      updated.net_salary, updated.total_deductions,
    );
    if (resultRows.length !== 1) throw payrollRunAttemptLost(updated.payroll_run_id);
    await tx.$executeRawUnsafe(
      `UPDATE payroll_run_attempts AS attempt
          SET status = 'processing', finalized_at = NULL,
              succeeded_staff_count = counts.succeeded_count,
              failed_staff_count = counts.failed_count,
              updated_at = clock_timestamp()
         FROM (
           SELECT count(*) FILTER (WHERE outcome = 'succeeded')::integer AS succeeded_count,
                  count(*) FILTER (WHERE outcome = 'failed')::integer AS failed_count
             FROM payroll_run_staff_results
            WHERE tenant_id = $1::uuid AND payroll_run_id = $2
              AND attempt_token = $3::uuid AND superseded_at IS NULL
         ) AS counts
        WHERE attempt.tenant_id = $1::uuid AND attempt.payroll_run_id = $2
          AND attempt.attempt_token = $3::uuid`,
      tid, Number(updated.payroll_run_id), updated.generation_attempt_token,
    );
    await tx.$executeRawUnsafe(
      `UPDATE payroll_runs
          SET status = 'processing', total_staff = 0, total_gross = 0,
              total_net = 0, total_deductions = 0,
              result_manifest_hash = NULL, document_manifest_hash = NULL,
              updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2
          AND attempt_token = $3::uuid
          AND hr_approved_at IS NULL AND admin_approved_at IS NULL`,
      tid, Number(updated.payroll_run_id), updated.generation_attempt_token,
    );
    const staffRows = await tx.$queryRawUnsafe(
      `SELECT users.uid AS staff_uid, users.name, users.role, users.email,
              COALESCE(directory.department, salary.department) AS department,
              jsonb_build_object(
                'employee_id', salary.employee_id,
                'designation', salary.designation,
                'department', salary.department,
                'date_of_joining', salary.date_of_joining,
                'pf_uan', salary.pf_uan,
                'pan_number', salary.pan_number,
                'bank_account', salary.bank_account,
                'bank_name', salary.bank_name
              ) AS salary_config
         FROM users
         JOIN staff_salary AS salary
           ON salary.tenant_id = users.tenant_id AND salary.staff_uid = users.uid
         LEFT JOIN staff AS directory
           ON directory.tenant_id = users.tenant_id AND directory.user_id = users.uid
        WHERE users.tenant_id = $1::uuid AND users.uid = $2::uuid`,
      tid, updated.staff_uid,
    );
    return {
      attemptStartedAt: current.generated_at,
      attemptToken: updated.generation_attempt_token,
      payrollRunId: Number(updated.payroll_run_id),
      calculation: { ...updated, salary_config: staffRows[0]?.salary_config || {} },
      payslip: updated,
      staff: staffRows[0] || { staff_uid: updated.staff_uid },
    };
  }, {
    isolationLevel: 'Serializable',
    maxWait: 10000,
    timeout: 30000,
  });
  if (!prepared) return null;
  await ensurePayslipDocumentReady({
    tenantId: tid,
    payrollRunId: prepared.payrollRunId,
    attemptToken: prepared.attemptToken,
    staffUid: prepared.payslip.staff_uid,
    calculation: prepared.calculation,
    payslip: prepared.payslip,
    staff: prepared.staff,
    ...documentDependencies,
  });
  await heartbeatPayrollRunAttempt({
    tenantId: tid,
    payrollRunId: prepared.payrollRunId,
    attemptStartedAt: prepared.attemptStartedAt,
    attemptToken: prepared.attemptToken,
  });
  await finalizePayrollRun({
    tenantId: tid,
    payrollRunId: prepared.payrollRunId,
    attemptStartedAt: prepared.attemptStartedAt,
    attemptToken: prepared.attemptToken,
  });
  return prepared.payslip;
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
