import { body, param, validationResult } from 'express-validator';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
// import { isValidTimeSlot } from '../../utils/appointment/dateTimeUtils.js';

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
  body().custom((_value, { req }) => {
    if (!req.body.patient_id && !req.body.patient_phone) {
      throw new Error('Patient ID or patient phone is required');
    }
    return true;
  }),
  body('patient_id')
    .optional({ values: 'falsy' })
    .isInt({ min: 1 })
    .withMessage('Patient ID must be a valid integer'),
  body('patient_phone')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 10, max: 20 })
    .withMessage('Patient phone must be 10-20 characters'),
  body('patient_name')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 2, max: 255 })
    .withMessage('Patient name must be 2-255 characters'),
  body('doctor_uid')
    .optional({ values: 'falsy' })
    .isUUID()
    .withMessage('Doctor UID must be a valid UUID'),
  // doctor_id is required for OPD/clinical visits but optional for lab-only,
  // radiology-only, pathology-only walk-ins where the patient never sees a
  // consultant. See finding 2026-05-08-lab-walk-in-receptionist-book-requires-doctor.
  body('doctor_id')
    .if((value, { req }) => {
      const dept = String(req.body?.department || '').toUpperCase();
      const visitType = String(req.body?.visit_type || '').toUpperCase();
      const labOnlyDept = ['LAB', 'LABORATORY', 'PATHOLOGY', 'RADIOLOGY', 'IMAGING'].includes(dept);
      const labOnlyVisit = ['LAB_ONLY', 'RADIOLOGY_ONLY', 'INVESTIGATION'].includes(visitType);
      const hasDoctorUid = Boolean(req.body?.doctor_uid);
      // If neither suggests lab/radiology-only, require doctor_id.
      return !(labOnlyDept || labOnlyVisit || hasDoctorUid);
    })
    .isInt({ min: 1 })
    .withMessage('Doctor ID must be a valid integer'),
  body('doctor_id')
    .if((value, { req }) => {
      const dept = String(req.body?.department || '').toUpperCase();
      const visitType = String(req.body?.visit_type || '').toUpperCase();
      const labOnlyDept = ['LAB', 'LABORATORY', 'PATHOLOGY', 'RADIOLOGY', 'IMAGING'].includes(dept);
      const labOnlyVisit = ['LAB_ONLY', 'RADIOLOGY_ONLY', 'INVESTIGATION'].includes(visitType);
      return labOnlyDept || labOnlyVisit;
    })
    .optional({ values: 'falsy' })
    .isInt({ min: 1 })
    .withMessage('Doctor ID, when provided, must be a valid integer'),
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
      if (!value) {return true;} // Optional field
      
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
      if (!value) {return value;}
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
