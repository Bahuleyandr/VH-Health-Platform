// src/services/notification/smsProviderConfigService.js
//
// Admin CRUD over the migration-699 SMS gateway tables:
//   * sms_provider_configs — per-tenant provider row (msg91 | twilio |
//     dry_run), TRAI DLT identity (sender_id + dlt_entity_id), write-only
//     encryptField() credentials, and the SHA-256 hash of the DLR callback
//     URL bearer token (the auth for the pre-RLS /webhooks/sms mount — MSG91
//     does not sign callbacks). The plaintext token is minted here, returned
//     to the admin EXACTLY ONCE, and only its hash is stored.
//   * sms_template_registrations — outbox template_version key → DLT content
//     template id (+ provider flow/content id). The adapter refuses to send
//     a template kind with no active row (fail-closed DLT gate).
//
// Reads never return ciphertext or token material — presence booleans only
// (paymentGatewayService config idiom). All queries carry explicit tenant
// predicates (699 tables are permissive-RLS request-path tables; dev/QA/CI
// run with the GUC unset).

import { createHash, randomBytes } from 'node:crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField } from '../../utils/fieldEncryption.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getSmsSettings } from '../tenant/tenantSettingsService.js';

export const SMS_PROVIDERS = Object.freeze(['msg91', 'twilio', 'dry_run']);

// base64url of 24 random bytes = 32 chars; accept a small range so a rotated
// scheme change never 500s the webhook route (it just fails the lookup).
const CALLBACK_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function generateCallbackToken() {
  return randomBytes(24).toString('base64url');
}

function isUniqueViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '23505';
}

function isCheckViolation(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '23514';
}

const CONFIG_VIEW_COLUMNS = `
  id, tenant_id::text, provider, enabled, sender_id, dlt_entity_id,
  account_sid, created_at, updated_at,
  (auth_key_ciphertext IS NOT NULL) AS has_auth_key,
  (callback_token_hash IS NOT NULL) AS has_callback_token`;

export function dlrPathForProvider(provider, token) {
  return provider === 'twilio'
    ? `/webhooks/sms/twilio-status/${token}`
    : `/webhooks/sms/dlr/${token}`;
}

function toConfigView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    provider: row.provider,
    enabled: row.enabled === true,
    sender_id: row.sender_id || null,
    dlt_entity_id: row.dlt_entity_id || null,
    account_sid: row.account_sid || null,
    has_auth_key: row.has_auth_key === true,
    has_callback_token: row.has_callback_token === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function envProviderSummary() {
  const provider = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  return {
    env_provider: provider || null,
    env_kill_switch: provider === 'logger',
  };
}

