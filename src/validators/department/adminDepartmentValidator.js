// src/validators/department/adminDepartmentValidator.js
import { body, param, query, validationResult } from 'express-validator';
import { DEPARTMENT_CONFIG, DEPARTMENT_MESSAGES, DEPARTMENT_STATUS } from '../../config/departmentConfig.js';

// Validation middleware
export const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};

// Admin department validators
export const createAdminDepartmentValidation = [
  body('name')
    .trim()
    .notEmpty().withMessage(DEPARTMENT_MESSAGES.NAME_REQUIRED)
    .isLength({ 
      min: DEPARTMENT_CONFIG.NAME_MIN_LENGTH, 
      max: DEPARTMENT_CONFIG.NAME_MAX_LENGTH 
    }).withMessage(DEPARTMENT_MESSAGES.INVALID_NAME_LENGTH),
  
  body('description')
    .trim()
    .notEmpty().withMessage(DEPARTMENT_MESSAGES.DESCRIPTION_REQUIRED)
    .isLength({ 
      min: DEPARTMENT_CONFIG.DESCRIPTION_MIN_LENGTH, 
      max: DEPARTMENT_CONFIG.DESCRIPTION_MAX_LENGTH 
    }).withMessage(DEPARTMENT_MESSAGES.INVALID_DESCRIPTION_LENGTH),
  
  body('head_doctor_id')
    .optional()
    .isInt({ min: 1 }).withMessage('Head doctor ID must be a positive integer'),
  
  body('contact_number')
    .optional()
    .trim()
    .matches(DEPARTMENT_CONFIG.CONTACT_NUMBER_PATTERN)
    .withMessage(DEPARTMENT_MESSAGES.INVALID_CONTACT_NUMBER),
  
  body('location')
    .optional()
    .trim()
    .isLength({ max: DEPARTMENT_CONFIG.LOCATION_MAX_LENGTH })
    .withMessage(`Location must not exceed ${DEPARTMENT_CONFIG.LOCATION_MAX_LENGTH} characters`),
  
  body('budget')
    .optional()
    .isFloat({ min: DEPARTMENT_CONFIG.MIN_BUDGET, max: DEPARTMENT_CONFIG.MAX_BUDGET })
    .withMessage(`Budget must be between ${DEPARTMENT_CONFIG.MIN_BUDGET} and ${DEPARTMENT_CONFIG.MAX_BUDGET}`),
  
  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean value'),
  
  validate
];

export const updateAdminDepartmentValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage(DEPARTMENT_MESSAGES.INVALID_DEPARTMENT_ID),
  
  body('name')
    .optional()
    .trim()
    .isLength({ 
      min: DEPARTMENT_CONFIG.NAME_MIN_LENGTH, 
      max: DEPARTMENT_CONFIG.NAME_MAX_LENGTH 
    }).withMessage(DEPARTMENT_MESSAGES.INVALID_NAME_LENGTH),
  
  body('description')
    .optional()
    .trim()
    .isLength({ 
      min: DEPARTMENT_CONFIG.DESCRIPTION_MIN_LENGTH, 
      max: DEPARTMENT_CONFIG.DESCRIPTION_MAX_LENGTH 
    }).withMessage(DEPARTMENT_MESSAGES.INVALID_DESCRIPTION_LENGTH),
  
  body('head_doctor_id')
    .optional()
    .isInt({ min: 1 }).withMessage('Head doctor ID must be a positive integer'),
  
  body('contact_number')
    .optional()
    .trim()
    .matches(DEPARTMENT_CONFIG.CONTACT_NUMBER_PATTERN)
    .withMessage(DEPARTMENT_MESSAGES.INVALID_CONTACT_NUMBER),
  
  body('location')
    .optional()
    .trim()
    .isLength({ max: DEPARTMENT_CONFIG.LOCATION_MAX_LENGTH })
    .withMessage(`Location must not exceed ${DEPARTMENT_CONFIG.LOCATION_MAX_LENGTH} characters`),
  
  body('budget')
    .optional()
    .isFloat({ min: DEPARTMENT_CONFIG.MIN_BUDGET, max: DEPARTMENT_CONFIG.MAX_BUDGET })
    .withMessage(`Budget must be between ${DEPARTMENT_CONFIG.MIN_BUDGET} and ${DEPARTMENT_CONFIG.MAX_BUDGET}`),
  
  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean value'),
  
  validate
];

export const getFinancialDataValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage(DEPARTMENT_MESSAGES.INVALID_DEPARTMENT_ID),
  
  query('months')
    .optional()
    .isInt({ min: 1, max: 24 })
    .withMessage('Months must be between 1 and 24'),
  
  validate
];

export const getStaffAllocationValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage(DEPARTMENT_MESSAGES.INVALID_DEPARTMENT_ID),
  
  validate
];

export const bulkOperationValidation = [
  body('operation')
    .notEmpty().withMessage(DEPARTMENT_MESSAGES.OPERATION_REQUIRED)
    .isIn(DEPARTMENT_CONFIG.VALID_BULK_OPERATIONS)
    .withMessage(DEPARTMENT_MESSAGES.INVALID_OPERATION),
  
  body('department_ids')
    .notEmpty().withMessage(DEPARTMENT_MESSAGES.DEPARTMENT_IDS_REQUIRED)
    .isArray({ min: 1, max: DEPARTMENT_CONFIG.MAX_BULK_OPERATIONS })
    .withMessage(`Department IDs must be an array with 1 to ${DEPARTMENT_CONFIG.MAX_BULK_OPERATIONS} items`),
  
  body('department_ids.*')
    .isInt({ min: 1 })
    .withMessage('Each department ID must be a positive integer'),
  
  body('data')
    .optional()
    .isObject()
    .withMessage('Data must be an object'),
  
  body('data.budget')
    .if((value, { req }) => req.body.operation === 'update_budget')
    .notEmpty().withMessage(DEPARTMENT_MESSAGES.BUDGET_REQUIRED)
    .isFloat({ min: DEPARTMENT_CONFIG.MIN_BUDGET, max: DEPARTMENT_CONFIG.MAX_BUDGET })
    .withMessage(`Budget must be between ${DEPARTMENT_CONFIG.MIN_BUDGET} and ${DEPARTMENT_CONFIG.MAX_BUDGET}`),
  
  body('data.head_doctor_id')
    .if((value, { req }) => req.body.operation === 'reassign_head')
    .notEmpty().withMessage(DEPARTMENT_MESSAGES.HEAD_DOCTOR_ID_REQUIRED)
    .isInt({ min: 1 })
    .withMessage('Head doctor ID must be a positive integer'),
  
  validate
];

export const deactivateWithReassignmentValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage(DEPARTMENT_MESSAGES.INVALID_DEPARTMENT_ID),
  
  body('reason')
    .optional()
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage('Reason must be between 3 and 500 characters'),
  
  body('reassign_to_department')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Reassignment department ID must be a positive integer'),
  
  validate
];

export const getManagementDataValidation = [
  query('status')
    .optional()
    .isIn(Object.values(DEPARTMENT_STATUS))
    .withMessage(DEPARTMENT_MESSAGES.INVALID_STATUS),
  
  query('search')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Search term must be between 1 and 100 characters'),
  
  validate
];