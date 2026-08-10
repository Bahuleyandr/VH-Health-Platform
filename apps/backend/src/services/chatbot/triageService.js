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
// GOVERNANCE STATUS (WS5 B5.2, completed in the CDS/AI hardening batch):
//   - Registered clinical_ai_modules row: `patient_triage` (registry entry in
//     clinicalAiModuleService.js auto-upserts on boot — live-provider calls
//     run only while the module is enabled for the tenant).
//   - Framework budget guardrails (getClinicalAiBudgetStatus) gate every
//     live-provider call; usage is recorded to clinical_ai_generations so the
//     daily token/cost budgets account for this surface.
//   - Flagged / blocked / urgent_care outputs enqueue a pending
//     clinical_ai_reviews row for RETROSPECTIVE clinician review (this is a
//     patient-facing real-time surface — same non-blocking signoff posture as
//     patient_record_chatbot).
//   - runOutputDefenses (PHI leak + numeric mismatch heuristics), the
//     region/egress guard (CHATBOT_EXTERNAL_REGIONS, fail-closed semantics
//     aligned with CLINICAL_AI_EXTERNAL_REGIONS), the decision-support-only
//     disclaimer, and fail-closed output parsing remain in force.

import logger from '../../logging/logger.js';
import { runOutputDefenses } from '../ai/hallucinationDefenses.js';
// Shared modernized Anthropic Messages request shaping (extracted from
// localLlmClient's provider path): refusal stop_reason handling, structured
// outputs with a plain retry on schema 400, cacheable system prompt, and
// cache-aware usage accounting. A LEAF module (logger only), so the triage
// load-time import graph stays light.
import { postAnthropicMessages } from '../ai/anthropicMessagesClient.js';

// clinical_ai_modules registry key for this surface.
const MODULE_KEY = 'patient_triage';

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

// Upper bound on a single provider call (the legacy raw fetch had no bound at
// all — an unresponsive endpoint held the patient request open indefinitely).
// Same clamp window as localLlmClient's CLINICAL_AI_TIMEOUT_MS.
const TIMEOUT_MS = Math.min(
  Math.max(Number.parseInt(process.env.CHATBOT_TIMEOUT_MS, 10) || 45_000, 5_000),
  120_000
);

// ---------------------------------------------------------------------------
// Region / egress guard
// CHATBOT_EXTERNAL_REGIONS — comma-separated region codes (e.g. "US,AP").
// Semantics are aligned with CLINICAL_AI_EXTERNAL_REGIONS in localLlmClient
// (fail-closed hardening, audit 2026-06-18):
//   - empty/unset: a tenant that CARRIES a region is DENIED external use; only
//     a region-less tenant (single-tenant pilot) is allowed.
//   - '*' wildcard: every region allowed (deliberate, audited opt-out).
//   - otherwise: exact allowlist match.
// When blocked, PHI never leaves before any network call is made.
// ---------------------------------------------------------------------------
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
  if (!raw) return !tenantRegion;
  const allowed = raw.split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  if (allowed.includes('*')) return true;
  if (!tenantRegion) return false;
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
// Governed-framework wiring: module gate, budget guardrails, and generation /
// review persistence (clinical_ai_generations / clinical_ai_reviews). All
// imports are lazy so the template path stays DB-free and this module's
// load-time import graph stays light (mirrors cdsAlertSurfacing).
// ---------------------------------------------------------------------------

