// src/routes/user/index.js
import express from 'express';
import { wrapAutoRBAC, wrapRoutes } from '../../config/routeWrapper.js';
import adminUserRoutes from './adminUserRoutes.js';
import dependentsRoutes from './dependentsRoutes.js';
import familyRoutes from './familyRoutes.js';
import lookupRoutes from './lookupRoutes.js';
import publicKeyRoutes from './publicKeyRoutes.js';
import userRoutes from './userRoutes.js';
import userSelfRoutes from './userSelfRoutes.js';

const router = express.Router();

// Family member routes (static path — must come before /:identifier).
// `family-members` is an address book of non-account contacts; `dependents`
// is the guardian-with-own-account model from migration 202.
router.use('/family-members', familyRoutes);
router.use('/dependents', dependentsRoutes);

// E2E public-key directory — mounted before the wildcard userRoutes so
// /me/public-key and /:id/public-key don't get swallowed by /:identifier.
router.use('/', publicKeyRoutes);

// Self-service routes (POST /profile, GET /me) — PATIENT-allowed. Mounted
// BEFORE the directory router so /me resolves here, not as /:identifier.
wrapAutoRBAC(router, 'userSelfRoutes', {
  use: [
    ['/', userSelfRoutes]
  ]
});

// Database/system metadata is admin-only and this static one-segment path must
// be registered before the directory router's GET /:identifier wildcard.
wrapRoutes(
  router,
  ['ADMIN'],
  {
    get: [
      ['/system-info', async (_req, res) => {
        const { AdminUserService } = await import('../../services/user/adminUserService.js');
        const systemInfo = await AdminUserService.getSystemInfo();
        res.json({
          success: true,
          data: systemInfo,
          message: 'System information retrieved successfully'
        });
      }]
    ]
  },
  {
    requireUID: true,
    requirePhone: false
  }
);

// Lookup routes - accessible to staff. Mounted BEFORE the directory router:
// userRoutes' GET /:identifier would otherwise capture "lookup" as an
// identifier, making GET /users/lookup unreachable (uuid-cast 500).
wrapAutoRBAC(router, 'lookupRoutes', {
  use: [
    ['/lookup', lookupRoutes]
  ]
});

// User directory routes (list/get/search/role/department) — staff/admin only.
wrapAutoRBAC(router, 'userRoutes', {
  use: [
    ['/', userRoutes]
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

export default router;
