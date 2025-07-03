// src/routes/notification/notificationRoutes.js

import express from 'express';
import { notificationController } from '../../controllers/notification/notificationController.js';
import {
  notificationValidator,
  bulkNotificationValidator,
  queryValidator,
  idParamValidator,
  userIdParamValidator,
  phoneParamValidator,
  statsQueryValidator
} from '../../validators/notification/notificationValidator.js';

const router = express.Router();

/**
 * User notification routes
 * Base path: /api/v1/notifications
 */

// Public test route
router.get('/test', notificationController.test);

// User notification routes (patients can only access their own)
router.get('/:phone', phoneParamValidator, notificationController.getByPhone);
router.get('/user/:user_id', [...userIdParamValidator, ...queryValidator], notificationController.getByUserId);
router.get('/detail/:id', idParamValidator, notificationController.getById);
router.get('/list', queryValidator, notificationController.getList);

// Mark notifications as read
router.patch('/:id/read', idParamValidator, notificationController.markAsRead);
router.patch('/:phone/mark-all-read', phoneParamValidator, notificationController.markAllAsReadByPhone);
router.patch('/user/:user_id/read-all', userIdParamValidator, notificationController.markAllAsReadByUserId);

// Medical staff & admin routes
router.post('/create', notificationValidator, notificationController.create);
router.post('/bulk', bulkNotificationValidator, notificationController.sendBulk);
router.get('/stats/summary', statsQueryValidator, notificationController.getStats);
router.get('/scheduled/pending', notificationController.getScheduledPending);
router.get('/emergency/active', notificationController.getEmergencyActive);

// Admin only
router.delete('/:id', idParamValidator, notificationController.delete);

export default router;