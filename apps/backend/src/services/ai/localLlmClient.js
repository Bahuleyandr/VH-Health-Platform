import logger from '../../logging/logger.js';
// Cycle-safe metric incrementer. localLlmClient.js depends ONLY on this one
// function symbol from the metrics layer — never the Counter class or the
// rest of prometheusMiddleware's load graph — exactly like src/lib/prisma.js
// depends only on recordUndefinedTableFallback. That keeps the AI client free
// of any prisma↔metrics-style import cycle (mirrors the B2.5 pattern).
import { recordDeepTemplateFallback } from '../../middleware/prometheusMiddleware.js';
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
// AI-6 (WS5 B5.1): bounded retries before the template fallback. A single
// transient blip (provider timeout, 5xx, empty completion) used to drop the
// draft straight to the template fallback; on a high-risk module that quietly
// degrades the output. Generation calls here are idempotent (no side effects
// on the provider), so retrying transient failures a small, bounded number of
// times is safe. Non-transient failures (4xx, unsupported provider, parse
// errors) are NOT retried — they will not succeed on a second attempt.
// Tunable via env so deployments (and tests) can tighten/relax the schedule.
const RETRY_MAX_ATTEMPTS = Math.min(
  Math.max(safeIntEnv(process.env.CLINICAL_AI_RETRY_ATTEMPTS, 2), 0),
  5
);
const RETRY_BASE_DELAY_MS = Math.min(
  Math.max(safeIntEnv(process.env.CLINICAL_AI_RETRY_BASE_MS, 250), 0),
  10_000
);
const RETRY_MAX_DELAY_MS = Math.min(
  Math.max(safeIntEnv(process.env.CLINICAL_AI_RETRY_MAX_MS, 2_000), RETRY_BASE_DELAY_MS),
  30_000
);

function safeIntEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Exponential backoff with full jitter. `attempt` is 0-based (the delay
 * applied BEFORE the (attempt+1)-th retry). Full jitter (random in
 * [0, cappedBackoff]) avoids retry stampedes when many drafts fail at once.
 */
function retryDelayMs(attempt) {
  const exp = RETRY_BASE_DELAY_MS * (2 ** attempt);
  const capped = Math.min(exp, RETRY_MAX_DELAY_MS);
  return Math.floor(Math.random() * (capped + 1));
}

/**
 * Classify whether a provider failure is worth retrying. Transient =
 * timeout/abort, network reset, HTTP 5xx, HTTP 429, or an empty completion.
 * Everything else (4xx other than 429, unsupported provider, JSON parse
 * failures) is permanent for an idempotent retry and falls through to the
 * template fallback immediately.
 */
