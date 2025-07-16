// src/routes/department/index.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import adminDepartmentRoutes from './adminDepartmentRoutes.js';
import departmentRoutes from './departmentRoutes.js';
import departmentStatsRoutes from './departmentStatsRoutes.js';

const router = express.Router();

// Mount sub-routes
router.use('/', departmentRoutes);
router.use('/stats', departmentStatsRoutes);
router.use('/admin', adminDepartmentRoutes);

// Apply RBAC wrapper to the main router
export default wrapAutoRBAC(
  router,
  'departmentRoutes',
  {},
  {
    requireUID: true,       // Require user authentication
    requirePhone: false,    // Phone not required for department operations
    auditLog: true,        // Enable audit logging
    rateLimiting: true,    // Enable rate limiting
    roles: ['ADMIN', 'DOCTOR', 'NURSE', 'PATIENT'] // Different access levels for different operations
  }
);