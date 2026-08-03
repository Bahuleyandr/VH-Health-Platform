import bcrypt from 'bcrypt';
import crypto from 'crypto';

import { setTenant } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField } from '../../utils/fieldEncryption.js';
import { ALL_STAFF_ROLES } from '../../utils/roleHelpers.js';
import { revokeAllUserTokens } from '../../utils/tokenBlacklist.js';
import { getTenantBySlug } from '../tenant/tenantService.js';

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const STAFF_REALM_ROLES = new Set(ALL_STAFF_ROLES);
const ADMIN_REALM_ROLES = new Set(['ADMIN']);
const DUMMY_TOKEN_HASH = '0'.repeat(64);
const RANDOM_DISABLED_PASSWORD = () => `scim:${crypto.randomUUID()}:${crypto.randomBytes(16).toString('hex')}`;

function validateProviderKey(providerKey) {
  const key = String(providerKey || '').trim().toLowerCase();
  if (!PROVIDER_KEY_RE.test(key)) throw AppError.badRequest('Invalid SCIM provider key', 'SCIM_PROVIDER_KEY_INVALID');
  return key;
}

function validateTenantSlug(slug) {
  const value = String(slug || '').trim().toLowerCase();
  if (!TENANT_SLUG_RE.test(value)) throw AppError.badRequest('Invalid tenant slug', 'SCIM_TENANT_SLUG_INVALID');
  return value;
}

