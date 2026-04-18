// src/validators/health/healthValidators.js
import { body, query, param } from 'express-validator';
import { HEALTH_RECORD_TYPES } from '../../config/healthConfig.js';

export const healthRecordCreateValidator = [
  body('patient_id')
    .notEmpty()
    .withMessage('Patient ID is required')
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID'),
  body('record_type')
    .optional()
    .isIn(HEALTH_RECORD_TYPES)
    .withMessage(`Invalid record type. Valid options: ${HEALTH_RECORD_TYPES.join(', ')}`),
  body('recorded_by')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Invalid recorder ID'),
  body('vital_signs')
    .optional()
    .isObject()
    .withMessage('Vital signs must be an object'),
  body('measurements')
    .optional()
    .isObject()
    .withMessage('Measurements must be an object'),
  body('symptoms')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Symptoms description too long')
    .trim(),
  body('notes')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Notes too long')
    .trim()
];

export const healthRecordUpdateValidator = [
  body('vital_signs')
    .optional()
    .isObject()
    .withMessage('Vital signs must be an object'),
  body('measurements')
    .optional()
    .isObject()
    .withMessage('Measurements must be an object'),
  body('symptoms')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Symptoms description too long')
    .trim(),
  body('notes')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Notes too long')
    .trim()
];

export const paginationValidator = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Offset must be non-negative')
];

export const recordFilterValidator = [
  query('patient_id')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID'),
  query('type')
    .optional()
    .isIn(HEALTH_RECORD_TYPES)
    .withMessage('Invalid record type'),
  query('date_from')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format (use YYYY-MM-DD)'),
  query('date_to')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format (use YYYY-MM-DD)')
];

export const patientIdValidator = [
  param('patient_id')
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID')
];

export const recordIdValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid record ID')
];

export const trendsValidator = [
  query('days')
    .optional()
    .isInt({ min: 1, max: 365 })
    .withMessage('Days must be between 1 and 365'),
  query('vital_type')
    .optional()
    .isString()
    .withMessage('Vital type must be a string')
];

export const activeOnlyValidator = [
  query('active_only')
    .optional()
    .isBoolean()
    .withMessage('active_only must be a boolean')
];