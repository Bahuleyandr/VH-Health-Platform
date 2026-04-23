/**
 * Voice Patient Assistant / IVR.
 *
 * Consent-gated IVR / voice-assistant session classifier. Given a patient,
 * intent (`prep` / `aftercare` / `meds` / `reminder` / `virtual_ward` /
 * `triage_callback` / `other`), transcript text, consent_ref, channel
 * (ivr / phone / sms / chat), language, and an optional script_key, the
 * service classifies session safety:
 *   - consent present + fresh? (otherwise block)
 *   - transcript has urgent/emergency phrases? (escalate to clinician)
 *   - candidate response has PHI leakage? (block response + sanitize)
 *   - intent supported in configured scripts? (otherwise fallback to human)
 *   - language supported? (otherwise fallback)
 *
 * Produces a per-session recommendation: `allow` / `escalate_to_clinician` /
 * `block` / `fallback_to_human` / `no_action`.
 *
 * Review-only — the module never plays audio or sends a reply. A downstream
 * dispatcher handles delivery only after reviewer approval (or via an
 * admin-approved automated template path).
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

export const MODULE_KEY = 'voice_patient_assistant_ivr';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support clinician review of a consent-gated voice / IVR patient-assistant session. Rules are authoritative. Return JSON only. This module never plays audio or sends a reply; a downstream dispatcher delivers only after reviewer approval.',
  user_prompt_template:
    'Given the session inputs and the rule-based recommendation + severity + signals + sanitized response, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based recommendation, severity, signal counts, or sanitized response.',
};

export const INTENTS = new Set([
  'prep',
  'aftercare',
  'meds',
  'reminder',
  'virtual_ward',
  'triage_callback',
  'other',
  'unknown',
]);

export const CHANNELS = new Set(['ivr', 'phone', 'sms', 'chat', 'unknown']);

export const RECOMMENDATIONS = new Set([
  'allow',
  'escalate_to_clinician',
  'block',
  'fallback_to_human',
  'no_action',
  'unknown',
]);

export const RECOMMENDATION_PRIORITY = [
  'unknown',
  'no_action',
  'allow',
  'fallback_to_human',
  'escalate_to_clinician',
  'block',
];

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);

export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

export const SUPPORTED_LANGUAGES = new Set([
  'en',
  'hi',
  'ta',
  'te',
  'kn',
  'ml',
  'mr',
  'bn',
]);

export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);

export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Clinician review required \u2014 decision support only; the module never plays audio or sends a reply.';

// Urgent phrase regex list for quick detection. Case-insensitive.
const URGENT_REGEXES = [
  { re: /\bchest pain\b/i, label: 'chest pain' },
  { re: /\bdifficulty breathing\b|shortness of breath|can'?t breathe/i, label: 'difficulty breathing' },
  { re: /\bsuicid/i, label: 'suicide reference' },
  { re: /\bbleeding/i, label: 'bleeding' },
  { re: /\bemergency\b/i, label: 'emergency' },
  { re: /\bseizure/i, label: 'seizure' },
  { re: /\bfainted|unconscious|passed out/i, label: 'loss of consciousness' },
  { re: /\bstroke\b|slurred speech|facial droop/i, label: 'stroke symptoms' },
  { re: /\bworsening\b/i, label: 'worsening' },
  { re: /\bsevere pain\b/i, label: 'severe pain' },
];

// PHI detection regex set for scanning a candidate response.
// NOTE: hyphens inside character classes are placed last to avoid range
// escape issues (e.g. `[\w-]`, `[:\s-]`).
const PHI_REGEXES = [
  { code: 'PHONE_LEAK', re: /(?:\+91[\s-]?)?\b\d{10}\b/g },
  { code: 'MRN_LEAK', re: /\bMRN[:\s-]*\w+/gi },
  { code: 'MRN_LEAK', re: /\bVH-\w+/gi },
  { code: 'EMAIL_LEAK', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { code: 'AADHAAR_LEAK', re: /\b\d{12}\b/g },
  { code: 'NAME_LEAK', re: /\b(?:Patient|Name)\s*:\s*[A-Za-z][A-Za-z .'-]{1,80}/g },
];

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(
    String(err?.message || '')
  );
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function optionalIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function truncate(text, n = 500) {
  const body = String(text || '');
  return body.length > n ? `${body.slice(0, n - 3)}...` : body;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Lowercase + trim. Returns value if in INTENTS else `'other'`.
 */
