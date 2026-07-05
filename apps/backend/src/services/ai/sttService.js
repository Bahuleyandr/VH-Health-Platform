/**
 * Speech-to-Text provider abstraction.
 *
 * Routes transcription to the provider configured per-tenant region.
 * Implementations today:
 *   - openai-compatible: OpenAI /v1/audio/transcriptions compatible endpoint
 *   - local_whisper: whisper.cpp REST server (on-prem, DPDP-safe)
 *   - azure: Azure Cognitive Services Speech (India region for DPDP tenants)
 *   - openai: OpenAI Whisper API (US — only for US-region tenants)
 *   - mock: canned transcript (test + dev)
 *   - none: no transcription (audio stored, transcript_status='skipped')
 *
 * All callers go through `transcribe()` — that function picks the right
 * backend based on env + tenant region, never exposes a provider SDK to
 * business logic, and never throws: STT failure yields a structured
 * { status:'failed', reason } response and the voice note still persists.
 */

import logger from '../../logging/logger.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 60_000;
const SUPPORTED_PROVIDERS = new Set(['none', 'openai-compatible', 'local_whisper', 'azure', 'openai', 'mock']);
const EXTERNAL_PROVIDERS = new Set(['openai-compatible', 'openai', 'azure']);

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

function normalizeProvider(value) {
  const provider = clean(value).toLowerCase().replace(/_/g, '-');
  if (provider === 'local-whisper') return 'local_whisper';
  return provider;
}

function getProvider(tenantRegion = null, env = process.env) {
  const configured = normalizeProvider(env.STT_PROVIDER || env.CLINICAL_AI_STT_PROVIDER || 'none');
  // Region safety mirror of the LLM routing: DPDP/GDPR tenants default to
  // local or tenant-approved providers. Explicit external providers still
  // pass through the region allowlist below.
  if (configured !== 'none') return configured;
  if (tenantRegion === 'IN') return 'none'; // require explicit local_whisper or azure config
  return 'none';
}

function getModel(provider, env = process.env) {
  switch (provider) {
    case 'openai-compatible':
      return clean(env.STT_MODEL || env.CLINICAL_AI_STT_MODEL) || null;
    case 'local_whisper':
      return env.CLINICAL_AI_STT_MODEL || 'whisper-large-v3';
    case 'azure':
      return env.CLINICAL_AI_STT_MODEL || 'azure-speech-v1';
    case 'openai':
      return env.CLINICAL_AI_STT_MODEL || 'whisper-1';
    case 'mock':
      return 'mock-transcriber';
    default:
      return null;
  }
}

function sttAllowedRegions(env = process.env) {
  return splitCsv(
    env.CLINICAL_AI_STT_ALLOWED_REGIONS
      || env.CLINICAL_AI_STT_REGIONS
      || env.CLINICAL_AI_EXTERNAL_REGIONS
  );
}

function regionAllowed(tenantRegion, allowedRegions) {
  if (!allowedRegions.length) return true;
  if (!tenantRegion) return false;
  const normalizedTenantRegion = normalizeRegion(tenantRegion);
  return allowedRegions.map(normalizeRegion).includes(normalizedTenantRegion);
}

