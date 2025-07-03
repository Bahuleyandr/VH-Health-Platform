// src/validators/user/userValidator.js
import { body, query, param } from 'express-validator';
import { USER_CONFIG } from '../../config/userConfig.js';

// User profile validation
export const userValidation = [
  body('phone')
    .matches(/^\+?[1-9]\d{9,14}$/)
    .withMessage('Phone number must be 10-15 digits'),
  body('name')
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters')
    .trim(),
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('gender')
    .optional()
    .isIn(['MALE', 'FEMALE', 'OTHER'])
    .withMessage('Gender must be MALE, FEMALE, or OTHER'),
  body('birthday')
    .optional()
    .isISO8601()
    .withMessage('Birthday must be a valid date (YYYY-MM-DD)'),
  body('anniversary')
    .optional()
    .isISO8601()
    .withMessage('Anniversary must be a valid date (YYYY-MM-DD)'),
  body('address')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Address must be less than 500 characters')
    .trim(),
  body('emergency_contact')
    .optional()
    .isObject()
    .withMessage('Emergency contact must be an object')
];

// Search validation
export const searchValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: USER_CONFIG.MAX_PAGE_SIZE })
    .withMessage(`Limit must be between 1 and ${USER_CONFIG.MAX_PAGE_SIZE}`),
  query('role')
    .optional()
    .isIn(Object.values(USER_CONFIG.ROLES))
    .withMessage('Invalid role specified'),
  query('search')
    .optional()
    .isLength({ min: USER_CONFIG.SEARCH.MIN_QUERY_LENGTH, max: USER_CONFIG.SEARCH.MAX_QUERY_LENGTH })
    .withMessage(`Search query must be ${USER_CONFIG.SEARCH.MIN_QUERY_LENGTH}-${USER_CONFIG.SEARCH.MAX_QUERY_LENGTH} characters`),
  query('status')
    .optional()
    .isIn(Object.values(USER_CONFIG.USER_STATUS))
    .withMessage('Invalid status specified'),
  query('department')
    .optional()
    .isString()
    .withMessage('Department must be a string'),
  query('sortBy')
    .optional()
    .isIn(['name', 'registered_at', 'last_login', 'role', 'phone'])
    .withMessage('Invalid sort field'),
  query('sortOrder')
    .optional()
    .isIn(['ASC', 'DESC'])
    .withMessage('Sort order must be ASC or DESC')
];

// User ID validation
export const userIdValidation = [
  param('identifier')
    .notEmpty()
    .withMessage('User identifier is required')
];

// Role validation
export const roleValidation = [
  param('role')
    .isIn(Object.values(USER_CONFIG.ROLES))
    .withMessage('Invalid role specified')
];

// Department validation
export const departmentValidation = [
  param('department')
    .notEmpty()
    .withMessage('Department is required')
];

// User search validation
export const userSearchValidation = [
  query('query')
    .optional()
    .isLength({ min: USER_CONFIG.SEARCH.MIN_QUERY_LENGTH, max: USER_CONFIG.SEARCH.MAX_QUERY_LENGTH })
    .withMessage(`Query must be ${USER_CONFIG.SEARCH.MIN_QUERY_LENGTH}-${USER_CONFIG.SEARCH.MAX_QUERY_LENGTH} characters`),
  query('role')
    .optional()
    .isIn(Object.values(USER_CONFIG.ROLES))
    .withMessage('Invalid role'),
  query('department')
    .optional()
    .isString()
    .withMessage('Department must be a string'),
  query('registeredAfter')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  query('registeredBefore')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  query('lastLoginAfter')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  query('ageMin')
    .optional()
    .isInt({ min: 0, max: 150 })
    .withMessage('Age must be between 0 and 150'),
  query('ageMax')
    .optional()
    .isInt({ min: 0, max: 150 })
    .withMessage('Age must be between 0 and 150'),
  query('hasProfilePicture')
    .optional()
    .isBoolean()
    .withMessage('hasProfilePicture must be boolean'),
  query('includeInactive')
    .optional()
    .isBoolean()
    .withMessage('includeInactive must be boolean')
];

// Status change validation
export const statusChangeValidation = [
  param('identifier')
    .notEmpty()
    .withMessage('User identifier is required'),
  body('status')
    .isIn(Object.values(USER_CONFIG.USER_STATUS))
    .withMessage('Invalid status'),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason must be less than 500 characters')
];

// Bulk import validation
export const bulkImportValidation = [
  body('users')
    .isArray({ min: 1, max: USER_CONFIG.MAX_BULK_IMPORT })
    .withMessage(`Users array must contain 1-${USER_CONFIG.MAX_BULK_IMPORT} items`),
  body('users.*.phone')
    .matches(/^\+?[1-9]\d{9,14}$/)
    .withMessage('Each phone number must be 10-15 digits'),
  body('users.*.name')
    .isLength({ min: 2, max: 100 })
    .withMessage('Each name must be 2-100 characters')
];

// User deactivation validation
export const userDeactivationValidation = [
  param('identifier')
    .notEmpty()
    .withMessage('User identifier is required'),
  body('reason')
    .isLength({ min: 5, max: 500 })
    .withMessage('Reason must be 5-500 characters')
];

// Admin validations
export const reactivationValidation = [
  param('userId')
    .notEmpty()
    .withMessage('User ID is required')
];

export const analyticsValidation = [
  query('timeframe')
    .optional()
    .isIn(['7d', '30d', '90d', '1y'])
    .withMessage('Timeframe must be 7d, 30d, 90d, or 1y')
];

export const activityAuditValidation = [
  query('userId')
    .optional()
    .isInt({ min: 1 })
    .withMessage('User ID must be positive integer'),
  query('action')
    .optional()
    .isString()
    .withMessage('Action must be a string'),
  query('startDate')
    .optional()
    .isISO8601()
    .withMessage('Invalid start date'),
  query('endDate')
    .optional()
    .isISO8601()
    .withMessage('Invalid end date'),
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be 1-100')
];

export const inactiveUsersValidation = [
  query('inactiveDays')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Inactive days must be 1-365')
];

export const reportGenerationValidation = [
  body('reportType')
    .isIn(['user-summary', 'inactive-users', 'role-distribution', 'user-growth'])
    .withMessage('Invalid report type'),
  body('filters')
    .optional()
    .isObject()
    .withMessage('Filters must be an object')
];

// Lookup validations
export const lookupValidator = [
  query('phone')
    .optional()
    .isLength({ min: 10, max: 15 })
    .withMessage('Invalid phone number'),
  query('uid')
    .optional()
    .isUUID()
    .withMessage('Invalid UID format'),
  query('name')
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be 2-100 characters'),
  query('email')
    .optional()
    .isEmail()
    .withMessage('Invalid email format'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('Limit must be between 1-50')
];

export const advancedSearchValidator = [
  body('criteria')
    .isObject()
    .withMessage('Search criteria must be an object'),
  body('criteria.role')
    .optional()
    .isIn(Object.values(USER_CONFIG.ROLES))
    .withMessage('Invalid role'),
  body('criteria.registeredAfter')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  body('criteria.registeredBefore')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format'),
  body('options.includeInactive')
    .optional()
    .isBoolean()
    .withMessage('includeInactive must be boolean'),
  body('options.sortBy')
    .optional()
    .isIn(['name', 'registered_at', 'last_login', 'role'])
    .withMessage('Invalid sort field'),
  body('options.sortOrder')
    .optional()
    .isIn(['ASC', 'DESC'])
    .withMessage('Sort order must be ASC or DESC')
];