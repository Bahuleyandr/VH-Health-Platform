// src/routes/user/lookupRoutes.js
import express from 'express';
import { LookupController } from '../../controllers/user/lookupController.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  lookupValidator,
  advancedSearchValidator
} from '../../validators/user/userValidator.js';

const router = express.Router();

// CAN-057: the lookup router is mounted for a broad operational role set, but
// the directory-wide stats / activity / bulk-search verbs must be admin-only.
// These per-route guards AND an ADMIN requirement onto the broad mount.
const requireAdmin = requireRole('ADMIN', 'SUPER_ADMIN');

// Basic user lookup
router.get('/', lookupValidator, LookupController.lookupUser);

// Advanced user search
router.get('/advanced', lookupValidator, LookupController.lookupUser);

// Quick user verification
router.get('/verify', lookupValidator, LookupController.verifyUser);

// User statistics (Admin only)
router.get('/stats', requireAdmin, LookupController.getUserStats);

// Recent activity (Admin only)
router.get('/activity', requireAdmin, LookupController.getRecentActivity);

// Bulk search (Admin only)
router.post('/bulk-search', requireAdmin, advancedSearchValidator, LookupController.bulkSearch);

export default router;