function intEnv(name, defaultValue, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

function maxPageSize() {
  return intEnv('SSO_SCIM_MAX_PAGE_SIZE', 100, 1, 500);
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeHashEqual(suppliedHash, storedHash) {
  const stored = /^[a-f0-9]{64}$/.test(String(storedHash || '')) ? String(storedHash) : DUMMY_TOKEN_HASH;
  const left = Buffer.from(String(suppliedHash || DUMMY_TOKEN_HASH), 'hex');
  const right = Buffer.from(stored, 'hex');
  return crypto.timingSafeEqual(left, right) && stored !== DUMMY_TOKEN_HASH;
}

function bearerToken(req) {
  const header = String(req?.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireScimToken(req) {
  const token = bearerToken(req);
  if (!token) throw AppError.unauthorized('Missing SCIM bearer token', 'SCIM_TOKEN_MISSING');
  return token;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

function cleanText(value, max = 255) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
}

function boolFromScim(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() !== 'false';
}

function groupNames(groups = []) {
  if (!Array.isArray(groups)) return [];
  return [...new Set(groups
    .map((group) => cleanText(group?.value || group?.display || group, 300))
    .filter(Boolean))];
}

function parseName(payload = {}) {
  const name = payload.name && typeof payload.name === 'object' ? payload.name : {};
  const formatted = cleanText(name.formatted || payload.displayName || payload.name);
  return {
    formatted,
    givenName: cleanText(name.givenName, 120),
    familyName: cleanText(name.familyName, 120),
  };
}

function displayNameFromPayload(payload = {}) {
  const parsed = parseName(payload);
  return cleanText(payload.displayName || parsed.formatted || [parsed.givenName, parsed.familyName].filter(Boolean).join(' '), 255);
}

function primaryEmail(payload = {}) {
  const direct = normalizeEmail(payload.userName);
  if (direct) return direct;
  if (Array.isArray(payload.emails)) {
    const primary = payload.emails.find((entry) => entry?.primary) || payload.emails[0];
    return normalizeEmail(primary?.value);
  }
  return null;
}

function enterprise(payload = {}) {
  const ext = payload[SCIM_ENTERPRISE_USER_SCHEMA] && typeof payload[SCIM_ENTERPRISE_USER_SCHEMA] === 'object'
    ? payload[SCIM_ENTERPRISE_USER_SCHEMA]
    : {};
  return {
    employeeNumber: cleanText(ext.employeeNumber || payload.employeeNumber || payload.employee_id || payload.employeeId, 80),
    department: cleanText(ext.department || payload.department, 120),
  };
}

function extractScimFields(payload = {}, fallbackActive = true) {
  const ent = enterprise(payload);
  return {
    externalId: cleanText(payload.externalId, 255),
    userName: primaryEmail(payload),
    displayName: displayNameFromPayload(payload),
    name: parseName(payload),
    active: boolFromScim(payload.active, fallbackActive),
    employeeId: ent.employeeNumber,
    department: ent.department,
    groups: groupNames(payload.groups),
  };
}

function pagination(query = {}) {
  const startIndex = Math.max(Number.parseInt(query.startIndex || '1', 10) || 1, 1);
  const count = Math.min(Math.max(Number.parseInt(query.count || `${maxPageSize()}`, 10) || maxPageSize(), 1), maxPageSize());
  return { startIndex, count, offset: startIndex - 1 };
}

function parseFilter(filter) {
  const text = String(filter || '').trim();
  if (!text) return null;
  const match = text.match(/^(userName|externalId)\s+eq\s+"([^"]{1,255})"$/i);
  if (!match) throw AppError.badRequest('Unsupported SCIM filter', 'SCIM_FILTER_UNSUPPORTED');
  return { field: match[1].toLowerCase(), value: match[2] };
}

function etag(value) {
  if (!value) return undefined;
  return `W/"${Buffer.from(String(value)).toString('base64url')}"`;
}

function sourceAfterScim(currentSource) {
  const source = String(currentSource || 'local').toLowerCase();
  if (source === 'scim') return 'scim';
  return 'hybrid';
}

function liveCommandKind({ existing, fields, mappedRole, method, realm }) {
  if (!existing) return 'create';
  if (method === 'delete') return 'delete';
  if (!fields.active) return 'deactivate';
  const inactive = existing.is_active === false
    || String(existing.status || 'active').toLowerCase() !== 'active'
    || (realm === 'staff' && (
      existing.staff_is_active === false || existing.archived === true
    ));
  if (inactive) return 'reactivate';
  if (mappedRole && mappedRole !== existing.role) return 'role_change';
  return 'profile_update';
}

function exactScimBody(req, method) {
  if (Buffer.isBuffer(req?.scimRawBody)) return Buffer.from(req.scimRawBody);
  if (method === 'delete') return Buffer.alloc(0);
  throw AppError.internal(
    'Exact SCIM request body capture is required',
    'SCIM_EXACT_BODY_REQUIRED',
  );
}

async function recordLiveScimCommandTx(tx, {
  context,
  req,
  method,
  commandKind,
  targetUid,
  externalId,
  deprovision,
}) {
  const normalizedMethod = String(method || '').trim().toUpperCase();
  const body = exactScimBody(req, String(method || '').trim().toLowerCase());
  const bodySha256 = crypto.createHash('sha256').update(body).digest('hex');
  const payload = JSON.stringify({
    schema: 'vhhealth.i13.scim-live-provider-command/v1',
    method: normalizedMethod,
    target_uid: String(targetUid),
    body_sha256: bodySha256,
  });
  const payloadSha256 = crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
  const breakGlassExcluded = deprovision?.excluded_break_glass === true;
  const authenticatedAt = context.authenticatedAt || new Date();

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO scim_provisioning_commands
       (tenant_id, provider_id, provider_key, direction, realm, command_source,
        command_kind, http_method, target_uid, external_id, authenticated_at,
        auth_binding_sha256, body_ciphertext, body_sha256, body_bytes,
        payload_ciphertext, payload_sha256, payload_bytes, occurred_at,
        effect_disposition, execution_disposition, access_shutdown_evidence,
        evidence)
     VALUES
       ($1::uuid, $2::bigint, $3::text, 'inbound', $4::text,
        'live_provider_push', $5::text, $6::text, $7::uuid, $8::text,
        $9::timestamptz, $10::char(64), $11::text, $12::char(64),
        $13::integer, $14::text, $15::char(64), $16::integer,
        $17::timestamptz, $18::text, $19::text, $20::jsonb, $21::jsonb)
     RETURNING id::text, body_sha256::text, body_bytes,
               payload_sha256::text, payload_bytes, execution_disposition`,
    context.tenant.id,
    context.provider.id,
    context.provider.provider_key,
    context.provider.realm,
    commandKind,
    normalizedMethod,
    targetUid,
    externalId || null,
    authenticatedAt,
    context.provider.scim_bearer_token_hash,
    encryptField(body.toString('base64'), { tenantId: context.tenant.id }),
    bodySha256,
    body.length,
    encryptField(payload, { tenantId: context.tenant.id }),
    payloadSha256,
    Buffer.byteLength(payload, 'utf8'),
    authenticatedAt,
    breakGlassExcluded ? 'live_excluded' : 'live_applied',
    breakGlassExcluded ? 'break_glass_excluded' : 'applied',
    JSON.stringify(deprovision || {}),
    JSON.stringify({
      payload_schema: 'vhhealth.i13.scim-live-provider-command/v1',
      exact_scim_body_byte_parity_verified: true,
      provider_sequence_present: false,
      push_replay_authorized: false,
      request_id: req?.id || null,
    }),
  );
  return rows[0];
}

export function scimErrorPayload(status, detail, scimType = null) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

async function recordScimAuditEvent({
  context,
  eventType,
  outcome = 'accepted',
  localUid = null,
  details = {},
  req = null,
}) {
  await setTenant(context.tenant.id, (tx) => tx.$executeRawUnsafe(
    `INSERT INTO identity_audit_events (
        tenant_id, realm, protocol, provider_id, provider_key, event_type, outcome,
        actor_uid, local_uid, request_id, ip_address, user_agent, details
      )
      VALUES (
        $1::uuid, $2, 'scim', $3::bigint, $4, $5, $6,
        NULL, $7::uuid, $8, $9::inet, $10, $11::jsonb
      )`,
    context.tenant.id,
    context.provider.realm,
    context.provider.id,
    context.provider.provider_key,
    eventType,
    outcome,
    localUid || null,
    req?.id || null,
    req?.ip || null,
    req?.headers?.['user-agent'] || null,
    JSON.stringify(details || {}),
  ));
}

export async function resolveScimContext({ tenantSlug, providerKey, req }) {
  const slug = validateTenantSlug(tenantSlug);
  const key = validateProviderKey(providerKey);
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.status !== 'active') {
    throw AppError.notFound('SCIM tenant not found', 'SCIM_TENANT_NOT_FOUND');
  }
  const providerRows = await setTenant(tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT *
       FROM tenant_identity_providers
      WHERE tenant_id = $1::uuid
        AND provider_key = $2
        AND status = 'active'
        AND scim_enabled = true
      LIMIT 2`,
    tenant.id,
    key,
  ));
  if (providerRows.length !== 1) {
    throw AppError.notFound('SCIM provider not found', 'SCIM_PROVIDER_NOT_FOUND');
  }
  const provider = providerRows[0];
  const token = requireScimToken(req);
  const ok = timingSafeHashEqual(hashToken(token), provider.scim_bearer_token_hash);
  const context = { tenant, provider };
  if (!ok) {
    await recordScimAuditEvent({
      context,
      eventType: 'SCIM_AUTH_FAILED',
      outcome: 'denied',
      req,
      details: { reason: 'token_mismatch' },
    }).catch(() => {});
    throw AppError.unauthorized('Invalid SCIM bearer token', 'SCIM_TOKEN_INVALID');
  }
  const authenticatedAt = new Date();
  await setTenant(tenant.id, (tx) => tx.$executeRawUnsafe(
    `UPDATE tenant_identity_providers
        SET scim_last_authenticated_at = $2::timestamptz
      WHERE id = $1::bigint`,
    provider.id,
    authenticatedAt,
  ));
  return { ...context, authenticatedAt };
}

async function mappedRoleForGroups(context, groups) {
  const lowerGroups = groups.map((group) => group.toLowerCase());
  if (!lowerGroups.length) return { role: null, mappedGroups: [], unmappedGroups: [] };
  const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT idp_group, vh_role, priority
       FROM tenant_idp_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_id = $2::bigint
        AND realm = $3
        AND status = 'active'
        AND lower(idp_group) = ANY($4::text[])
      ORDER BY priority ASC, idp_group ASC`,
    context.tenant.id,
    context.provider.id,
    context.provider.realm,
    lowerGroups,
  ));
  const mappedGroups = rows.map((row) => String(row.idp_group));
  const mappedLower = new Set(mappedGroups.map((group) => group.toLowerCase()));
  const unmappedGroups = groups.filter((group) => !mappedLower.has(group.toLowerCase()));
  if (!rows.length) return { role: null, mappedGroups, unmappedGroups };
  const role = String(rows[0].vh_role || '').toUpperCase();
  if (context.provider.realm === 'staff' && !STAFF_REALM_ROLES.has(role)) {
    throw AppError.badRequest('Mapped SCIM staff role is invalid', 'SCIM_ROLE_MAPPING_INVALID');
  }
  if (context.provider.realm === 'admin' && !ADMIN_REALM_ROLES.has(role)) {
    throw AppError.badRequest('Mapped SCIM admin role is invalid', 'SCIM_ROLE_MAPPING_INVALID');
  }
  return { role, mappedGroups, unmappedGroups };
}

function staffRowToScim(row, groups = []) {
  const display = row.name || row.staff_name || row.email || row.employee_id || String(row.uid);
  const active = row.user_is_active !== false
    && row.staff_is_active !== false
    && String(row.user_status || 'active').toLowerCase() === 'active'
    && row.archived !== true
    && !row.archived_at;
  return {
    schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_USER_SCHEMA],
    id: String(row.uid),
    externalId: row.scim_external_id || row.employee_id || undefined,
    userName: row.email || row.employee_id || String(row.uid),
    name: { formatted: display },
    displayName: display,
    active,
    emails: row.email ? [{ value: row.email, primary: true, type: 'work' }] : [],
    userType: row.role || undefined,
    groups: groups.map((group) => ({ value: group, display: group })),
    [SCIM_ENTERPRISE_USER_SCHEMA]: {
      employeeNumber: row.employee_id || undefined,
      department: row.department || undefined,
    },
    meta: {
      resourceType: 'User',
      created: row.created_at,
      lastModified: row.updated_at || row.staff_updated_at,
      version: etag(row.updated_at || row.staff_updated_at || row.scim_last_synced_at),
    },
  };
}

function adminRowToScim(row, groups = []) {
  const display = row.name || row.email || row.username || String(row.uid);
  const active = row.is_active !== false && String(row.status || 'active').toLowerCase() === 'active';
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: String(row.uid),
    externalId: row.scim_external_id || row.username || undefined,
    userName: row.email || row.username || String(row.uid),
    name: { formatted: display },
    displayName: display,
    active,
    emails: row.email ? [{ value: row.email, primary: true, type: 'work' }] : [],
    userType: row.role || undefined,
    groups: groups.map((group) => ({ value: group, display: group })),
    meta: {
      resourceType: 'User',
      created: row.created_at,
      lastModified: row.updated_at || row.scim_last_synced_at,
      version: etag(row.updated_at || row.scim_last_synced_at),
    },
  };
}

async function groupsForRole(context, role) {
  if (!role) return [];
  const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT idp_group
       FROM tenant_idp_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_id = $2::bigint
        AND realm = $3
        AND status = 'active'
        AND vh_role = $4
      ORDER BY priority ASC, idp_group ASC`,
    context.tenant.id,
    context.provider.id,
    context.provider.realm,
    role,
  ));
  return rows.map((row) => String(row.idp_group));
}

