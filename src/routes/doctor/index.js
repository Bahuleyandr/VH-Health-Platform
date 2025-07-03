// src/routes/doctor/index.js
import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import doctorRoutes from './doctorRoutes.js';
import doctorStatsRoutes from './doctorStatsRoutes.js';
import adminDoctorRoutes from './adminDoctorRoutes.js';

const router = express.Router();

// Apply RBAC to regular doctor routes
wrapAutoRBAC(
  doctorRoutes,
  'doctorRoutes',
  {},
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true
  }
);

// Apply RBAC to stats routes
wrapAutoRBAC(
  doctorStatsRoutes,
  'doctorRoutes',
  {},
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true
  }
);

// Apply RBAC to admin routes (more restrictive)
wrapAutoRBAC(
  adminDoctorRoutes,
  'adminDoctorRoutes',
  {},
  {
    requireUID: false,
    requirePhone: false
  }
);

// Mount routes
router.use('/', doctorRoutes);
router.use('/stats', doctorStatsRoutes);
router.use('/admin', adminDoctorRoutes);

export default router;