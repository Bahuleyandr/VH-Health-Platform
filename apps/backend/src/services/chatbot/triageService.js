// src/services/chatbot/triageService.js
//
// AI symptom-triage helper. Provider-agnostic: speaks to either Anthropic
// Messages API or any OpenAI-compatible chat-completions server (Ollama, vLLM,
// llama.cpp server, LM Studio, text-generation-webui, a local OpenAI proxy,
// etc). Selection is driven purely by env so the deployment can point at a
// self-hosted model without code changes.
//
//   CHATBOT_PROVIDER   = 'template' (default — safe, no PHI egress) | 'openai' | 'anthropic'
//
//   IMPORTANT SECURITY/COMPLIANCE NOTE:
//   The default provider is 'template' (decision-support-only stub that returns
//   a safe placeholder response without any external API call). This guarantees
//   NO PHI leaves the building unless an operator explicitly sets
//   CHATBOT_PROVIDER=anthropic or CHATBOT_PROVIDER=openai and provides the
//   corresponding CHATBOT_API_KEY. The prior default of 'anthropic' caused
//   patient symptom text to be sent to an external cloud endpoint in any
//   deployment that did not explicitly override it — a HIPAA/DPDP egress
//   violation. Any production deployment that wishes to use a live LLM MUST
//   explicitly set CHATBOT_PROVIDER and accept responsibility for PHI routing.
//
//   CHATBOT_BASE_URL   = override endpoint. For 'openai' with Ollama:
//                        http://ollama.internal:11434/v1
//                        For 'anthropic': https://api.anthropic.com (default)
//   CHATBOT_MODEL      = model identifier (defaults per provider)
//   CHATBOT_API_KEY    = API key. Optional for self-hosted backends that
//                        don't auth; required for Anthropic.
//   ANTHROPIC_API_KEY  = back-compat alias for CHATBOT_API_KEY when provider
//                        is Anthropic.
//
// The structured response contract (`{triage, differential, summary, redFlags}`)
// is enforced by the system prompt regardless of provider — the patient app
// sees the same shape either way.
//
// GOVERNANCE STATUS (WS5 B5.2):
//   Applied: runOutputDefenses (PHI leak + numeric mismatch heuristics),
//            region/egress guard (CHATBOT_EXTERNAL_REGIONS allowlist),
//            decision-support-only disclaimer on every response.
//   NOT YET applied: full clinical-AI review queue (clinicalAiWorkflowService)
//            and module-level budget guardrails. These require a DB-backed
//            clinical_ai_modules row for this surface and a review queue
//            table entry for each triage call. That wiring is deferred to a
//            follow-on governance batch (AI-8 or equivalent) because it
//            requires schema additions + a new migration. Track this gap as
//            GOVERNANCE_GAP_TRIAGE_REVIEW_QUEUE in the tech-debt register.

import logger from '../../logging/logger.js';
import { runOutputDefenses } from '../ai/hallucinationDefenses.js';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------
//
// DEFAULT IS 'template' — safe stub, zero PHI egress.
// Operator must explicitly set CHATBOT_PROVIDER=anthropic|openai to enable a
// live model. This matches how localLlmClient defaults to 'template'.
const PROVIDER = (process.env.CHATBOT_PROVIDER || 'template').toLowerCase();

// Model defaults: when the operator opts into anthropic, the default is the
// CURRENT Opus release (claude-opus-4-8). claude-opus-4-6 was two releases
// stale and has been removed as a default.
const MODEL = process.env.CHATBOT_MODEL
  || (PROVIDER === 'openai' ? 'gpt-oss-20b' : 'claude-opus-4-8');

const BASE_URL = process.env.CHATBOT_BASE_URL
  || (PROVIDER === 'openai' ? 'http://localhost:11434/v1' : 'https://api.anthropic.com');
const API_KEY = process.env.CHATBOT_API_KEY || process.env.ANTHROPIC_API_KEY || '';

// ---------------------------------------------------------------------------
// Region / egress guard
// CHATBOT_EXTERNAL_REGIONS — comma-separated region codes (e.g. "US,AP").
// Mirrors CLINICAL_AI_EXTERNAL_REGIONS in localLlmClient.
// Empty / unset → all regions permitted (acceptable for single-tenant pilot).
// When set, PHI from a tenant outside the list is blocked before any network
// call is made.
// ---------------------------------------------------------------------------
const EXTERNAL_PROVIDER = new Set(['anthropic', 'openai']);

