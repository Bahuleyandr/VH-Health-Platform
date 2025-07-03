// src/routes/user/adminUserRoutes.js
import express from 'express';
import { AdminUserController } from '../../controllers/user/adminUserController.js';
import {
  analyticsValidation,
  activityAuditValidation,
  inactiveUsersValidation,
  reactivationValidation,
  reportGenerationValidation
} from '../../validators/user/userValidator.js';

const router = express.Router();

// Dashboard
router.get('/dashboard', AdminUserController.getDashboard);

// User Analytics
router.get('/analytics', analyticsValidation, AdminUserController.getUserAnalytics);

// User Activity Audit
router.get('/activity-audit', activityAuditValidation, AdminUserController.getActivityAudit);

// Inactive Users Report
router.get('/inactive-users', inactiveUsersValidation, AdminUserController.getInactiveUsersReport);

// Reactivate User
router.post('/reactivate/:userId', reactivationValidation, AdminUserController.reactivateUser);

// Generate User Report
router.post('/generate-report', reportGenerationValidation, AdminUserController.generateReport);

// System Information
router.get('/system-info', AdminUserController.getSystemInfo);

export default router;