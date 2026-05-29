import { body, query, param } from 'express-validator';
import { STAFF_ROLES, SHIFT_TYPES } from '../../config/staffConfig.js';

export const staffProfileValidation = [
  body('user_id').optional().isInt({ min: 1 }).withMessage('Valid user ID required'),
  body('employee_id').notEmpty().withMessage('Employee ID required'),
  body('position').notEmpty().withMessage('Position required'),
  body('department').notEmpty().withMessage('Department required'),
  body('shift').optional().isIn(Object.keys(SHIFT_TYPES)).withMessage('Valid shift required'),
  body('salary').optional().isFloat({ min: 0 }).withMessage('Valid salary required'),
  body('emergency_contact').optional().isMobilePhone('en-IN').withMessage('Valid emergency contact required')
];

export const updateStaffValidation = [
  param('id').notEmpty().withMessage('Staff identifier required'),
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