async function randomPasswordHash() {
  return bcrypt.hash(RANDOM_DISABLED_PASSWORD(), 12);
}

async function findStaffById(context, id) {
  const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.email, u.role, u.is_active AS user_is_active,
            u.status AS user_status, u.identity_source AS user_identity_source,
            u.scim_external_id, u.is_break_glass_account, u.break_glass_name,
            u.registered_at AS created_at, u.updated_at,
            s.id AS staff_id, s.employee_id, s.name AS staff_name, s.department,
            s.position, s.is_active AS staff_is_active, s.archived, s.archived_at,
            s.identity_source AS staff_identity_source, s.updated_at AS staff_updated_at
       FROM users u
       JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
        AND (u.scim_provider_id = $3::bigint OR s.scim_provider_id = $3::bigint)
      LIMIT 1`,
    context.tenant.id,
    id,
    context.provider.id,
  ));
  return rows[0] || null;
}

async function findStaffByIdTx(tx, context, id) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.email, u.role, u.is_active AS user_is_active,
            u.status AS user_status, u.identity_source AS user_identity_source,
            u.scim_external_id, u.is_break_glass_account, u.break_glass_name,
            u.registered_at AS created_at, u.updated_at,
            s.id AS staff_id, s.employee_id, s.name AS staff_name, s.department,
            s.position, s.is_active AS staff_is_active, s.archived, s.archived_at,
            s.identity_source AS staff_identity_source, s.updated_at AS staff_updated_at
       FROM users u
       JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid
        AND u.uid = $2::uuid
      LIMIT 1`,
    context.tenant.id,
    id,
  );
  return rows[0] || null;
}

