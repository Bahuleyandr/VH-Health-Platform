// src/validators/paymentGatewayValidator.js
//
// express-validator chains for the payment gateway surface
// (/api/v1/billing/gateway/*). Built from the sharedValidators primitives
// (PR #785 convention). Amount bounds mirror billingV2: positive decimal
// rupees; the service re-validates against the invoice/link due.

import { body } from 'express-validator';
import {
  paramId,
  optionalString,
  optionalEnum,
} from './sharedValidators.js';

const GATEWAY_PROVIDERS = ['razorpay', 'dry_run'];
const GATEWAY_ENVIRONMENTS = ['sandbox', 'production'];
const GATEWAY_METHODS = ['upi', 'card', 'netbanking', 'wallet'];

/** POST /api/v1/billing/gateway/orders */
export const gatewayOrderCreateValidator = [
  body('invoice_id')
    .optional({ nullable: true })
    .isInt({ min: 1 }).withMessage('invoice_id must be a positive integer')
    .toInt(),
  optionalString('payment_link_token', 64),
  body('amount')
    .optional({ nullable: true })
    .isFloat({ min: 0.01 }).withMessage('amount must be a positive number')
    .toFloat(),
  body('payment_link_token').custom((value, { req }) => {
    if (!value && !req.body?.invoice_id) {
      throw new Error('One of invoice_id or payment_link_token is required');
    }
    return true;
  }),
];

/** POST /api/v1/billing/gateway/orders/:id/cancel + GET /orders/:id */
export const gatewayOrderIdValidator = [paramId('id')];

/** POST /api/v1/billing/gateway/refunds */
export const gatewayRefundCreateValidator = [
  body('billing_refund_id')
    .exists({ checkFalsy: true }).withMessage('billing_refund_id is required')
    .isInt({ min: 1 }).withMessage('billing_refund_id must be a positive integer')
    .toInt(),
];

/** PUT /api/v1/billing/gateway/config */
export const gatewayConfigUpsertValidator = [
  body('provider')
    .exists({ checkFalsy: true }).withMessage('provider is required')
    .isIn(GATEWAY_PROVIDERS).withMessage(`provider must be one of: ${GATEWAY_PROVIDERS.join(', ')}`),
  optionalEnum('environment', GATEWAY_ENVIRONMENTS),
  body('enabled')
    .optional({ nullable: true })
    .isBoolean().withMessage('enabled must be a boolean')
    .toBoolean(),
  optionalString('display_name', 120),
  optionalString('key_id', 120),
  optionalString('key_secret', 200),
  optionalString('webhook_secret', 200),
  body('accepted_methods')
    .optional({ nullable: true })
    .isArray({ min: 1 }).withMessage('accepted_methods must be a non-empty array'),
  body('accepted_methods.*')
    .optional()
    .isIn(GATEWAY_METHODS).withMessage(`accepted_methods entries must be one of: ${GATEWAY_METHODS.join(', ')}`),
];

export default {
  gatewayOrderCreateValidator,
  gatewayOrderIdValidator,
  gatewayRefundCreateValidator,
  gatewayConfigUpsertValidator,
};
