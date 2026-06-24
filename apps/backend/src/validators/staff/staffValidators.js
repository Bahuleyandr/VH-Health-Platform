import { body, query, param } from 'express-validator';
import { STAFF_ROLES, SHIFT_TYPES } from '../../config/staffConfig.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';

const PASSWORD_MIN_LENGTH = SECURITY_CONFIG.password.minLength;

export const staffProfileValidation = [
  body('user_id')
    .optional()
    .custom((value) => Number.isInteger(Number(value)) || /^[0-9a-f-]{36}$/i.test(String(value)))
    .withMessage('Valid user ID or UID required'),
  body('employee_id').optional().isLength({ min: 3, max: 50 }).withMessage('Valid employee ID required'),
  body('name').optional().isLength({ min: 2, max: 255 }).withMessage('Valid staff name required'),
  body('phone').optional().isMobilePhone('en-IN').withMessage('Valid staff phone required'),
  body('email').optional({ checkFalsy: true }).isEmail().withMessage('Valid email required'),
  body('role').optional().isIn(Object.values(STAFF_ROLES)).withMessage('Valid staff role required'),
  body('temporary_password')
    .optional({ checkFalsy: true })
    .isLength({ min: PASSWORD_MIN_LENGTH })
    .withMessage(`Temporary password must be at least ${PASSWORD_MIN_LENGTH} characters`),
  body('password')
    .optional({ checkFalsy: true })
    .isLength({ min: PASSWORD_MIN_LENGTH })
    .withMessage(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`),
  body('position').notEmpty().withMessage('Position required'),
  body('department').notEmpty().withMessage('Department required'),
  body('shift').optional().isIn(Object.keys(SHIFT_TYPES)).withMessage('Valid shift required'),
  body('salary').optional().isFloat({ min: 0 }).withMessage('Valid salary required'),
  body('emergency_contact').optional().isMobilePhone('en-IN').withMessage('Valid emergency contact required')
];

export const updateStaffValidation = [
  param('identifier').notEmpty().withMessage('Staff identifier required'),
  body('position').optional().isLength({ min: 1 }).withMessage('Valid position required'),
  body('department').optional().isLength({ min: 1 }).withMessage('Valid department required'),
  body('shift').optional().isIn(Object.keys(SHIFT_TYPES)).withMessage('Valid shift required'),
  body('salary').optional().isFloat({ min: 0 }).withMessage('Valid salary required'),
  body('is_active').optional().isBoolean().withMessage('Active status must be boolean')
];

export const staffListValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Valid page number required'),
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Valid limit required (1-200)'),
  query('role').optional().isIn(Object.values(STAFF_ROLES)).withMessage('Valid role required'),
  query('department').optional().isLength({ min: 1, max: 100 }).withMessage('Valid department required'),
  query('shift').optional().isIn(Object.keys(SHIFT_TYPES)).withMessage('Valid shift required'),
  query('active').optional().isBoolean().withMessage('Active filter must be boolean')
];

export const staffByDepartmentValidation = [
  param('department').notEmpty().withMessage('Department required'),
  query('shift').optional().isIn(Object.keys(SHIFT_TYPES)).withMessage('Valid shift required'),
  query('include_inactive').optional().isBoolean().withMessage('Include inactive must be boolean')
];

export const staffByShiftValidation = [
  param('shift').isIn(Object.keys(SHIFT_TYPES)).withMessage('Valid shift required'),
  query('department').optional().isLength({ min: 1 }).withMessage('Valid department required'),
  query('date').optional().isISO8601().withMessage('Valid date required')
];

export const staffIdentifierValidation = [
  param('identifier').notEmpty().withMessage('Staff identifier required')
];
