// src/utils/notifications/smsProviders/index.js
//
// SMS provider registry + per-tenant resolution (migrations 699/700).
//
// This module is the ONLY place that knows which concrete SMS gateway a
// tenant uses. `services/smsService.js` (the seam — exports exactly
// `sendSMS`, guarded by smsProviderSeam.test.js) delegates here; nothing
// else may import the seam, and nothing outside the notification layer
// should import this module either.
//
// Resolution order (config-gated, DEFAULT OFF — every step falls back to the
// dry-run logger, which never claims a delivery):
//   1. SMS_PROVIDER=logger — deployment-wide kill switch: everything dry-run.
//   2. tenants.settings.sms.enabled !== true — tenant gate closed: dry-run.
//   3. The tenant's single enabled sms_provider_configs row (699 partial
//      unique) — tenant-registered credentials (encryptField ciphertext) +
//      TRAI DLT identity (sender_id, dlt_entity_id).
//   4. Env fallback: SMS_PROVIDER=msg91|twilio with complete env credentials
//      (a deployment-shared account; the tenant gate in step 2 still holds).
//   5. Nothing configured: dry-run.
//
// India DLT compliance is fail-closed for every REAL provider: the outbox
// row's template_version must have an active sms_template_registrations row
// (699) carrying the tenant's DLT content template id. No registration ⇒
// terminal rejection `dlt_template_not_registered` — never an unregistered
// send (the row dead-letters; other templates keep delivering).

import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';
import { decryptField } from '../../fieldEncryption.js';
import { normalizeIndianSmsPhone } from '../../phoneUtils.js';
import { getSmsSettings } from '../../../services/tenant/tenantSettingsService.js';
import { sendViaMsg91 } from './msg91Provider.js';
import { sendViaTwilioSms } from './twilioSmsProvider.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLBACK_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function rejected(providerCode, evidence = {}) {
  return { outcome: 'rejected', providerReference: null, providerCode, evidence };
}

function uncertain(providerCode, evidence = {}) {
  return {
    outcome: 'uncertain',
    providerReference: null,
    providerCode,
    evidence,
  };
}

function envProviderName() {
  return String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
}

function envMsg91Complete() {
  return Boolean(process.env.MSG91_AUTH_KEY
    && process.env.MSG91_SENDER_ID
    && process.env.MSG91_DLT_ENTITY_ID);
}

function envTwilioSmsComplete() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_SMS_FROM);
}

/** The tenant's single enabled provider config row (full row — never return
 * it to a client; ciphertext stays inside this layer). */
async function getEnabledSmsConfigRow(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text, provider, enabled, sender_id, dlt_entity_id,
            auth_key_ciphertext, account_sid, callback_token_ciphertext
       FROM sms_provider_configs
      WHERE tenant_id = $1::uuid AND enabled = true
      LIMIT 1`,
    tenantId,
  );
  return rows[0] || null;
}

async function getSmsConfigRowForProvider(tenantId, provider) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text, provider, enabled, sender_id, dlt_entity_id,
            auth_key_ciphertext, account_sid, callback_token_ciphertext
       FROM sms_provider_configs
      WHERE tenant_id = $1::uuid AND provider = $2::text
      LIMIT 1`,
    tenantId, provider,
  );
  return rows[0] || null;
}

/**
 * Resolve which provider would handle a send for this tenant. Never throws —
 * any resolution failure lands on dry_run with a reason, and the dry-run
 * result is an honest `rejected('sms_gateway_not_configured')`.
 *
 * @returns {Promise<{provider: 'msg91'|'twilio'|'dry_run', source: string,
 *   reason: string|null, config: object|null}>}
 */
