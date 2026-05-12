import { query, param } from 'express-validator';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { handleValidationErrors } from './appointmentValidators.js';

// Resolve the `today` / `tomorrow` / `yesterday` keyword shorthands the
// staff and patient apps send for date filters into a real ISO date,
// so the existing `isISO8601()` rule below stays strict. Symmetric with
// how the legacy `/queue/today` endpoint hardcodes CURRENT_DATE server-
// side — both Flutter clients use literal "today" interchangeably.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const dateKeywordSanitizer = (value) => {
  if (typeof value !== 'string') return value;
  const v = value.trim().toLowerCase();
  const today = new Date();
  if (v === 'today') return today.toISOString().slice(0, 10);
  if (v === 'tomorrow') return new Date(today.getTime() + ONE_DAY_MS).toISOString().slice(0, 10);
  if (v === 'yesterday') return new Date(today.getTime() - ONE_DAY_MS).toISOString().slice(0, 10);
  return value;
};

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
    .customSanitizer(dateKeywordSanitizer)
    .isISO8601()
    .withMessage('Date must be in YYYY-MM-DD format (or "today" / "tomorrow" / "yesterday")'),
  query('advised_for_admission')
    .optional()
    .isIn(['true', 'false', '1', '0'])
    .withMessage('advised_for_admission must be true / false / 1 / 0'),
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
    .customSanitizer(dateKeywordSanitizer)
    .isISO8601()
    .withMessage('Date must be in YYYY-MM-DD format (or "today" / "tomorrow" / "yesterday")'),
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