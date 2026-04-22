import logger from '../../logging/logger.js';
import {
  getClinicalAiBudgetStatus,
  getClinicalAiGuardrails,
  getClinicalAiModule,
  getClinicalAiUsageSummary,
  listClinicalAiModules,
} from './clinicalAiModuleService.js';
import { describeDiarizationConfig } from './ambientDiarizationService.js';
import { describePacsConfig } from './imagingPacsAdapterService.js';
import { describePriorAuthPayerConfig } from './priorAuthorizationPayerAdapterService.js';
import { describeSttConfig } from './sttService.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_MAX_TOKENS = 2200;
const SUPPORTED_PROVIDERS = ['template', 'ollama', 'openai-compatible', 'openai', 'anthropic'];
const EXTERNAL_PROVIDERS = new Set(['openai', 'anthropic']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase().trim());
}

function safeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProvider(value) {
  const provider = String(value || 'template').toLowerCase().trim();
  const aliases = {
    local: 'ollama',
    'llama-local': 'ollama',
    llama: 'ollama',
    openai_compatible: 'openai-compatible',
    openai_compat: 'openai-compatible',
    compatible: 'openai-compatible',
    chatgpt: 'openai',
    claude: 'anthropic',
  };
  return aliases[provider] || provider;
}

function defaultBaseUrl(provider) {
  if (provider === 'ollama') return 'http://localhost:11434';
  if (provider === 'openai') return 'https://api.openai.com';
  if (provider === 'anthropic') return 'https://api.anthropic.com';
  return '';
}

function getApiKey(provider) {
  if (process.env.CLINICAL_AI_API_KEY) return process.env.CLINICAL_AI_API_KEY;
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY || '';
  return '';
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/$/, '');
}

function joinEndpoint(baseUrl, endpoint) {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith(endpoint)) return base;
  if (endpoint.startsWith('/v1/') && base.endsWith('/v1')) {
    return `${base}${endpoint.slice(3)}`;
  }
  return `${base}${endpoint}`;
}

function isExternalUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const { protocol, hostname } = new URL(baseUrl);
    if (!['http:', 'https:'].includes(protocol)) return true;
    return !LOCAL_HOSTS.has(hostname.toLowerCase());
  } catch {
    return true;
  }
}

/**
 * Tenants outside the externally-allowed region list can never route their
 * PHI to an external model. DPDP / GDPR / HIPAA all hard-block cross-region
 * PHI egress; this guard is the last mile that enforces it.
 *
 * `CLINICAL_AI_EXTERNAL_REGIONS` is a comma-separated allowlist of regions
 * (e.g. `US,AP`). Empty or unset means every region is allowed — fine for
 * single-tenant pilots, but MUST be set the moment a second region onboards.
 */
function tenantCanUseExternal(tenantRegion) {
  if (!tenantRegion) return true;
  const raw = (process.env.CLINICAL_AI_EXTERNAL_REGIONS || '').trim();
  if (!raw) return true;
  const allowed = raw.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  return allowed.includes(String(tenantRegion).toUpperCase());
}

