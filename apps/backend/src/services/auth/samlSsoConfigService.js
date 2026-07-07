import crypto from 'crypto';

import { parseDomFromString, xpath } from '@node-saml/node-saml/lib/xml.js';

import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, decryptField } from '../../utils/fieldEncryption.js';
import { ADMIN_ROLES, ALL_STAFF_ROLES } from '../../utils/roleHelpers.js';
import { exposeScimProviderConfig } from './scimCredentialService.js';

const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9_-]{1,78}[a-z0-9]$/;
const ADMIN_REALM_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const STAFF_REALM_ROLES = new Set(ALL_STAFF_ROLES);
const FORBIDDEN_STAFF_SSO_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'PATIENT', 'WEBHOOK_CLIENT']);
const MAX_ACTIVE_IDP_CERTS = 2;

function intEnv(name, defaultValue, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(Math.max(value, min), max);
}

function metadataHttpTimeoutMs() {
  return intEnv('SSO_OIDC_HTTP_TIMEOUT_MS', 5000, 1000, 30000);
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
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array`, 'SSO_ARRAY_INVALID');
  return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function hashValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw AppError.badRequest('Invalid boolean SAML setting', 'SSO_BOOLEAN_INVALID');
}

function withIdentityScope(tenantId, fn) {
  if (tenantId) return setTenant(tenantId, fn);
  return setTenant(null, fn, { superAdmin: true });
}

function tenantForScope({ tenantId, platform }) {
  return platform ? null : tenantId;
}

function encryptOptional(value, tenantId) {
  if (value === undefined || value === null || value === '') return null;
  return encryptField(String(value), { tenantId });
}

function encryptJson(value, tenantId) {
  if (value === undefined || value === null) return null;
  return encryptField(JSON.stringify(value), { tenantId });
}

export function decryptSamlJson(ciphertext, fallback = null) {
  if (!ciphertext) return fallback;
  const plaintext = decryptField(ciphertext);
  if (!plaintext) return fallback;
  return JSON.parse(plaintext);
}

export function decryptSamlField(ciphertext) {
  return ciphertext ? decryptField(ciphertext) : null;
}

function normalizePemCertificate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/-----BEGIN CERTIFICATE-----/.test(raw)) {
    return raw.replace(/\r\n?/g, '\n').trim();
  }
  const compact = raw
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) {
    throw AppError.badRequest('SAML signing certificate must be PEM or base64', 'SSO_SAML_CERT_INVALID');
  }
  const rows = compact.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${rows.join('\n')}\n-----END CERTIFICATE-----`;
}

