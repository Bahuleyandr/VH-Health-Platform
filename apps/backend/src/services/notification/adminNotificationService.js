// src/services/notification/adminNotificationService.js

import { 
  NOTIFICATION_TYPES, 
  NOTIFICATION_PRIORITIES,
  VALID_OPERATIONS,
  NOTIFICATION_LIMITS
} from '../../config/notificationConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { 
  buildNotificationQuery,
  buildUserTargetingQuery,
  processTemplate,
  formatNotificationResponse 
} from '../../utils/notification/notificationHelpers.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';


const attachQueryMetadata = (rows, rowCount = rows.length) => {
  Object.defineProperty(rows, 'rows', { value: rows, enumerable: false });
  Object.defineProperty(rows, 'rowCount', { value: rowCount, enumerable: false });
  return rows;
};

const query = async (sql, params = []) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await prisma.$queryRawUnsafe(normalizedSql, ...params);
    return attachQueryMetadata(Array.isArray(rows) ? rows : []);
  }

  const rowCount = await prisma.$executeRawUnsafe(normalizedSql, ...params);
  return attachQueryMetadata([], Number(rowCount) || 0);
};


export const adminNotificationService = {
  /**
   * Get notification system overview
   */
  async getOverview(days = 7) {
    try {
      const [notificationStats, typeDistribution, userEngagement, recentActivity] = await Promise.all([
        // Overall notification statistics
        query(`
          SELECT 
            COUNT(*) as total_notifications,
            COUNT(CASE WHEN is_read = false THEN 1 END) as unread_notifications,
            COUNT(CASE WHEN is_read = true THEN 1 END) as read_notifications,
            COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_notifications,
            ROUND(COUNT(CASE WHEN is_read = true THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as read_rate
          FROM notifications
        `),
        
        // Notification type distribution
        query(`
          SELECT type, priority,
                 COUNT(*) as count,
                 COUNT(CASE WHEN is_read = true THEN 1 END) as read_count,
                 ROUND(COUNT(CASE WHEN is_read = true THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as read_rate
          FROM notifications 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
          GROUP BY type, priority
          ORDER BY count DESC
        `),
        
        // User engagement metrics
        query(`
          SELECT u.role,
                 COUNT(n.id) as notifications_received,
                 COUNT(CASE WHEN n.is_read = true THEN 1 END) as notifications_read,
                 ROUND(AVG(EXTRACT(EPOCH FROM (n.read_at - n.created_at))/3600), 2) as avg_read_time_hours
          FROM users u
          LEFT JOIN notifications n ON u.id = n.user_id 
            AND n.created_at >= CURRENT_DATE - INTERVAL '${days} days'
          WHERE n.id IS NOT NULL
          GROUP BY u.role
          ORDER BY notifications_received DESC
        `),
        
        // Recent notification activity
        query(`
          SELECT DATE(created_at) as date,
                 COUNT(*) as notifications_sent,
                 COUNT(CASE WHEN is_read = true THEN 1 END) as notifications_read
          FROM notifications 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
          GROUP BY DATE(created_at)
          ORDER BY date DESC
        `)
      ]);
      
      return {
        statistics: notificationStats[0],
        type_distribution: typeDistribution,
        user_engagement: userEngagement,
        daily_activity: recentActivity,
        period_days: days
      };
    } catch (error) {
      logger.error('Error getting notification overview:', error.message);
      throw error;
    }
  },

  /**
   * Get notification management list with advanced filtering
   */
  async getManagementList(filters) {
    try {
      const listQuery = parseListQuery(filters, {
        defaultLimit: 50,
        maxLimit: NOTIFICATION_LIMITS.MAX_PAGE_SIZE,
        defaultSortBy: 'created_at'
      });

      // Notifications in this schema are phone-addressed (no user_id / sender_id
      // columns). Left-join users on phone to surface recipient metadata when
      // the phone matches a registered user.
      let sql = `
        SELECT n.id, n.title, n.body AS message, n.type, n.priority, n.is_read,
               n.created_at, n.read_at, n.scheduled_for, n.phone,
               u.name as recipient_name, u.phone as recipient_phone, u.role as recipient_role
        FROM notifications n
        LEFT JOIN users u ON n.phone = u.phone
        WHERE 1=1
      `;

      // Build filter query
      const filterQuery = buildNotificationQuery(filters);
      sql += filterQuery.query;

      sql += ` ORDER BY n.created_at DESC LIMIT $${filterQuery.params.length + 1} OFFSET $${filterQuery.params.length + 2}`;
      const params = [...filterQuery.params, listQuery.limit, listQuery.offset];

      const result = await query(sql, params);

      // Get total count
      let countSql = 'SELECT COUNT(*) FROM notifications n LEFT JOIN users u ON n.phone = u.phone WHERE 1=1';
      countSql += filterQuery.query;

      const countResult = await query(countSql, filterQuery.params);
      const totalNotifications = parseInt(countResult.rows[0].count);

      return {
        notifications: result.rows.map(n => formatNotificationResponse(n, true)),
        pagination: buildPagination(totalNotifications, listQuery.page, listQuery.limit),
        filters
      };
    } catch (error) {
      logger.error('Error getting management list:', error.message);
      throw error;
    }
  },

  /**
   * Get notification templates
   */
  async getTemplates() {
    try {
      const result = await query(`
        SELECT id, name, title_template, message_template, type, priority, 
               variables, description, is_active, created_at
        FROM notification_templates 
        WHERE is_active = true
        ORDER BY name
      `);
      
      return {
        templates: result,
        count: result.length
      };
    } catch (error) {
      logger.error('Error getting templates:', error.message);
      throw error;
    }
  },

  /**
   * Get delivery statistics
   */
  async getDeliveryStats(days = 30) {
    try {
      const [deliveryMetrics, failureAnalysis, engagementRates] = await Promise.all([
        // Delivery success metrics
        query(`
          SELECT 
            COUNT(*) as total_sent,
            COUNT(CASE WHEN scheduled_for IS NULL OR scheduled_for <= NOW() THEN 1 END) as delivered,
            COUNT(CASE WHEN scheduled_for > NOW() THEN 1 END) as pending_delivery,
            COUNT(CASE WHEN is_read = true THEN 1 END) as read_notifications,
            ROUND(COUNT(CASE WHEN is_read = true THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 2) as read_rate
          FROM notifications 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
        `),
        
        // Failure analysis (if available)
        query(`
          SELECT error_type, COUNT(*) as count, 
                 STRING_AGG(DISTINCT error_message, '; ') as sample_errors
          FROM notification_delivery_log 
          WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days' AND status = 'FAILED'
          GROUP BY error_type
          ORDER BY count DESC
        `),
        
        // Engagement rates by user type
        query(`
          SELECT u.role,
                 COUNT(n.id) as notifications_received,
                 COUNT(CASE WHEN n.is_read = true THEN 1 END) as notifications_read,
                 ROUND(COUNT(CASE WHEN n.is_read = true THEN 1 END)::numeric / NULLIF(COUNT(n.id), 0) * 100, 2) as read_rate,
                 ROUND(AVG(EXTRACT(EPOCH FROM (n.read_at - n.created_at))/3600), 2) as avg_read_time_hours
          FROM users u
          LEFT JOIN notifications n ON u.id = n.user_id 
            AND n.created_at >= CURRENT_DATE - INTERVAL '${days} days'
          WHERE n.id IS NOT NULL
          GROUP BY u.role
          ORDER BY notifications_received DESC
        `)
      ]);
      
      return {
        overall_metrics: deliveryMetrics[0],
        failure_analysis: failureAnalysis,
        engagement_by_role: engagementRates,
        period_days: days
      };
    } catch (error) {
      logger.error('Error getting delivery stats:', error.message);
      throw error;
    }
  },

  /**
   * Send legacy notification (backward compatibility)
   */
  async sendLegacyNotification(data, user) {
    try {
      const { phones, title, body, type = 'general' } = data;

      const inserts = phones.map(phone => {
        const normalized = normalizePhone(phone);
        return query(
          `INSERT INTO notifications (phone, title, body, type, created_at, is_read, created_by)
           VALUES ($1, $2, $3, $4, NOW(), false, $5)`,
          [normalized, title, body, type, user?.uid || 'admin']
        );
      });

      await Promise.all(inserts);
      
      logger.info(`📣 Admin Notification sent to ${phones.length} user(s) by ${user?.uid}`);
      
      return {
        recipients_count: phones.length
      };
    } catch (error) {
      logger.error('Error sending legacy notification:', error.message);
      throw error;
    }
  },

  /**
   * Send system announcement
   */
  async sendAnnouncement(data, user) {
    try {
      const { 
        title, message, priority = NOTIFICATION_PRIORITIES.MEDIUM, 
        target_roles = [], target_departments = [], 
        scheduled_for = null, sender_id 
      } = data;
      
      // Build user targeting query
      let targetQuery = 'SELECT DISTINCT u.id, u.name, u.phone FROM users u';
      const targetParams = [];
      const whereConditions = [];
      
      if (target_roles.length > 0) {
        whereConditions.push(`u.role = ANY($${targetParams.length + 1})`);
        targetParams.push(target_roles.map(r => r.toUpperCase()));
      }
      
      if (target_departments.length > 0) {
        targetQuery += ` LEFT JOIN doctors d ON u.id = d.user_id 
                         LEFT JOIN staff s ON u.uid = s.user_id`;
        whereConditions.push(`(d.department = ANY($${targetParams.length + 1}) OR s.department = ANY($${targetParams.length + 1}))`);
        targetParams.push(target_departments);
      }
      
      if (whereConditions.length > 0) {
        targetQuery += ' WHERE ' + whereConditions.join(' AND ');
      }
      
      const targetUsers = await query(targetQuery, targetParams);
      
      if (targetUsers.length === 0) {
        throw new Error('No users match the targeting criteria');
      }
      
      // Create notifications for all target users
      const notifications = targetUsers.map(targetUser => [
        targetUser.id, title, message, NOTIFICATION_TYPES.ANNOUNCEMENT, priority.toUpperCase(), 
        sender_id || user?.uid, scheduled_for, false, targetUser.phone
      ]);
      
      const values = notifications.map((_, index) => {
        const offset = index * 9;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW(), $${offset + 9})`;
      }).join(', ');
      
      const flatParams = notifications.flat();
      
      const result = await query(`
        INSERT INTO notifications (user_id, title, message, type, priority, sender_id, scheduled_for, is_read, created_at, phone)
        VALUES ${values}
        RETURNING id, user_id
      `, flatParams);
      
      logger.info(`System announcement sent to ${targetUsers.length} users by ${user?.uid}`);
      
      return {
        announcement: {
          title,
          message,
          priority: priority.toUpperCase(),
          target_criteria: {
            roles: target_roles,
            departments: target_departments
          }
        },
        delivery: {
          notifications_created: result.length,
          target_users: targetUsers.length,
          scheduled_for
        }
      };
    } catch (error) {
      logger.error('Error sending announcement:', error.message);
      throw error;
    }
  },

  /**
   * Send targeted notifications
   */
  async sendTargeted(data, user) {
    try {
      const { 
        title, message, type = NOTIFICATION_TYPES.SYSTEM, 
        priority = NOTIFICATION_PRIORITIES.MEDIUM,
        user_ids = [], criteria = {}, sender_id, scheduled_for = null 
      } = data;
      
      let targetUserIds = [...user_ids];
      
      // Apply criteria-based targeting if provided
      if (Object.keys(criteria).length > 0) {
        const targetingQuery = buildUserTargetingQuery(criteria);
        const criteriaUsers = await query(targetingQuery.query, targetingQuery.params);
        const criteriaUserIds = criteriaUsers.map(u => u.id);
        
        // Combine with explicitly provided user_ids
        targetUserIds = [...new Set([...targetUserIds, ...criteriaUserIds])];
      }
      
      if (targetUserIds.length === 0) {
        throw new Error('No target users specified or found matching criteria');
      }
      
      // Verify target users exist
      const userCheck = await query(
        'SELECT id, name, role, phone FROM users WHERE id = ANY($1)',
        [targetUserIds]
      );
      
      if (userCheck.length === 0) {
        throw new Error('No valid target users found');
      }
      
      // Create notifications
      const notifications = userCheck.map(targetUser => [
        targetUser.id, title, message, type.toUpperCase(), priority.toUpperCase(),
        sender_id || user?.uid, scheduled_for, false, targetUser.phone
      ]);
      
      const values = notifications.map((_, index) => {
        const offset = index * 9;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW(), $${offset + 9})`;
      }).join(', ');
      
      const flatParams = notifications.flat();
      
      const result = await query(`
        INSERT INTO notifications (user_id, title, message, type, priority, sender_id, scheduled_for, is_read, created_at, phone)
        VALUES ${values}
        RETURNING id, user_id
      `, flatParams);
      
      logger.info(`Targeted notifications sent to ${userCheck.length} users by ${user?.uid}`);
      
      return {
        notification: {
          title,
          message,
          type: type.toUpperCase(),
          priority: priority.toUpperCase()
        },
        targeting: {
          explicit_user_ids: user_ids.length,
          criteria_matched: userCheck.length - user_ids.length,
          total_recipients: userCheck.length
        },
        recipients: userCheck,
        notifications_created: result.length
      };
    } catch (error) {
      logger.error('Error sending targeted notifications:', error.message);
      throw error;
    }
  },

  /**
  /**
 * Perform bulk operations on notifications
 */
