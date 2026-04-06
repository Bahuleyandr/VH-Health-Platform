// src/validators/record/recordValidators.js
import { body, query, param } from 'express-validator';
import { VALID_RECORD_TYPES } from '../../config/recordConfig.js';

export const recordCreateValidator = [
  body('patient_id')
    .notEmpty()
    .withMessage('Patient ID is required')
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID'),
  body('record_type')
    .isIn(VALID_RECORD_TYPES)
    .withMessage('Invalid record type'),
  body('title')
    .isLength({ min: 1, max: 200 })
    .withMessage('Title required (max 200 chars)')
    .trim(),
  body('description')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Description too long')
    .trim(),
  body('privacy_level')
    .optional()
    .isIn([0, 1, 2, 3])
    .withMessage('Invalid privacy level')
];

export const doctorIdValidator = [
  param('doctor_id')
    .isInt({ min: 1 })
    .withMessage('Invalid doctor ID')
];

export const recordUpdateValidator = [
  body('title')
    .optional()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title too long')
    .trim(),
  body('description')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Description too long')
    .trim(),
  body('diagnosis')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Diagnosis too long')
    .trim(),
  body('treatment')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Treatment description too long')
    .trim(),
  body('medications')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Medications list too long'),
  body('lab_results')
    .optional()
    .isLength({ max: 5000 })
    .withMessage('Lab results too long')
];

export const healthRecordCreateValidator = [
  body('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone must be 10 digits'),
  body('file_key')
    .notEmpty()
    .withMessage('File key is required'),
  body('file_name')
    .notEmpty()
    .withMessage('File name is required')
    .isLength({ max: 255 })
    .withMessage('File name too long'),
  body('file_type')
    .notEmpty()
    .withMessage('File type is required')
    .isLength({ max: 50 })
    .withMessage('File type too long'),
  body('privacy_level')
    .optional()
    .isIn([0, 1, 2, 3])
    .withMessage('Invalid privacy level'),
  body('notes')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Notes too long')
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

export const filterValidator = [
  query('type')
    .optional()
    .isIn(VALID_RECORD_TYPES)
    .withMessage('Invalid record type'),
  query('date_from')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format (use YYYY-MM-DD)'),
  query('date_to')
    .optional()
    .isISO8601()
    .withMessage('Invalid date format (use YYYY-MM-DD)'),
  query('patient_id')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID'),
  query('doctor_id')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Invalid doctor ID')
];

export const recordIdValidator = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Invalid record ID')
];

export const patientIdValidator = [
  param('patient_id')
    .isInt({ min: 1 })
    .withMessage('Invalid patient ID')
];

export const phoneValidator = [
  param('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone must be 10 digits')
];

export const uidValidator = [
  param('uid')
    .notEmpty()
    .withMessage('UID is required')
];

export const deleteReasonValidator = [
  body('reason')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Reason too long')
    .trim()
];