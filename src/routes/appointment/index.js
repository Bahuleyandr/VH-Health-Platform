// src/routes/appointment/index.js
import express from 'express';
import logger from '../../logging/logger.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import appointmentAdminRoutes from './appointmentAdminRoutes.js';
import appointmentCrudRoutes from './appointmentCrudRoutes.js';
import appointmentLegacyRoutes from './appointmentLegacyRoutes.js';
import appointmentListRoutes from './appointmentListRoutes.js';

const router = express.Router();
logger.info('✅ Appointment routes loaded with RBAC protection');

// Apply RBAC wrapper to entire router
wrapAutoRBAC(
  router,
  'appointmentRoutes',
  {
    // Routes will be added by sub-routers
    get: [],
    post: [],
    put: [],
    delete: []
  },
  {
    requireUID: true,
    requirePhone: false,
    auditLog: true,
    rateLimiting: true,
    roles: ['ADMIN', 'DOCTOR', 'PATIENT', 'NURSE', 'RECEPTIONIST']
  }
);

// Mount sub-routes
router.use('/', appointmentListRoutes);
router.use('/', appointmentCrudRoutes);
router.use('/', appointmentLegacyRoutes);
router.use('/admin', appointmentAdminRoutes); // Admin routes under /admin prefix

export default router;