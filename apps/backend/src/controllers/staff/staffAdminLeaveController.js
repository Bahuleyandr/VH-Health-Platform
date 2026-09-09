// src/controllers/staff/staffAdminLeaveController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { requestTenantId } from './staffAdminTenant.js';

// Leave Patterns
export const getLeavePatterns = async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const { department, year = new Date().getFullYear() } = req.query;
    
    const patterns = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(`
      SELECT 
        EXTRACT(MONTH FROM la.start_date) as month,
        la.leave_type,
        COUNT(*) as leave_count,
        SUM(la.end_date - la.start_date + 1) as total_days
      FROM leave_applications la
      JOIN users u ON la.staff_id = u.id AND u.tenant_id = $2::uuid
      LEFT JOIN staff s ON s.user_id = u.uid AND s.tenant_id = $2::uuid
      WHERE 
        EXTRACT(YEAR FROM la.start_date)::int = $1::int
        AND LOWER(la.status) = 'approved'
        AND la.tenant_id = $2::uuid
        ${department ? 'AND s.department = $3' : ''}
      GROUP BY month, la.leave_type
      ORDER BY month, la.leave_type
    `, year, tenantId, ...(department ? [department] : [])));

    success(res, {
      patterns: patterns,
      year
    }, 'Leave patterns retrieved successfully');
  } catch (err) {
    relayAppError(res, err, 'Failed to retrieve leave patterns');
  }
};

// Get All Leave Requests
export const getAllLeaveRequests = async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const { status = 'pending', department } = req.query;
    
    const leaveRequests = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(`
      SELECT 
        la.id,
        la.staff_id,
        COALESCE(NULLIF(u.name, ''), NULLIF(s.name, ''), s.employee_id, 'Unknown staff') as staff_name,
        s.employee_id,
        s.department,
        la.leave_type,
        la.start_date,
        la.end_date,
        la.reason,
        LOWER(la.status) AS status,
        la.created_at,
        la.end_date - la.start_date + 1 as total_days
      FROM leave_applications la
      JOIN users u ON la.staff_id = u.id AND u.tenant_id = $2::uuid
      LEFT JOIN staff s ON s.user_id = u.uid AND s.tenant_id = $2::uuid
      WHERE 
        LOWER(la.status) = LOWER($1)
        AND la.tenant_id = $2::uuid
        ${department ? 'AND s.department = $3' : ''}
      ORDER BY la.created_at DESC
    `, status, tenantId, ...(department ? [department] : [])));

    success(res, {
      leaveRequests: leaveRequests,
      total: leaveRequests.length,
      status
    }, 'Leave requests retrieved successfully');
  } catch (err) {
    relayAppError(res, err, 'Failed to retrieve leave requests');
  }
};

// Bulk Leave Approval
export const bulkLeaveApproval = async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const { leave_ids, action = 'approve' } = req.body;
    const approvedBy = req.user?.uid;
    const status = action === 'approve' ? 'approved' : 'rejected';

    const result = await prisma.$queryRawUnsafe(`
      UPDATE leave_applications
      SET
        status = $1,
        reviewed_by = $2::uuid,
        reviewed_at = NOW()
      WHERE id = ANY($3::int[]) AND tenant_id = $4::uuid
      RETURNING id
    `, status, approvedBy, leave_ids, tenantId);

    if (result.length === 0) {
      return error(res, 'Leave requests not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      processed: result.length,
      action,
      leave_ids
    }, `${result.length} leave requests ${status}`);
  } catch (err) {
    relayAppError(res, err, 'Failed to process leave requests');
  }
};

// Approve Leave Request
export const approveLeaveRequest = async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const { leaveId } = req.params;
    const { comments } = req.body;
    const approvedBy = req.user?.uid;
    const status = req.path.includes('/reject') || req.body?.action === 'reject'
      ? 'rejected'
      : 'approved';

    const result = await prisma.$queryRawUnsafe(`
      UPDATE leave_applications
      SET
        status = $4,
        reviewed_by = $2::uuid,
        reviewed_at = NOW(),
        review_notes = $3
      WHERE id = $1::int AND tenant_id = $5::uuid
      RETURNING id, staff_id, leave_type, start_date, end_date, status, reviewed_by, reason, created_at
    `, leaveId, approvedBy, comments, status, tenantId);

    if (result.length === 0) {
      return error(res, 'Leave request not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], `Leave request ${status} successfully`);
  } catch (err) {
    relayAppError(res, err, 'Failed to approve leave request');
  }
};

// Override Leave Balance
export const overrideLeaveBalance = async (req, res) => {
  try {
    const tenantId = requestTenantId(req);
    const { staff_id, leave_type, new_balance, reason } = req.body;
    const overriddenBy = req.user?.uid;

    const result = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(`
      INSERT INTO leave_balance_overrides (tenant_id, staff_id, leave_type, new_balance, reason, overridden_by)
      SELECT $6::uuid, u.id, $2, $3, $4, $5::uuid
      FROM users u
      WHERE u.id = $1::int AND u.tenant_id = $6::uuid
        AND COALESCE(UPPER(u.role), '') <> 'PATIENT'
      RETURNING id
    `, staff_id, leave_type, new_balance, reason, overriddenBy, tenantId));

    if (result.length === 0) {
      return error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, {
      staff_id,
      leave_type,
      new_balance,
      reason
    }, 'Leave balance override successful');
  } catch (err) {
    relayAppError(res, err, 'Failed to override leave balance');
  }
};
