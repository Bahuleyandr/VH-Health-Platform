// src/routes/notification/index.js

import express from 'express';
import { ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../../config/routeWrapper.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import adminNotificationRoutes from './adminNotificationRoutes.js';
import notificationRoutes from './notificationRoutes.js';
import { error } from '../../utils/responseHelper.js';

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
    // Self-service (JWT-derived) + authorized staff by user id. The legacy
    // by-phone route was removed (PII-in-URL; collided with by-id).
    ['/my', notificationRoutes],
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

// Legacy phone-number routes (GET /:phone, PATCH /:phone/mark-all-read) were
// removed — PII-in-URL is unsafe. The gatekeeper above forwards only the
// curated allowlist to notificationRoutes, so a bare phone segment otherwise
// falls through to a confusing app-level 404. Return an explicit 410 Gone for
// the phone-shaped (numeric) paths so callers get a clear "use /my" deprecation
// signal. Numeric-guarded + registered after every real route so it can never
// shadow one; non-numeric single segments fall through (404).
const legacyPhoneRouteGone = (req, res, next) => {
  if (!/^\d+$/.test(req.params.phone)) return next();
  return error(
    res,
    'Phone-number notification routes have been removed — use GET /api/v1/notifications/my.',
    410,
  );
};
router.get('/:phone', legacyPhoneRouteGone);
router.patch('/:phone/mark-all-read', legacyPhoneRouteGone);

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
