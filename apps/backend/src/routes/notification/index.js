// src/routes/notification/index.js

import express from 'express';
import { ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import adminNotificationRoutes from './adminNotificationRoutes.js';
import notificationRoutes from './notificationRoutes.js';

const router = express.Router();
logger.info('✅ Notification Module loaded with RBAC protection');

/**
 * Notification Module Routes
 * Base path: /api/v1/notifications
 * 
 * Role-based access:
 * - PATIENT: Can view/manage own notifications only
 * - DOCTOR, NURSING_STAFF: Can create notifications and view stats
 * - ADMIN: Full access including bulk operations and management
 */

// Public test route (no auth required)
wrapRoutesWithValidation(
  router,
  [], // No roles required
  {
    get: [
      ['/test', (req, res, next) => {
        req.url = '/test';
        notificationRoutes.handle(req, res, next);
      }]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// User notification routes - accessible by all authenticated users
// Note: `notificationRoutes` is an Express Router object passed as a handler.
// This is valid because Express Routers are middleware functions — when a request
// matches the path registered here, it is forwarded to the notificationRoutes
// router which matches its own internal route definitions to find the final handler.
wrapAutoRBAC(router, 'notificationRoutes', {
  get: [
    // Get notifications by phone or user ID
    ['/my', notificationRoutes],
    ['/:phone', notificationRoutes],
    ['/user/:user_id', notificationRoutes],
    ['/detail/:id', notificationRoutes],
    ['/detail/:id/events', notificationRoutes],
    ['/list', notificationRoutes]
  ],
  patch: [
    // Mark notifications as read
    ['/my/mark-all-read', notificationRoutes],
    ['/:id/read', notificationRoutes],
    ['/:id/acknowledge', notificationRoutes],
    ['/:phone/mark-all-read', notificationRoutes],
    ['/user/:user_id/read-all', notificationRoutes]
  ]
});

// Medical staff routes (DOCTOR, NURSING_STAFF, ADMIN)
wrapAutoRBAC(router, 'ALL', {
  post: [
    ['/create', notificationRoutes],
    ['/bulk', notificationRoutes]
  ],
  get: [
    ['/stats/summary', notificationRoutes],
    ['/scheduled/pending', notificationRoutes],
    ['/emergency/active', notificationRoutes]
  ],
  delete: [
    ['/:id', notificationRoutes]
  ]
});

// Admin-only routes — mounted via `router.use` so the full
// adminNotificationRoutes sub-router resolves. The earlier wrapAutoRBAC
// form registered each admin path as a handler invocation of the sub-
// router, but Express doesn't strip the path prefix under
// `router.get(path, subRouter)` so sub-routes like GET `/manage` never
// matched against the incoming `/admin/manage` request — everything under
// `/api/v1/notifications/admin/*` was 404'ing. Using `router.use('/admin',
// subRouter)` strips the prefix so GET `/admin/manage` correctly hits
// GET `/manage` in adminNotificationRoutes.
router.use('/admin', requireRole(...ADMIN_ROUTE_ROLES), adminNotificationRoutes);

// Export the configured router
export default router;
