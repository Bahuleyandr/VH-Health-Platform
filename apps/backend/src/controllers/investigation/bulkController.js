// controllers/investigation/bulkController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as bulkService from '../../services/investigation/bulkService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

// Bulk update investigation status
export const updateStatus = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const updatedBy = req.user?.uid;
    
    // Check permissions
    const allowedRoles = ['LAB_STAFF', 'LAB_TECHNICIAN', 'DOCTOR', 'RADIOLOGIST', 'ADMIN', 'SUPER_ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Lab technician or doctor privileges required', 403);
    }
    
    const { investigation_ids, status, notes } = req.body;
    
    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return error(res, 'Investigation IDs array is required', 400);
    }

    if (!status) {
      return error(res, 'Status is required', 400);
    }

    // Limit bulk operations to prevent abuse
    if (investigation_ids.length > 100) {
      return error(res, 'Cannot update more than 100 investigations at once', 400);
    }
    
    const results = await bulkService.bulkUpdateStatus(
      investigation_ids,
      status,
      notes,
      updatedBy
    );
    
    await logAudit(req, 'investigation-bulk-status-update', {
      investigation_ids,
      new_status: status,
      count: results.length
    });
    
    success(res, {
      updated: results,
      count: results.length,
      requested: investigation_ids.length,
      updatedBy
    }, 'Bulk status update completed');
    
  } catch (err) {
    logger.error('Bulk Update Status Error:', err);
    
    if (err.message === 'Invalid status') {
      return error(res, err.message, 400);
    }
    
    error(res, 'Failed to bulk update status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk cancel investigations
export const cancelInvestigations = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const cancelledBy = req.user?.uid;
    
    // Check permissions - more restrictive for cancellation
    const allowedRoles = ['DOCTOR', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Doctor or admin privileges required for cancellation', 403);
    }

    const { investigation_ids, reason } = req.body;

    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return error(res, 'Investigation IDs array is required', 400);
    }

    if (!reason || reason.trim().length < 10) {
      return error(res, 'Cancellation reason is required (minimum 10 characters)', 400);
    }

    // Limit bulk operations
    if (investigation_ids.length > 50) {
      return error(res, 'Cannot cancel more than 50 investigations at once', 400);
    }
    
    const results = await bulkService.bulkCancel(
      investigation_ids,
      reason,
      cancelledBy
    );
    
    await logAudit(req, 'investigation-bulk-cancel', {
      investigation_ids,
      reason,
      count: results.length
    });
    
    success(res, {
      cancelled: results,
      count: results.length,
      requested: investigation_ids.length,
      skipped: investigation_ids.length - results.length,
      cancelledBy
    }, 'Bulk cancellation completed');
    
  } catch (err) {
    logger.error('Bulk Cancel Error:', err);
    error(res, 'Failed to bulk cancel investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk assign to technician
export const assignToTechnician = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const assignedBy = req.user?.uid;
    
    // Check permissions
    const allowedRoles = ['LAB_STAFF', 'LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Lab supervisor privileges required', 403);
    }

    const { investigation_ids, technician_id } = req.body;

    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return error(res, 'Investigation IDs array is required', 400);
    }

    if (!technician_id) {
      return error(res, 'Technician ID is required', 400);
    }
    
    const results = await bulkService.bulkAssignTechnician(
      investigation_ids,
      technician_id,
      assignedBy
    );
    
    await logAudit(req, 'investigation-bulk-assign', {
      investigation_ids,
      technician_id,
      count: results.length
    });
    
    success(res, {
      assigned: results,
      count: results.length,
      assignedBy
    }, 'Bulk assignment completed');
    
  } catch (err) {
    logger.error('Bulk Assign Error:', err);
    error(res, 'Failed to bulk assign investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Bulk schedule investigations
export const scheduleInvestigations = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const scheduledBy = req.user?.uid;
    
    // Check permissions
    const allowedRoles = ['RECEPTIONIST', 'NURSE', 'LAB_STAFF', 'LAB_TECHNICIAN', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return error(res, 'Access denied: Staff privileges required', 403);
    }

    const { investigation_ids, scheduled_date, time_slot } = req.body;

    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return error(res, 'Investigation IDs array is required', 400);
    }

    if (!scheduled_date) {
      return error(res, 'Scheduled date is required', 400);
    }

    // Validate scheduled date is not in past
    const scheduledDateObj = new Date(scheduled_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (scheduledDateObj < today) {
      return error(res, 'Scheduled date cannot be in the past', 400);
    }
    
    const results = await bulkService.bulkSchedule(
      investigation_ids,
      scheduled_date,
      time_slot,
      scheduledBy
    );
    
    await logAudit(req, 'investigation-bulk-schedule', {
      investigation_ids,
      scheduled_date,
      time_slot,
      count: results.length
    });
    
    success(res, {
      scheduled: results,
      count: results.length,
      scheduledBy
    }, 'Bulk scheduling completed');
    
  } catch (err) {
    logger.error('Bulk Schedule Error:', err);
    error(res, 'Failed to bulk schedule investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
