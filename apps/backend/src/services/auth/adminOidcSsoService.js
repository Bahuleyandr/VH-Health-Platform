import crypto from 'crypto';
import { URLSearchParams } from 'url';

import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { sha256Base64Url, verifyOidcIdToken } from '../../utils/oidcJwt.js';
import { ADMIN_ROLES } from '../../utils/roleHelpers.js';
import { JWT_AUDIENCES, JWT_ISSUER } from '../../utils/jwtUtils.js';
import { getTenantBySlug } from '../tenant/tenantService.js';
import { generateRefreshToken, issueAccessTokenAndClaimSession } from './loginSessionHelper.js';
import { exposeScimProviderConfig } from './scimCredentialService.js';

export const OIDC_STATE_COOKIE = 'vh_admin_oidc_state';
export const OIDC_HANDOFF_COOKIE = 'vh_admin_sso_handoff';

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const ADMIN_REALM_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const DEFAULT_SCOPE = 'openid email profile';
const STATE_TTL_SECONDS = 10 * 60;
const HANDOFF_TTL_SECONDS = 90;
const METADATA_CACHE = new Map();
const JWKS_CACHE = new Map();

function getHmacSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw AppError.internal('JWT_SECRET is required for SSO state signing', 'SSO_STATE_SECRET_MISSING');
  return secret;
}

function hmac(value) {
  return crypto.createHmac('sha256', getHmacSecret()).update(String(value)).digest('base64url');
}