async function _governanceGate({ tenantId }) {
  try {
    const { getClinicalAiTenantModule, getClinicalAiGuardrails, getClinicalAiBudgetStatus } =
      await import('../ai/clinicalAiModuleService.js');
    const module = await getClinicalAiTenantModule(MODULE_KEY, { tenantId });
    if (!module?.enabled) return { allowed: false, reason: 'module_disabled', module: module || null };
    const guardrails = await getClinicalAiGuardrails();
    const budget = await getClinicalAiBudgetStatus({ days: 1, guardrails, tenantId });
    if (guardrails?.enabled && budget?.tripped) {
      return { allowed: false, reason: 'budget_guardrail_tripped', module };
    }
    return { allowed: true, module };
  } catch (err) {
    // Fail closed for egress: when governance state cannot be read, PHI does
    // not go to a live provider. (No PHI in this log line.)
    logger.error('Triage: governance gate unavailable — falling back to template', {
      error: String(err?.message || err).slice(0, 300),
    });
    return { allowed: false, reason: 'governance_unavailable', module: null };
  }
}

function _reviewReasonsFor(result) {
  const reasons = [];
  if (result.blocked === true) reasons.push('output_blocked');
  if ((result.safetyFlags || []).length > 0) reasons.push('safety_flags');
  if (result.triage === 'urgent_care') reasons.push('urgent_care_escalation');
  return reasons;
}

/**
 * Persist the triage outcome through the governed framework's tables: one
 * clinical_ai_generations row per live-provider call (feeds the daily budget
 * guardrails), plus a pending clinical_ai_reviews row when the output was
 * blocked, flagged, or an urgent_care escalation — the retrospective review
 * queue for this patient-facing surface. The writes are atomic. A persistence
 * failure is loud and causes a successful model answer to be withheld; safe
 * blocked fallbacks remain safe to return even when the review store is down.
 */
