// src/routes/notification/notificationRoutes.js

import express from 'express';
import { notificationController } from '../../controllers/notification/notificationController.js';
import logger from '../../logging/logger.js';
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

router.get('/my', queryValidator, notificationController.getMine);
router.patch('/my/mark-all-read', notificationController.markAllMineAsRead);

router.get('/detail/:id', idParamValidator, notificationController.getById);
router.get('/list', queryValidator, notificationController.getList);

// DEPRECATED: Use GET /my instead. PII in URL is a security risk.
// These routes will be removed in a future release.
router.get('/:phone', phoneParamValidator, (req, res, next) => {
  logger.warn(`DEPRECATED: GET /notifications/${req.params.phone} — migrate to GET /notifications/my`);
  res.set('Deprecation', 'true');
  res.set('Sunset', '2026-07-01');
  next();
}, notificationController.getByPhone);
router.get('/user/:user_id', [...userIdParamValidator, ...queryValidator], notificationController.getByUserId);

// Mark notifications as read
router.patch('/:id/read', idParamValidator, notificationController.markAsRead);
router.patch('/:phone/mark-all-read', phoneParamValidator, (req, res, next) => {
  logger.warn(`DEPRECATED: PATCH /notifications/${req.params.phone}/mark-all-read — migrate to PATCH /notifications/my/mark-all-read`);
  res.set('Deprecation', 'true');
  res.set('Sunset', '2026-07-01');
  next();
}, notificationController.markAllAsReadByPhone);
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
