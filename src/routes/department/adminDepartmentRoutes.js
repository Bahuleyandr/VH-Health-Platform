// src/routes/department/adminDepartmentRoutes.js
import express from 'express';
import * as adminDepartmentController from '../../controllers/department/adminDepartmentController.js';
import { createAdminDepartmentValidation,
  updateAdminDepartmentValidation,
  getFinancialDataValidation,
  getStaffAllocationValidation,
  bulkOperationValidation,
  deactivateWithReassignmentValidation,
  getManagementDataValidation } from '../../validators/department/adminDepartmentValidator.js';
import {  getDepartmentHistoryValidation
} from '../../validators/department/departmentAuditValidator.js';
import { checkAdminPermission } from '../../validators/department/departmentValidator.js';

const router = express.Router();

// Apply admin permission check to all routes
router.use(checkAdminPermission);

// Test route
router.get('/test', adminDepartmentController.testAdminDepartmentRoutes);

// Admin department management routes
router.get('/overview', adminDepartmentController.getDepartmentOverview);
router.get('/manage', getManagementDataValidation, adminDepartmentController.getDepartmentManagementData);

// Department-specific admin routes
router.get('/:id/financial', getFinancialDataValidation, adminDepartmentController.getDepartmentFinancialOverview);
router.get('/:id/staff-allocation', getStaffAllocationValidation, adminDepartmentController.getDepartmentStaffAllocation);

// Department operations
router.post('/create', createAdminDepartmentValidation, adminDepartmentController.createDepartment);
router.post('/bulk-operations', bulkOperationValidation, adminDepartmentController.performBulkOperation);
router.put('/:id', updateAdminDepartmentValidation, adminDepartmentController.updateDepartment);
router.put('/:id/deactivate', deactivateWithReassignmentValidation, adminDepartmentController.deactivateDepartmentWithReassignment);

// Export routes
router.get('/export/csv', adminDepartmentController.exportDepartmentsCSV);
router.get('/:id/export/report', adminDepartmentController.exportDepartmentReport);

// Audit routes
router.get('/:id/history', getDepartmentHistoryValidation, adminDepartmentController.getDepartmentHistory);
router.get('/activities/recent', adminDepartmentController.getRecentActivities);

export default router;