function isTransientProviderError(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;
  const status = Number(err.httpStatus);
  if (Number.isFinite(status)) {
    return status === 429 || (status >= 500 && status <= 599);
  }
  const name = String(err.name || '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const msg = String(err.message || '').toLowerCase();
  return (
    msg.includes('timeout')
    || msg.includes('timed out')
    || msg.includes('aborted')
    || msg.includes('network')
    || msg.includes('socket')
    || msg.includes('econnreset')
    || msg.includes('econnrefused')
    || msg.includes('connection refused')
    || msg.includes('fetch failed')
    || msg.includes('empty content')
  );
}
const SUPPORTED_PROVIDERS = ['template', 'ollama', 'openai-compatible', 'openai', 'anthropic'];
const EXTERNAL_PROVIDERS = new Set(['openai', 'anthropic']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

// Model tiers — adapted from TauricResearch/TradingAgents' deep_think_llm /
// quick_think_llm split. A module that declares `settings.model_tier:
// 'deep'` is routed to the deep config (defaults: a stronger external
// model behind CLINICAL_AI_DEEP_*); everything else uses the standard
// CLINICAL_AI_* config. The deep tier is opt-in per module so cost stays
// predictable. Cross-region PHI egress + budget guardrails still gate the
// deep tier exactly like the standard tier.
const VALID_TIERS = new Set(['quick', 'deep']);

function normalizeTier(value) {
  const raw = String(value || '').toLowerCase().trim();
  return VALID_TIERS.has(raw) ? raw : 'quick';
}

/**
 * A module is "high-assurance" — i.e. a silent template fallback is a SAFETY
 * hazard worth a named metric + WARN — when it is deep-tier OR critical-risk OR
 * requires clinician sign-off. These are the modules whose drafts a clinician
 * trusts as AI-assisted; if they quietly degrade to a deterministic template
 * the clinician is misled. Tier/risk/signoff all live under module.settings
 * (model_tier|modelTier, risk, requiresClinicianSignoff) — read defensively so
 * an unregistered/typo'd module (which defaults to signoff-required) is still
 * treated as high-assurance. Quick-tier, non-critical, no-signoff modules
 * (e.g. routine summaries) are intentionally excluded so normal degradation
 * stays quiet.
 */
function isHighAssuranceModule(module, tier) {
  if (normalizeTier(tier) === 'deep') return true;
  const settings = module?.settings || {};
  const risk = String(settings.risk || '').toLowerCase().trim();
  if (risk === 'critical') return true;
  if (settings.requiresClinicianSignoff === true) return true;
  return false;
}

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

function getApiKey(provider, tier = 'quick') {
  // Deep-tier first: CLINICAL_AI_DEEP_API_KEY beats everything else when
  // the module asks for the deep tier. Falls back to the standard chain
  // so deployments that reuse one key for both tiers keep working.
  if (tier === 'deep' && process.env.CLINICAL_AI_DEEP_API_KEY) {
    return process.env.CLINICAL_AI_DEEP_API_KEY;
  }
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
 * (e.g. `US,AP`). External egress is allowed ONLY when a tenant's region is
 * explicitly allow-listed.
 *
 * FAIL-CLOSED default (audit 2026-06-18, §3/§6): an empty/unset allowlist no
 * longer means "every region is allowed". A tenant that CARRIES a region is
 * DENIED external use until that region is explicitly listed — so onboarding a
 * second region can never silently start exporting its PHI cross-region.
 *
 * Two documented escapes are preserved so the single-tenant pilot keeps working
 * out of the box:
 *   - A tenant with NO region (single-tenant deployments don't tag a region) is
 *     allowed when the allowlist is empty. As soon as an allowlist IS set, even
 *     a region-less tenant is denied (it can't be matched against the list).
 *   - An explicit wildcard `CLINICAL_AI_EXTERNAL_REGIONS=*` allows every region
 *     (deliberate, audited opt-out of the region gate).
 */
function tenantCanUseExternal(tenantRegion) {
  const raw = (process.env.CLINICAL_AI_EXTERNAL_REGIONS || '').trim();
  if (!raw) {
    // Empty/unset allowlist: fail closed for any region-bearing tenant, but
    // keep the single-tenant pilot (no region tagged) working.
    return !tenantRegion;
  }
  const allowed = raw.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  if (allowed.includes('*')) return true;
  if (!tenantRegion) return false;
  return allowed.includes(String(tenantRegion).trim().toUpperCase());
}

function externalRegionBlockReason(tenantRegion) {
  if (tenantCanUseExternal(tenantRegion)) return null;
  const blockedRegion = tenantRegion ? String(tenantRegion).trim().toUpperCase() : 'UNKNOWN';
  return `external_provider_blocked_for_region:${blockedRegion}`;
}

// Tier-prefixed env helper. When the module is in the deep tier, prefer
// CLINICAL_AI_DEEP_* env vars; fall back to the unprefixed CLINICAL_AI_*
// (so a deployment with one set of credentials keeps working without any
// changes). The non-deep path is unchanged from the legacy behaviour.
function tieredEnv(tier, suffix) {
  if (tier === 'deep') {
    const deepValue = process.env[`CLINICAL_AI_DEEP_${suffix}`];
    if (deepValue !== undefined && deepValue !== '') return deepValue;
  }
  return process.env[`CLINICAL_AI_${suffix}`] || '';
}

function getProviderConfig(module = null, guardrails = null) {
  const tier = normalizeTier(
    module?.settings?.model_tier
      || module?.settings?.modelTier
      || module?.model_tier
      || module?.modelTier
  );
  const tierProvider = tieredEnv(tier, 'PROVIDER');
  const provider = normalizeProvider(
    module?.provider_override
      || tierProvider
      || process.env.AI_PROVIDER
      || 'template'
  );
  const tierBaseUrl = tieredEnv(tier, 'BASE_URL');
  const explicitBaseUrl = tierBaseUrl || process.env.AI_SUMMARIZE_URL || '';
  const baseUrl = normalizeBaseUrl(explicitBaseUrl || defaultBaseUrl(provider));
  const tierModel = tieredEnv(tier, 'MODEL');
  const model = module?.model_override
    || tierModel
    || process.env.AI_SUMMARIZE_MODEL
    || DEFAULT_MODEL;
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
  const apiKey = getApiKey(provider, tier);
  const allowExternal = module
    ? boolEnv(process.env.CLINICAL_AI_ALLOW_EXTERNAL) && Boolean(module.external_allowed)
    : boolEnv(process.env.CLINICAL_AI_ALLOW_EXTERNAL);
  const externalProvider = EXTERNAL_PROVIDERS.has(provider) || (
    provider === 'openai-compatible' && isExternalUrl(baseUrl)
  );

  return {
    module,
    moduleKey: module?.module_key || null,
    tier,
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

/**
 * Strip chain-of-thought / reasoning tags emitted by reasoning models.
 *
 * Pattern observed in production:
 *   - MiniMax-M2.7-highspeed wraps every reply in `<think>...</think>` before
 *     the final answer (verified 2026-05-02 via direct API call).
 *   - DeepSeek-R1, GLM-4-Plus, and several open-weight reasoning models use
 *     the same tag convention.
 *   - Anthropic + OpenAI emit reasoning tokens in a separate field, not
 *     inline in `content`, so this is a no-op for them.
 *
 * Stripping is safe on non-reasoning models — the regex simply doesn't
 * match. We strip ALL `<think>...</think>` blocks (some models emit
 * multiple) and trim residual whitespace.
 *
 * Done at extraction time so downstream JSON parsing in the explainer
 * pipelines and `safeJsonParse` see clean text.
 */
export function stripReasoningTags(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function readOpenAIText(payload) {
  const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text ?? '';
  if (Array.isArray(content)) {
    return stripReasoningTags(
      content
        .map((part) => part?.text || part?.content || '')
        .join('')
        .trim(),
    );
  }
  return stripReasoningTags(String(content || '').trim());
}

function readAnthropicText(payload) {
  return stripReasoningTags(
    (payload.content || [])
      .filter((part) => part?.type === 'text' && part.text)
      .map((part) => part.text)
      .join('')
      .trim(),
  );
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
    const err = new Error(`Ollama returned HTTP ${response.status}`);
    err.httpStatus = response.status;
    throw err;
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
  return { text: stripReasoningTags(payload.response || ''), usage };
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
    const err = new Error(`OpenAI-compatible endpoint returned HTTP ${response.status}`);
    err.httpStatus = response.status;
    throw err;
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

/**
 * Conservatively normalize a JSON schema for Anthropic structured outputs
 * (`output_config.format` on /v1/messages). Structured outputs require
 * `additionalProperties: false` on every object node; we additionally require
 * every object node to declare non-empty `properties` and every `required` key
 * to exist in them, so the loose registry stubs (e.g. `{type:'object',
 * required:[...]}` with no properties) NEVER activate structured output —
 * they'd be rejected by the API and would only burn a request. Returns the
 * normalized deep copy, or null when the schema is absent/too loose to send.
 * Exported for unit tests.
 */
export function normalizeStructuredOutputSchema(schema) {
  const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'null']);
  const normalizeNode = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    if (node.type === 'object') {
      const properties = node.properties;
      if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;
      const keys = Object.keys(properties);
      if (!keys.length) return null;
      const outProps = {};
      for (const key of keys) {
        const child = normalizeNode(properties[key]);
        if (!child) return null;
        outProps[key] = child;
      }
      const required = Array.isArray(node.required) ? node.required : [];
      if (!required.every((key) => Object.prototype.hasOwnProperty.call(outProps, key))) return null;
      return { ...node, type: 'object', properties: outProps, required, additionalProperties: false };
    }
    if (node.type === 'array') {
      const items = normalizeNode(node.items);
      if (!items) return null;
      return { ...node, items };
    }
    if (SCALAR_TYPES.has(node.type)) return { ...node };
    // anyOf/enum-only/unknown nodes: reject the whole schema rather than risk
    // sending something the endpoint refuses.
    return null;
  };
  const normalized = normalizeNode(schema);
  return normalized && normalized.type === 'object' ? normalized : null;
}

async function callAnthropic(config, userPrompt, systemPrompt, { jsonSchema = null } = {}) {
  const url = joinEndpoint(config.baseUrl, '/v1/messages');
  const structuredSchema = normalizeStructuredOutputSchema(jsonSchema);

  const attempt = async (withSchema) => {
    const startedAt = Date.now();
    const body = {
      model: config.model,
      max_tokens: config.maxTokens,
      // NOTE: no `temperature`. Current Anthropic models (4.6-family onward)
      // reject non-default sampling parameters with a 400; the framework's
      // risk-tier temperature still applies to the ollama/openai paths.
      // Determinism for high-risk modules is carried by the prompt and, where
      // a schema is available, by structured outputs below.
      //
      // Prompt caching: module system prompts are stable per prompt version,
      // so mark the system block cacheable — repeated drafts against the same
      // module reuse the cached prefix (usage parsing below already sums
      // cache_creation/cache_read token fields). Short prompts silently skip
      // caching; that is harmless.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (withSchema) {
      body.output_config = { format: { type: 'json_schema', schema: structuredSchema } };
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || process.env.ANTHROPIC_API_VERSION || '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      const err = new Error(`Anthropic endpoint returned HTTP ${response.status}`);
      err.httpStatus = response.status;
      throw err;
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
    // Safety-classifier refusal: HTTP 200 with stop_reason 'refusal' and empty
    // (or partial) content. NON-RETRYABLE — re-sending the same prompt cannot
    // succeed, so it must not burn the transient-retry budget as "empty
    // content". The thrown reason (with the PHI-free stop_details category)
    // flows into the labeled template-fallback path and the generation row.
    if (payload.stop_reason === 'refusal') {
      const category = payload.stop_details?.category
        ? String(payload.stop_details.category).slice(0, 60)
        : null;
      const err = new Error(category ? `anthropic_refusal:${category}` : 'anthropic_refusal');
      err.retryable = false;
      err.usage = usage; // refusal tokens are billed; keep them accountable
      throw err;
    }
    return { text: readAnthropicText(payload), usage };
  };

  try {
    return await attempt(Boolean(structuredSchema));
  } catch (err) {
    // Endpoint rejected the structured-output schema (e.g. an unsupported
    // constraint survived normalization). One plain retry without
    // output_config — the caller's fence-stripping JSON parser remains the
    // fallback, exactly as on providers without structured-output support.
    if (structuredSchema && Number(err.httpStatus) === 400) {
      logger.warn('Anthropic rejected structured-output schema; retrying without output_config', {
        model: config.model,
        module: config.moduleKey,
      });
      return attempt(false);
    }
    throw err;
  }
}

function serializeClinicalAiConfig(config, readiness) {
  return {
    moduleKey: config.moduleKey,
    tier: config.tier || 'quick',
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

function fallbackModeForReadiness(config, reason) {
  if (config.provider === 'template' || /template fallback/i.test(String(reason || ''))) {
    return 'template_fallback';
  }
  return 'blocked';
}

/**
 * Loud signal for the silent-template-fallback hazard. When a HIGH-ASSURANCE
 * module (deep-tier OR critical OR clinician-signoff) drops to the
 * deterministic TEMPLATE draft (used_ai=false), increment the named
 * clinical_ai_deep_template_fallback_total counter (module + tier labels) and
 * emit a WARN — so what used to be a silent degradation becomes observable on
 * /metrics and in the logs.
 *
 * Scoped to generation_mode === 'template_fallback' ONLY. Deliberate policy
 * denials ('blocked' — external-not-allowed, region-blocked, budget tripped,
 * module disabled) are NOT silent degradation and are intentionally excluded.
 * Normal quick-tier / non-critical / no-signoff fallbacks are also excluded so
 * routine degradation stays quiet (no metric noise, no alert fatigue).
 *
 * Never throws — metric/log emission is best-effort and must never break the
 * generation hot path (the caller is already returning a safe template draft).
 */
function signalDeepTemplateFallback({ module, config, taskType, reason }) {
  try {
    if (!isHighAssuranceModule(module, config.tier)) return;
    const moduleLabel = config.moduleKey || taskType || 'unknown';
    const tierLabel = normalizeTier(config.tier);
    recordDeepTemplateFallback({ module: moduleLabel, tier: tierLabel });
    logger.warn('Clinical AI deep/critical module fell back to template draft (used_ai=false)', {
      module: moduleLabel,
      tier: tierLabel,
      provider: config.provider,
      model: config.model,
      risk: module?.settings?.risk || null,
      requiresClinicianSignoff: module?.settings?.requiresClinicianSignoff === true,
      reason: String(reason || '').slice(0, 200),
    });
  } catch (err) {
    // Defensive: never let observability break the safe-fallback return.
    logger.warn('Failed to record deep template fallback signal', { error: err?.message });
  }
}

function nonAiResult({
  config,
  taskType,
  reason,
  usage,
  generationMode,
  providerStatus,
  provider = null,
}) {
  return {
    text: '',
    usedAi: false,
    provider: provider || config.provider,
    model: config.model,
    tier: config.tier,
    moduleKey: config.moduleKey || taskType || null,
    reason,
    fallback_reason: generationMode === 'template_fallback' ? reason : null,
    readiness_reason: reason,
    generation_mode: generationMode,
    provider_status: providerStatus || generationMode,
    usage,
    estimatedCostMinor: null,
  };
}

export function getClinicalAiConfig() {
  const config = getProviderConfig();
  const readiness = getReadiness(config);
  return serializeClinicalAiConfig(config, readiness);
}

/**
 * Test-only helper: returns the resolved provider config for a synthetic
 * module without touching the DB or invoking a model. The unit suite for
 * the deep/quick tier routing exercises this; production callers should
 * keep using getClinicalAiConfig() / generateClinicalText().
 */
export function _resolveProviderConfigForTesting(module = null, guardrails = null) {
  const config = getProviderConfig(module, guardrails);
  return {
    tier: config.tier,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: config.apiKey,
    serialized: serializeClinicalAiConfig(config, getReadiness(config)),
  };
}

export async function generateClinicalText({
  systemPrompt,
  userPrompt,
  taskType,
  tenantRegion = null,
  tenantId = null,
  // Optional JSON contract for the draft. On the Anthropic provider a
  // well-formed schema is enforced server-side via structured outputs
  // (output_config.format); other providers ignore it and callers keep
  // parsing the text with their existing fence-stripping fallback.
  jsonSchema = null,
}) {
  const module = await getClinicalAiModule(taskType, { tenantId });
  const guardrails = await getClinicalAiGuardrails();
  const budgetStatus = await getClinicalAiBudgetStatus({ days: 1, guardrails, tenantId });
  const config = getProviderConfig(module, guardrails);
  const readiness = getReadiness(config, budgetStatus);
  const baseUsage = emptyUsage();

  // Region-safety: block external PHI egress for tenants whose region is not
  // on the allowlist. Local providers pass through; external ones fall back
  // to the template with a clear reason written to the draft metadata.
  const regionBlockReason = config.externalProvider ? externalRegionBlockReason(tenantRegion) : null;
  if (regionBlockReason) {
    logger.warn('External provider blocked by region policy', {
      taskType,
      tier: config.tier,
      provider: config.provider,
      tenantRegion,
    });
    return nonAiResult({
      config,
      taskType,
      reason: regionBlockReason,
      usage: baseUsage,
      generationMode: 'blocked',
      providerStatus: 'blocked',
    });
  }

  if (!readiness.ready) {
    const generationMode = fallbackModeForReadiness(config, readiness.reason);
    if (generationMode === 'template_fallback') {
      signalDeepTemplateFallback({ module, config, taskType, reason: readiness.reason });
    }
    return nonAiResult({
      config,
      taskType,
      reason: readiness.reason,
      usage: baseUsage,
      generationMode,
      providerStatus: generationMode,
    });
  }

  // AI-6: bounded retry loop. Try once, then retry transient failures up to
  // RETRY_MAX_ATTEMPTS more times with jittered backoff. Permanent failures
  // (4xx, parse errors) break out immediately. On exhaustion or a permanent
  // failure we fall through to the clearly-labelled template fallback below.
  const totalAttempts = 1 + RETRY_MAX_ATTEMPTS;
  let lastError = null;
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      let result;
      if (looksLikeOllama(config)) {
        result = await callOllama(config, userPrompt, systemPrompt);
      } else if (config.provider === 'anthropic') {
        result = await callAnthropic(config, userPrompt, systemPrompt, { jsonSchema });
      } else {
        result = await callOpenAICompatible(config, userPrompt, systemPrompt);
      }
      const { text, usage } = result;

      if (!String(text || '').trim()) {
        const emptyErr = new Error('Model returned empty content');
        emptyErr.retryable = true;
        throw emptyErr;
      }
      const estimatedCostMinor = estimateCostMinor(config, usage);

      if (attempt > 0) {
        logger.info('Clinical AI generation succeeded after retry', {
          taskType,
          tier: config.tier,
          provider: config.provider,
          model: config.model,
          attempts: attempt + 1,
        });
      }

      return {
        text: String(text).trim(),
        usedAi: true,
        provider: looksLikeOllama(config) ? 'ollama' : config.provider,
        model: config.model,
        tier: config.tier,
        moduleKey: config.moduleKey || taskType || null,
        generation_mode: 'ai',
        fallback_reason: null,
        readiness_reason: null,
        provider_status: 'used',
        usage,
        estimatedCostMinor,
        retry_attempts: attempt,
      };
    } catch (err) {
      lastError = err;
      const transient = isTransientProviderError(err);
      const hasMoreAttempts = attempt < totalAttempts - 1;
      if (transient && hasMoreAttempts) {
        const delayMs = retryDelayMs(attempt);
        logger.warn('Clinical AI generation transient failure; retrying', {
          taskType,
          tier: config.tier,
          provider: config.provider,
          model: config.model,
          attempt: attempt + 1,
          max_attempts: totalAttempts,
          delay_ms: delayMs,
          error: err.message,
        });
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }

  logger.warn('Clinical AI generation failed; falling back to template', {
    taskType,
    tier: config.tier,
    provider: config.provider,
    model: config.model,
    attempts: totalAttempts,
    transient_last_error: isTransientProviderError(lastError),
    error: lastError?.message,
  });
  // This is the canonical silent-degradation path the readiness gate guards:
  // a deep model that isn't pulled/reachable fails generation and lands here.
  // Raise the named metric + targeted WARN for high-assurance modules.
  signalDeepTemplateFallback({
    module,
    config,
    taskType,
    reason: lastError?.message || 'clinical_ai_generation_failed',
  });
  return nonAiResult({
    config: { ...config, provider: looksLikeOllama(config) ? 'ollama' : config.provider },
    taskType,
    reason: lastError?.message || 'clinical_ai_generation_failed',
    // A provider refusal still bills the tokens it consumed — carry that
    // usage into the fallback row so budget accounting stays honest.
    usage: lastError?.usage || baseUsage,
    generationMode: 'template_fallback',
    providerStatus: 'error',
  });
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

/**
 * Match a configured model name against a provider's reported model list.
 *
 * Ollama tags are fully-qualified (`llama3.1:70b-instruct-q4_K_M`) and the
 * `:latest` tag is implicit when omitted — so `llama3.1` matches a pulled
 * `llama3.1:latest`. We accept an exact match OR a tag-prefix match in either
 * direction (configured `name` vs reported `name:tag`) so the common
 * "configured without an explicit tag" case resolves correctly without
 * over-matching unrelated families.
 */
function modelNameMatches(configuredModel, reportedName) {
  const want = String(configuredModel || '').trim().toLowerCase();
  const have = String(reportedName || '').trim().toLowerCase();
  if (!want || !have) return false;
  if (want === have) return true;
  const wantBase = want.split(':')[0];
  const haveBase = have.split(':')[0];
  if (wantBase !== haveBase) return false;
  // Same family/base. Match when either side omitted the tag (implicit
  // :latest) — i.e. one of them is exactly the base name.
  return want === wantBase || have === haveBase;
}

function extractOllamaTagNames(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  return models
    .map((m) => m?.name || m?.model || '')
    .filter(Boolean);
}

/**
 * Deep-tier model-pulled readiness (the silent-template-fallback safety fix).
 *
 * The existing probeProvider() only confirms the endpoint ANSWERS — for Ollama
 * a healthy daemon returns 200 on /api/tags even when the configured deep
 * model has never been pulled. Generation against an un-pulled model then
 * fails (or a cold pull blows the timeout) and drops to a silent template
 * draft. This probe closes that gap: it confirms the configured model NAME is
 * actually present in the provider's model list.
 *
 * Returns `{ checked, pulled, model, models, reason, latencyMs }`:
 *   - `checked:false` → we couldn't enumerate models (provider doesn't expose
 *     a list we parse, or the call itself was blocked/errored). `pulled` is
 *     null — "unknown", never asserted true.
 *   - `checked:true, pulled:true|false` → authoritative presence answer.
 *
 * Ollama is the parsed path (GET /api/tags). External providers (openai,
 * anthropic, openai-compatible) are intentionally `checked:false` here — their
 * model availability is an account/endpoint concern already covered by
 * probeProvider's per-model GET, and enumerating a remote catalogue is out of
 * scope for this local-GPU readiness gate. Never throws.
 */
async function probeModelPulled(config) {
  const readiness = getReadiness(config);
  if (!readiness.ready) {
    return { checked: false, pulled: null, model: config.model, models: [], reason: readiness.reason, latencyMs: null };
  }
  if (!looksLikeOllama(config)) {
    return {
      checked: false,
      pulled: null,
      model: config.model,
      models: [],
      reason: 'model_list_not_enumerated_for_provider',
      latencyMs: null,
    };
  }

  const startedAt = Date.now();
  const url = joinEndpoint(config.baseUrl, '/api/tags');
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {},
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 8_000)),
    });
    if (!response.ok) {
      return {
        checked: false,
        pulled: null,
        model: config.model,
        models: [],
        reason: `HTTP ${response.status}`,
        latencyMs: Date.now() - startedAt,
      };
    }
    const payload = await response.json();
    const models = extractOllamaTagNames(payload);
    const pulled = models.some((name) => modelNameMatches(config.model, name));
    return {
      checked: true,
      pulled,
      model: config.model,
      models,
      reason: pulled ? null : `model_not_pulled:${config.model}`,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      checked: false,
      pulled: null,
      model: config.model,
      models: [],
      reason: err.message,
      latencyMs: Date.now() - startedAt,
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
  const regionBlockReason = config.externalProvider ? externalRegionBlockReason(tenantRegion) : null;
  const effectiveReadiness = regionBlockReason
    ? { ready: false, reason: regionBlockReason }
    : readiness;
  const providerHealth = live
    ? (regionBlockReason
      ? { ok: false, status: 'blocked', reason: regionBlockReason, latencyMs: null }
      : await probeProvider(config))
    : {
      ok: effectiveReadiness.ready,
      status: effectiveReadiness.ready ? 'configured' : 'blocked',
      reason: effectiveReadiness.reason,
      latencyMs: null,
    };

  // Deep-tier model-pulled readiness (silent-template-fallback safety gate).
  // The top-level `config` above is quick-tier (module=null), so it can't tell
  // us whether the DEEP model (CLINICAL_AI_DEEP_*) is actually pulled. Resolve a
  // synthetic deep-tier config and, when a live probe is requested AND a deep
  // tier is actually configured (provider !== template), confirm the model is
  // present in the provider's list — surfacing a DISTINCT `deepModelPulled`
  // boolean. When not live, or when no deep tier is configured, we report the
  // configured-shape without a network call (deepModelPulled:null = unknown).
  // Synthetic deep-tier module: `enabled:true` so getReadiness() resolves the
  // PROVIDER readiness (not the module-disabled gate) — this probe is about the
  // deep model/endpoint, not whether any specific governed module is on.
  const deepConfig = getProviderConfig({ enabled: true, settings: { model_tier: 'deep' } }, guardrails);
  const deepTierConfigured = deepConfig.provider !== 'template';
  const deepReadiness = getReadiness(deepConfig, budget);
  const deepRegionBlockReason = deepConfig.externalProvider
    ? externalRegionBlockReason(tenantRegion)
    : null;
  const deepModelProbe = (live && deepTierConfigured && !deepRegionBlockReason)
    ? await probeModelPulled(deepConfig)
    : { checked: false, pulled: null, model: deepConfig.model, models: [], reason: null, latencyMs: null };
  const deepTier = {
    configured: deepTierConfigured,
    provider: deepConfig.provider,
    model: deepConfig.model,
    ready: deepRegionBlockReason ? false : deepReadiness.ready,
    readiness_reason: deepRegionBlockReason || deepReadiness.reason,
    // The headline safety boolean: true ONLY when we positively confirmed the
    // model is pulled. null = not checked / unknown (never asserted true).
    deepModelPulled: deepModelProbe.checked ? deepModelProbe.pulled : null,
    modelPulledChecked: deepModelProbe.checked,
    modelPulledReason: deepModelProbe.reason,
    available_models: deepModelProbe.models,
  };

  return {
    config: serializeClinicalAiConfig(config, effectiveReadiness),
    providerHealth,
    deepTier,
    guardrails,
    budget,
    modules,
    usage,
    adapters: buildAdapterReadiness({ tenantRegion }),
  };
}

/**
 * Enablement-gate readiness check for a deep-tier clinical-AI module
 * (Enablement-plan gate C3: "deep-tier producing real AI").
 *
 * Before an operator flips `enabled=true` on a deep/critical module, this
 * answers: is the configured model actually PULLED, and (optionally) does a
 * smoke generation return `used_ai=true` rather than a silent template draft?
 *
 * Resolves the module's REAL effective config (tenant override aware), so it
 * reflects exactly what generation would use. For non-deep modules it returns
 * `{ deepTier:false, ready:true }` — this gate only governs the deep tier and
 * must never block quick-tier enablement.
 *
 * Options:
 *   - `tenantId`      — resolve tenant-effective module config.
 *   - `tenantRegion`  — applied to the smoke gen's region egress check.
 *   - `smoke` (default true) — run a tiny generation and require used_ai=true.
 *                     Set false for a model-pulled-only check (no token spend).
 *
 * Returns a structured verdict; NEVER throws (callers gate on `.ready`):
 *   {
 *     module, deepTier, provider, model,
 *     modelPulled,        // true | false | null(unknown — not enumerable)
 *     modelPulledChecked,
 *     smokeRan, smokeUsedAi,
 *     ready,              // overall: safe to enable as a real-AI deep module
 *     reason,             // null when ready; else why not
 *   }
 */
export async function checkDeepModuleReadiness(moduleKey, {
  tenantId = null,
  tenantRegion = null,
  smoke = true,
} = {}) {
  const verdict = {
    module: moduleKey || null,
    deepTier: false,
    provider: null,
    model: null,
    modelPulled: null,
    modelPulledChecked: false,
    smokeRan: false,
    smokeUsedAi: null,
    ready: false,
    reason: null,
  };

  let module;
  try {
    module = await getClinicalAiModule(moduleKey, { tenantId });
  } catch (err) {
    verdict.reason = `module_lookup_failed:${err?.message || 'unknown'}`;
    return verdict;
  }

  const config = getProviderConfig(module, await getClinicalAiGuardrails().catch(() => null));
  verdict.provider = config.provider;
  verdict.model = config.model;
  verdict.deepTier = normalizeTier(config.tier) === 'deep';

  // Non-deep modules are out of scope for this gate — do not block them.
  if (!verdict.deepTier) {
    verdict.ready = true;
    verdict.reason = 'not_deep_tier';
    return verdict;
  }

  // Provider config must resolve to a real (non-template) provider.
  if (config.provider === 'template') {
    verdict.reason = 'deep_tier_provider_is_template';
    return verdict;
  }

  // Model-pulled probe (Ollama enumerated; external providers report unknown).
  const probe = await probeModelPulled(config);
  verdict.modelPulled = probe.checked ? probe.pulled : null;
  verdict.modelPulledChecked = probe.checked;
  if (probe.checked && probe.pulled === false) {
    verdict.reason = probe.reason || `model_not_pulled:${config.model}`;
    return verdict;
  }

  // Optional smoke generation — the authoritative "producing real AI" proof.
  if (smoke) {
    let result;
    try {
      result = await generateClinicalText({
        systemPrompt: 'Readiness smoke check. Reply with a short clinical-style acknowledgement.',
        userPrompt: 'Deep-tier model liveness probe. Respond briefly to confirm generation.',
        taskType: moduleKey,
        tenantRegion,
        tenantId,
      });
    } catch (err) {
      verdict.reason = `smoke_generation_threw:${err?.message || 'unknown'}`;
      return verdict;
    }
    verdict.smokeRan = true;
    verdict.smokeUsedAi = Boolean(result?.usedAi);
    if (!result?.usedAi) {
      verdict.reason = result?.fallback_reason
        || result?.readiness_reason
        || result?.reason
        || 'smoke_generation_used_template_fallback';
      return verdict;
    }
  } else if (!probe.checked) {
    // No smoke and we couldn't confirm the model is pulled → "unknown", not ready.
    verdict.reason = probe.reason || 'model_pulled_unknown_and_smoke_skipped';
    return verdict;
  }

  verdict.ready = true;
  return verdict;
}

/**
 * Thin assertion wrapper around checkDeepModuleReadiness for callers that want
 * a throw-on-not-ready gate (e.g. an enablement endpoint that should refuse to
 * flip a deep module ON until it provably produces real AI). Non-deep modules
 * pass through (the gate doesn't apply). Throws AppError-shaped via the caller;
 * here it throws a plain Error with a `.readiness` payload attached so the
 * enablement path can surface the exact blocking reason.
 */
export async function assertDeepModuleLive(moduleKey, options = {}) {
  const readiness = await checkDeepModuleReadiness(moduleKey, options);
  if (!readiness.ready) {
    const err = new Error(
      `Deep-tier module "${moduleKey}" is not producing real AI: ${readiness.reason}`
    );
    err.code = 'CLINICAL_AI_DEEP_MODULE_NOT_LIVE';
    err.readiness = readiness;
    throw err;
  }
  return readiness;
}

export default {
  generateClinicalText,
  getClinicalAiConfig,
  getClinicalAiRuntimeStatus,
  checkDeepModuleReadiness,
  assertDeepModuleLive,
};
