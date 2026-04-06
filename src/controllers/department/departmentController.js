// src/controllers/department/departmentController.js
import { DEPARTMENT_MESSAGES } from '../../config/departmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import departmentService from '../../services/department/departmentService.js';
import { success, error } from '../../utils/responseHelper.js';

// For backward compatibility with existing routes
export const getAllDepartments = async (req, res) => {
  try {
    const result = await departmentService.getAllDepartments();
    
    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENTS_RETRIEVED);
  } catch (err) {
    logger.error('Error in getAllDepartments:', err);
    error(res, 'Failed to retrieve departments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentsWithDoctors = async (req, res) => {
  try {
    const departments = await departmentService.getDepartmentsWithDoctors();
    
    success(res, {
      departments,
      count: departments.length,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENTS_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentsWithDoctors:', err);
    error(res, 'Failed to retrieve departments with doctors', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentById = async (req, res) => {
  try {
    const { departmentId } = req.params;
    const department = await departmentService.getDepartmentById(departmentId);
    
    if (!department) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentById:', err);
    error(res, 'Failed to retrieve department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const addDepartment = async (req, res) => {
  try {
    // Check permissions
    if (!['ADMIN', 'SUPER_ADMIN', 'DOCTOR'].includes(req.user?.role)) {
      return error(res, DEPARTMENT_MESSAGES.INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
    }
    
    const department = await departmentService.createDepartment(req.body, req.user?.id);
    
    success(res, {
      department,
      createdBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_CREATED, HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Error in addDepartment:', err);
    
    if (err.message === 'Department with this name already exists') {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_EXISTS, HTTP_STATUS.CONFLICT);
    }
    if (err.message === 'Head doctor not found') {
      return error(res, DEPARTMENT_MESSAGES.HEAD_DOCTOR_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to create department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deleteDepartment = async (req, res) => {
  try {
    // Check permissions
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user?.role)) {
      return error(res, 'Only administrators can delete departments', HTTP_STATUS.FORBIDDEN);
    }
    
    const { departmentId } = req.params;
    const { reason = 'Deleted by admin' } = req.body;
    
    const department = await departmentService.deactivateDepartment(
      departmentId, 
      reason, 
      req.user?.id
    );
    
    if (!department) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department,
      reason,
      deactivatedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_DEACTIVATED);
  } catch (err) {
    logger.error('Error in deleteDepartment:', err);
    
    if (err.message.includes('Cannot deactivate department')) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    
    error(res, 'Failed to delete department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// New enhanced controllers
export const getDepartmentList = async (req, res) => {
  try {
    const result = await departmentService.getAllDepartments();
    
    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENTS_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentList:', err);
    error(res, 'Failed to retrieve departments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getAvailableDepartments = async (req, res) => {
  try {
    const result = await departmentService.getAvailableDepartments();
    
    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENTS_RETRIEVED);
  } catch (err) {
    logger.error('Error in getAvailableDepartments:', err);
    error(res, 'Failed to retrieve available departments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentDetails = async (req, res) => {
  try {
    const { identifier } = req.params;
    const department = await departmentService.getDepartmentById(identifier);
    
    if (!department) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department,
      requestedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentDetails:', err);
    error(res, 'Failed to retrieve department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createDepartment = async (req, res) => {
  try {
    // Check permissions
    if (!['ADMIN', 'SUPER_ADMIN', 'DOCTOR'].includes(req.user?.role)) {
      return error(res, DEPARTMENT_MESSAGES.INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
    }
    
    const department = await departmentService.createDepartment(req.body, req.user?.id);
    
    success(res, {
      department,
      createdBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_CREATED, HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Error in createDepartment:', err);
    
    if (err.message === 'Department with this name already exists') {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_EXISTS, HTTP_STATUS.CONFLICT);
    }
    if (err.message === 'Head doctor not found') {
      return error(res, DEPARTMENT_MESSAGES.HEAD_DOCTOR_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to create department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateDepartment = async (req, res) => {
  try {
    // Check permissions
    if (!['ADMIN', 'SUPER_ADMIN', 'DOCTOR'].includes(req.user?.role)) {
      return error(res, DEPARTMENT_MESSAGES.INSUFFICIENT_PERMISSIONS, HTTP_STATUS.FORBIDDEN);
    }
    
    const { id } = req.params;
    const department = await departmentService.updateDepartment(id, req.body, req.user?.id);
    
    if (!department) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department,
      updatedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_UPDATED);
  } catch (err) {
    logger.error('Error in updateDepartment:', err);
    
    if (err.message === 'Head doctor not found') {
      return error(res, DEPARTMENT_MESSAGES.HEAD_DOCTOR_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to update department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deactivateDepartment = async (req, res) => {
  try {
    // Check permissions
    if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user?.role)) {
      return error(res, 'Only administrators can deactivate departments', HTTP_STATUS.FORBIDDEN);
    }
    
    const { id } = req.params;
    const { reason = 'Deactivated by admin' } = req.body;
    
    const department = await departmentService.deactivateDepartment(
      id, 
      reason, 
      req.user?.id
    );
    
    if (!department) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department,
      reason,
      deactivatedBy: req.user?.name
    }, DEPARTMENT_MESSAGES.DEPARTMENT_DEACTIVATED);
  } catch (err) {
    logger.error('Error in deactivateDepartment:', err);
    
    if (err.message.includes('Cannot deactivate department')) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    
    error(res, 'Failed to deactivate department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};