async function findAdminById(context, id) {
  const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT *
       FROM admins
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND scim_provider_id = $3::bigint
      LIMIT 1`,
    context.tenant.id,
    id,
    context.provider.id,
  ));
  return rows[0] || null;
}

async function findExistingStaff(tx, context, fields, id = null) {
  if (id) {
    const byId = await tx.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.role, u.is_active, u.status,
              u.identity_source AS user_identity_source, u.scim_external_id,
              u.is_break_glass_account, s.id AS staff_id,
              s.is_active AS staff_is_active, s.archived,
              s.identity_source AS staff_identity_source,
              s.scim_external_id AS staff_external_id
         FROM users u
         JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1::uuid AND u.uid = $2::uuid
          AND (u.scim_provider_id IS NULL OR u.scim_provider_id = $3::bigint)
          AND (s.scim_provider_id IS NULL OR s.scim_provider_id = $3::bigint)
        LIMIT 1`,
      context.tenant.id,
      id,
      context.provider.id,
    );
    if (byId[0]) return byId[0];
  }
  // Sol Ultra #5: a SCIM provider may match/mutate only identities it owns or
  // that are unowned — never another provider's. The provider match was in the
  // ORDER BY (ranking) only, not the WHERE (filter), so a lookup by external id
  // / email / employee id could adopt a foreign provider's identity. Filter both
  // halves of the joined staff identity by provider ownership.
  const rows = await tx.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.role, u.is_active, u.status,
            u.identity_source AS user_identity_source, u.scim_external_id,
            u.is_break_glass_account, s.id AS staff_id,
            s.is_active AS staff_is_active, s.archived,
            s.identity_source AS staff_identity_source,
            s.scim_external_id AS staff_external_id
       FROM users u
       JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1::uuid
        AND (u.scim_provider_id IS NULL OR u.scim_provider_id = $5::bigint)
        AND (s.scim_provider_id IS NULL OR s.scim_provider_id = $5::bigint)
        AND (
          ($2::text IS NOT NULL AND (u.scim_external_id = $2 OR s.scim_external_id = $2))
          OR ($3::text IS NOT NULL AND lower(u.email) = lower($3))
          OR ($4::text IS NOT NULL AND s.employee_id = $4)
        )
      ORDER BY CASE
        WHEN u.scim_provider_id = $5::bigint OR s.scim_provider_id = $5::bigint THEN 0
        ELSE 1
      END
      LIMIT 2`,
    context.tenant.id,
    fields.externalId || null,
    fields.userName || null,
    fields.employeeId || null,
    context.provider.id,
  );
  if (rows.length > 1) throw AppError.conflict('SCIM identity match is ambiguous', 'SCIM_IDENTITY_AMBIGUOUS');
  return rows[0] || null;
}

async function findExistingAdmin(tx, context, fields, id = null) {
  if (id) {
    const byId = await tx.$queryRawUnsafe(
      `SELECT uid, role, is_active, status, identity_source,
              scim_external_id, is_break_glass_account
         FROM admins
        WHERE tenant_id = $1::uuid AND uid = $2::uuid
          AND (scim_provider_id IS NULL OR scim_provider_id = $3::bigint)
        LIMIT 1`,
      context.tenant.id,
      id,
      context.provider.id,
    );
    if (byId[0]) return byId[0];
  }
  // Sol Ultra #5: filter by provider ownership (unowned or own), not just rank.
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role, is_active, status, identity_source,
            scim_external_id, is_break_glass_account
       FROM admins
      WHERE tenant_id = $1::uuid
        AND (scim_provider_id IS NULL OR scim_provider_id = $5::bigint)
        AND (
          ($2::text IS NOT NULL AND scim_external_id = $2)
          OR ($3::text IS NOT NULL AND lower(email) = lower($3))
          OR ($4::text IS NOT NULL AND lower(username) = lower($4))
        )
      ORDER BY CASE WHEN scim_provider_id = $5::bigint THEN 0 ELSE 1 END
      LIMIT 2`,
    context.tenant.id,
    fields.externalId || null,
    fields.userName || null,
    fields.userName || null,
    context.provider.id,
  );
  if (rows.length > 1) throw AppError.conflict('SCIM identity match is ambiguous', 'SCIM_IDENTITY_AMBIGUOUS');
  return rows[0] || null;
}

