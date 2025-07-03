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
    .custom((value) => {
      let appointmentDate;
      
      // Try DD-MM-YYYY format first
      const ddmmyyyyRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      if (ddmmyyyyRegex.test(value)) {
        const [, day, month, year] = value.match(ddmmyyyyRegex);
        appointmentDate = new Date(`${year}-${month}-${day}`);
      } 
      // Try YYYY-MM-DD format
      else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        appointmentDate = new Date(value);
      } 
      else {
        throw new Error('Date must be in DD-MM-YYYY format');
      }
      
      // Validate date
      if (isNaN(appointmentDate.getTime())) {
        throw new Error('Invalid date');
      }
      
      // Check if date is in the past
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      appointmentDate.setHours(0, 0, 0, 0);
      
      if (appointmentDate < today) {
        throw new Error('Appointment date cannot be in the past');
      }
      
      return true;
    })
    .customSanitizer((value) => {
      // Convert DD-MM-YYYY to YYYY-MM-DD for database
      const ddmmyyyyRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      if (ddmmyyyyRegex.test(value)) {
        const [, day, month, year] = value.match(ddmmyyyyRegex);
        return `${year}-${month}-${day}`;
      }
      return value;
    }),
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
    .custom((value) => {
      if (!value) return true; // Optional field
      
      let appointmentDate;
      const ddmmyyyyRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      if (ddmmyyyyRegex.test(value)) {
        const [, day, month, year] = value.match(ddmmyyyyRegex);
        appointmentDate = new Date(`${year}-${month}-${day}`);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        appointmentDate = new Date(value);
      } else {
        throw new Error('Date must be in DD-MM-YYYY format');
      }
      
      if (isNaN(appointmentDate.getTime())) {
        throw new Error('Invalid date');
      }
      
      // Check if date is in the past
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      appointmentDate.setHours(0, 0, 0, 0);
      
      if (appointmentDate < today) {
        throw new Error('Appointment date cannot be in the past');
      }
      
      return true;
    })
    .customSanitizer((value) => {
      if (!value) return value;
      const ddmmyyyyRegex = /^(\d{2})-(\d{2})-(\d{4})$/;
      if (ddmmyyyyRegex.test(value)) {
        const [, day, month, year] = value.match(ddmmyyyyRegex);
        return `${year}-${month}-${day}`;
      }
      return value;
    }),
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

body('appointment_date')
  .custom((value) => {
    // Accept both DD-MM-YYYY and YYYY-MM-DD
    const ddmmyyyy = moment(value, 'DD-MM-YYYY', true);
    const yyyymmdd = moment(value, 'YYYY-MM-DD', true);
    
    if (!ddmmyyyy.isValid() && !yyyymmdd.isValid()) {
      throw new Error('Date must be in DD-MM-YYYY or YYYY-MM-DD format');
    }
    
    const date = ddmmyyyy.isValid() ? ddmmyyyy : yyyymmdd;
    if (date.isBefore(moment().startOf('day'))) {
      throw new Error('Appointment date cannot be in the past');
    }
    
    return true;
  })