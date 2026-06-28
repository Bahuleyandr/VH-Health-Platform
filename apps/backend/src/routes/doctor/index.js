// src/routes/doctor/index.js
import express from 'express';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import adminDoctorRoutes from './adminDoctorRoutes.js';
import doctorRoutes from './doctorRoutes.js';
import doctorStatsRoutes from './doctorStatsRoutes.js';

const router = express.Router();

// RBAC is applied at the per-prefix mounts below (requireRole on /stats and
// /admin; the '/' doctor directory is intentionally broad for the patient
// doctor-picker). The previous wrapAutoRBAC(<subrouter>, 'key', {}) calls here
// were inert no-ops (a subrouter passed as the 1st arg with an empty routeMap
// attaches no middleware) and were removed — see the no-op-RBAC guard test.

// Mount routes
router.use('/', doctorRoutes);
// HEAD-003: the wrapAutoRBAC above is a no-op (empty routeMap attaches no role
// middleware) and the /api/v1/doctors parent mount is publicCache-only, so the
// doctor stats endpoint (workload / patient-volume / revenue aggregates) was
// reachable by ANY authenticated user — the controller only restricts a DOCTOR
// to their own id, not patients/general staff. Gate the mount to admin/clinical
// leadership + doctors; the controller still enforces doctor-self-only.
router.use(
  '/stats',
  requireRole('ADMIN', 'SUPER_ADMIN', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT', 'DOCTOR'),
  doctorStatsRoutes,
);
// CAN-003: the wrapAutoRBAC above is a no-op (empty routeMap attaches no role
// middleware), and the /api/v1/doctors parent mount is publicCache-only with no
// requireRole — so the admin doctor-management mutations were reachable by any
// authenticated user. Gate the admin sub-mount explicitly. (The regular doctor
// directory at '/' stays broadly readable by design — patient doctor picker.)
router.use('/admin', requireRole('ADMIN'), adminDoctorRoutes);

export default router;