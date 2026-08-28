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
import { toPaise } from '../utils/money.js';

const GATEWAY_PROVIDERS = ['razorpay', 'dry_run'];
const GATEWAY_ENVIRONMENTS = ['sandbox', 'production'];
const GATEWAY_METHODS = ['upi', 'card', 'netbanking', 'wallet'];
const GATEWAY_REFUND_RECONCILIATION_DISPOSITIONS = [
  'provider_processed',
  'provider_failed',
  'provider_pending',
  'provider_status_unknown',
];
const GATEWAY_REFUND_RECONCILIATION_SOURCES = [
  'provider_dashboard',
  'provider_support',
  'bank_statement',
  'other_authoritative',
];
const GATEWAY_REFUND_RECONCILIATION_PROVIDER_STATUSES = [
  'processed',
  'failed',
  'pending',
  'unknown',
];
const REFUND_DISPOSITION_PROVIDER_STATUS = Object.freeze({
  provider_processed: 'processed',
  provider_failed: 'failed',
  provider_pending: 'pending',
  provider_status_unknown: 'unknown',
});

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
    .bail()
    .custom((value) => {
      try {
        const parsed = Number(value);
        if (typeof value === 'number'
            && Math.abs(parsed - Math.round(parsed * 100) / 100) > 1e-9) {
          throw new Error('sub-paisa precision');
        }
        toPaise(typeof value === 'number' ? value : String(value).trim());
        return true;
      } catch {
        throw new Error('amount must have at most 2 decimal places');
      }
    })
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

/** POST /api/v1/billing/gateway/orders/:id/reconcile */
export const gatewayOrderReconcileValidator = [
  paramId('id'),
  body('note')
    .exists({ checkFalsy: true }).withMessage('note is required')
    .isString()
    .trim()
    .isLength({ min: 10, max: 500 }).withMessage('note must be 10-500 chars describing the manual resolution'),
];

/** POST /api/v1/billing/gateway/refunds/:id/reconcile */
export const gatewayRefundReconcileValidator = [
  paramId('id'),
  body().custom((value) => {
    const allowed = new Set(['disposition', 'evidence']);
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('request body must be an object');
    }
    if (Object.keys(value).some(key => !allowed.has(key))) {
      throw new Error('request contains unsupported fields');
    }
    return true;
  }),
  body('disposition')
    .exists({ checkFalsy: true }).withMessage('disposition is required')
    .isString()
    .trim()
    .isIn(GATEWAY_REFUND_RECONCILIATION_DISPOSITIONS)
    .withMessage(`disposition must be one of: ${GATEWAY_REFUND_RECONCILIATION_DISPOSITIONS.join(', ')}`),
  body('evidence')
    .exists({ checkNull: true }).withMessage('evidence is required')
    .isObject({ strict: true }).withMessage('evidence must be an object')
    .bail()
    .custom((value) => {
      const allowed = new Set(['source', 'reference', 'observed_at', 'provider_status', 'notes']);
      if (Object.keys(value).some(key => !allowed.has(key))) {
        throw new Error('evidence contains unsupported fields');
      }
      return true;
    }),
  body('evidence.source')
    .exists({ checkFalsy: true }).withMessage('evidence.source is required')
    .isString()
    .trim()
    .isIn(GATEWAY_REFUND_RECONCILIATION_SOURCES)
    .withMessage(`evidence.source must be one of: ${GATEWAY_REFUND_RECONCILIATION_SOURCES.join(', ')}`),
  body('evidence.reference')
    .exists({ checkFalsy: true }).withMessage('evidence.reference is required')
    .isString()
    .trim()
    .isLength({ min: 6, max: 255 }).withMessage('evidence.reference must be 6-255 chars'),
  body('evidence.observed_at')
    .exists({ checkFalsy: true }).withMessage('evidence.observed_at is required')
    .isString()
    .isISO8601({ strict: true, strictSeparator: true })
    .withMessage('evidence.observed_at must be a valid ISO 8601 date-time')
    .bail()
    .custom((value) => {
      if (Date.parse(value) > Date.now()) {
        throw new Error('evidence.observed_at cannot be in the future');
      }
      return true;
    }),
  body('evidence.provider_status')
    .exists({ checkFalsy: true }).withMessage('evidence.provider_status is required')
    .isString()
    .trim()
    .isIn(GATEWAY_REFUND_RECONCILIATION_PROVIDER_STATUSES)
    .withMessage(`evidence.provider_status must be one of: ${GATEWAY_REFUND_RECONCILIATION_PROVIDER_STATUSES.join(', ')}`)
    .bail()
    .custom((value, { req }) => {
      const expected = REFUND_DISPOSITION_PROVIDER_STATUS[req.body?.disposition];
      if (expected && value !== expected) {
        throw new Error(`evidence.provider_status must be ${expected} for disposition ${req.body.disposition}`);
      }
      return true;
    }),
  body('evidence.notes')
    .optional({ nullable: true })
    .isString().withMessage('evidence.notes must be a string')
    .trim()
    .isLength({ max: 500 }).withMessage('evidence.notes must be at most 500 chars'),
];

/** POST /api/v1/billing/gateway/refunds/:id/recover */
export const gatewayRefundRecoveryValidator = [paramId('id')];

/** POST /api/v1/billing/gateway/refunds */
export const gatewayRefundCreateValidator = [
  body('billing_refund_id')
    .exists({ checkFalsy: true }).withMessage('billing_refund_id is required')
    .isInt({ min: 1 }).withMessage('billing_refund_id must be a positive integer')
    .toInt(),
  body('gateway_order_id')
    .exists({ checkFalsy: true }).withMessage('gateway_order_id is required')
    .isInt({ min: 1 }).withMessage('gateway_order_id must be a positive integer')
    .toInt(),
];

/** PUT /api/v1/billing/gateway/config */
export const gatewayConfigUpsertValidator = [
  body('provider')
    .exists({ checkFalsy: true }).withMessage('provider is required')
    .isIn(GATEWAY_PROVIDERS).withMessage(`provider must be one of: ${GATEWAY_PROVIDERS.join(', ')}`),
  optionalEnum('environment', GATEWAY_ENVIRONMENTS),
  // `enabled` is REQUIRED on every upsert: the DB upsert takes EXCLUDED.enabled,
  // so an omitted flag would silently flip a live config off (e.g. a PUT that
  // only rotates a secret). Forcing the caller to state it makes the
  // enable/disable decision always explicit.
  body('enabled')
    .exists().withMessage('enabled is required — an omitted flag would silently disable a live config')
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
  gatewayOrderReconcileValidator,
  gatewayRefundReconcileValidator,
  gatewayRefundRecoveryValidator,
  gatewayRefundCreateValidator,
  gatewayConfigUpsertValidator,
};
