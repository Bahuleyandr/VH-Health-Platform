import logger from '../../logging/logger.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL = 'llama3.1:8b';
const DEFAULT_MAX_TOKENS = 2200;
const SUPPORTED_PROVIDERS = ['template', 'ollama', 'openai-compatible', 'openai', 'anthropic'];
const EXTERNAL_PROVIDERS = new Set(['openai', 'anthropic']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase().trim());
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

function getProviderConfig() {
  const provider = normalizeProvider(process.env.CLINICAL_AI_PROVIDER || process.env.AI_PROVIDER || 'template');
  const explicitBaseUrl = process.env.CLINICAL_AI_BASE_URL || process.env.AI_SUMMARIZE_URL || '';
  const baseUrl = normalizeBaseUrl(explicitBaseUrl || defaultBaseUrl(provider));
  const model = process.env.CLINICAL_AI_MODEL || process.env.AI_SUMMARIZE_MODEL || DEFAULT_MODEL;
  const timeoutMs = Math.min(
    Math.max(parseInt(process.env.CLINICAL_AI_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS, 5_000),
    120_000
  );
  const maxTokens = Math.min(
    Math.max(parseInt(process.env.CLINICAL_AI_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS, 256),
    8000
  );
  const temperature = Math.min(
    Math.max(Number.parseFloat(process.env.CLINICAL_AI_TEMPERATURE || '0.15'), 0),
    1
  );
  const apiKey = getApiKey(provider);
  const allowExternal = boolEnv(process.env.CLINICAL_AI_ALLOW_EXTERNAL);
  const externalProvider = EXTERNAL_PROVIDERS.has(provider) || (
    provider === 'openai-compatible' && isExternalUrl(baseUrl)
  );

  return {
    provider,
    baseUrl,
    model,
    timeoutMs,
    maxTokens,
    temperature,
    apiKey,
    allowExternal,
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

function getReadiness(config) {
  if (!config.supported) {
    return { ready: false, reason: `Unsupported clinical AI provider: ${config.provider}` };
  }
  if (config.provider === 'template') {
    return { ready: false, reason: 'Clinical AI provider is template fallback' };
  }
  if (!config.baseUrl) {
    return { ready: false, reason: 'No clinical AI endpoint configured' };
  }
  if (config.externalProvider && !config.allowExternal) {
    return {
      ready: false,
      reason: 'External clinical AI providers require CLINICAL_AI_ALLOW_EXTERNAL=true',
    };
  }
  if (EXTERNAL_PROVIDERS.has(config.provider) && !config.apiKey) {
    return { ready: false, reason: `${config.provider} clinical AI API key is not configured` };
  }
  return { ready: true, reason: null };
}

async function callOllama(config, prompt, systemPrompt) {
  const url = joinEndpoint(config.baseUrl, '/api/generate');
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
  return payload.response || '';
}

async function callOpenAICompatible(config, userPrompt, systemPrompt) {
  const url = joinEndpoint(config.baseUrl, '/v1/chat/completions');
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
  return readOpenAIText(payload);
}

async function callAnthropic(config, userPrompt, systemPrompt) {
  const url = joinEndpoint(config.baseUrl, '/v1/messages');
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
  return readAnthropicText(payload);
}

export function getClinicalAiConfig() {
  const config = getProviderConfig();
  const readiness = getReadiness(config);
  return {
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

export async function generateClinicalText({ systemPrompt, userPrompt, taskType }) {
  const config = getProviderConfig();
  const readiness = getReadiness(config);

  if (!readiness.ready) {
    return {
      text: '',
      usedAi: false,
      provider: config.provider === 'template' ? 'template' : config.provider,
      model: config.model,
      reason: readiness.reason,
    };
  }

  try {
    let text = '';
    if (looksLikeOllama(config)) {
      text = await callOllama(config, userPrompt, systemPrompt);
    } else if (config.provider === 'anthropic') {
      text = await callAnthropic(config, userPrompt, systemPrompt);
    } else {
      text = await callOpenAICompatible(config, userPrompt, systemPrompt);
    }

    if (!String(text || '').trim()) {
      throw new Error('Model returned empty content');
    }

    return {
      text: String(text).trim(),
      usedAi: true,
      provider: looksLikeOllama(config) ? 'ollama' : config.provider,
      model: config.model,
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
      reason: err.message,
    };
  }
}

export default {
  generateClinicalText,
  getClinicalAiConfig,
};
