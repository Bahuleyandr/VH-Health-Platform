/**
 * SMART-on-FHIR OAuth service (Phase D3).
 *
 * Implements the SMART App Launch v1.0 / v2.0 minimum surface:
 *   - App registry with allowed_scopes + redirect_uris (smart_apps)
 *   - Authorization code grant w/ PKCE (smart_authz_codes)
 *   - Access + refresh tokens with FHIR resource scopes
 *     (smart_access_tokens)
 *
 * Decision-support only: this service issues + verifies tokens. The
 * existing JWT + RBAC stack handles user-facing auth; SMART tokens
 * gate the FHIR resource surface for third-party apps.
 *
 * Scopes follow the SMART syntax:
 *   patient/<Resource>.read          (patient-context, single resource read)
 *   patient/<Resource>.read|write|*  (read/write/all)
 *   user/<Resource>.read             (user-context, full org access)
 *   system/<Resource>.read           (backend-service grant)
 *   launch                           (EHR launch)
 *   launch/patient                   (patient context request)
 *   launch/encounter                 (encounter context request)
 *   openid / profile / fhirUser      (OIDC identity)
 *   offline_access                   (refresh token allowed)
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField } from '../../utils/fieldEncryption.js';
import { requireTenantId } from '../tenant/tenantService.js';

const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const ACCESS_TTL_SECONDS = 60 * 60;          // 1h
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 90; // 90d
const AUTHZ_CODE_TTL_SECONDS = 60 * 5;        // 5m

export const APP_KINDS = ['public', 'confidential', 'backend_service'];
export const APP_STATUSES = ['active', 'paused', 'revoked', 'archived'];
export const FHIR_VERSIONS = ['DSTU2', 'STU3', 'R4', 'R4B', 'R5'];
export const ENVIRONMENTS = ['sandbox', 'production'];
export const PKCE_METHODS = ['S256', 'plain'];
export const AUTHZ_STATUSES = ['pending', 'consumed', 'expired', 'revoked'];
export const TOKEN_STATUSES = ['active', 'revoked', 'expired', 'rotated'];

const FHIR_RESOURCE_RE = /^[A-Z][A-Za-z]+$/;
const SMART_SCOPE_RE = /^(patient|user|system)\/([A-Za-z*]+)\.(read|write|\*)$/;

/**
 * Parse a single SMART scope string into structured form, or null if
 * it's a non-resource scope (launch, openid, etc.).
 */
export function parseSmartScope(scope) {
  if (!scope || typeof scope !== 'string') return null;
  const text = scope.trim();
  const m = SMART_SCOPE_RE.exec(text);
  if (!m) return null;
  const [, level, resource, op] = m;
  if (resource !== '*' && !FHIR_RESOURCE_RE.test(resource)) return null;
  return { level, resource, operation: op };
}

/**
 * Resolve granted scopes by intersecting requested with the app's
 * allowed_scopes. Non-resource scopes (launch, openid, profile,
 * fhirUser, offline_access) pass through if explicitly allowed.
 */
