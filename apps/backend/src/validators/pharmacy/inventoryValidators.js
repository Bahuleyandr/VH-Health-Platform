import { query } from 'express-validator';

export const inventoryQueryValidation = [
  query('threshold').optional().isInt({ min: 1, max: 1000 }).withMessage('Threshold must be between 1 and 1000'),
  query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Days must be between 1 and 365')
];