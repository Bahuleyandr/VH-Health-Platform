/**
 * Provider-neutral prior-authorization payer adapter.
 *
 * The prior-auth workflow can stay clinical/revenue-cycle focused while this
 * edge handles manual submission, webhook/API submission, and safe fallbacks.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1000;
const SUPPORTED_HTTP_MODES = new Set(['http', 'webhook']);

function clean(value) {
  return String(value ?? '').trim();
}

function splitCsv(value) {
  return clean(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeRegion(value) {
  return clean(value).toUpperCase();
}

function regionAllowed(tenantRegion, allowedRegions) {
  if (!allowedRegions.length) return true;
  if (!tenantRegion) return false;
  const normalizedTenantRegion = normalizeRegion(tenantRegion);
  return allowedRegions.map(normalizeRegion).includes(normalizedTenantRegion);
}

function normalizeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

export function normalizePriorAuthPayerMode(mode = null, env = process.env) {
  const raw = clean(
    mode
      || env.PRIOR_AUTH_PAYER_MODE
      || env.CLINICAL_AI_PRIOR_AUTH_PAYER_MODE
      || 'manual'
  ).toLowerCase();
  if (!raw || raw === 'manual') return 'manual';
  if (raw === 'api') return 'http';
  if (SUPPORTED_HTTP_MODES.has(raw)) return raw;
  if (['none', 'off', 'disabled'].includes(raw)) return 'none';
  return 'manual';
}

export function resolvePriorAuthPayerConfig({
  mode = null,
  tenantRegion = null,
  env = process.env,
} = {}) {
  const selectedMode = normalizePriorAuthPayerMode(mode, env);
  const endpoint = clean(env.PRIOR_AUTH_PAYER_ENDPOINT || env.CLINICAL_AI_PRIOR_AUTH_PAYER_ENDPOINT);
  const apiKey = clean(env.PRIOR_AUTH_PAYER_API_KEY || env.CLINICAL_AI_PRIOR_AUTH_PAYER_API_KEY);
  const allowedRegions = splitCsv(env.PRIOR_AUTH_PAYER_ALLOWED_REGIONS || env.CLINICAL_AI_PRIOR_AUTH_PAYER_ALLOWED_REGIONS);
  const isRegionAllowed = regionAllowed(tenantRegion, allowedRegions);
  const timeoutMs = Math.max(
    Number.parseInt(env.PRIOR_AUTH_PAYER_TIMEOUT_MS || env.CLINICAL_AI_PRIOR_AUTH_PAYER_TIMEOUT_MS, 10)
      || DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS
  );

  if (selectedMode === 'manual') {
    return {
      configured: true,
      mode: 'manual',
      reason: null,
      external_call: false,
      endpoint_configured: Boolean(endpoint),
      api_key_configured: Boolean(apiKey),
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: timeoutMs,
    };
  }

  if (selectedMode === 'none') {
    return {
      configured: false,
      mode: 'none',
      reason: 'payer_adapter_not_configured',
      external_call: false,
      endpoint_configured: Boolean(endpoint),
      api_key_configured: Boolean(apiKey),
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: timeoutMs,
    };
  }

  if (!endpoint) {
    return {
      configured: false,
      mode: selectedMode,
      reason: 'payer_endpoint_not_configured',
      external_call: true,
      endpoint_configured: false,
      api_key_configured: Boolean(apiKey),
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: timeoutMs,
    };
  }

  if (!isRegionAllowed) {
    return {
      configured: false,
      mode: selectedMode,
      reason: 'tenant_region_not_allowed_for_payer',
      external_call: true,
      endpoint_configured: true,
      api_key_configured: Boolean(apiKey),
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: timeoutMs,
    };
  }

  return {
    configured: true,
    mode: selectedMode,
    reason: null,
    external_call: true,
    endpoint,
    endpoint_configured: true,
    api_key: apiKey,
    api_key_configured: Boolean(apiKey),
    tenant_region: tenantRegion || null,
    allowed_regions: allowedRegions,
    timeout_ms: timeoutMs,
  };
}

export function describePriorAuthPayerConfig(options = {}) {
  const config = resolvePriorAuthPayerConfig(options);
  return {
    configured: config.configured,
    mode: config.mode,
    reason: config.reason || null,
    external_call: Boolean(config.external_call),
    endpoint_configured: Boolean(config.endpoint_configured),
    api_key_configured: Boolean(config.api_key_configured),
    tenant_region: config.tenant_region || null,
    allowed_regions: config.allowed_regions || [],
    timeout_ms: config.timeout_ms || null,
  };
}

export function buildPriorAuthPayerPayload(priorAuth, { payerReferenceId = null } = {}) {
  const evidence = normalizeJson(priorAuth?.clinical_evidence, {});
  const packet = normalizeJson(priorAuth?.packet_draft, {});
  const citations = normalizeJson(priorAuth?.citations, []);
  return {
    prior_auth_id: priorAuth?.id ?? null,
    tenant_id: priorAuth?.tenant_id ?? null,
    admission_id: priorAuth?.admission_id ?? null,
    patient_uid: priorAuth?.patient_uid ?? null,
    payer_name: priorAuth?.payer_name ?? null,
    policy_number: priorAuth?.policy_number ?? null,
    procedure_code: priorAuth?.procedure_code ?? null,
    procedure_description: priorAuth?.procedure_description ?? null,
    requested_service_type: priorAuth?.requested_service_type ?? null,
    requested_reference_id: clean(payerReferenceId) || null,
    medical_necessity: priorAuth?.medical_necessity ?? null,
    clinical_evidence: evidence && typeof evidence === 'object' ? evidence : {},
    packet_draft: packet && typeof packet === 'object' ? packet : {},
    citations: Array.isArray(citations) ? citations : [],
  };
}

function normalizeResponsePayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const referenceId = clean(
    body.reference_id
      || body.payer_reference_id
      || body.request_id
      || body.external_id
      || body.id
  ) || null;
  return {
    reference_id: referenceId,
    payer_status: clean(body.status || body.state || body.decision) || null,
    message: clean(body.message || body.detail || body.description).slice(0, 500) || null,
  };
}

async function readResponsePayload(response) {
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      // Some payer APIs return an empty body on 202.
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text.slice(0, 500) };
    }
  }
  return {};
}

async function postJsonWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function submitPriorAuthToPayer({
  priorAuth,
  payerReferenceId = null,
  tenantRegion = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resolvePriorAuthPayerConfig({ tenantRegion, env });
  const configSummary = describePriorAuthPayerConfig({ tenantRegion, env });
  const requestedReferenceId = clean(payerReferenceId) || null;
  const base = {
    adapter: 'prior_auth_payer',
    mode: config.mode,
    status: 'skipped',
    reason: null,
    submitted: false,
    blocking: false,
    reference_id: requestedReferenceId,
    http_status: null,
    tenant_region: tenantRegion || null,
    config: configSummary,
  };

  if (!priorAuth?.id) {
    return {
      ...base,
      status: 'failed',
      reason: 'prior_auth_required',
      blocking: true,
    };
  }

  if (config.mode === 'manual') {
    return {
      ...base,
      status: 'manual_submission_required',
      reason: 'manual_payer_submission',
    };
  }

  if (config.mode === 'none') {
    return {
      ...base,
      reason: config.reason,
    };
  }

  if (!config.configured) {
    return {
      ...base,
      status: 'failed',
      reason: config.reason,
      blocking: true,
    };
  }

  if (typeof fetchImpl !== 'function') {
    return {
      ...base,
      status: 'failed',
      reason: 'fetch_unavailable',
      blocking: true,
    };
  }

  const payload = buildPriorAuthPayerPayload(priorAuth, { payerReferenceId: requestedReferenceId });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Idempotency-Key': `vh-prior-auth-${priorAuth.id}`,
  };
  if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;

  try {
    const response = await postJsonWithTimeout(
      fetchImpl,
      config.endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      },
      config.timeout_ms
    );
    const responsePayload = await readResponsePayload(response);
    const normalized = normalizeResponsePayload(responsePayload);

    if (!response.ok) {
      return {
        ...base,
        status: 'failed',
        reason: `payer_http_${response.status}`,
        blocking: true,
        http_status: response.status,
        response: normalized,
      };
    }

    return {
      ...base,
      status: 'submitted',
      reason: null,
      submitted: true,
      reference_id: normalized.reference_id || requestedReferenceId,
      http_status: response.status,
      payer_status: normalized.payer_status,
      response: normalized,
    };
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      reason: err?.name === 'AbortError' ? 'payer_submission_timeout' : 'payer_submission_error',
      blocking: true,
      error_message: clean(err?.message).slice(0, 500) || null,
    };
  }
}

export default {
  buildPriorAuthPayerPayload,
  describePriorAuthPayerConfig,
  normalizePriorAuthPayerMode,
  resolvePriorAuthPayerConfig,
  submitPriorAuthToPayer,
};
