import express from 'express';
import * as adminController from '../controllers/adminController.js';
import { wrapAutoRBAC } from '../config/routeWrapper.js';
import validateApiKey from '../middleware/validateApiKey.js';
import jwtMiddleware from '../middleware/jwtMiddleware.js';
import rbac from '../middleware/rbacMiddleware.js';

const router = express.Router();

/**
 * ✅ Admin-only maintenance routes
 * Centrally protected with RBAC, audit logging, and optional identity guards
 */
wrapAutoRBAC(router, 'adminRoutes', {
  get: [
    ['/r2/files', adminController.listR2Files],
    ['/logs/list', adminController.listLogs],

    ['/validate-jwt', (req, res) => {
      res.json({
        success: true,
        uid: req.user?.uid || null,
        role: req.user?.role || null,
        message: 'JWT and RBAC validation successful'
      });
    }],

    ['/users/audit', adminController.viewRoleAudit],

    // ✅ Audit logs viewer
    ['/audit/logs', adminController.getAuditLogs]
  ],
  post: [
    ['/r2/cleanup', adminController.cleanupR2Files],
    ['/r2/migrate-archive', adminController.migrateR2Archive],
    ['/db/backup', adminController.backupDatabase],
    ['/db/restore', adminController.restoreDatabase],
    ['/logs/cleanup', adminController.cleanupLogs],
    ['/logs/purge', adminController.purgeLogs],
    ['/fix-permissions', adminController.fixPermissions],
    ['/swagger/validate', adminController.validateSwagger],

    // ✅ Admin-triggered push
    ['/push-test', adminController.sendTestNotification]
  ]
}, {
  requireUID: false,
  requirePhone: false
});

export default router;
