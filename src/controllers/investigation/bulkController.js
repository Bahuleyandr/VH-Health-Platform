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
    const allowedRoles = ['LAB_TECHNICIAN', 'DOCTOR', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        message: 'Access denied: Lab technician or doctor privileges required',
        requestedBy: updatedBy
      });
    }
    
    const { investigation_ids, status, notes } = req.body;
    
    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return res.status(400).json({
        message: 'Investigation IDs array is required',
        requestedBy: updatedBy
      });
    }
    
    if (!status) {
      return res.status(400).json({
        message: 'Status is required',
        requestedBy: updatedBy
      });
    }
    
    // Limit bulk operations to prevent abuse
    if (investigation_ids.length > 100) {
      return res.status(400).json({
        message: 'Cannot update more than 100 investigations at once',
        requestedBy: updatedBy
      });
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
      return res.status(400).json({
        message: err.message,
        requestedBy: req.user?.uid
      });
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
      return res.status(403).json({
        message: 'Access denied: Doctor or admin privileges required for cancellation',
        requestedBy: cancelledBy
      });
    }
    
    const { investigation_ids, reason } = req.body;
    
    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return res.status(400).json({
        message: 'Investigation IDs array is required',
        requestedBy: cancelledBy
      });
    }
    
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        message: 'Cancellation reason is required (minimum 10 characters)',
        requestedBy: cancelledBy
      });
    }
    
    // Limit bulk operations
    if (investigation_ids.length > 50) {
      return res.status(400).json({
        message: 'Cannot cancel more than 50 investigations at once',
        requestedBy: cancelledBy
      });
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
    const allowedRoles = ['LAB_TECHNICIAN', 'RADIOLOGIST', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        message: 'Access denied: Lab supervisor privileges required',
        requestedBy: assignedBy
      });
    }
    
    const { investigation_ids, technician_id } = req.body;
    
    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return res.status(400).json({
        message: 'Investigation IDs array is required',
        requestedBy: assignedBy
      });
    }
    
    if (!technician_id) {
      return res.status(400).json({
        message: 'Technician ID is required',
        requestedBy: assignedBy
      });
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
    const allowedRoles = ['RECEPTIONIST', 'NURSE', 'LAB_TECHNICIAN', 'ADMIN'];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        message: 'Access denied: Staff privileges required',
        requestedBy: scheduledBy
      });
    }
    
    const { investigation_ids, scheduled_date, time_slot } = req.body;
    
    // Validate input
    if (!investigation_ids || !Array.isArray(investigation_ids) || investigation_ids.length === 0) {
      return res.status(400).json({
        message: 'Investigation IDs array is required',
        requestedBy: scheduledBy
      });
    }
    
    if (!scheduled_date) {
      return res.status(400).json({
        message: 'Scheduled date is required',
        requestedBy: scheduledBy
      });
    }
    
    // Validate scheduled date is not in past
    const scheduledDateObj = new Date(scheduled_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (scheduledDateObj < today) {
      return res.status(400).json({
        message: 'Scheduled date cannot be in the past',
        requestedBy: scheduledBy
      });
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