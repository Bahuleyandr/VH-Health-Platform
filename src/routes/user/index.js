// src/routes/user/index.js
import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../../config/routeWrapper.js';
import adminUserRoutes from './adminUserRoutes.js';
import familyRoutes from './familyRoutes.js';
import lookupRoutes from './lookupRoutes.js';
import publicKeyRoutes from './publicKeyRoutes.js';
import userRoutes from './userRoutes.js';

const router = express.Router();

// Family member routes (static path — must come before /:identifier)
router.use('/family-members', familyRoutes);

// E2E public-key directory — mounted before the wildcard userRoutes so
// /me/public-key and /:id/public-key don't get swallowed by /:identifier.
router.use('/', publicKeyRoutes);

// Regular user routes - accessible based on RBAC
wrapAutoRBAC(router, 'userRoutes', {
  use: [
    ['/', userRoutes]
  ]
});

// Lookup routes - accessible to staff
wrapAutoRBAC(router, 'lookupRoutes', {
  use: [
    ['/lookup', lookupRoutes]
  ]
});

// Admin-only user management routes
wrapRoutes(
  router,
  ['ADMIN'],
  {
    use: [
      ['/admin', adminUserRoutes]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// Public system info route
router.get('/system-info', async (req, res) => {
  const { AdminUserService } = await import('../../services/user/adminUserService.js');
  const systemInfo = await AdminUserService.getSystemInfo();
  res.json({
    success: true,
    data: systemInfo,
    message: 'System information retrieved successfully'
  });
});

export default router;