/** Admin read: config rows with write-only secrets reduced to booleans. */
export async function listSmsProviderConfigs(tenantId) {
  const tenant = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${CONFIG_VIEW_COLUMNS}
       FROM sms_provider_configs
      WHERE tenant_id = $1::uuid
      ORDER BY enabled DESC, provider`,
    tenant,
  );
  return {
    ...envProviderSummary(),
    tenant_enabled: (await getSmsSettings(tenant)).enabled,
    configs: rows.map(toConfigView),
  };
}

/**
 * Admin upsert of the per-tenant provider config (one row per
 * tenant/provider; at most one enabled per tenant — 699 partial unique).
 * auth_key is write-only (encryptField ciphertext, only overwritten when a
 * new plaintext arrives). The DLR callback token is minted when the row has
 * none (or rotation is requested) and the PLAINTEXT is returned exactly once
 * as `callback_token` + `dlr_path`; only its SHA-256 lands in the database.
 */
export async function upsertSmsProviderConfig({
  tenantId, provider, enabled = false, sender_id, dlt_entity_id,
  auth_key, account_sid, rotate_callback_token = false, created_by,
}) {
  const tenant = requireTenantId(tenantId);
  const providerValue = String(provider || '').trim().toLowerCase();
  if (!SMS_PROVIDERS.includes(providerValue)) {
    throw AppError.badRequest(
      `provider must be one of: ${SMS_PROVIDERS.join(', ')}`,
      'SMS_CONFIG_UNKNOWN_PROVIDER',
    );
  }

  const authKeyCipher = auth_key ? encryptField(String(auth_key), { tenantId: tenant }) : null;
  const mintedToken = generateCallbackToken();
  const mintedHash = sha256Hex(mintedToken);
  const rotate = rotate_callback_token === true;

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `INSERT INTO sms_provider_configs
         (tenant_id, provider, enabled, sender_id, dlt_entity_id,
          auth_key_ciphertext, account_sid, callback_token_hash, created_by)
       VALUES ($1::uuid, $2::text, $3::boolean, $4::text, $5::text,
               $6::text, $7::text, $8::char(64), $9::uuid)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         sender_id = COALESCE(EXCLUDED.sender_id, sms_provider_configs.sender_id),
         dlt_entity_id = COALESCE(EXCLUDED.dlt_entity_id, sms_provider_configs.dlt_entity_id),
         auth_key_ciphertext = COALESCE(EXCLUDED.auth_key_ciphertext, sms_provider_configs.auth_key_ciphertext),
         account_sid = COALESCE(EXCLUDED.account_sid, sms_provider_configs.account_sid),
         -- Keep the existing callback token stable unless the admin asked
         -- for rotation (the provider dashboard holds the old URL).
         callback_token_hash = CASE
           WHEN $10::boolean OR sms_provider_configs.callback_token_hash IS NULL
             THEN EXCLUDED.callback_token_hash
           ELSE sms_provider_configs.callback_token_hash
         END,
         updated_at = NOW()
       RETURNING ${CONFIG_VIEW_COLUMNS}, callback_token_hash`,
      tenant, providerValue, enabled === true,
      sender_id ? String(sender_id).slice(0, 20) : null,
      dlt_entity_id ? String(dlt_entity_id).slice(0, 40) : null,
      authKeyCipher,
      account_sid ? String(account_sid).slice(0, 64) : null,
      mintedHash,
      created_by ? String(created_by) : null,
      rotate,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'Another SMS provider config is already enabled for this tenant — disable it first (one live config per tenant).',
        'SMS_CONFIG_CONFLICT',
      );
    }
    if (isCheckViolation(err)) {
      throw AppError.badRequest(
        'An enabled non-dry_run config requires sender_id, dlt_entity_id, and auth_key.',
        'SMS_CONFIG_CREDENTIALS_REQUIRED',
      );
    }
    throw err;
  }

  const row = rows[0];
  const view = toConfigView(row);
  if (String(row.callback_token_hash || '').trim() === mintedHash) {
    // The mint took effect (new row, empty hash, or explicit rotation):
    // this response is the ONLY time the plaintext token exists outside the
    // provider dashboard. Configure the DLR URL there, then discard it.
    view.callback_token = mintedToken;
    view.dlr_path = dlrPathForProvider(providerValue, mintedToken);
  }
  return view;
}

/**
 * Fail-closed tenant resolution for the pre-RLS DLR mount: SHA-256 of the
 * URL token must equal a stored callback_token_hash. Unknown/malformed
 * tokens resolve to null (the route answers 401) — never a default tenant.
 * Returns the FULL config row (ciphertext included, for Twilio signature
 * verification) — never hand it to a client.
 */
export async function resolveSmsConfigByCallbackToken(token) {
  if (typeof token !== 'string' || !CALLBACK_TOKEN_RE.test(token)) return null;
  const hash = sha256Hex(token);
  // Comparing one-way hashes by index lookup is the standard token-hash
  // pattern (refresh tokens, SCIM bearers): the stored value is not
  // recoverable and a timing signal over hash equality reveals nothing an
  // attacker can iterate on (the hash input space is the 192-bit token).
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id::text, provider, enabled, sender_id, dlt_entity_id,
            auth_key_ciphertext, account_sid, callback_token_hash
       FROM sms_provider_configs
      WHERE callback_token_hash = $1::char(64)
      LIMIT 1`,
    hash,
  );
  return rows[0] || null;
}

// ───────────────────────────────────────────────────────────────────────
// Template registrations (fail-closed DLT gate data)
// ───────────────────────────────────────────────────────────────────────

