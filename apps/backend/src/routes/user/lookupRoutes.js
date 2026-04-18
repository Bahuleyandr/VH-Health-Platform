// src/routes/user/lookupRoutes.js
import express from 'express';
import { LookupController } from '../../controllers/user/lookupController.js';
import {
  lookupValidator,
  advancedSearchValidator
} from '../../validators/user/userValidator.js';

const router = express.Router();

// Basic user lookup
router.get('/', lookupValidator, LookupController.lookupUser);

// Advanced user search
router.get('/advanced', lookupValidator, LookupController.lookupUser);

// Quick user verification
router.get('/verify', lookupValidator, LookupController.verifyUser);

// User statistics
router.get('/stats', LookupController.getUserStats);

// Recent activity (Admin only)
router.get('/activity', LookupController.getRecentActivity);

// Bulk search (Admin only)
router.post('/bulk-search', advancedSearchValidator, LookupController.bulkSearch);

export default router;