export async function resolveSmsProviderContext(tenantId) {
  if (envProviderName() === 'logger') {
    return { provider: 'dry_run', source: 'env', reason: 'env_kill_switch', config: null };
  }
  const tid = String(tenantId || '').trim();
  if (!UUID_RE.test(tid)) {
    return { provider: 'dry_run', source: 'default', reason: 'tenant_unresolved', config: null };
  }

  let settings;
  try {
    settings = await getSmsSettings(tid);
  } catch (err) {
    logger.warn('sms provider resolution: tenant settings lookup failed', { error: err?.message });
    return { provider: 'dry_run', source: 'default', reason: 'settings_unavailable', config: null };
  }
  if (!settings.enabled) {
    return { provider: 'dry_run', source: 'default', reason: 'tenant_disabled', config: null };
  }

  let config = null;
  try {
    config = await getEnabledSmsConfigRow(tid);
  } catch (err) {
    logger.error('sms provider resolution: config lookup failed', { error: err?.message });
    return { provider: 'dry_run', source: 'default', reason: 'config_unavailable', config: null };
  }
  if (config) {
    if (config.provider === 'dry_run') {
      return { provider: 'dry_run', source: 'tenant_config', reason: 'tenant_config_dry_run', config };
    }
    return { provider: config.provider, source: 'tenant_config', reason: null, config };
  }

  const envProvider = envProviderName();
  if (envProvider === 'msg91' && envMsg91Complete()) {
    return { provider: 'msg91', source: 'env', reason: null, config: null };
  }
  if (envProvider === 'twilio' && envTwilioSmsComplete()) {
    try {
      const callbackConfig = await getSmsConfigRowForProvider(tid, 'twilio');
      if (callbackConfig?.callback_token_ciphertext) {
        return { provider: 'twilio', source: 'env', reason: null, config: callbackConfig };
      }
    } catch (err) {
      logger.error('sms provider resolution: callback config lookup failed', { error: err?.message });
      return { provider: 'dry_run', source: 'default', reason: 'config_unavailable', config: null };
    }
    return {
      provider: 'dry_run', source: 'default', reason: 'env_callback_config_missing', config: null,
    };
  }
  if (envProvider === 'msg91' || envProvider === 'twilio') {
    return { provider: 'dry_run', source: 'default', reason: 'env_credentials_incomplete', config: null };
  }
  return { provider: 'dry_run', source: 'default', reason: 'not_configured', config: null };
}

/**
 * Resolve the tenant's active DLT template registration for an outbox
 * template key (699). Tenant configs require their exact registration row;
 * env-credential deployments may use a registration attached to a config row
 * for that same provider, including an intentionally disabled config row.
 * Returns null when the template kind is not registered — the caller must
 * treat that as a terminal rejection, never send unregistered.
 */
