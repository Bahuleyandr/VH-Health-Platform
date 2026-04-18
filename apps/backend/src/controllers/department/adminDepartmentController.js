// src/controllers/department/adminDepartmentController.js
import { DEPARTMENT_MESSAGES } from '../../config/departmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import adminDepartmentService from '../../services/department/adminDepartmentService.js';
import departmentAuditService from '../../services/department/departmentAuditService.js';
import departmentExportService from '../../services/department/departmentExportService.js';
import { success, error } from '../../utils/responseHelper.js';

export const getDepartmentOverview = async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const overview = await adminDepartmentService.getDepartmentOverview(
      parseInt(page), 
      parseInt(limit)
    );
    
    success(res, {
      overview,
      generated_at: new Date().toISOString()
    }, DEPARTMENT_MESSAGES.OVERVIEW_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentOverview:', err);
    error(res, 'Failed to retrieve department overview', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentManagementData = async (req, res) => {
  try {
    const { status, search } = req.query;
    const departments = await adminDepartmentService.getDepartmentManagementData({ status, search });
    
    success(res, {
      departments,
      count: departments.length,
      filters: {
        status: status || 'active',
        search: search || null
      }
    }, 'Department management data retrieved successfully');
  } catch (err) {
    logger.error('Error in getDepartmentManagementData:', err);
    error(res, 'Failed to retrieve department management data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentFinancialOverview = async (req, res) => {
  try {
    const { id } = req.params;
    const months = parseInt(req.query.months) || 6;
    
    const financialData = await adminDepartmentService.getDepartmentFinancialData(id, months);
    
    if (!financialData) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      ...financialData,
      generated_at: new Date().toISOString()
    }, DEPARTMENT_MESSAGES.FINANCIAL_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentFinancialOverview:', err);
    error(res, 'Failed to retrieve department financial data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDepartmentStaffAllocation = async (req, res) => {
  try {
    const { id } = req.params;
    const allocation = await adminDepartmentService.getDepartmentStaffAllocation(id);
    
    if (!allocation) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, allocation, DEPARTMENT_MESSAGES.STAFF_ALLOCATION_RETRIEVED);
  } catch (err) {
    logger.error('Error in getDepartmentStaffAllocation:', err);
    error(res, 'Failed to retrieve staff allocation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createDepartment = async (req, res) => {
  try {
    const department = await adminDepartmentService.createDepartmentWithValidation({
      ...req.body,
      created_by: req.user?.id
    });
    
    success(res, {
      department
    }, DEPARTMENT_MESSAGES.DEPARTMENT_CREATED, HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Error in createDepartment:', err);
    
    if (err.message.includes('already exists')) {
      return error(res, err.message, HTTP_STATUS.CONFLICT);
    }
    if (err.message.includes('not found')) {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to create department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const department = await adminDepartmentService.updateDepartment(id, {
      ...req.body,
      updated_by: req.user?.id
    });
    
    if (!department) {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    success(res, {
      department
    }, DEPARTMENT_MESSAGES.DEPARTMENT_UPDATED);
  } catch (err) {
    logger.error('Error in updateDepartment:', err);
    
    if (err.message.includes('already head')) {
      return error(res, err.message, HTTP_STATUS.CONFLICT);
    }
    if (err.message.includes('not found')) {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to update department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const performBulkOperation = async (req, res) => {
  try {
    const { operation, department_ids, data } = req.body;
    
    const result = await adminDepartmentService.performBulkOperation(
      operation,
      department_ids,
      data
    );
    
    success(res, result, DEPARTMENT_MESSAGES.BULK_OPERATION_SUCCESS);
  } catch (err) {
    logger.error('Error in performBulkOperation:', err);
    
    if (err.message.includes('not found')) {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    if (err.message === 'Invalid operation') {
      return error(res, DEPARTMENT_MESSAGES.INVALID_OPERATION, HTTP_STATUS.BAD_REQUEST);
    }
    
    error(res, 'Failed to perform bulk operation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const deactivateDepartmentWithReassignment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, reassign_to_department } = req.body;
    
    const result = await adminDepartmentService.deactivateDepartmentWithReassignment(
      id,
      reason,
      reassign_to_department
    );
    
    success(res, result, DEPARTMENT_MESSAGES.DEPARTMENT_DEACTIVATED);
  } catch (err) {
    logger.error('Error in deactivateDepartmentWithReassignment:', err);
    
    if (err.message.includes('not found')) {
      return error(res, err.message, HTTP_STATUS.NOT_FOUND);
    }
    if (err.message.includes('already inactive')) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    if (err.message.includes('Cannot deactivate')) {
      return error(res, err.message, HTTP_STATUS.BAD_REQUEST);
    }
    
    error(res, 'Failed to deactivate department', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const testAdminDepartmentRoutes = (req, res) => {
  res.json({ 
    message: 'Admin department routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    user: req.user?.role || 'anonymous'
  });
};

export const getDepartmentHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;
    
    const history = await departmentAuditService.getDepartmentHistory(
      id, 
      parseInt(limit)
    );
    
    success(res, {
      department_id: id,
      history,
      count: history.length
    }, 'Department history retrieved successfully');
  } catch (err) {
    logger.error('Error in getDepartmentHistory:', err);
    error(res, 'Failed to retrieve department history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getRecentActivities = async (req, res) => {
  try {
    const { days = 7, limit = 100 } = req.query;
    
    const activities = await departmentAuditService.getRecentDepartmentActivities(
      parseInt(days),
      parseInt(limit)
    );
    
    success(res, {
      activities,
      count: activities.length,
      period_days: parseInt(days)
    }, 'Recent activities retrieved successfully');
  } catch (err) {
    logger.error('Error in getRecentActivities:', err);
    error(res, 'Failed to retrieve recent activities', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const exportDepartmentsCSV = async (req, res) => {
  try {
    const { status } = req.query;
    const exportData = await departmentExportService.exportDepartmentsToCSV({ status });
    
    // Convert to CSV format
    const csvContent = [
      exportData.headers.join(','),
      ...exportData.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=departments_export.csv');
    res.send(csvContent);
  } catch (err) {
    logger.error('Error in exportDepartmentsCSV:', err);
    error(res, 'Failed to export departments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const exportDepartmentReport = async (req, res) => {
  try {
    const { id } = req.params;
    const report = await departmentExportService.exportDepartmentReport(id);
    
    success(res, {
      report,
      generated_at: new Date().toISOString()
    }, 'Department report generated successfully');
  } catch (err) {
    logger.error('Error in exportDepartmentReport:', err);
    
    if (err.message === 'Department not found') {
      return error(res, DEPARTMENT_MESSAGES.DEPARTMENT_NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    
    error(res, 'Failed to generate department report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};