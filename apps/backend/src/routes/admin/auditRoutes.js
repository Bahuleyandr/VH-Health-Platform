import express from 'express';
import * as auditQueryController from '../../controllers/admin/auditQueryController.js';

const router = express.Router();

// GET /api/v1/admin/audit/logs
router.get('/logs', auditQueryController.getAuditLogs);

// GET /api/v1/admin/audit/summary?hours=24
router.get('/summary', auditQueryController.getAuditSummary);

// GET /api/v1/admin/audit/modules
router.get('/modules', auditQueryController.getAuditModules);

// Normalized accountability workspace. Static paths must precede event detail.
router.get('/events', auditQueryController.getUnifiedAuditLogs);
router.get('/events/:source/:id', auditQueryController.getUnifiedAuditEventDetail);
router.get('/export', auditQueryController.exportUnifiedAuditEvents);
router.get('/health', auditQueryController.getUnifiedAuditHealth);

// Backward-compatible alias used by the existing admin clinical-audit tab.
router.get('/unified', auditQueryController.getUnifiedAuditLogs);

// GET /api/v1/admin/audit/user/:userId?days=30
router.get('/user/:userId', auditQueryController.getUserAuditHistory);

export default router;
