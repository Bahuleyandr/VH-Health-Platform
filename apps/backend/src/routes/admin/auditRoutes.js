import express from 'express';
import * as auditQueryController from '../../controllers/admin/auditQueryController.js';

const router = express.Router();

// GET /api/v1/admin/audit/logs
router.get('/logs', auditQueryController.getAuditLogs);

// GET /api/v1/admin/audit/summary?hours=24
router.get('/summary', auditQueryController.getAuditSummary);

// GET /api/v1/admin/audit/modules
router.get('/modules', auditQueryController.getAuditModules);

// GET /api/v1/admin/audit/unified
router.get('/unified', auditQueryController.getUnifiedAuditLogs);

// GET /api/v1/admin/audit/user/:userId?days=30
router.get('/user/:userId', auditQueryController.getUserAuditHistory);

export default router;
