import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as staffService from '../../services/staff/staffService.js';
import { parseListQuery } from '../../utils/listQuery.js';
import { success, error } from '../../utils/responseHelper.js';

// Get staff list with filtering
export const getStaffList = async (req, res) => {
  try {
    const listQuery = parseListQuery(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'name',
    });
    const filters = {
      page: listQuery.page,
      limit: listQuery.limit,
      role: req.query.role,
      department: req.query.department,
      shift: req.query.shift,
      active: req.query.active !== 'false',
      search: listQuery.search,
      supervisor_id: req.query.supervisor_id,
      skill: req.query.skill
    };

    const userRole = req.user?.role;
    const result = await staffService.getStaffList(filters, userRole);

    success(res, result, 'Staff directory retrieved successfully');
  } catch (err) {
    logger.error('Staff List Error:', err);
    error(res, 'Failed to retrieve staff directory', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get individual staff profile
export const getStaffProfile = async (req, res) => {
  try {
    const { identifier } = req.params;
    const includePrivate = req.query.include_private === 'true';
    const userRole = req.user?.role;
    const userId = req.user?.uid;

    const profile = await staffService.getStaffProfile(identifier, userRole, userId, includePrivate);

    success(res, profile, 'Staff profile retrieved successfully');
  } catch (err) {
    logger.error('Staff Profile Error:', err);
    if (err.message === 'NOT_FOUND') {
      error(res, 'Staff member not found or access denied', HTTP_STATUS.NOT_FOUND);
    } else {
      error(res, 'Failed to retrieve staff profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

// Create staff profile
export const createStaffProfile = async (req, res) => {
  try {
    const userRole = req.user?.role;
    const createdBy = req.user?.uid;
    const creatorName = req.user?.name;

    // Check permissions
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      return error(res, 'Insufficient permissions to create staff profiles', HTTP_STATUS.FORBIDDEN);
    }

    const profile = await staffService.createStaffProfile(req.body, createdBy, creatorName, req.headers['x-forwarded-for'] || req.socket?.remoteAddress);

    success(res, profile, 'Staff profile created successfully');
  } catch (err) {
    logger.error('Create Staff Profile Error:', err);
    
    if (err.message === 'USER_NOT_FOUND') {
      error(res, 'User not found', HTTP_STATUS.NOT_FOUND);
    } else if (err.message === 'INVALID_ROLE') {
      error(res, 'User must have a valid staff role', HTTP_STATUS.BAD_REQUEST);
    } else if (err.message === 'PROFILE_EXISTS') {
      error(res, 'Staff profile already exists for this user', HTTP_STATUS.CONFLICT);
    } else if (err.message === 'EMPLOYEE_ID_EXISTS') {
      error(res, 'Employee ID already exists', HTTP_STATUS.CONFLICT);
    } else {
      error(res, 'Failed to create staff profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

// Update staff profile
export const updateStaffProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role;
    const updatedBy = req.user?.uid;
    const updaterName = req.user?.name;

    // Check permissions
    if (!['ADMIN', 'HR_STAFF'].includes(userRole)) {
      return error(res, 'Insufficient permissions to update staff profiles', HTTP_STATUS.FORBIDDEN);
    }

    const result = await staffService.updateStaffProfile(
      id, 
      req.body, 
      updatedBy, 
      updaterName,
      req.headers['x-forwarded-for'] || req.socket?.remoteAddress
    );

    success(res, result, 'Staff profile updated successfully');
  } catch (err) {
    logger.error('Update Staff Profile Error:', err);
    
    if (err.message === 'NOT_FOUND') {
      error(res, 'Staff profile not found', HTTP_STATUS.NOT_FOUND);
    } else if (err.message === 'INVALID_SUPERVISOR') {
      error(res, 'Invalid supervisor ID or supervisor lacks appropriate role', HTTP_STATUS.BAD_REQUEST);
    } else {
      error(res, 'Failed to update staff profile', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};

// Get staff by department
export const getStaffByDepartment = async (req, res) => {
  try {
    const { department } = req.params;
    const { shift, include_inactive = false } = req.query;
    const userRole = req.user?.role;

    const result = await staffService.getStaffByDepartment(department, shift, include_inactive, userRole);

    success(res, result, `Staff in ${department} department retrieved successfully`);
  } catch (err) {
    logger.error('Department Staff Error:', err);
    error(res, 'Failed to retrieve department staff', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get staff by shift
export const getStaffByShift = async (req, res) => {
  try {
    const { shift } = req.params;
    const { department, date = new Date().toISOString().split('T')[0] } = req.query;
    const userRole = req.user?.role;

    const result = await staffService.getStaffByShift(shift, department, date, userRole);

    success(res, result, `Staff on ${shift} shift retrieved successfully`);
  } catch (err) {
    logger.error('Shift Staff Error:', err);
    error(res, 'Failed to retrieve shift staff', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get staff statistics
export const getStaffStatistics = async (req, res) => {
  try {
    const userRole = req.user?.role;
    const { timeframe = 'current' } = req.query;

    const stats = await staffService.getStaffStatistics(userRole, timeframe);

    success(res, stats, 'Staff statistics retrieved successfully');
  } catch (err) {
    logger.error('Staff Statistics Error:', err);
    error(res, 'Failed to retrieve staff statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
