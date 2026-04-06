// src/validators/doctor/doctorValidator.js
import { body, param, query } from 'express-validator';
import { DOCTOR_CONFIG } from '../../config/doctorConfig.js';

export const doctorValidators = {
  // Create doctor profile
  createProfile: [
    body('user_id').isInt({ min: 1 }).withMessage('Valid user_id is required'),
    body('specialization').notEmpty().withMessage('Specialization is required'),
    body('department')
      .notEmpty()
      .withMessage('Department is required'),
    body('experience_years')
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage('Experience must be between 0 and 50 years'),
    body('consultation_fee')
      .isFloat({ min: DOCTOR_CONFIG.FEE_RANGES.MIN, max: DOCTOR_CONFIG.FEE_RANGES.MAX })
      .withMessage(`Consultation fee must be between ${DOCTOR_CONFIG.FEE_RANGES.MIN} and ${DOCTOR_CONFIG.FEE_RANGES.MAX}`),
    body('available_days')
      .optional()
      .isArray()
      .withMessage('Available days must be an array'),
    body('available_days.*')
      .optional()
      .isIn(DOCTOR_CONFIG.WEEK_DAYS)
      .withMessage('Invalid day specified'),
    body('available_hours')
      .optional()
      .matches(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
      .withMessage('Available hours must be in HH:mm-HH:mm format'),
    body('bio')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Bio must not exceed 1000 characters'),
    body('education')
      .optional()
      .isLength({ max: 500 })
      .withMessage('Education must not exceed 500 characters'),
    body('qualifications')
      .optional()
      .isArray()
      .withMessage('Qualifications must be an array')
  ],

  // Update doctor profile
  updateProfile: [
    param('id').isInt({ min: 1 }).withMessage('Valid doctor ID is required'),
    body('specialization').optional().notEmpty().withMessage('Specialization cannot be empty'),
    body('department')
      .optional()
      .notEmpty()
      .withMessage('Department cannot be empty'),
    body('experience_years')
      .optional()
      .isInt({ min: 0, max: 50 })
      .withMessage('Experience must be between 0 and 50 years'),
    body('consultation_fee')
      .optional()
      .isFloat({ min: DOCTOR_CONFIG.FEE_RANGES.MIN, max: DOCTOR_CONFIG.FEE_RANGES.MAX })
      .withMessage(`Consultation fee must be between ${DOCTOR_CONFIG.FEE_RANGES.MIN} and ${DOCTOR_CONFIG.FEE_RANGES.MAX}`),
    body('bio')
      .optional()
      .isLength({ max: 1000 })
      .withMessage('Bio must not exceed 1000 characters')
  ],

  // Update availability
  updateAvailability: [
    param('id').isInt({ min: 1 }).withMessage('Valid doctor ID is required'),
    body('is_available')
      .optional()
      .isBoolean()
      .withMessage('is_available must be a boolean'),
    body('available_days')
      .optional()
      .isArray()
      .withMessage('Available days must be an array'),
    body('available_days.*')
      .optional()
      .isIn(DOCTOR_CONFIG.WEEK_DAYS)
      .withMessage('Invalid day specified'),
    body('available_hours')
      .optional()
      .matches(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
      .withMessage('Available hours must be in HH:mm-HH:mm format')
  ],

  // List doctors
  listDoctors: [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: DOCTOR_CONFIG.PAGINATION.MAX_LIMIT })
      .withMessage(`Limit must be between 1 and ${DOCTOR_CONFIG.PAGINATION.MAX_LIMIT}`),
    query('department')
      .optional()
      .isIn(DOCTOR_CONFIG.DEPARTMENTS)
      .withMessage('Invalid department'),
    query('available')
      .optional()
      .isBoolean()
      .withMessage('Available must be true or false'),
    query('search')
      .optional()
      .isLength({ max: 100 })
      .withMessage('Search term too long')
  ],

  // Get doctor by ID
  getById: [
    param('identifier')
      .notEmpty()
      .withMessage('Doctor identifier is required')
  ],

  // Get statistics
  getStats: [
    param('id').isInt({ min: 1 }).withMessage('Valid doctor ID is required'),
    query('months')
      .optional()
      .isInt({ min: 1, max: 12 })
      .withMessage('Months must be between 1 and 12')
  ]
};