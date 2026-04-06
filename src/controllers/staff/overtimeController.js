import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * Request overtime
 */
export const requestOvertime = async (req, res) => {
  try {
    const staffId = req.user?.uid;
    const { date, extra_hours, reason, type } = req.body;

    if (!date || !extra_hours || !reason) {
      return error(res, 'date, extra_hours, and reason are required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO overtime_requests (staff_id, date, extra_hours, reason, type)
      VALUES ($1, $2, $3, $4, $5) RETURNING id, staff_uid, date, hours, reason, status, approved_by, created_at
    `, [staffId, date, extra_hours, reason, type || 'comp_time']);

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
    const staffId = req.user?.uid;
    const rows = await prisma.$queryRawUnsafe(`
      SELECT o.*, u.name as approved_by_name
      FROM overtime_requests o
      LEFT JOIN users u ON o.approved_by = u.id
      WHERE o.staff_id = $1 ORDER BY o.date DESC LIMIT 30
    `, staffId);

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
    const approverId = req.user?.uid;
    const { status, rejection_reason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return error(res, 'status must be approved or rejected', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await prisma.$queryRawUnsafe(`
      UPDATE overtime_requests
      SET status=$1, approved_by=$2, approved_at=NOW(), rejection_reason=$3
      WHERE id=$4 RETURNING id, staff_uid, date, hours, reason, status, approved_by, created_at
    `, [status, approverId, rejection_reason || null, id]);

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
      SELECT o.*, u.name as staff_name, u.employee_id, s.department
      FROM overtime_requests o
      JOIN users u ON o.staff_id = u.id
      LEFT JOIN staff s ON u.id = s.user_id
      WHERE o.status='pending' ORDER BY o.date DESC
    `);

    success(res, rows, 'Pending overtime requests fetched');
  } catch (err) {
    logger.error('Get Pending Overtime Error:', err);
    error(res, 'Failed to fetch overtime requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