export async function deactivateScimIdentityTx(tx, {
  tenantId,
  uid,
  staffId = null,
  realm,
  breakGlass = false,
  reason = 'SCIM deprovision',
}) {
  if (breakGlass) {
    return { excluded_break_glass: true, revoked_sessions: 0, disabled_staff_devices: 0, deleted_staff_sessions: 0 };
  }
  const activeRows = await tx.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS count FROM user_active_sessions WHERE user_uid = $1::uuid',
    uid,
  );
  const activeCount = Number(activeRows[0]?.count || 0);
  await tx.$executeRawUnsafe('DELETE FROM user_active_sessions WHERE user_uid = $1::uuid', uid);
  let staffSessionCount = 0;
  let staffDeviceCount = 0;
  if (realm === 'staff' && staffId) {
    const sessionRows = await tx.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM staff_auth_sessions WHERE staff_id = $1',
      staffId,
    );
    const deviceRows = await tx.$queryRawUnsafe(
      'SELECT COUNT(*)::int AS count FROM staff_devices WHERE staff_id = $1 AND is_active = true',
      staffId,
    );
    staffSessionCount = Number(sessionRows[0]?.count || 0);
    staffDeviceCount = Number(deviceRows[0]?.count || 0);
    await tx.$executeRawUnsafe('DELETE FROM staff_auth_sessions WHERE staff_id = $1', staffId);
    await tx.$executeRawUnsafe(
      `UPDATE staff_devices
          SET is_active = false,
              pin_hash = NULL,
              biometric_enabled = false
        WHERE staff_id = $1`,
      staffId,
    );
  }
  await revokeAllUserTokens(uid);
  if (realm === 'staff') {
    await tx.$executeRawUnsafe(
      `UPDATE users
          SET is_active = false,
              status = 'inactive',
              status_reason = $3::text,
              status_updated_at = NOW(),
              updated_at = NOW()
        WHERE uid = $1::uuid AND tenant_id = $2::uuid`,
      uid,
      tenantId,
      reason,
    );
    await tx.$executeRawUnsafe(
      `UPDATE staff
          SET is_active = false,
              archived = true,
              archived_at = COALESCE(archived_at, NOW()),
              archive_reason = COALESCE(archive_reason, $2::text),
              updated_at = NOW()
        WHERE id = $1`,
      staffId,
      reason,
    );
  } else if (realm === 'admin') {
    await tx.$executeRawUnsafe(
      `UPDATE admins
          SET is_active = false,
              status = 'inactive',
              deactivation_reason = COALESCE(deactivation_reason, $3::text),
              deactivated_at = COALESCE(deactivated_at, NOW()),
              updated_at = NOW()
        WHERE uid = $1::uuid AND tenant_id = $2::uuid`,
      uid,
      tenantId,
      reason,
    );
  } else {
    throw AppError.badRequest('SCIM identity realm is invalid', 'SCIM_REALM_INVALID');
  }
  return {
    excluded_break_glass: false,
    revoked_sessions: activeCount,
    disabled_staff_devices: staffDeviceCount,
    deleted_staff_sessions: staffSessionCount,
  };
}