export function normalizeIntent(value) {
  const text = cleanText(value).toLowerCase();
  return INTENTS.has(text) ? text : 'other';
}

/**
 * Lowercase + trim. Returns value if in CHANNELS else `'unknown'`.
 */
export function normalizeChannel(value) {
  const text = cleanText(value).toLowerCase();
  return CHANNELS.has(text) ? text : 'unknown';
}

/**
 * Lowercase + trim. Returns value if in SUPPORTED_LANGUAGES else the
 * literal string `'unsupported'` (so downstream rules can detect it).
 */
export function normalizeLanguage(value) {
  const text = cleanText(value).toLowerCase();
  return SUPPORTED_LANGUAGES.has(text) ? text : 'unsupported';
}

/**
 * Detect urgent/emergency phrases in a transcript. Case-insensitive,
 * dedupes by regex label.
 *
 * Returns `{ signals: [{ code: 'URGENT_TERM', term: string }], count }`.
 */
export function detectUrgentSignals(transcriptText) {
  const text = String(transcriptText || '');
  if (!text) return { signals: [], count: 0 };
  const seen = new Set();
  const signals = [];
  for (const { re, label } of URGENT_REGEXES) {
    if (re.test(text) && !seen.has(label)) {
      seen.add(label);
      signals.push({ code: 'URGENT_TERM', term: label });
    }
  }
  return { signals, count: signals.length };
}

/**
 * Detect PHI in a candidate response. Returns
 * `{ leaks: [{ code, sample }], count }` where `sample` is truncated to
 * 40 chars.
 */
export function detectPhiInResponse(responseText) {
  const text = String(responseText || '');
  if (!text) return { leaks: [], count: 0 };
  const leaks = [];
  for (const { code, re } of PHI_REGEXES) {
    const matches = text.match(re);
    if (!matches) continue;
    for (const m of matches) {
      const sample = m.length > 40 ? `${m.slice(0, 37)}...` : m;
      leaks.push({ code, sample });
    }
  }
  return { leaks, count: leaks.length };
}

/**
 * Return the response with detected PHI tokens replaced by `[REDACTED]`.
 * Non-destructive to other content.
 */
