// src/services/nhcx/nhcxTenantConfigService.js
//
// Per-tenant NHCX enrolment/configuration. Nonsecret settings live under
// tenants.settings.nhcx; secrets stay encrypted in tenant_interop_secrets and
// are keyed by the globally unique NHCX participant code.

import { NHCX_CONFIG } from '../../config/nhcxConfig.js';
import logger from '../../logging/logger.js';
import {
  getInteropSecret,
  listInteropSecretsForTenant,
  resolveTenantBySender,
  upsertInteropSecret,
} from '../interop/tenantInteropSecretService.js';
import { getTenantById, updateTenant } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';

export const NHCX_SECRET_KINDS = Object.freeze({
  apiToken: 'nhcx_api_token',
  jwePrivateKey: 'nhcx_jwe_private_key',
  callbackSecret: 'nhcx_callback_secret',
});

const VALID_NHCX_SECRET_KINDS = new Set(Object.values(NHCX_SECRET_KINDS));
const VALID_ENVIRONMENTS = new Set(['sandbox', 'production']);
const CONFIG_CACHE = new Map();

function clean(value) {
  return String(value ?? '').trim();
}

function boolFrom(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = clean(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function settingsObject(settings) {
  if (!settings) return {};
  if (typeof settings === 'object' && !Array.isArray(settings)) return settings;
  if (typeof settings === 'string') {
    try {
      const parsed = JSON.parse(settings);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function nullableString(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return null;
}

function normalizeUrl(value, field) {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw AppError.badRequest(`${field} must be an HTTP(S) URL`, 'NHCX_GATEWAY_URL_INVALID');
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.badRequest(`${field} must be a valid URL`, 'NHCX_GATEWAY_URL_INVALID');
  }
}

function existingNHCXSettings(tenant) {
  const settings = settingsObject(tenant?.settings);
  const raw = settings.nhcx;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

export function normalizeNHCXConfig(input = {}, previous = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const gatewayBaseUrls = src.gatewayBaseUrls || src.gateway_base_urls || {};
  const priorGatewayBaseUrls = prior.gatewayBaseUrls || {};
  const environment = clean(src.environment ?? prior.environment ?? NHCX_CONFIG.defaultEnvironment).toLowerCase();
  if (!VALID_ENVIRONMENTS.has(environment)) {
    throw AppError.badRequest('NHCX environment must be sandbox or production', 'NHCX_ENVIRONMENT_INVALID');
  }

  return {
    enabled: boolFrom(src.enabled, boolFrom(prior.enabled, false)),
    environment,
    participantCode: nullableString(
      src.participantCode,
      src.participant_code,
      prior.participantCode,
      prior.participant_code,
    ),
    counterpartyParticipantCode: nullableString(
      src.counterpartyParticipantCode,
      src.counterparty_participant_code,
      prior.counterpartyParticipantCode,
      prior.counterparty_participant_code,
    ),
    gatewayBaseUrls: {
      sandbox: normalizeUrl(
        gatewayBaseUrls.sandbox
          ?? src.sandboxGatewayBaseUrl
          ?? src.sandbox_gateway_base_url
          ?? priorGatewayBaseUrls.sandbox,
        'NHCX sandbox gateway base URL',
      ),
      production: normalizeUrl(
        gatewayBaseUrls.production
          ?? src.productionGatewayBaseUrl
          ?? src.production_gateway_base_url
          ?? priorGatewayBaseUrls.production,
        'NHCX production gateway base URL',
      ),
    },
  };
}

function publicConfig(config) {
  return {
    globalEnabled: NHCX_CONFIG.enabled,
    effectiveEnabled: NHCX_CONFIG.enabled && config.enabled === true,
    enabled: config.enabled === true,
    environment: config.environment || NHCX_CONFIG.defaultEnvironment,
    participantCode: config.participantCode || null,
    counterpartyParticipantCode: config.counterpartyParticipantCode || null,
    gatewayBaseUrls: {
      sandbox: config.gatewayBaseUrls?.sandbox || null,
      production: config.gatewayBaseUrls?.production || null,
    },
  };
}

function cacheGet(tenantId) {
  const hit = CONFIG_CACHE.get(tenantId);
  if (!hit || hit.expiresAt <= Date.now()) {
    CONFIG_CACHE.delete(tenantId);
    return null;
  }
  return hit.value;
}

function cacheSet(tenantId, value) {
  CONFIG_CACHE.set(tenantId, {
    value,
    expiresAt: Date.now() + Math.max(1000, NHCX_CONFIG.credentialCacheTtlMs || 60000),
  });
}

export function clearNHCXConfigCache(tenantId = null) {
  if (tenantId) CONFIG_CACHE.delete(tenantId);
  else CONFIG_CACHE.clear();
}

export async function getNHCXConfigForTenant(tenantId) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
  return publicConfig(normalizeNHCXConfig(existingNHCXSettings(tenant)));
}

export async function updateNHCXConfigForTenant(tenantId, patch = {}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
  const settings = settingsObject(tenant.settings);
  const normalized = normalizeNHCXConfig(patch, existingNHCXSettings(tenant));
  const updated = await updateTenant(tenantId, {
    settings: {
      ...settings,
      nhcx: normalized,
    },
  });
  clearNHCXConfigCache(tenantId);
  return publicConfig(normalizeNHCXConfig(existingNHCXSettings(updated)));
}

export async function listNHCXSecretsForTenant(tenantId) {
  const rows = await listInteropSecretsForTenant(tenantId);
  return rows.filter((row) => VALID_NHCX_SECRET_KINDS.has(row.kind));
}

export async function upsertNHCXSecret({ tenantId, kind, participantCode = null, secret }) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  const cleanKind = clean(kind);
  if (!VALID_NHCX_SECRET_KINDS.has(cleanKind)) {
    throw AppError.badRequest('Unknown NHCX secret kind', 'NHCX_SECRET_KIND_INVALID', {
      allowed: Object.values(NHCX_SECRET_KINDS),
    });
  }
  const config = await getNHCXConfigForTenant(tenantId);
  const senderIdentifier = clean(participantCode || config.participantCode);
  if (!senderIdentifier) {
    throw AppError.badRequest('NHCX participant code is required before storing secrets', 'NHCX_PARTICIPANT_CODE_REQUIRED');
  }
  const row = await upsertInteropSecret({
    tenantId,
    kind: cleanKind,
    senderIdentifier,
    secret,
  });
  clearNHCXConfigCache(tenantId);
  return row;
}

export async function resolveTenantByNHCXParticipantCode(participantCode) {
  return resolveTenantBySender(NHCX_SECRET_KINDS.callbackSecret, participantCode);
}

export async function loadNHCXRuntimeConfig(tenantId, { forceRefresh = false } = {}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required', 'TENANT_ID_REQUIRED');
  if (!forceRefresh) {
    const cached = cacheGet(tenantId);
    if (cached) return cached;
  }

  const config = await getNHCXConfigForTenant(tenantId);
  const participantCode = config.participantCode;
  const credentials = {
    apiToken: participantCode
      ? await getInteropSecret(tenantId, NHCX_SECRET_KINDS.apiToken, { senderIdentifier: participantCode })
      : null,
    jwePrivateKey: participantCode
      ? await getInteropSecret(tenantId, NHCX_SECRET_KINDS.jwePrivateKey, { senderIdentifier: participantCode })
      : null,
    callbackSecret: participantCode
      ? await getInteropSecret(tenantId, NHCX_SECRET_KINDS.callbackSecret, { senderIdentifier: participantCode })
      : null,
  };
  const gatewayBaseUrl = config.gatewayBaseUrls?.[config.environment] || null;
  const missing = [];
  if (!participantCode) missing.push('participantCode');
  if (!config.counterpartyParticipantCode) missing.push('counterpartyParticipantCode');
  if (!gatewayBaseUrl) missing.push(`${config.environment}GatewayBaseUrl`);
  if (!credentials.apiToken) missing.push(NHCX_SECRET_KINDS.apiToken);
  if (!credentials.jwePrivateKey) missing.push(NHCX_SECRET_KINDS.jwePrivateKey);
  if (!credentials.callbackSecret) missing.push(NHCX_SECRET_KINDS.callbackSecret);

  const runtime = {
    ...config,
    gatewayBaseUrl,
    credentials,
    missing,
  };
  cacheSet(tenantId, runtime);
  return runtime;
}

export async function getAdminNHCXConfig(tenantId) {
  const [config, secrets] = await Promise.all([
    getNHCXConfigForTenant(tenantId),
    listNHCXSecretsForTenant(tenantId).catch((err) => {
      logger.warn('NHCX secret metadata lookup failed', { tenantId, error: err?.message });
      return [];
    }),
  ]);
  return { config, secrets, secretKinds: Object.values(NHCX_SECRET_KINDS) };
}

export default {
  clearNHCXConfigCache,
  getAdminNHCXConfig,
  getNHCXConfigForTenant,
  listNHCXSecretsForTenant,
  loadNHCXRuntimeConfig,
  normalizeNHCXConfig,
  resolveTenantByNHCXParticipantCode,
  updateNHCXConfigForTenant,
  upsertNHCXSecret,
  NHCX_SECRET_KINDS,
};
