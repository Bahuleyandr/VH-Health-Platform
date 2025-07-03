// src/routes/user/index.js
import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../../config/routeWrapper.js';
import userRoutes from './userRoutes.js';
import adminUserRoutes from './adminUserRoutes.js';
import lookupRoutes from './lookupRoutes.js';

const router = express.Router();

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