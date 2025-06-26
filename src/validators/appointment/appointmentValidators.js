import { body, param, query, validationResult } from 'express-validator';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { isValidTimeSlot } from '../../utils/appointment/dateTimeUtils.js';

// Middleware to handle validation errors
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array(),
      message: 'Validation failed'
    });
  }
  next();
};

// Create appointment validators
export const createAppointmentValidators = [
  body('patient_id').isInt().withMessage('Patient ID must be a valid integer'),
  body('doctor_id').isInt().withMessage('Doctor ID must be a valid integer'),
  body('appointment_date')
    .isISO8601()
    .withMessage('Appointment date must be in YYYY-MM-DD format')
    .custom((value) => {
      const appointmentDate = new Date(value);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return appointmentDate >= today;
    })
    .withMessage('Appointment date cannot be in the past'),
  body('appointment_time')
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Appointment time must be in HH:mm format'),
  body('reason')
    .trim()
    .notEmpty()
    .withMessage('Reason is required')
    .isLength({ min: 3, max: 500 })
    .withMessage('Reason must be between 3 and 500 characters'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Notes cannot exceed 1000 characters'),
  handleValidationErrors
];

// Update appointment validators
export const updateAppointmentValidators = [
  param('id').isInt().withMessage('Appointment ID must be a valid integer'),
  body('appointment_date')
    .optional()
    .isISO8601()
    .withMessage('Appointment date must be in YYYY-MM-DD format'),
  body('appointment_time')
    .optional()
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Appointment time must be in HH:mm format'),
  body('reason')
    .optional()
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage('Reason must be between 3 and 500 characters'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Notes cannot exceed 1000 characters'),
  handleValidationErrors
];

// Status update validators
export const updateStatusValidators = [
  param('id').isInt().withMessage('Appointment ID must be a valid integer'),
  body('status')
    .trim()
    .toUpperCase()
    .isIn(Object.values(APPOINTMENT_CONFIG.STATUSES))
    .withMessage(`Status must be one of: ${Object.values(APPOINTMENT_CONFIG.STATUSES).join(', ')}`),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Notes cannot exceed 1000 characters'),
  handleValidationErrors
];

// Legacy appointment validator (for backward compatibility)
export const legacyAppointmentValidators = [
  body('phone')
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Invalid phone number format'),
  body('phoneNumber')
    .optional()
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Invalid phone number format'),
  body('doctor_name')
    .trim()
    .notEmpty()
    .withMessage('Doctor name is required'),
  body('date')
    .isISO8601()
    .withMessage('Date must be in valid format'),
  body('time')
    .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
    .withMessage('Time must be in HH:mm format'),
  handleValidationErrors
];