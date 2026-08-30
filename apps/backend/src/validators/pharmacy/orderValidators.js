import { body, param, query } from 'express-validator';
import { ORDER_STATUS } from '../../config/pharmacyConfig.js';

const MAX_NUMERIC_14_4_SCALED = 99_999_999_999_999n;

export function isPositiveNumeric14_4Quantity(value) {
  if (value == null || ['boolean', 'symbol', 'function'].includes(typeof value)) return false;
  let quantityText;
  try {
    quantityText = String(value);
  } catch {
    return false;
  }
  if (quantityText !== quantityText.trim()) return false;
  const match = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,4}))?$/.exec(quantityText);
  if (!match) return false;
  const scaledQuantity = (BigInt(match[1]) * 10_000n)
    + BigInt((match[2] || '').padEnd(4, '0'));
  return scaledQuantity > 0n && scaledQuantity <= MAX_NUMERIC_14_4_SCALED;
}

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

// Pharmacist dispenses an in-stock same-formulation alternative for a prescribed brand.
export const dispenseSubstitutionValidator = [
  body('order_id').isInt({ min: 1 }).withMessage('Valid order_id required'),
  body('prescription_id').isInt({ min: 1 }).withMessage('Valid prescription_id required'),
  body('order_line_index').isInt({ min: 0 }).withMessage('Valid order_line_index required'),
  body('prescription_line_index').isInt({ min: 0 }).withMessage('Valid prescription_line_index required'),
  body('patient_uid').isUUID().withMessage('Valid patient UID required'),
  body('encounter_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Valid encounter_id required'),
  body('inventory_item_id').isInt({ min: 1 }).withMessage('Valid inventory_item_id required'),
  body('inventory_batch_id').isInt({ min: 1 }).withMessage('Valid inventory_batch_id required'),
  body('quantity')
    .custom(isPositiveNumeric14_4Quantity)
    .withMessage('quantity must be positive, fit NUMERIC(14,4), and have at most four decimal places'),
  body('original_catalog_id').isInt({ min: 1 }).withMessage('Valid original_catalog_id required'),
  body('final_catalog_id').isInt({ min: 1 }).withMessage('Valid final_catalog_id required'),
  body('reason').optional({ nullable: true }).isString().isLength({ max: 500 }).withMessage('Reason too long (max 500 characters)'),
  body('payment_mode').optional({ nullable: true }).isIn(['cash', 'card', 'upi', 'wallet', 'insurance', 'corporate_tpa']).withMessage('Invalid payment_mode'),
  body('amount_collected').optional({ nullable: true }).isFloat({ min: 0 }).withMessage('amount_collected must be non-negative'),
  body('tpa_reference').optional({ nullable: true }).isString().isLength({ min: 1, max: 160 }).withMessage('Invalid tpa_reference'),
  // Controlled (Schedule X / narcotic) substitutes: the one-time approval id
  // from the two-person witness flow. Deep validation (existence, fingerprint,
  // consumption) happens in controlledDispenseWitnessService.
  body('witness_approval_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Valid witness_approval_id required'),
  body('performed_by_name').not().exists().withMessage('performed_by_name is derived from the authenticated roster identity')
];
