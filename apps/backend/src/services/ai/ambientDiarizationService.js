/**
 * Ambient diarization adapter.
 *
 * The ambient note workflow should not know provider-specific payload shapes.
 * This adapter accepts already-diarized provider output from capture clients
 * or a raw speaker-labelled transcript, can call a configured provider
 * webhook, normalizes the result into canonical transcript segments, and
 * leaves provider SDK/API details at the edge.
 */

const DEFAULT_TURN_SECONDS = 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1000;
const WORDS_PER_SECOND = 2.4;
const LOCAL_PROVIDERS = new Set(['none', 'local', 'speaker_hint_parser']);

const SPEAKER_ALIASES = new Map([
  ['clinician', 'doctor'],
  ['physician', 'doctor'],
  ['doctor', 'doctor'],
  ['dr', 'doctor'],
  ['nurse', 'doctor'],
  ['provider', 'doctor'],
  ['patient', 'patient'],
  ['pt', 'patient'],
  ['caregiver', 'caregiver'],
  ['attendant', 'caregiver'],
  ['family', 'caregiver'],
  ['other', 'other'],
]);

function clean(value) {
  return String(value ?? '').trim();
}

function splitCsv(value) {
  return clean(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function configuredProvider(env = process.env) {
  return clean(env.CLINICAL_AI_DIARIZATION_PROVIDER || 'none').toLowerCase() || 'none';
}

export function normalizeDiarizationProvider(provider = null, env = process.env) {
  const raw = clean(provider || configuredProvider(env)).toLowerCase();
  if (!raw || ['none', 'off', 'disabled'].includes(raw)) return 'none';
  if (raw === 'azure_speech' || raw === 'azure-conversation') return 'azure';
  if (raw === 'pyannote.audio') return 'pyannote';
  if (raw === 'webhook' || raw === 'http') return 'webhook';
  if (raw === 'local' || raw === 'speaker_hint_parser') return 'speaker_hint_parser';
  return raw;
}

export function resolveDiarizationConfig({
  provider = null,
  tenantRegion = null,
  env = process.env,
} = {}) {
  const selectedProvider = normalizeDiarizationProvider(provider, env);
  const endpoint = clean(env.CLINICAL_AI_DIARIZATION_ENDPOINT || env.DIARIZATION_WEBHOOK_URL);
  const apiKey = clean(env.CLINICAL_AI_DIARIZATION_API_KEY || env.DIARIZATION_WEBHOOK_API_KEY);
  const allowedRegions = splitCsv(env.CLINICAL_AI_DIARIZATION_ALLOWED_REGIONS || env.CLINICAL_AI_DIARIZATION_REGIONS);
  const regionAllowed = !tenantRegion || allowedRegions.length === 0 || allowedRegions.includes(String(tenantRegion));
  const timeoutMs = Math.max(
    Number.parseInt(env.CLINICAL_AI_DIARIZATION_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS
  );

  if (LOCAL_PROVIDERS.has(selectedProvider)) {
    return {
      configured: selectedProvider !== 'none',
      provider: selectedProvider,
      reason: selectedProvider === 'none' ? 'diarization_provider_not_configured' : null,
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
      provider: selectedProvider,
      reason: 'diarization_endpoint_not_configured',
      external_call: true,
      endpoint_configured: false,
      api_key_configured: Boolean(apiKey),
      tenant_region: tenantRegion || null,
      allowed_regions: allowedRegions,
      timeout_ms: timeoutMs,
    };
  }

  if (!regionAllowed) {
    return {
      configured: false,
      provider: selectedProvider,
      reason: 'tenant_region_not_allowed_for_diarization',
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
    provider: selectedProvider,
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

export function describeDiarizationConfig(options = {}) {
  const config = resolveDiarizationConfig(options);
  return {
    configured: config.configured,
    provider: config.provider,
    reason: config.reason || null,
    external_call: Boolean(config.external_call),
    endpoint_configured: Boolean(config.endpoint_configured),
    api_key_configured: Boolean(config.api_key_configured),
    tenant_region: config.tenant_region || null,
    allowed_regions: config.allowed_regions || [],
    timeout_ms: config.timeout_ms || null,
  };
}

function normalizeSpeaker(value, fallbackIndex = 0) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (SPEAKER_ALIASES.has(raw)) return SPEAKER_ALIASES.get(raw);

  const normalized = raw
    .replace(/^speaker[_\s-]*/i, '')
    .replace(/^spk[_\s-]*/i, '')
    .trim();
  const numericLabel = normalized.match(/(\d+)$/)?.[1] || normalized;
  if (numericLabel === '0' || normalized === 'a') return 'doctor';
  if (numericLabel === '1' || numericLabel === '2' || normalized === 'b') return 'patient';
  if (normalized === '3' || normalized === 'c') return 'caregiver';

  if (fallbackIndex === 0) return 'doctor';
  if (fallbackIndex === 1) return 'patient';
  return 'other';
}

function numeric(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function secondsFromTicks(value) {
  if (value === null || value === undefined) return null;
  return numeric(value, 0) / 10_000_000;
}

function estimateEnd(start, text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return start + Math.max(DEFAULT_TURN_SECONDS, words / WORDS_PER_SECOND);
}

function speakerFromLinePrefix(text) {
  const line = String(text || '').trim();
  const match = line.match(/^(?:\[)?([A-Za-z][A-Za-z0-9_\s-]{0,30})(?:\])?\s*[:-]\s+(.+)$/);
  if (!match) return null;
  const candidate = match[1].trim();
  const canonical = normalizeSpeaker(candidate, 99);
  if (canonical === 'other' && !/speaker|spk|doctor|dr|patient|pt|nurse|caregiver|family|clinician|provider/i.test(candidate)) {
    return null;
  }
  return {
    speaker: canonical,
    text: match[2].trim(),
  };
}

function mapProviderSegment(item, index = 0) {
  const best = Array.isArray(item?.NBest) ? item.NBest[0] : null;
  const text = String(
    item?.text
      ?? item?.transcript
      ?? item?.utterance
      ?? item?.display
      ?? item?.Display
      ?? item?.displayText
      ?? item?.DisplayText
      ?? best?.Display
      ?? best?.display
      ?? ''
  ).trim();
  if (!text) return null;

  const speaker = normalizeSpeaker(
    item?.speaker
      ?? item?.speaker_label
      ?? item?.speakerLabel
      ?? item?.speaker_id
      ?? item?.speakerId
      ?? item?.SpeakerId
      ?? item?.channel
      ?? item?.channel_index,
    index
  );

  const offsetFromTicks = secondsFromTicks(item?.offsetInTicks ?? item?.OffsetInTicks);
  const durationFromTicks = secondsFromTicks(item?.durationInTicks ?? item?.DurationInTicks);
  const start = numeric(
    item?.start_seconds
      ?? item?.start
      ?? item?.start_time
      ?? item?.offset_seconds
      ?? offsetFromTicks,
    index * DEFAULT_TURN_SECONDS
  );
  const end = numeric(
    item?.end_seconds
      ?? item?.end
      ?? item?.end_time
      ?? (durationFromTicks === null ? null : start + durationFromTicks),
    estimateEnd(start, text)
  );

  return {
    speaker,
    text,
    start_seconds: start,
    end_seconds: Math.max(start, end),
  };
}

function candidateArrays(payload) {
  if (Array.isArray(payload)) return [payload];
  if (!payload || typeof payload !== 'object') return [];
  return [
    payload.segments,
    payload.utterances,
    payload.results?.utterances,
    payload.recognizedPhrases,
    payload.RecognizedPhrases,
    payload.phrases,
    payload.channels?.[0]?.alternatives?.[0]?.utterances,
  ].filter(Array.isArray);
}

export function segmentRawTranscriptBySpeakerHints(rawTranscript) {
  const lines = String(rawTranscript || '')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const sourceLines = lines.length ? lines : [String(rawTranscript || '').trim()].filter(Boolean);
  let cursor = 0;
  return sourceLines.map((line, index) => {
    const hinted = speakerFromLinePrefix(line);
    const text = hinted?.text || line;
    const speaker = hinted?.speaker || (sourceLines.length === 1 ? 'other' : normalizeSpeaker(null, index % 2));
    const start = cursor;
    const end = estimateEnd(start, text);
    cursor = end;
    return {
      speaker,
      text,
      start_seconds: start,
      end_seconds: end,
    };
  });
}

export function normalizeDiarizationPayload(payload, { fallbackTranscript = null } = {}) {
  const segments = [];
  for (const array of candidateArrays(payload)) {
    for (const item of array) {
      const segment = mapProviderSegment(item, segments.length);
      if (segment) segments.push(segment);
    }
    if (segments.length) break;
  }
  if (segments.length) return segments;
  return fallbackTranscript ? segmentRawTranscriptBySpeakerHints(fallbackTranscript) : [];
}

async function readResponsePayload(response) {
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      // Empty 202 bodies are common for webhook-style workers.
    }
  }
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
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

export async function requestExternalDiarization({
  rawTranscript = null,
  audioStorageKey = null,
  audioMime = null,
  provider = null,
  tenantRegion = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resolveDiarizationConfig({ provider, tenantRegion, env });
  const configSummary = describeDiarizationConfig({ provider, tenantRegion, env });
  const base = {
    status: 'skipped',
    provider: config.provider,
    segments: [],
    reason: config.reason || null,
    source: 'external_provider',
    tenant_region: tenantRegion || null,
    config: configSummary,
  };

  if (!config.external_call) return base;
  if (!rawTranscript && !audioStorageKey) {
    return {
      ...base,
      reason: 'raw_transcript_or_audio_storage_key_required',
    };
  }
  if (!config.configured) return base;
  if (typeof fetchImpl !== 'function') {
    return {
      ...base,
      status: 'failed',
      reason: 'fetch_unavailable',
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.api_key) headers.Authorization = `Bearer ${config.api_key}`;

  try {
    const response = await postJsonWithTimeout(
      fetchImpl,
      config.endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: config.provider,
          raw_transcript: rawTranscript || null,
          audio_storage_key: audioStorageKey || null,
          audio_mime: audioMime || null,
          tenant_region: tenantRegion || null,
        }),
      },
      config.timeout_ms
    );
    const payload = await readResponsePayload(response);
    const segments = normalizeDiarizationPayload(payload, { fallbackTranscript: rawTranscript });

    if (!response.ok) {
      return {
        ...base,
        status: 'failed',
        reason: `diarization_http_${response.status}`,
        http_status: response.status,
      };
    }

    return {
      ...base,
      status: segments.length ? 'completed' : 'failed',
      segments,
      reason: segments.length ? null : 'diarization_provider_returned_no_segments',
      http_status: response.status,
    };
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      reason: err?.name === 'AbortError' ? 'diarization_provider_timeout' : 'diarization_provider_error',
      error_message: clean(err?.message).slice(0, 500) || null,
    };
  }
}

export async function resolveAmbientDiarization({
  transcriptSegments = [],
  rawTranscript = null,
  diarizationPayload = null,
  audioStorageKey = null,
  audioMime = null,
  provider = null,
  tenantRegion = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const selectedProvider = normalizeDiarizationProvider(provider, env);
  const provided = Array.isArray(transcriptSegments) ? transcriptSegments : [];
  if (provided.length) {
    return {
      status: 'provided',
      provider: selectedProvider === 'none' ? 'client_segments' : selectedProvider,
      segments: provided,
      reason: null,
      source: 'transcript_segments',
    };
  }

  if (diarizationPayload) {
    const segments = normalizeDiarizationPayload(diarizationPayload, { fallbackTranscript: rawTranscript });
    return {
      status: segments.length ? 'completed' : 'failed',
      provider: selectedProvider === 'none' ? 'provider_payload' : selectedProvider,
      segments,
      reason: segments.length ? null : 'diarization_payload_empty',
      source: 'diarization_payload',
    };
  }

  const config = resolveDiarizationConfig({ provider: selectedProvider, tenantRegion, env });
  if (config.external_call && (rawTranscript || audioStorageKey)) {
    const external = await requestExternalDiarization({
      rawTranscript,
      audioStorageKey,
      audioMime,
      provider: selectedProvider,
      tenantRegion,
      env,
      fetchImpl,
    });
    if (external.status === 'completed') return external;
    if (rawTranscript) {
      return {
        status: 'completed',
        provider: selectedProvider,
        segments: segmentRawTranscriptBySpeakerHints(rawTranscript),
        reason: external.reason || 'external_diarization_unavailable',
        source: 'raw_transcript_fallback',
        external_status: external.status,
      };
    }
    return external;
  }

  if (rawTranscript) {
    return {
      status: 'completed',
      provider: selectedProvider === 'none' ? 'speaker_hint_parser' : selectedProvider,
      segments: segmentRawTranscriptBySpeakerHints(rawTranscript),
      reason: 'raw_transcript_segmented_locally',
      source: 'raw_transcript',
    };
  }

  return {
    status: 'skipped',
    provider: selectedProvider,
    segments: [],
    reason: selectedProvider === 'none'
      ? 'diarization_provider_not_configured'
      : 'no_transcript_or_provider_payload',
    source: null,
    tenant_region: tenantRegion || null,
  };
}

export default {
  describeDiarizationConfig,
  normalizeDiarizationPayload,
  normalizeDiarizationProvider,
  requestExternalDiarization,
  resolveDiarizationConfig,
  resolveAmbientDiarization,
  segmentRawTranscriptBySpeakerHints,
};