function _isExternalUrl(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    const local = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
    return !local.has(hostname.toLowerCase());
  } catch {
    return true;
  }
}

function _tenantCanUseExternal(tenantRegion) {
  const raw = (process.env.CHATBOT_EXTERNAL_REGIONS || '').trim();
  if (!raw) return true;
  if (!tenantRegion) return false;
  const allowed = raw.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  return allowed.includes(String(tenantRegion).trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Decision-support-only disclaimer (mandatory on every response)
// ---------------------------------------------------------------------------
const CLINICAL_DISCLAIMER =
  'This triage suggestion is decision-support only and is NOT a medical diagnosis. ' +
  'Always consult a qualified healthcare professional for medical advice, ' +
  'diagnosis, or treatment.';

// ---------------------------------------------------------------------------
// Template / safe-fallback response
// ---------------------------------------------------------------------------
function _templateResponse() {
  return {
    triage: 'see_doctor_now',
    differential: [],
    summary:
      'Our AI triage service is not currently configured. Please contact your care team or visit the outpatient department.',
    redFlags: [],
    raw: null,
    provider: 'template',
    disclaimer: CLINICAL_DISCLAIMER,
    safetyFlags: [],
    governanceNote: 'AI triage unavailable — template fallback active.',
  };
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a clinical triage assistant for VHHealth, a hospital in Chennai.
The patient below will describe symptoms. You must:

1. Produce a differential diagnosis (2–5 possibilities) ranked by likelihood.
2. Decide on one triage category:
   * "self_care"       — safe to monitor at home, no clinician needed today.
   * "see_doctor_now"  — should book an outpatient appointment today/tomorrow.
   * "urgent_care"     — go to A&E / call emergency services now.
3. Write a 1–2 sentence summary for the patient in plain language.

You MUST respond with *only* a JSON object matching this schema (no prose before or after):
{
  "triage": "self_care" | "see_doctor_now" | "urgent_care",
  "differential": [ { "diagnosis": string, "likelihood": "high" | "medium" | "low" } ],
  "summary": string,
  "redFlags": string[]
}

Be conservative: when uncertain, escalate. Anything chest-pain / loss-of-consciousness /
stroke-symptoms / severe-bleeding / anaphylaxis must be "urgent_care".`;

/**
 * Run the triage flow for a single patient message.
 *
 * @param {object}   opts
 * @param {string}   opts.symptoms
 * @param {object[]} [opts.history]        prior {role, content} turns
 * @param {object}   [opts.patientContext] age, sex, known conditions, allergies
 * @param {string}   [opts.tenantRegion]   tenant's data-residency region code
 *                                         (e.g. 'IN', 'US'). Used for the
 *                                         egress guard when CHATBOT_EXTERNAL_REGIONS
 *                                         is set.
 * @returns {Promise<object>} parsed triage JSON + governance fields
 */
export async function triageSymptoms({
  symptoms,
  history = [],
  patientContext = null,
  tenantRegion = null,
} = {}) {
  if (!symptoms || typeof symptoms !== 'string' || symptoms.trim().length < 5) {
    const err = new Error('symptoms must be at least 5 characters');
    err.statusCode = 400;
    throw err;
  }

  // --- Template / safe-fallback path ---
  // When no operator has explicitly opted into a live provider, return a
  // policy-safe placeholder. Zero network calls, zero PHI egress.
  if (PROVIDER === 'template') {
    logger.info('Triage: template provider active — returning safe placeholder (no external call)');
    return _templateResponse();
  }

  // --- Region / egress guard ---
  // External providers (anthropic, openai) must be permitted for this
  // tenant's region. Local/self-hosted OpenAI-compatible endpoints that
  // resolve to a LOCAL_HOST bypass this check (same as localLlmClient).
  const isExternalCall = EXTERNAL_PROVIDER.has(PROVIDER) || _isExternalUrl(BASE_URL);
  if (isExternalCall && !_tenantCanUseExternal(tenantRegion)) {
    const blockedRegion = tenantRegion ? String(tenantRegion).toUpperCase() : 'UNKNOWN';
    logger.warn('Triage: PHI egress blocked by region policy', {
      provider: PROVIDER,
      tenantRegion: blockedRegion,
    });
    const result = _templateResponse();
    result.governanceNote =
      `external_provider_blocked_for_region:${blockedRegion} — template fallback active`;
    result.safetyFlags = [{
      severity: 'high',
      code: 'PHI_EGRESS_BLOCKED',
      message: `External chatbot provider blocked for region ${blockedRegion}`,
    }];
    return result;
  }

  // Anthropic requires an API key; OpenAI-compatible self-hosted backends
  // usually don't (Ollama, vLLM w/o auth). We only hard-fail when the chosen
  // provider actually needs a key.
  if (PROVIDER === 'anthropic' && !API_KEY) {
    const err = new Error('Chatbot not configured: CHATBOT_API_KEY / ANTHROPIC_API_KEY unset');
    err.statusCode = 503;
    throw err;
  }

  const contextBlock = patientContext
    ? `\n\nPatient context: ${JSON.stringify(patientContext)}`
    : '';
  const userMessage = `${symptoms.trim()}${contextBlock}`;

  const rawText = PROVIDER === 'openai'
    ? await _callOpenAICompatible({ userMessage, history })
    : await _callAnthropic({ userMessage, history });

  let parsed;
  try {
    parsed = JSON.parse(_extractJson(rawText));
  } catch {
    logger.warn('Triage response not valid JSON, returning raw text');
    // Still run defenses on the raw text so PHI leaks are flagged even on
    // malformed outputs.
    const safetyFlags = runOutputDefenses({
      draft: rawText,
      context: patientContext || {},
      citations: [],
    });
    return {
      triage: 'see_doctor_now',
      differential: [],
      summary: rawText,
      redFlags: [],
      raw: rawText,
      provider: PROVIDER,
      model: MODEL,
      disclaimer: CLINICAL_DISCLAIMER,
      safetyFlags,
    };
  }

  // --- Output defenses ---
  // Apply the clinical substrate's heuristic defense matrix (PHI leak
  // detection + numeric mismatch detection). An empty safetyFlags list means
  // "no heuristic fired", NOT "verified safe".
  const safetyFlags = runOutputDefenses({
    draft: parsed,
    context: patientContext || {},
    citations: [],
  });

  if (safetyFlags.some((f) => f.severity === 'critical')) {
    logger.error('Triage: critical safety flag on output — response may contain hallucinated PHI', {
      provider: PROVIDER,
      model: MODEL,
      flagCount: safetyFlags.length,
    });
  } else if (safetyFlags.length > 0) {
    logger.warn('Triage: output defense flags raised', {
      provider: PROVIDER,
      model: MODEL,
      flags: safetyFlags.map((f) => f.code),
    });
  }

  return {
    ...parsed,
    raw: rawText,
    provider: PROVIDER,
    model: MODEL,
    disclaimer: CLINICAL_DISCLAIMER,
    safetyFlags,
  };
}

// -- Anthropic Messages API ---------------------------------------------------

async function _callAnthropic({ userMessage, history }) {
  const messages = [
    ...history.map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content),
    })),
    { role: 'user', content: userMessage },
  ];

  const resp = await fetch(`${BASE_URL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error(`Triage (anthropic) error ${resp.status}: ${text}`);
    const err = new Error('Triage service upstream error');
    err.statusCode = 502;
    throw err;
  }

  const data = await resp.json();
  return Array.isArray(data.content)
    ? data.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
    : '';
}

// -- OpenAI-compatible chat-completions ---------------------------------------
// Works against any server that speaks /v1/chat/completions: Ollama, vLLM,
// llama.cpp server, LM Studio, text-generation-webui, OpenRouter, local proxies.

async function _callOpenAICompatible({ userMessage, history }) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content),
    })),
    { role: 'user', content: userMessage },
  ];

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const resp = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages,
      max_tokens: 800,
      temperature: 0.2,
      // Ask for JSON mode where the server supports it. Servers that don't
      // know the field just ignore it — the system prompt still enforces JSON.
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error(`Triage (openai-compat) error ${resp.status}: ${text}`);
    const err = new Error('Triage service upstream error');
    err.statusCode = 502;
    throw err;
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// -- Helpers ------------------------------------------------------------------

/**
 * Some self-hosted models wrap the JSON in ```json ... ``` fences or add a
 * short preamble despite the system prompt. Extract the first balanced JSON
 * object so downstream parsing doesn't trip on it.
 */
function _extractJson(text) {
  if (!text) return '{}';
  const trimmed = text.trim();
  // Strip ```json / ``` fences if present.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // Fall back to first { ... last }.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

export default { triageSymptoms };
