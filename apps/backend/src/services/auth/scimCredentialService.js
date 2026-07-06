import crypto from 'crypto';

import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const VALID_REALMS = new Set(['admin', 'staff']);

function validateProviderKey(providerKey) {
  const key = String(providerKey || '').trim().toLowerCase();
  if (!PROVIDER_KEY_RE.test(key)) {
    throw AppError.badRequest('Invalid provider key', 'SCIM_PROVIDER_KEY_INVALID');
  }
  return key;
}

function normalizeRealm(realm) {
  const value = String(realm || '').trim().toLowerCase();
  if (!VALID_REALMS.has(value)) throw AppError.badRequest('Invalid SCIM realm', 'SCIM_REALM_INVALID');
  return value;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenHint(token) {
  const value = String(token || '');
  if (value.length <= 8) return 'set';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function jsonObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be an object`, 'SCIM_JSON_INVALID');
  }
  return value;
}

function publicScimConfig(row) {
  return {
    enabled: Boolean(row.scim_enabled),
    token_configured: Boolean(row.scim_bearer_token_hash),
    token_hint: row.scim_bearer_token_hint || null,
    token_rotated_at: row.scim_token_rotated_at || null,
    last_authenticated_at: row.scim_last_authenticated_at || null,
    config: row.scim_config || {},
  };
}

async function recordScimCredentialAudit({ tenantId, provider, actorUid, eventType, outcome, details }) {
  await setTenant(tenantId, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO identity_audit_events (
        tenant_id, realm, protocol, provider_id, provider_key, event_type, outcome,
        actor_uid, details
      )
      VALUES ($1::uuid, $2, 'scim', $3::bigint, $4, $5, $6, $7::uuid, $8::jsonb)`,
    tenantId,
    provider.realm,
    provider.id,
    provider.provider_key,
    eventType,
    outcome,
    actorUid || null,
    JSON.stringify(details || {}),
  ));
}

export async function configureProviderScimCredentials({
  tenantId,
  providerKey,
  realm,
  actorUid = null,
  input = {},
} = {}) {
  if (!tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const key = validateProviderKey(providerKey);
  const scimRealm = normalizeRealm(realm);
  const enabledProvided = Object.prototype.hasOwnProperty.call(input, 'enabled')
    || Object.prototype.hasOwnProperty.call(input, 'scim_enabled');
  const enabled = enabledProvided ? Boolean(input.enabled ?? input.scim_enabled) : true;
  const bearerToken = input.bearerToken
    ?? input.bearer_token
    ?? input.scimBearerToken
    ?? input.scim_bearer_token
    ?? null;
  const config = jsonObject(input.config ?? input.scim_config ?? {}, 'scim_config');
  const clearToken = input.clearToken === true || input.clear_token === true;
  if (bearerToken !== null && String(bearerToken).length < 20) {
    throw AppError.badRequest('SCIM bearer token must be at least 20 characters', 'SCIM_TOKEN_TOO_SHORT');
  }

  const rows = await setTenant(tenantId, async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT *
         FROM tenant_identity_providers
        WHERE tenant_id = $1::uuid
          AND is_platform_provider = false
          AND realm = $2
          AND provider_key = $3
        LIMIT 1
        FOR UPDATE`,
      tenantId,
      scimRealm,
      key,
    );
    if (!existing[0]) throw AppError.notFound('Identity provider not found', 'SCIM_PROVIDER_NOT_FOUND');
    if (enabled && !bearerToken && !existing[0].scim_bearer_token_hash) {
      throw AppError.badRequest('SCIM bearer token is required before enabling SCIM', 'SCIM_TOKEN_REQUIRED');
    }
    const hash = bearerToken ? tokenHash(bearerToken) : null;
    const hint = bearerToken ? tokenHint(bearerToken) : null;
    return tx.$queryRawUnsafe(
      `UPDATE tenant_identity_providers
          SET scim_enabled = $1,
              scim_bearer_token_hash = CASE
                WHEN $2::boolean THEN NULL
                ELSE COALESCE($3, scim_bearer_token_hash)
              END,
              scim_bearer_token_hint = CASE
                WHEN $2::boolean THEN NULL
                ELSE COALESCE($4, scim_bearer_token_hint)
              END,
              scim_token_rotated_at = CASE
                WHEN $2::boolean THEN NULL
                WHEN $3 IS NOT NULL THEN NOW()
                ELSE scim_token_rotated_at
              END,
              scim_config = $5::jsonb,
              updated_by = $6::uuid,
              updated_at = NOW()
        WHERE id = $7::bigint
        RETURNING *`,
      enabled,
      clearToken,
      hash,
      hint,
      JSON.stringify(config),
      actorUid || null,
      existing[0].id,
    );
  });

  const provider = rows[0];
  await recordScimCredentialAudit({
    tenantId,
    provider,
    actorUid,
    eventType: 'SCIM_CREDENTIALS_CONFIGURED',
    outcome: 'accepted',
    details: {
      enabled: Boolean(provider.scim_enabled),
      token_changed: Boolean(bearerToken) || clearToken,
      realm: scimRealm,
    },
  });
  return {
    provider: {
      id: Number(provider.id),
      tenant_id: String(provider.tenant_id),
      realm: provider.realm,
      provider_key: provider.provider_key,
      display_name: provider.display_name,
      status: provider.status,
    },
    scim: publicScimConfig(provider),
  };
}

export function exposeScimProviderConfig(row) {
  return publicScimConfig(row);
}
