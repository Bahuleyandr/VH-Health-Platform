// src/controllers/notification/notificationController.js

import { validationResult } from 'express-validator';
import { NOTIFICATION_TYPES } from '../../config/notificationConfig.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import { notificationService } from '../../services/notification/notificationService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';

export const notificationController = {
  /**
   * Test endpoint
   */
  test: (req, res) => {
    success(res, {
      message: 'Notification routes working!',
      timestamp: new Date().toISOString(),
      version: '3.0.0-enhanced',
      security: 'RBAC-protected',
      features: ['User notifications', 'Push notifications', 'Bulk messaging', 'Emergency alerts']
    }, 'Notification system operational');
  },

  /**
   * Get notifications by phone
   */
  getByPhone: async (req, res) => {
    try {
      const result = await notificationService.getNotificationsByPhone(
        req.params.phone,
        req.user,
        { limit: req.query.limit, offset: req.query.offset }
      );

      await logAudit(req, 'notifications-phone-view', { 
        phone: req.params.phone, 
        count: result.count 
      });

      success(res, {
        ...result,
        requestedBy: req.user?.uid,
        accessLevel: req.user?.role?.toUpperCase()
      }, 'Notifications fetched successfully');
    } catch (err) {
      logger.error('Error in getByPhone:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      // Graceful fallback
      success(res, {
        notifications: [],
        message: 'Notification system temporarily unavailable',
        requestedBy: req.user?.uid
      }, 'Notification service status');
    }
  },

  /**
   * Get notifications by user ID
   */
  getByUserId: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const result = await notificationService.getNotificationsByUserId(
        req.params.user_id,
        req.query,
        req.user
      );

      await logAudit(req, 'notifications-user-view', { 
        user_id: req.params.user_id, 
        count: result.count,
        unread_only: req.query.unread_only === 'true'
      });

      success(res, {
        ...result,
        user_id: req.params.user_id,
        requestedBy: req.user?.uid,
        accessLevel: req.user?.role?.toUpperCase()
      }, 'User notifications retrieved successfully');
    } catch (err) {
      logger.error('Error in getByUserId:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      error(res, 'Failed to retrieve user notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get single notification by ID
   */
  getById: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const notification = await notificationService.getNotificationById(
        req.params.id,
        req.user
      );

      await logAudit(req, 'notification-detail-view', { 
        notification_id: req.params.id 
      });

      success(res, {
        notification,
        requestedBy: req.user?.uid,
        accessLevel: req.user?.role?.toUpperCase()
      }, 'Notification retrieved successfully');
    } catch (err) {
      logger.error('Error in getById:', err.message);
      if (err.message.includes('not found') || err.message.includes('access denied')) {
        return error(res, 'Notification not found or access denied', HTTP_STATUS.NOT_FOUND);
      }
      error(res, 'Failed to retrieve notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get notification list with pagination
   */
  getList: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const result = await notificationService.getNotificationList(
        req.query,
        req.user
      );

      await logAudit(req, 'notifications-list-view', {
        count: result.notifications.length,
        filters: req.query
      });

      success(res, {
        ...result,
        requestedBy: req.user?.uid,
        accessLevel: req.user?.role?.toUpperCase()
      }, 'Notifications retrieved successfully');
    } catch (err) {
      logger.error('Error in getList:', err.message);
      // Graceful fallback
      success(res, {
        notifications: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        message: 'Notification system temporarily unavailable',
        requestedBy: req.user?.uid
      }, 'Notification service status');
    }
  },

  /**
   * Mark notification as read
   */
  markAsRead: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const notification = await notificationService.markNotificationAsRead(
        req.params.id,
        req.user
      );

      await logAudit(req, 'notification-marked-read', { 
        notification_id: req.params.id 
      });

      success(res, {
        notification,
        updatedBy: req.user?.uid
      }, 'Notification marked as read');
    } catch (err) {
      logger.error('Error in markAsRead:', err.message);
      if (err.message.includes('not found') || err.message.includes('access denied')) {
        return error(res, 'Notification not found or access denied', HTTP_STATUS.NOT_FOUND);
      }
      error(res, 'Failed to update notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Mark all notifications as read by phone
   */
  markAllAsReadByPhone: async (req, res) => {
    try {
      const result = await notificationService.markAllAsReadByPhone(
        req.params.phone,
        req.user
      );

      await logAudit(req, 'notifications-mark-all-read', { 
        phone: req.params.phone, 
        updated_count: result.updated_count 
      });

      success(res, {
        ...result,
        updatedBy: req.user?.uid
      }, 'All notifications marked as read');
    } catch (err) {
      logger.error('Error in markAllAsReadByPhone:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      error(res, 'Failed to mark all notifications as read', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Mark all user notifications as read
   */
  markAllAsReadByUserId: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const result = await notificationService.markAllAsReadByUserId(
        req.params.user_id,
        req.user
      );

      await logAudit(req, 'notifications-user-mark-all-read', { 
        user_id: req.params.user_id, 
        updated_count: result.updated_count 
      });

      success(res, {
        ...result,
        updatedBy: req.user?.uid
      }, 'All user notifications marked as read');
    } catch (err) {
      logger.error('Error in markAllAsReadByUserId:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      error(res, 'Failed to mark all notifications as read', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Create notification (medical staff & admin only)
   */
  create: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const result = await notificationService.createNotification(
        req.body,
        req.user
      );

      await logAudit(req, 'notification-created', {
        notification_id: result.notification.id,
        recipient_user_id: req.body.user_id,
        type: result.notification.type,
        priority: result.notification.priority
      });

      success(res, {
        ...result,
        createdBy: req.user?.uid
      }, 'Notification created successfully');
    } catch (err) {
      logger.error('Error in create:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      if (err.message.includes('not found')) {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      error(res, 'Failed to create notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Send bulk notifications (admin only)
   */
  sendBulk: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const result = await notificationService.sendBulkNotifications(
        req.body,
        req.user
      );

      await logAudit(req, 'bulk-notifications-sent', {
        recipient_count: result.notifications_sent,
        type: req.body.type?.toUpperCase(),
        priority: req.body.priority?.toUpperCase()
      });

      success(res, {
        ...result,
        createdBy: req.user?.uid
      }, 'Bulk notifications sent successfully');
    } catch (err) {
      logger.error('Error in sendBulk:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      if (err.message.includes('not found')) {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      error(res, 'Failed to send bulk notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get notification statistics (medical staff & admin)
   */
  getStats: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const days = parseInt(req.query.days) || 7;
      const stats = await notificationService.getNotificationStats(days);

      await logAudit(req, 'notification-stats-viewed', { period_days: days });

      success(res, {
        statistics: stats,
        generatedBy: req.user?.uid,
        timestamp: new Date().toISOString()
      }, 'Notification statistics retrieved successfully');
    } catch (err) {
      logger.error('Error in getStats:', err.message);
      // Graceful fallback
      success(res, {
        statistics: {
          totals: { total_notifications: 0, unread_notifications: 0, read_notifications: 0 },
          by_type: [],
          by_priority: [],
          daily_activity: []
        },
        message: 'Notification statistics temporarily unavailable',
        generatedBy: req.user?.uid
      }, 'Notification statistics service status');
    }
  },

  /**
   * Get scheduled pending notifications (medical staff & admin)
   */
  getScheduledPending: async (req, res) => {
    try {
      const result = await notificationService.getScheduledPending(req.user);

      await logAudit(req, 'scheduled-notifications-viewed', { 
        count: result.count 
      });

      success(res, {
        ...result,
        note: 'These notifications are ready to be sent',
        requestedBy: req.user?.uid
      }, 'Pending scheduled notifications retrieved');
    } catch (err) {
      logger.error('Error in getScheduledPending:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      error(res, 'Failed to retrieve scheduled notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get emergency notifications (medical staff & admin)
   */
  getEmergencyActive: async (req, res) => {
    try {
      const result = await notificationService.getEmergencyActive(req.user);

      await logAudit(req, 'emergency-notifications-viewed', { 
        count: result.count 
      });

      success(res, {
        ...result,
        requestedBy: req.user?.uid
      }, 'Active emergency notifications retrieved');
    } catch (err) {
      logger.error('Error in getEmergencyActive:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      error(res, 'Failed to retrieve emergency notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Delete notification (admin only)
   */
  delete: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return error(res, RESPONSE_MESSAGES.VALIDATION_FAILED, HTTP_STATUS.BAD_REQUEST, errors.array());
    }

    try {
      const deleted = await notificationService.deleteNotification(
        req.params.id,
        req.user
      );

      await logAudit(req, 'notification-deleted', {
        notification_id: req.params.id,
        title: deleted.title,
        user_id: deleted.user_id
      });

      success(res, {
        deleted_notification: deleted,
        deletedBy: req.user?.uid
      }, 'Notification deleted successfully');
    } catch (err) {
      logger.error('Error in delete:', err.message);
      if (err.message.includes('Access denied')) {
        return error(res, err.message, HTTP_STATUS.FORBIDDEN);
      }
      if (err.message.includes('not found')) {
        return error(res, err.message, HTTP_STATUS.NOT_FOUND);
      }
      error(res, 'Failed to delete notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};