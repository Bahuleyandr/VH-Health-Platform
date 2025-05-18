const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const rbac = require('../middleware/rbacMiddleware');
const { ADMIN } = require('../utils/roles');

// ✅ R2 Storage (Admin Only)
router.get('/r2/files', rbac([ADMIN]), adminController.listR2Files);
router.post('/r2/cleanup', rbac([ADMIN]), adminController.cleanupR2Files);
router.post('/r2/migrate-archive', rbac([ADMIN]), adminController.migrateR2Archive);

// ✅ Database (Admin Only)
router.post('/db/backup', rbac([ADMIN]), adminController.backupDatabase);
router.post('/db/restore', rbac([ADMIN]), adminController.restoreDatabase);

// ✅ Logs (Admin Only)
router.get('/logs/list', rbac([ADMIN]), adminController.listLogs);
router.post('/logs/cleanup', rbac([ADMIN]), adminController.cleanupLogs);
router.post('/logs/purge', rbac([ADMIN]), adminController.purgeLogs);

// ✅ Permissions (Admin Only)
router.post('/fix-permissions', rbac([ADMIN]), adminController.fixPermissions);

// ✅ Swagger (Admin Only)
router.post('/swagger/validate', rbac([ADMIN]), adminController.validateSwagger);

module.exports = router;
