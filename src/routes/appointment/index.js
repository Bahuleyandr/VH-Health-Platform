import express from 'express';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import appointmentCrudRoutes from './appointmentCrudRoutes.js';
import appointmentLegacyRoutes from './appointmentLegacyRoutes.js';
import appointmentListRoutes from './appointmentListRoutes.js';

const router = express.Router();
console.log('✅ Appointment routes loaded with RBAC protection');

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

export default router;