// src/routes/logs/index.js
import express from 'express';
import {
  getAuditLogs,
  getSystemLogs,
  exportAuditLogs,
  exportSystemLogs,
} from '../../controllers/logs/logController.js';

const router = express.Router();

/**
 * GET  /api/v1/logs/audit          — paginated audit log entries
 * GET  /api/v1/logs/system         — paginated system/admin activity logs
 * GET  /api/v1/logs/audit/export   — CSV download of audit logs
 * GET  /api/v1/logs/system/export  — CSV download of system logs
 *
 * Auth: validateApiKey + authMiddleware applied in app.js
 */

router.get('/audit/export', exportAuditLogs);
router.get('/system/export', exportSystemLogs);
router.get('/audit', getAuditLogs);
router.get('/system', getSystemLogs);

export default router;