function timeoutMs(env = process.env) {
  const configured = Number.parseInt(env.STT_TIMEOUT_MS || env.CLINICAL_AI_STT_TIMEOUT_MS || '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(configured, MIN_TIMEOUT_MS);
}

function openAiCompatibleBaseUrl(env = process.env) {
  return clean(env.STT_BASE_URL || env.CLINICAL_AI_STT_BASE_URL).replace(/\/+$/, '');
}

function resolveSttConfig({ tenantRegion = null, env = process.env } = {}) {
  const provider = getProvider(tenantRegion, env);
  const model = getModel(provider, env);
  const allowedRegions = sttAllowedRegions(env);
  const externalCall = EXTERNAL_PROVIDERS.has(provider);
  const apiKeyConfigured = Boolean(env.STT_API_KEY || env.CLINICAL_AI_STT_API_KEY || env.OPENAI_API_KEY || env.AZURE_SPEECH_KEY);
  const baseUrl = provider === 'openai-compatible' ? openAiCompatibleBaseUrl(env) : null;
  const endpointConfigured = provider === 'openai-compatible'
    ? Boolean(baseUrl)
    : provider !== 'none';
  const configuredTimeoutMs = timeoutMs(env);

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return {
      provider,
      model,
      configured: false,
      reason: 'stt_provider_unsupported',
      external_call: false,
      endpoint_configured: false,
      api_key_configured: null,
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: configuredTimeoutMs,
      default_language: clean(env.STT_LANGUAGE) || null,
      prompt_configured: Boolean(clean(env.STT_PROMPT)),
    };
  }

  if (externalCall && !regionAllowed(tenantRegion, allowedRegions)) {
    return {
      provider,
      model,
      configured: false,
      reason: 'tenant_region_not_allowed_for_stt',
      external_call: true,
      endpoint_configured: true,
      api_key_configured: apiKeyConfigured,
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: configuredTimeoutMs,
      default_language: clean(env.STT_LANGUAGE) || null,
      prompt_configured: Boolean(clean(env.STT_PROMPT)),
    };
  }

  if (provider === 'openai-compatible' && !baseUrl) {
    return {
      provider,
      model,
      configured: false,
      reason: 'stt_endpoint_not_configured',
      external_call: externalCall,
      endpoint_configured: false,
      api_key_configured: apiKeyConfigured,
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: configuredTimeoutMs,
      default_language: clean(env.STT_LANGUAGE) || null,
      prompt_configured: Boolean(clean(env.STT_PROMPT)),
    };
  }

  if (provider === 'openai-compatible' && !model) {
    return {
      provider,
      model,
      configured: false,
      reason: 'stt_model_not_configured',
      external_call: externalCall,
      endpoint_configured: true,
      api_key_configured: apiKeyConfigured,
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: configuredTimeoutMs,
      default_language: clean(env.STT_LANGUAGE) || null,
      prompt_configured: Boolean(clean(env.STT_PROMPT)),
    };
  }

  return {
    provider,
    model,
    configured: provider !== 'none',
    reason: provider === 'none' ? 'stt_provider_not_configured' : null,
    external_call: externalCall,
    endpoint_configured: endpointConfigured,
    api_key_configured: externalCall ? apiKeyConfigured : null,
    tenant_region: tenantRegion || null,
    allowed_regions: allowedRegions,
    timeout_ms: configuredTimeoutMs,
    default_language: clean(env.STT_LANGUAGE) || null,
    prompt_configured: Boolean(clean(env.STT_PROMPT)),
  };
}

async function callLocalWhisper({ audioBuffer, mimeType, language = 'en' }) {
  const baseUrl = (process.env.CLINICAL_AI_STT_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), 'audio');
  form.append('language', language);
  form.append('response_format', 'json');
  const response = await fetch(`${baseUrl}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`local_whisper returned ${response.status}`);
  }
  const payload = await response.json();
  return {
    text: String(payload.text || payload.transcription || '').trim(),
    language: payload.language || language,
  };
}

async function callOpenAICompatible({ audioBuffer, mimeType, language = 'en', prompt = null }) {
  const baseUrl = openAiCompatibleBaseUrl();
  if (!baseUrl) throw new Error('openai_compatible_stt_base_url_missing');
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), 'audio.wav');
  form.append('model', getModel('openai-compatible'));
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  form.append('response_format', 'json');
  const apiKey = process.env.STT_API_KEY || process.env.CLINICAL_AI_STT_API_KEY || process.env.OPENAI_API_KEY;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`openai_compatible_stt_status_${response.status}`);
  }
  const payload = await response.json();
  return {
    text: String(payload.text || payload.transcript || payload.transcription || '').trim(),
    language: payload.language || language,
  };
}

async function callOpenAI({ audioBuffer, mimeType, language = 'en' }) {
  const apiKey = process.env.CLINICAL_AI_STT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openai_stt_key_missing');
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/wav' }), 'audio.wav');
  form.append('model', getModel('openai'));
  form.append('language', language);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`openai_stt_status_${response.status}`);
  }
  const payload = await response.json();
  return { text: String(payload.text || '').trim(), language };
}

async function callAzure({ audioBuffer, mimeType, language = 'en-IN' }) {
  const apiKey = process.env.CLINICAL_AI_STT_API_KEY || process.env.AZURE_SPEECH_KEY;
  const region = process.env.CLINICAL_AI_STT_AZURE_REGION || 'centralindia';
  if (!apiKey) throw new Error('azure_stt_key_missing');
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(language)}&format=detailed`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': mimeType || 'audio/wav',
      Accept: 'application/json',
    },
    body: audioBuffer,
    signal: AbortSignal.timeout(timeoutMs()),
  });
  if (!response.ok) {
    throw new Error(`azure_stt_status_${response.status}`);
  }
  const payload = await response.json();
  const best = payload.NBest?.[0];
  return {
    text: String(best?.Display || payload.DisplayText || '').trim(),
    language,
  };
}