export function resolveScopes(requested, allowed) {
  const allowedSet = new Set((allowed || []).map((s) => String(s).trim()));
  const out = [];
  for (const raw of requested || []) {
    const text = String(raw).trim();
    if (!text) continue;
    if (allowedSet.has(text)) {
      out.push(text);
      continue;
    }
    // Wildcard match: allowed has e.g. "patient/*.read" and requested
    // is "patient/Observation.read".
    const reqParsed = parseSmartScope(text);
    if (!reqParsed) continue;
    let matched = false;
    for (const allow of allowedSet) {
      const allowParsed = parseSmartScope(allow);
      if (!allowParsed) continue;
      if (allowParsed.level !== reqParsed.level) continue;
      if (allowParsed.resource !== '*' && allowParsed.resource !== reqParsed.resource) continue;
      if (allowParsed.operation !== '*' && allowParsed.operation !== reqParsed.operation) continue;
      matched = true; break;
    }
    if (matched) out.push(text);
  }
  return out;
}

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeStringArray(value, label, { max = 200 } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array of strings`);
  if (value.length > max) throw AppError.badRequest(`${label} max length is ${max}`);
  return value.map((v) => safeText(v, 255)).filter(Boolean);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function envOrDefault(value) {
  return normalizeEnum(value, ENVIRONMENTS, 'environment') || 'sandbox';
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(`vh-smart:${value}`).digest('hex');
}

function generateRandomToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// smart_apps
// ---------------------------------------------------------------------------

const APP_RETURNING = `id, tenant_id, client_id, display_name, description,
  app_kind, redirect_uris, allowed_scopes, launch_uri, jwks_url,
  fhir_version, status, environment, metadata, created_by, created_at, updated_at`;

export async function registerSmartApp({
  tenantId = null,
  clientId,
  displayName,
  description = null,
  appKind = 'public',
  redirectUris = [],
  allowedScopes = [],
  launchUri = null,
  jwksUrl = null,
  fhirVersion = 'R4',
  status = 'active',
  environment = 'sandbox',
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanClient = safeText(clientId, 120);
  if (!cleanClient) throw AppError.badRequest('client_id is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const kind = normalizeEnum(appKind, APP_KINDS, 'app_kind') || 'public';
  const uris = normalizeStringArray(redirectUris, 'redirect_uris', { max: 50 });
  if (kind !== 'backend_service' && uris.length === 0) {
    throw AppError.badRequest('redirect_uris must include at least one URI for non-backend apps');
  }
  // Generate + hash a client secret only for confidential apps.
  let plaintextSecret = null;
  let secretCipher = null;
  let secretHash = null;
  if (kind === 'confidential') {
    plaintextSecret = `vh_smart_${generateRandomToken(32)}`;
    secretCipher = encryptField(plaintextSecret);
    secretHash = hashSecret(plaintextSecret);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO smart_apps
         (tenant_id, client_id, display_name, description, app_kind,
          redirect_uris, allowed_scopes, launch_uri, jwks_url,
          client_secret_ciphertext, client_secret_hash,
          fhir_version, status, environment, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5,
         $6::text[], $7::text[], $8, $9, $10, $11,
         $12, $13, $14, $15::jsonb, $16::uuid)
       RETURNING ${APP_RETURNING}`,
      tid, cleanClient, cleanName, safeText(description), kind,
      uris,
      normalizeStringArray(allowedScopes, 'allowed_scopes'),
      safeText(launchUri),
      safeText(jwksUrl),
      secretCipher, secretHash,
      normalizeEnum(fhirVersion, FHIR_VERSIONS, 'fhir_version') || 'R4',
      normalizeEnum(status, APP_STATUSES, 'status') || 'active',
      envOrDefault(environment),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return { app: rows[0], plaintext_client_secret: plaintextSecret };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(`client_id already exists for this tenant + environment`);
    }
    throw err;
  }
}

