// validators/infrastructure/swaggerValidator.js
import { body, query } from 'express-validator';

// Stats query validation
export const statsQueryValidator = [
  query('format')
    .optional()
    .isIn(['json', 'summary'])
    .withMessage('Format must be json or summary')
];

// Validation query validation  
export const validationQueryValidator = [
  query('strict')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('Strict validation flag must be boolean')
];

// Discovery query validation
export const discoveryQueryValidator = [
  query('tag')
    .optional()
    .isLength({ min: 1 })
    .withMessage('Tag filter cannot be empty'),
  query('method')
    .optional()
    .isIn(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    .withMessage('Invalid HTTP method')
];

// Regenerate documentation validation
export const regenerateDocValidator = [
  body('source')
    .optional()
    .isIn(['file', 'fallback'])
    .withMessage('Source must be file or fallback'),
  body('force')
    .optional()
    .isBoolean()
    .toBoolean()
    .withMessage('Force flag must be boolean')
];

// Analytics query validation
export const analyticsQueryValidator = [
  query('timeframe')
    .optional()
    .matches(/^\d+d$/)
    .withMessage('Timeframe must be in format like 30d')
];