export function sanitizeResponse(responseText) {
  const text = String(responseText || '');
  if (!text) return text;
  let out = text;
  for (const { re } of PHI_REGEXES) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

/**
 * Classify consent freshness.
 *   - null/empty consentRef                               -> 'missing'
 *   - consentFresh === false                              -> 'stale'
 *   - consentFresh === true AND consentRef truthy         -> 'fresh'
 *   - otherwise                                           -> 'unknown'
 */
export function classifyConsent({ consentRef, consentFresh } = {}) {
  const ref = cleanText(consentRef);
  if (!ref) return 'missing';
  if (consentFresh === false) return 'stale';
  if (consentFresh === true && ref) return 'fresh';
  return 'unknown';
}

/**
 * Classify intent/script support. Returns one of:
 *   - 'supported'          — normalized intent != 'other' AND scriptKey provided
 *   - 'unsupported_intent' — normalized intent === 'other'
 *   - 'no_script'          — supported intent but no scriptKey
 */
export function classifyIntentSupport({ intent, scriptKey } = {}) {
  const normalizedIntent = normalizeIntent(intent);
  if (normalizedIntent === 'other') return 'unsupported_intent';
  const script = cleanText(scriptKey);
  if (!script) return 'no_script';
  return 'supported';
}

/**
 * Compose everything into a rule-based session classification. First match
 * wins.
 *
 * Returns {
 *   recommendation, severity, signals, phi_leak_count, urgent_signal_count,
 *   sanitized_response, consent_state, intent_support, language_state
 * }
 */
export function classifyVoiceSession({
  intent,
  channel,
  language,
  scriptKey,
  consentRef,
  consentFresh,
  transcriptText = '',
  candidateResponse = '',
} = {}) {
  const normalizedIntent = normalizeIntent(intent);
  const normalizedChannel = normalizeChannel(channel);
  const languageState = normalizeLanguage(language);
  const consentState = classifyConsent({ consentRef, consentFresh });
  const intentSupport = classifyIntentSupport({ intent: normalizedIntent, scriptKey });
  const urgent = detectUrgentSignals(transcriptText);
  const phi = detectPhiInResponse(candidateResponse);
  const sanitized = sanitizeResponse(candidateResponse);

  const signals = [];
  const pushSignal = (code, detail) => signals.push({ code, detail });

  let recommendation = 'no_action';
  let severity = 'low';

  // Rules (first match wins).
  if (consentState === 'missing') {
    recommendation = 'block';
    severity = 'critical';
    pushSignal('CONSENT_MISSING', 'Consent reference missing for voice/IVR outreach.');
  } else if (consentState === 'stale') {
    recommendation = 'block';
    severity = 'critical';
    pushSignal('CONSENT_STALE', 'Consent reference present but marked stale / not fresh.');
  } else if (consentState === 'unknown') {
    recommendation = 'block';
    severity = 'critical';
    pushSignal('CONSENT_UNKNOWN', 'Consent freshness is unknown; treat as missing.');
  } else if (phi.count > 0) {
    recommendation = 'block';
    severity = 'critical';
    pushSignal(
      'RESPONSE_PHI_LEAK',
      `Candidate response contains ${phi.count} PHI token(s); sanitized preview: ${truncate(sanitized, 160)}`
    );
  } else if (urgent.count > 0) {
    recommendation = 'escalate_to_clinician';
    severity = 'high';
    pushSignal(
      'URGENT_PATIENT_SIGNAL',
      `Transcript contains ${urgent.count} urgent term(s): ${urgent.signals.map((s) => s.term).join(', ')}.`
    );
  } else if (languageState === 'unsupported') {
    recommendation = 'fallback_to_human';
    severity = 'moderate';
    pushSignal('UNSUPPORTED_LANGUAGE', 'Requested language is not in the supported-language set.');
  } else if (intentSupport === 'unsupported_intent') {
    recommendation = 'fallback_to_human';
    severity = 'moderate';
    pushSignal('UNSUPPORTED_INTENT', 'Intent is not in the configured intent set; route to human.');
  } else if (intentSupport === 'no_script') {
    recommendation = 'fallback_to_human';
    severity = 'moderate';
    pushSignal('NO_SCRIPT', 'No script_key provided for supported intent; route to human.');
  } else {
    recommendation = 'allow';
    severity = 'low';
    pushSignal('SAFE_TO_DELIVER', 'Consent fresh, no urgent signals, no PHI in response, language + intent supported.');
  }

  // Carry forward urgent-term detail even when a higher-priority rule fired,
  // so reviewers still see the full context.
  for (const sig of urgent.signals) {
    signals.push({ code: 'URGENT_TERM_DETAIL', term: sig.term });
  }

  return {
    recommendation,
    severity,
    signals,
    phi_leak_count: phi.count,
    urgent_signal_count: urgent.count,
    sanitized_response: sanitized,
    consent_state: consentState,
    intent_support: intentSupport,
    language_state: languageState,
    normalized_intent: normalizedIntent,
    normalized_channel: normalizedChannel,
  };
}

/**
 * Escalate to the highest-priority severity per SEVERITY_PRIORITY. Higher
 * index = more severe.
 */
export function escalateSeverity(list) {
  const items = asArray(list);
  if (!items.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const entry of items) {
    const normalized = SEVERITIES.has(entry) ? entry : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Escalate to the highest-priority recommendation per
 * RECOMMENDATION_PRIORITY.
 */
export function escalateRecommendation(list) {
  const items = asArray(list);
  if (!items.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = RECOMMENDATION_PRIORITY.indexOf('unknown');
  for (const entry of items) {
    const normalized = RECOMMENDATIONS.has(entry) ? entry : 'unknown';
    const idx = RECOMMENDATION_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Build a reviewer-facing action list for the supplied recommendation.
 * Always ends with the review disclaimer.
 */
export function buildVoiceActions({
  recommendation = 'no_action',
  signals = [],
  patientUid = null,
} = {}) {
  const rec = RECOMMENDATIONS.has(cleanText(recommendation).toLowerCase())
    ? cleanText(recommendation).toLowerCase()
    : 'unknown';
  const pid = cleanText(patientUid);
  const signalCodes = asArray(signals).map((s) => s?.code).filter(Boolean);
  const actions = [];

  const hasCode = (code) => signalCodes.includes(code);

  switch (rec) {
    case 'block':
      if (hasCode('RESPONSE_PHI_LEAK')) {
        actions.push(
          pid
            ? `Block delivery for patient ${pid} \u2014 candidate response contains PHI; review the sanitized preview and regenerate without identifiers.`
            : 'Block delivery \u2014 candidate response contains PHI; review the sanitized preview and regenerate without identifiers.'
        );
      } else if (hasCode('CONSENT_MISSING') || hasCode('CONSENT_STALE') || hasCode('CONSENT_UNKNOWN')) {
        actions.push(
          pid
            ? `Block delivery for patient ${pid} \u2014 consent reference is missing or stale; re-consent before any outreach.`
            : 'Block delivery \u2014 consent reference is missing or stale; re-consent before any outreach.'
        );
      } else {
        actions.push(
          pid
            ? `Block delivery for patient ${pid} pending clinician review.`
            : 'Block delivery pending clinician review.'
        );
      }
      actions.push('Do not attempt to re-send from this module; no automated retry.');
      break;
    case 'escalate_to_clinician':
      actions.push(
        pid
          ? `Escalate patient ${pid} to clinician \u2014 transcript contains urgent/emergency language.`
          : 'Escalate to clinician \u2014 transcript contains urgent/emergency language.'
      );
      actions.push('Do not send the automated response; hand the session to on-call triage.');
      break;
    case 'fallback_to_human':
      if (hasCode('UNSUPPORTED_LANGUAGE')) {
        actions.push(
          pid
            ? `Route patient ${pid} to a human agent \u2014 requested language is not supported.`
            : 'Route to a human agent \u2014 requested language is not supported.'
        );
      } else if (hasCode('UNSUPPORTED_INTENT') || hasCode('NO_SCRIPT')) {
        actions.push(
          pid
            ? `Route patient ${pid} to a human agent \u2014 intent has no configured script.`
            : 'Route to a human agent \u2014 intent has no configured script.'
        );
      } else {
        actions.push(
          pid
            ? `Route patient ${pid} to a human agent.`
            : 'Route to a human agent.'
        );
      }
      break;
    case 'allow':
      actions.push(
        pid
          ? `Reviewer can approve delivery of the candidate response to patient ${pid}; the downstream dispatcher will send only after approval (or via an admin-approved template path).`
          : 'Reviewer can approve delivery of the candidate response; the downstream dispatcher will send only after approval (or via an admin-approved template path).'
      );
      break;
    case 'no_action':
      actions.push('No action required; session logged for audit.');
      break;
    default:
      actions.push('Recommendation unknown \u2014 confirm inputs and review with a clinician.');
      break;
  }

  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence summary for the reviewer / event payload.
 */
export function summarizeVoiceSession({
  patientUid = null,
  intent = 'other',
  recommendation = 'no_action',
  severity = 'low',
} = {}) {
  const pid = cleanText(patientUid) || 'unknown-patient';
  const normIntent = normalizeIntent(intent);
  const rec = RECOMMENDATIONS.has(cleanText(recommendation).toLowerCase())
    ? cleanText(recommendation).toLowerCase()
    : 'unknown';
  const sev = SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : 'unknown';
  return `Voice/IVR session for ${pid} (intent=${normIntent}): ${rec} (${sev}).`;
}

// ---------- DB loaders / writers ----------------------------------------

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  patientUid,
  admissionId,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = asArray(safetyFlags).some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6,
               $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
               $14::uuid, $15, $16, $17, $18, $19::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      admissionId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(citations || []),
      JSON.stringify(draft || {}),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Voice IVR generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, patientUid, admissionId, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'NURSE', 'ADMIN'],
        source: 'voice_patient_assistant_ivr',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Voice IVR review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeSessionRow(row) {
  if (!row) return row;
  return {
    ...row,
    phi_leak_count: toNumber(row.phi_leak_count, 0),
    urgent_signal_count: toNumber(row.urgent_signal_count, 0),
    generation_id:
      row.generation_id !== null && row.generation_id !== undefined
        ? toNumber(row.generation_id, null)
        : null,
    admission_id:
      row.admission_id !== null && row.admission_id !== undefined
        ? toNumber(row.admission_id, null)
        : null,
  };
}

async function insertSessionRow({
  tenantId,
  patientUid,
  admissionId,
  generationId,
  intent,
  channel,
  language,
  scriptKey,
  consentRef,
  consentFresh,
  transcriptPreview,
  sanitizedResponse,
  recommendation,
  severity,
  phiLeakCount,
  urgentSignalCount,
  signals,
  summary,
  recommendedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_voice_ivr_sessions
         (tenant_id, patient_uid, admission_id, generation_id, intent, channel,
          language, script_key, consent_ref, consent_fresh, transcript_preview,
          sanitized_response, recommendation, severity, phi_leak_count,
          urgent_signal_count, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6,
               $7, $8, $9, $10, $11,
               $12, $13, $14, $15,
               $16, $17::jsonb, $18, $19::jsonb,
               $20::jsonb, $21::jsonb, 'pending', $22::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, generation_id, intent,
                 channel, language, script_key, consent_ref, consent_fresh,
                 transcript_preview, sanitized_response, recommendation, severity,
                 phi_leak_count, urgent_signal_count, signals, summary,
                 recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      admissionId,
      generationId,
      INTENTS.has(intent) ? intent : 'other',
      CHANNELS.has(channel) ? channel : 'unknown',
      language,
      scriptKey,
      consentRef,
      Boolean(consentFresh),
      transcriptPreview,
      sanitizedResponse,
      RECOMMENDATIONS.has(recommendation) ? recommendation : 'unknown',
      SEVERITIES.has(severity) ? severity : 'unknown',
      toNumber(phiLeakCount, 0),
      toNumber(urgentSignalCount, 0),
      JSON.stringify(signals || []),
      summary,
      JSON.stringify(recommendedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeSessionRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateVoiceSession({
  req = null,
  patientUid,
  admissionId = null,
  intent,
  channel = 'ivr',
  language = 'en',
  scriptKey = null,
  consentRef = null,
  consentFresh = false,
  transcriptText = '',
  candidateResponse = '',
  metadata = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const cleanedPatientUid = cleanText(patientUid);
  if (!cleanedPatientUid) {
    throw AppError.badRequest('patient_uid is required');
  }
  if (!cleanText(intent)) {
    throw AppError.badRequest('intent is required');
  }

  const safeAdmissionId = optionalIntOrNull(admissionId);

  const classification = classifyVoiceSession({
    intent,
    channel,
    language,
    scriptKey,
    consentRef,
    consentFresh,
    transcriptText,
    candidateResponse,
  });

  const {
    recommendation,
    severity,
    signals,
    phi_leak_count,
    urgent_signal_count,
    sanitized_response,
    consent_state,
    intent_support,
    language_state,
    normalized_intent,
    normalized_channel,
  } = classification;

  const transcriptPreview = truncate(String(transcriptText || ''), 500);

  const summary = summarizeVoiceSession({
    patientUid: cleanedPatientUid,
    intent: normalized_intent,
    recommendation,
    severity,
  });

  const recommendedActions = buildVoiceActions({
    recommendation,
    signals,
    patientUid: cleanedPatientUid,
  });

  // Citations: patient record ref, voice_ivr_rules reference, optional consent_ref.
  const citationsRaw = [
    {
      source_type: 'patient',
      source_id: cleanedPatientUid,
      label: 'Patient record',
      timestamp: null,
    },
    {
      source_type: 'voice_ivr_rules',
      source_id: MODULE_KEY,
      label: 'Voice/IVR classification rules (consent, urgent-phrase, PHI, language, intent)',
      timestamp: null,
    },
  ];
  if (cleanText(consentRef)) {
    citationsRaw.push({
      source_type: 'consent',
      source_id: cleanText(consentRef),
      label: `Consent reference ${cleanText(consentRef)}${consentFresh ? ' (fresh)' : ' (stale)'}`,
      timestamp: null,
    });
  }
  const citations = uniqueCitations(citationsRaw);

  const safetyFlags = [];
  if (consent_state === 'missing' || consent_state === 'stale' || consent_state === 'unknown') {
    safetyFlags.push({
      severity: 'critical',
      code: 'CONSENT_MISSING',
      message: `Voice/IVR outreach blocked \u2014 consent ${consent_state}; re-consent before any delivery attempt.`,
    });
  }
  if (phi_leak_count > 0) {
    safetyFlags.push({
      severity: 'critical',
      code: 'RESPONSE_PHI_LEAK',
      message: `Candidate response contains ${phi_leak_count} PHI token(s); blocked and sanitized preview persisted for review.`,
    });
  }
  if (urgent_signal_count > 0) {
    safetyFlags.push({
      severity: 'high',
      code: 'URGENT_PATIENT_SIGNAL',
      message: `Transcript contains ${urgent_signal_count} urgent term(s); escalating to clinician.`,
    });
  }
  if (!citations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Voice/IVR session has no source citations.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'VOICE_IVR_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only \u2014 the module never plays audio or sends a reply.',
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: cleanedPatientUid,
    admission_id: safeAdmissionId,
    intent: normalized_intent,
    channel: normalized_channel,
    language: language_state === 'unsupported' ? cleanText(language).toLowerCase() : language_state,
    script_key: cleanText(scriptKey) || null,
    consent_ref: cleanText(consentRef) || null,
    consent_fresh: Boolean(consentFresh),
    recommendation,
    severity,
    signals,
    phi_leak_count,
    urgent_signal_count,
    sanitized_response,
    consent_state,
    intent_support,
    language_state,
    transcript_preview: transcriptPreview,
    summary,
    recommended_actions: recommendedActions,
    source_citations: citations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = null;
  let draft = fallbackDraft;
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        session_context: {
          patient_uid: cleanedPatientUid,
          intent: normalized_intent,
          channel: normalized_channel,
          language: language_state,
          script_key: cleanText(scriptKey) || null,
          consent_state,
          consent_ref: cleanText(consentRef) || null,
          consent_fresh: Boolean(consentFresh),
          transcript_preview: transcriptPreview,
          candidate_response_preview: truncate(String(candidateResponse || ''), 500),
        },
        rule_based_evaluation: {
          recommendation,
          severity,
          phi_leak_count,
          urgent_signal_count,
          sanitized_response,
          signals,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
        // Never let AI override rule-based recommendation, severity, signal
        // counts, sanitized_response, consent/intent/language states, or the
        // signal list.
      };
    }
  } catch (err) {
    logger.debug('Voice IVR AI narrative unavailable; using rule summary fallback', {
      error: err?.message,
    });
    draft = fallbackDraft;
  }

  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        voice_ivr: {
          patient_uid: cleanedPatientUid,
          intent: normalized_intent,
          recommendation,
          severity,
        },
      },
      citations: draft.source_citations,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  const generation = await insertGeneration({
    tenantId,
    patientUid: cleanedPatientUid,
    admissionId: safeAdmissionId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: cleanedPatientUid,
      intent: normalized_intent,
      channel: normalized_channel,
      language: language_state,
      consent_state,
      phi_leak_count,
      urgent_signal_count,
      recommendation,
      severity,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      intent: normalized_intent,
      channel: normalized_channel,
      language: language_state,
      consent_state,
      rules_authoritative: true,
      decision_support_only: true,
      ...((metadata && typeof metadata === 'object') ? metadata : {}),
    },
  });

  const sessionRow = await insertSessionRow({
    tenantId,
    patientUid: cleanedPatientUid,
    admissionId: safeAdmissionId,
    generationId: generation?.id || null,
    intent: normalized_intent,
    channel: normalized_channel,
    language: language_state === 'unsupported' ? cleanText(language).toLowerCase() : language_state,
    scriptKey: cleanText(scriptKey) || null,
    consentRef: cleanText(consentRef) || null,
    consentFresh: Boolean(consentFresh),
    transcriptPreview,
    sanitizedResponse: sanitized_response,
    recommendation,
    severity,
    phiLeakCount: phi_leak_count,
    urgentSignalCount: urgent_signal_count,
    signals,
    summary: draft.summary,
    recommendedActions,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      consent_state,
      intent_support,
      language_state,
      rules_authoritative: true,
      decision_support_only: true,
      ...((metadata && typeof metadata === 'object') ? metadata : {}),
    },
  });

  if (!sessionRow) {
    return {
      session_id: null,
      generation_id: generation?.id || null,
      clinical_review_id: null,
      draft,
      session: null,
      recommendation,
      severity,
      signals,
      phi_leak_count,
      urgent_signal_count,
      sanitized_response,
      consent_state,
      intent_support,
      language_state,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_voice_ivr_sessions_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      ai_metadata: {
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        used_ai: Boolean(aiResult?.usedAi),
      },
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid: cleanedPatientUid,
    admissionId: safeAdmissionId,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.voice_ivr_session_evaluated',
      aggregateType: 'clinical_ai_voice_ivr_session',
      aggregateId: sessionRow.id,
      patientUid: cleanedPatientUid,
      payload: {
        tenant_id: tenantId,
        session_id: sessionRow.id,
        generation_id: generation?.id || null,
        patient_uid: cleanedPatientUid,
        intent: normalized_intent,
        channel: normalized_channel,
        language: language_state,
        recommendation,
        severity,
        phi_leak_count,
        urgent_signal_count,
        consent_state,
        signal_codes: asArray(signals).map((s) => s?.code).filter(Boolean),
      },
    });
  } catch (err) {
    logger.warn('Voice IVR event publish failed', { error: err?.message });
  }

  return {
    session_id: sessionRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    session: sessionRow,
    recommendation,
    severity,
    signals,
    phi_leak_count,
    urgent_signal_count,
    sanitized_response,
    consent_state,
    intent_support,
    language_state,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || sessionRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listVoiceSessions({
  tenantId = null,
  patientUid = null,
  intent = null,
  channel = null,
  recommendation = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedIntent = intent && INTENTS.has(cleanText(intent).toLowerCase())
    ? cleanText(intent).toLowerCase()
    : null;
  const normalizedChannel = channel && CHANNELS.has(cleanText(channel).toLowerCase())
    ? cleanText(channel).toLowerCase()
    : null;
  const normalizedRecommendation = recommendation
    && RECOMMENDATIONS.has(cleanText(recommendation).toLowerCase())
    ? cleanText(recommendation).toLowerCase()
    : null;
  const normalizedSeverity = severity && SEVERITIES.has(cleanText(severity).toLowerCase())
    ? cleanText(severity).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision
    && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.tenant_id, s.patient_uid, s.admission_id, s.generation_id,
              s.intent, s.channel, s.language, s.script_key, s.consent_ref,
              s.consent_fresh, s.transcript_preview, s.sanitized_response,
              s.recommendation, s.severity, s.phi_leak_count, s.urgent_signal_count,
              s.signals, s.summary, s.recommended_actions, s.source_citations,
              s.safety_flags, s.reviewer_decision, s.reviewed_by, s.reviewed_at,
              s.reviewer_note, s.metadata, s.created_at, s.updated_at
       FROM clinical_ai_voice_ivr_sessions s
       WHERE s.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR s.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR s.intent = $3)
         AND ($4::text IS NULL OR s.channel = $4)
         AND ($5::text IS NULL OR s.recommendation = $5)
         AND ($6::text IS NULL OR s.severity = $6)
         AND ($7::text IS NULL OR s.reviewer_decision = $7)
       ORDER BY
         CASE s.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         s.created_at DESC
       LIMIT $8`,
      tid,
      patientUid || null,
      normalizedIntent,
      normalizedChannel,
      normalizedRecommendation,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeSessionRow);
    return { sessions: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { sessions: [], count: 0 };
    throw err;
  }
}

export async function decideVoiceSession({
  tenantId = null,
  sessionId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_voice_ivr_sessions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, patient_uid, admission_id, generation_id, intent,
               channel, language, script_key, consent_ref, consent_fresh,
               transcript_preview, sanitized_response, recommendation, severity,
               phi_leak_count, urgent_signal_count, signals, summary,
               recommended_actions, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(sessionId, 'session_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Voice IVR session not found');
  return normalizeSessionRow(rows[0]);
}

export default {
  MODULE_KEY,
  INTENTS,
  CHANNELS,
  RECOMMENDATIONS,
  RECOMMENDATION_PRIORITY,
  SEVERITIES,
  SEVERITY_PRIORITY,
  SUPPORTED_LANGUAGES,
  DECISIONS,
  FINAL_DECISIONS,
  normalizeIntent,
  normalizeChannel,
  normalizeLanguage,
  detectUrgentSignals,
  detectPhiInResponse,
  sanitizeResponse,
  classifyConsent,
  classifyIntentSupport,
  classifyVoiceSession,
  escalateSeverity,
  escalateRecommendation,
  buildVoiceActions,
  summarizeVoiceSession,
  evaluateVoiceSession,
  listVoiceSessions,
  decideVoiceSession,
};
