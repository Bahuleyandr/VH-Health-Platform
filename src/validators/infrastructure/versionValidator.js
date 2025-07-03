// validators/infrastructure/versionValidator.js
import { query, body } from 'express-validator';

// Metrics query validation
export const metricsQueryValidator = [
  query('format')
    .optional()
    .isIn(['json', 'csv', 'prometheus'])
    .withMessage('Invalid format'),
  query('includeSystem')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('includeSystem must be boolean')
];

// History query validation
export const historyQueryValidator = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
];

// Export query validation
export const exportQueryValidator = [
  query('format')
    .optional()
    .isIn(['json', 'csv', 'xml'])
    .withMessage('Invalid export format'),
  query('includeAudit')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('includeAudit must be boolean'),
  query('includeInactive')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('includeInactive must be boolean')
];