// src/routes/health/index.js
import express from 'express';
import { wrapRoutes, wrapAutoRBAC } from '../../config/routeWrapper.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
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

// Protected routes with RBAC
// Note: This module is mounted before global jwtAuth in app.js (public health checks),
// so we apply API key + JWT auth inline for patient-data routes.
wrapAutoRBAC(protectedRoutes, 'healthRecordsRoutes');

// Use protected routes — require API key + JWT for patient health data
router.use('/', validateApiKey, jwtAuth, protectedRoutes);

export default router;