import crypto from 'crypto';
import { URLSearchParams } from 'url';

import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { sha256Base64Url, verifyOidcIdToken } from '../../utils/oidcJwt.js';
import { ALL_STAFF_ROLES } from '../../utils/roleHelpers.js';
import { resolveTenantForRequest } from '../tenant/tenantService.js';
import { issueAccessTokenAndClaimSession } from './loginSessionHelper.js';
import { exposeScimProviderConfig } from './scimCredentialService.js';
import { StaffAuthService } from './staffAuthService.js';

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const DEFAULT_SCOPE = 'openid email profile';
const STATE_TTL_SECONDS = 10 * 60;
const STAFF_STATE_CACHE = new Map();
const METADATA_CACHE = new Map();
const JWKS_CACHE = new Map();
const STAFF_REALM_ROLES = new Set(ALL_STAFF_ROLES);
const FORBIDDEN_STAFF_SSO_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'PATIENT', 'WEBHOOK_CLIENT', 'DEVICE_GATEWAY']);

function getHmacSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw AppError.internal('JWT_SECRET is required for SSO state signing', 'SSO_STATE_SECRET_MISSING');
  return secret;
}

function hmac(value) {
  return crypto.createHmac('sha256', getHmacSecret()).update(String(value)).digest('base64url');
}

function timingSafeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function intEnv(name, defaultValue, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

function oidcHttpTimeoutMs() {
  return intEnv('SSO_OIDC_HTTP_TIMEOUT_MS', 5000, 1000, 30000);
}

function metadataCacheTtlMs() {
  return intEnv('SSO_METADATA_CACHE_TTL_SECONDS', 300, 30, 3600) * 1000;
}

function assertionClockSkewSeconds() {
  return intEnv('SSO_ASSERTION_CLOCK_SKEW_SECONDS', 60, 0, 600);
}

function hashValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

function validateProviderKey(providerKey) {
  const key = String(providerKey || '').trim().toLowerCase();
  if (!PROVIDER_KEY_RE.test(key)) {
    throw AppError.badRequest('Invalid provider key', 'SSO_PROVIDER_KEY_INVALID');
  }
  return key;
}

function validateHttpsUrl(value, label, { allowEmpty = true } = {}) {
  if ((value === null || value === undefined || value === '') && allowEmpty) return null;
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw AppError.badRequest(`${label} must be a valid URL`, 'SSO_URL_INVALID');
  }
  const allowHttpLocal = String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
    && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(allowHttpLocal && parsed.protocol === 'http:')) {
    throw AppError.badRequest(`${label} must use HTTPS`, 'SSO_URL_NOT_HTTPS');
  }
  return parsed.toString();
}

function jsonObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be an object`, 'SSO_JSON_INVALID');
  }
  return value;
}

function normalizeStringArray(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`, 'SSO_ARRAY_INVALID');
  return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function requestHost(req) {
  return String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase();
}

function deviceTypeFrom(req) {
  return String(
    req?.query?.deviceType
    || req?.query?.device_type
    || req?.body?.deviceType
    || req?.body?.device_type
    || 'mobile',
  ).slice(0, 40);
}

function deviceIdFrom(req) {
  const value = String(req?.query?.deviceId || req?.query?.device_id || req?.body?.deviceId || req?.body?.device_id || '').trim();
  return value ? value.slice(0, 120) : null;
}