function getProviderConfig(module = null, guardrails = null) {
  const provider = normalizeProvider(
    module?.provider_override || process.env.CLINICAL_AI_PROVIDER || process.env.AI_PROVIDER || 'template'
  );
  const explicitBaseUrl = process.env.CLINICAL_AI_BASE_URL || process.env.AI_SUMMARIZE_URL || '';
  const baseUrl = normalizeBaseUrl(explicitBaseUrl || defaultBaseUrl(provider));
  const model = module?.model_override || process.env.CLINICAL_AI_MODEL || process.env.AI_SUMMARIZE_MODEL || DEFAULT_MODEL;
  const timeoutMs = Math.min(
    Math.max(parseInt(process.env.CLINICAL_AI_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS, 5_000),
    120_000
  );
  const configuredMaxTokens = Math.min(
    Math.max(parseInt(module?.max_tokens ?? process.env.CLINICAL_AI_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS, 256),
    8000
  );
  const requestTokenLimit = guardrails?.enabled ? safeInt(guardrails.request_token_limit, 0) : 0;
  const maxTokens = requestTokenLimit ? Math.min(configuredMaxTokens, requestTokenLimit) : configuredMaxTokens;
  // High-risk modules must not be creative. Risk tier on settings.risk wins
  // unless the module has an explicit temperature override (SUPER_ADMIN only).
  const riskTier = String(module?.settings?.risk || '').toLowerCase();
  const riskDefault = riskTier === 'critical' ? 0.0
    : riskTier === 'high' ? 0.15
    : riskTier === 'medium' ? 0.3
    : riskTier === 'low' ? 0.5
    : null;
  const temperatureRaw = module?.temperature
    ?? riskDefault
    ?? process.env.CLINICAL_AI_TEMPERATURE
    ?? '0.15';
  const temperature = Math.min(Math.max(Number.parseFloat(temperatureRaw), 0), 1);
  const apiKey = getApiKey(provider);
  const allowExternal = module
    ? boolEnv(process.env.CLINICAL_AI_ALLOW_EXTERNAL) && Boolean(module.external_allowed)
    : boolEnv(process.env.CLINICAL_AI_ALLOW_EXTERNAL);
  const externalProvider = EXTERNAL_PROVIDERS.has(provider) || (
    provider === 'openai-compatible' && isExternalUrl(baseUrl)
  );

  return {
    module,
    moduleKey: module?.module_key || null,
    guardrails,
    provider,
    baseUrl,
    model,
    timeoutMs,
    maxTokens,
    temperature,
    apiKey,
    allowExternal: allowExternal && (guardrails?.external_ai_enabled !== false),
    externalProvider,
    supported: SUPPORTED_PROVIDERS.includes(provider),
    baseUrlConfigured: Boolean(explicitBaseUrl) || Boolean(defaultBaseUrl(provider)),
  };
}

function looksLikeOllama(config) {
  return config.provider === 'ollama' || config.baseUrl.includes(':11434');
}

function buildMessages({ systemPrompt, userPrompt, systemRole = 'system' }) {
  return [
    { role: systemRole, content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function emptyUsage(extra = {}) {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    provider_request_id: null,
    finish_reason: null,
    latency_ms: null,
    raw: null,
    ...extra,
  };
}

function estimateCostMinor(config, usage) {
  const inputRate = safeInt(process.env.CLINICAL_AI_INPUT_COST_PER_MILLION_MINOR, 0);
  const outputRate = safeInt(process.env.CLINICAL_AI_OUTPUT_COST_PER_MILLION_MINOR, 0);
  if (!inputRate && !outputRate) return null;
  return Math.round(
    ((usage.prompt_tokens || 0) * inputRate + (usage.completion_tokens || 0) * outputRate) / 1_000_000
  );
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) || null;
}

function readOpenAIText(payload) {
  const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? '';
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text || part?.content || '')
      .join('')
      .trim();
  }
  return String(content || '').trim();
}

function readAnthropicText(payload) {
  return (payload.content || [])
    .filter((part) => part?.type === 'text' && part.text)
    .map((part) => part.text)
    .join('')
    .trim();
}

function getReadiness(config, budgetStatus = null) {
  if (!config.supported) {
    return { ready: false, reason: `Unsupported clinical AI provider: ${config.provider}` };
  }
  if (config.module && !config.module.enabled) {
    return { ready: false, reason: `Clinical AI module disabled: ${config.module.display_name}` };
  }
  if (config.provider === 'template') {
    return { ready: false, reason: 'Clinical AI provider is template fallback' };
  }
  if (!config.baseUrl) {
    return { ready: false, reason: 'No clinical AI endpoint configured' };
  }
  if (config.externalProvider && !config.allowExternal) {
    if (config.guardrails?.external_ai_enabled === false) {
      return {
        ready: false,
        reason: 'External clinical AI disabled by admin guardrail',
      };
    }
    return {
      ready: false,
      reason: 'External clinical AI providers require CLINICAL_AI_ALLOW_EXTERNAL=true',
    };
  }
  if (config.guardrails?.enabled && budgetStatus?.tripped) {
    return {
      ready: false,
      reason: budgetStatus.blocking_reasons?.[0] || 'Clinical AI budget guardrail is active',
    };
  }
  if (EXTERNAL_PROVIDERS.has(config.provider) && !config.apiKey) {
    return { ready: false, reason: `${config.provider} clinical AI API key is not configured` };
  }
  return { ready: true, reason: null };
}

function adapterStatus(config = {}) {
  if (config.configured) return 'configured';
  if (String(config.reason || '').includes('not_allowed')) return 'blocked';
  return 'not_configured';
}

function buildAdapterReadiness({ tenantRegion = null } = {}) {
  const stt = describeSttConfig({ tenantRegion });
  const diarization = describeDiarizationConfig({ tenantRegion });
  const pacs = describePacsConfig({ tenantRegion });
  const payer = describePriorAuthPayerConfig({ tenantRegion });

  return [
    {
      key: 'speech_to_text',
      display_name: 'Speech-to-text',
      surface: 'voice',
      provider: stt.provider,
      model: stt.model || null,
      configured: Boolean(stt.configured),
      status: adapterStatus(stt),
      reason: stt.reason || null,
      external_call: Boolean(stt.external_call),
      endpoint_configured: stt.endpoint_configured ?? null,
      api_key_configured: stt.api_key_configured ?? null,
      tenant_region: stt.tenant_region || tenantRegion || null,
      allowed_regions: stt.allowed_regions || [],
      timeout_ms: stt.timeout_ms || null,
    },
    {
      key: 'ambient_diarization',
      display_name: 'Ambient diarization',
      surface: 'ambient_documentation',
      provider: diarization.provider,
      configured: Boolean(diarization.configured),
      status: adapterStatus(diarization),
      reason: diarization.reason || null,
      external_call: Boolean(diarization.external_call),
      endpoint_configured: Boolean(diarization.endpoint_configured),
      api_key_configured: Boolean(diarization.api_key_configured),
      tenant_region: diarization.tenant_region || tenantRegion || null,
      allowed_regions: diarization.allowed_regions || [],
      timeout_ms: diarization.timeout_ms || null,
    },
    {
      key: 'imaging_pacs',
      display_name: 'Imaging PACS',
      surface: 'imaging',
      provider: pacs.provider,
      mode: pacs.api_mode || null,
      configured: Boolean(pacs.configured),
      status: adapterStatus(pacs),
      reason: pacs.reason || null,
      external_call: Boolean(pacs.provider && pacs.provider !== 'none'),
      endpoint_configured: Boolean(pacs.base_url_configured),
      auth_configured: Boolean(pacs.auth_configured),
      tenant_region: pacs.tenant_region || tenantRegion || null,
      allowed_regions: pacs.allowed_regions || [],
      timeout_ms: pacs.timeout_ms || null,
    },
    {
      key: 'prior_auth_payer',
      display_name: 'Prior auth payer',
      surface: 'billing',
      provider: payer.mode,
      mode: payer.mode,
      configured: Boolean(payer.configured),
      status: adapterStatus(payer),
      reason: payer.reason || null,
      external_call: Boolean(payer.external_call),
      endpoint_configured: Boolean(payer.endpoint_configured),
      api_key_configured: Boolean(payer.api_key_configured),
      tenant_region: payer.tenant_region || tenantRegion || null,
      allowed_regions: payer.allowed_regions || [],
      timeout_ms: payer.timeout_ms || null,
    },
  ];
}

async function callOllama(config, prompt, systemPrompt) {
  const url = joinEndpoint(config.baseUrl, '/api/generate');
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      prompt,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: config.temperature,
        top_p: 0.9,
        num_predict: config.maxTokens,
      },
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const usage = emptyUsage({
    prompt_tokens: safeInt(payload.prompt_eval_count, 0),
    completion_tokens: safeInt(payload.eval_count, 0),
    total_tokens: safeInt(payload.prompt_eval_count, 0) + safeInt(payload.eval_count, 0),
    finish_reason: payload.done_reason || null,
    latency_ms: payload.total_duration ? Math.round(Number(payload.total_duration) / 1_000_000) : Date.now() - startedAt,
    raw: {
      total_duration: payload.total_duration || null,
      load_duration: payload.load_duration || null,
      prompt_eval_duration: payload.prompt_eval_duration || null,
      eval_duration: payload.eval_duration || null,
    },
  });
  return { text: payload.response || '', usage };
}

