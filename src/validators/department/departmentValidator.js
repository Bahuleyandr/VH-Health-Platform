// src/validators/department/departmentValidator.js
import { body, param, query, validationResult } from 'express-validator';
import { DEPARTMENT_CONFIG, DEPARTMENT_MESSAGES } from '../../config/departmentConfig.js';

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

// Department validators
export const createDepartmentValidation = [
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
  
  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean value'),
  
  validate
];

export const updateDepartmentValidation = [
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
  
  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean value'),
  
  validate
];

export const getDepartmentByIdValidation = [
  param('identifier')
    .trim()
    .notEmpty()
    .withMessage('Department ID or name is required'),
  
  validate
];

export const getDepartmentStatsValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage(DEPARTMENT_MESSAGES.INVALID_DEPARTMENT_ID),
  
  validate
];

export const deactivateDepartmentValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage(DEPARTMENT_MESSAGES.INVALID_DEPARTMENT_ID),
  
  body('reason')
    .optional()
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage('Reason must be between 3 and 500 characters'),
  
  validate
];

export const getAvailableDepartmentsValidation = [
  // No specific validation needed for this endpoint
  validate
];

export const departmentListValidation = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: DEPARTMENT_CONFIG.MAX_LIMIT })
    .withMessage(`Limit must be between 1 and ${DEPARTMENT_CONFIG.MAX_LIMIT}`),
  
  query('search')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Search term must be between 1 and 100 characters'),
  
  query('status')
    .optional()
    .isIn(['active', 'inactive', 'all'])
    .withMessage(DEPARTMENT_MESSAGES.INVALID_STATUS),
  
  validate
];

// Helper function to check if user has permission to manage departments
export const checkDepartmentPermission = (req, res, next) => {
  const userRole = req.user?.role;
  
  if (!['ADMIN', 'DOCTOR'].includes(userRole)) {
    return res.status(403).json({
      success: false,
      message: DEPARTMENT_MESSAGES.INSUFFICIENT_PERMISSIONS
    });
  }
  
  next();
};

// Helper function to check admin-only permissions
export const checkAdminPermission = (req, res, next) => {
  const userRole = req.user?.role;
  
  if (userRole !== 'ADMIN') {
    return res.status(403).json({
      success: false,
      message: DEPARTMENT_MESSAGES.INSUFFICIENT_PERMISSIONS
    });
  }
  
  next();
};