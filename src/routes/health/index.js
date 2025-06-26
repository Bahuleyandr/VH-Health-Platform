// src/routes/health/index.js
import express from 'express';
import { wrapRoutes, wrapAutoRBAC } from '../../config/routeWrapper.js';
import publicRoutes from './publicRoutes.js';
import protectedRoutes from './protectedRoutes.js';

const router = express.Router();
console.log('✅ healthRoutes loaded with RBAC protection');

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

// Protected routes with RBAC
wrapAutoRBAC(protectedRoutes, 'healthRecordsRoutes');

// Use protected routes
router.use('/', protectedRoutes);

export default router;