async function callOpenAICompatible(config, userPrompt, systemPrompt) {
  const url = joinEndpoint(config.baseUrl, '/v1/chat/completions');
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : {}),
      ...(config.provider === 'openai' && process.env.OPENAI_ORGANIZATION
        ? { 'OpenAI-Organization': process.env.OPENAI_ORGANIZATION }
        : {}),
      ...(config.provider === 'openai' && process.env.OPENAI_PROJECT
        ? { 'OpenAI-Project': process.env.OPENAI_PROJECT }
        : {}),
    },
    body: JSON.stringify({
      model: config.model,
      messages: buildMessages({
        systemPrompt,
        userPrompt,
        systemRole: config.provider === 'openai' ? 'developer' : 'system',
      }),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const usage = emptyUsage({
    prompt_tokens: safeInt(payload.usage?.prompt_tokens, 0),
    completion_tokens: safeInt(payload.usage?.completion_tokens, 0),
    total_tokens: safeInt(payload.usage?.total_tokens, 0),
    provider_request_id: responseHeader(response, 'x-request-id') || payload.id || null,
    finish_reason: payload.choices?.[0]?.finish_reason || null,
    latency_ms: Date.now() - startedAt,
    raw: payload.usage || null,
  });
  if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return { text: readOpenAIText(payload), usage };
}

async function callAnthropic(config, userPrompt, systemPrompt) {
  const url = joinEndpoint(config.baseUrl, '/v1/messages');
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': process.env.ANTHROPIC_VERSION || process.env.ANTHROPIC_API_VERSION || '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Anthropic endpoint returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const inputTokens = safeInt(payload.usage?.input_tokens, 0)
    + safeInt(payload.usage?.cache_creation_input_tokens, 0)
    + safeInt(payload.usage?.cache_read_input_tokens, 0);
  const outputTokens = safeInt(payload.usage?.output_tokens, 0);
  const usage = emptyUsage({
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    provider_request_id: responseHeader(response, 'request-id') || payload.id || null,
    finish_reason: payload.stop_reason || null,
    latency_ms: Date.now() - startedAt,
    raw: payload.usage || null,
  });
  return { text: readAnthropicText(payload), usage };
}

function serializeClinicalAiConfig(config, readiness) {
  return {
    moduleKey: config.moduleKey,
    provider: config.provider,
    model: config.model,
    enabled: readiness.ready,
    baseUrlConfigured: config.baseUrlConfigured,
    apiKeyConfigured: Boolean(config.apiKey),
    externalProvider: config.externalProvider,
    externalAllowed: config.allowExternal,
    readiness: readiness.reason,
    supportedProviders: SUPPORTED_PROVIDERS,
  };
}

export function getClinicalAiConfig() {
  const config = getProviderConfig();
  const readiness = getReadiness(config);
  return serializeClinicalAiConfig(config, readiness);
}

export async function generateClinicalText({ systemPrompt, userPrompt, taskType, tenantRegion = null, tenantId = null }) {
  const module = await getClinicalAiModule(taskType, { tenantId });
  const guardrails = await getClinicalAiGuardrails();
  const budgetStatus = await getClinicalAiBudgetStatus({ days: 1, guardrails, tenantId });
  const config = getProviderConfig(module, guardrails);
  const readiness = getReadiness(config, budgetStatus);
  const baseUsage = emptyUsage();

  // Region-safety: block external PHI egress for tenants whose region is not
  // on the allowlist. Local providers pass through; external ones fall back
  // to the template with a clear reason written to the draft metadata.
  if (config.externalProvider && !tenantCanUseExternal(tenantRegion)) {
    logger.warn('External provider blocked by region policy', {
      taskType,
      provider: config.provider,
      tenantRegion,
    });
    return {
      text: '',
      usedAi: false,
      provider: 'template',
      model: config.model,
      moduleKey: config.moduleKey || taskType || null,
      reason: `external_provider_blocked_for_region:${String(tenantRegion).toUpperCase()}`,
      usage: baseUsage,
      estimatedCostMinor: null,
    };
  }

  if (!readiness.ready) {
    return {
      text: '',
      usedAi: false,
      provider: config.provider === 'template' ? 'template' : config.provider,
      model: config.model,
      moduleKey: config.moduleKey || taskType || null,
      reason: readiness.reason,
      usage: baseUsage,
      estimatedCostMinor: null,
    };
  }

  try {
    let result;
    if (looksLikeOllama(config)) {
      result = await callOllama(config, userPrompt, systemPrompt);
    } else if (config.provider === 'anthropic') {
      result = await callAnthropic(config, userPrompt, systemPrompt);
    } else {
      result = await callOpenAICompatible(config, userPrompt, systemPrompt);
    }
    const { text, usage } = result;

    if (!String(text || '').trim()) {
      throw new Error('Model returned empty content');
    }
    const estimatedCostMinor = estimateCostMinor(config, usage);

    return {
      text: String(text).trim(),
      usedAi: true,
      provider: looksLikeOllama(config) ? 'ollama' : config.provider,
      model: config.model,
      moduleKey: config.moduleKey || taskType || null,
      usage,
      estimatedCostMinor,
    };
  } catch (err) {
    logger.warn('Clinical AI generation failed; falling back to template', {
      taskType,
      provider: config.provider,
      model: config.model,
      error: err.message,
    });
    return {
      text: '',
      usedAi: false,
      provider: looksLikeOllama(config) ? 'ollama' : config.provider,
      model: config.model,
      moduleKey: config.moduleKey || taskType || null,
      reason: err.message,
      usage: baseUsage,
      estimatedCostMinor: null,
    };
  }
}

async function probeProvider(config) {
  const readiness = getReadiness(config);
  if (!readiness.ready) {
    return { ok: false, status: 'blocked', reason: readiness.reason, latencyMs: null };
  }

  const startedAt = Date.now();
  let url = '';
  const headers = {};
  if (looksLikeOllama(config)) {
    url = joinEndpoint(config.baseUrl, '/api/tags');
  } else if (config.provider === 'anthropic') {
    url = joinEndpoint(config.baseUrl, `/v1/models/${encodeURIComponent(config.model)}`);
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = process.env.ANTHROPIC_VERSION || process.env.ANTHROPIC_API_VERSION || '2023-06-01';
  } else {
    url = joinEndpoint(config.baseUrl, '/v1/models');
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 8_000)),
    });
    return {
      ok: response.ok,
      status: response.ok ? 'reachable' : 'error',
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      reason: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      reason: err.message,
    };
  }
}

export async function getClinicalAiRuntimeStatus({
  live = false,
  days = 7,
  tenantId = null,
  tenantRegion = null,
} = {}) {
  const modules = await listClinicalAiModules({ tenantId });
  const guardrails = await getClinicalAiGuardrails();
  const config = getProviderConfig(null, guardrails);
  const usage = await getClinicalAiUsageSummary({ days, tenantId });
  const budget = await getClinicalAiBudgetStatus({ days: 1, guardrails, tenantId });
  const readiness = getReadiness(config, budget);
  const providerHealth = live
    ? await probeProvider(config)
    : { ok: readiness.ready, status: readiness.ready ? 'configured' : 'blocked', reason: readiness.reason, latencyMs: null };

  return {
    config: serializeClinicalAiConfig(config, readiness),
    providerHealth,
    guardrails,
    budget,
    modules,
    usage,
    adapters: buildAdapterReadiness({ tenantRegion }),
  };
}

export default {
  generateClinicalText,
  getClinicalAiConfig,
  getClinicalAiRuntimeStatus,
};
