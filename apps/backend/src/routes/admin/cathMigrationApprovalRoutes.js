// Deliberately absent from every production route registry until PR 5.
// Tests mount this actual router; no environment variable can mount it.
import express from 'express';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import tenantContextMiddleware from '../../middleware/tenantContextMiddleware.js';
import { requireRole, requireSuperAdminStepUp } from '../../middleware/rbacMiddleware.js';
import { approveDispositions } from '../../controllers/admin/cathMigrationApprovalController.js';

const router = express.Router();
router.use(jwtAuth, requireRole('SUPER_ADMIN'), requireSuperAdminStepUp, tenantContextMiddleware);
router.post('/dispositions/approve', approveDispositions);
export default router;
