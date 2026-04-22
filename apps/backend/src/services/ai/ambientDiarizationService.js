/**
 * Ambient diarization adapter.
 *
 * The ambient note workflow should not know provider-specific payload shapes.
 * This adapter accepts already-diarized provider output from capture clients
 * or a raw speaker-labelled transcript, normalizes it into canonical
 * transcript segments, and leaves provider SDK/API calls as a swappable edge.
 */

const DEFAULT_TURN_SECONDS = 6;
const WORDS_PER_SECOND = 2.4;

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

function configuredProvider() {
  return String(process.env.CLINICAL_AI_DIARIZATION_PROVIDER || 'none').trim().toLowerCase() || 'none';
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

export async function resolveAmbientDiarization({
  transcriptSegments = [],
  rawTranscript = null,
  diarizationPayload = null,
  provider = null,
  tenantRegion = null,
} = {}) {
  const selectedProvider = String(provider || configuredProvider()).trim().toLowerCase() || 'none';
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

export function describeDiarizationConfig() {
  const provider = configuredProvider();
  return {
    provider,
    configured: provider !== 'none',
  };
}

export default {
  describeDiarizationConfig,
  normalizeDiarizationPayload,
  resolveAmbientDiarization,
  segmentRawTranscriptBySpeakerHints,
};
