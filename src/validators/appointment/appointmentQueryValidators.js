import { query, param } from 'express-validator';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { handleValidationErrors } from './appointmentValidators.js';

export const listAppointmentsValidators = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('status')
    .optional()
    .toUpperCase()
    .isIn(Object.values(APPOINTMENT_CONFIG.STATUSES))
    .withMessage(`Status must be one of: ${Object.values(APPOINTMENT_CONFIG.STATUSES).join(', ')}`),
  query('doctor_id')
    .optional()
    .isInt()
    .withMessage('Doctor ID must be a valid integer'),
  query('patient_id')
    .optional()
    .isInt()
    .withMessage('Patient ID must be a valid integer'),
  query('date')
    .optional()
    .isISO8601()
    .withMessage('Date must be in YYYY-MM-DD format'),
  handleValidationErrors
];

export const getAppointmentByIdValidators = [
  param('id').isInt().withMessage('Appointment ID must be a valid integer'),
  handleValidationErrors
];

export const getDoctorAppointmentsValidators = [
  param('doctor_id').isInt().withMessage('Doctor ID must be a valid integer'),
  query('date')
    .optional()
    .isISO8601()
    .withMessage('Date must be in YYYY-MM-DD format'),
  query('status')
    .optional()
    .toUpperCase()
    .isIn(Object.values(APPOINTMENT_CONFIG.STATUSES))
    .withMessage(`Status must be one of: ${Object.values(APPOINTMENT_CONFIG.STATUSES).join(', ')}`),
  handleValidationErrors
];

export const getPatientAppointmentsValidators = [
  param('patient_id').isInt().withMessage('Patient ID must be a valid integer'),
  query('status')
    .optional()
    .toUpperCase()
    .isIn(Object.values(APPOINTMENT_CONFIG.STATUSES))
    .withMessage(`Status must be one of: ${Object.values(APPOINTMENT_CONFIG.STATUSES).join(', ')}`),
  handleValidationErrors
];