async function upsertStaff(context, payload, { id = null, method = 'post', req = null } = {}) {
  const fields = extractScimFields(payload, true);
  const roleMapping = await mappedRoleForGroups(context, fields.groups);
  let mutation = null;
  let deprovision = null;
  let commandReceipt = null;
  const row = await setTenant(context.tenant.id, async (tx) => {
    const existing = await findExistingStaff(tx, context, fields, id);
    const role = roleMapping.role || null;
    const commandKind = liveCommandKind({ existing, fields, mappedRole: role, method, realm: 'staff' });
    if (!existing && !fields.active) {
      throw AppError.notFound('SCIM user not found', 'SCIM_USER_NOT_FOUND');
    }
    if (!existing && !role) {
      throw AppError.badRequest('Mapped SCIM group is required to create staff identity', 'SCIM_ROLE_REQUIRED');
    }
    if (!existing) {
      const passwordHash = await randomPasswordHash();
      const userRows = await tx.$queryRawUnsafe(
        `INSERT INTO users (
            name, email, role, is_active, status, encrypted_password, tenant_id,
            registered_at, updated_at, identity_source, scim_external_id, scim_provider_id,
            scim_last_synced_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, NOW(), NOW(), 'scim', $8, $9::bigint, NOW())
          RETURNING id, uid`,
        fields.displayName,
        fields.userName,
        role,
        fields.active,
        fields.active ? 'active' : 'inactive',
        passwordHash,
        context.tenant.id,
        fields.externalId || fields.employeeId || fields.userName,
        context.provider.id,
      );
      const user = userRows[0];
      const staffRows = await tx.$queryRawUnsafe(
        `INSERT INTO staff (
            user_id, employee_id, name, department, position, is_active, tenant_id,
            created_at, updated_at, identity_source, scim_external_id, scim_provider_id,
            scim_last_synced_at
          )
          VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid,
                  NOW(), NOW(), 'scim', $8, $9::bigint, NOW())
          RETURNING id`,
        user.uid,
        fields.employeeId || fields.externalId,
        fields.displayName,
        fields.department,
        payload.title || payload.userType || null,
        fields.active,
        context.tenant.id,
        fields.externalId || fields.employeeId || fields.userName,
        context.provider.id,
      );
      mutation = 'created';
      const createdRow = await findStaffByIdTx(tx, context, user.uid) || {
        id: user.id, uid: user.uid, staff_id: staffRows[0].id,
        role, email: fields.userName, name: fields.displayName,
        employee_id: fields.employeeId, department: fields.department,
        user_is_active: fields.active, staff_is_active: fields.active,
      };
      commandReceipt = await recordLiveScimCommandTx(tx, {
        context,
        req,
        method,
        commandKind,
        targetUid: user.uid,
        externalId: fields.externalId || fields.employeeId || fields.userName,
        deprovision,
      });
      return createdRow;
    }

    const source = sourceAfterScim(existing.user_identity_source);
    const staffSource = sourceAfterScim(existing.staff_identity_source);
    const nextRole = role || undefined;
    if (!fields.active) {
      deprovision = await deactivateScimIdentityTx(tx, {
        tenantId: context.tenant.id,
        uid: existing.uid,
        staffId: existing.staff_id,
        realm: 'staff',
        breakGlass: existing.is_break_glass_account === true,
      });
    }
    await tx.$executeRawUnsafe(
      `UPDATE users
          SET name = COALESCE($2, name),
              email = COALESCE($3, email),
              role = COALESCE($4, role),
              is_active = CASE WHEN $5::boolean THEN true ELSE is_active END,
              status = CASE WHEN $5::boolean THEN 'active' ELSE status END,
              identity_source = $6,
              scim_external_id = COALESCE($7, scim_external_id),
              scim_provider_id = $8::bigint,
              scim_last_synced_at = NOW(),
              updated_at = NOW()
        WHERE uid = $1::uuid
          AND tenant_id = $9::uuid`,
      existing.uid,
      fields.displayName,
      fields.userName,
      nextRole || null,
      fields.active,
      source,
      fields.externalId || fields.employeeId || fields.userName,
      context.provider.id,
      context.tenant.id,
    );
    await tx.$executeRawUnsafe(
      `UPDATE staff
          SET employee_id = COALESCE($2, employee_id),
              name = COALESCE($3, name),
              department = COALESCE($4, department),
              position = COALESCE($5, position),
              is_active = CASE WHEN $6::boolean THEN true ELSE is_active END,
              archived = CASE WHEN $6::boolean THEN false ELSE archived END,
              archived_at = CASE WHEN $6::boolean THEN NULL ELSE archived_at END,
              identity_source = $7,
              scim_external_id = COALESCE($8, scim_external_id),
              scim_provider_id = $9::bigint,
              scim_last_synced_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      existing.staff_id,
      fields.employeeId || fields.externalId,
      fields.displayName,
      fields.department,
      payload.title || payload.userType || null,
      fields.active,
      staffSource,
      fields.externalId || fields.employeeId || fields.userName,
      context.provider.id,
    );
    mutation = fields.active ? 'updated' : 'deactivated';
    const updatedRow = await findStaffByIdTx(tx, context, existing.uid);
    commandReceipt = await recordLiveScimCommandTx(tx, {
      context,
      req,
      method,
      commandKind,
      targetUid: existing.uid,
      externalId: fields.externalId || fields.employeeId || fields.userName,
      deprovision,
    });
    return updatedRow;
  });
  await recordScimAuditEvent({
    context,
    eventType: mutation === 'created' ? 'SCIM_USER_CREATED' : (mutation === 'deactivated' ? 'SCIM_USER_DEACTIVATED' : 'SCIM_USER_UPDATED'),
    localUid: row?.uid || id,
    req,
    details: {
      method,
      realm: 'staff',
      external_id: fields.externalId || null,
      active: fields.active,
      mapped_role: roleMapping.role,
      mapped_groups: roleMapping.mappedGroups,
      unmapped_group_count: roleMapping.unmappedGroups.length,
      deprovision,
      command_receipt_id: commandReceipt?.id || null,
    },
  });
  const groups = await groupsForRole(context, row?.role || roleMapping.role);
  return { resource: staffRowToScim(row, groups), created: mutation === 'created' };
}

async function upsertAdmin(context, payload, { id = null, method = 'post', req = null } = {}) {
  const fields = extractScimFields(payload, true);
  const roleMapping = await mappedRoleForGroups(context, fields.groups);
  const role = roleMapping.role || (fields.groups.length ? null : 'ADMIN');
  let mutation = null;
  let deprovision = null;
  let commandReceipt = null;
  const row = await setTenant(context.tenant.id, async (tx) => {
    const existing = await findExistingAdmin(tx, context, fields, id);
    const commandKind = liveCommandKind({ existing, fields, mappedRole: role, method, realm: 'admin' });
    if (!existing && !fields.active) throw AppError.notFound('SCIM user not found', 'SCIM_USER_NOT_FOUND');
    if (!existing && !role) {
      throw AppError.badRequest('Mapped SCIM group is required to create admin identity', 'SCIM_ROLE_REQUIRED');
    }
    if (!existing) {
      const passwordHash = await randomPasswordHash();
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO admins (
            username, password_hash, email, name, role, is_active, status, tenant_id,
            permissions, created_at, updated_at, identity_source, scim_external_id,
            scim_provider_id, scim_last_synced_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid,
                  ARRAY[]::text[], NOW(), NOW(), 'scim', $9, $10::bigint, NOW())
          RETURNING *`,
        fields.userName || fields.externalId,
        passwordHash,
        fields.userName,
        fields.displayName,
        role,
        fields.active,
        fields.active ? 'active' : 'inactive',
        context.tenant.id,
        fields.externalId || fields.userName,
        context.provider.id,
      );
      mutation = 'created';
      commandReceipt = await recordLiveScimCommandTx(tx, {
        context,
        req,
        method,
        commandKind,
        targetUid: rows[0].uid,
        externalId: fields.externalId || fields.userName,
        deprovision,
      });
      return rows[0];
    }
    const source = sourceAfterScim(existing.identity_source);
    if (!fields.active) {
      deprovision = await deactivateScimIdentityTx(tx, {
        tenantId: context.tenant.id,
        uid: existing.uid,
        realm: 'admin',
        breakGlass: existing.is_break_glass_account === true,
      });
    }
    await tx.$executeRawUnsafe(
      `UPDATE admins
          SET email = COALESCE($2, email),
              name = COALESCE($3, name),
              role = COALESCE($4, role),
              is_active = CASE WHEN $5::boolean THEN true ELSE is_active END,
              status = CASE WHEN $5::boolean THEN 'active' ELSE status END,
              identity_source = $6,
              scim_external_id = COALESCE($7, scim_external_id),
              scim_provider_id = $8::bigint,
              scim_last_synced_at = NOW(),
              updated_at = NOW()
        WHERE uid = $1::uuid
          AND tenant_id = $9::uuid`,
      existing.uid,
      fields.userName,
      fields.displayName,
      role || null,
      fields.active,
      source,
      fields.externalId || fields.userName,
      context.provider.id,
      context.tenant.id,
    );
    mutation = fields.active ? 'updated' : 'deactivated';
    const rows = await tx.$queryRawUnsafe(
      'SELECT * FROM admins WHERE uid = $1::uuid AND tenant_id = $2::uuid LIMIT 1',
      existing.uid,
      context.tenant.id,
    );
    commandReceipt = await recordLiveScimCommandTx(tx, {
      context,
      req,
      method,
      commandKind,
      targetUid: existing.uid,
      externalId: fields.externalId || fields.userName,
      deprovision,
    });
    return rows[0];
  });
  await recordScimAuditEvent({
    context,
    eventType: mutation === 'created' ? 'SCIM_USER_CREATED' : (mutation === 'deactivated' ? 'SCIM_USER_DEACTIVATED' : 'SCIM_USER_UPDATED'),
    localUid: row?.uid || id,
    req,
    details: {
      method,
      realm: 'admin',
      external_id: fields.externalId || null,
      active: fields.active,
      mapped_role: roleMapping.role || role || null,
      mapped_groups: roleMapping.mappedGroups,
      unmapped_group_count: roleMapping.unmappedGroups.length,
      deprovision,
      command_receipt_id: commandReceipt?.id || null,
    },
  });
  const groups = await groupsForRole(context, row?.role || role);
  return { resource: adminRowToScim(row, groups), created: mutation === 'created' };
}

