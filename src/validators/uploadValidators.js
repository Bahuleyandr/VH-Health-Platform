// src/validators/uploadValidators.js - Hospital Upload Validations

import { body, query, param } from 'express-validator';
import { HOSPITAL_UPLOAD_CONFIG } from '../config/uploadConfig.js';

export const uploadValidation = [
  body('category')
    .optional()
    .isIn(HOSPITAL_UPLOAD_CONFIG.allowedCategories)
    .withMessage(`Category must be one of: ${HOSPITAL_UPLOAD_CONFIG.allowedCategories.join(', ')}`),
  body('patientPhone')
    .optional()
    .isMobilePhone('any')
    .withMessage('Invalid patient phone number format'),
  body('description')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Description must be less than 1000 characters'),
  body('isPrivate')
    .optional()
    .isBoolean()
    .withMessage('isPrivate must be boolean'),
  body('relatedId')
    .optional()
    .isUUID()
    .withMessage('relatedId must be valid UUID'),
  body('hipaaProtected')
    .optional()
    .isBoolean()
    .withMessage('hipaaProtected must be boolean')
];

export const fileIdValidation = [
  param('fileId').isUUID().withMessage('File ID must be valid UUID')
];

export const listFilesValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be 1-100'),
  query('category').optional().isIn(HOSPITAL_UPLOAD_CONFIG.allowedCategories),
  query('scanStatus').optional().isIn(['pending', 'clean', 'infected', 'failed', 'all']),
  query('hipaaOnly').optional().isBoolean(),
  query('urgencyLevel').optional().isIn(['normal', 'high', 'urgent'])
];

export const downloadUrlValidation = [
  ...fileIdValidation,
  query('expiresIn').optional().isInt({ min: 60, max: 86400 }).withMessage('Expires must be 60-86400 seconds')
];

export const statsValidation = [
  query('timeframe').optional().isIn(['7d', '30d', '90d', '1y']).withMessage('Invalid timeframe'),
  query('detailed').optional().isBoolean()
];

export const deleteFileValidation = [
  ...fileIdValidation,
  body('reason').optional().isLength({ max: 500 }).withMessage('Reason must be less than 500 characters'),
  body('permanentDelete').optional().isBoolean()
];

export const hipaaProtectionValidation = [
  body('fileIds').isArray({ min: 1, max: 100 }).withMessage('File IDs array required (1-100 items)'),
  body('fileIds.*').isUUID().withMessage('Each file ID must be valid UUID'),
  body('setHipaaProtected').isBoolean().withMessage('setHipaaProtected must be boolean'),
  body('reason').isLength({ min: 10, max: 500 }).withMessage('Reason required (10-500 characters)')
];

export const cleanupValidation = [
  body('dryRun').optional().isBoolean(),
  body('category').optional().isIn(HOSPITAL_UPLOAD_CONFIG.allowedCategories),
  body('olderThanDays').optional().isInt({ min: 1, max: 3650 })
];

export const purgeValidation = [
  body('olderThanDays').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be 1-365'),
  body('confirmPurge').isBoolean().withMessage('Confirmation required')
];