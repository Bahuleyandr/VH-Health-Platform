import crypto from 'crypto';

import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import { parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml.js';

import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { JWT_AUDIENCES, JWT_ISSUER } from '../../utils/jwtUtils.js';
import { ALL_STAFF_ROLES } from '../../utils/roleHelpers.js';
import { resolveTenantForRequest } from '../tenant/tenantService.js';
import { resolveAdminSsoTenant } from './adminOidcSsoService.js';
import { generateRefreshToken, issueAccessTokenAndClaimSession } from './loginSessionHelper.js';
import {
  decryptSamlField,
  decryptSamlJson,
  getSamlProvider,
  listSamlProviders,
  recordSamlIdentityAuditEvent,
} from './samlSsoConfigService.js';
import { StaffAuthService } from './staffAuthService.js';

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const ADMIN_REALM_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const STAFF_REALM_ROLES = new Set(ALL_STAFF_ROLES);
const FORBIDDEN_STAFF_SSO_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'PATIENT', 'WEBHOOK_CLIENT']);
const RELAY_STATE_TTL_SECONDS = 10 * 60;
const SAML_REQUEST_TTL_SECONDS = 10 * 60;
const SAML_REPLAY_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_ASSERTION_BYTES = 256 * 1024;

function intEnv(name, defaultValue, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

function assertionClockSkewMs() {
  return intEnv('SSO_ASSERTION_CLOCK_SKEW_SECONDS', 60, 0, 600) * 1000;
}

function samlMaxAssertionBytes() {
  return intEnv('SSO_SAML_MAX_ASSERTION_BYTES', DEFAULT_MAX_ASSERTION_BYTES, 4096, 2 * 1024 * 1024);
}

function getHmacSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw AppError.internal('JWT_SECRET is required for SAML state signing', 'SSO_STATE_SECRET_MISSING');
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

function hashValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function validateProviderKey(providerKey) {
  const key = String(providerKey || '').trim().toLowerCase();
  if (!PROVIDER_KEY_RE.test(key)) {
    throw AppError.badRequest('Invalid provider key', 'SSO_PROVIDER_KEY_INVALID');
  }
  return key;
}

function withIdentityScope(tenantId, fn) {
  if (tenantId) return setTenant(tenantId, fn);
  return setTenant(null, fn, { superAdmin: true });
}

function requestProto(req) {
  return String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https').split(',')[0].trim();
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

function deviceTypeFrom(req, fallback = 'web') {
  return String(
    req?.query?.deviceType
    || req?.query?.device_type
    || req?.body?.deviceType
    || req?.body?.device_type
    || fallback,
  ).slice(0, 40);
}

function deviceIdFrom(req) {
  const value = String(req?.query?.deviceId || req?.query?.device_id || req?.body?.deviceId || req?.body?.device_id || '').trim();
  return value ? value.slice(0, 120) : null;
}

function callbackUrlFor(req, realm, providerKey) {
  const host = req?.headers?.['x-forwarded-api-host'] || req?.headers?.host;
  const proto = requestProto(req);
  return `${proto}://${host}/api/v1/auth/${realm}/sso/saml/${encodeURIComponent(providerKey)}/acs`;
}

function relayStateFor({ realm, tenant, provider, providerKey, req }) {
  const common = {
    v: 1,
    realm,
    providerKey,
    providerId: Number(provider.id),
    tenantId: tenant.tenantId,
    platform: Boolean(tenant.isPlatform),
    deviceType: deviceTypeFrom(req, realm === 'staff' ? 'mobile' : 'web'),
    exp: Math.floor(Date.now() / 1000) + RELAY_STATE_TTL_SECONDS,
  };
  if (realm === 'admin') {
    return signEnvelope({
      ...common,
      tenantSlug: tenant.tenantSlug,
      adminHost: tenant.host,
      returnTo: safeReturnTo(req?.query?.returnTo || req?.query?.return_to, req),
    });
  }
  return signEnvelope({
    ...common,
    deviceId: deviceIdFrom(req),
  });
}

function parseRelayState(value, { realm, providerKey, tenant, provider }) {
  if (!value) return null;
  const parsed = verifyEnvelope(value);
  if (
    parsed.realm !== realm
    || parsed.providerKey !== providerKey
    || Number(parsed.providerId) !== Number(provider.id)
    || (parsed.tenantId || null) !== (tenant.tenantId || null)
    || Boolean(parsed.platform) !== Boolean(tenant.isPlatform)
  ) {
    throw AppError.unauthorized('Invalid SSO state', 'SSO_STATE_PROVIDER_MISMATCH');
  }
  return parsed;
}

function normalizeSamlResponseInput(raw) {
  const value = String(raw || '').trim();
  if (!value) throw AppError.badRequest('SAMLResponse is required', 'SSO_SAML_RESPONSE_REQUIRED');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length) throw AppError.badRequest('SAMLResponse is empty', 'SSO_SAML_RESPONSE_REQUIRED');
  if (decoded.length > samlMaxAssertionBytes()) {
    throw AppError.badRequest('SAMLResponse exceeds configured size limit', 'SSO_SAML_ASSERTION_TOO_LARGE');
  }
  return decoded.toString('utf8');
}

function attr(node, expression) {
  return xpath.selectAttributes(node, expression)[0]?.nodeValue || null;
}

function text(node, expression) {
  return String(xpath.selectElements(node, expression)[0]?.textContent || '').trim() || null;
}

async function inspectResponseXml(xml) {
  let doc;
  try {
    doc = await parseDomFromString(xml);
  } catch (err) {
    throw AppError.unauthorized('SSO assertion rejected', 'SSO_ASSERTION_REJECTED', { reason: err.message });
  }
  const responseId = attr(doc, "/*[local-name()='Response']/@ID");
  const inResponseTo = attr(doc, "/*[local-name()='Response']/@InResponseTo");
  const destination = attr(doc, "/*[local-name()='Response']/@Destination");
  const responseIssuer = text(doc, "/*[local-name()='Response']/*[local-name()='Issuer']");
  const encryptedAssertionCount = xpath.selectElements(doc, "/*[local-name()='Response']/*[local-name()='EncryptedAssertion']").length;
  return { doc, responseId, inResponseTo, destination, responseIssuer, encryptedAssertionCount };
}

async function inspectAssertionXml(xml) {
  let doc;
  try {
    doc = await parseDomFromString(String(xml || ''));
  } catch (err) {
    throw AppError.unauthorized('SSO assertion rejected', 'SSO_ASSERTION_REJECTED', { reason: err.message });
  }
  const assertionId = attr(doc, "/*[local-name()='Assertion']/@ID");
  const assertionIssuer = text(doc, "/*[local-name()='Assertion']/*[local-name()='Issuer']");
  const recipients = xpath.selectAttributes(
    doc,
    "/*[local-name()='Assertion']/*[local-name()='Subject']/*[local-name()='SubjectConfirmation']/*[local-name()='SubjectConfirmationData']/@Recipient",
  ).map((node) => String(node.nodeValue || '').trim()).filter(Boolean);
  return { assertionId, assertionIssuer, recipients };
}

function normalizeClaimValue(value) {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'object') return value;
  const textValue = String(value).trim();
  return textValue || null;
}