export async function upsertScimUser(context, payload, options = {}) {
  if (context.provider.realm === 'staff') return upsertStaff(context, payload, options);
  return upsertAdmin(context, payload, options);
}

export async function getScimUser(context, id) {
  const row = context.provider.realm === 'staff'
    ? await findStaffById(context, id)
    : await findAdminById(context, id);
  if (!row) throw AppError.notFound('SCIM user not found', 'SCIM_USER_NOT_FOUND');
  const groups = await groupsForRole(context, row.role);
  return context.provider.realm === 'staff' ? staffRowToScim(row, groups) : adminRowToScim(row, groups);
}

export async function listScimUsers(context, query = {}) {
  const page = pagination(query);
  const filter = parseFilter(query.filter);
  if (context.provider.realm === 'staff') {
    const params = [context.tenant.id, context.provider.id];
    const conditions = [
      'u.tenant_id = $1::uuid',
      '(u.scim_provider_id = $2::bigint OR s.scim_provider_id = $2::bigint)',
    ];
    if (filter?.field === 'username') {
      params.push(filter.value);
      conditions.push(`lower(u.email) = lower($${params.length})`);
    } else if (filter?.field === 'externalid') {
      params.push(filter.value);
      conditions.push(`(u.scim_external_id = $${params.length} OR s.scim_external_id = $${params.length} OR s.employee_id = $${params.length})`);
    }
    const countRows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM users u
         JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
        WHERE ${conditions.join(' AND ')}`,
      ...params,
    ));
    const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.name, u.email, u.role, u.is_active AS user_is_active,
              u.status AS user_status, u.scim_external_id,
              u.registered_at AS created_at, u.updated_at,
              s.employee_id, s.name AS staff_name, s.department, s.position,
              s.is_active AS staff_is_active, s.archived, s.archived_at,
              s.updated_at AS staff_updated_at
         FROM users u
         JOIN staff s ON s.user_id = u.uid AND s.tenant_id = u.tenant_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY u.email NULLS LAST, s.employee_id NULLS LAST, u.uid
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      page.count,
      page.offset,
    ));
    const resources = [];
    for (const row of rows) resources.push(staffRowToScim(row, await groupsForRole(context, row.role)));
    return {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: Number(countRows[0]?.count || 0),
      startIndex: page.startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }
  const params = [context.tenant.id, context.provider.id];
  const conditions = ['tenant_id = $1::uuid', 'scim_provider_id = $2::bigint'];
  if (filter?.field === 'username') {
    params.push(filter.value);
    conditions.push(`lower(email) = lower($${params.length})`);
  } else if (filter?.field === 'externalid') {
    params.push(filter.value);
    conditions.push(`(scim_external_id = $${params.length} OR username = $${params.length})`);
  }
  const countRows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM admins WHERE ${conditions.join(' AND ')}`,
    ...params,
  ));
  const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT *
       FROM admins
      WHERE ${conditions.join(' AND ')}
      ORDER BY email NULLS LAST, username, uid
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    ...params,
    page.count,
    page.offset,
  ));
  const resources = [];
  for (const row of rows) resources.push(adminRowToScim(row, await groupsForRole(context, row.role)));
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: Number(countRows[0]?.count || 0),
    startIndex: page.startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export async function deleteScimUser(context, id, { req = null } = {}) {
  const current = await getScimUser(context, id);
  const patched = { ...current, active: false };
  return upsertScimUser(context, patched, { id, method: 'delete', req });
}

