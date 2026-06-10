// WHO ICD API client for ICD-11 MMS lookup/search.
//
// Cloud ICD API requires OAuth2 client-credentials. Local WHO ICD deployments
// may set WHO_ICD_DISABLE_AUTH=true and reuse the same request/normalization
// path without bearer tokens.

import { AppError } from '../../utils/AppError.js';

const DEFAULT_BASE_URL = 'https://id.who.int';
const DEFAULT_AUTH_URL = 'https://icdaccessmanagement.who.int/connect/token';
const DEFAULT_RELEASE_ID = '2026-01';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_TIMEOUT_MS = 8000;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

let cachedToken = null;

export function whoIcdConfig(env = process.env) {
  const disableAuth = String(env.WHO_ICD_DISABLE_AUTH || '').toLowerCase() === 'true';
  const timeoutMs = Number.parseInt(env.WHO_ICD_TIMEOUT_MS, 10);
  return {
    baseUrl: (env.WHO_ICD_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    authUrl: env.WHO_ICD_AUTH_URL || DEFAULT_AUTH_URL,
    clientId: env.WHO_ICD_CLIENT_ID || '',
    clientSecret: env.WHO_ICD_CLIENT_SECRET || '',
    releaseId: env.WHO_ICD_RELEASE_ID || DEFAULT_RELEASE_ID,
    language: env.WHO_ICD_LANGUAGE || DEFAULT_LANGUAGE,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    disableAuth,
  };
}

export function isWhoIcdConfigured(env = process.env) {
  const cfg = whoIcdConfig(env);
  return cfg.disableAuth || Boolean(cfg.clientId && cfg.clientSecret);
}

export function resetWhoIcdTokenCache() {
  cachedToken = null;
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function languageText(value) {
  if (!value) return null;
  if (typeof value === 'string') return stripMarkup(value);
  if (typeof value === 'object') {
    return stripMarkup(value['@value'] || value.value || value.label || value.title || '');
  }
  return stripMarkup(value);
}

export function extractIcdEntityId(uri) {
  const text = String(uri || '').trim();
  if (!text) return null;
  const clean = text.split('?')[0].replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || null;
}

function authHeaders(config) {
  const token = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function fetchJson(fetchImpl, url, options, timeoutMs) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const err = new Error(`WHO ICD API returned HTTP ${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function getAccessToken({ fetchImpl, config, now = Date.now }) {
  if (config.disableAuth) return null;
  if (!config.clientId || !config.clientSecret) {
    throw AppError.badRequest(
      'WHO ICD credentials are not configured',
      'WHO_ICD_NOT_CONFIGURED',
    );
  }
  if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_SKEW_MS > now()) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: 'icdapi_access',
  });
  const payload = await fetchJson(fetchImpl, config.authUrl, {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  }, config.timeoutMs);

  if (!payload.access_token) {
    throw AppError.internal('WHO ICD token response did not include access_token', 'WHO_ICD_TOKEN_INVALID');
  }
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: now() + (Number(payload.expires_in || 3600) * 1000),
  };
  return cachedToken.accessToken;
}

function conceptFromSearchEntity(entity, { releaseId, language }) {
  const code = entity?.theCode || entity?.code;
  const display = languageText(entity?.title);
  if (!code || !display) return null;
  const linearizationUri = entity?.id || null;
  const foundationUri = String(entity?.stemId || '').includes('/icd/entity/')
    ? entity.stemId
    : null;
  return {
    system_key: 'ICD11',
    code,
    display,
    category: entity?.chapter || null,
    semantic_tag: entity?.entityType || null,
    status: 'active',
    release_id: releaseId,
    language,
    linearization_uri: linearizationUri,
    foundation_uri: foundationUri,
    source: 'who_icd_api',
    score: typeof entity?.score === 'number' ? entity.score : null,
    properties: {
      who: {
        release_id: releaseId,
        language,
        linearization_uri: linearizationUri,
        foundation_uri: foundationUri,
        is_leaf: entity?.isLeaf ?? null,
        important: entity?.important ?? null,
        score: entity?.score ?? null,
      },
    },
  };
}

function conceptFromLinearizationEntity(entity, { code, releaseId, language }) {
  const resolvedCode = entity?.code || code;
  const display = languageText(entity?.title || entity?.fullySpecifiedName);
  if (!resolvedCode || !display) return null;
  return {
    system_key: 'ICD11',
    code: resolvedCode,
    display,
    category: entity?.chapter || entity?.blockId || null,
    semantic_tag: entity?.classKind || null,
    status: 'active',
    release_id: releaseId,
    language,
    linearization_uri: entity?.['@id'] || null,
    foundation_uri: entity?.source || null,
    source: 'who_icd_api',
    properties: {
      who: {
        release_id: releaseId,
        language,
        linearization_uri: entity?.['@id'] || null,
        foundation_uri: entity?.source || null,
        class_kind: entity?.classKind || null,
        browser_url: entity?.browserUrl || null,
      },
    },
  };
}

export function createWhoIcdClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('WHO ICD client requires a fetch implementation');
  }
  const config = whoIcdConfig(env);

  async function request(path, params = {}) {
    const token = await getAccessToken({ fetchImpl, config, now });
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return fetchJson(fetchImpl, url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': config.language,
        'API-Version': 'v2',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, config.timeoutMs);
  }

  return {
    config,
    isConfigured: () => isWhoIcdConfigured(env),

    async searchIcd11(query, { limit = 20 } = {}) {
      const payload = await request(`/icd/release/11/${config.releaseId}/mms/search`, {
        q: query,
        flatResults: true,
        highlightingEnabled: false,
        medicalCodingMode: true,
      });
      if (payload?.error) {
        throw AppError.badRequest(payload.errorMessage || 'WHO ICD search failed', 'WHO_ICD_SEARCH_ERROR');
      }
      const rows = Array.isArray(payload?.destinationEntities) ? payload.destinationEntities : [];
      return rows
        .map((entity) => conceptFromSearchEntity(entity, {
          releaseId: config.releaseId,
          language: config.language,
        }))
        .filter(Boolean)
        .slice(0, limit);
    },

    async lookupIcd11Code(code) {
      const codeInfo = await request(
        `/icd/release/11/${config.releaseId}/mms/codeinfo/${encodeURIComponent(code)}`,
      );
      const stemId = codeInfo?.stemId || codeInfo?.stemIdUri || codeInfo?.stemURI;
      const entityId = extractIcdEntityId(stemId);
      if (!entityId) {
        return {
          system_key: 'ICD11',
          code: codeInfo?.code || code,
          display: codeInfo?.code || code,
          status: 'active',
          release_id: config.releaseId,
          language: config.language,
          linearization_uri: null,
          foundation_uri: null,
          source: 'who_icd_api',
          properties: { who: { release_id: config.releaseId, language: config.language, code_info: codeInfo } },
        };
      }
      const entity = await request(`/icd/release/11/${config.releaseId}/mms/${encodeURIComponent(entityId)}`);
      const concept = conceptFromLinearizationEntity(entity, {
        code: codeInfo?.code || code,
        releaseId: config.releaseId,
        language: config.language,
      });
      return concept ? {
        ...concept,
        properties: {
          ...(concept.properties || {}),
          who: {
            ...(concept.properties?.who || {}),
            code_info: codeInfo,
          },
        },
      } : null;
    },
  };
}

const defaultClient = createWhoIcdClient();

export default defaultClient;