function mockTranscribe({ audioBuffer, language = 'en' }) {
  const size = audioBuffer?.byteLength || audioBuffer?.length || 0;
  return {
    text: `[mock transcript for ${size}-byte audio] Patient reports improved breathing. Cough reduced. No new complaints. Plan: continue current antibiotics, discharge if stable overnight.`,
    language,
  };
}

/**
 * Transcribe an audio buffer. Returns { status, text, language, provider,
 * model, reason } — never throws. On provider failure, status='failed' and
 * reason is a structured code so audit + self-healing can react.
 */
export async function transcribe({
  audioBuffer,
  mimeType = 'audio/wav',
  language = null,
  tenantRegion = null,
} = {}) {
  const config = resolveSttConfig({ tenantRegion });
  const { provider, model } = config;

  if (!config.configured) {
    return {
      status: config.reason === 'stt_provider_not_configured' ? 'skipped' : 'blocked',
      provider,
      model,
      text: null,
      language: null,
      reason: config.reason,
    };
  }

  try {
    let result;
    const lang = language || config.default_language || (tenantRegion === 'IN' ? 'en-IN' : 'en');
    if (provider === 'openai-compatible') {
      result = await callOpenAICompatible({
        audioBuffer,
        mimeType,
        language: lang,
        prompt: clean(process.env.STT_PROMPT) || null,
      });
    } else if (provider === 'local_whisper') result = await callLocalWhisper({ audioBuffer, mimeType, language: lang });
    else if (provider === 'azure') result = await callAzure({ audioBuffer, mimeType, language: lang });
    else if (provider === 'openai') result = await callOpenAI({ audioBuffer, mimeType, language: lang });
    else if (provider === 'mock') result = mockTranscribe({ audioBuffer, language: lang });
    else throw new Error(`unknown_stt_provider:${provider}`);

    if (!result.text) {
      return {
        status: 'failed',
        provider,
        model,
        text: null,
        language: result.language || lang,
        reason: 'empty_transcript',
      };
    }
    return {
      status: 'completed',
      provider,
      model,
      text: result.text,
      language: result.language || lang,
      reason: null,
    };
  } catch (err) {
    logger.warn('STT provider call failed', { provider, error: err.message });
    return {
      status: 'failed',
      provider,
      model,
      text: null,
      language: null,
      reason: err.message.slice(0, 200),
    };
  }
}

export function describeSttConfig({ tenantRegion = null } = {}) {
  const config = resolveSttConfig({ tenantRegion });
  return {
    provider: config.provider,
    model: config.model,
    configured: config.configured,
    reason: config.reason,
    external_call: config.external_call,
    endpoint_configured: config.endpoint_configured,
    api_key_configured: config.api_key_configured,
    tenant_region: config.tenant_region,
    allowed_regions: config.allowed_regions,
    timeout_ms: config.timeout_ms,
    default_language: config.default_language,
    prompt_configured: config.prompt_configured,
  };
}

export default { transcribe, describeSttConfig };
