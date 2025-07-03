// src/routes/notification/adminNotificationRoutes.js

import express from 'express';
import { adminNotificationController } from '../../controllers/notification/adminNotificationController.js';
import {
  legacyNotificationValidator,
  announcementValidator,
  targetedNotificationValidator,
  bulkOperationValidator,
  templateValidator,
  sendFromTemplateValidator,
  statsQueryValidator,
  cleanupQueryValidator,
  queryValidator
} from '../../validators/notification/notificationValidator.js';

const router = express.Router();

/**
 * Admin notification routes
 * Base path: /api/v1/notifications/admin
 * All routes require ADMIN role (enforced by index.js)
 */

// Test route
router.get('/test', adminNotificationController.test);

// Analytics and overview
router.get('/overview', statsQueryValidator, adminNotificationController.getOverview);
router.get('/manage', queryValidator, adminNotificationController.getManagementList);
router.get('/templates', adminNotificationController.getTemplates);
router.get('/delivery-stats', statsQueryValidator, adminNotificationController.getDeliveryStats);

// Notification sending
router.post('/', legacyNotificationValidator, adminNotificationController.sendLegacy);
router.post('/announcement', announcementValidator, adminNotificationController.sendAnnouncement);
router.post('/targeted', targetedNotificationValidator, adminNotificationController.sendTargeted);
router.post('/bulk-operations', bulkOperationValidator, adminNotificationController.performBulkOperations);

// Template management
router.post('/templates', templateValidator, adminNotificationController.createTemplate);
router.post('/send-from-template', sendFromTemplateValidator, adminNotificationController.sendFromTemplate);

// Cleanup
router.delete('/cleanup', cleanupQueryValidator, adminNotificationController.cleanup);

export default router;