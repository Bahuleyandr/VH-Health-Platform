// src/routes/admin/smsConfigRoutes.js
//
// Admin surface for the SMS gateway config (migrations 699/700), mounted
// under /api/v1/admin/notifications/sms (requireRole ADMIN tiers +
// requireSuperAdminStepUp + adminIpAllowlist + adminRateLimiter in app.js,
// via routes/admin/index.js). Tenant provenance is server-derived.
//
// Secrets are WRITE-ONLY: auth_key goes in, only has_auth_key comes back.
// The DLR callback token plaintext appears exactly once — in the PUT /config
// response that minted it — and only its SHA-256 is stored (it is the
// authentication for the public /webhooks/sms mount).

import express from 'express';
import { validationResult } from 'express-validator';

import { markRouterDomain } from '../../config/openapiDomain.js';
import {
  listSmsProviderConfigs,
  upsertSmsProviderConfig,
  listSmsTemplateRegistrations,
  createSmsTemplateRegistration,
  updateSmsTemplateRegistration,
} from '../../services/notification/smsProviderConfigService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, relayAppError } from '../../utils/responseHelper.js';
import {
  smsConfigUpsertValidator,
  smsTemplateCreateValidator,
  smsTemplateUpdateValidator,
} from '../../validators/smsConfigValidator.js';

const router = markRouterDomain(express.Router(), 'sms-gateway');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'SMS gateway config error');
    }
  };
}

router.get('/config', wrap(async (req) => listSmsProviderConfigs(resolveTenantOrThrow(req))));

router.put('/config', ...smsConfigUpsertValidator, validate, wrap(async (req) => {
  const view = await upsertSmsProviderConfig({
    tenantId: resolveTenantOrThrow(req),
    provider: req.body.provider,
    enabled: req.body.enabled,
    sender_id: req.body.sender_id,
    dlt_entity_id: req.body.dlt_entity_id,
    auth_key: req.body.auth_key,
    account_sid: req.body.account_sid,
    rotate_callback_token: req.body.rotate_callback_token,
    created_by: req.user?.uid,
  });
  await logAudit(req, 'SMS_GATEWAY_CONFIG_UPSERTED', {
    provider: view?.provider ?? req.body?.provider ?? null,
    enabled: view?.enabled === true,
    // Booleans only — never secret material or the token itself.
    auth_key_present: Boolean(req.body?.auth_key),
    callback_token_minted: Boolean(view?.callback_token),
    source: 'sms_gateway',
  }, {
    resource: 'sms_provider_config',
    resourceId: view?.id ?? null,
  });
  return view;
}));

router.get('/templates', wrap(async (req) => ({
  templates: await listSmsTemplateRegistrations(resolveTenantOrThrow(req)),
})));

router.post('/templates', ...smsTemplateCreateValidator, validate, wrap(async (req) => {
  const registration = await createSmsTemplateRegistration({
    tenantId: resolveTenantOrThrow(req),
    provider_config_id: req.body.provider_config_id,
    template_key: req.body.template_key,
    dlt_template_id: req.body.dlt_template_id,
    provider_template_id: req.body.provider_template_id,
    active: req.body.active !== undefined ? req.body.active : true,
    created_by: req.user?.uid,
  });
  await logAudit(req, 'SMS_TEMPLATE_REGISTERED', {
    template_key: registration?.template_key ?? null,
    dlt_template_id: registration?.dlt_template_id ?? null,
    source: 'sms_gateway',
  }, {
    resource: 'sms_template_registration',
    resourceId: registration?.id ?? null,
  });
  return registration;
}));

router.put('/templates/:id', ...smsTemplateUpdateValidator, validate, wrap(async (req) => {
  const registration = await updateSmsTemplateRegistration({
    tenantId: resolveTenantOrThrow(req),
    id: req.params.id,
    dlt_template_id: req.body.dlt_template_id,
    provider_template_id: req.body.provider_template_id,
    active: req.body.active,
  });
  await logAudit(req, 'SMS_TEMPLATE_REGISTRATION_UPDATED', {
    template_key: registration?.template_key ?? null,
    active: registration?.active === true,
    source: 'sms_gateway',
  }, {
    resource: 'sms_template_registration',
    resourceId: registration?.id ?? null,
  });
  return registration;
}));

export default router;
