// src/validators/smsConfigValidator.js
//
// express-validator chains for the admin SMS gateway config surface
// (/api/v1/admin/notifications/sms/*). Built from the sharedValidators
// primitives (PR #785 convention). Secrets are write-only strings; the
// service encrypts and never echoes them.

import { body, param } from 'express-validator';
import {
  optionalString,
} from './sharedValidators.js';

const SMS_PROVIDERS = ['msg91', 'twilio', 'dry_run'];

/** PUT /api/v1/admin/notifications/sms/config */
export const smsConfigUpsertValidator = [
  body('provider')
    .exists({ checkFalsy: true }).withMessage('provider is required')
    .isIn(SMS_PROVIDERS).withMessage(`provider must be one of: ${SMS_PROVIDERS.join(', ')}`),
  body('enabled')
    .optional({ nullable: true })
    .isBoolean().withMessage('enabled must be a boolean')
    .toBoolean(),
  optionalString('sender_id', 20),
  optionalString('dlt_entity_id', 40),
  optionalString('auth_key', 200),
  optionalString('account_sid', 64),
  body('rotate_callback_token')
    .optional({ nullable: true })
    .isBoolean().withMessage('rotate_callback_token must be a boolean')
    .toBoolean(),
];

/** POST /api/v1/admin/notifications/sms/templates */
export const smsTemplateCreateValidator = [
  body('template_key')
    .exists({ checkFalsy: true }).withMessage('template_key is required')
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 }).withMessage('template_key must be 1-120 chars'),
  body('dlt_template_id')
    .exists({ checkFalsy: true }).withMessage('dlt_template_id is required')
    .isString()
    .trim()
    .isLength({ min: 1, max: 40 }).withMessage('dlt_template_id must be 1-40 chars'),
  optionalString('provider_template_id', 64),
  body('provider_config_id')
    .optional({ nullable: true })
    .isInt({ min: 1 }).withMessage('provider_config_id must be a positive integer')
    .toInt(),
  body('active')
    .optional({ nullable: true })
    .isBoolean().withMessage('active must be a boolean')
    .toBoolean(),
];

/** PUT /api/v1/admin/notifications/sms/templates/:id */
export const smsTemplateUpdateValidator = [
  param('id')
    .isInt({ min: 1 }).withMessage('id must be a positive integer'),
  optionalString('dlt_template_id', 40),
  optionalString('provider_template_id', 64),
  body('active')
    .optional({ nullable: true })
    .isBoolean().withMessage('active must be a boolean')
    .toBoolean(),
];

export default {
  smsConfigUpsertValidator,
  smsTemplateCreateValidator,
  smsTemplateUpdateValidator,
};
