// src/validators/notification/notificationValidator.js

import { body, query, param } from 'express-validator';
import { 
  NOTIFICATION_TYPES, 
  NOTIFICATION_PRIORITIES, 
  NOTIFICATION_LIMITS,
  VALID_OPERATIONS 
} from '../../config/notificationConfig.js';

// User notification validators
export const notificationValidator = [
  body('user_id').isInt({ min: 1 }).withMessage('Valid user_id is required'),
  body('title').isLength({ min: NOTIFICATION_LIMITS.TITLE_MIN_LENGTH, max: NOTIFICATION_LIMITS.TITLE_MAX_LENGTH })
    .withMessage(`Title must be ${NOTIFICATION_LIMITS.TITLE_MIN_LENGTH}-${NOTIFICATION_LIMITS.TITLE_MAX_LENGTH} characters`),
  body('message').isLength({ min: NOTIFICATION_LIMITS.MESSAGE_MIN_LENGTH, max: NOTIFICATION_LIMITS.MESSAGE_MAX_LENGTH })
    .withMessage(`Message must be ${NOTIFICATION_LIMITS.MESSAGE_MIN_LENGTH}-${NOTIFICATION_LIMITS.MESSAGE_MAX_LENGTH} characters`),
  body('type').optional().isIn(Object.values(NOTIFICATION_TYPES)).withMessage('Invalid notification type'),
  body('priority').optional().isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage('Invalid priority level'),
  body('sender_id').optional().isInt({ min: 1 }).withMessage('Invalid sender_id'),
  body('scheduled_for').optional().isISO8601().withMessage('Invalid scheduled_for date format')
];

export const bulkNotificationValidator = [
  body('user_ids').isArray({ min: 1, max: NOTIFICATION_LIMITS.MAX_BULK_RECIPIENTS })
    .withMessage(`user_ids must be array of 1-${NOTIFICATION_LIMITS.MAX_BULK_RECIPIENTS} user IDs`),
  body('user_ids.*').isInt({ min: 1 }).withMessage('Each user_id must be valid integer'),
  body('title').isLength({ min: NOTIFICATION_LIMITS.TITLE_MIN_LENGTH, max: NOTIFICATION_LIMITS.TITLE_MAX_LENGTH })
    .withMessage(`Title must be ${NOTIFICATION_LIMITS.TITLE_MIN_LENGTH}-${NOTIFICATION_LIMITS.TITLE_MAX_LENGTH} characters`),
  body('message').isLength({ min: NOTIFICATION_LIMITS.MESSAGE_MIN_LENGTH, max: NOTIFICATION_LIMITS.MESSAGE_MAX_LENGTH })
    .withMessage(`Message must be ${NOTIFICATION_LIMITS.MESSAGE_MIN_LENGTH}-${NOTIFICATION_LIMITS.MESSAGE_MAX_LENGTH} characters`),
  body('type').optional().isIn(Object.values(NOTIFICATION_TYPES)).withMessage('Invalid notification type'),
  body('priority').optional().isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage('Invalid priority level')
];

export const queryValidator = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: NOTIFICATION_LIMITS.MAX_PAGE_SIZE })
    .withMessage(`Limit must be 1-${NOTIFICATION_LIMITS.MAX_PAGE_SIZE}`),
  query('type').optional().isIn(Object.values(NOTIFICATION_TYPES)).withMessage('Invalid notification type'),
  query('priority').optional().isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage('Invalid priority level'),
  query('read').optional().isIn(['true', 'false']).withMessage('Read status must be true or false')
];

export const idParamValidator = [
  param('id').isInt({ min: 1 }).withMessage('Valid notification ID required')
];

export const userIdParamValidator = [
  param('user_id').isInt({ min: 1 }).withMessage('Valid user ID required')
];

export const phoneParamValidator = [
  param('phone').matches(/^\+?\d{10,15}$/).withMessage('Valid phone number required')
];

// Admin notification validators
export const legacyNotificationValidator = [
  body('phones').isArray({ min: 1 }).withMessage('At least one phone number is required'),
  body('phones.*').matches(/^\+?\d{10,15}$/).withMessage('Each phone must be valid'),
  body('title').notEmpty().withMessage('Title is required'),
  body('body').notEmpty().withMessage('Body is required'),
  body('type').optional().isString().withMessage('Type must be a string')
];

export const announcementValidator = [
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required'),
  body('priority').optional().isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage('Invalid priority level'),
  body('target_roles').optional().isArray().withMessage('target_roles must be an array'),
  body('target_departments').optional().isArray().withMessage('target_departments must be an array'),
  body('scheduled_for').optional().isISO8601().withMessage('Invalid scheduled_for date format')
];

export const targetedNotificationValidator = [
  body('title').notEmpty().withMessage('Title is required'),
  body('message').notEmpty().withMessage('Message is required'),
  body('type').optional().isIn(Object.values(NOTIFICATION_TYPES)).withMessage('Invalid notification type'),
  body('priority').optional().isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage('Invalid priority level'),
  body('user_ids').optional().isArray().withMessage('user_ids must be an array'),
  body('criteria').optional().isObject().withMessage('criteria must be an object'),
  body('criteria.has_appointments_in_last_days')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('criteria.has_appointments_in_last_days must be an integer between 1 and 365'),
  body('scheduled_for').optional().isISO8601().withMessage('Invalid scheduled_for date format')
];

export const bulkOperationValidator = [
  body('operation').isIn(Object.values(VALID_OPERATIONS)).withMessage('Invalid operation'),
  body('notification_ids').isArray({ min: 1 }).withMessage('notification_ids array is required'),
  body('notification_ids.*').isInt({ min: 1 }).withMessage('Each notification_id must be valid integer'),
  body('data').optional().isObject().withMessage('data must be an object')
];

export const templateValidator = [
  body('name').notEmpty().withMessage('Name is required'),
  body('title_template').notEmpty().withMessage('Title template is required'),
  body('message_template').notEmpty().withMessage('Message template is required'),
  body('type').isIn(Object.values(NOTIFICATION_TYPES)).withMessage('Invalid notification type'),
  body('priority').optional().isIn(Object.values(NOTIFICATION_PRIORITIES)).withMessage('Invalid priority level'),
  body('variables').optional().isArray().withMessage('variables must be an array'),
  body('description').optional().isString().withMessage('description must be a string'),
  body('is_active').optional().isBoolean().withMessage('is_active must be a boolean')
];

export const sendFromTemplateValidator = [
  body('template_id').isInt({ min: 1 }).withMessage('Valid template_id is required'),
  body('target_users').isArray({ min: 1 }).withMessage('target_users array is required'),
  body('variable_values').optional().isObject().withMessage('variable_values must be an object'),
  body('scheduled_for').optional().isISO8601().withMessage('Invalid scheduled_for date format')
];

export const statsQueryValidator = [
  query('days').optional().isInt({ min: 1, max: NOTIFICATION_LIMITS.MAX_QUERY_DAYS })
    .withMessage(`Days must be 1-${NOTIFICATION_LIMITS.MAX_QUERY_DAYS}`)
];

export const cleanupQueryValidator = [
  query('days').optional().isInt({ min: 1 }).withMessage('Days must be positive integer'),
  query('keep_unread').optional().isIn(['true', 'false']).withMessage('keep_unread must be true or false')
];
