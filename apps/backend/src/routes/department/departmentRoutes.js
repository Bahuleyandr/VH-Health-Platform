// src/routes/department/departmentRoutes.js
import express from 'express';
import * as departmentController from '../../controllers/department/departmentController.js';
import {
  createDepartmentValidation,
  updateDepartmentValidation,
  getDepartmentByIdValidation,
  deactivateDepartmentValidation,
  getAvailableDepartmentsValidation,
  departmentListValidation,
  checkDepartmentPermission,
  checkAdminPermission
} from '../../validators/department/departmentValidator.js';

const router = express.Router();

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Department routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    user: req.user?.name || 'Unknown'
  });
});

// Legacy routes (maintained for backward compatibility)
router.get('/', departmentListValidation, departmentController.getAllDepartments);
router.get('/departments-with-doctors', departmentController.getDepartmentsWithDoctors);
router.post('/', createDepartmentValidation, checkDepartmentPermission, departmentController.addDepartment);
router.delete('/:departmentId', checkAdminPermission, departmentController.deleteDepartment);

// Enhanced department routes
router.get('/list', departmentListValidation, departmentController.getDepartmentList);
router.get('/available/now', getAvailableDepartmentsValidation, departmentController.getAvailableDepartments);
router.post('/create', createDepartmentValidation, checkDepartmentPermission, departmentController.createDepartment);
router.put('/:id', updateDepartmentValidation, checkDepartmentPermission, departmentController.updateDepartment);
router.put('/:id/deactivate', deactivateDepartmentValidation, checkAdminPermission, departmentController.deactivateDepartment);

// Get department by ID or name (should be last to avoid conflicts)
router.get('/:identifier', getDepartmentByIdValidation, departmentController.getDepartmentDetails);

export default router;