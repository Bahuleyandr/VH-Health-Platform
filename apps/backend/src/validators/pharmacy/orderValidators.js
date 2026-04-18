import { body, param, query } from 'express-validator';
import { ORDER_STATUS } from '../../config/pharmacyConfig.js';

export const placeOrderValidation = [
  body('phone').isMobilePhone('en-IN').withMessage('Valid Indian phone number required'),
  body('order_note').notEmpty().trim().withMessage('Order note is required'),
  body('file_key').optional().isString().withMessage('File key must be a string'),
  body('prescription_id').optional().isInt({ min: 1 }).withMessage('Valid prescription ID required'),
  body('urgent').optional().isBoolean().withMessage('Urgent must be boolean')
];

export const updateOrderStatusValidation = [
  param('orderId').isInt({ min: 1 }).withMessage('Valid order ID required'),
  body('status').isIn(Object.values(ORDER_STATUS)).withMessage('Invalid status'),
  body('notes').optional().isString().isLength({ max: 500 }).withMessage('Notes too long (max 500 characters)')
];

export const getOrdersValidation = [
  query('status').optional().isIn(Object.values(ORDER_STATUS)).withMessage('Invalid status filter'),
  query('limit').optional().isInt({ min: 1, max: 200 }).withMessage('Limit must be between 1 and 200'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be non-negative')
];

export const phoneParamValidation = [
  param('phone').isMobilePhone('en-IN').withMessage('Valid Indian phone number required')
];

export const uidParamValidation = [
  param('uid').isUUID().withMessage('Valid UID required')
];