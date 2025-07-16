// src/services/notification/notificationService.js

import db from '../../config/database.js';
import { 
  NOTIFICATION_TYPES, 
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_LIMITS 
} from '../../config/notificationConfig.js';
import logger from '../../logging/logger.js';
import { 
  hasNotificationAccess, 
  buildNotificationQuery,
  formatNotificationResponse 
} from '../../utils/notification/notificationHelpers.js';
import { normalizePhone } from '../../utils/phoneUtils.js';

// Keep the original service object
const notificationService = {
async notifyEmergencyTeam(alertData, nearbyHospitals = []) {
    try {
      // 1. Find all emergency responders
      const respondersResult = await db.query(
        "SELECT id, name, phone FROM users WHERE role = 'EMERGENCY_RESPONDER' AND is_active = true"
      );
      const responders = respondersResult.rows;

      // In a real app, you might also find staff at nearby hospitals
      // For now, we'll just notify the central emergency team.

      const title = `SOS Alert: ${alertData.severity} - ${alertData.user_name || alertData.phone}`;
      const message = `SOS alert triggered by ${alertData.user_name || alertData.phone}. Message: "${alertData.message || 'No message'}". Location: ${alertData.latitude}, ${alertData.longitude}.`;

      // 2. Create a notification for each responder
      const notificationPromises = responders.map(responder => {
        return this.createNotification({
          user_id: responder.id,
          title: title,
          message: message,
          type: NOTIFICATION_TYPES.EMERGENCY,
          priority: NOTIFICATION_PRIORITIES.HIGH,
          data: { 
            sos_alert_id: alertData.id,
            latitude: alertData.latitude,
            longitude: alertData.longitude,
            user_phone: alertData.phone
          }
        }, { role: 'ADMIN' }); // Create as an admin to bypass permissions
      });

      await Promise.all(notificationPromises);
      logger.info(`Notified ${responders.length} emergency responders for SOS alert ${alertData.id}`);
      
      return { success: true, notified_count: responders.length };

    } catch (error) {
      logger.error('Error notifying emergency team:', error.message);
      throw error;
    }
  },

  /**
   * Get notifications by phone number
   */
  async getNotificationsByPhone(phone, user) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const userRole = user?.role?.toUpperCase();

      // Check access for patients
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0 || userResult.rows[0].phone !== normalizedPhone) {
          throw new Error('Access denied: Cannot view other user notifications');
        }
      }

      const result = await db.query(
        `SELECT * FROM notifications WHERE phone = $1 ORDER BY created_at DESC`,
        [normalizedPhone]
      );

      return {
        notifications: result.rows.map(n => formatNotificationResponse(n, userRole === 'ADMIN')),
        count: result.rows.length
      };
    } catch (error) {
      logger.error('Error getting notifications by phone:', error.message);
      throw error;
    }
  },

  /**
   * Get notifications by user ID with filtering
   */
  async getNotificationsByUserId(userId, filters, user) {
    try {
      const userRole = user?.role?.toUpperCase();
      
      // Check access for patients
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0 || userResult.rows[0].id !== parseInt(userId)) {
          throw new Error('Access denied: Cannot view other user notifications');
        }
      }

      let query = `
        SELECT n.id, n.title, n.message, n.type, n.priority, n.is_read,
               n.created_at, n.read_at, n.scheduled_for, n.data,
               ${userRole === 'ADMIN' ? 'sender.name as sender_name,' : ''} n.phone
        FROM notifications n
        ${userRole === 'ADMIN' ? 'LEFT JOIN users sender ON n.sender_id = sender.id' : ''}
        WHERE n.user_id = $1
      `;
      const params = [userId];

      // Apply filters
      if (filters.unread_only === 'true') {
        query += ' AND n.is_read = false';
      }

      if (filters.type) {
        query += ` AND n.type = $${params.length + 1}`;
        params.push(filters.type.toUpperCase());
      }

      if (filters.priority) {
        query += ` AND n.priority = $${params.length + 1}`;
        params.push(filters.priority.toUpperCase());
      }

      const limit = Math.min(parseInt(filters.limit) || NOTIFICATION_LIMITS.DEFAULT_PAGE_SIZE, NOTIFICATION_LIMITS.MAX_PAGE_SIZE);
      query += ` ORDER BY n.created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await db.query(query, params);

      // Get unread count
      const unreadResult = await db.query(
        'SELECT COUNT(*) as unread_count FROM notifications WHERE user_id = $1 AND is_read = false',
        [userId]
      );

      return {
        notifications: result.rows.map(n => formatNotificationResponse(n, userRole === 'ADMIN')),
        count: result.rows.length,
        unread_count: parseInt(unreadResult.rows[0]?.unread_count || 0),
        filters
      };
    } catch (error) {
      logger.error('Error getting notifications by user ID:', error.message);
      throw error;
    }
  },

  /**
   * Get single notification by ID
   */
  async getNotificationById(notificationId, user, markAsRead = true) {
    try {
      const userRole = user?.role?.toUpperCase();
      let accessQuery = '';
      const params = [notificationId];

      // Patients can only view their own notifications
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0) {
          throw new Error('User not found');
        }
        accessQuery = ' AND n.user_id = $2';
        params.push(userResult.rows[0].id);
      }

      const result = await db.query(`
        SELECT n.*, 
               u.name as recipient_name, u.phone as recipient_phone,
               ${userRole === 'ADMIN' ? 'u.email as recipient_email, sender.name as sender_name, sender.phone as sender_phone' : ''}
        FROM notifications n
        LEFT JOIN users u ON n.user_id = u.id
        ${userRole === 'ADMIN' ? 'LEFT JOIN users sender ON n.sender_id = sender.id' : ''}
        WHERE n.id = $1${accessQuery}
      `, params);

      if (result.rows.length === 0) {
        throw new Error('Notification not found or access denied');
      }

      // Auto-mark as read when viewed
      if (markAsRead && !result.rows[0].is_read) {
        await db.query(
          'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1',
          [notificationId]
        );
        result.rows[0].is_read = true;
        result.rows[0].read_at = new Date();
      }

      return formatNotificationResponse(result.rows[0], userRole === 'ADMIN');
    } catch (error) {
      logger.error('Error getting notification by ID:', error.message);
      throw error;
    }
  },

  /**
   * Get notification list with pagination
   */
  async getNotificationList(filters, user) {
    try {
      const page = parseInt(filters.page) || 1;
      const limit = Math.min(parseInt(filters.limit) || NOTIFICATION_LIMITS.DEFAULT_PAGE_SIZE, NOTIFICATION_LIMITS.MAX_PAGE_SIZE);
      const offset = (page - 1) * limit;
      const userRole = user?.role?.toUpperCase();

      let baseConditions = '1=1';
      const params = [];

      // Patients can only see their own notifications
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0) {
          throw new Error('User not found');
        }
        baseConditions = 'n.user_id = $1';
        params.push(userResult.rows[0].id);
      }

      // Build filter query
      const filterQuery = buildNotificationQuery({
        type: filters.type,
        priority: filters.priority,
        read_status: filters.read === 'true' ? 'read' : filters.read === 'false' ? 'unread' : null
      });

      if (filterQuery.query) {
        baseConditions += filterQuery.query;
        params.push(...filterQuery.params);
      }

      const query = `
        SELECT n.id, n.title, n.message, n.type, n.priority, n.is_read,
               n.created_at, n.read_at, n.scheduled_for,
               ${userRole === 'ADMIN' ? 'n.data, u.name as recipient_name, u.phone as recipient_phone, sender.name as sender_name' : 'u.name as recipient_name'}
        FROM notifications n
        LEFT JOIN users u ON n.user_id = u.id
        ${userRole === 'ADMIN' ? 'LEFT JOIN users sender ON n.sender_id = sender.id' : ''}
        WHERE ${baseConditions}
        ORDER BY n.created_at DESC 
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;

      params.push(limit, offset);
      const result = await db.query(query, params);

      // Get total count
      const countQuery = `SELECT COUNT(*) FROM notifications n WHERE ${baseConditions}`;
      const countResult = await db.query(countQuery, params.slice(0, -2));
      const totalNotifications = parseInt(countResult.rows[0].count);

      return {
        notifications: result.rows.map(n => formatNotificationResponse(n, userRole === 'ADMIN')),
        pagination: {
          page,
          limit,
          total: totalNotifications,
          totalPages: Math.ceil(totalNotifications / limit),
          hasNext: page * limit < totalNotifications,
          hasPrev: page > 1
        },
        filters
      };
    } catch (error) {
      logger.error('Error getting notification list:', error.message);
      throw error;
    }
  },

  /**
   * Mark notification as read
   */
  async markNotificationAsRead(notificationId, user) {
    try {
      const userRole = user?.role?.toUpperCase();
      let accessCondition = '';
      const params = [notificationId];

      // Patients can only mark their own notifications as read
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0) {
          throw new Error('User not found');
        }
        accessCondition = ' AND user_id = $2';
        params.push(userResult.rows[0].id);
      }

      const result = await db.query(`
        UPDATE notifications SET 
          is_read = true,
          read_at = NOW()
        WHERE id = $1${accessCondition}
        RETURNING id, title, is_read, read_at
      `, params);

      if (result.rows.length === 0) {
        throw new Error('Notification not found or access denied');
      }

      return result.rows[0];
    } catch (error) {
      logger.error('Error marking notification as read:', error.message);
      throw error;
    }
  },

  /**
   * Mark all notifications as read by phone
   */
  async markAllAsReadByPhone(phone, user) {
    try {
      const normalizedPhone = normalizePhone(phone);
      const userRole = user?.role?.toUpperCase();

      // Access control: patients can only mark their own notifications as read
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0 || userResult.rows[0].phone !== normalizedPhone) {
          throw new Error('Access denied: Cannot modify other user notifications');
        }
      }

      const result = await db.query(`
        UPDATE notifications SET is_read = TRUE, read_at = NOW() 
        WHERE phone = $1 AND is_read = FALSE
      `, [normalizedPhone]);

      return {
        updated_count: result.rowCount || 0,
        phone: normalizedPhone
      };
    } catch (error) {
      logger.error('Error marking all notifications as read by phone:', error.message);
      throw error;
    }
  },

  /**
   * Mark all user notifications as read
   */
  async markAllAsReadByUserId(userId, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Access control: users can only mark their own notifications as read
      if (userRole === 'PATIENT') {
        const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [user.uid]);
        if (userResult.rows.length === 0 || userResult.rows[0].id !== parseInt(userId)) {
          throw new Error('Access denied: Cannot modify other user notifications');
        }
      }

      const result = await db.query(`
        UPDATE notifications SET 
          is_read = true,
          read_at = NOW()
        WHERE user_id = $1 AND is_read = false
      `, [userId]);

      return {
        updated_count: result.rowCount || 0,
        user_id: userId
      };
    } catch (error) {
      logger.error('Error marking all notifications as read by user ID:', error.message);
      throw error;
    }
  },

  /**
   * Create a new notification
   */
  async createNotification(data, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Only medical staff and admin can create notifications
      if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
        throw new Error('Access denied: Medical staff privileges required');
      }

      const { 
        user_id, title, message, 
        type = NOTIFICATION_TYPES.SYSTEM, 
        priority = NOTIFICATION_PRIORITIES.MEDIUM,
        sender_id = null, scheduled_for = null, data: extraData = null 
      } = data;

      // Verify recipient user exists
      const userCheck = await db.query('SELECT id, name, phone FROM users WHERE id = $1', [user_id]);
      if (userCheck.rows.length === 0) {
        throw new Error('Recipient user not found');
      }

      // Verify sender exists if provided
      if (sender_id) {
        const senderCheck = await db.query('SELECT id FROM users WHERE id = $1', [sender_id]);
        if (senderCheck.rows.length === 0) {
          throw new Error('Sender user not found');
        }
      }

      const result = await db.query(`
        INSERT INTO notifications (
          user_id, title, message, type, priority, sender_id,
          scheduled_for, data, is_read, created_at, created_by, phone
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW(), $9, $10)
        RETURNING *
      `, [user_id, title, message, type.toUpperCase(), priority.toUpperCase(),
          sender_id, scheduled_for, extraData, user.uid, userCheck.rows[0].phone]);

      return {
        notification: formatNotificationResponse(result.rows[0], true),
        recipient_name: userCheck.rows[0].name
      };
    } catch (error) {
      logger.error('Error creating notification:', error.message);
      throw error;
    }
  },

  /**
   * Send bulk notifications
   */
  async sendBulkNotifications(data, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Only admin can send bulk notifications
      if (userRole !== 'ADMIN') {
        throw new Error('Access denied: Admin privileges required for bulk notifications');
      }

      const { 
        user_ids, title, message, 
        type = NOTIFICATION_TYPES.SYSTEM, 
        priority = NOTIFICATION_PRIORITIES.MEDIUM, 
        sender_id = null 
      } = data;

      if (user_ids.length > NOTIFICATION_LIMITS.MAX_BULK_RECIPIENTS) {
        throw new Error(`Maximum ${NOTIFICATION_LIMITS.MAX_BULK_RECIPIENTS} recipients allowed per bulk notification`);
      }

      // Verify all users exist
      const userCheck = await db.query(
        'SELECT id, name, phone FROM users WHERE id = ANY($1)',
        [user_ids]
      );

      if (userCheck.rows.length !== user_ids.length) {
        const foundIds = userCheck.rows.map(user => user.id);
        const missingIds = user_ids.filter(id => !foundIds.includes(parseInt(id)));
        throw new Error(`Some users not found: ${missingIds.join(', ')}`);
      }

      // Create notifications for all users
      const notifications = userCheck.rows.map(recipient => [
        recipient.id, title, message, type.toUpperCase(), priority.toUpperCase(), 
        sender_id, user.uid, recipient.phone
      ]);

      const placeholders = notifications.map((_, index) => {
        const offset = index * 8;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, false, NOW(), $${offset + 7}, $${offset + 8})`;
      }).join(', ');

      const flatParams = notifications.flat();

      const result = await db.query(`
        INSERT INTO notifications (user_id, title, message, type, priority, sender_id, is_read, created_at, created_by, phone)
        VALUES ${placeholders}
        RETURNING id, user_id
      `, flatParams);

      return {
        notifications_sent: result.rows.length,
        notification_ids: result.rows.map(n => n.id),
        recipients: userCheck.rows.map(u => ({ id: u.id, name: u.name }))
      };
    } catch (error) {
      logger.error('Error sending bulk notifications:', error.message);
      throw error;
    }
  },

  /**
   * Get notification statistics
   */
  async getNotificationStats(days = 7) {
    try {
      const [totalStats, typeStats, priorityStats, recentActivity] = await Promise.all([
        // Total notification statistics
        db.query(`
          SELECT 
            COUNT(*) as total_notifications,
            COUNT(CASE WHEN is_read = false THEN 1 END) as unread_notifications,
            COUNT(CASE WHEN is_read = true THEN 1 END) as read_notifications,
            COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_notifications,
            ROUND(AVG(CASE WHEN is_read = true THEN EXTRACT(EPOCH FROM (read_at - created_at))/3600 END), 2) as avg_read_time_hours
          FROM notifications
        `),

        // Type breakdown
        db.query(`
          SELECT type, COUNT(*) as count
          FROM notifications 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
          GROUP BY type
          ORDER BY count DESC
        `),

        // Priority breakdown
        db.query(`
          SELECT priority, COUNT(*) as count
          FROM notifications 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
          GROUP BY priority
          ORDER BY 
            CASE priority 
              WHEN 'HIGH' THEN 1 
              WHEN 'MEDIUM' THEN 2 
              WHEN 'LOW' THEN 3 
            END
        `),

        // Recent activity (daily counts)
        db.query(`
          SELECT DATE(created_at) as date, COUNT(*) as count,
                 COUNT(CASE WHEN is_read = true THEN 1 END) as read_count
          FROM notifications 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `)
      ]);

      return {
        totals: totalStats.rows[0],
        by_type: typeStats.rows,
        by_priority: priorityStats.rows,
        daily_activity: recentActivity.rows,
        period_days: days
      };
    } catch (error) {
      logger.error('Error getting notification stats:', error.message);
      // Return empty stats on error
      return {
        totals: { total_notifications: 0, unread_notifications: 0, read_notifications: 0 },
        by_type: [],
        by_priority: [],
        daily_activity: [],
        period_days: days
      };
    }
  },

  /**
   * Get scheduled notifications pending delivery
   */
  async getScheduledPending(user) {
    try {
      const userRole = user?.role?.toUpperCase();

      if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        throw new Error('Access denied: Medical staff privileges required');
      }

      const result = await db.query(`
        SELECT n.id, n.user_id, n.title, n.message, n.type, n.priority,
               n.scheduled_for, n.data,
               u.name as recipient_name, u.phone, u.email
        FROM notifications n
        JOIN users u ON n.user_id = u.id
        WHERE n.scheduled_for <= NOW() AND n.is_read = false AND n.scheduled_for IS NOT NULL
        ORDER BY n.scheduled_for ASC
        LIMIT 100
      `);

      return {
        notifications: result.rows.map(n => formatNotificationResponse(n, true)),
        count: result.rows.length
      };
    } catch (error) {
      logger.error('Error getting scheduled pending notifications:', error.message);
      throw error;
    }
  },

  /**
   * Get emergency notifications
   */
  async getEmergencyActive(user) {
    try {
      const userRole = user?.role?.toUpperCase();

      if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
        throw new Error('Access denied: Medical staff privileges required');
      }

      const result = await db.query(`
        SELECT n.id, n.title, n.message, n.created_at, n.data,
               u.name as recipient_name, u.phone
        FROM notifications n
        JOIN users u ON n.user_id = u.id
        WHERE n.type = 'EMERGENCY' AND n.priority = 'HIGH'
          AND n.created_at >= CURRENT_DATE - INTERVAL '24 hours'
        ORDER BY n.created_at DESC
      `);

      return {
        emergency_notifications: result.rows.map(n => formatNotificationResponse(n, true)),
        count: result.rows.length,
        period: 'Last 24 hours'
      };
    } catch (error) {
      logger.error('Error getting emergency notifications:', error.message);
      throw error;
    }
  },

  /**
   * Delete notification
   */
  async deleteNotification(notificationId, user) {
    try {
      const userRole = user?.role?.toUpperCase();

      // Only admin can delete notifications
      if (userRole !== 'ADMIN') {
        throw new Error('Access denied: Admin privileges required');
      }

      const result = await db.query(
        'DELETE FROM notifications WHERE id = $1 RETURNING id, title, user_id',
        [notificationId]
      );

      if (result.rows.length === 0) {
        throw new Error('Notification not found');
      }

      return result.rows[0];
    } catch (error) {
      logger.error('Error deleting notification:', error.message);
      throw error;
    }
  }
};
export class NotificationService {
  static notifyEmergencyTeam = notificationService.notifyEmergencyTeam;
  static getNotificationsByPhone = notificationService.getNotificationsByPhone;
  static getNotificationsByUserId = notificationService.getNotificationsByUserId;
  static getNotificationById = notificationService.getNotificationById;
  static getNotificationList = notificationService.getNotificationList;
  static markNotificationAsRead = notificationService.markNotificationAsRead;
  static markAllAsReadByPhone = notificationService.markAllAsReadByPhone;
  static markAllAsReadByUserId = notificationService.markAllAsReadByUserId;
  static createNotification = notificationService.createNotification;
  static sendBulkNotifications = notificationService.sendBulkNotifications;
  static getNotificationStats = notificationService.getNotificationStats;
  static getScheduledPending = notificationService.getScheduledPending;
  static getEmergencyActive = notificationService.getEmergencyActive;
  static deleteNotification = notificationService.deleteNotification;
}

// Also export the original service for backward compatibility
export { notificationService };