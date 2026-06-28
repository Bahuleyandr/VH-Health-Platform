// src/routes/health/index.js
import express from 'express';
import { wrapRoutes } from '../../config/routeWrapper.js';
import rbacConfig from '../../config/rbacConfig.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import tenantContextMiddleware from '../../middleware/tenantContextMiddleware.js';
import tenantRlsMiddleware from '../../middleware/tenantRlsMiddleware.js';
import validateApiKey from '../../middleware/validateApiKey.js';
import logger from '../../logging/logger.js';
import protectedRoutes from './protectedRoutes.js';
import publicRoutes from './publicRoutes.js';
import uptimeRoutes from './uptimeRoutes.js';

const router = express.Router();
logger.info('✅ healthRoutes loaded with RBAC protection');

// Public routes (no authentication required)
wrapRoutes(
  publicRoutes,
  [], // No roles required
  {
    get: publicRoutes.stack
      .filter(layer => layer.route && layer.route.methods.get)
      .map(layer => [layer.route.path, ...layer.route.stack.map(s => s.handle)])
  },
  {
    requireUID: false,
    requirePhone: false
  }
);

// Use public routes
router.use('/', publicRoutes);

// Uptime monitoring endpoints (public, no auth)
router.use('/', uptimeRoutes);

// Protected routes (patient health data). This module is mounted BEFORE the
// global jwtAuth + tenant middleware in app.js (so the public health checks
// above stay open), so the full PHI middleware chain is applied inline here.
//
// CAN-028/029: the previous `wrapAutoRBAC(protectedRoutes, 'healthRecordsRoutes')`
// passed an EMPTY routeMap → a no-op, so these routes were reachable by ANY
// authenticated user with no tenant scoping. Apply real RBAC (the
// healthRecordsRoutes role set), tenant context, and RLS so reads/writes are
// role-gated and tenant-scoped (raw queries here auto-scope under the AsyncLocal
// tenant context when AUTH_ENFORCE_TENANT_RLS=true).
router.use(
  '/',
  validateApiKey,
  jwtAuth,
  tenantContextMiddleware,
  tenantRlsMiddleware,
  requireRole(...rbacConfig.healthRecordsRoutes),
  protectedRoutes,
);

export default router;