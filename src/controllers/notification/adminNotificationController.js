// src/controllers/notification/adminNotificationController.js

import { validationResult } from 'express-validator';
import { adminNotificationService } from '../../services/notification/adminNotificationService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { logAudit } from '../../utils/logAudit.js';
import { NotificationService } from '../../services/notification/notificationService.js';
import logger from '../../logging/logger.js';
import { NOTIFICATION_TYPES, NOTIFICATION_CHANNELS } from '../../config/notificationConfig.js';

export const adminNotificationController = {
  /**
   * Test endpoint
   */
  test: (req, res) => {
    res.json({ 
      message: 'Admin notification routes working!',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      user: req.user?.role || 'anonymous'
    });
  },

  /**
   * Get notification system overview
   */
  getOverview: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const days = parseInt(req.query.days) || 7;
      const overview = await adminNotificationService.getOverview(days);

      success(res, {
        overview,
        generated_at: new Date().toISOString()
      }, 'Notification system overview retrieved successfully');
    } catch (err) {
      logger.error('Error in getOverview:', err.message);
      error(res, 'Failed to retrieve notification overview', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get notification management list
   */
  getManagementList: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.getManagementList(req.query);

      success(res, result, 'Notification management data retrieved successfully');
    } catch (err) {
      logger.error('Error in getManagementList:', err.message);
      error(res, 'Failed to retrieve notification management data', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get notification templates
   */
  getTemplates: async (req, res) => {
    try {
      const result = await adminNotificationService.getTemplates();

      success(res, result, 'Notification templates retrieved successfully');
    } catch (err) {
      logger.error('Error in getTemplates:', err.message);
      error(res, 'Failed to retrieve templates', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Get delivery statistics
   */
  getDeliveryStats: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const days = parseInt(req.query.days) || 30;
      const stats = await adminNotificationService.getDeliveryStats(days);

      success(res, {
        delivery_statistics: stats,
        generated_at: new Date().toISOString()
      }, 'Notification delivery statistics retrieved successfully');
    } catch (err) {
      logger.error('Error in getDeliveryStats:', err.message);
      error(res, 'Failed to retrieve delivery statistics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Send legacy notification
   */
  sendLegacy: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.sendLegacyNotification(
        req.body,
        req.user
      );

      await logAudit(req, 'legacy-notification-sent', { 
        recipients_count: result.recipients_count 
      });

      success(res, null, `Notifications sent to ${result.recipients_count} user(s)`);
    } catch (err) {
      logger.error('Error in sendLegacy:', err.message);
      error(res, 'Failed to send notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Send system announcement
   */
  sendAnnouncement: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.sendAnnouncement(
        req.body,
        req.user
      );

      await logAudit(req, 'system-announcement-sent', { 
        recipients_count: result.delivery.target_users,
        priority: result.announcement.priority
      });

      res.status(HTTP_STATUS.CREATED).json({
        message: 'System announcement sent successfully',
        ...result
      });
    } catch (err) {
      logger.error('Error in sendAnnouncement:', err.message);
      if (err.message.includes('No users match')) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          message: err.message,
          criteria: {
            roles: req.body.target_roles,
            departments: req.body.target_departments
          }
        });
      }
      error(res, 'Failed to send system announcement', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Send targeted notifications
   */
  sendTargeted: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.sendTargeted(
        req.body,
        req.user
      );

      await logAudit(req, 'targeted-notifications-sent', { 
        recipients_count: result.targeting.total_recipients,
        type: result.notification.type
      });

      res.status(HTTP_STATUS.CREATED).json({
        message: 'Targeted notifications sent successfully',
        ...result
      });
    } catch (err) {
      logger.error('Error in sendTargeted:', err.message);
      if (err.message.includes('No target users') || err.message.includes('No valid target')) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({ 
          message: err.message 
        });
      }
      error(res, 'Failed to send targeted notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Perform bulk operations
   */
  performBulkOperations: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.performBulkOperations(
        req.body,
        req.user
      );

      await logAudit(req, `bulk-${req.body.operation}`, { 
        notification_count: req.body.notification_ids.length,
        affected_count: result.count
      });

      success(res, result, `Bulk ${result.operation} operation completed successfully`);
    } catch (err) {
      logger.error('Error in performBulkOperations:', err.message);
      if (err.message.includes('required for')) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({ 
          message: err.message 
        });
      }
      error(res, 'Failed to perform bulk operation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Create notification template
   */
  createTemplate: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const template = await adminNotificationService.createTemplate(
        req.body,
        req.user
      );

      await logAudit(req, 'notification-template-created', { 
        template_name: req.body.name,
        template_id: template.id
      });

      res.status(HTTP_STATUS.CREATED).json({
        message: 'Notification template created successfully',
        template
      });
    } catch (err) {
      logger.error('Error in createTemplate:', err.message);
      error(res, 'Failed to create template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Send from template
   */
  sendFromTemplate: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.sendFromTemplate(
        req.body,
        req.user
      );

      await logAudit(req, 'template-notifications-sent', { 
        template_id: req.body.template_id,
        recipients_count: result.delivery.recipients.length
      });

      res.status(HTTP_STATUS.CREATED).json({
        message: 'Notifications sent using template successfully',
        ...result
      });
    } catch (err) {
      logger.error('Error in sendFromTemplate:', err.message);
      if (err.message.includes('not found')) {
        return res.status(HTTP_STATUS.NOT_FOUND).json({ 
          message: err.message 
        });
      }
      error(res, 'Failed to send notifications from template', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  },

  /**
   * Clean up old notifications
   */
  cleanup: async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        errors: errors.array(),
        message: RESPONSE_MESSAGES.VALIDATION_FAILED
      });
    }

    try {
      const result = await adminNotificationService.cleanupNotifications(
        req.query,
        req.user
      );

      await logAudit(req, 'notifications-cleanup', { 
        deleted_count: result.notifications_deleted,
        days: req.query.days || 90
      });

      success(res, {
        cleanup_summary: result
      }, 'Notification cleanup completed successfully');
    } catch (err) {
      logger.error('Error in cleanup:', err.message);
      error(res, 'Failed to perform notification cleanup', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }
  }
};