export async function listSmartApps({
  tenantId = null, environment = null, status = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (environment) {
    params.push(envOrDefault(environment));
    filters.push(`environment = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, APP_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${APP_RETURNING} FROM smart_apps
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name`,
      ...params,
    );
    return { apps: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { apps: [], count: 0 };
    throw err;
  }
}

async function findActiveAppByClientId({ tenantId, clientId, environment }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, client_id, app_kind, redirect_uris, allowed_scopes,
            client_secret_hash, status, environment, fhir_version
     FROM smart_apps
     WHERE tenant_id = $1::uuid AND client_id = $2 AND environment = $3
     LIMIT 1`,
    tenantId, clientId, environment,
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Authorization code grant
// ---------------------------------------------------------------------------

const AUTHZ_RETURNING = `id, tenant_id, smart_app_id, redirect_uri,
  requested_scopes, granted_scopes, patient_uid, encounter_id, user_uid, user_role,
  pkce_code_challenge, pkce_method, state, status,
  expires_at, consumed_at, environment, metadata, created_at`;

export async function issueAuthorizationCode({
  tenantId = null,
  clientId,
  redirectUri,
  requestedScopes,
  patientUid = null,
  encounterId = null,
  userUid = null,
  userRole = null,
  pkceCodeChallenge = null,
  pkceMethod = null,
  state = null,
  environment = 'sandbox',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const env = envOrDefault(environment);
  const cleanRedirect = safeText(redirectUri, 1000);
  if (!cleanRedirect) throw AppError.badRequest('redirect_uri is required');
  const cleanScopes = normalizeStringArray(requestedScopes, 'requested_scopes');
  if (cleanScopes.length === 0) throw AppError.badRequest('requested_scopes must be non-empty');

  const app = await findActiveAppByClientId({ tenantId: tid, clientId: safeText(clientId, 120), environment: env });
  if (!app) throw AppError.notFound('SMART app not found');
  if (app.status !== 'active') throw AppError.badRequest(`App status is ${app.status}, not active`);
  if (!app.redirect_uris.some((uri) => uri === cleanRedirect)) {
    throw AppError.badRequest('redirect_uri is not registered for this app');
  }

  const granted = resolveScopes(cleanScopes, app.allowed_scopes);
  if (granted.length === 0) {
    throw AppError.forbidden('No requested scopes are allowed for this app');
  }

  const codePlaintext = `vh_authz_${generateRandomToken(32)}`;
  const codeHash = hashSecret(codePlaintext);
  const cleanPkceMethod = normalizeEnum(pkceMethod, PKCE_METHODS, 'pkce_method');
  if (app.app_kind === 'public' && !pkceCodeChallenge) {
    throw AppError.badRequest('PKCE code_challenge is required for public clients');
  }
  const expiresAt = new Date(Date.now() + AUTHZ_CODE_TTL_SECONDS * 1000);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO smart_authz_codes
       (tenant_id, smart_app_id, code_hash, redirect_uri,
        requested_scopes, granted_scopes,
        patient_uid, encounter_id, user_uid, user_role,
        pkce_code_challenge, pkce_method, state, status, expires_at, environment, metadata)
     VALUES ($1::uuid, $2, $3, $4,
       $5::text[], $6::text[],
       $7::uuid, $8, $9::uuid, $10,
       $11, $12, $13, 'pending', $14::timestamptz, $15, $16::jsonb)
     RETURNING ${AUTHZ_RETURNING}`,
    tid, app.id, codeHash, cleanRedirect,
    cleanScopes, granted,
    maybeUuid(patientUid, 'patient_uid'),
    encounterId ? normalizeId(encounterId, 'encounter_id') : null,
    maybeUuid(userUid, 'user_uid'),
    safeText(userRole, 80),
    safeText(pkceCodeChallenge, 255),
    cleanPkceMethod,
    safeText(state, 255),
    expiresAt.toISOString(), env,
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return { plaintext_code: codePlaintext, authz: rows[0] };
}

/**
 * Verify a PKCE code_verifier against the stored challenge.
 */
function verifyPkce({ codeVerifier, challenge, method }) {
  if (!challenge) return true; // no PKCE on confidential clients
  if (!codeVerifier) return false;
  if (method === 'plain') {
    return timingSafeStringEqual(codeVerifier, challenge);
  }
  // S256 default
  const computed = crypto.createHash('sha256').update(String(codeVerifier)).digest('base64url');
  return timingSafeStringEqual(computed, challenge);
}

/**
 * Token endpoint — exchange code + (optional) client_secret + PKCE
 * code_verifier for access + (if scope includes offline_access) refresh
 * tokens. Atomically marks the authz code consumed; replay returns
 * unauthorized.
 */
export async function exchangeAuthorizationCode({
  tenantId = null,
  clientId,
  clientSecret = null,
  code,
  redirectUri,
  codeVerifier = null,
  environment = 'sandbox',
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const env = envOrDefault(environment);
  const app = await findActiveAppByClientId({
    tenantId: tid, clientId: safeText(clientId, 120), environment: env,
  });
  if (!app) throw AppError.unauthorized('Invalid client_id');
  if (app.status !== 'active') throw AppError.unauthorized(`App status is ${app.status}`);
  if (app.app_kind === 'confidential') {
    if (!clientSecret || !app.client_secret_hash) {
      throw AppError.unauthorized('client_secret required for confidential app');
    }
    if (!timingSafeStringEqual(hashSecret(clientSecret), app.client_secret_hash)) {
      throw AppError.unauthorized('Invalid client_secret');
    }
  }
  const codeHash = hashSecret(safeText(code, 1024) || '');
  // Atomic check-and-consume: WHERE status='pending' guards replay.
  const codeRows = await prisma.$queryRawUnsafe(
    `UPDATE smart_authz_codes
     SET status = 'consumed', consumed_at = NOW()
     WHERE tenant_id = $1::uuid AND code_hash = $2 AND status = 'pending'
       AND expires_at > NOW()
     RETURNING ${AUTHZ_RETURNING}`,
    tid, codeHash,
  );
  if (!codeRows[0]) throw AppError.unauthorized('Invalid or expired authorization code');
  const authz = codeRows[0];
  if (authz.smart_app_id !== app.id) throw AppError.unauthorized('client_id does not match authorization code');
  if (authz.redirect_uri !== safeText(redirectUri, 1000)) {
    throw AppError.unauthorized('redirect_uri mismatch');
  }
  if (!verifyPkce({
    codeVerifier, challenge: authz.pkce_code_challenge, method: authz.pkce_method || 'S256',
  })) {
    throw AppError.unauthorized('PKCE verification failed');
  }

  // Issue tokens.
  const accessPlain = `vh_access_${generateRandomToken(40)}`;
  const includeRefresh = (authz.granted_scopes || []).includes('offline_access');
  const refreshPlain = includeRefresh ? `vh_refresh_${generateRandomToken(40)}` : null;
  const accessExp = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);
  const refreshExp = refreshPlain ? new Date(Date.now() + REFRESH_TTL_SECONDS * 1000) : null;

  const tokenRows = await prisma.$queryRawUnsafe(
    `INSERT INTO smart_access_tokens
       (tenant_id, smart_app_id, authz_code_id,
        access_token_hash, refresh_token_hash, granted_scopes,
        patient_uid, encounter_id, user_uid, user_role, status,
        access_expires_at, refresh_expires_at, environment)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::text[],
       $7::uuid, $8, $9::uuid, $10, 'active',
       $11::timestamptz, $12::timestamptz, $13)
     RETURNING id, granted_scopes, access_expires_at, refresh_expires_at,
               patient_uid, encounter_id, user_uid, user_role, environment`,
    tid, app.id, authz.id,
    hashSecret(accessPlain),
    refreshPlain ? hashSecret(refreshPlain) : null,
    authz.granted_scopes,
    authz.patient_uid, authz.encounter_id, authz.user_uid, authz.user_role,
    accessExp.toISOString(),
    refreshExp ? refreshExp.toISOString() : null,
    env,
  );
  return {
    access_token: accessPlain,
    refresh_token: refreshPlain,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    scope: (authz.granted_scopes || []).join(' '),
    patient: authz.patient_uid,
    encounter: authz.encounter_id,
    record: tokenRows[0],
  };
}

/**
 * Refresh-token grant. Issues a new access token and rotates the
 * refresh token (parent_token_id pointer) so the old one is single-use.
 */
export async function refreshAccessToken({
  tenantId = null,
  clientId,
  clientSecret = null,
  refreshToken,
  environment = 'sandbox',
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const env = envOrDefault(environment);
  const app = await findActiveAppByClientId({
    tenantId: tid, clientId: safeText(clientId, 120), environment: env,
  });
  if (!app) throw AppError.unauthorized('Invalid client_id');
  if (app.app_kind === 'confidential') {
    if (!clientSecret || !timingSafeStringEqual(hashSecret(clientSecret), app.client_secret_hash || '')) {
      throw AppError.unauthorized('Invalid client_secret');
    }
  }
  const refreshHash = hashSecret(safeText(refreshToken, 1024) || '');
  const tokenRows = await prisma.$queryRawUnsafe(
    `UPDATE smart_access_tokens
     SET status = 'rotated', updated_at = NOW()
     WHERE tenant_id = $1::uuid AND smart_app_id = $2
       AND refresh_token_hash = $3 AND status = 'active'
       AND (refresh_expires_at IS NULL OR refresh_expires_at > NOW())
     RETURNING id, granted_scopes, patient_uid, encounter_id, user_uid, user_role,
               refresh_expires_at`,
    tid, app.id, refreshHash,
  );
  if (!tokenRows[0]) throw AppError.unauthorized('Invalid or expired refresh token');
  const parent = tokenRows[0];
  // Issue new access + refresh.
  const accessPlain = `vh_access_${generateRandomToken(40)}`;
  const refreshPlain = `vh_refresh_${generateRandomToken(40)}`;
  const accessExp = new Date(Date.now() + ACCESS_TTL_SECONDS * 1000);
  const refreshExp = parent.refresh_expires_at ? new Date(parent.refresh_expires_at) : new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  const newRows = await prisma.$queryRawUnsafe(
    `INSERT INTO smart_access_tokens
       (tenant_id, smart_app_id, parent_token_id, access_token_hash, refresh_token_hash,
        granted_scopes, patient_uid, encounter_id, user_uid, user_role, status,
        access_expires_at, refresh_expires_at, environment)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::text[], $7::uuid, $8, $9::uuid, $10, 'active',
       $11::timestamptz, $12::timestamptz, $13)
     RETURNING id, access_expires_at, refresh_expires_at`,
    tid, app.id, parent.id,
    hashSecret(accessPlain), hashSecret(refreshPlain),
    parent.granted_scopes,
    parent.patient_uid, parent.encounter_id, parent.user_uid, parent.user_role,
    accessExp.toISOString(), refreshExp.toISOString(),
    env,
  );
  return {
    access_token: accessPlain,
    refresh_token: refreshPlain,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    scope: (parent.granted_scopes || []).join(' '),
    record: newRows[0],
  };
}

/**
 * Verify an access token at a FHIR resource boundary. Returns the
 * token row + parent app if valid, null otherwise.
 */
export async function verifyAccessToken({
  tenantId = null,
  accessToken,
  environment = 'sandbox',
  ipAddress = null,
} = {}) {
  if (!accessToken) return null;
  const tid = resolveTenantId({ tenantId });
  const env = envOrDefault(environment);
  const accessHash = hashSecret(String(accessToken).trim());
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT t.id, t.smart_app_id, t.granted_scopes, t.patient_uid, t.encounter_id,
              t.user_uid, t.user_role, t.access_expires_at, t.environment,
              a.client_id, a.app_kind, a.status AS app_status, a.fhir_version
       FROM smart_access_tokens t
       JOIN smart_apps a ON a.id = t.smart_app_id AND a.tenant_id = t.tenant_id
       WHERE t.tenant_id = $1::uuid AND t.access_token_hash = $2 AND t.environment = $3
         AND t.status = 'active' AND t.access_expires_at > NOW()
         AND a.status = 'active'
       LIMIT 1`,
      tid, accessHash, env,
    );
    if (!rows[0]) return null;
    await prisma.$queryRawUnsafe(
      `UPDATE smart_access_tokens
       SET last_used_at = NOW(), last_used_ip = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      safeText(ipAddress, 64), rows[0].id, tid,
    );
    return rows[0];
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * Check whether the granted scopes permit the requested operation.
 *   resource: 'Patient' | 'Observation' | etc.
 *   operation: 'read' | 'write'
 */
export function scopesAllow(grantedScopes, { level = 'patient', resource, operation = 'read' } = {}) {
  if (!Array.isArray(grantedScopes) || !resource) return false;
  for (const scope of grantedScopes) {
    const parsed = parseSmartScope(scope);
    if (!parsed) continue;
    if (parsed.level !== level) continue;
    if (parsed.resource !== '*' && parsed.resource !== resource) continue;
    if (parsed.operation !== '*' && parsed.operation !== operation) continue;
    return true;
  }
  return false;
}

export async function revokeAccessToken({
  tenantId = null, id, revokedReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const tokenId = normalizeId(id, 'access_token id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE smart_access_tokens
     SET status = 'revoked', revoked_at = NOW(), revoked_reason = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status = 'active'
     RETURNING id, status, revoked_at`,
    safeText(revokedReason), tokenId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Active access token not found');
  return rows[0];
}

export async function listAccessTokens({
  tenantId = null, smartAppId = null, status = null, limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (smartAppId) {
    params.push(normalizeId(smartAppId, 'smart_app_id'));
    filters.push(`smart_app_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, TOKEN_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, smart_app_id, granted_scopes, status,
              issued_at, access_expires_at, refresh_expires_at,
              last_used_at, last_used_ip, environment
       FROM smart_access_tokens
       WHERE ${filters.join(' AND ')}
       ORDER BY issued_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { tokens: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tokens: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  parseSmartScope,
  resolveScopes,
  scopesAllow,
  hashSecret,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  AUTHZ_CODE_TTL_SECONDS,
};

export default {
  registerSmartApp,
  listSmartApps,
  issueAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  verifyAccessToken,
  scopesAllow,
  revokeAccessToken,
  listAccessTokens,
  parseSmartScope,
  resolveScopes,
};
