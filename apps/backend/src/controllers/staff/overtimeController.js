import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

async function resolveCurrentUserRef(req) {
  if (!req.user?.uid) return null;
  return prisma.users.findUnique({
    where: { uid: req.user.uid },
    select: { id: true, uid: true },
  });
}

/**
 * Request overtime
 */
export const requestOvertime = async (req, res) => {
  try {
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const { date, extra_hours, reason, type } = req.body;

    if (!date || !extra_hours || !reason) {
      return error(res, 'date, extra_hours, and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO overtime_requests (staff_id, staff_uid, date, extra_hours, reason, type)
      VALUES ($1, $2::uuid, $3::date, $4, $5, $6)
      RETURNING id, staff_id, staff_uid, date, extra_hours, reason, type, status, approved_by, created_at
    `, staff.id, staff.uid, date, extra_hours, reason, type || 'comp_time');

    success(res, result[0], 'Overtime request submitted');
  } catch (err) {
    logger.error('Overtime Request Error:', err);
    error(res, 'Failed to submit overtime request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get my overtime requests
 */
export const getMyOvertimeRequests = async (req, res) => {
  try {
    const staff = await resolveCurrentUserRef(req);
    if (!staff) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }
    const rows = await prisma.$queryRawUnsafe(`
      SELECT o.*, u.name as approved_by_name
      FROM overtime_requests o
      LEFT JOIN users u ON o.approved_by = u.id
      WHERE o.staff_id = $1 ORDER BY o.date DESC LIMIT 30
    `, staff.id);

    success(res, rows, 'Overtime requests fetched');
  } catch (err) {
    logger.error('Get Overtime Error:', err);
    error(res, 'Failed to fetch overtime requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Approve or reject overtime request (HR/Admin only)
 */
export const approveOvertime = async (req, res) => {
  try {
    const { id } = req.params;
    const approver = await resolveCurrentUserRef(req);
    if (!approver) {
      return error(res, 'Approver not found', HTTP_STATUS.NOT_FOUND);
    }
    const { status, rejection_reason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return error(res, 'status must be approved or rejected', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE overtime_requests
      SET status=$1, approved_by=$2, approved_by_uid=$3::uuid, approved_at=NOW(), rejection_reason=$4, updated_at=NOW()
      WHERE id=$5::int
      RETURNING id, staff_id, staff_uid, date, extra_hours, reason, type, status, approved_by, created_at
    `, status, approver.id, approver.uid, rejection_reason || null, id);

    if (result.length === 0) {
      return error(res, 'Request not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], `Overtime request ${status}`);
  } catch (err) {
    logger.error('Approve Overtime Error:', err);
    error(res, 'Failed to approve overtime request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get all pending overtime requests (Admin/HR only)
 */
export const getPendingOvertimeRequests = async (req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT o.*, u.name as staff_name, s.employee_id, s.department
      FROM overtime_requests o
      JOIN users u ON o.staff_id = u.id
      LEFT JOIN staff s ON u.uid = s.user_id
      WHERE o.status='pending' ORDER BY o.date DESC
    `);

    success(res, rows, 'Pending overtime requests fetched');
  } catch (err) {
    logger.error('Get Pending Overtime Error:', err);
    error(res, 'Failed to fetch overtime requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
