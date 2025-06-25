// src/validators/userValidators.js - Hospital User Validation Schemas

import { body, query, param } from 'express-validator';
import { HOSPITAL_ROLES, HOSPITAL_DEPARTMENTS, MEDICAL_SPECIALTIES, USER_STATUS, REPORT_TYPES } from '../config/userConfig.js';

export const userValidation = [
  body('phone').optional().isMobilePhone('any').withMessage('Invalid phone number format'),
  body('name').optional().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('email').optional().isEmail().withMessage('Invalid email format'),
  body('role').optional().isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Invalid hospital role'),
  body('department').optional().isIn(HOSPITAL_DEPARTMENTS).withMessage('Invalid department'),
  body('specialty').optional().isIn(MEDICAL_SPECIALTIES).withMessage('Invalid medical specialty'),
  body('employeeId').optional().isLength({ min: 3, max: 20 }).withMessage('Employee ID must be 3-20 characters'),
  body('licenseNumber').optional().isLength({ min: 5, max: 50 }).withMessage('License number must be 5-50 characters'),
  body('emergencyContact').optional().isMobilePhone('any').withMessage('Invalid emergency contact number'),
  body('birthday').optional().isISO8601().withMessage('Invalid date format (use YYYY-MM-DD)'),
  body('address').optional().isLength({ max: 500 }).withMessage('Address must be less than 500 characters')
];

export const searchValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
  query('role').optional().isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Invalid role filter'),
  query('department').optional().isIn(HOSPITAL_DEPARTMENTS).withMessage('Invalid department filter'),
  query('status').optional().isIn(Object.values(USER_STATUS)).withMessage('Invalid status filter')
];

export const userIdValidation = [
  param('identifier').notEmpty().withMessage('User identifier is required')
];

export const roleValidation = [
  param('role').isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Invalid hospital role'),
  query('includeInactive').optional().isBoolean()
];

export const departmentValidation = [
  param('department').isIn(HOSPITAL_DEPARTMENTS).withMessage('Invalid hospital department'),
  query('roleFilter').optional().isIn(Object.keys(HOSPITAL_ROLES))
];

export const userSearchValidation = [
  query('q').notEmpty().withMessage('Search query is required'),
  query('searchType').optional().isIn(['name', 'phone', 'employee_id', 'email', 'all']),
  query('role').optional().isIn(Object.keys(HOSPITAL_ROLES)),
  query('department').optional().isIn(HOSPITAL_DEPARTMENTS),
  query('limit').optional().isInt({ min: 1, max: 100 })
];

export const statusChangeValidation = [
  ...userIdValidation,
  body('status').isIn(Object.values(USER_STATUS)).withMessage('Invalid status'),
  body('reason').isLength({ min: 10, max: 500 }).withMessage('Reason required (10-500 characters)')
];

export const bulkImportValidation = [
  body('users').isArray({ min: 1, max: 50 }).withMessage('Users array required (1-50 users)'),
  body('users.*.phone').isMobilePhone('any').withMessage('Valid phone required for each user'),
  body('users.*.name').isLength({ min: 2, max: 100 }).withMessage('Valid name required for each user'),
  body('users.*.role').isIn(Object.keys(HOSPITAL_ROLES)).withMessage('Valid role required for each user'),
  body('notifyUsers').optional().isBoolean()
];

export const userDeactivationValidation = [
  ...userIdValidation,
  body('reason').isLength({ min: 10, max: 500 }).withMessage('Deletion reason required (10-500 characters)'),
  body('transferDataTo').optional().isUUID().withMessage('Transfer target must be valid UID')
];

export const reactivationValidation = [
  param('userId').isUUID().withMessage('User ID must be valid UUID'),
  body('reason').isLength({ min: 10, max: 500 }).withMessage('Reactivation reason required (10-500 characters)')
];

export const analyticsValidation = [
  query('timeframe').optional().isIn(['7d', '30d', '90d', '1y']).withMessage('Invalid timeframe'),
  query('department').optional().isIn(HOSPITAL_DEPARTMENTS)
];

export const activityAuditValidation = [
  query('userId').optional().isUUID().withMessage('User ID must be valid UUID'),
  query('action').optional().isLength({ min: 1 }).withMessage('Action filter required'),
  query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be 1-365'),
  query('ipAddress').optional().isIP().withMessage('Invalid IP address format')
];

export const inactiveUsersValidation = [
  query('inactiveDays').optional().isInt({ min: 1, max: 365 }).withMessage('Inactive days must be 1-365'),
  query('role').optional().isIn(Object.keys(HOSPITAL_ROLES)),
  query('includePatients').optional().isBoolean()
];

export const reportGenerationValidation = [
  body('reportType').isIn(Object.values(REPORT_TYPES)).withMessage('Invalid report type'),
  body('filters').optional().isObject().withMessage('Filters must be an object'),
  body('includeInactive').optional().isBoolean(),
  body('dateRange').optional().isObject().withMessage('Date range must be an object')
];