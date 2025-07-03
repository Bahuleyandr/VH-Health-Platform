// src/routes/notification/index.js

import express from 'express';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import notificationRoutes from './notificationRoutes.js';
import adminNotificationRoutes from './adminNotificationRoutes.js';
import logger from '../../logging/logger.js';

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
wrapAutoRBAC(router, 'notificationRoutes', {
  get: [
    // Get notifications by phone or user ID
    ['/:phone', notificationRoutes],
    ['/user/:user_id', notificationRoutes],
    ['/detail/:id', notificationRoutes],
    ['/list', notificationRoutes]
  ],
  patch: [
    // Mark notifications as read
    ['/:id/read', notificationRoutes],
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

// Admin-only routes
wrapAutoRBAC(router, 'adminNotificationRoutes', {
  get: [
    ['/admin/test', adminNotificationRoutes],
    ['/admin/overview', adminNotificationRoutes],
    ['/admin/manage', adminNotificationRoutes],
    ['/admin/templates', adminNotificationRoutes],
    ['/admin/delivery-stats', adminNotificationRoutes]
  ],
  post: [
    ['/admin', adminNotificationRoutes],
    ['/admin/announcement', adminNotificationRoutes],
    ['/admin/targeted', adminNotificationRoutes],
    ['/admin/bulk-operations', adminNotificationRoutes],
    ['/admin/templates', adminNotificationRoutes],
    ['/admin/send-from-template', adminNotificationRoutes]
  ],
  delete: [
    ['/admin/cleanup', adminNotificationRoutes]
  ]
}, {
  requireUID: false,
  requirePhone: false
});

// Export the configured router
export default router;