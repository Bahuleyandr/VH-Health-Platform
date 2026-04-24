// src/controllers/staff/salaryRevisionController.js
import crypto from 'crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

function computeRevisionHash(revision) {
  const data = [
    revision.staff_uid,
    revision.revision_type,
    revision.proposed_basic,
    revision.bonus_amount,
    revision.effective_from,
    revision.proposed_by,
    revision.hr_signed_by,
    revision.hr_signed_at,
  ].join(':');
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ─── HR: Propose increment or bonus ──────────────────────────────────────────
export const proposeRevision = async (req, res) => {
  try {
    const proposerUid = req.user?.uid;
    const {
      staff_uid, revision_type, proposed_basic, increment_amount, increment_pct,
      bonus_amount, bonus_reason, other_changes, effective_from, reason,
    } = req.body;

    if (!staff_uid || !revision_type || !reason || !effective_from) {
      return error(res, 'staff_uid, revision_type, effective_from, and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const validTypes = ['increment', 'bonus', 'deduction_change', 'component_change'];
    if (!validTypes.includes(revision_type)) {
      return error(res, `revision_type must be one of: ${validTypes.join(', ')}`, HTTP_STATUS.BAD_REQUEST);
    }

    // Verify staff exists
    const staffCheck = await prisma.$queryRawUnsafe('SELECT uid, name FROM users WHERE uid = $1', staff_uid);
    if (staffCheck.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    // Get current salary
    const currentSalaryRes = await prisma.$queryRawUnsafe('SELECT id, staff_uid, basic_salary, hra_pct, da_pct, special_allowance, transport_allowance, medical_allowance, pf_employee_pct, is_active, effective_from, created_at FROM staff_salary WHERE staff_uid=$1', staff_uid);
    const currentSalary = currentSalaryRes[0];

    // Calculate proposed gross if basic is provided
    let proposedGross = null;
    if (proposed_basic) {
      const pb = parseFloat(proposed_basic);
      const hra = pb * ((currentSalary?.hra_pct || 40) / 100);
      const da = pb * ((currentSalary?.da_pct || 10) / 100);
      proposedGross = pb + hra + da +
        parseFloat(currentSalary?.special_allowance || 0) +
        parseFloat(currentSalary?.transport_allowance || 0) +
        parseFloat(currentSalary?.medical_allowance || 0);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO salary_revisions (
        staff_uid, revision_type, current_basic, proposed_basic,
        increment_amount, increment_pct,
        bonus_amount, bonus_reason, other_changes,
        effective_from, reason, proposed_by,
        current_gross, proposed_gross
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING id, staff_uid, revision_type, current_basic, proposed_basic, status, reason, created_at, revision_number
    `, 
      staff_uid, revision_type,
      currentSalary?.basic_salary ?? null,
      proposed_basic ?? null,
      increment_amount ?? null,
      increment_pct ?? null,
      bonus_amount ?? null,
      bonus_reason ?? null,
      other_changes ? JSON.stringify(other_changes) : null,
      effective_from, reason, proposerUid,
      currentSalary?.basic_salary ?? null,
      proposedGross ?? proposed_basic ?? null,
    );

    success(res, result[0],
      `${revision_type} proposal ${result[0].revision_number} submitted — awaiting HR signature`);
  } catch (err) {
    logger.error('Propose Revision Error:', err);
    error(res, 'Failed to propose revision', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── HR: Sign revision (first countersign) ───────────────────────────────────
export const hrSignRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const hrUid = req.user?.uid;
    const { comment } = req.body;

    const rev = await prisma.$queryRawUnsafe('SELECT id, staff_uid, revision_type, current_basic, proposed_basic, current_gross, proposed_gross, effective_from, status, hr_signed_by, admin_signed_by, reason, created_at FROM salary_revisions WHERE id=$1', id);
    if (rev.length === 0) return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    if (rev[0].status !== 'pending_hr') {
      return error(res, 'Revision is not awaiting HR signature', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE salary_revisions
      SET hr_signed_by=$1, hr_signed_at=NOW(), hr_comment=$2, status='pending_admin', updated_at=NOW()
      WHERE id=$3
      RETURNING id, staff_uid, revision_type, current_basic, proposed_basic, status, reason, created_at
    `, hrUid, comment ?? null, id);

    success(res, result[0], 'HR signature applied — awaiting Admin countersign');
  } catch (err) {
    logger.error('HR Sign Revision Error:', err);
    error(res, 'Failed to sign revision', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Countersign revision (second/final sign) ────────────────────────
export const adminSignRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUid = req.user?.uid;
    const { comment } = req.body;

    const rev = await prisma.$queryRawUnsafe('SELECT id, staff_uid, revision_type, current_basic, proposed_basic, current_gross, proposed_gross, effective_from, status, hr_signed_by, admin_signed_by, reason, created_at FROM salary_revisions WHERE id=$1', id);
    if (rev.length === 0) return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    if (rev[0].status !== 'pending_admin') {
      return error(res, 'Revision must be HR-signed before Admin countersign', HTTP_STATUS.BAD_REQUEST);
    }
    if (rev[0].hr_signed_by === adminUid) {
      return error(res, 'HR signer and Admin signer cannot be the same person', HTTP_STATUS.FORBIDDEN);
    }

    // Compute integrity hash
    const hash = computeRevisionHash({ ...rev[0], admin_signed_by: adminUid });

    const result = await prisma.$queryRawUnsafe(`
      UPDATE salary_revisions
      SET admin_signed_by=$1, admin_signed_at=NOW(), admin_comment=$2,
          status='approved', signature_hash=$3, updated_at=NOW()
      WHERE id=$4
      RETURNING id, staff_uid, revision_type, current_basic, proposed_basic, status, reason, created_at
    `, adminUid, comment ?? null, hash, id);

    success(res, result[0], 'Admin countersign complete — revision approved');
  } catch (err) {
    logger.error('Admin Sign Revision Error:', err);
    error(res, 'Failed to countersign revision', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Admin: Apply approved revision to staff_salary ─────────────────────────
export const applyRevision = async (req, res) => {
  try {
    const { id } = req.params;

    const rev = await prisma.$queryRawUnsafe('SELECT id, staff_uid, revision_type, current_basic, proposed_basic, current_gross, proposed_gross, effective_from, status, hr_signed_by, admin_signed_by, reason, created_at FROM salary_revisions WHERE id=$1', id);
    if (rev.length === 0) return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    if (rev[0].status !== 'approved') {
      return error(res, 'Revision must be approved by both HR and Admin before applying', HTTP_STATUS.FORBIDDEN);
    }

    const r = rev[0];
    const updates = [];
    const vals = [];
    let idx = 1;

    if (r.proposed_basic) {
      updates.push(`basic_salary = $${idx++}`);
      vals.push(r.proposed_basic);
    }

    if (r.other_changes) {
      try {
        const changes = typeof r.other_changes === 'string'
          ? JSON.parse(r.other_changes)
          : r.other_changes;
        const allowed = ['hra_pct', 'da_pct', 'special_allowance', 'transport_allowance', 'medical_allowance', 'tds_monthly'];
        for (const [field, value] of Object.entries(changes)) {
          if (allowed.includes(field)) {
            updates.push(`${field} = $${idx++}`);
            vals.push(value);
          }
        }
      } catch (_) { /* skip invalid JSON */ }
    }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      vals.push(r.staff_uid);
      await prisma.$queryRawUnsafe(
        `UPDATE staff_salary SET ${updates.join(', ')} WHERE staff_uid = $${idx}`,
        vals
      );
    }

    // Mark as applied
    await prisma.$queryRawUnsafe(
      `UPDATE salary_revisions SET status='applied', applied_at=NOW() WHERE id=$1`,
      id
    );

    // Update annual review reminder if applicable
    const thisYear = new Date().getFullYear();
    await prisma.$queryRawUnsafe(`
      UPDATE annual_review_reminders
      SET status='completed', revision_id=$1
      WHERE staff_uid=$2 AND review_year=$3 AND status IN ('pending','initiated')
    `, id, r.staff_uid, thisYear).catch(() => { /* non-critical */ });

    success(res, { revision_id: id, staff_uid: r.staff_uid }, 'Revision applied to staff salary');
  } catch (err) {
    logger.error('Apply Revision Error:', err);
    error(res, 'Failed to apply revision', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Reject revision ─────────────────────────────────────────────────────────
export const rejectRevision = async (req, res) => {
  try {
    const { id } = req.params;
    const rejecterUid = req.user?.uid;
    const { reason } = req.body;

    const result = await prisma.$queryRawUnsafe(`
      UPDATE salary_revisions
      SET status='rejected', rejected_by=$1, rejected_at=NOW(), rejection_reason=$2, updated_at=NOW()
      WHERE id=$3 AND status IN ('pending_hr','pending_admin')
      RETURNING id, staff_uid, revision_type, current_basic, proposed_basic, status, reason, created_at
    `, rejecterUid, reason ?? null, id);

    if (result.length === 0) {
      return error(res, 'Revision not found or already processed', HTTP_STATUS.NOT_FOUND);
    }
    success(res, result[0], 'Revision rejected');
  } catch (err) {
    logger.error('Reject Revision Error:', err);
    error(res, 'Failed to reject revision', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Get revisions list ───────────────────────────────────────────────────────
export const getRevisions = async (req, res) => {
  try {
    const { status, staff_uid, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`sr.status = $${idx++}`); params.push(status); }
    if (staff_uid) { conditions.push(`sr.staff_uid = $${idx++}`); params.push(staff_uid); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(limit) || 50, 200));

    const revisions = await prisma.$queryRawUnsafe(`
      SELECT sr.id, sr.staff_uid, sr.revision_type, sr.current_basic, sr.proposed_basic, sr.current_gross, sr.proposed_gross,
             sr.effective_from, sr.status, sr.reason, sr.created_at,
             u.name as staff_name, COALESCE(s.department, ss.department) as department,
             u2.name as proposed_by_name,
             u3.name as hr_signed_by_name,
             u4.name as admin_signed_by_name,
             u5.name as rejected_by_name
      FROM salary_revisions sr
      JOIN users u ON sr.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.uid
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
      LEFT JOIN users u2 ON sr.proposed_by = u2.uid
      LEFT JOIN users u3 ON sr.hr_signed_by = u3.uid
      LEFT JOIN users u4 ON sr.admin_signed_by = u4.uid
      LEFT JOIN users u5 ON sr.rejected_by = u5.uid
      ${where}
      ORDER BY sr.created_at DESC
      LIMIT $${idx}
    `, params);

    success(res, revisions, 'Revisions fetched');
  } catch (err) {
    logger.error('Get Revisions Error:', err);
    error(res, 'Failed to fetch revisions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Annual review reminders ─────────────────────────────────────────────────
export const getAnnualReviewStatus = async (req, res) => {
  try {
    const year = new Date().getFullYear();

    const dueForReview = await prisma.$queryRawUnsafe(`
      SELECT u.uid, u.name, COALESCE(s.department, ss.department) as department, u.role,
             ss.basic_salary, ss.date_of_joining,
             EXTRACT(YEAR FROM AGE(CURRENT_DATE, ss.date_of_joining::date)) as years_of_service,
             arr.status as review_status, arr.id as reminder_id,
             (
               SELECT revision_number FROM salary_revisions
               WHERE staff_uid = u.uid
                 AND EXTRACT(YEAR FROM created_at) = $1
                 AND status IN ('approved','applied')
               ORDER BY created_at DESC LIMIT 1
             ) as revision_this_year
      FROM staff_salary ss
      JOIN users u ON ss.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.uid
      LEFT JOIN annual_review_reminders arr ON arr.staff_uid = u.uid AND arr.review_year = $1
      WHERE ss.is_active = true
        AND ss.date_of_joining IS NOT NULL
        AND ss.date_of_joining::date <= CURRENT_DATE - INTERVAL '11 months'
      ORDER BY ss.date_of_joining ASC
    `, year);

    success(res, { year, staff: dueForReview }, 'Annual review status fetched');
  } catch (err) {
    logger.error('Annual Review Status Error:', err);
    error(res, 'Failed to fetch annual review status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Get single revision detail ───────────────────────────────────────────────
export const getRevisionDetail = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await prisma.$queryRawUnsafe(`
      SELECT sr.id, sr.staff_uid, sr.revision_type, sr.current_basic, sr.proposed_basic, sr.current_gross, sr.proposed_gross,
             sr.effective_from, sr.status, sr.reason, sr.created_at,
             u.name as staff_name, COALESCE(s.department, ss.department) as department,
             u2.name as proposed_by_name,
             u3.name as hr_signed_by_name,
             u4.name as admin_signed_by_name
      FROM salary_revisions sr
      JOIN users u ON sr.staff_uid = u.uid
      LEFT JOIN staff s ON s.user_id = u.uid
      LEFT JOIN staff_salary ss ON ss.staff_uid = u.uid
      LEFT JOIN users u2 ON sr.proposed_by = u2.uid
      LEFT JOIN users u3 ON sr.hr_signed_by = u3.uid
      LEFT JOIN users u4 ON sr.admin_signed_by = u4.uid
      WHERE sr.id = $1
    `, id);

    if (result.length === 0) return error(res, 'Revision not found', HTTP_STATUS.NOT_FOUND);
    success(res, result[0], 'Revision detail fetched');
  } catch (err) {
    logger.error('Get Revision Detail Error:', err);
    error(res, 'Failed to fetch revision detail', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
