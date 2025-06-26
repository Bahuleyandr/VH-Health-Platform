import { body } from 'express-validator';

export const updatePharmacyOrderValidation = [
  body('phone').isMobilePhone('en-IN').withMessage('Valid phone number required'),
  body('order_id').isInt({ min: 1 }).withMessage('Valid order ID required'),
  body('status').isIn(['pending', 'preparing', 'ready', 'dispensed', 'cancelled']).withMessage('Valid status required'),
  body('notes').optional().isLength({ max: 500 }).withMessage('Notes too long (max 500 characters)'),
  body('dispensed_medications').optional().isArray().withMessage('Dispensed medications must be an array'),
  body('pharmacist_notes').optional().isString().withMessage('Pharmacist notes must be a string')
];