const TEMPLATE_COLUMNS = `
  id, tenant_id::text, provider_config_id, template_key, dlt_template_id,
  provider_template_id, active, created_at, updated_at`;

function toTemplateView(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    provider_config_id: Number(row.provider_config_id),
    template_key: row.template_key,
    dlt_template_id: row.dlt_template_id,
    provider_template_id: row.provider_template_id || null,
    active: row.active === true,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listSmsTemplateRegistrations(tenantId) {
  const tenant = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM sms_template_registrations
      WHERE tenant_id = $1::uuid
      ORDER BY template_key, id`,
    tenant,
  );
  return rows.map(toTemplateView);
}

async function resolveConfigIdForTemplate(tenant, providerConfigId) {
  if (providerConfigId !== null && providerConfigId !== undefined) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM sms_provider_configs
        WHERE tenant_id = $1::uuid AND id = $2::integer
        LIMIT 1`,
      tenant, Number(providerConfigId),
    );
    if (!rows.length) {
      throw AppError.notFound('SMS provider config not found', 'SMS_CONFIG_NOT_FOUND');
    }
    return Number(rows[0].id);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM sms_provider_configs
      WHERE tenant_id = $1::uuid
      ORDER BY enabled DESC, id
      LIMIT 2`,
    tenant,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'Create an SMS provider config before registering templates',
      'SMS_CONFIG_REQUIRED',
    );
  }
  // Deterministic default only when unambiguous (a single row, or exactly
  // one enabled row sorted first by the ORDER BY).
  return Number(rows[0].id);
}

export async function createSmsTemplateRegistration({
  tenantId, provider_config_id, template_key, dlt_template_id,
  provider_template_id, active = true, created_by,
}) {
  const tenant = requireTenantId(tenantId);
  const key = String(template_key || '').trim();
  if (!key) throw AppError.badRequest('template_key is required');
  const dltId = String(dlt_template_id || '').trim();
  if (!dltId) throw AppError.badRequest('dlt_template_id is required');
  const configId = await resolveConfigIdForTemplate(tenant, provider_config_id ?? null);

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `INSERT INTO sms_template_registrations
         (tenant_id, provider_config_id, template_key, dlt_template_id,
          provider_template_id, active, created_by)
       VALUES ($1::uuid, $2::integer, $3::text, $4::text, $5::text, $6::boolean, $7::uuid)
       RETURNING ${TEMPLATE_COLUMNS}`,
      tenant, configId, key.slice(0, 120), dltId.slice(0, 40),
      provider_template_id ? String(provider_template_id).slice(0, 64) : null,
      active === true,
      created_by ? String(created_by) : null,
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(
        'A registration for this template key already exists on this config — update it instead.',
        'SMS_TEMPLATE_REGISTRATION_EXISTS',
      );
    }
    throw err;
  }
  return toTemplateView(rows[0]);
}

export async function updateSmsTemplateRegistration({
  tenantId, id, dlt_template_id, provider_template_id, active,
}) {
  const tenant = requireTenantId(tenantId);
  const templateId = Number(id);
  if (!Number.isSafeInteger(templateId) || templateId < 1) {
    throw AppError.badRequest('template registration id is invalid');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE sms_template_registrations SET
       dlt_template_id = COALESCE($3::text, dlt_template_id),
       provider_template_id = COALESCE($4::text, provider_template_id),
       active = COALESCE($5::boolean, active),
       updated_at = NOW()
     WHERE tenant_id = $1::uuid AND id = $2::integer
     RETURNING ${TEMPLATE_COLUMNS}`,
    tenant, templateId,
    dlt_template_id !== undefined && dlt_template_id !== null
      ? String(dlt_template_id).trim().slice(0, 40) : null,
    provider_template_id !== undefined && provider_template_id !== null
      ? String(provider_template_id).trim().slice(0, 64) : null,
    active === undefined || active === null ? null : active === true,
  );
  if (!rows.length) {
    throw AppError.notFound('SMS template registration not found', 'SMS_TEMPLATE_REGISTRATION_NOT_FOUND');
  }
  return toTemplateView(rows[0]);
}

export const __testing__ = Object.freeze({
  sha256Hex,
  generateCallbackToken,
  CALLBACK_TOKEN_RE,
});
