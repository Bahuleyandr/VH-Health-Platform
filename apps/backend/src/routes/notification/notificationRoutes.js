// src/routes/notification/notificationRoutes.js

import express from 'express';
import { notificationController } from '../../controllers/notification/notificationController.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
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

function rejectDeprecatedPhoneRoute(req, res) {
  logger.warn(`DEPRECATED notification phone route blocked: ${req.method} ${req.originalUrl || req.url}`);
  res.set('Deprecation', 'true');
  res.set('Sunset', '2026-07-01');
  return res.status(410).json({
    success: false,
    message: 'Phone-number notification routes are disabled. Use /notifications/my for self-service or /notifications/user/:user_id for authorized staff workflows.',
  });
}

/**
 * User notification routes
 * Base path: /api/v1/notifications
 */

// Public test route
router.get('/test', notificationController.test);

router.get('/my', queryValidator, notificationController.getMine);
router.patch('/my/mark-all-read', notificationController.markAllMineAsRead);

router.get('/detail/:id', idParamValidator, notificationController.getById);
router.get('/detail/:id/events', idParamValidator, notificationController.getEvents);
router.get('/list', queryValidator, notificationController.getList);

// DEPRECATED: Use GET /my instead. PII in URL is a security risk.
// The route is intentionally blocked instead of forwarding to the service.
router.get('/:phone', phoneParamValidator, (req, _res, next) => {
  logger.warn(`DEPRECATED: GET /notifications/${maskPhoneForLog(req.params.phone)} — migrate to GET /notifications/my`);
  next();
}, rejectDeprecatedPhoneRoute);
router.get('/user/:user_id', [...userIdParamValidator, ...queryValidator], notificationController.getByUserId);

// Mark notifications as read
router.patch('/:id/read', idParamValidator, notificationController.markAsRead);
router.patch('/:id/acknowledge', idParamValidator, notificationController.acknowledge);
router.patch('/:phone/mark-all-read', phoneParamValidator, (req, _res, next) => {
  logger.warn(`DEPRECATED: PATCH /notifications/${maskPhoneForLog(req.params.phone)}/mark-all-read — migrate to PATCH /notifications/my/mark-all-read`);
  next();
}, rejectDeprecatedPhoneRoute);
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
