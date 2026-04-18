// validators/infrastructure/debugValidator.js
import { body, query } from 'express-validator';

// Load test validation
export const loadTestValidator = [
  body('iterations')
    .optional()
    .isInt({ min: 1, max: 10000 })
    .withMessage('Iterations must be between 1 and 10000'),
  body('delay')
    .optional()
    .isInt({ min: 0, max: 1000 })
    .withMessage('Delay must be between 0 and 1000 ms')
];

// Log query validation
export const logQueryValidator = [
  query('level')
    .optional()
    .isIn(['all', 'info', 'warn', 'error', 'debug'])
    .withMessage('Invalid log level'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 1000 })
    .withMessage('Limit must be between 1 and 1000')
];

// Performance query validation
export const performanceQueryValidator = [
  query('timeframe')
    .optional()
    .isIn(['1h', '6h', '24h', '7d', '30d'])
    .withMessage('Invalid timeframe')
];