function claimValue(profile, names) {
  for (const name of names) {
    const value = normalizeClaimValue(profile?.[name] ?? profile?.attributes?.[name]);
    if (Array.isArray(value) ? value.length : value) return value;
  }
  return null;
}

function normalizeEmail(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const email = String(raw || '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

function validateRequiredClaims(requiredClaims, profile) {
  for (const [claim, expected] of Object.entries(requiredClaims || {})) {
    const actual = claimValue(profile, [claim]);
    const actualValues = Array.isArray(actual) ? actual.map(String) : [String(actual ?? '')];
    if (Array.isArray(expected)) {
      const ok = expected.map(String).some((value) => actualValues.includes(value));
      if (!ok) throw new Error(`SAML required claim mismatch: ${claim}`);
    } else if (!actualValues.includes(String(expected))) {
      throw new Error(`SAML required claim mismatch: ${claim}`);
    }
  }
}

function validateAllowedDomains(provider, profile) {
  const allowed = (provider.allowed_domains || []).map((d) => String(d).toLowerCase().replace(/^@/, ''));
  if (!allowed.length) return;
  const email = normalizeEmail(claimValue(profile, [
    'email',
    'mail',
    'urn:oid:0.9.2342.19200300.100.1.3',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  ]));
  const emailDomain = email?.includes('@') ? email.split('@').pop() : '';
  const hostedDomain = String(claimValue(profile, ['hd', 'tid', 'tenant']) || '').toLowerCase();
  if (!allowed.includes(emailDomain) && !allowed.includes(hostedDomain)) {
    throw new Error('SAML hosted domain not allowed');
  }
}

function extractGroups(provider, profile) {
  const claimName = provider.group_claim_name || 'groups';
  const value = claimValue(profile, [
    claimName,
    'groups',
    'group',
    'memberOf',
    'http://schemas.xmlsoap.org/claims/Group',
    'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  ]);
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function employeeIdFromProfile(provider, profile) {
  const policy = provider.policy || {};
  const configured = policy.staff_employee_id_claim
    || policy.staffEmployeeIdClaim
    || policy.employee_id_claim
    || policy.employeeIdClaim;
  const claimNames = configured
    ? [configured]
    : ['employee_id', 'employeeId', 'employee_number', 'employeeNumber'];
  const value = claimValue(profile, claimNames);
  return Array.isArray(value) ? String(value[0] || '').trim() || null : String(value || '').trim() || null;
}

function replayKey(value) {
  return String(value || '').trim();
}

function replayExpiresAt(ttlSeconds = SAML_REPLAY_TTL_SECONDS) {
  return new Date(Date.now() + ttlSeconds * 1000);
}

function scopeTenantId({ tenantId, platform }) {
  return platform ? null : tenantId;
}

async function saveCacheEntry({ tenantId, realm, providerId, kind, key, value, ttlSeconds }) {
  const scopedTenantId = tenantId || null;
  await withIdentityScope(scopedTenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `INSERT INTO identity_saml_replay_cache (
          tenant_id, realm, provider_id, cache_kind, cache_key, cache_value, expires_at
        )
        VALUES ($1::uuid, $2, $3::bigint, $4, $5, $6, $7::timestamptz)
        ON CONFLICT (provider_id, cache_kind, cache_key)
        DO UPDATE SET cache_value = EXCLUDED.cache_value,
                      expires_at = EXCLUDED.expires_at`,
      scopedTenantId,
      realm,
      providerId,
      kind,
      key,
      value,
      replayExpiresAt(ttlSeconds),
    );
  });
}

async function getCacheEntry({ tenantId, realm, providerId, kind, key }) {
  const scopedTenantId = tenantId || null;
  return withIdentityScope(scopedTenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT cache_value
         FROM identity_saml_replay_cache
        WHERE provider_id = $1::bigint
          AND realm = $2
          AND cache_kind = $3
          AND cache_key = $4
          AND expires_at > NOW()
        LIMIT 1`,
      providerId,
      realm,
      kind,
      key,
    );
    return rows[0]?.cache_value || null;
  });
}

async function removeCacheEntry({ tenantId, realm, providerId, kind, key }) {
  const scopedTenantId = tenantId || null;
  return withIdentityScope(scopedTenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `DELETE FROM identity_saml_replay_cache
        WHERE provider_id = $1::bigint
          AND realm = $2
          AND cache_kind = $3
          AND cache_key = $4
        RETURNING cache_value`,
      providerId,
      realm,
      kind,
      key,
    );
    return rows[0]?.cache_value || null;
  });
}

function buildCacheProvider({ tenantId, realm, provider }) {
  const providerId = Number(provider.id);
  return {
    async saveAsync(key, value) {
      await saveCacheEntry({
        tenantId,
        realm,
        providerId,
        kind: 'request',
        key,
        value,
        ttlSeconds: SAML_REQUEST_TTL_SECONDS,
      });
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      if (!key) return null;
      return getCacheEntry({ tenantId, realm, providerId, kind: 'request', key });
    },
    async removeAsync(key) {
      if (!key) return null;
      return removeCacheEntry({ tenantId, realm, providerId, kind: 'request', key });
    },
  };
}

async function assertReplayKeyUnused({ tenantId, realm, provider, kind, key }) {
  const normalized = replayKey(key);
  if (!normalized) throw AppError.unauthorized('SSO assertion rejected', 'SSO_SAML_ID_MISSING');
  const scopedTenantId = tenantId || null;
  const rows = await withIdentityScope(scopedTenantId, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO identity_saml_replay_cache (
        tenant_id, realm, provider_id, cache_kind, cache_key, cache_value, expires_at
      )
      VALUES ($1::uuid, $2, $3::bigint, $4, $5, $5, $6::timestamptz)
      ON CONFLICT (provider_id, cache_kind, cache_key) DO NOTHING
      RETURNING id`,
    scopedTenantId,
    realm,
    provider.id,
    kind,
    normalized,
    replayExpiresAt(),
  ));
  if (!rows[0]) throw AppError.unauthorized('SSO assertion replay rejected', 'SSO_SAML_REPLAY');
}

function buildSamlClient({ tenantId, realm, provider }) {
  const idpCerts = decryptSamlJson(provider.saml_idp_signing_certs_ciphertext, []);
  if (!idpCerts.length) throw AppError.internal('SAML provider has no IdP signing certificates', 'SSO_PROVIDER_INCOMPLETE');
  const signingKey = decryptSamlField(provider.saml_signing_key_ciphertext);
  const signingCert = decryptSamlField(provider.saml_signing_cert_ciphertext);
  const decryptionKey = decryptSamlField(provider.saml_decryption_key_ciphertext);
  const config = {
    entryPoint: provider.saml_sso_url || undefined,
    issuer: provider.saml_sp_entity_id,
    callbackUrl: provider.saml_acs_url,
    audience: provider.saml_sp_entity_id,
    idpCert: idpCerts,
    identifierFormat: provider.saml_nameid_format || null,
    acceptedClockSkewMs: assertionClockSkewMs(),
    wantAuthnResponseSigned: Boolean(provider.saml_require_signed_response),
    wantAssertionsSigned: Boolean(provider.saml_require_signed_assertion),
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: SAML_REQUEST_TTL_SECONDS * 1000,
    cacheProvider: buildCacheProvider({ tenantId, realm, provider }),
    disableRequestedAuthnContext: Boolean(provider.policy?.disable_requested_authn_context),
    skipRequestCompression: Boolean(provider.policy?.skip_request_compression),
    authnRequestBinding: provider.policy?.authn_request_binding || 'HTTP-Redirect',
  };
  if (signingKey) {
    config.privateKey = signingKey;
    config.signatureAlgorithm = provider.policy?.signature_algorithm || 'sha256';
  }
  if (signingCert) config.publicCert = signingCert;
  if (decryptionKey) config.decryptionPvk = decryptionKey;
  return new SAML(config);
}

function validateProfile({ provider, responseInfo, assertionInfo, profile }) {
  if (responseInfo.responseIssuer && responseInfo.responseIssuer !== provider.saml_entity_id) {
    throw new Error('SAML response issuer mismatch');
  }
  if (responseInfo.destination && responseInfo.destination !== provider.saml_acs_url) {
    throw new Error('SAML response destination mismatch');
  }
  if (!assertionInfo.assertionIssuer || assertionInfo.assertionIssuer !== provider.saml_entity_id) {
    throw new Error('SAML assertion issuer mismatch');
  }
  if (!assertionInfo.recipients.includes(provider.saml_acs_url)) {
    throw new Error('SAML assertion recipient mismatch');
  }
  if (!profile?.nameID) throw new Error('SAML assertion missing NameID');
  if (provider.saml_nameid_format && profile.nameIDFormat !== provider.saml_nameid_format) {
    throw new Error('SAML NameID format mismatch');
  }
  validateRequiredClaims(provider.required_claims, profile);
  validateAllowedDomains(provider, profile);
}

function normalizedPrincipal({ provider, profile, relayState }) {
  const email = normalizeEmail(claimValue(profile, [
    'email',
    'mail',
    'urn:oid:0.9.2342.19200300.100.1.3',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  ]));
  return {
    issuer: String(profile.issuer || ''),
    subject: String(profile.nameID || ''),
    nameIdFormat: profile.nameIDFormat || null,
    email,
    groups: extractGroups(provider, profile),
    employeeId: employeeIdFromProfile(provider, profile),
    sessionIndex: profile.sessionIndex || null,
    attributes: profile.attributes || {},
    relayState,
  };
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

async function mapStaffRole({ tenantId, provider, groups }) {
  if (!groups.length) throw AppError.unauthorized('SSO role mapping failed', 'SSO_ROLE_MAPPING_FAILED');
  const lowerGroups = groups.map((group) => group.toLowerCase());
  const rows = await withIdentityScope(tenantId, (tx) => tx.$queryRawUnsafe(
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
  return withIdentityScope(tenantId, async (tx) => {
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

async function createStaffSsoRefreshSession({ tenantId, staff, refreshToken, req, deviceId = null }) {
  const maxSessions = Number.parseInt(process.env.MAX_STAFF_SESSIONS || '3', 10);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  const sessionHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const ssoDeviceId = deviceId || `sso-saml-${crypto.randomUUID()}`;

  await withIdentityScope(tenantId, async (tx) => {
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

async function resolveSamlContext({ req, realm, providerKey }) {
  const key = validateProviderKey(providerKey);
  if (realm === 'admin') {
    const tenant = await resolveAdminSsoTenant(req);
    const provider = await getSamlProvider({
      tenantId: tenant.tenantId,
      realm,
      platform: tenant.isPlatform,
      providerKey: key,
      activeOnly: true,
    });
    return { key, tenant, provider };
  }

  const tenantId = await resolveTenantForRequest(req);
  const tenant = { tenantId, isPlatform: false };
  const provider = await getSamlProvider({
    tenantId,
    realm,
    platform: false,
    providerKey: key,
    activeOnly: true,
  });
  return { key, tenant, provider };
}

export async function discoverAdminSamlProvidersForRequest(req) {
  const tenant = await resolveAdminSsoTenant(req);
  const rows = await listSamlProviders({
    tenantId: tenant.tenantId,
    realm: 'admin',
    platform: tenant.isPlatform,
    status: 'active',
  });
  return {
    tenant: { id: tenant.tenantId, slug: tenant.tenantSlug, platform: tenant.isPlatform },
    providers: rows.map((row) => ({
      provider_key: row.provider_key,
      display_name: row.display_name,
      start_url: `/api/v1/auth/admin/sso/saml/${encodeURIComponent(row.provider_key)}/start`,
      acs_url: row.saml_acs_url,
    })),
  };
}

export async function discoverStaffSamlProvidersForRequest(req) {
  const tenantId = await resolveTenantForRequest(req);
  const rows = await listSamlProviders({
    tenantId,
    realm: 'staff',
    platform: false,
    status: 'active',
  });
  return {
    tenant: { id: tenantId },
    providers: rows.map((row) => ({
      provider_key: row.provider_key,
      display_name: row.display_name,
      start_url: `/api/v1/auth/staff/sso/saml/${encodeURIComponent(row.provider_key)}/start`,
      acs_url: row.saml_acs_url,
    })),
  };
}

export async function startSamlLogin({ req, realm, providerKey }) {
  const { key, tenant, provider } = await resolveSamlContext({ req, realm, providerKey });
  const tenantId = scopeTenantId({ tenantId: tenant.tenantId, platform: tenant.isPlatform });
  const client = buildSamlClient({ tenantId, realm, provider });
  const relayState = relayStateFor({ realm, tenant, provider, providerKey: key, req });
  const redirectUrl = await client.getAuthorizeUrlAsync(relayState, requestHost(req), {});

  await recordSamlIdentityAuditEvent({
    tenantId,
    realm,
    provider,
    eventType: 'SSO_START',
    outcome: 'started',
    state: relayState,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      acs_url_hash: hashValue(provider.saml_acs_url),
      requested_acs_url_hash: hashValue(callbackUrlFor(req, realm, key)),
      binding: provider.policy?.authn_request_binding || 'HTTP-Redirect',
    },
  });

  return { redirectUrl, relayState };
}

export async function validateSamlAcs({ req, realm, providerKey }) {
  const { key, tenant, provider } = await resolveSamlContext({ req, realm, providerKey });
  const tenantId = scopeTenantId({ tenantId: tenant.tenantId, platform: tenant.isPlatform });
  const relayStateRaw = req?.body?.RelayState || req?.body?.relayState || req?.query?.RelayState;
  let relayState = null;
  try {
    relayState = parseRelayState(relayStateRaw, { realm, providerKey: key, tenant, provider });
  } catch (err) {
    await recordSamlIdentityAuditEvent({
      tenantId,
      realm,
      provider,
      eventType: 'SSO_ASSERTION_DENIED',
      outcome: 'denied',
      state: relayStateRaw,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: { reason: err.code || 'relay_state_invalid' },
    });
    throw err;
  }

  const samlResponse = req?.body?.SAMLResponse || req?.body?.samlResponse;
  let responseXml;
  let responseInfo;
  let profile;
  try {
    responseXml = normalizeSamlResponseInput(samlResponse);
    responseInfo = await inspectResponseXml(responseXml);
    const client = buildSamlClient({ tenantId, realm, provider });
    const result = await client.validatePostResponseAsync({ SAMLResponse: samlResponse });
    profile = result.profile;
    if (!profile || result.loggedOut) throw new Error('SAML response did not contain a login assertion');
    const assertionInfo = await inspectAssertionXml(profile.getAssertionXml?.());
    validateProfile({ provider, responseInfo, assertionInfo, profile });
    await assertReplayKeyUnused({ tenantId, realm, provider, kind: 'response', key: responseInfo.responseId });
    await assertReplayKeyUnused({ tenantId, realm, provider, kind: 'assertion', key: assertionInfo.assertionId });
  } catch (err) {
    await recordSamlIdentityAuditEvent({
      tenantId,
      realm,
      provider,
      eventType: 'SSO_ASSERTION_DENIED',
      outcome: 'denied',
      state: relayStateRaw,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: {
        reason: err.code || 'assertion_validation_failed',
        error: err.message,
        response_id_hash: hashValue(responseInfo?.responseId),
        in_response_to_hash: hashValue(responseInfo?.inResponseTo),
      },
    });
    if (err instanceof AppError) throw err;
    throw AppError.unauthorized('SSO assertion rejected', 'SSO_ASSERTION_REJECTED');
  }

  const principal = normalizedPrincipal({ provider, profile, relayState });
  return {
    tenant,
    tenantId,
    realm,
    provider,
    relayState,
    principal,
    assertion: {
      responseId: responseInfo.responseId,
      inResponseTo: responseInfo.inResponseTo,
      responseXml,
      assertionXml: profile.getAssertionXml?.() || null,
      encrypted: responseInfo.encryptedAssertionCount > 0,
    },
  };
}

async function completeAdminSamlAcs({ validation, req }) {
  const { tenant, tenantId, provider, principal, assertion } = validation;
  let mappedRole;
  try {
    mappedRole = await mapAdminRole({
      tenantId,
      platform: Boolean(tenant.isPlatform),
      provider,
      groups: principal.groups,
    });
  } catch (err) {
    await recordSamlIdentityAuditEvent({
      tenantId,
      realm: 'admin',
      provider,
      eventType: 'SSO_ROLE_MAPPING_FAILED',
      outcome: 'denied',
      issuer: principal.issuer,
      subject: principal.subject,
      assertion: assertion.assertionXml || assertion.responseXml,
      state: req?.body?.RelayState || req?.body?.relayState || null,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: {
        reason: err.code || 'mapping_failed',
        group_count: principal.groups.length,
        group_hashes: principal.groups.map(hashValue),
      },
    });
    throw err;
  }

  let admin;
  try {
    admin = await resolveOrLinkAdmin({
      tenantId,
      platform: Boolean(tenant.isPlatform),
      provider,
      issuer: principal.issuer,
      subject: principal.subject,
      email: principal.email,
      mappedRole,
    });
  } catch (err) {
    await recordSamlIdentityAuditEvent({
      tenantId,
      realm: 'admin',
      provider,
      eventType: 'SSO_LOCAL_IDENTITY_LINK_FAILED',
      outcome: 'denied',
      issuer: principal.issuer,
      subject: principal.subject,
      assertion: assertion.assertionXml || assertion.responseXml,
      state: req?.body?.RelayState || req?.body?.relayState || null,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: { reason: err.code || 'local_identity_not_found', email_hash: hashValue(principal.email) },
    });
    throw err;
  }

  await withIdentityScope(tenant.isPlatform ? null : tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE admins
        SET last_login = NOW(), failed_login_attempts = 0, updated_at = NOW()
      WHERE uid = $1::uuid`,
    admin.uid,
  ));

  await recordSamlIdentityAuditEvent({
    tenantId,
    realm: 'admin',
    provider,
    eventType: 'SSO_ASSERTION_ACCEPTED',
    outcome: 'accepted',
    localUid: admin.uid,
    issuer: principal.issuer,
    subject: principal.subject,
    assertion: assertion.assertionXml || assertion.responseXml,
    state: req?.body?.RelayState || req?.body?.relayState || null,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      mapped_role: mappedRole,
      assurance: {
        name_id_format: principal.nameIdFormat,
        encrypted_assertion: Boolean(assertion.encrypted),
      },
      idp_session_hash: hashValue(principal.sessionIndex),
      email_hash: hashValue(principal.email),
    },
  });

  const tenantIdForToken = tenant.isPlatform ? undefined : tenantId;
  const { accessToken: token } = await issueAccessTokenAndClaimSession({
    userUid: admin.uid,
    tokenPayload: {
      uid: admin.uid,
      role: mappedRole,
      email: admin.email ?? principal.email ?? undefined,
      sub: admin.uid,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCES.admin,
      ...(tenantIdForToken ? { tenant_id: tenantIdForToken } : {}),
    },
    expiresIn: SECURITY_CONFIG.jwt.adminExpiry,
    deviceType: validation.relayState?.deviceType || 'web',
    req,
  });
  const refreshToken = await generateRefreshToken({ uid: admin.uid, role: mappedRole });
  return {
    token,
    refreshToken,
    admin: {
      uid: admin.uid,
      username: admin.username,
      email: admin.email,
      name: admin.name,
      role: mappedRole,
    },
    returnTo: validation.relayState?.returnTo || '/dashboard',
    adminHost: validation.relayState?.adminHost || tenant.host || requestHost(req),
  };
}

async function completeStaffSamlAcs({ validation, req }) {
  const { tenantId, provider, principal, assertion } = validation;
  let mappedRole;
  try {
    mappedRole = await mapStaffRole({
      tenantId,
      provider,
      groups: principal.groups,
    });
  } catch (err) {
    await recordSamlIdentityAuditEvent({
      tenantId,
      realm: 'staff',
      provider,
      eventType: 'SSO_ROLE_MAPPING_FAILED',
      outcome: 'denied',
      issuer: principal.issuer,
      subject: principal.subject,
      assertion: assertion.assertionXml || assertion.responseXml,
      state: req?.body?.RelayState || req?.body?.relayState || null,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: {
        reason: err.code || 'mapping_failed',
        group_count: principal.groups.length,
        group_hashes: principal.groups.map(hashValue),
      },
    });
    throw err;
  }

  let linkResult;
  try {
    linkResult = await resolveOrLinkStaff({
      tenantId,
      provider,
      issuer: principal.issuer,
      subject: principal.subject,
      email: principal.email,
      employeeId: principal.employeeId,
      mappedRole,
    });
  } catch (err) {
    await recordSamlIdentityAuditEvent({
      tenantId,
      realm: 'staff',
      provider,
      eventType: 'SSO_LOCAL_IDENTITY_LINK_FAILED',
      outcome: 'denied',
      issuer: principal.issuer,
      subject: principal.subject,
      assertion: assertion.assertionXml || assertion.responseXml,
      state: req?.body?.RelayState || req?.body?.relayState || null,
      requestId: req?.id,
      ipAddress: req?.ip,
      userAgent: req?.headers?.['user-agent'],
      details: {
        reason: err.code || 'local_identity_not_found',
        email_hash: hashValue(principal.email),
        employee_id_hash: hashValue(principal.employeeId),
      },
    });
    throw err;
  }

  const staff = linkResult.staff;
  await withIdentityScope(tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE users
        SET last_sign_in_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2::uuid`,
    staff.id,
    tenantId,
  ));

  await recordSamlIdentityAuditEvent({
    tenantId,
    realm: 'staff',
    provider,
    eventType: 'SSO_ASSERTION_ACCEPTED',
    outcome: 'accepted',
    localUid: staff.uid,
    issuer: principal.issuer,
    subject: principal.subject,
    assertion: assertion.assertionXml || assertion.responseXml,
    state: req?.body?.RelayState || req?.body?.relayState || null,
    requestId: req?.id,
    ipAddress: req?.ip,
    userAgent: req?.headers?.['user-agent'],
    details: {
      mapped_role: mappedRole,
      matched_claim: linkResult.matchedClaim,
      assurance: {
        name_id_format: principal.nameIdFormat,
        encrypted_assertion: Boolean(assertion.encrypted),
      },
      idp_session_hash: hashValue(principal.sessionIndex),
      email_hash: hashValue(principal.email),
      employee_id_hash: hashValue(principal.employeeId),
    },
  });

  const stableDeviceId = await StaffAuthService.bindStaffInstallation(
    staff,
    validation.relayState?.deviceId,
    { platform: validation.relayState?.deviceType || deviceTypeFrom(req, 'mobile') },
  );
  const { accessToken } = await issueAccessTokenAndClaimSession({
    userUid: staff.uid,
    tokenPayload: {
      id: staff.id,
      uid: staff.uid,
      role: mappedRole,
      tenant_id: tenantId,
    },
    expiresIn: SECURITY_CONFIG.jwt.staffAccessExpiry,
    deviceType: validation.relayState?.deviceType || deviceTypeFrom(req, 'mobile'),
    stableDeviceId,
    req,
  });
  const refreshToken = await StaffAuthService.generateRefreshToken(staff, stableDeviceId);
  await createStaffSsoRefreshSession({
    tenantId,
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

export async function completeSamlAcs({ req, realm, providerKey }) {
  const validation = await validateSamlAcs({ req, realm, providerKey });
  if (realm === 'admin') return completeAdminSamlAcs({ validation, req });
  if (realm === 'staff') return completeStaffSamlAcs({ validation, req });
  throw AppError.badRequest('Invalid SSO realm', 'SSO_REALM_INVALID');
}