export async function resolveTemplateRegistration(tenantId, templateKey, configId = null, provider = null) {
  const key = String(templateKey || '').trim();
  if (!key) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT r.id, r.provider_config_id, r.dlt_template_id, r.provider_template_id
       FROM sms_template_registrations r
      JOIN sms_provider_configs c
         ON c.id = r.provider_config_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1::uuid AND r.template_key = $2::text AND r.active = true
        AND c.provider = $4::text
        AND ($3::integer IS NULL OR r.provider_config_id = $3::integer)
      ORDER BY r.id
      LIMIT 1`,
    tenantId, key, configId === null || configId === undefined ? null : Number(configId), provider,
  );
  return rows[0] || null;
}

function tenantCredentials(config, provider) {
  return {
    authKey: config.auth_key_ciphertext ? decryptField(config.auth_key_ciphertext) : null,
    senderId: config.sender_id || null,
    dltEntityId: config.dlt_entity_id || null,
    accountSid: config.account_sid || null,
    callbackToken: provider === 'twilio' && config.callback_token_ciphertext
      ? decryptField(config.callback_token_ciphertext)
      : null,
  };
}

function envCredentials(provider) {
  if (provider === 'msg91') {
    return {
      authKey: process.env.MSG91_AUTH_KEY || null,
      senderId: process.env.MSG91_SENDER_ID || null,
      dltEntityId: process.env.MSG91_DLT_ENTITY_ID || null,
      accountSid: null,
      callbackToken: null,
    };
  }
  return {
    authKey: process.env.TWILIO_AUTH_TOKEN || null,
    senderId: process.env.TWILIO_SMS_FROM || null,
    dltEntityId: null,
    accountSid: process.env.TWILIO_ACCOUNT_SID || null,
    callbackToken: null,
  };
}

function twilioStatusCallbackUrl(token) {
  const callbackToken = String(token || '').trim();
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!CALLBACK_TOKEN_RE.test(callbackToken) || !publicBaseUrl) return null;
  try {
    const parsed = new URL(publicBaseUrl);
    if (!['https:', 'http:'].includes(parsed.protocol)
        || parsed.username || parsed.password || parsed.search || parsed.hash
        || (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')) {
      return null;
    }
  } catch {
    return null;
  }
  return `${publicBaseUrl}/webhooks/sms/twilio-status/${callbackToken}`;
}

/**
 * Full provider send: resolve provider → resolve DLT template → dispatch to
 * the concrete adapter → return the receipt-shaped result
 * `{ outcome, providerReference, providerCode, evidence }`.
 *
 * Called ONLY by services/smsService.js (the seam). Never throws — transport
 * faults classify as `uncertain`, configuration/registration gaps as
 * `rejected`.
 */
export async function sendThroughResolvedProvider({ phone, message, tenantId, templateVersion, outboxId }) {
  const normalizedPhone = normalizeIndianSmsPhone(phone);
  if (!normalizedPhone) return rejected('phone_missing', { invalid_phone: true });

  let resolution;
  try {
    resolution = await resolveSmsProviderContext(tenantId);
  } catch {
    return uncertain('sms_provider_resolution_failed');
  }

  if (resolution.provider === 'dry_run') {
    // Honest dry run: log, never claim a delivery. The drain records this as
    // a provider rejection so the outbox row can never reach SENT (609 law).
    logger.info('[SMS DRY RUN] Send suppressed', {
      reason: resolution.reason || null,
      outbox_id: outboxId ?? null,
      destination_present: true,
      message_length: String(message || '').length,
    });
    return rejected('sms_gateway_not_configured', {
      dry_run: true,
      reason: resolution.reason || null,
    });
  }

  let credentials;
  try {
    credentials = resolution.source === 'tenant_config'
      ? tenantCredentials(resolution.config, resolution.provider)
      : envCredentials(resolution.provider);
    if (resolution.provider === 'twilio' && !credentials.callbackToken
        && resolution.config?.callback_token_ciphertext) {
      credentials.callbackToken = decryptField(resolution.config.callback_token_ciphertext);
    }
  } catch (err) {
    // decryptField failure — configuration exists but is unreadable. This is
    // a channel-level configuration fault (pause is honest), not transport.
    logger.error('sms provider credentials unreadable', { error: err?.message });
    return rejected('sms_config_credentials_unreadable', { source: resolution.source });
  }

  // DLT fail-closed gate: a real provider send requires an active template
  // registration for the outbox template key.
  let registration = null;
  try {
    registration = await resolveTemplateRegistration(
      tenantId,
      templateVersion,
      resolution.config?.id ?? null,
      resolution.provider,
    );
  } catch {
    return uncertain('sms_template_lookup_failed');
  }
  if (!registration) {
    return rejected('dlt_template_not_registered', {
      template_key: String(templateVersion || '') || null,
      provider: resolution.provider,
    });
  }

  try {
    if (resolution.provider === 'msg91') {
      return await sendViaMsg91({
        authKey: credentials.authKey,
        senderId: credentials.senderId,
        dltTemplateId: registration.dlt_template_id,
        providerTemplateId: registration.provider_template_id,
        phone: normalizedPhone,
        message,
      });
    }
    return await sendViaTwilioSms({
      accountSid: credentials.accountSid,
      authToken: credentials.authKey,
      from: credentials.senderId,
      phone: normalizedPhone,
      message,
      statusCallback: twilioStatusCallbackUrl(credentials.callbackToken),
    });
  } catch {
    return uncertain(`${resolution.provider}_transport_failure`);
  }
}

export const __testing__ = Object.freeze({
  envMsg91Complete,
  envTwilioSmsComplete,
  getEnabledSmsConfigRow,
});