function withStaffIdentityScope(tenantId, fn) {
  if (!tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  return setTenant(tenantId, fn);
}

async function queryStaffProviders({ tenantId, status = null, providerKey = null }) {
  return withStaffIdentityScope(tenantId, async (tx) => {
    const params = [tenantId];
    let idx = 2;
    const filters = [
      'tenant_id = $1::uuid',
      'is_platform_provider = false',
      "realm = 'staff'",
      "protocol = 'oidc'",
    ];
    if (status) {
      filters.push(`status = $${idx}`);
      params.push(status);
      idx += 1;
    }
    if (providerKey) {
      filters.push(`provider_key = $${idx}`);
      params.push(providerKey);
    }
    return tx.$queryRawUnsafe(
      `SELECT *
         FROM tenant_identity_providers
        WHERE ${filters.join(' AND ')}
        ORDER BY display_name ASC`,
      ...params,
    );
  });
}

function sanitizeStaffProvider(row, { includeSecretPresence = true } = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    tenant_id: row.tenant_id ? String(row.tenant_id) : null,
    is_platform_provider: Boolean(row.is_platform_provider),
    realm: row.realm,
    protocol: row.protocol,
    provider_key: row.provider_key,
    display_name: row.display_name,
    status: row.status,
    oidc_issuer: row.oidc_issuer,
    oidc_discovery_url: row.oidc_discovery_url,
    oidc_jwks_uri: row.oidc_jwks_uri,
    oidc_authorization_endpoint: row.oidc_authorization_endpoint,
    oidc_token_endpoint: row.oidc_token_endpoint,
    oidc_userinfo_endpoint: row.oidc_userinfo_endpoint,
    oidc_client_id: row.oidc_client_id,
    ...(includeSecretPresence ? { has_oidc_client_secret: Boolean(row.oidc_client_secret_ciphertext) } : {}),
    group_claim_name: row.group_claim_name || 'groups',
    allowed_domains: row.allowed_domains || [],
    required_claims: row.required_claims || {},
    policy: row.policy || {},
    scim: exposeScimProviderConfig(row),
    created_by: row.created_by ? String(row.created_by) : null,
    updated_by: row.updated_by ? String(row.updated_by) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeStaffRedirectUris(policy, status) {
  const redirects = normalizeStringArray(
    policy.staff_redirect_uris
      || policy.staffRedirectUris
      || policy.allowed_staff_redirect_uris
      || policy.allowedStaffRedirectUris
      || policy.redirect_uris
      || policy.redirectUris,
    'policy.staff_redirect_uris',
  ).map(normalizeRedirectUri);
  const allowHttpsAppLinks = policy.allow_https_app_links === true || policy.allowHttpsAppLinks === true;
  const uniqueRedirects = [...new Set(redirects)];
  for (const redirectUri of uniqueRedirects) {
    const parsed = new URL(redirectUri);
    const isHttpsAppLink = parsed.protocol === 'https:' && allowHttpsAppLinks;
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isHttpsAppLink) {
      throw AppError.badRequest('Staff SSO redirect_uri must be an app deep link', 'SSO_REDIRECT_URI_NOT_DEEP_LINK');
    }
  }
  if (status === 'active' && uniqueRedirects.length === 0) {
    throw AppError.badRequest('Staff SSO provider has no registered app redirect URIs', 'SSO_REDIRECT_URI_NOT_CONFIGURED');
  }
  return {
    ...policy,
    staff_redirect_uris: uniqueRedirects,
    allow_https_app_links: allowHttpsAppLinks,
  };
}

export function invalidateStaffOidcProviderCache(providerId = null) {
  if (!providerId) {
    METADATA_CACHE.clear();
    JWKS_CACHE.clear();
    STAFF_STATE_CACHE.clear();
    return;
  }
  const id = String(providerId);
  for (const key of METADATA_CACHE.keys()) {
    if (key.startsWith(`${id}:`)) METADATA_CACHE.delete(key);
  }
  for (const key of JWKS_CACHE.keys()) {
    if (key.startsWith(`${id}:`)) JWKS_CACHE.delete(key);
  }
}

export async function getStaffOidcProvider({ tenantId, providerKey, activeOnly = false }) {
  const key = validateProviderKey(providerKey);
  const rows = await queryStaffProviders({
    tenantId,
    providerKey: key,
    status: activeOnly ? 'active' : null,
  });
  if (!rows[0]) throw AppError.notFound('Staff SSO provider not found', 'SSO_PROVIDER_NOT_FOUND');
  return rows[0];
}

export async function listStaffOidcProviders({ tenantId, status = null } = {}) {
  if (!tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const rows = await queryStaffProviders({ tenantId, status });
  return rows.map((row) => sanitizeStaffProvider(row));
}

export async function getStaffOidcProviderConfig({ tenantId, providerKey }) {
  const provider = await getStaffOidcProvider({ tenantId, providerKey });
  return sanitizeStaffProvider(provider);
}

export async function upsertStaffOidcProvider({ tenantId, providerKey, actorUid, input = {} }) {
  if (!tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const key = validateProviderKey(providerKey || input.provider_key);
  const status = String(input.status || 'draft').toLowerCase();
  if (!['draft', 'active', 'disabled'].includes(status)) {
    throw AppError.badRequest('Invalid provider status', 'SSO_PROVIDER_STATUS_INVALID');
  }

  const displayName = String(input.display_name || input.displayName || key).trim();
  if (!displayName) throw AppError.badRequest('display_name is required', 'SSO_DISPLAY_NAME_REQUIRED');

  const policyInput = jsonObject(input.policy, 'policy');
  const policy = normalizeStaffRedirectUris(policyInput, status);
  const patch = {
    oidc_issuer: validateHttpsUrl(input.oidc_issuer || input.issuer, 'issuer', { allowEmpty: status !== 'active' }),
    oidc_discovery_url: validateHttpsUrl(input.oidc_discovery_url || input.discovery_url, 'discovery_url'),
    oidc_jwks_uri: validateHttpsUrl(input.oidc_jwks_uri || input.jwks_uri, 'jwks_uri', { allowEmpty: status !== 'active' }),
    oidc_authorization_endpoint: validateHttpsUrl(input.oidc_authorization_endpoint || input.authorization_endpoint, 'authorization_endpoint', { allowEmpty: status !== 'active' }),
    oidc_token_endpoint: validateHttpsUrl(input.oidc_token_endpoint || input.token_endpoint, 'token_endpoint', { allowEmpty: status !== 'active' }),
    oidc_userinfo_endpoint: validateHttpsUrl(input.oidc_userinfo_endpoint || input.userinfo_endpoint, 'userinfo_endpoint'),
    oidc_client_id: input.oidc_client_id || input.client_id ? String(input.oidc_client_id || input.client_id).trim() : null,
    group_claim_name: String(input.group_claim_name || input.groupClaimName || 'groups').trim() || 'groups',
    allowed_domains: normalizeStringArray(input.allowed_domains || input.allowedDomains, 'allowed_domains'),
    required_claims: jsonObject(input.required_claims || input.requiredClaims, 'required_claims'),
    policy,
  };
  if (status === 'active') {
    for (const [field, value] of Object.entries({
      oidc_issuer: patch.oidc_issuer,
      oidc_jwks_uri: patch.oidc_jwks_uri,
      oidc_authorization_endpoint: patch.oidc_authorization_endpoint,
      oidc_token_endpoint: patch.oidc_token_endpoint,
      oidc_client_id: patch.oidc_client_id,
    })) {
      if (!value) throw AppError.badRequest(`${field} is required for active OIDC providers`, 'SSO_PROVIDER_INCOMPLETE');
    }
  }

  const secretInput = input.oidc_client_secret ?? input.client_secret;
  const encryptedSecret = secretInput
    ? encryptField(String(secretInput), { tenantId })
    : null;

  const rows = await withStaffIdentityScope(tenantId, async (tx) => {
    const existing = await tx.$queryRawUnsafe(
      `SELECT *
         FROM tenant_identity_providers
        WHERE tenant_id = $1::uuid
          AND is_platform_provider = false
          AND realm = 'staff'
          AND protocol = 'oidc'
          AND provider_key = $2
        LIMIT 1`,
      tenantId,
      key,
    );
    if (existing[0]) {
      return tx.$queryRawUnsafe(
        `UPDATE tenant_identity_providers
            SET display_name = $1,
                status = $2,
                oidc_issuer = $3,
                oidc_discovery_url = $4,
                oidc_jwks_uri = $5,
                oidc_authorization_endpoint = $6,
                oidc_token_endpoint = $7,
                oidc_userinfo_endpoint = $8,
                oidc_client_id = $9,
                oidc_client_secret_ciphertext = COALESCE($10, oidc_client_secret_ciphertext),
                group_claim_name = $11,
                allowed_domains = $12::text[],
                required_claims = $13::jsonb,
                policy = $14::jsonb,
                updated_by = $15::uuid,
                updated_at = NOW()
          WHERE id = $16::bigint
          RETURNING *`,
        displayName,
        status,
        patch.oidc_issuer,
        patch.oidc_discovery_url,
        patch.oidc_jwks_uri,
        patch.oidc_authorization_endpoint,
        patch.oidc_token_endpoint,
        patch.oidc_userinfo_endpoint,
        patch.oidc_client_id,
        encryptedSecret,
        patch.group_claim_name,
        patch.allowed_domains,
        JSON.stringify(patch.required_claims),
        JSON.stringify(patch.policy),
        actorUid || null,
        existing[0].id,
      );
    }
    return tx.$queryRawUnsafe(
      `INSERT INTO tenant_identity_providers (
          tenant_id, is_platform_provider, realm, protocol, provider_key, display_name, status,
          oidc_issuer, oidc_discovery_url, oidc_jwks_uri, oidc_authorization_endpoint,
          oidc_token_endpoint, oidc_userinfo_endpoint, oidc_client_id, oidc_client_secret_ciphertext,
          group_claim_name, allowed_domains, required_claims, policy, created_by, updated_by
        )
        VALUES (
          $1::uuid, false, 'staff', 'oidc', $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11, $12,
          $13, $14::text[], $15::jsonb, $16::jsonb, $17::uuid, $17::uuid
        )
        RETURNING *`,
      tenantId,
      key,
      displayName,
      status,
      patch.oidc_issuer,
      patch.oidc_discovery_url,
      patch.oidc_jwks_uri,
      patch.oidc_authorization_endpoint,
      patch.oidc_token_endpoint,
      patch.oidc_userinfo_endpoint,
      patch.oidc_client_id,
      encryptedSecret,
      patch.group_claim_name,
      patch.allowed_domains,
      JSON.stringify(patch.required_claims),
      JSON.stringify(patch.policy),
      actorUid || null,
    );
  });

  invalidateStaffOidcProviderCache(rows[0]?.id);
  await recordStaffIdentityAuditEvent({
    tenantId,
    provider: rows[0],
    eventType: 'SSO_PROVIDER_CONFIG_UPDATED',
    outcome: 'accepted',
    actorUid,
    details: { status, secret_changed: Boolean(secretInput) },
  });
  return sanitizeStaffProvider(rows[0]);
}

export async function listStaffOidcRoleMappings({ tenantId, providerKey }) {
  const provider = await getStaffOidcProvider({ tenantId, providerKey });
  const rows = await withStaffIdentityScope(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, tenant_id, provider_id, realm, idp_group, vh_role, status, priority, created_at, updated_at
       FROM tenant_idp_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_id = $2::bigint
        AND realm = 'staff'
      ORDER BY priority ASC, idp_group ASC`,
    tenantId,
    provider.id,
  ));
  return rows.map((row) => ({
    id: Number(row.id),
    idp_group: row.idp_group,
    vh_role: row.vh_role,
    status: row.status,
    priority: row.priority,
  }));
}

export async function replaceStaffOidcRoleMappings({ tenantId, providerKey, actorUid, mappings = [] }) {
  const provider = await getStaffOidcProvider({ tenantId, providerKey });
  if (!Array.isArray(mappings)) throw AppError.badRequest('mappings must be an array', 'SSO_MAPPINGS_INVALID');
  const normalized = mappings.map((mapping, index) => {
    const idpGroup = String(mapping?.idp_group || mapping?.idpGroup || '').trim();
    const vhRole = String(mapping?.vh_role || mapping?.vhRole || '').trim().toUpperCase();
    const status = String(mapping?.status || 'active').toLowerCase();
    const priority = Number.parseInt(mapping?.priority ?? `${100 + index}`, 10);
    if (!idpGroup) throw AppError.badRequest('idp_group is required', 'SSO_MAPPING_GROUP_REQUIRED');
    if (!isStaffSsoRoleAllowed(vhRole)) throw AppError.badRequest('Invalid staff role mapping', 'SSO_MAPPING_ROLE_INVALID');
    if (!['active', 'disabled'].includes(status)) throw AppError.badRequest('Invalid mapping status', 'SSO_MAPPING_STATUS_INVALID');
    return { idpGroup, vhRole, status, priority: Number.isFinite(priority) ? priority : 100 + index };
  });

  await withStaffIdentityScope(tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `DELETE FROM tenant_idp_role_mappings
        WHERE tenant_id = $1::uuid
          AND provider_id = $2::bigint
          AND realm = 'staff'`,
      tenantId,
      provider.id,
    );
    for (const mapping of normalized) {
      await tx.$queryRawUnsafe(
        `INSERT INTO tenant_idp_role_mappings (
            tenant_id, provider_id, realm, idp_group, vh_role, status, priority, created_by, updated_by
          )
          VALUES ($1::uuid, $2::bigint, 'staff', $3, $4, $5, $6, $7::uuid, $7::uuid)`,
        tenantId,
        provider.id,
        mapping.idpGroup,
        mapping.vhRole,
        mapping.status,
        mapping.priority,
        actorUid || null,
      );
    }
  });

  await recordStaffIdentityAuditEvent({
    tenantId,
    provider,
    eventType: 'SSO_ROLE_MAPPINGS_UPDATED',
    outcome: 'accepted',
    actorUid,
    details: { count: normalized.length, roles: [...new Set(normalized.map((m) => m.vhRole))] },
  });
  return listStaffOidcRoleMappings({ tenantId, providerKey });
}

export async function discoverStaffOidcProvidersForRequest(req) {
  const tenantId = await resolveTenantForRequest(req);
  const rows = await queryStaffProviders({ tenantId, status: 'active' });
  return {
    tenant: { id: tenantId },
    providers: rows.map((row) => ({
      provider_key: row.provider_key,
      display_name: row.display_name,
      start_url: `/api/v1/auth/staff/sso/oidc/${encodeURIComponent(row.provider_key)}/start`,
      redirect_uris: configuredRedirectUris(row),
    })),
  };
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), oidcHttpTimeoutMs());
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`OIDC endpoint returned non-JSON (${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`OIDC endpoint returned ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function getProviderMetadata(provider) {
  const cacheKey = `${provider.id}:metadata`;
  const cached = METADATA_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let metadata = {
    issuer: provider.oidc_issuer,
    authorization_endpoint: provider.oidc_authorization_endpoint,
    token_endpoint: provider.oidc_token_endpoint,
    jwks_uri: provider.oidc_jwks_uri,
    userinfo_endpoint: provider.oidc_userinfo_endpoint,
  };
  if (provider.oidc_discovery_url) {
    const discovered = await fetchJsonWithTimeout(provider.oidc_discovery_url);
    metadata = { ...discovered, ...Object.fromEntries(Object.entries(metadata).filter(([, v]) => v)) };
  }
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (!metadata[field]) throw AppError.internal(`OIDC metadata missing ${field}`, 'SSO_METADATA_INCOMPLETE');
  }
  METADATA_CACHE.set(cacheKey, { value: metadata, expiresAt: Date.now() + metadataCacheTtlMs() });
  return metadata;
}

async function getJwks(provider, metadata) {
  const cacheKey = `${provider.id}:jwks`;
  const cached = JWKS_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const jwks = await fetchJsonWithTimeout(metadata.jwks_uri);
  if (!Array.isArray(jwks.keys)) throw AppError.internal('OIDC JWKS missing keys', 'SSO_JWKS_INVALID');
  JWKS_CACHE.set(cacheKey, { value: jwks, expiresAt: Date.now() + metadataCacheTtlMs() });
  return jwks;
}

function configuredRedirectUris(provider) {
  const policy = provider?.policy || {};
  const values = policy.staff_redirect_uris
    || policy.staffRedirectUris
    || policy.allowed_staff_redirect_uris
    || policy.allowedStaffRedirectUris
    || policy.redirect_uris
    || policy.redirectUris
    || [];
  if (!Array.isArray(values)) return [];
  return values.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function normalizeRedirectUri(value) {
  try {
    return new URL(String(value || '').trim()).toString();
  } catch {
    throw AppError.badRequest('redirect_uri must be a valid URI', 'SSO_REDIRECT_URI_INVALID');
  }
}

function selectAllowedRedirectUri(provider, rawRedirectUri) {
  const allowed = configuredRedirectUris(provider).map(normalizeRedirectUri);
  if (!allowed.length) {
    throw AppError.badRequest('Staff SSO provider has no registered app redirect URIs', 'SSO_REDIRECT_URI_NOT_CONFIGURED');
  }
  const selected = normalizeRedirectUri(rawRedirectUri || allowed[0]);
  if (!allowed.includes(selected)) {
    throw AppError.badRequest('redirect_uri is not registered for this staff SSO provider', 'SSO_REDIRECT_URI_NOT_ALLOWED');
  }
  const parsed = new URL(selected);
  const isHttpsAppLink = parsed.protocol === 'https:' && provider.policy?.allow_https_app_links === true;
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isHttpsAppLink) {
    throw AppError.badRequest('Staff SSO redirect_uri must be an app deep link', 'SSO_REDIRECT_URI_NOT_DEEP_LINK');
  }
  return selected;
}

function storeState(payload) {
  const now = Math.floor(Date.now() / 1000);
  const stateId = crypto.randomBytes(24).toString('base64url');
  const state = `${stateId}.${hmac(stateId)}`;
  const stateHash = hashValue(state);
  STAFF_STATE_CACHE.set(stateId, {
    ...payload,
    stateId,
    stateHash,
    exp: now + STATE_TTL_SECONDS,
  });
  return { state, stateId, stateHash };
}

function consumeState(state) {
  const [stateId, sig] = String(state || '').split('.');
  if (!stateId || !sig || !timingSafeEqual(sig, hmac(stateId))) {
    throw AppError.unauthorized('Invalid SSO state', 'SSO_STATE_INVALID');
  }
  const payload = STAFF_STATE_CACHE.get(stateId);
  STAFF_STATE_CACHE.delete(stateId);
  if (!payload) throw AppError.unauthorized('Missing SSO state', 'SSO_STATE_MISSING');
  if (!payload.exp || Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    throw AppError.unauthorized('Expired SSO state', 'SSO_STATE_EXPIRED');
  }
  return payload;
}

function cleanupExpiredStates() {
  const now = Math.floor(Date.now() / 1000);
  for (const [stateId, payload] of STAFF_STATE_CACHE.entries()) {
    if (!payload?.exp || payload.exp < now) STAFF_STATE_CACHE.delete(stateId);
  }
}

export async function startStaffOidcLogin({ req, providerKey }) {
  cleanupExpiredStates();
  const tenantId = await resolveTenantForRequest(req);
  const key = validateProviderKey(providerKey);
  const provider = await getStaffOidcProvider({ tenantId, providerKey: key, activeOnly: true });
  const metadata = await getProviderMetadata(provider);
  const redirectUri = selectAllowedRedirectUri(
    provider,
    req?.query?.redirect_uri || req?.query?.redirectUri || req?.body?.redirect_uri || req?.body?.redirectUri,
  );
  const nonce = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = sha256Base64Url(codeVerifier);
  const deviceType = deviceTypeFrom(req);
  const deviceId = deviceIdFrom(req);
  const { state, stateHash } = storeState({
    v: 1,
    tenantId,
    providerKey: key,
    providerId: Number(provider.id),
    nonce,
    codeVerifier,
    redirectUri,
    deviceType,
    deviceId,
    requestHost: requestHost(req),
  });

  await recordStaffIdentityAuditEvent({
    tenantId,
    provider,
    eventType: 'SSO_START',
    outcome: 'started',
    state,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      state_hash: stateHash,
      device_type: deviceType,
      redirect_uri_hash: hashValue(redirectUri),
      host: requestHost(req),
    },
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.oidc_client_id,
    redirect_uri: redirectUri,
    scope: provider.policy?.scope || DEFAULT_SCOPE,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    redirectUrl: `${metadata.authorization_endpoint}?${params.toString()}`,
    expiresIn: STATE_TTL_SECONDS,
  };
}

function validateRequiredClaims(requiredClaims, payload) {
  for (const [claim, expected] of Object.entries(requiredClaims || {})) {
    const actual = payload?.[claim];
    if (Array.isArray(expected)) {
      const actualValues = Array.isArray(actual) ? actual.map(String) : [String(actual || '')];
      const ok = expected.map(String).some((value) => actualValues.includes(value));
      if (!ok) throw new Error(`OIDC required claim mismatch: ${claim}`);
    } else if (String(actual ?? '') !== String(expected)) {
      throw new Error(`OIDC required claim mismatch: ${claim}`);
    }
  }
}

function validateAllowedDomains(provider, payload) {
  const allowed = (provider.allowed_domains || []).map((d) => String(d).toLowerCase().replace(/^@/, ''));
  if (!allowed.length) return;
  const email = String(payload.email || '').toLowerCase();
  const emailDomain = email.includes('@') ? email.split('@').pop() : '';
  const hostedDomain = String(payload.hd || payload.tid || '').toLowerCase();
  if (!allowed.includes(emailDomain) && !allowed.includes(hostedDomain)) {
    throw new Error('OIDC hosted domain not allowed');
  }
}

function extractGroups(provider, payload) {
  const claimName = provider.group_claim_name || 'groups';
  const value = payload?.[claimName];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function claimValue(payload, names) {
  for (const name of names) {
    const value = payload?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function employeeIdFromPayload(provider, payload) {
  const policy = provider.policy || {};
  const configured = policy.staff_employee_id_claim
    || policy.staffEmployeeIdClaim
    || policy.employee_id_claim
    || policy.employeeIdClaim;
  const claimNames = configured
    ? [configured]
    : ['employee_id', 'employeeId', 'employee_number', 'employeeNumber'];
  return claimValue(payload, claimNames);
}

async function mapStaffRole({ tenantId, provider, groups }) {
  if (!groups.length) throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  const lowerGroups = groups.map((group) => group.toLowerCase());
  const rows = await withStaffIdentityScope(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT idp_group, vh_role, priority
       FROM tenant_idp_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_id = $2::bigint
        AND realm = 'staff'
        AND status = 'active'
        AND lower(idp_group) = ANY($3::text[])
      ORDER BY priority ASC, idp_group ASC`,
    tenantId,
    provider.id,
    lowerGroups,
  ));
  const roles = [...new Set(rows.map((row) => String(row.vh_role || '').toUpperCase()))];
  if (roles.length !== 1) {
    throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  }
  const role = roles[0];
  if (FORBIDDEN_STAFF_SSO_ROLES.has(role) || !STAFF_REALM_ROLES.has(role)) {
    throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  }
  return role;
}

function assertActiveStaff(row, mappedRole) {
  if (!row) throw AppError.unauthorized('SSO local identity not found', 'SSO_LOCAL_IDENTITY_NOT_FOUND');
  const localRole = String(row.role || '').toUpperCase();
  const userStatus = String(row.user_status || row.status || '').toLowerCase();
  if (
    localRole !== mappedRole
    || row.user_is_active === false
    || row.staff_is_active === false
    || row.is_deleted === true
    || row.archived === true
    || row.archived_at
    || (userStatus && userStatus !== 'active')
  ) {
    throw AppError.unauthorized('SSO local identity inactive, deprovisioned, or role mismatched', 'SSO_LOCAL_IDENTITY_DENIED');
  }
}

function normalizeStaffRow(row, mappedRole) {
  return {
    id: row.id,
    uid: row.uid,
    employee_id: row.employee_id,
    name: row.name || row.staff_name,
    email: row.email,
    department: row.department,
    position: row.position,
    role: mappedRole,
  };
}

async function findStaffByClaim(tx, { tenantId, mappedRole, email, employeeId }) {
  const selectors = [];
  if (email) {
    selectors.push({
      claim: 'email',
      value: email,
      rows: () => tx.$queryRawUnsafe(
        `SELECT u.id, u.uid, u.name, u.email, u.role, u.status AS user_status,
                u.is_active AS user_is_active, u.is_deleted, u.tenant_id,
                s.employee_id, s.name AS staff_name, s.department, s.position,
                s.is_active AS staff_is_active, s.archived, s.archived_at
           FROM users u
           JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
          WHERE u.tenant_id = $1::uuid
            AND lower(u.email) = lower($2)
            AND u.role = $3
          LIMIT 2`,
        tenantId,
        email,
        mappedRole,
      ),
    });
  }
  if (employeeId) {
    selectors.push({
      claim: 'employee_id',
      value: employeeId,
      rows: () => tx.$queryRawUnsafe(
        `SELECT u.id, u.uid, u.name, u.email, u.role, u.status AS user_status,
                u.is_active AS user_is_active, u.is_deleted, u.tenant_id,
                s.employee_id, s.name AS staff_name, s.department, s.position,
                s.is_active AS staff_is_active, s.archived, s.archived_at
           FROM users u
           JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
          WHERE u.tenant_id = $1::uuid
            AND s.employee_id = $2
            AND u.role = $3
          LIMIT 2`,
        tenantId,
        employeeId,
        mappedRole,
      ),
    });
  }

  for (const selector of selectors) {
    const rows = await selector.rows();
    if (rows.length > 1) {
      throw AppError.unauthorized('SSO local identity ambiguous', 'SSO_LOCAL_IDENTITY_AMBIGUOUS');
    }
    if (rows.length === 1) {
      return { row: rows[0], matchedClaim: selector.claim, matchedValue: selector.value };
    }
  }
  throw AppError.unauthorized('SSO local identity not found', 'SSO_LOCAL_IDENTITY_NOT_FOUND');
}

async function resolveOrLinkStaff({ tenantId, provider, issuer, subject, email, employeeId, mappedRole }) {
  return withStaffIdentityScope(tenantId, async (tx) => {
    const linked = await tx.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.name, u.email, u.role, u.status AS user_status,
              u.is_active AS user_is_active, u.is_deleted, u.tenant_id,
              s.employee_id, s.name AS staff_name, s.department, s.position,
              s.is_active AS staff_is_active, s.archived, s.archived_at
         FROM federated_identities fi
         JOIN users u ON u.uid = fi.local_uid
         JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
        WHERE fi.tenant_id = $1::uuid
          AND fi.provider_id = $2::bigint
          AND fi.issuer = $3
          AND fi.subject = $4
          AND fi.realm = 'staff'
          AND fi.status = 'active'
        LIMIT 1`,
      tenantId,
      provider.id,
      issuer,
      subject,
    );
    if (linked[0]) {
      assertActiveStaff(linked[0], mappedRole);
      await tx.$queryRawUnsafe(
        `UPDATE federated_identities
            SET last_seen_at = NOW(), email_at_link = COALESCE($1, email_at_link), updated_at = NOW()
          WHERE tenant_id = $2::uuid
            AND provider_id = $3::bigint
            AND issuer = $4
            AND subject = $5
            AND realm = 'staff'`,
        email || null,
        tenantId,
        provider.id,
        issuer,
        subject,
      );
      return { staff: normalizeStaffRow(linked[0], mappedRole), matchedClaim: 'federated_identity' };
    }

    const { row, matchedClaim, matchedValue } = await findStaffByClaim(tx, {
      tenantId,
      mappedRole,
      email,
      employeeId,
    });
    assertActiveStaff(row, mappedRole);

    const existingLocalLink = await tx.$queryRawUnsafe(
      `SELECT issuer, subject
         FROM federated_identities
        WHERE tenant_id = $1::uuid
          AND provider_id = $2::bigint
          AND local_uid = $3::uuid
          AND realm = 'staff'
          AND status = 'active'
        LIMIT 1`,
      tenantId,
      provider.id,
      row.uid,
    );
    if (
      existingLocalLink[0]
      && (existingLocalLink[0].issuer !== issuer || existingLocalLink[0].subject !== subject)
    ) {
      throw AppError.conflict('Local staff identity is already linked to a different IdP principal', 'SSO_LOCAL_IDENTITY_ALREADY_LINKED');
    }

    await tx.$queryRawUnsafe(
      `INSERT INTO federated_identities (
          tenant_id, realm, provider_id, issuer, subject, local_uid, email_at_link,
          last_seen_at, status, created_at, updated_at
        )
        VALUES ($1::uuid, 'staff', $2::bigint, $3, $4, $5::uuid, $6, NOW(), 'active', NOW(), NOW())
        ON CONFLICT (provider_id, issuer, subject)
        DO UPDATE SET local_uid = EXCLUDED.local_uid,
                      email_at_link = EXCLUDED.email_at_link,
                      last_seen_at = NOW(),
                      status = 'active',
                      updated_at = NOW()`,
      tenantId,
      provider.id,
      issuer,
      subject,
      row.uid,
      email || null,
    );
    return { staff: normalizeStaffRow(row, mappedRole), matchedClaim, matchedValue };
  });
}

async function exchangeCodeForTokens({ provider, metadata, code, redirectUri, codeVerifier }) {
  const clientSecret = provider.oidc_client_secret_ciphertext
    ? decryptField(provider.oidc_client_secret_ciphertext)
    : null;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: provider.oidc_client_id,
    code_verifier: codeVerifier,
  });
  if (clientSecret) params.set('client_secret', clientSecret);
  return fetchJsonWithTimeout(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
}

async function createStaffSsoRefreshSession({ tenantId, staff, refreshToken, req, deviceId = null }) {
  const maxSessions = Number.parseInt(process.env.MAX_STAFF_SESSIONS || '3', 10);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  const sessionHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const ssoDeviceId = deviceId || `sso-${crypto.randomUUID()}`;

  await withStaffIdentityScope(tenantId, async (tx) => {
    const activeSessions = await tx.$queryRawUnsafe(
      `SELECT id
         FROM staff_auth_sessions
        WHERE staff_id = $1
          AND tenant_id = $2::uuid
          AND expires_at > NOW()
        ORDER BY created_at ASC
        FOR UPDATE`,
      staff.id,
      tenantId,
    );
    const excess = activeSessions.length - (maxSessions - 1);
    if (excess > 0) {
      const idsToRevoke = activeSessions.slice(0, excess).map((row) => row.id);
      await tx.$executeRawUnsafe(
        'DELETE FROM staff_auth_sessions WHERE id = ANY($1::int[])',
        idsToRevoke,
      );
    }
    await tx.$executeRawUnsafe(
      `INSERT INTO staff_auth_sessions (
          staff_id, device_id, session_token, expires_at, ip_address, created_at, tenant_id
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), $6::uuid)`,
      staff.id,
      ssoDeviceId,
      sessionHash,
      expiresAt,
      req?.ip || '',
      tenantId,
    );
  });
}

export async function completeStaffOidcCallback({ req, providerKey, code, state, redirectUri }) {
  const key = validateProviderKey(providerKey);
  if (!code || !state) throw AppError.badRequest('code and state are required', 'SSO_CALLBACK_INVALID');
  const statePayload = consumeState(state);
  if (key !== statePayload.providerKey) {
    throw AppError.unauthorized('Invalid SSO state', 'SSO_STATE_PROVIDER_MISMATCH');
  }
  const callbackRedirectUri = normalizeRedirectUri(
    redirectUri
    || req?.query?.redirect_uri
    || req?.query?.redirectUri
    || req?.body?.redirect_uri
    || req?.body?.redirectUri
    || statePayload.redirectUri,
  );
  if (callbackRedirectUri !== statePayload.redirectUri) {
    await recordStaffIdentityAuditEvent({
      tenantId: statePayload.tenantId,
      provider: { id: statePayload.providerId, provider_key: key },
      eventType: 'SSO_ASSERTION_DENIED',
      outcome: 'denied',
      state,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: { reason: 'redirect_uri_mismatch', redirect_uri_hash: hashValue(callbackRedirectUri) },
    });
    throw AppError.unauthorized('SSO redirect URI mismatch', 'SSO_REDIRECT_URI_MISMATCH');
  }

  const requestTenantId = await resolveTenantForRequest(req);
  if (String(requestTenantId) !== String(statePayload.tenantId)) {
    await recordStaffIdentityAuditEvent({
      tenantId: statePayload.tenantId,
      provider: { id: statePayload.providerId, provider_key: key },
      eventType: 'SSO_ASSERTION_DENIED',
      outcome: 'denied',
      state,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: {
        reason: 'tenant_host_mismatch',
        request_tenant: requestTenantId,
        state_tenant: statePayload.tenantId,
      },
    });
    throw AppError.unauthorized('SSO tenant mismatch', 'SSO_TENANT_MISMATCH');
  }

  const provider = await getStaffOidcProvider({
    tenantId: statePayload.tenantId,
    providerKey: key,
    activeOnly: true,
  });
  const metadata = await getProviderMetadata(provider);
  let tokenResponse;
  let idPayload;
  try {
    tokenResponse = await exchangeCodeForTokens({
      provider,
      metadata,
      code,
      redirectUri: statePayload.redirectUri,
      codeVerifier: statePayload.codeVerifier,
    });
    if (!tokenResponse?.id_token) throw new Error('OIDC token response missing id_token');
    const jwks = await getJwks(provider, metadata);
    const verified = verifyOidcIdToken({
      idToken: tokenResponse.id_token,
      jwks,
      issuer: metadata.issuer,
      clientId: provider.oidc_client_id,
      nonce: statePayload.nonce,
      clockSkewSeconds: assertionClockSkewSeconds(),
    });
    idPayload = verified.payload;
    validateRequiredClaims(provider.required_claims, idPayload);
    validateAllowedDomains(provider, idPayload);
  } catch (err) {
    await recordStaffIdentityAuditEvent({
      tenantId: statePayload.tenantId,
      provider,
      eventType: 'SSO_ASSERTION_DENIED',
      outcome: 'denied',
      state,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: { reason: 'assertion_validation_failed', error: err.message },
    });
    throw AppError.unauthorized('SSO assertion rejected', 'SSO_ASSERTION_REJECTED');
  }

  const issuer = String(idPayload.iss);
  const subject = String(idPayload.sub || '');
  const email = normalizeEmail(idPayload.email);
  const employeeId = employeeIdFromPayload(provider, idPayload);
  const groups = extractGroups(provider, idPayload);
  let mappedRole;
  try {
    mappedRole = await mapStaffRole({
      tenantId: statePayload.tenantId,
      provider,
      groups,
    });
  } catch (err) {
    await recordStaffIdentityAuditEvent({
      tenantId: statePayload.tenantId,
      provider,
      eventType: 'SSO_ROLE_MAPPING_FAILED',
      outcome: 'denied',
      issuer,
      subject,
      assertion: tokenResponse?.id_token,
      state,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: { reason: err.code || 'mapping_failed', group_count: groups.length, group_hashes: groups.map(hashValue) },
    });
    throw err;
  }

  let linkResult;
  try {
    linkResult = await resolveOrLinkStaff({
      tenantId: statePayload.tenantId,
      provider,
      issuer,
      subject,
      email,
      employeeId,
      mappedRole,
    });
  } catch (err) {
    await recordStaffIdentityAuditEvent({
      tenantId: statePayload.tenantId,
      provider,
      eventType: 'SSO_LOCAL_IDENTITY_LINK_FAILED',
      outcome: 'denied',
      issuer,
      subject,
      assertion: tokenResponse?.id_token,
      state,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: {
        reason: err.code || 'local_identity_not_found',
        email_hash: hashValue(email),
        employee_id_hash: hashValue(employeeId),
      },
    });
    throw err;
  }

  const staff = linkResult.staff;
  await withStaffIdentityScope(statePayload.tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE users
        SET last_sign_in_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2::uuid`,
    staff.id,
    statePayload.tenantId,
  ));

  await recordStaffIdentityAuditEvent({
    tenantId: statePayload.tenantId,
    provider,
    eventType: 'SSO_ASSERTION_ACCEPTED',
    outcome: 'accepted',
    localUid: staff.uid,
    issuer,
    subject,
    assertion: tokenResponse?.id_token,
    state,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      mapped_role: mappedRole,
      matched_claim: linkResult.matchedClaim,
      assurance: {
        acr: idPayload.acr || null,
        amr: idPayload.amr || null,
      },
      idp_session_hash: hashValue(idPayload.sid),
      email_hash: hashValue(email),
      employee_id_hash: hashValue(employeeId),
    },
  });

  const stableDeviceId = await StaffAuthService.bindStaffInstallation(
    staff,
    statePayload.deviceId,
    { platform: statePayload.deviceType || deviceTypeFrom(req) },
  );
  const {
    accessToken,
    tokenEpoch,
    sessionFamilyId,
  } = await issueAccessTokenAndClaimSession({
    userUid: staff.uid,
    tokenPayload: {
      id: staff.id,
      uid: staff.uid,
      role: mappedRole,
      tenant_id: statePayload.tenantId,
    },
    expiresIn: SECURITY_CONFIG.jwt.staffAccessExpiry,
    deviceType: statePayload.deviceType || deviceTypeFrom(req),
    stableDeviceId,
    req,
  });
  const refreshToken = await StaffAuthService.generateRefreshToken(
    staff,
    stableDeviceId,
    tokenEpoch,
    sessionFamilyId,
  );
  await createStaffSsoRefreshSession({
    tenantId: statePayload.tenantId,
    staff,
    refreshToken,
    req,
    deviceId: stableDeviceId,
  });

  return {
    accessToken,
    refreshToken,
    staff: {
      id: staff.id,
      uid: staff.uid,
      employeeId: staff.employee_id,
      name: staff.name,
      email: staff.email,
      department: staff.department,
      role: mappedRole,
      position: staff.position,
    },
  };
}

export async function recordStaffIdentityAuditEvent({
  tenantId,
  provider = null,
  eventType,
  outcome,
  actorUid = null,
  localUid = null,
  issuer = null,
  subject = null,
  assertion = null,
  state = null,
  requestId = null,
  ipAddress = null,
  userAgent = null,
  details = {},
} = {}) {
  if (!tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  if (!eventType || !outcome) throw new Error('identity audit requires eventType and outcome');
  const providerId = provider?.id ?? null;
  const providerKey = provider?.provider_key ?? null;
  const safeDetails = details && typeof details === 'object' ? details : {};
  try {
    await withStaffIdentityScope(tenantId, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO identity_audit_events (
          tenant_id, realm, protocol, provider_id, provider_key, event_type, outcome,
          actor_uid, local_uid, issuer, subject_hash, assertion_hash, state_hash,
          request_id, ip_address, user_agent, details
        )
        VALUES (
          $1::uuid, 'staff', 'oidc', $2::bigint, $3, $4, $5,
          $6::uuid, $7::uuid, $8, $9, $10, $11,
          $12, $13::inet, $14, $15::jsonb
        )`,
      tenantId,
      providerId,
      providerKey,
      eventType,
      outcome,
      actorUid || null,
      localUid || null,
      issuer || null,
      hashValue(subject),
      hashValue(assertion),
      hashValue(state),
      requestId || null,
      ipAddress || null,
      userAgent || null,
      JSON.stringify(safeDetails),
    ));
  } catch (err) {
    logger.error('staff identity audit write failed', { eventType, outcome, error: err.message });
    throw AppError.internal('Identity audit write failed', 'SSO_AUDIT_WRITE_FAILED');
  }
}

export function isStaffSsoRoleAllowed(role) {
  const normalized = String(role || '').toUpperCase();
  return STAFF_REALM_ROLES.has(normalized) && !FORBIDDEN_STAFF_SSO_ROLES.has(normalized);
}
