// validators/infrastructure/rbacValidator.js
import { body, query } from 'express-validator';
import { 
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF, 
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF 
} from '../../utils/roles.js';

// All available roles
export const ALL_ROLES = [
  ADMIN, PATIENT, NURSING_STAFF, PHARMACY_STAFF,
  LAB_STAFF, DOCTOR, GENERAL_STAFF, HR_STAFF
];

// Role assignment validation
export const roleAssignmentValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\d{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('role')
    .isIn(ALL_ROLES)
    .withMessage('Invalid role specified'),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason too long')
];

// Bulk assignment validation
export const bulkAssignmentValidator = [
  body('assignments')
    .isArray({ min: 1 })
    .withMessage('Assignments array required'),
  body('assignments.*.phone')
    .notEmpty()
    .withMessage('Phone required for each assignment'),
  body('assignments.*.role')
    .isIn(ALL_ROLES)
    .withMessage('Valid role required for each assignment'),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason too long')
];

// User status toggle validation
export const toggleUserStatusValidator = [
  body('phone')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\d{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('action')
    .isIn(['lock', 'unlock'])
    .withMessage('Action must be lock or unlock'),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason too long')
];

// Mass role update validation
export const massRoleUpdateValidator = [
  body('fromRole')
    .isIn(ALL_ROLES)
    .withMessage('Valid from role required'),
  body('toRole')
    .isIn(ALL_ROLES)
    .withMessage('Valid to role required'),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason too long'),
  body('dryRun')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('Dry run must be boolean')
];

// Audit log query validation
export const auditLogQueryValidator = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 1000 })
    .withMessage('Limit must be between 1 and 1000'),
  query('phone')
    .optional()
    .matches(/^\d{10}$/)
    .withMessage('Phone must be 10 digits'),
  query('role')
    .optional()
    .isIn(ALL_ROLES)
    .withMessage('Invalid role'),
  query('startDate')
    .optional()
    .isISO8601()
    .withMessage('Start date must be valid ISO date'),
  query('endDate')
    .optional()
    .isISO8601()
    .withMessage('End date must be valid ISO date'),
  query('action_type')
    .optional()
    .isIn(['role_change', 'user_lock', 'user_unlock', 'mass_update'])
    .withMessage('Invalid action type')
];

// Users query validation
export const usersQueryValidator = [
  query('includeInactive')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('includeInactive must be boolean'),
  query('role')
    .optional()
    .isIn(ALL_ROLES)
    .withMessage('Invalid role'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 1000 })
    .withMessage('Limit must be between 1 and 1000')
];

// Analytics query validation
export const rbacAnalyticsQueryValidator = [
  query('days')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Days must be between 1 and 365')
];

// Migration report query validation
export const migrationReportQueryValidator = [
  query('days')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Days must be between 1 and 365')
];