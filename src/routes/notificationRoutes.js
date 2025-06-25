// src/routes/notificationRoutes.js - ENHANCED VERSION WITH FULL RBAC
import express from 'express';
import { validationResult } from 'express-validator';
import db from '../config/database.js';
import { success, error } from '../utils/responseHelper.js';
import logger from '../logging/logger.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../config/responseCodes.js';
import { wrapAutoRBAC, wrapRoutesWithValidation } from '../config/routeWrapper.js';
import { normalizePhone } from '../utils/phoneUtils.js';
import { logAudit } from '../utils/logAudit.js';
import { body, query, param } from 'express-validator';

const router = express.Router();
logger.info('✅ Enhanced notificationRoutes loaded with full RBAC protection and privacy controls');

// ✅ Input validation schemas
const notificationValidator = [
  body('user_id').isInt({ min: 1 }).withMessage('Valid user_id is required'),
  body('title').isLength({ min: 1, max: 200 }).withMessage('Title must be 1-200 characters'),
  body('message').isLength({ min: 1, max: 1000 }).withMessage('Message must be 1-1000 characters'),
  body('type').optional().isIn(['APPOINTMENT', 'MEDICATION', 'EMERGENCY', 'SYSTEM', 'REMINDER', 'ALERT', 'INFO']).withMessage('Invalid notification type'),
  body('priority').optional().isIn(['HIGH', 'MEDIUM', 'LOW']).withMessage('Invalid priority level'),
  body('sender_id').optional().isInt({ min: 1 }).withMessage('Invalid sender_id'),
  body('scheduled_for').optional().isISO8601().withMessage('Invalid scheduled_for date format')
];

const bulkNotificationValidator = [
  body('user_ids').isArray({ min: 1, max: 100 }).withMessage('user_ids must be array of 1-100 user IDs'),
  body('user_ids.*').isInt({ min: 1 }).withMessage('Each user_id must be valid integer'),
  body('title').isLength({ min: 1, max: 200 }).withMessage('Title must be 1-200 characters'),
  body('message').isLength({ min: 1, max: 1000 }).withMessage('Message must be 1-1000 characters'),
  body('type').optional().isIn(['APPOINTMENT', 'MEDICATION', 'EMERGENCY', 'SYSTEM', 'REMINDER', 'ALERT', 'INFO']).withMessage('Invalid notification type'),
  body('priority').optional().isIn(['HIGH', 'MEDIUM', 'LOW']).withMessage('Invalid priority level')
];

const queryValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
  query('type').optional().isIn(['APPOINTMENT', 'MEDICATION', 'EMERGENCY', 'SYSTEM', 'REMINDER', 'ALERT', 'INFO']).withMessage('Invalid notification type'),
  query('priority').optional().isIn(['HIGH', 'MEDIUM', 'LOW']).withMessage('Invalid priority level'),
  query('read').optional().isIn(['true', 'false']).withMessage('Read status must be true or false')
];

// ✅ PUBLIC TEST ROUTE (for system health checks)
wrapRoutesWithValidation(
  router,
  [], // No roles required - public
  {
    get: [
      [
        '/test',
        (req, res) => {
          success(res, {
            message: 'Notification routes working!',
            timestamp: new Date().toISOString(),
            version: '3.0.0-enhanced',
            security: 'RBAC-protected',
            features: ['User notifications', 'Push notifications', 'Bulk messaging', 'Emergency alerts']
          }, 'Notification system operational');
        }
      ]
    ]
  },
  {
    requireUID: false,
    requirePhone: false,
    skipRBAC: true
  }
);

