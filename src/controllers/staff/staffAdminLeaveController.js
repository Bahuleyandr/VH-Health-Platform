// src/controllers/staff/staffAdminLeaveController.js
import db from '../../config/database.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Leave Patterns
export const getLeavePatterns = async (req, res) => {
  try {
    const { department, year = new Date().getFullYear() } = req.query;
    
    const patterns = await db.query(`
      SELECT 
        EXTRACT(MONTH FROM la.start_date) as month,
        la.leave_type,
        COUNT(*) as leave_count,
        SUM(la.end_date - la.start_date + 1) as total_days
      FROM leave_applications la
      JOIN staff s ON la.staff_id = s.id
      WHERE 
        EXTRACT(YEAR FROM la.start_date) = $1
        AND la.status = 'approved'
        ${department ? 'AND s.department = $2' : ''}
      GROUP BY month, la.leave_type
      ORDER BY month, la.leave_type
    `, department ? [year, department] : [year]);

    success(res, {
      patterns: patterns.rows,
      year
    }, 'Leave patterns retrieved successfully');
  } catch (err) {
    logger.error('Leave Patterns Error:', err);
    error(res, 'Failed to retrieve leave patterns', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get All Leave Requests
export const getAllLeaveRequests = async (req, res) => {
  try {
    const { status = 'pending', department } = req.query;
    
    const leaveRequests = await db.query(`
      SELECT 
        la.id,
        la.staff_id,
        s.name as staff_name,
        s.department,
        la.leave_type,
        la.start_date,
        la.end_date,
        la.reason,
        la.status,
        la.created_at,
        la.end_date - la.start_date + 1 as total_days
      FROM leave_applications la
      JOIN staff s ON la.staff_id = s.id
      WHERE 
        la.status = $1
        ${department ? 'AND s.department = $2' : ''}
      ORDER BY la.created_at DESC
    `, department ? [status, department] : [status]);

    success(res, {
      leaveRequests: leaveRequests.rows,
      total: leaveRequests.rows.length,
      status
    }, 'Leave requests retrieved successfully');
  } catch (err) {
    logger.error('Leave Requests Error:', err);
    error(res, 'Failed to retrieve leave requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk Leave Approval
export const bulkLeaveApproval = async (req, res) => {
  try {
    const { leave_ids, action = 'approve' } = req.body;
    const approvedBy = req.user?.uid;
    const status = action === 'approve' ? 'approved' : 'rejected';

    const result = await db.query(`
      UPDATE leave_applications
      SET 
        status = $1,
        approved_by = $2,
        approved_at = NOW()
      WHERE id = ANY($3::int[])
      RETURNING id
    `, [status, approvedBy, leave_ids]);

    success(res, {
      processed: result.rows.length,
      action,
      leave_ids
    }, `${result.rows.length} leave requests ${status}`);
  } catch (err) {
    logger.error('Bulk Leave Approval Error:', err);
    error(res, 'Failed to process leave requests', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Approve Leave Request
export const approveLeaveRequest = async (req, res) => {
  try {
    const { leaveId } = req.params;
    const { comments } = req.body;
    const approvedBy = req.user?.uid;

    const result = await db.query(`
      UPDATE leave_applications
      SET 
        status = 'approved',
        approved_by = $2,
        approved_at = NOW(),
        approver_comments = $3
      WHERE id = $1
      RETURNING *
    `, [leaveId, approvedBy, comments]);

    if (result.rows.length === 0) {
      return error(res, 'Leave request not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result.rows[0], 'Leave request approved successfully');
  } catch (err) {
    logger.error('Approve Leave Error:', err);
    error(res, 'Failed to approve leave request', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Override Leave Balance
export const overrideLeaveBalance = async (req, res) => {
  try {
    const { staff_id, leave_type, new_balance, reason } = req.body;
    const overriddenBy = req.user?.uid;

    await db.query(`
      INSERT INTO leave_balance_overrides (staff_id, leave_type, new_balance, reason, overridden_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [staff_id, leave_type, new_balance, reason, overriddenBy]);

    success(res, {
      staff_id,
      leave_type,
      new_balance,
      reason
    }, 'Leave balance override successful');
  } catch (err) {
    logger.error('Override Leave Balance Error:', err);
    error(res, 'Failed to override leave balance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
