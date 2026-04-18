import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as shiftService from '../../services/staff/shiftService.js';
import { success, error } from '../../utils/responseHelper.js';

/**
 * Get all active shifts
 */
export const getAllShifts = async (req, res) => {
  try {
    const shifts = await shiftService.getAllShifts();
    success(res, shifts, 'Shifts fetched');
  } catch (err) {
    logger.error('Get Shifts Error:', err);
    error(res, 'Failed to fetch shifts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Assign a shift to a staff member
 */
export const assignShift = async (req, res) => {
  try {
    const { staffId, shiftId, effectiveFrom } = req.body;

    if (!staffId || !shiftId) {
      return error(res, 'staffId and shiftId are required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await shiftService.assignShift(staffId, shiftId, effectiveFrom);
    success(res, result, 'Shift assigned successfully');
  } catch (err) {
    logger.error('Assign Shift Error:', err);
    error(res, 'Failed to assign shift', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get current staff member's shift
 */
export const getMyShift = async (req, res) => {
  try {
    const staffId = req.user?.uid;
    const shift = await shiftService.getStaffShift(staffId);
    success(res, shift || {}, 'Shift fetched');
  } catch (err) {
    logger.error('Get My Shift Error:', err);
    error(res, 'Failed to fetch shift', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Create a custom shift
 */
export const createCustomShift = async (req, res) => {
  try {
    const { name, start_time, end_time, grace_period_minutes, late_threshold_minutes, absent_threshold_minutes, department } = req.body;
    const shift = await shiftService.createCustomShift({ name, start_time, end_time, grace_period_minutes, late_threshold_minutes, absent_threshold_minutes, department });
    success(res, shift, 'Custom shift created');
  } catch (err) {
    logger.error('Create Custom Shift Error:', err);
    const status = err.message.includes('required') || err.message.includes('format') ? HTTP_STATUS.BAD_REQUEST : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    error(res, err.message, status);
  }
};

/**
 * Update a custom shift
 */
export const updateCustomShift = async (req, res) => {
  try {
    const { id } = req.params;
    const shift = await shiftService.updateCustomShift(id, req.body);
    success(res, shift, 'Shift updated');
  } catch (err) {
    logger.error('Update Custom Shift Error:', err);
    const status = err.message.includes('not found') ? HTTP_STATUS.NOT_FOUND
      : err.message.includes('cannot') ? HTTP_STATUS.FORBIDDEN
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    error(res, err.message, status);
  }
};

/**
 * Deactivate (soft-delete) a custom shift
 */
export const deactivateShift = async (req, res) => {
  try {
    const { id } = req.params;
    const shift = await shiftService.deactivateShift(id);
    success(res, shift, 'Shift deactivated');
  } catch (err) {
    logger.error('Deactivate Shift Error:', err);
    const status = err.message.includes('not found') ? HTTP_STATUS.NOT_FOUND
      : err.message.includes('cannot') ? HTTP_STATUS.FORBIDDEN
      : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    error(res, err.message, status);
  }
};
