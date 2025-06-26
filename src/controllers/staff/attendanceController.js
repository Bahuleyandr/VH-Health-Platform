import * as attendanceService from '../../services/staff/attendanceService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';

export const markAttendance = async (req, res) => {
  try {
    const markedBy = req.user?.uid;
    const markerRole = req.user?.role;
    const markerName = req.user?.name;
    
    const result = await attendanceService.markAttendance(
      req.body,
      markedBy,
      markerRole,
      markerName
    );
    
    success(res, result, `Attendance ${result.action} recorded successfully`);
  } catch (err) {
    logger.error('Mark Attendance Error:', err);
    
    if (err.message === 'INSUFFICIENT_PERMISSIONS') {
      error(res, 'Insufficient permissions to mark attendance', HTTP_STATUS.FORBIDDEN);
    } else if (err.message === 'STAFF_NOT_FOUND') {
      error(res, 'Staff member not found', HTTP_STATUS.NOT_FOUND);
    } else {
      error(res, 'Failed to record attendance', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

export const getStaffAttendance = async (req, res) => {
  // Implementation...
};