function setPath(target, path, value) {
  const clean = String(path || '').trim();
  if (!clean) {
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(target, value);
    return;
  }
  const lower = clean.toLowerCase();
  if (lower === 'active') target.active = boolFromScim(value, true);
  else if (lower === 'username') target.userName = value;
  else if (lower === 'externalid') target.externalId = value;
  else if (lower === 'displayname') target.displayName = value;
  else if (lower === 'name.formatted') target.name = { ...(target.name || {}), formatted: value };
  else if (lower === 'name.givenname') target.name = { ...(target.name || {}), givenName: value };
  else if (lower === 'name.familyname') target.name = { ...(target.name || {}), familyName: value };
  else if (lower.startsWith('emails')) target.emails = Array.isArray(value) ? value : [{ value, primary: true, type: 'work' }];
  else if (lower === 'groups') target.groups = Array.isArray(value) ? value : [];
  else if (lower === `${SCIM_ENTERPRISE_USER_SCHEMA.toLowerCase()}:department` || lower === 'department') {
    target[SCIM_ENTERPRISE_USER_SCHEMA] = { ...(target[SCIM_ENTERPRISE_USER_SCHEMA] || {}), department: value };
  } else if (lower === `${SCIM_ENTERPRISE_USER_SCHEMA.toLowerCase()}:employeenumber` || lower === 'employeenumber') {
    target[SCIM_ENTERPRISE_USER_SCHEMA] = { ...(target[SCIM_ENTERPRISE_USER_SCHEMA] || {}), employeeNumber: value };
  }
}

export async function patchScimUser(context, id, patch, { req = null } = {}) {
  if (!Array.isArray(patch?.Operations)) {
    throw AppError.badRequest('SCIM PatchOp Operations array is required', 'SCIM_PATCH_INVALID');
  }
  const current = await getScimUser(context, id);
  const next = JSON.parse(JSON.stringify(current));
  for (const operation of patch.Operations) {
    const op = String(operation?.op || 'replace').toLowerCase();
    if (!['replace', 'remove'].includes(op)) throw AppError.badRequest('Unsupported SCIM patch op', 'SCIM_PATCH_OP_UNSUPPORTED');
    if (op === 'remove') setPath(next, operation.path, operation.path?.toLowerCase() === 'groups' ? [] : null);
    else setPath(next, operation.path, operation.value);
  }
  return upsertScimUser(context, next, { id, method: 'patch', req });
}

export async function listScimGroups(context, query = {}) {
  const page = pagination(query);
  const rows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT idp_group, vh_role, priority
       FROM tenant_idp_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_id = $2::bigint
        AND realm = $3
        AND status = 'active'
      ORDER BY priority ASC, idp_group ASC
      LIMIT $4 OFFSET $5`,
    context.tenant.id,
    context.provider.id,
    context.provider.realm,
    page.count,
    page.offset,
  ));
  const countRows = await setTenant(context.tenant.id, (tx) => tx.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM tenant_idp_role_mappings
      WHERE tenant_id = $1::uuid
        AND provider_id = $2::bigint
        AND realm = $3
        AND status = 'active'`,
    context.tenant.id,
    context.provider.id,
    context.provider.realm,
  ));
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: Number(countRows[0]?.count || 0),
    startIndex: page.startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((row) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      id: row.idp_group,
      displayName: row.idp_group,
      externalId: row.idp_group,
      meta: { resourceType: 'Group' },
      vhRole: row.vh_role,
    })),
  };
}

export function serviceProviderConfig() {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://www.rfc-editor.org/rfc/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: maxPageSize() },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: true },
    authenticationSchemes: [{
      type: 'oauthbearertoken',
      name: 'SCIM Bearer Token',
      description: 'Tenant/provider scoped SCIM bearer token configured on the VH Health tenant IdP provider.',
      primary: true,
    }],
  };
}
