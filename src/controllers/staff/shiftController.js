import * as shiftService from '../../services/staff/shiftService.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';

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