function normalizePemList(value, label) {
  const raw = value === undefined || value === null ? [] : value;
  const entries = Array.isArray(raw)
    ? raw
    : String(raw)
      .split(/(?=-----BEGIN CERTIFICATE-----)|\r?\n\s*\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  const certs = entries.map(normalizePemCertificate).filter(Boolean);
  const unique = [...new Map(certs.map((cert) => [cert.replace(/\s+/g, ''), cert])).values()];
  if (unique.length > MAX_ACTIVE_IDP_CERTS) {
    throw AppError.badRequest(`${label} supports at most two active certificates`, 'SSO_SAML_CERT_ROTATION_LIMIT');
  }
  return unique;
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), metadataHttpTimeoutMs());
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/samlmetadata+xml, application/xml, text/xml, */*' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`SAML metadata endpoint returned ${response.status}`);
    if (!text.trim()) throw new Error('SAML metadata endpoint returned an empty body');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function textContent(node) {
  return String(node?.textContent || '').trim();
}

function normalizeMetadataCert(raw) {
  return normalizePemCertificate(raw.replace(/\s+/g, ''));
}

export async function parseSamlMetadataXml(xml) {
  const text = String(xml || '').trim();
  if (!text) throw AppError.badRequest('SAML metadata XML is empty', 'SSO_SAML_METADATA_EMPTY');
  let doc;
  try {
    doc = await parseDomFromString(text);
  } catch (err) {
    throw AppError.badRequest(`SAML metadata XML is invalid: ${err.message}`, 'SSO_SAML_METADATA_INVALID');
  }

  const entities = xpath.selectElements(
    doc,
    "/*[local-name()='EntityDescriptor'] | /*[local-name()='EntitiesDescriptor']/*[local-name()='EntityDescriptor']",
  );
  const idpEntity = entities.find((entity) => (
    xpath.selectElements(entity, "./*[local-name()='IDPSSODescriptor']").length > 0
  ));
  if (!idpEntity) throw AppError.badRequest('SAML metadata does not contain an IDPSSODescriptor', 'SSO_SAML_METADATA_INVALID');

  const entityId = String(idpEntity.getAttribute('entityID') || '').trim();
  if (!entityId) throw AppError.badRequest('SAML metadata is missing entityID', 'SSO_SAML_METADATA_INVALID');

  const ssoServices = xpath.selectElements(idpEntity, ".//*[local-name()='IDPSSODescriptor']/*[local-name()='SingleSignOnService']");
  const preferredService = ssoServices.find((node) => String(node.getAttribute('Binding') || '').includes('HTTP-Redirect'))
    || ssoServices.find((node) => String(node.getAttribute('Binding') || '').includes('HTTP-POST'))
    || ssoServices[0];
  const ssoUrl = preferredService ? String(preferredService.getAttribute('Location') || '').trim() : null;

  const certNodes = xpath.selectElements(
    idpEntity,
    ".//*[local-name()='IDPSSODescriptor']/*[local-name()='KeyDescriptor'][not(@use) or @use='signing']//*[local-name()='X509Certificate']",
  );
  const signingCerts = [...new Map(
    certNodes
      .map((node) => normalizeMetadataCert(textContent(node)))
      .filter(Boolean)
      .map((cert) => [cert.replace(/\s+/g, ''), cert]),
  ).values()].slice(0, MAX_ACTIVE_IDP_CERTS);

  return { entityId, ssoUrl, signingCerts };
}

async function importSamlMetadata({ metadataUrl, metadataXml }) {
  const xml = metadataXml ? String(metadataXml).trim() : (metadataUrl ? await fetchTextWithTimeout(metadataUrl) : null);
  if (!xml) return { importedXml: null, imported: {} };
  const parsed = await parseSamlMetadataXml(xml);
  return { importedXml: xml, imported: parsed };
}

function sanitizeSamlProvider(row, { includeSecretPresence = true } = {}) {
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
    saml_entity_id: row.saml_entity_id,
    saml_sp_entity_id: row.saml_sp_entity_id,
    saml_metadata_url: row.saml_metadata_url,
    saml_acs_url: row.saml_acs_url,
    saml_sso_url: row.saml_sso_url,
    saml_nameid_format: row.saml_nameid_format,
    saml_require_signed_response: Boolean(row.saml_require_signed_response),
    saml_require_signed_assertion: Boolean(row.saml_require_signed_assertion),
    saml_encrypted_assertions: Boolean(row.saml_encrypted_assertions),
    ...(includeSecretPresence ? {
      has_saml_metadata_xml: Boolean(row.saml_metadata_xml_ciphertext),
      has_saml_idp_signing_certs: Boolean(row.saml_idp_signing_certs_ciphertext),
      has_saml_signing_key: Boolean(row.saml_signing_key_ciphertext),
      has_saml_signing_cert: Boolean(row.saml_signing_cert_ciphertext),
      has_saml_decryption_key: Boolean(row.saml_decryption_key_ciphertext),
      has_saml_decryption_cert: Boolean(row.saml_decryption_cert_ciphertext),
    } : {}),
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

async function querySamlProviders({ tenantId, realm, platform = false, status = null, providerKey = null }) {
  return withIdentityScope(tenantForScope({ tenantId, platform }), async (tx) => {
    const tenantFilter = platform
      ? 'tenant_id IS NULL AND is_platform_provider = true'
      : 'tenant_id = $1::uuid AND is_platform_provider = false';
    const params = platform ? [] : [tenantId];
    let idx = params.length + 1;
    const filters = [
      tenantFilter,
      `realm = $${idx}`,
      "protocol = 'saml'",
    ];
    params.push(realm);
    idx += 1;
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

export async function listSamlProviders({ tenantId, realm, platform = false, status = null } = {}) {
  if (!platform && !tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  if (realm === 'staff' && platform) throw AppError.badRequest('Staff SAML providers are tenant-scoped', 'SSO_STAFF_PLATFORM_FORBIDDEN');
  const rows = await querySamlProviders({ tenantId, realm, platform, status });
  return rows.map((row) => sanitizeSamlProvider(row));
}

export async function getSamlProvider({ tenantId, realm, platform = false, providerKey, activeOnly = false }) {
  if (realm === 'staff' && platform) throw AppError.badRequest('Staff SAML providers are tenant-scoped', 'SSO_STAFF_PLATFORM_FORBIDDEN');
  const key = validateProviderKey(providerKey);
  const rows = await querySamlProviders({
    tenantId,
    realm,
    platform,
    providerKey: key,
    status: activeOnly ? 'active' : null,
  });
  if (!rows[0]) throw AppError.notFound('SAML provider not found', 'SSO_PROVIDER_NOT_FOUND');
  return rows[0];
}

export async function getSamlProviderConfig(args) {
  return sanitizeSamlProvider(await getSamlProvider(args));
}

function validateRealm(realm) {
  const normalized = String(realm || '').trim().toLowerCase();
  if (!['admin', 'staff'].includes(normalized)) {
    throw AppError.badRequest('Invalid SSO realm', 'SSO_REALM_INVALID');
  }
  return normalized;
}

function normalizeSamlPolicy({ realm, policyInput, status }) {
  const policy = { ...jsonObject(policyInput, 'policy') };
  if (realm === 'staff') {
    const employeeClaim = String(
      policy.staff_employee_id_claim
      || policy.staffEmployeeIdClaim
      || policy.employee_id_claim
      || policy.employeeIdClaim
      || 'employee_id',
    ).trim();
    policy.staff_employee_id_claim = employeeClaim || 'employee_id';
  }
  if (status === 'active' && policy.allow_idp_initiated === true && policy.require_in_response_to !== false) {
    throw AppError.badRequest('IdP-initiated SAML must explicitly disable InResponseTo requirement', 'SSO_SAML_POLICY_INVALID');
  }
  return policy;
}

function normalizeSamlInput({ tenantId, platform, realm, input, status, existing }) {
  return Promise.resolve().then(async () => {
    const metadataUrl = validateHttpsUrl(input.saml_metadata_url || input.metadata_url, 'metadata_url');
    const metadataXmlInput = input.saml_metadata_xml ?? input.metadata_xml;
    const { importedXml, imported } = await importSamlMetadata({ metadataUrl, metadataXml: metadataXmlInput });

    const signingCertInput = input.saml_idp_signing_certs
      ?? input.idp_signing_certs
      ?? input.idp_certificates
      ?? imported.signingCerts
      ?? null;
    const normalizedIdpSigningCerts = signingCertInput === null && existing?.saml_idp_signing_certs_ciphertext
      ? null
      : normalizePemList(signingCertInput, 'saml_idp_signing_certs');
    const idpSigningCerts = normalizedIdpSigningCerts && normalizedIdpSigningCerts.length
      ? normalizedIdpSigningCerts
      : null;

    const policy = normalizeSamlPolicy({
      realm,
      policyInput: input.policy,
      status,
    });
    const encryptedTenantId = platform ? null : tenantId;
    const patch = {
      saml_entity_id: String(input.saml_entity_id || input.idp_entity_id || imported.entityId || '').trim() || null,
      saml_sp_entity_id: String(input.saml_sp_entity_id || input.sp_entity_id || '').trim() || null,
      saml_metadata_url: metadataUrl,
      saml_acs_url: validateHttpsUrl(input.saml_acs_url || input.acs_url, 'acs_url', { allowEmpty: status !== 'active' }),
      saml_sso_url: validateHttpsUrl(input.saml_sso_url || input.sso_url || imported.ssoUrl, 'sso_url'),
      saml_metadata_xml_ciphertext: importedXml ? encryptField(importedXml, { tenantId: encryptedTenantId }) : null,
      saml_idp_signing_certs_ciphertext: idpSigningCerts ? encryptJson(idpSigningCerts, encryptedTenantId) : null,
      saml_signing_key_ciphertext: encryptOptional(input.saml_signing_key || input.signing_key, encryptedTenantId),
      saml_signing_cert_ciphertext: encryptOptional(input.saml_signing_cert || input.signing_cert, encryptedTenantId),
      saml_decryption_key_ciphertext: encryptOptional(input.saml_decryption_key || input.decryption_key, encryptedTenantId),
      saml_decryption_cert_ciphertext: encryptOptional(input.saml_decryption_cert || input.decryption_cert, encryptedTenantId),
      saml_nameid_format: String(input.saml_nameid_format || input.nameid_format || '').trim() || null,
      saml_require_signed_response: normalizeBoolean(input.saml_require_signed_response ?? input.require_signed_response, false),
      saml_require_signed_assertion: normalizeBoolean(input.saml_require_signed_assertion ?? input.require_signed_assertion, false),
      saml_encrypted_assertions: normalizeBoolean(input.saml_encrypted_assertions ?? input.encrypted_assertions, false),
      group_claim_name: String(input.group_claim_name || input.groupClaimName || 'groups').trim() || 'groups',
      allowed_domains: normalizeStringArray(input.allowed_domains || input.allowedDomains, 'allowed_domains'),
      required_claims: jsonObject(input.required_claims || input.requiredClaims, 'required_claims'),
      policy,
    };

    if (status === 'active') {
      for (const [field, value] of Object.entries({
        saml_entity_id: patch.saml_entity_id,
        saml_sp_entity_id: patch.saml_sp_entity_id,
        saml_acs_url: patch.saml_acs_url,
      })) {
        if (!value) throw AppError.badRequest(`${field} is required for active SAML providers`, 'SSO_PROVIDER_INCOMPLETE');
      }
      if (!patch.saml_idp_signing_certs_ciphertext && !existing?.saml_idp_signing_certs_ciphertext) {
        throw AppError.badRequest('saml_idp_signing_certs is required for active SAML providers', 'SSO_PROVIDER_INCOMPLETE');
      }
      if (patch.saml_encrypted_assertions && !patch.saml_decryption_key_ciphertext && !existing?.saml_decryption_key_ciphertext) {
        throw AppError.badRequest('saml_decryption_key is required when encrypted assertions are enabled', 'SSO_PROVIDER_INCOMPLETE');
      }
    }
    return patch;
  });
}

export async function upsertSamlProvider({
  tenantId,
  realm: requestedRealm,
  platform = false,
  providerKey,
  actorUid,
  input = {},
}) {
  const realm = validateRealm(requestedRealm);
  if (!platform && !tenantId) throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  if (realm === 'staff' && platform) throw AppError.badRequest('Staff SAML providers are tenant-scoped', 'SSO_STAFF_PLATFORM_FORBIDDEN');
  const key = validateProviderKey(providerKey || input.provider_key);
  const status = String(input.status || 'draft').toLowerCase();
  if (!['draft', 'active', 'disabled'].includes(status)) {
    throw AppError.badRequest('Invalid provider status', 'SSO_PROVIDER_STATUS_INVALID');
  }
  const displayName = String(input.display_name || input.displayName || key).trim();
  if (!displayName) throw AppError.badRequest('display_name is required', 'SSO_DISPLAY_NAME_REQUIRED');

  const scopeTenantId = tenantForScope({ tenantId, platform });
  const rows = await withIdentityScope(scopeTenantId, async (tx) => {
    const existing = platform
      ? await tx.$queryRawUnsafe(
        `SELECT *
           FROM tenant_identity_providers
          WHERE tenant_id IS NULL
            AND is_platform_provider = true
            AND realm = $1
            AND protocol = 'saml'
            AND provider_key = $2
          LIMIT 1`,
        realm,
        key,
      )
      : await tx.$queryRawUnsafe(
        `SELECT *
           FROM tenant_identity_providers
          WHERE tenant_id = $1::uuid
            AND is_platform_provider = false
            AND realm = $2
            AND protocol = 'saml'
            AND provider_key = $3
          LIMIT 1`,
        tenantId,
        realm,
        key,
      );
    const patch = await normalizeSamlInput({
      tenantId,
      platform,
      realm,
      input,
      status,
      existing: existing[0],
    });
    if (existing[0]) {
      return tx.$queryRawUnsafe(
        `UPDATE tenant_identity_providers
            SET display_name = $1,
                status = $2,
                saml_entity_id = $3,
                saml_sp_entity_id = $4,
                saml_metadata_url = $5,
                saml_acs_url = $6,
                saml_sso_url = $7,
                saml_metadata_xml_ciphertext = COALESCE($8, saml_metadata_xml_ciphertext),
                saml_idp_signing_certs_ciphertext = COALESCE($9, saml_idp_signing_certs_ciphertext),
                saml_signing_key_ciphertext = COALESCE($10, saml_signing_key_ciphertext),
                saml_signing_cert_ciphertext = COALESCE($11, saml_signing_cert_ciphertext),
                saml_decryption_key_ciphertext = COALESCE($12, saml_decryption_key_ciphertext),
                saml_decryption_cert_ciphertext = COALESCE($13, saml_decryption_cert_ciphertext),
                saml_nameid_format = $14,
                saml_require_signed_response = $15,
                saml_require_signed_assertion = $16,
                saml_encrypted_assertions = $17,
                group_claim_name = $18,
                allowed_domains = $19::text[],
                required_claims = $20::jsonb,
                policy = $21::jsonb,
                updated_by = $22::uuid,
                updated_at = NOW()
          WHERE id = $23::bigint
          RETURNING *`,
        displayName,
        status,
        patch.saml_entity_id,
        patch.saml_sp_entity_id,
        patch.saml_metadata_url,
        patch.saml_acs_url,
        patch.saml_sso_url,
        patch.saml_metadata_xml_ciphertext,
        patch.saml_idp_signing_certs_ciphertext,
        patch.saml_signing_key_ciphertext,
        patch.saml_signing_cert_ciphertext,
        patch.saml_decryption_key_ciphertext,
        patch.saml_decryption_cert_ciphertext,
        patch.saml_nameid_format,
        patch.saml_require_signed_response,
        patch.saml_require_signed_assertion,
        patch.saml_encrypted_assertions,
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
          saml_entity_id, saml_sp_entity_id, saml_metadata_url, saml_acs_url, saml_sso_url,
          saml_metadata_xml_ciphertext, saml_idp_signing_certs_ciphertext,
          saml_signing_key_ciphertext, saml_signing_cert_ciphertext,
          saml_decryption_key_ciphertext, saml_decryption_cert_ciphertext,
          saml_nameid_format, saml_require_signed_response, saml_require_signed_assertion,
          saml_encrypted_assertions, group_claim_name, allowed_domains, required_claims, policy,
          created_by, updated_by
        )
        VALUES (
          $1::uuid, $2, $3, 'saml', $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13,
          $14, $15,
          $16, $17,
          $18, $19, $20,
          $21, $22, $23::text[], $24::jsonb, $25::jsonb,
          $26::uuid, $26::uuid
        )
        RETURNING *`,
      scopeTenantId,
      Boolean(platform),
      realm,
      key,
      displayName,
      status,
      patch.saml_entity_id,
      patch.saml_sp_entity_id,
      patch.saml_metadata_url,
      patch.saml_acs_url,
      patch.saml_sso_url,
      patch.saml_metadata_xml_ciphertext,
      patch.saml_idp_signing_certs_ciphertext,
      patch.saml_signing_key_ciphertext,
      patch.saml_signing_cert_ciphertext,
      patch.saml_decryption_key_ciphertext,
      patch.saml_decryption_cert_ciphertext,
      patch.saml_nameid_format,
      patch.saml_require_signed_response,
      patch.saml_require_signed_assertion,
      patch.saml_encrypted_assertions,
      patch.group_claim_name,
      patch.allowed_domains,
      JSON.stringify(patch.required_claims),
      JSON.stringify(patch.policy),
      actorUid || null,
    );
  });

  await recordSamlIdentityAuditEvent({
    tenantId: scopeTenantId,
    realm,
    provider: rows[0],
    eventType: 'SSO_PROVIDER_CONFIG_UPDATED',
    outcome: 'accepted',
    actorUid,
    details: {
      status,
      platform: Boolean(platform),
      metadata_imported: Boolean(input.saml_metadata_xml || input.metadata_xml || input.saml_metadata_url || input.metadata_url),
      idp_cert_rotation_slots: rows[0].saml_idp_signing_certs_ciphertext ? MAX_ACTIVE_IDP_CERTS : 0,
    },
  });
  return sanitizeSamlProvider(rows[0]);
}

function isStaffSsoRoleAllowed(role) {
  const normalized = String(role || '').toUpperCase();
  return STAFF_REALM_ROLES.has(normalized) && !FORBIDDEN_STAFF_SSO_ROLES.has(normalized);
}

function validateMapping({ realm, platform, mapping, index }) {
  const idpGroup = String(mapping?.idp_group || mapping?.idpGroup || '').trim();
  const vhRole = String(mapping?.vh_role || mapping?.vhRole || '').trim().toUpperCase();
  const status = String(mapping?.status || 'active').toLowerCase();
  const priority = Number.parseInt(mapping?.priority ?? `${100 + index}`, 10);
  if (!idpGroup) throw AppError.badRequest('idp_group is required', 'SSO_MAPPING_GROUP_REQUIRED');
  if (!['active', 'disabled'].includes(status)) throw AppError.badRequest('Invalid mapping status', 'SSO_MAPPING_STATUS_INVALID');
  if (realm === 'staff') {
    if (!isStaffSsoRoleAllowed(vhRole)) throw AppError.badRequest('Invalid staff role mapping', 'SSO_MAPPING_ROLE_INVALID');
  } else {
    if (!ADMIN_REALM_ROLES.has(vhRole)) throw AppError.badRequest('Invalid admin role mapping', 'SSO_MAPPING_ROLE_INVALID');
    if (!platform && vhRole !== 'ADMIN') throw AppError.badRequest('Tenant providers may map only ADMIN', 'SSO_MAPPING_ROLE_INVALID');
    if (platform && vhRole !== 'SUPER_ADMIN') throw AppError.badRequest('Platform providers may map only SUPER_ADMIN', 'SSO_MAPPING_ROLE_INVALID');
  }
  return { idpGroup, vhRole, status, priority: Number.isFinite(priority) ? priority : 100 + index };
}

export async function listSamlRoleMappings({ tenantId, realm: requestedRealm, platform = false, providerKey }) {
  const realm = validateRealm(requestedRealm);
  const provider = await getSamlProvider({ tenantId, realm, platform, providerKey });
  const scopeTenantId = tenantForScope({ tenantId, platform });
  const rows = await withIdentityScope(scopeTenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT id, tenant_id, provider_id, realm, idp_group, vh_role, status, priority, created_at, updated_at
       FROM tenant_idp_role_mappings
      WHERE provider_id = $1::bigint
        AND realm = $2
      ORDER BY priority ASC, idp_group ASC`,
    provider.id,
    realm,
  ));
  return rows.map((row) => ({
    id: Number(row.id),
    idp_group: row.idp_group,
    vh_role: row.vh_role,
    status: row.status,
    priority: row.priority,
  }));
}

export async function replaceSamlRoleMappings({
  tenantId,
  realm: requestedRealm,
  platform = false,
  providerKey,
  actorUid,
  mappings = [],
}) {
  const realm = validateRealm(requestedRealm);
  const provider = await getSamlProvider({ tenantId, realm, platform, providerKey });
  if (!Array.isArray(mappings)) throw AppError.badRequest('mappings must be an array', 'SSO_MAPPINGS_INVALID');
  const normalized = mappings.map((mapping, index) => validateMapping({ realm, platform, mapping, index }));
  const scopeTenantId = tenantForScope({ tenantId, platform });

  await withIdentityScope(scopeTenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      'DELETE FROM tenant_idp_role_mappings WHERE provider_id = $1::bigint AND realm = $2',
      provider.id,
      realm,
    );
    for (const mapping of normalized) {
      await tx.$queryRawUnsafe(
        `INSERT INTO tenant_idp_role_mappings (
            tenant_id, provider_id, realm, idp_group, vh_role, status, priority, created_by, updated_by
          )
          VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6, $7, $8::uuid, $8::uuid)`,
        scopeTenantId,
        provider.id,
        realm,
        mapping.idpGroup,
        mapping.vhRole,
        mapping.status,
        mapping.priority,
        actorUid || null,
      );
    }
  });

  await recordSamlIdentityAuditEvent({
    tenantId: scopeTenantId,
    realm,
    provider,
    eventType: 'SSO_ROLE_MAPPINGS_UPDATED',
    outcome: 'accepted',
    actorUid,
    details: { count: normalized.length, roles: [...new Set(normalized.map((m) => m.vhRole))] },
  });
  return listSamlRoleMappings({ tenantId, realm, platform, providerKey });
}

export async function recordSamlIdentityAuditEvent({
  tenantId,
  realm: requestedRealm,
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
  const realm = validateRealm(requestedRealm);
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
          $1::uuid, $2, 'saml', $3::bigint, $4, $5, $6,
          $7::uuid, $8::uuid, $9, $10, $11, $12,
          $13, $14::inet, $15, $16::jsonb
        )`,
      tenantId || null,
      realm,
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
    logger.error('saml identity audit write failed', { eventType, outcome, error: err.message });
    throw AppError.internal('Identity audit write failed', 'SSO_AUDIT_WRITE_FAILED');
  }
}

export function isAdminSamlRoleAllowed(role) {
  return ADMIN_ROLES.includes(role) || role === 'SUPER_ADMIN';
}
