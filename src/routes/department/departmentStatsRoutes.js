// src/routes/department/departmentStatsRoutes.js
import express from 'express';
import * as departmentStatsController from '../../controllers/department/departmentStatsController.js';
import {
  getDepartmentStatsValidation
} from '../../validators/department/departmentValidator.js';

const router = express.Router();

// Department statistics routes
router.get('/comparison', departmentStatsController.getDepartmentComparison);
router.get('/:id', getDepartmentStatsValidation, departmentStatsController.getDepartmentStats);
router.get('/:id/performance', getDepartmentStatsValidation, departmentStatsController.getDepartmentPerformance);
router.get('/:id/trends', getDepartmentStatsValidation, departmentStatsController.getDepartmentTrends);
router.get('/:id/analytics', getDepartmentStatsValidation, departmentStatsController.getDepartmentAnalytics);

// Legacy route for backward compatibility
router.get('/:id/stats', getDepartmentStatsValidation, departmentStatsController.getDepartmentStats);

export default router;