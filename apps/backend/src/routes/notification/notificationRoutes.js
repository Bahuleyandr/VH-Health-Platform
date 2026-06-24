// src/routes/notification/notificationRoutes.js

import express from 'express';
import { notificationController } from '../../controllers/notification/notificationController.js';
import {
  notificationValidator,
  bulkNotificationValidator,
  queryValidator,
  idParamValidator,
  userIdParamValidator,
  statsQueryValidator
} from '../../validators/notification/notificationValidator.js';

const router = express.Router();

/**
 * User notification routes
 * Base path: /api/v1/notifications
 *
 * Self-service is JWT-derived via /my; authorized staff workflows use
 * /user/:user_id. The legacy phone-number routes (GET /:phone, PATCH
 * /:phone/mark-all-read) were removed — PII-in-URL, and they collided with the
 * by-id routes at the /notifications/{} template.
 */

// Public test route
router.get('/test', notificationController.test);

router.get('/my', queryValidator, notificationController.getMine);
router.patch('/my/mark-all-read', notificationController.markAllMineAsRead);

router.get('/detail/:id', idParamValidator, notificationController.getById);
router.get('/detail/:id/events', idParamValidator, notificationController.getEvents);
router.get('/list', queryValidator, notificationController.getList);

router.get('/user/:user_id', [...userIdParamValidator, ...queryValidator], notificationController.getByUserId);

// Mark notifications as read
router.patch('/:id/read', idParamValidator, notificationController.markAsRead);
router.patch('/:id/acknowledge', idParamValidator, notificationController.acknowledge);
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