async performBulkOperations(data, user) {
  try {
    const { operation, notification_ids, data: operationData } = data;
    
    let results = [];
    
    switch (operation) {
      case VALID_OPERATIONS.MARK_READ: {
        const readResult = await query(
          'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = ANY($1) RETURNING id, title',
          [notification_ids]
        );
        results = readResult;
        break;
      }
      
      case VALID_OPERATIONS.MARK_UNREAD: {
        const unreadResult = await query(
          'UPDATE notifications SET is_read = false, read_at = NULL WHERE id = ANY($1) RETURNING id, title',
          [notification_ids]
        );
        results = unreadResult;
        break;
      }
      
      case VALID_OPERATIONS.DELETE: {
        const deleteResult = await query(
          'DELETE FROM notifications WHERE id = ANY($1) RETURNING id, title',
          [notification_ids]
        );
        results = deleteResult;
        break;
      }
      
      case VALID_OPERATIONS.UPDATE_PRIORITY: {
        if (!operationData?.priority) {
          throw new Error('priority is required for update_priority operation');
        }
        const priorityResult = await query(
          'UPDATE notifications SET priority = $1 WHERE id = ANY($2) RETURNING id, title, priority',
          [operationData.priority.toUpperCase(), notification_ids]
        );
        results = priorityResult;
        break;
      }
      
      default:
        throw new Error('Invalid operation');
    }
    
    logger.info(`Bulk ${operation} performed on ${notification_ids.length} notifications by ${user?.uid}`);
    
    return {
      operation,
      affected_notifications: results,
      count: results.length
    };
  } catch (error) {
    logger.error('Error performing bulk operations:', error.message);
    throw error;
  }
},

  /**
   * Create notification template
   */
  async createTemplate(data, user) {
    try {
      const { 
        name, title_template, message_template, type, 
        priority = NOTIFICATION_PRIORITIES.MEDIUM,
        variables = [], description, is_active = true 
      } = data;
      
      const result = await query(`
        INSERT INTO notification_templates (
          name, title_template, message_template, type, priority,
          variables, description, is_active, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING id, name, title_template, message_template, type, priority, variables, description, is_active, created_at
      `, [name, title_template, message_template, type.toUpperCase(), priority.toUpperCase(),
          JSON.stringify(variables), description, is_active]);
      
      logger.info(`Notification template created: ${name} by ${user?.uid}`);
      
      return result[0];
    } catch (error) {
      logger.error('Error creating template:', error.message);
      throw error;
    }
  },

  /**
   * Send notifications from template
   */
  async sendFromTemplate(data, user) {
    try {
      const { 
        template_id, target_users, variable_values = {}, 
        sender_id, scheduled_for = null 
      } = data;
      
      // Get template
      const templateResult = await query(
        'SELECT id, name, title_template, message_template, type, priority, is_active, created_at FROM notification_templates WHERE id = $1 AND is_active = true',
        [template_id]
      );
      
      if (templateResult.length === 0) {
        throw new Error('Notification template not found');
      }
      
      const template = templateResult[0];
      
      // Replace variables in title and message
      const title = processTemplate(template.title_template, variable_values);
      const message = processTemplate(template.message_template, variable_values);
      
      // Verify target users exist
      const userCheck = await query(
        'SELECT id, name, phone FROM users WHERE id = ANY($1)',
        [target_users]
      );
      
      if (userCheck.length === 0) {
        throw new Error('No valid target users found');
      }
      
      // Create notifications
      const notifications = userCheck.map(targetUser => [
        targetUser.id, title, message, template.type, template.priority,
        sender_id || user?.uid, scheduled_for, false, targetUser.phone
      ]);
      
      const values = notifications.map((_, index) => {
        const offset = index * 9;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, NOW(), $${offset + 9})`;
      }).join(', ');
      
      const flatParams = notifications.flat();
      
      const result = await query(`
        INSERT INTO notifications (user_id, title, message, type, priority, sender_id, scheduled_for, is_read, created_at, phone)
        VALUES ${values}
        RETURNING id, user_id
      `, flatParams);
      
      logger.info(`Template-based notifications sent to ${userCheck.length} users by ${user?.uid}`);
      
      return {
        template: {
          id: template.id,
          name: template.name
        },
        processed_content: {
          title,
          message
        },
        delivery: {
          notifications_created: result.length,
          recipients: userCheck
        }
      };
    } catch (error) {
      logger.error('Error sending from template:', error.message);
      throw error;
    }
  },

  /**
   * Clean up old notifications
   */
  async cleanupNotifications(params, user) {
    try {
      const days = parseInt(params.days) || NOTIFICATION_LIMITS.DEFAULT_CLEANUP_DAYS;
      const keep_unread = params.keep_unread === 'true';
      
      let deleteQuery = 'DELETE FROM notifications WHERE created_at < CURRENT_DATE - INTERVAL $1';
      const queryParams = [`${days} days`];
      
      if (keep_unread) {
        deleteQuery += ' AND is_read = true';
      }
      
      deleteQuery += ' RETURNING id, title, created_at';
      
      const result = await query(deleteQuery, queryParams);
      
      logger.info(`Notification cleanup: ${result.length} notifications deleted (older than ${days} days) by ${user?.uid}`);
      
      return {
        notifications_deleted: result.length,
        cutoff_date: new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString().split('T')[0],
        kept_unread: keep_unread,
        deleted_notifications: result.slice(0, 10) // Show first 10 as sample
      };
    } catch (error) {
      logger.error('Error cleaning up notifications:', error.message);
      throw error;
    }
  }
};