// ✅ PATIENTS & USERS - View own notifications
wrapAutoRBAC(router, 'notificationRoutes', {
  get: [
    // Get user's own notifications (patients can only see their own)
    [
      '/:phone',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone);
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Access control: patients can only view their own notifications
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0 || userResult.rows[0].phone !== phone) {
              return res.status(403).json({ 
                message: 'Access denied: Cannot view other user notifications',
                requestedBy
              });
            }
          }

          const result = await db.query(
            `SELECT * FROM notifications WHERE phone = $1 ORDER BY created_at DESC`,
            [phone]
          );

          await logAudit(req, 'notifications-phone-view', { phone, count: result.rows.length });

          success(res, {
            notifications: result.rows,
            requestedBy,
            accessLevel: userRole
          }, 'Notifications fetched successfully');
          
        } catch (dbError) {
          logger.error(dbError.stack || dbError.toString());
          // Graceful fallback
          success(res, {
            notifications: [],
            message: 'Notification system temporarily unavailable',
            requestedBy: req.user?.uid
          }, 'Notification service status');
        }
      }
    ],

    // Get notifications by user ID with comprehensive filtering
    [
      '/user/:user_id',
      queryValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { user_id } = req.params;
          const { unread_only = false, limit = 50, type, priority } = req.query;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Access control: users can only view their own notifications unless staff
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0 || userResult.rows[0].id !== parseInt(user_id)) {
              return res.status(403).json({ 
                message: 'Access denied: Cannot view other user notifications',
                requestedBy
              });
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
          let params = [user_id];

          if (unread_only === 'true') {
            query += ' AND n.is_read = false';
          }

          if (type) {
            query += ` AND n.type = $${params.length + 1}`;
            params.push(type.toUpperCase());
          }

          if (priority) {
            query += ` AND n.priority = $${params.length + 1}`;
            params.push(priority.toUpperCase());
          }

          query += ` ORDER BY n.created_at DESC LIMIT $${params.length + 1}`;
          params.push(Math.min(parseInt(limit), 100));

          const result = await db.query(query, params);

          // Get unread count
          const unreadResult = await db.query(
            'SELECT COUNT(*) as unread_count FROM notifications WHERE user_id = $1 AND is_read = false',
            [user_id]
          );

          await logAudit(req, 'notifications-user-view', { 
            user_id, 
            count: result.rows.length,
            unread_only: unread_only === 'true'
          });

          success(res, {
            notifications: result.rows,
            count: result.rows.length,
            unread_count: parseInt(unreadResult.rows[0]?.unread_count || 0),
            user_id,
            filters: { unread_only, type, priority },
            requestedBy,
            accessLevel: userRole
          }, 'User notifications retrieved successfully');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve user notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Get single notification by ID with access control
    [
      '/detail/:id',
      param('id').isInt({ min: 1 }).withMessage('Valid notification ID required'),
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { id } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          let accessQuery = '';
          let params = [id];

          // Patients can only view their own notifications
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0) {
              return res.status(404).json({ message: 'User not found' });
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
            return res.status(404).json({ 
              message: 'Notification not found or access denied',
              id,
              requestedBy
            });
          }

          // Auto-mark as read when viewed (optional feature)
          if (!result.rows[0].is_read) {
            await db.query(
              'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1',
              [id]
            );
          }

          await logAudit(req, 'notification-detail-view', { notification_id: id });

          success(res, {
            notification: result.rows[0],
            requestedBy,
            accessLevel: userRole
          }, 'Notification retrieved successfully');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    // Legacy phone-based notification list (backward compatibility)
    [
      '/list',
      queryValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const page = parseInt(req.query.page) || 1;
          const limit = Math.min(parseInt(req.query.limit) || 20, 100);
          const offset = (page - 1) * limit;
          const { user_id, type, read, priority } = req.query;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Role-based access control
          let baseConditions = '1=1';
          let params = [];

          // Patients can only see their own notifications
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0) {
              return res.status(404).json({ message: 'User not found' });
            }
            baseConditions = 'n.user_id = $1';
            params.push(userResult.rows[0].id);
          }

          // Apply filters
          if (user_id && (userRole !== 'PATIENT' || user_id === userResult?.rows[0]?.id)) {
            if (params.length === 0) {
              baseConditions = 'n.user_id = $1';
              params.push(user_id);
            }
          }

          if (type) {
            baseConditions += ` AND n.type = $${params.length + 1}`;
            params.push(type.toUpperCase());
          }

          if (read !== undefined) {
            baseConditions += ` AND n.is_read = $${params.length + 1}`;
            params.push(read === 'true');
          }

          if (priority) {
            baseConditions += ` AND n.priority = $${params.length + 1}`;
            params.push(priority.toUpperCase());
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

          // Get total count for pagination
          const countQuery = `SELECT COUNT(*) FROM notifications n WHERE ${baseConditions}`;
          const countResult = await db.query(countQuery, params.slice(0, -2));
          const totalNotifications = parseInt(countResult.rows[0].count);

          await logAudit(req, 'notifications-list-view', {
            count: result.rows.length,
            filters: { user_id, type, read, priority }
          });

          success(res, {
            notifications: result.rows,
            pagination: {
              page,
              limit,
              total: totalNotifications,
              totalPages: Math.ceil(totalNotifications / limit),
              hasNext: page * limit < totalNotifications,
              hasPrev: page > 1
            },
            filters: { user_id, type, read, priority },
            requestedBy,
            accessLevel: userRole
          }, 'Notifications retrieved successfully');

        } catch (dbError) {
          logger.error('Database error for notifications:', dbError.message);
          // Graceful fallback
          success(res, {
            notifications: [],
            pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
            message: 'Notification system temporarily unavailable',
            requestedBy: req.user?.uid
          }, 'Notification service status');
        }
      }
    ]
  ],

  // ✅ USERS - Mark notifications as read
  patch: [
    [
      '/:id/read',
      param('id').isInt({ min: 1 }).withMessage('Valid notification ID required'),
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { id } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          let accessCondition = '';
          let params = [id];

          // Patients can only mark their own notifications as read
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0) {
              return res.status(404).json({ message: 'User not found' });
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
            return res.status(404).json({ 
              message: 'Notification not found or access denied',
              requestedBy
            });
          }

          await logAudit(req, 'notification-marked-read', { notification_id: id });

          success(res, {
            notification: result.rows[0],
            updatedBy: requestedBy
          }, 'Notification marked as read');

        } catch (dbError) {
          logger.error(dbError.stack || dbError.toString());
          error(res, 'Failed to update notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    [
      '/:phone/mark-all-read',
      async (req, res) => {
        try {
          const phone = normalizePhone(req.params.phone);
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Access control: patients can only mark their own notifications as read
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0 || userResult.rows[0].phone !== phone) {
              return res.status(403).json({ 
                message: 'Access denied: Cannot modify other user notifications',
                requestedBy
              });
            }
          }

          const result = await db.query(`
            UPDATE notifications SET is_read = TRUE, read_at = NOW() 
            WHERE phone = $1 AND is_read = FALSE
            RETURNING COUNT(*) as updated_count
          `, [phone]);

          const updatedCount = result.rowCount || 0;

          await logAudit(req, 'notifications-mark-all-read', { phone, updated_count: updatedCount });

          success(res, {
            updated_count: updatedCount,
            phone,
            updatedBy: requestedBy
          }, 'All notifications marked as read');

        } catch (dbError) {
          logger.error(dbError.stack || dbError.toString());
          error(res, 'Failed to mark all notifications as read', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    [
      '/user/:user_id/read-all',
      param('user_id').isInt({ min: 1 }).withMessage('Valid user ID required'),
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { user_id } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Access control: users can only mark their own notifications as read
          if (userRole === 'PATIENT') {
            const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [req.user.uid]);
            if (userResult.rows.length === 0 || userResult.rows[0].id !== parseInt(user_id)) {
              return res.status(403).json({ 
                message: 'Access denied: Cannot modify other user notifications',
                requestedBy
              });
            }
          }

          const result = await db.query(`
            UPDATE notifications SET 
              is_read = true,
              read_at = NOW()
            WHERE user_id = $1 AND is_read = false
          `, [user_id]);

          const updatedCount = result.rowCount || 0;

          await logAudit(req, 'notifications-user-mark-all-read', { user_id, updated_count: updatedCount });

          success(res, {
            updated_count: updatedCount,
            user_id,
            updatedBy: requestedBy
          }, 'All user notifications marked as read');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to mark all notifications as read', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

// ✅ MEDICAL STAFF & ADMIN - Create and manage notifications
wrapAutoRBAC(router, 'ALL', {
  post: [
    [
      '/create',
      notificationValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Only medical staff and admin can create notifications
          if (!['DOCTOR', 'NURSING_STAFF', 'ADMIN'].includes(userRole)) {
            return error(res, 'Access denied: Medical staff privileges required', HTTP_STATUS.FORBIDDEN);
          }

          const { 
            user_id, title, message, type = 'SYSTEM', priority = 'MEDIUM',
            sender_id = null, scheduled_for = null, data = null 
          } = req.body;

          const validTypes = ['APPOINTMENT', 'MEDICATION', 'EMERGENCY', 'SYSTEM', 'REMINDER', 'ALERT', 'INFO'];
          const validPriorities = ['HIGH', 'MEDIUM', 'LOW'];

          if (!validTypes.includes(type.toUpperCase())) {
            return res.status(400).json({
              message: 'Invalid notification type',
              validTypes,
              requestedBy
            });
          }

          if (!validPriorities.includes(priority.toUpperCase())) {
            return res.status(400).json({
              message: 'Invalid priority level',
              validPriorities,
              requestedBy
            });
          }

          // Verify recipient user exists
          const userCheck = await db.query('SELECT id, name, phone FROM users WHERE id = $1', [user_id]);
          if (userCheck.rows.length === 0) {
            return res.status(404).json({ 
              message: 'Recipient user not found',
              requestedBy
            });
          }

          // Verify sender exists if provided
          if (sender_id) {
            const senderCheck = await db.query('SELECT id FROM users WHERE id = $1', [sender_id]);
            if (senderCheck.rows.length === 0) {
              return res.status(404).json({ 
                message: 'Sender user not found',
                requestedBy
              });
            }
          }

          const result = await db.query(`
            INSERT INTO notifications (
              user_id, title, message, type, priority, sender_id,
              scheduled_for, data, is_read, created_at, created_by, phone
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW(), $9, $10)
            RETURNING *
          `, [user_id, title, message, type.toUpperCase(), priority.toUpperCase(),
              sender_id, scheduled_for, data, requestedBy, userCheck.rows[0].phone]);

          await logAudit(req, 'notification-created', {
            notification_id: result.rows[0].id,
            recipient_user_id: user_id,
            type: type.toUpperCase(),
            priority: priority.toUpperCase()
          });

          success(res, {
            notification: result.rows[0],
            recipient_name: userCheck.rows[0].name,
            createdBy: requestedBy
          }, 'Notification created successfully');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to create notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    [
      '/bulk',
      bulkNotificationValidator,
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Only admin can send bulk notifications
          if (userRole !== 'ADMIN') {
            return error(res, 'Access denied: Admin privileges required for bulk notifications', HTTP_STATUS.FORBIDDEN);
          }

          const { 
            user_ids, title, message, type = 'SYSTEM', 
            priority = 'MEDIUM', sender_id = null 
          } = req.body;

          if (user_ids.length > 100) {
            return res.status(400).json({
              message: 'Maximum 100 recipients allowed per bulk notification',
              requestedBy
            });
          }

          // Verify all users exist
          const userCheck = await db.query(
            'SELECT id, name, phone FROM users WHERE id = ANY($1)',
            [user_ids]
          );

          if (userCheck.rows.length !== user_ids.length) {
            const foundIds = userCheck.rows.map(user => user.id);
            const missingIds = user_ids.filter(id => !foundIds.includes(parseInt(id)));
            return res.status(404).json({
              message: 'Some users not found',
              missing_user_ids: missingIds,
              requestedBy
            });
          }

          // Create notifications for all users
          const notifications = userCheck.rows.map(user => [
            user.id, title, message, type.toUpperCase(), priority.toUpperCase(), 
            sender_id, requestedBy, user.phone
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

          await logAudit(req, 'bulk-notifications-sent', {
            recipient_count: result.rows.length,
            type: type.toUpperCase(),
            priority: priority.toUpperCase()
          });

          success(res, {
            notifications_sent: result.rows.length,
            notification_ids: result.rows.map(n => n.id),
            recipients: userCheck.rows.map(u => ({ id: u.id, name: u.name })),
            createdBy: requestedBy
          }, 'Bulk notifications sent successfully');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to send bulk notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  get: [
    [
      '/stats/summary',
      query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be 1-365'),
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const days = parseInt(req.query.days) || 7;
          const requestedBy = req.user?.uid;

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

          await logAudit(req, 'notification-stats-viewed', { period_days: days });

          success(res, {
            statistics: {
              totals: totalStats.rows[0],
              by_type: typeStats.rows,
              by_priority: priorityStats.rows,
              daily_activity: recentActivity.rows
            },
            period_days: days,
            generatedBy: requestedBy,
            timestamp: new Date().toISOString()
          }, 'Notification statistics retrieved successfully');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
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
      }
    ],

    [
      '/scheduled/pending',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
            return error(res, 'Access denied: Medical staff privileges required', HTTP_STATUS.FORBIDDEN);
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

          await logAudit(req, 'scheduled-notifications-viewed', { count: result.rows.length });

          success(res, {
            notifications: result.rows,
            count: result.rows.length,
            note: 'These notifications are ready to be sent',
            requestedBy
          }, 'Pending scheduled notifications retrieved');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve scheduled notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ],

    [
      '/emergency/active',
      async (req, res) => {
        try {
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          if (!['ADMIN', 'DOCTOR', 'NURSING_STAFF'].includes(userRole)) {
            return error(res, 'Access denied: Medical staff privileges required', HTTP_STATUS.FORBIDDEN);
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

          await logAudit(req, 'emergency-notifications-viewed', { count: result.rows.length });

          success(res, {
            emergency_notifications: result.rows,
            count: result.rows.length,
            period: 'Last 24 hours',
            requestedBy
          }, 'Active emergency notifications retrieved');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to retrieve emergency notifications', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ],

  delete: [
    [
      '/:id',
      param('id').isInt({ min: 1 }).withMessage('Valid notification ID required'),
      async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            errors: errors.array(),
            message: RESPONSE_MESSAGES.VALIDATION_FAILED
          });
        }

        try {
          const { id } = req.params;
          const userRole = req.user?.role?.toUpperCase();
          const requestedBy = req.user?.uid;

          // Only admin can delete notifications
          if (userRole !== 'ADMIN') {
            return error(res, 'Access denied: Admin privileges required', HTTP_STATUS.FORBIDDEN);
          }

          const result = await db.query(
            'DELETE FROM notifications WHERE id = $1 RETURNING id, title, user_id',
            [id]
          );

          if (result.rows.length === 0) {
            return res.status(404).json({ 
              message: 'Notification not found',
              requestedBy
            });
          }

          await logAudit(req, 'notification-deleted', {
            notification_id: id,
            title: result.rows[0].title,
            user_id: result.rows[0].user_id
          });

          success(res, {
            deleted_notification: result.rows[0],
            deletedBy: requestedBy
          }, 'Notification deleted successfully');

        } catch (dbError) {
          logger.error('Database error:', dbError.message);
          error(res, 'Failed to delete notification', HTTP_STATUS.INTERNAL_SERVER_ERROR);
        }
      }
    ]
  ]
});

export default router;