function signEnvelope(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verifyEnvelope(value, code = 'SSO_STATE_INVALID') {
  const [body, sig] = String(value || '').split('.');
  if (!body || !sig || !timingSafeEqual(sig, hmac(body))) {
    throw AppError.unauthorized('Invalid SSO state', code);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw AppError.unauthorized('Invalid SSO state', code);
  }
  if (!parsed?.exp || Number(parsed.exp) < Math.floor(Date.now() / 1000)) {
    throw AppError.unauthorized('Expired SSO state', 'SSO_STATE_EXPIRED');
  }
  return parsed;
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

function parseCookie(header, name) {
  const cookieHeader = String(header || '');
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function requestHost(req) {
  return String(
    req?.headers?.['x-admin-host']
    || req?.query?.admin_host
    || req?.headers?.['x-forwarded-host']
    || req?.headers?.host
    || '',
  ).split(',')[0].trim().toLowerCase();
}

function requestProto(req) {
  return String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https').split(',')[0].trim();
}

function tenantBaseHosts() {
  return String(process.env.TENANT_BASE_HOST || 'localhost')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function parseAdminTenantSlug(host, baseHosts = tenantBaseHosts()) {
  const h = String(host || '').toLowerCase().split(':')[0].trim();
  if (!h) return null;
  for (const base of baseHosts) {
    if (h === base) return null;
    if (h.endsWith(`.${base}`)) {
      const label = h.slice(0, -(base.length + 1)).split('.')[0] || '';
      if (label.endsWith('-admin') && label.length > 6) return label.slice(0, -6);
      return null;
    }
  }
  return null;
}

export async function resolveAdminSsoTenant(req) {
  const host = requestHost(req);
  const slug = parseAdminTenantSlug(host);
  if (!slug) {
    return { tenantId: null, tenantSlug: null, host, isPlatform: true };
  }
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.status !== 'active') {
    throw AppError.badRequest('Unknown or inactive tenant', 'SSO_TENANT_NOT_RESOLVED');
  }
  return { tenantId: String(tenant.id), tenantSlug: slug, host, isPlatform: false };
}

async function resolveAdminSsoTenantFromHost(host) {
  const slug = parseAdminTenantSlug(host);
  if (!slug) return { tenantId: null, tenantSlug: null, host, isPlatform: true };
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.status !== 'active') {
    throw AppError.badRequest('Unknown or inactive tenant', 'SSO_TENANT_NOT_RESOLVED');
  }
  return { tenantId: String(tenant.id), tenantSlug: slug, host, isPlatform: false };
}

async function resolveCallbackTenant(req, statePayload) {
  const fromRequest = await resolveAdminSsoTenant(req);
  if (fromRequest.tenantId || statePayload.platform) return fromRequest;
  if (statePayload.adminHost) {
    return resolveAdminSsoTenantFromHost(statePayload.adminHost);
  }
  return fromRequest;
}

function isLocalhost(hostname) {
  const host = String(hostname || '').toLowerCase().split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function cookieDomainForHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  if (!h || isLocalhost(h) || /^[0-9.]+$/.test(h)) return null;
  const base = tenantBaseHosts().find((candidate) => h === candidate || h.endsWith(`.${candidate}`));
  if (!base || isLocalhost(base)) return null;
  return `.${base}`;
}

export function buildCookie(name, value, req, {
  maxAgeSeconds,
  httpOnly = true,
  sameSite = 'Lax',
  path = '/',
  domainHost = null,
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (requestProto(req) === 'https' || String(process.env.NODE_ENV).toLowerCase() === 'production') {
    parts.push('Secure');
  }
  if (Number.isFinite(maxAgeSeconds)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  const domain = cookieDomainForHost(domainHost || req?.headers?.host || '');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function clearCookie(name, req, opts = {}) {
  return buildCookie(name, '', req, { ...opts, maxAgeSeconds: 0 });
}

function withIdentityScope(tenantId, fn) {
  if (tenantId) return setTenant(tenantId, fn);
  return setTenant(null, fn, { superAdmin: true });
}

function sanitizeProvider(row, { includeSecretPresence = true } = {}) {
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

export function invalidateAdminOidcProviderCache(providerId = null) {
  if (!providerId) {
    METADATA_CACHE.clear();
    JWKS_CACHE.clear();
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

async function queryProviders({ tenantId, platform = false, status = null, providerKey = null }) {
  return withIdentityScope(platform ? null : tenantId, async (tx) => {
    const tenantFilter = platform
      ? 'tenant_id IS NULL AND is_platform_provider = true'
      : 'tenant_id = $1::uuid AND is_platform_provider = false';
    const params = platform ? [] : [tenantId];
    let idx = params.length + 1;
    const filters = [
      tenantFilter,
      "realm = 'admin'",
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

export async function listAdminOidcProviders({ tenantId, platform = false, status = null } = {}) {
  if (!platform && !tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const rows = await queryProviders({ tenantId, platform, status });
  return rows.map((row) => sanitizeProvider(row));
}

export async function getAdminOidcProvider({ tenantId, platform = false, providerKey, activeOnly = false }) {
  const key = validateProviderKey(providerKey);
  const rows = await queryProviders({
    tenantId,
    platform,
    providerKey: key,
    status: activeOnly ? 'active' : null,
  });
  if (!rows[0]) throw AppError.notFound('SSO provider not found', 'SSO_PROVIDER_NOT_FOUND');
  return rows[0];
}

export async function upsertAdminOidcProvider({ tenantId, platform = false, providerKey, actorUid, input = {} }) {
  if (!platform && !tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const key = validateProviderKey(providerKey || input.provider_key);
  const status = String(input.status || 'draft').toLowerCase();
  if (!['draft', 'active', 'disabled'].includes(status)) {
    throw AppError.badRequest('Invalid provider status', 'SSO_PROVIDER_STATUS_INVALID');
  }

  const displayName = String(input.display_name || input.displayName || key).trim();
  if (!displayName) throw AppError.badRequest('display_name is required', 'SSO_DISPLAY_NAME_REQUIRED');

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
    policy: jsonObject(input.policy, 'policy'),
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
    ? encryptField(String(secretInput), { tenantId: platform ? null : tenantId })
    : null;

  const rows = await withIdentityScope(platform ? null : tenantId, async (tx) => {
    const existing = platform
      ? await tx.$queryRawUnsafe(
        `SELECT *
           FROM tenant_identity_providers
          WHERE tenant_id IS NULL
            AND is_platform_provider = true
            AND realm = 'admin'
            AND protocol = 'oidc'
            AND provider_key = $1
          LIMIT 1`,
        key,
      )
      : await tx.$queryRawUnsafe(
        `SELECT *
           FROM tenant_identity_providers
          WHERE tenant_id = $1::uuid
            AND is_platform_provider = false
            AND realm = 'admin'
            AND protocol = 'oidc'
            AND provider_key = $2
          LIMIT 1`,
        tenantId,
        key,
      );
    if (existing[0]) {
      const updateRows = await tx.$queryRawUnsafe(
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
      return updateRows;
    }
    return tx.$queryRawUnsafe(
      `INSERT INTO tenant_identity_providers (
          tenant_id, is_platform_provider, realm, protocol, provider_key, display_name, status,
          oidc_issuer, oidc_discovery_url, oidc_jwks_uri, oidc_authorization_endpoint,
          oidc_token_endpoint, oidc_userinfo_endpoint, oidc_client_id, oidc_client_secret_ciphertext,
          group_claim_name, allowed_domains, required_claims, policy, created_by, updated_by
        )
        VALUES (
          $1::uuid, $2, 'admin', 'oidc', $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15::text[], $16::jsonb, $17::jsonb, $18::uuid, $18::uuid
        )
        RETURNING *`,
      platform ? null : tenantId,
      Boolean(platform),
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

  invalidateAdminOidcProviderCache(rows[0]?.id);
  await recordIdentityAuditEvent({
    tenantId: platform ? null : tenantId,
    provider: rows[0],
    eventType: 'SSO_PROVIDER_CONFIG_UPDATED',
    outcome: 'accepted',
    actorUid,
    details: { status, platform: Boolean(platform), secret_changed: Boolean(secretInput) },
  });
  return sanitizeProvider(rows[0]);
}

export async function listAdminOidcRoleMappings({ tenantId, platform = false, providerKey }) {
  const provider = await getAdminOidcProvider({ tenantId, platform, providerKey });
  const rows = await withIdentityScope(platform ? null : tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, tenant_id, provider_id, realm, idp_group, vh_role, status, priority, created_at, updated_at
       FROM tenant_idp_role_mappings
      WHERE provider_id = $1::bigint
      ORDER BY priority ASC, idp_group ASC`,
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

export async function replaceAdminOidcRoleMappings({ tenantId, platform = false, providerKey, actorUid, mappings = [] }) {
  const provider = await getAdminOidcProvider({ tenantId, platform, providerKey });
  if (!Array.isArray(mappings)) throw AppError.badRequest('mappings must be an array', 'SSO_MAPPINGS_INVALID');
  const normalized = mappings.map((mapping, index) => {
    const idpGroup = String(mapping?.idp_group || mapping?.idpGroup || '').trim();
    const vhRole = String(mapping?.vh_role || mapping?.vhRole || '').trim().toUpperCase();
    const status = String(mapping?.status || 'active').toLowerCase();
    const priority = Number.parseInt(mapping?.priority ?? `${100 + index}`, 10);
    if (!idpGroup) throw AppError.badRequest('idp_group is required', 'SSO_MAPPING_GROUP_REQUIRED');
    if (!ADMIN_REALM_ROLES.has(vhRole)) throw AppError.badRequest('Invalid admin role mapping', 'SSO_MAPPING_ROLE_INVALID');
    if (!platform && vhRole !== 'ADMIN') throw AppError.badRequest('Tenant providers may map only ADMIN', 'SSO_MAPPING_ROLE_INVALID');
    if (platform && vhRole !== 'SUPER_ADMIN') throw AppError.badRequest('Platform providers may map only SUPER_ADMIN', 'SSO_MAPPING_ROLE_INVALID');
    if (!['active', 'disabled'].includes(status)) throw AppError.badRequest('Invalid mapping status', 'SSO_MAPPING_STATUS_INVALID');
    return { idpGroup, vhRole, status, priority: Number.isFinite(priority) ? priority : 100 + index };
  });

  await withIdentityScope(platform ? null : tenantId, async (tx) => {
    await tx.$queryRawUnsafe('DELETE FROM tenant_idp_role_mappings WHERE provider_id = $1::bigint', provider.id);
    for (const mapping of normalized) {
      await tx.$queryRawUnsafe(
        `INSERT INTO tenant_idp_role_mappings (
            tenant_id, provider_id, realm, idp_group, vh_role, status, priority, created_by, updated_by
          )
          VALUES ($1::uuid, $2::bigint, 'admin', $3, $4, $5, $6, $7::uuid, $7::uuid)`,
        platform ? null : tenantId,
        provider.id,
        mapping.idpGroup,
        mapping.vhRole,
        mapping.status,
        mapping.priority,
        actorUid || null,
      );
    }
  });

  await recordIdentityAuditEvent({
    tenantId: platform ? null : tenantId,
    provider,
    eventType: 'SSO_ROLE_MAPPINGS_UPDATED',
    outcome: 'accepted',
    actorUid,
    details: { count: normalized.length, roles: [...new Set(normalized.map((m) => m.vhRole))] },
  });
  return listAdminOidcRoleMappings({ tenantId, platform, providerKey });
}

export async function discoverAdminOidcProvidersForRequest(req) {
  const tenant = await resolveAdminSsoTenant(req);
  const rows = await queryProviders({
    tenantId: tenant.tenantId,
    platform: tenant.isPlatform,
    status: 'active',
  });
  return {
    tenant: {
      id: tenant.tenantId,
      slug: tenant.tenantSlug,
      platform: tenant.isPlatform,
    },
    providers: rows.map((row) => ({
      provider_key: row.provider_key,
      display_name: row.display_name,
      start_url: `/api/v1/auth/admin/sso/oidc/${encodeURIComponent(row.provider_key)}/start`,
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

function callbackUrlFor(req, providerKey) {
  const host = req?.headers?.['x-forwarded-api-host'] || req?.headers?.host;
  const proto = requestProto(req);
  return `${proto}://${host}/api/v1/auth/admin/sso/oidc/${encodeURIComponent(providerKey)}/callback`;
}

function safeReturnTo(raw, req) {
  const fallback = '/dashboard';
  const value = String(raw || '').trim();
  if (!value) return fallback;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const parsed = new URL(value);
    const host = requestHost(req).split(':')[0];
    if (parsed.hostname.toLowerCase() === host) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
  return fallback;
}

export async function startAdminOidcLogin({ req, providerKey }) {
  const tenant = await resolveAdminSsoTenant(req);
  const key = validateProviderKey(providerKey);
  const provider = await getAdminOidcProvider({
    tenantId: tenant.tenantId,
    platform: tenant.isPlatform,
    providerKey: key,
    activeOnly: true,
  });
  const metadata = await getProviderMetadata(provider);
  const stateId = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = sha256Base64Url(codeVerifier);
  const redirectUri = callbackUrlFor(req, key);
  const state = `${stateId}.${hmac(stateId)}`;
  const stateHash = hashValue(state);
  const deviceType = String(req?.query?.deviceType || req?.query?.device_type || 'web').slice(0, 40);
  const returnTo = safeReturnTo(req?.query?.returnTo || req?.query?.return_to, req);

  const cookieValue = signEnvelope({
    v: 1,
    stateId,
    stateHash,
    nonce,
    codeVerifier,
    providerKey: key,
    providerId: Number(provider.id),
    tenantId: tenant.tenantId,
    tenantSlug: tenant.tenantSlug,
    platform: tenant.isPlatform,
    adminHost: tenant.host,
    redirectUri,
    returnTo,
    deviceType,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  });

  await recordIdentityAuditEvent({
    tenantId: tenant.tenantId,
    provider,
    eventType: 'SSO_START',
    outcome: 'started',
    state,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: { device_type: deviceType, redirect_target: returnTo.startsWith('/') ? 'relative' : 'other' },
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
    stateCookie: buildCookie(OIDC_STATE_COOKIE, cookieValue, req, {
      maxAgeSeconds: STATE_TTL_SECONDS,
      path: '/api/v1/auth/admin/sso/oidc',
    }),
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

async function mapAdminRole({ tenantId, platform, provider, groups }) {
  if (!groups.length) throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  const lowerGroups = groups.map((group) => group.toLowerCase());
  const rows = await withIdentityScope(platform ? null : tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT idp_group, vh_role, priority
       FROM tenant_idp_role_mappings
      WHERE provider_id = $1::bigint
        AND realm = 'admin'
        AND status = 'active'
        AND lower(idp_group) = ANY($2::text[])
      ORDER BY priority ASC, idp_group ASC`,
    provider.id,
    lowerGroups,
  ));
  const roles = [...new Set(rows.map((row) => String(row.vh_role || '').toUpperCase()))];
  if (roles.length !== 1) {
    throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  }
  const role = roles[0];
  if (!ADMIN_REALM_ROLES.has(role)) {
    throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  }
  if (platform && role !== 'SUPER_ADMIN') {
    throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  }
  if (!platform && role !== 'ADMIN') {
    throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  }
  return role;
}

async function resolveOrLinkAdmin({ tenantId, platform, provider, issuer, subject, email, mappedRole }) {
  return withIdentityScope(platform ? null : tenantId, async (tx) => {
    const linked = await tx.$queryRawUnsafe(
      `SELECT a.uid, a.username, a.email, a.name, a.role, a.status, a.tenant_id
         FROM federated_identities fi
         JOIN admins a ON a.uid = fi.local_uid
        WHERE fi.provider_id = $1::bigint
          AND fi.issuer = $2
          AND fi.subject = $3
          AND fi.realm = 'admin'
          AND fi.status = 'active'
          AND (($4::uuid IS NULL AND fi.tenant_id IS NULL) OR fi.tenant_id = $4::uuid)
        LIMIT 1`,
      provider.id,
      issuer,
      subject,
      platform ? null : tenantId,
    );
    if (linked[0]) {
      const admin = linked[0];
      if (String(admin.status || '').toLowerCase() !== 'active' || String(admin.role || '').toUpperCase() !== mappedRole) {
        throw AppError.unauthorized('SSO local identity inactive or role mismatch', 'SSO_LOCAL_IDENTITY_DENIED');
      }
      await tx.$queryRawUnsafe(
        `UPDATE federated_identities
            SET last_seen_at = NOW(), email_at_link = COALESCE($1, email_at_link), updated_at = NOW()
          WHERE provider_id = $2::bigint AND issuer = $3 AND subject = $4`,
        email || null,
        provider.id,
        issuer,
        subject,
      );
      return admin;
    }

    if (!email) {
      throw AppError.unauthorized('SSO local identity not found', 'SSO_LOCAL_IDENTITY_NOT_FOUND');
    }
    const candidates = await tx.$queryRawUnsafe(
      `SELECT uid, username, email, name, role, status, tenant_id
         FROM admins
        WHERE lower(email) = lower($1)
          AND role = $2
          AND status = 'active'
          AND (($3::uuid IS NULL AND tenant_id IS NULL) OR tenant_id = $3::uuid)
        LIMIT 2`,
      email,
      mappedRole,
      platform ? null : tenantId,
    );
    if (candidates.length !== 1) {
      throw AppError.unauthorized('SSO local identity not found', 'SSO_LOCAL_IDENTITY_NOT_FOUND');
    }
    const admin = candidates[0];
    await tx.$queryRawUnsafe(
      `INSERT INTO federated_identities (
          tenant_id, realm, provider_id, issuer, subject, local_uid, email_at_link,
          last_seen_at, status, created_at, updated_at
        )
        VALUES ($1::uuid, 'admin', $2::bigint, $3, $4, $5::uuid, $6, NOW(), 'active', NOW(), NOW())
        ON CONFLICT (provider_id, issuer, subject)
        DO UPDATE SET local_uid = EXCLUDED.local_uid,
                      email_at_link = EXCLUDED.email_at_link,
                      last_seen_at = NOW(),
                      status = 'active',
                      updated_at = NOW()`,
      platform ? null : tenantId,
      provider.id,
      issuer,
      subject,
      admin.uid,
      email || null,
    );
    return admin;
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

export async function completeAdminOidcCallback({ req, providerKey, code, state }) {
  const key = validateProviderKey(providerKey);
  if (!code || !state) throw AppError.badRequest('code and state are required', 'SSO_CALLBACK_INVALID');
  const cookieValue = parseCookie(req?.headers?.cookie, OIDC_STATE_COOKIE);
  if (!cookieValue) throw AppError.unauthorized('Missing SSO state cookie', 'SSO_STATE_MISSING');
  const statePayload = verifyEnvelope(cookieValue);
  const [stateId, stateSig] = String(state).split('.');
  if (!stateId || !stateSig || !timingSafeEqual(stateSig, hmac(stateId)) || stateId !== statePayload.stateId) {
    throw AppError.unauthorized('Invalid SSO state', 'SSO_STATE_INVALID');
  }
  if (key !== statePayload.providerKey) {
    throw AppError.unauthorized('Invalid SSO state', 'SSO_STATE_PROVIDER_MISMATCH');
  }

  const tenant = await resolveCallbackTenant(req, statePayload);
  if ((tenant.tenantId || null) !== (statePayload.tenantId || null)) {
    await recordIdentityAuditEvent({
      tenantId: statePayload.tenantId || tenant.tenantId,
      provider: { id: statePayload.providerId, provider_key: key },
      eventType: 'SSO_ASSERTION_DENIED',
      outcome: 'denied',
      state,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: { reason: 'tenant_host_mismatch', request_tenant: tenant.tenantId, state_tenant: statePayload.tenantId },
    });
    throw AppError.unauthorized('SSO tenant mismatch', 'SSO_TENANT_MISMATCH');
  }

  const provider = await getAdminOidcProvider({
    tenantId: statePayload.tenantId,
    platform: Boolean(statePayload.platform),
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
    await recordIdentityAuditEvent({
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
  const email = idPayload.email ? String(idPayload.email).toLowerCase() : null;
  const groups = extractGroups(provider, idPayload);
  let mappedRole;
  try {
    mappedRole = await mapAdminRole({
      tenantId: statePayload.tenantId,
      platform: Boolean(statePayload.platform),
      provider,
      groups,
    });
  } catch (err) {
    await recordIdentityAuditEvent({
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

  let admin;
  try {
    admin = await resolveOrLinkAdmin({
      tenantId: statePayload.tenantId,
      platform: Boolean(statePayload.platform),
      provider,
      issuer,
      subject,
      email,
      mappedRole,
    });
  } catch (err) {
    await recordIdentityAuditEvent({
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
      details: { reason: err.code || 'local_identity_not_found', email_hash: hashValue(email) },
    });
    throw err;
  }

  await withIdentityScope(statePayload.platform ? null : statePayload.tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE admins
        SET last_login = NOW(), failed_login_attempts = 0, updated_at = NOW()
      WHERE uid = $1::uuid`,
    admin.uid,
  ));

  await recordIdentityAuditEvent({
    tenantId: statePayload.tenantId,
    provider,
    eventType: 'SSO_ASSERTION_ACCEPTED',
    outcome: 'accepted',
    localUid: admin.uid,
    issuer,
    subject,
    assertion: tokenResponse?.id_token,
    state,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      mapped_role: mappedRole,
      assurance: {
        acr: idPayload.acr || null,
        amr: idPayload.amr || null,
      },
      idp_session_hash: hashValue(idPayload.sid),
      email_hash: hashValue(email),
    },
  });

  const tenantIdForToken = statePayload.platform ? undefined : statePayload.tenantId;
  const { accessToken: token, tokenEpoch } = await issueAccessTokenAndClaimSession({
    userUid: admin.uid,
    tokenPayload: {
      uid: admin.uid,
      role: mappedRole,
      email: admin.email ?? email ?? undefined,
      sub: admin.uid,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCES.admin,
      ...(tenantIdForToken ? { tenant_id: tenantIdForToken } : {}),
      // Intentionally no `mfa: true`: SUPER_ADMIN SSO still requires local TOTP step-up.
    },
    expiresIn: SECURITY_CONFIG.jwt.adminExpiry,
    deviceType: statePayload.deviceType || 'web',
    req,
  });
  const refreshToken = await generateRefreshToken({
    uid: admin.uid,
    role: mappedRole,
    tokenEpoch,
    realm: 'admin',
  });
  const response = {
    token,
    refreshToken,
    admin: {
      uid: admin.uid,
      username: admin.username,
      email: admin.email,
      name: admin.name,
      role: mappedRole,
    },
    returnTo: statePayload.returnTo || '/dashboard',
    adminHost: statePayload.adminHost || requestHost(req),
  };
  return response;
}

export function createHandoffCookiePayload(loginResult) {
  return signEnvelope({
    v: 1,
    token: loginResult.token,
    admin: loginResult.admin,
    returnTo: loginResult.returnTo || '/dashboard',
    exp: Math.floor(Date.now() / 1000) + HANDOFF_TTL_SECONDS,
  });
}

export function consumeHandoffCookie(cookieHeader) {
  const value = parseCookie(cookieHeader, OIDC_HANDOFF_COOKIE);
  if (!value) throw AppError.unauthorized('Missing SSO handoff cookie', 'SSO_HANDOFF_MISSING');
  const payload = verifyEnvelope(value, 'SSO_HANDOFF_INVALID');
  if (!payload?.token || !payload?.admin) {
    throw AppError.unauthorized('Invalid SSO handoff cookie', 'SSO_HANDOFF_INVALID');
  }
  return payload;
}

export async function recordIdentityAuditEvent({
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
  if (!eventType || !outcome) throw new Error('identity audit requires eventType and outcome');
  const providerId = provider?.id ?? null;
  const providerKey = provider?.provider_key ?? null;
  const safeDetails = details && typeof details === 'object' ? details : {};
  try {
    await withIdentityScope(tenantId || null, (tx) => tx.$queryRawUnsafe(
      `INSERT INTO identity_audit_events (
          tenant_id, realm, protocol, provider_id, provider_key, event_type, outcome,
          actor_uid, local_uid, issuer, subject_hash, assertion_hash, state_hash,
          request_id, ip_address, user_agent, details
        )
        VALUES (
          $1::uuid, 'admin', 'oidc', $2::bigint, $3, $4, $5,
          $6::uuid, $7::uuid, $8, $9, $10, $11,
          $12, $13::inet, $14, $15::jsonb
        )`,
      tenantId || null,
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
    logger.error('identity audit write failed', { eventType, outcome, error: err.message });
    throw AppError.internal('Identity audit write failed', 'SSO_AUDIT_WRITE_FAILED');
  }
}

export function isAdminRoleAllowed(role) {
  return ADMIN_ROLES.includes(role) || role === 'SUPER_ADMIN';
}
