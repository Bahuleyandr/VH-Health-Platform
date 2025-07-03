// src/validators/department/departmentAuditValidator.js
import { param, query } from 'express-validator';
import { validate } from './departmentValidator.js';

export const getDepartmentHistoryValidation = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Department ID must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Limit must be between 1 and 200'),
  
  validate
];