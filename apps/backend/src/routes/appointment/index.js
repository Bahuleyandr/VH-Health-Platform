// src/routes/appointment/index.js
import express from 'express';
import { ADMIN_ROUTE_ROLES, APPOINTMENT_STAFF_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import appointmentAdminRoutes from './appointmentAdminRoutes.js';
import appointmentCrudRoutes from './appointmentCrudRoutes.js';
import appointmentLegacyRoutes from './appointmentLegacyRoutes.js';
import appointmentListRoutes from './appointmentListRoutes.js';
import appointmentQueueDisplayRoutes from './appointmentQueueDisplayRoutes.js';
import appointmentWaitTimeRoutes from './appointmentWaitTimeRoutes.js';
import appointmentWorkflowRoutes from './appointmentWorkflowRoutes.js';

const router = express.Router();

// NOTE (audit finding H2, 2026-06-10): this file previously called
// `wrapAutoRBAC(router, 'appointmentRoutes', { get: [], post: [], ... })`.
// With an empty route map that call attaches NOTHING (applyWrappers only
// wraps routes present in the map) — the router had no RBAC at all.
// The role gate now lives at the app.js mount
// (`requireRole(...APPOINTMENT_ROUTE_ROLES)`), staff-only routes re-narrow
// inside the sub-routers, and admin routes are gated below.

// Mount sub-routes
// Wait time routes (static paths: /doctor/:doctorId/wait-time, /:id/wait-time)
router.use('/', appointmentWaitTimeRoutes);
// PHI-free queue TV display reads; staff-only because the route lists operational tokens.
router.use('/queue-displays', requireRole(...APPOINTMENT_STAFF_ROUTE_ROLES), appointmentQueueDisplayRoutes);
// Workflow routes (static paths: /queue/today, /pending, /patient/records/*, /admin/*)
router.use('/', appointmentWorkflowRoutes);
router.use('/', appointmentListRoutes);
router.use('/', appointmentCrudRoutes);
router.use('/', appointmentLegacyRoutes);
// Admin routes under /admin prefix — admin-only, gated here AND inside the
// sub-router (its wrapAutoRBAC config key now resolves to real roles).
router.use('/admin', requireRole(...ADMIN_ROUTE_ROLES), appointmentAdminRoutes);

export default router;
