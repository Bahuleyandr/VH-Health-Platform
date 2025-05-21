// src/routes/adminRoutes.js

import express from 'express';
import * as adminController from '../controllers/adminController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';

const router = express.Router();

/**
 * ✅ Admin-only maintenance routes
 * Centrally protected with RBAC, audit logging, and optional identity guards
 */
wrapAutoRBAC(router, 'adminRoutes', {
  get: [
    ['/r2/files', adminController.listR2Files],
    ['/logs/list', adminController.listLogs],

    // ✅ Add this new route for JWT validation testing
    ['/validate-jwt', (req, res) => {
      res.json({
        success: true,
        uid: req.user?.uid || null,
        role: req.user?.role || null,
        message: 'JWT and RBAC validation successful'
      });
    }]
  ],
  post: [
    ['/r2/cleanup', adminController.cleanupR2Files],
    ['/r2/migrate-archive', adminController.migrateR2Archive],
    ['/db/backup', adminController.backupDatabase],
    ['/db/restore', adminController.restoreDatabase],
    ['/logs/cleanup', adminController.cleanupLogs],
    ['/logs/purge', adminController.purgeLogs],
    ['/fix-permissions', adminController.fixPermissions],
    ['/swagger/validate', adminController.validateSwagger]
  ]
}, {
  requireUID: false,
  requirePhone: false
});

export default router;