async function _recordTriageOutcome({ tenantId, patientUid, module, result, usage, reviewReasons }) {
  try {
    const { setTenantTx } = await import('../../lib/prisma.js');
    const { requireTenantId } = await import('../tenant/tenantService.js');
    const tid = requireTenantId(tenantId || null);
    const draft = {
      triage: result.triage ?? null,
      differential: result.differential ?? [],
      summary: result.summary ?? null,
      redFlags: result.redFlags ?? [],
      blocked: result.blocked === true,
    };
    const generationId = await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, task_type, module_key, provider, model, prompt_version, status,
          used_ai, safety_flags, draft, prompt_tokens, completion_tokens, total_tokens, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5, 'patient-triage-v1', $6, true, $7::jsonb,
               $8::jsonb, $9, $10, $11, $12::jsonb, NOW(), NOW())
       RETURNING id`,
        tid,
        patientUid || null,
        MODULE_KEY,
        result.provider || PROVIDER,
        result.model || MODEL,
        result.blocked === true ? 'failed' : 'draft',
        JSON.stringify(result.safetyFlags || []),
        JSON.stringify(draft),
        usage?.prompt_tokens || 0,
        usage?.completion_tokens || 0,
        usage?.total_tokens || 0,
        JSON.stringify({ surface: MODULE_KEY, review_reasons: reviewReasons }),
      );
      const insertedGenerationId = rows?.[0]?.id ?? null;
      if (insertedGenerationId == null) throw new Error('generation insert returned no id');
      if (reviewReasons.length) {
        await tx.$queryRawUnsafe(
          `INSERT INTO clinical_ai_reviews
           (tenant_id, generation_id, module_key, patient_uid, decision, metadata, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, 'pending', $5::jsonb, NOW(), NOW())`,
          tid,
          insertedGenerationId,
          MODULE_KEY,
          patientUid || null,
          JSON.stringify({
            review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'ADMIN'],
            requires_signoff: false,
            review_mode: 'retrospective',
            reasons: reviewReasons,
          }),
        );
      }
      return insertedGenerationId;
    });
    return generationId;
  } catch (err) {
    // Distinctive, greppable marker for ops alerting. (No PHI in this line.)
    logger.error('TRIAGE_GOVERNANCE_RECORD_FAILED: triage generation/review row not persisted', {
      error: String(err?.message || err).slice(0, 300),
      review_reasons: reviewReasons,
    });
    return null;
  }
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

// JSON contract enforced server-side via Anthropic structured outputs
// (output_config.format). Mirrors the fail-closed schema validation in
// triageSymptoms below — the validator (not this schema) remains the
// authoritative gate, so a provider that ignores output_config changes
// nothing. `differential` matches the object shape consumed by the Patient
// app; the OpenAI-compatible path keeps relying on the prompt +
// response_format json_object as before.
const TRIAGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    triage: { type: 'string', enum: ['self_care', 'see_doctor_now', 'urgent_care'] },
    differential: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          diagnosis: { type: 'string' },
          likelihood: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['diagnosis', 'likelihood'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
    redFlags: { type: 'array', items: { type: 'string' } },
  },
  required: ['triage', 'differential', 'summary', 'redFlags'],
  additionalProperties: false,
};

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
 * @param {string}   [opts.tenantId]       requesting tenant (governance gate +
 *                                         generation/review persistence)
 * @param {string}   [opts.patientUid]     patient uid for the generation /
 *                                         review rows (IDs in the DB are fine)
 * @returns {Promise<object>} parsed triage JSON + governance fields
 */
export async function triageSymptoms({
  symptoms,
  history = [],
  patientContext = null,
  tenantRegion = null,
  tenantId = null,
  patientUid = null,
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

  // --- Governance gate (module enablement + budget guardrails) ---
  // Live-provider calls run only while the patient_triage clinical_ai_modules
  // row is enabled for the tenant and the daily budget guardrails have head-
  // room. Blocked calls fall back to the safe template (never a hard error on
  // this patient-facing surface).
  const gate = await _governanceGate({ tenantId });
  if (!gate.allowed) {
    logger.warn('Triage: live provider blocked by governance gate — template fallback active', {
      reason: gate.reason,
    });
    const result = _templateResponse();
    result.governanceNote = `patient_triage_governance_blocked:${gate.reason} — template fallback active`;
    return result;
  }

  // --- Region / egress guard ---
  // External providers (anthropic, openai) must be permitted for this
  // tenant's region. Local/self-hosted OpenAI-compatible endpoints that
  // resolve to a LOCAL_HOST bypass this check (same as localLlmClient).
  const isExternalCall = _isExternalUrl(BASE_URL);
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

  // Fail-closed patient-facing response builder. Used when the model output
  // cannot be trusted (unparseable, or a critical safety flag fired): never
  // echoes the raw/parsed model content, always escalates to a clinician, and
  // surfaces the reason + any detection flags. (audit 2026-06-18 — triage
  // fail-open paths: raw-text-on-parse-fail + defenses-annotate-but-don't-block)
  const buildBlockedTriage = ({ code, reason, extraFlags = [] }) => ({
    triage: 'see_doctor_now',
    differential: [],
    summary: 'We could not safely interpret the assistant response. Please consult a doctor.',
    redFlags: [],
    provider: PROVIDER,
    model: MODEL,
    disclaimer: CLINICAL_DISCLAIMER,
    blocked: true,
    safetyFlags: [{ severity: 'high', code, message: reason }, ...extraFlags],
  });

  const buildGovernanceRecordFallback = ({ urgent = false } = {}) => ({
    ..._templateResponse(),
    ...(urgent ? {
      triage: 'urgent_care',
      summary: 'We could not complete the required safety recording. Please seek urgent medical care now.',
    } : {}),
    governanceNote: 'patient_triage_governance_record_failed — template fallback active',
    safetyFlags: [{
      severity: 'high',
      code: 'TRIAGE_GOVERNANCE_RECORD_FAILED',
      message: 'The assistant response was withheld because its required safety record could not be stored.',
    }],
  });

  let rawText;
  let usage;
  try {
    ({ text: rawText, usage } = PROVIDER === 'openai'
      ? await _callOpenAICompatible({ userMessage, history })
      : await _callAnthropic({ userMessage, history }));
  } catch (err) {
    if (err?.refusal === true) {
      // FAIL-CLOSED: the provider's safety classifiers declined the request
      // (HTTP 200, stop_reason 'refusal'). Nothing usable came back — return
      // the safe canned escalation and record the (billed) refusal through
      // the governed tables like any other blocked outcome. The refusal
      // category in err.message is PHI-free.
      logger.warn('Triage: provider refusal — returning safe fallback', {
        provider: PROVIDER,
        model: MODEL,
        reason: String(err.message || 'anthropic_refusal').slice(0, 120),
      });
      const blockedResult = buildBlockedTriage({
        code: 'TRIAGE_PROVIDER_REFUSAL',
        reason: 'The assistant declined to answer this request.',
      });
      await _recordTriageOutcome({
        tenantId,
        patientUid,
        module: gate.module,
        result: blockedResult,
        usage: err.usage || null,
        reviewReasons: _reviewReasonsFor(blockedResult),
      });
      return blockedResult;
    }
    throw err;
  }

  const recordOutcome = (result) => _recordTriageOutcome({
    tenantId,
    patientUid,
    module: gate.module,
    result,
    usage,
    reviewReasons: _reviewReasonsFor(result),
  });

  let parsed;
  try {
    parsed = JSON.parse(_extractJson(rawText));
  } catch {
    // FAIL-CLOSED: unparseable model output must NOT be echoed back to the
    // patient — it is unvalidated and may carry hallucinated PHI, unsafe advice,
    // or injected instructions. Run defenses for server-side detection/logging,
    // then return a safe canned response that escalates to a clinician.
    const detectionFlags = runOutputDefenses({
      draft: rawText,
      context: patientContext || {},
      citations: [],
    });
    logger.warn('Triage response not valid JSON — blocking raw text, returning safe fallback', {
      provider: PROVIDER,
      model: MODEL,
      detectionFlagCodes: detectionFlags.map((f) => f.code),
    });
    const blockedResult = buildBlockedTriage({
      code: 'TRIAGE_UNPARSEABLE_OUTPUT_BLOCKED',
      reason: 'The assistant response could not be safely interpreted.',
      extraFlags: detectionFlags,
    });
    await recordOutcome(blockedResult);
    return blockedResult;
  }

  const validTriageCategories = new Set(['self_care', 'see_doctor_now', 'urgent_care']);
  const validLikelihoods = new Set(['high', 'medium', 'low']);
  const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
  const normalizedDifferential = Array.isArray(parsed?.differential)
    ? parsed.differential.map((item) => ({
      diagnosis: typeof item?.diagnosis === 'string' ? item.diagnosis.trim() : item?.diagnosis,
      likelihood: typeof item?.likelihood === 'string'
        ? item.likelihood.trim().toLowerCase()
        : item?.likelihood,
    }))
    : null;
  const differentialArrayIsValid = Array.isArray(normalizedDifferential)
    && normalizedDifferential.every((item) => (
    item
    && typeof item === 'object'
    && !Array.isArray(item)
    && typeof item.diagnosis === 'string'
    && item.diagnosis.trim()
    && validLikelihoods.has(item.likelihood)
  ));
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !validTriageCategories.has(parsed.triage)
    || !differentialArrayIsValid
    || typeof parsed.summary !== 'string'
    || !parsed.summary.trim()
    || !stringArray(parsed.redFlags)
  ) {
    const blockedResult = buildBlockedTriage({
      code: 'TRIAGE_SCHEMA_INVALID',
      reason: 'The assistant response did not match the required triage schema.',
    });
    await recordOutcome(blockedResult);
    return blockedResult;
  }
  // Anthropic documents that structured-output enum values may differ only
  // in capitalization. Canonicalize the accepted values before returning the
  // contract consumed by the Patient app.
  parsed.differential = normalizedDifferential;

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
    // FAIL-CLOSED: a critical defense flag means the output likely contains
    // hallucinated PHI or a dangerous mismatch. Do NOT return the flagged
    // content to the patient — escalate to a clinician and surface the flags.
    logger.error('Triage: critical safety flag — blocking output, returning safe fallback', {
      provider: PROVIDER,
      model: MODEL,
      flagCount: safetyFlags.length,
    });
    const blockedResult = buildBlockedTriage({
      code: 'TRIAGE_OUTPUT_BLOCKED_CRITICAL',
      reason: 'The assistant response failed an automated safety check.',
      extraFlags: safetyFlags,
    });
    await recordOutcome(blockedResult);
    return blockedResult;
  } else if (safetyFlags.length > 0) {
    logger.warn('Triage: output defense flags raised', {
      provider: PROVIDER,
      model: MODEL,
      flags: safetyFlags.map((f) => f.code),
    });
  }

  const result = {
    ...parsed,
    provider: PROVIDER,
    model: MODEL,
    disclaimer: CLINICAL_DISCLAIMER,
    safetyFlags,
  };
  const generationId = await recordOutcome(result);
  if (generationId == null) {
    return buildGovernanceRecordFallback({ urgent: result.triage === 'urgent_care' });
  }
  return result;
}

// -- Anthropic Messages API ---------------------------------------------------
// Routed through the shared modernized provider path (anthropicMessagesClient,
// extracted from localLlmClient) instead of a bespoke raw fetch. Gains over
// the legacy fetch: refusal stop_reason handling (surfaced to the caller as a
// fail-closed blocked response, never parsed as empty content), structured
// outputs enforcing the triage JSON contract (with a plain retry if the
// endpoint rejects the schema), cache-aware token accounting
// (cache_creation/cache_read tokens feed the budget guardrails), and a
// bounded request timeout.

async function _callAnthropic({ userMessage, history }) {
  const messages = [
    ...history.map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: String(t.content),
    })),
    { role: 'user', content: userMessage },
  ];

  try {
    return await postAnthropicMessages({
      url: `${BASE_URL.replace(/\/$/, '')}/v1/messages`,
      apiKey: API_KEY,
      model: MODEL,
      maxTokens: 800,
      systemPrompt: SYSTEM_PROMPT,
      messages,
      jsonSchema: TRIAGE_OUTPUT_SCHEMA,
      timeoutMs: TIMEOUT_MS,
      logContext: { surface: MODULE_KEY },
    });
  } catch (err) {
    // Safety-classifier refusal: propagate as-is (marked err.refusal, carries
    // the billed usage) — triageSymptoms converts it into the fail-closed
    // blocked response and records the generation row.
    if (err?.refusal === true) throw err;
    logger.error(`Triage (anthropic) error: ${String(err?.httpStatus || err?.message || err)}`);
    const upstreamErr = new Error('Triage service upstream error');
    upstreamErr.statusCode = 502;
    throw upstreamErr;
  }
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

  let resp;
  try {
    resp = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
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
      // Same bounded request timeout as the Anthropic path (TIMEOUT_MS via
      // anthropicMessagesClient) — a hung upstream must not hold the request
      // open indefinitely.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (fetchErr) {
    const reason = fetchErr?.name === 'TimeoutError'
      ? `timed out after ${TIMEOUT_MS}ms`
      : String(fetchErr?.message || fetchErr);
    logger.error(`Triage (openai-compat) error: ${reason}`);
    const err = new Error('Triage service upstream error');
    err.statusCode = 502;
    throw err;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    logger.error(`Triage (openai-compat) error ${resp.status}: ${text}`);
    const err = new Error('Triage service upstream error');
    err.statusCode = 502;
    throw err;
  }

  const data = await resp.json();
  const promptTokens = data?.usage?.prompt_tokens || 0;
  const completionTokens = data?.usage?.completion_tokens || 0;
  return {
    text: data?.choices?.[0]?.message?.content ?? '',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: data?.usage?.total_tokens || (promptTokens + completionTokens),
    },
  };
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
