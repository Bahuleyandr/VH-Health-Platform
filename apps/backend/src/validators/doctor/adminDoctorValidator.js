// src/validators/doctor/adminDoctorValidator.js
import { body, param, query } from 'express-validator';
import { DOCTOR_CONFIG } from '../../config/doctorConfig.js';

export const adminDoctorValidators = {
  // Create doctor account
  createDoctor: [
    body('name').notEmpty().trim().withMessage('Name is required'),
    body('phone')
      .optional()
      .matches(/^\+?[\d\s-()]+$/)
      .withMessage('Valid phone number required'),
    body('email')
      .optional()
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required'),
    body('gender')
      .optional()
      .isIn(['MALE', 'FEMALE', 'OTHER'])
      .withMessage('Invalid gender'),
    body('birthday')
      .optional()
      .matches(/^\d{2}-\d{2}-\d{4}$/)
      .withMessage('Birthday must be in DD-MM-YYYY format'),
    body('specialization').notEmpty().withMessage('Specialization is required'),
    body('department')
      .notEmpty()
      .withMessage('Department is required'),
    body('consultation_fee')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Consultation fee must be a positive number')
  ],

  // Bulk operations
  bulkOperations: [
    body('operation')
      .notEmpty()
      .isIn(['activate', 'deactivate', 'update_fee', 'change_department', 'update_schedule'])
      .withMessage('Invalid operation'),
    body('doctor_ids')
      .isArray({ min: 1, max: DOCTOR_CONFIG.BULK_OPERATION_LIMIT })
      .withMessage(`Doctor IDs must be an array with 1-${DOCTOR_CONFIG.BULK_OPERATION_LIMIT} items`),
    body('doctor_ids.*')
      .isInt({ min: 1 })
      .withMessage('Each doctor ID must be a valid integer'),
    body('data').optional().isObject().withMessage('Data must be an object'),
    body('data.consultation_fee')
      .optional()
      .isFloat({ min: DOCTOR_CONFIG.FEE_RANGES.MIN, max: DOCTOR_CONFIG.FEE_RANGES.MAX })
      .withMessage('Invalid consultation fee'),
    body('data.department')
      .optional()
      .isIn(DOCTOR_CONFIG.DEPARTMENTS)
      .withMessage('Invalid department')
  ],

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

updateAvailability: [
  param('id').isInt({ min: 1 }).withMessage('Valid doctor ID is required'),
  body('is_available')
    .notEmpty()
    .isBoolean()
    .withMessage('is_available must be a boolean'),
  body('available_days')
    .optional()
    .isArray()
    .withMessage('Available days must be an array'),
  // Day names — accept any case (admin form sends lowercase, legacy code
   // sent UPPERCASE). Normalised downstream by the controller before insert.
  body('available_days.*')
    .optional()
    .custom((value) => {
      if (typeof value !== 'string') {
        throw new Error('Invalid day specified');
      }
      if (!DOCTOR_CONFIG.WEEK_DAYS.includes(value.toUpperCase())) {
        throw new Error('Invalid day specified');
      }
      return true;
    }),
  // Accept either a single 'HH:mm-HH:mm' window or a per-day map
  // ({ monday: 'HH:mm-HH:mm', ... }) to match the doctors.available_hours
  // jsonb column shape that the admin form actually sends.
  body('available_hours')
    .optional()
    .custom((value) => {
      if (value == null) return true;
      const RANGE = /^\d{2}:\d{2}-\d{2}:\d{2}$/;
      if (typeof value === 'string') {
        if (!RANGE.test(value)) {
          throw new Error('Available hours must be in HH:mm-HH:mm format');
        }
        return true;
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [day, hrs] of Object.entries(value)) {
          if (typeof hrs !== 'string' || !RANGE.test(hrs)) {
            throw new Error(`Available hours for "${day}" must be HH:mm-HH:mm`);
          }
        }
        return true;
      }
      throw new Error('Available hours must be a string or per-day map');
    }),
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason must not exceed 500 characters')
],
  // Analytics
  getAnalytics: [
    param('id').isInt({ min: 1 }).withMessage('Valid doctor ID is required'),
    query('months')
      .optional()
      .isInt({ min: 1, max: 12 })
      .withMessage('Months must be between 1 and 12')
  ],

  // Workload analysis
  workloadAnalysis: [
    query('days')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Days must be between 1 and 365'),
    query('department')
      .optional()
      .isIn(DOCTOR_CONFIG.DEPARTMENTS)
      .withMessage('Invalid department')
  ],

  // Delete doctor
  deleteDoctor: [
    param('id').isInt({ min: 1 }).withMessage('Valid doctor ID is required'),
    body('reason')
      .optional()
      .isLength({ max: 500 })
      .withMessage('Reason must not exceed 500 characters'),
    body('transfer_patients_to')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Transfer doctor ID must be valid')
  ]
};