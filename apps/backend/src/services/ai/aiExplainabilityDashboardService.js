/**
 * AI Explainability Dashboard.
 *
 * For any clinical AI draft (any row in clinical_ai_generations), compute an
 * explainability report: citation coverage %, unsupported-claim count,
 * numeric coherence (do numbers in the narrative appear in the citations?),
 * PHI leakage risk, bias markers (gendered / age / race language in the
 * narrative that's unsupported by the chart), and a reviewer-friendly
 * evidence map (which sentences trace to which citations). Rules are
 * authoritative: the trust band (trusted / review / reject) and severity
 * are produced by a deterministic rule-based evaluator. Review-only — the
 * AI governance lead uses this to green-light a draft for clinical workflow;
 * the module never modifies the underlying draft.
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

const MODULE_KEY = 'ai_explainability_dashboard';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the AI explainability dashboard. Rules are authoritative. Return JSON only and never modify the underlying clinical AI draft — AI governance review is required for every green-light decision.',
  user_prompt_template:
    'Given the clinical AI draft, citations, chart context, and the rule-based explainability evaluation, return keys: summary, recommended_actions, source_citations, safety_flags. Do not override the rule-based trust band or severity, and do not modify the underlying draft.',
};

// ---------- Constants (exported) ----------------------------------------

export const TRUST_BANDS = new Set(['trusted', 'review', 'reject', 'unknown']);
// Most-restrictive-wins ordering: higher index = more restrictive.
// Order from least restrictive to most restrictive:
//   unknown (no signal) → trusted → review → reject
export const TRUST_PRIORITY = ['unknown', 'trusted', 'review', 'reject'];

export const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
// Higher index = higher severity.
export const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'AI governance review required — decision support only; the underlying draft is never modified.';

// Assertive keywords used to identify candidate "claim" sentences.
const ASSERTIVE_KEYWORDS = [
  'patient',
  'diagnosis',
  'treatment',
  'dose',
  'recommend',
  'started',
  'stopped',
  'severe',
  'acute',
  'improving',
  'worsening',
];

// Bias term dictionaries — matched as whole words, case-insensitive.
const GENDER_TERMS = [
  'male', 'female', 'man', 'woman', 'boy', 'girl',
  'he', 'she', 'his', 'her',
];
const AGE_TERMS = [
  'elderly', 'geriatric', 'young', 'old', 'aged', 'pediatric',
];
const ETHNICITY_TERMS = [
  'asian', 'african', 'hispanic', 'caucasian', 'indian', 'white', 'black',
];

// ---------- Small helpers -----------------------------------------------

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

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
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

function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Pure helpers (exported) -------------------------------------

/**
 * Split text into trimmed non-empty sentences by sentence-terminating
 * punctuation followed by whitespace.
 */
export function splitSentences(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  return s
    .split(/[.!?]+\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Extract numeric tokens from text. Returns an array of
 *   { value: Number, raw: string, unit: string|null }
 * Pure 4-digit tokens in the year range (1900..2100) are treated as
 * years and excluded UNLESS a unit follows.
 */
export function extractNumbers(text) {
  const s = String(text || '');
  if (!s) return [];
  const out = [];
  const re = /(\d+(?:\.\d+)?)(\s*[%°]?\s*[a-zA-Z/]+)?/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const numericStr = match[1];
    const rawUnit = match[2] ? match[2].trim() : null;
    const value = Number(numericStr);
    if (!Number.isFinite(value)) continue;
    // A "real" unit starts with % or °, or is a short (≤4 char) letter
    // token like mg/ml/kg/C/F/mmHg/dL. Longer words like "without" are
    // prose continuation, not a unit.
    const hasSymbolPrefix = rawUnit ? /^[%°]/.test(rawUnit) : false;
    const isShortLetterUnit = rawUnit ? /^[a-zA-Z/]{1,4}$/.test(rawUnit) : false;
    const unitStr = rawUnit && (hasSymbolPrefix || isShortLetterUnit) ? rawUnit : null;
    // Skip pure 4-digit years when no genuine unit follows.
    if (!unitStr && /^\d{4}$/.test(numericStr)) {
      if (value > 1900 && value <= 2100) continue;
    }
    out.push({
      value,
      raw: numericStr,
      unit: unitStr || null,
    });
  }
  return out;
}

/**
 * Compute citation coverage percentage and sentence-level evidence map.
 *
 * For each sentence, test if any citation label/source_id substring
 * (case-insensitive, ≥ 4 chars) appears. Coverage is the fraction of
 * sentences with at least one matched citation, rounded to 2dp.
 */
export function computeCitationCoverage({ draftText, citations } = {}) {
  const text = String(draftText || '');
  const sentences = splitSentences(text);
  const citationList = asArray(citations);
  if (!sentences.length) {
    return { coverage_pct: 0, evidence_map: [] };
  }

  // Build a list of { id, tokens } where tokens are ≥4-char lowercased
  // substrings drawn from label + source_id.
  const citationTokens = citationList.map((citation, idx) => {
    const cid = citation?.source_id ? String(citation.source_id) : `citation_${idx}`;
    const pieces = [];
    const label = cleanText(citation?.label || '');
    const sourceId = String(citation?.source_id || '');
    // Gather candidate tokens: whole label, whole source_id, and each
    // ≥4-char word from the label.
    if (label.length >= 4) pieces.push(label.toLowerCase());
    if (sourceId.length >= 4) pieces.push(sourceId.toLowerCase());
    for (const word of label.split(/\W+/)) {
      if (word && word.length >= 4) pieces.push(word.toLowerCase());
    }
    return { id: cid, tokens: Array.from(new Set(pieces)) };
  });

  const evidenceMap = [];
  let matchedCount = 0;
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const matchedIds = [];
    for (const cit of citationTokens) {
      for (const token of cit.tokens) {
        if (token.length < 4) continue;
        if (lower.includes(token)) {
          matchedIds.push(cit.id);
          break;
        }
      }
    }
    if (matchedIds.length) matchedCount += 1;
    evidenceMap.push({ sentence, matched_citation_ids: matchedIds });
  }

  const coverage = (matchedCount / sentences.length) * 100;
  return {
    coverage_pct: round2(coverage),
    evidence_map: evidenceMap,
  };
}

/**
 * Detect sentences that make an assertive clinical claim but have no
 * supporting citation. Sentences shorter than 5 words are skipped.
 */
export function detectUnsupportedClaims({ draftText, citations } = {}) {
  const { evidence_map } = computeCitationCoverage({ draftText, citations });
  const claims = [];
  for (const entry of evidence_map) {
    const sentence = entry.sentence;
    const wordCount = sentence.split(/\s+/).filter(Boolean).length;
    if (wordCount < 5) continue;
    const lower = sentence.toLowerCase();
    const hasAssertive = ASSERTIVE_KEYWORDS.some((kw) => lower.includes(kw));
    if (!hasAssertive) continue;
    if (!entry.matched_citation_ids || entry.matched_citation_ids.length === 0) {
      claims.push(sentence);
    }
  }
  return { claims, count: claims.length };
}

/**
 * Check whether numeric tokens in the draft are supported by the
 * citations. Searches the concatenated citation labels + source_ids for
 * the literal number (allow ±10% tolerance for decimals).
 *
 * Returns { coherence_pct, mismatches: [{ value, context, citation_pool_preview }] }.
 */
export function checkNumericCoherence({ draftText, citations } = {}) {
  const text = String(draftText || '');
  const numbers = extractNumbers(text);
  if (!numbers.length) {
    return { coherence_pct: 100, mismatches: [] };
  }
  const citationList = asArray(citations);
  const pool = citationList
    .map((c) => `${cleanText(c?.label || '')} ${String(c?.source_id || '')}`.trim())
    .filter(Boolean);
  const poolStr = pool.join(' | ');
  const poolLower = poolStr.toLowerCase();

  const mismatches = [];
  let matched = 0;
  for (const num of numbers) {
    const { value, raw } = num;
    let found = false;
    if (poolLower) {
      // Direct literal match (word-boundary-ish).
      const literal = String(value);
      const rawLower = String(raw).toLowerCase();
      if (poolLower.includes(literal) || poolLower.includes(rawLower)) {
        found = true;
      }
      // Decimal ±10% tolerance scan against numbers present in the pool.
      if (!found && !Number.isInteger(value)) {
        const poolNumbers = extractNumbers(poolStr).map((p) => p.value);
        const tolerance = Math.abs(value) * 0.1;
        for (const pv of poolNumbers) {
          if (Math.abs(pv - value) <= tolerance) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) {
      matched += 1;
      continue;
    }
    // Build context around the first occurrence of the raw token in the draft.
    const idx = text.indexOf(raw);
    const start = Math.max(0, idx - 60);
    const end = idx >= 0 ? Math.min(text.length, idx + raw.length + 60) : 0;
    const contextSlice = idx >= 0 ? text.slice(start, end) : String(raw);
    mismatches.push({
      value,
      context: contextSlice,
      citation_pool_preview: pool.slice(0, 3),
    });
  }
  const coherence = (matched / numbers.length) * 100;
  return {
    coherence_pct: round2(coherence),
    mismatches,
  };
}

/**
 * Detect PHI indicators in the draft text.
 *   PHONE_LEAK    — 10-digit runs or +91-prefixed numbers
 *   MRN_LEAK      — MRN: prefixed tokens or VH- prefixed tokens
 *   EMAIL_LEAK    — email-like tokens
 *   AADHAAR_LEAK  — 12-digit runs
 */
export function detectPhiLeakage(draftText) {
  const text = String(draftText || '');
  const leaks = [];
  if (!text) return { leaks, count: 0 };

  const pushLeak = (code, sample) => {
    leaks.push({ code, sample: String(sample).slice(0, 40) });
  };

  // AADHAAR first (12-digit) so a 12-digit doesn't get grabbed as a phone.
  const aadhaarRe = /\b\d{12}\b/g;
  let m;
  while ((m = aadhaarRe.exec(text)) !== null) {
    pushLeak('AADHAAR_LEAK', m[0]);
  }

  // PHONE: +91-prefixed (with optional separators) or bare 10-digit runs.
  // Avoid 12-digit overlap by requiring a non-digit (or string start/end) around
  // 10-digit matches.
  const phoneRe = /(?:\+91[\s-]*\d{10})|(?:(?<!\d)\d{10}(?!\d))/g;
  while ((m = phoneRe.exec(text)) !== null) {
    pushLeak('PHONE_LEAK', m[0]);
  }

  // MRN: explicit 'MRN' prefix or VH- prefixed identifier.
  const mrnRe = /(?:MRN[:\s-]*\w+)|(?:VH-\w+)/gi;
  while ((m = mrnRe.exec(text)) !== null) {
    pushLeak('MRN_LEAK', m[0]);
  }

  // EMAIL: simple email-like pattern.
  const emailRe = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  while ((m = emailRe.exec(text)) !== null) {
    pushLeak('EMAIL_LEAK', m[0]);
  }

  return { leaks, count: leaks.length };
}

/**
 * Detect bias markers: gender/age/ethnicity language in the draft that
 * is not supported by the contextText (i.e. not present in the chart
 * context that the draft was generated from).
 *
 * Returns { markers: [{ code, term, sentence }], count }.
 */
export function detectBiasMarkers({ draftText, contextText = '' } = {}) {
  const text = String(draftText || '');
  const context = String(contextText || '');
  if (!text) return { markers: [], count: 0 };

  const contextLower = context.toLowerCase();
  const sentences = splitSentences(text);
  if (!sentences.length) return { markers: [], count: 0 };

  const markers = [];

  const scan = (terms, code) => {
    for (const term of terms) {
      const termLower = term.toLowerCase();
      // Skip if the context supports the term.
      const contextRe = new RegExp(`\\b${escapeRegex(termLower)}\\b`, 'i');
      if (contextRe.test(contextLower)) continue;
      const draftRe = new RegExp(`\\b${escapeRegex(termLower)}\\b`, 'i');
      for (const sentence of sentences) {
        if (draftRe.test(sentence)) {
          markers.push({ code, term: termLower, sentence });
        }
      }
    }
  };

  scan(GENDER_TERMS, 'UNSUPPORTED_GENDER_TERM');
  scan(AGE_TERMS, 'UNSUPPORTED_AGE_TERM');
  scan(ETHNICITY_TERMS, 'UNSUPPORTED_ETHNICITY_TERM');

  return { markers, count: markers.length };
}

/**
 * Rules-authoritative trust-band classifier. First match wins.
 *
 *   1. phi_leakage_count > 0 → 'reject' / 'critical' / PHI_LEAKAGE
 *   2. unsupported_claim_count >= 3 OR numeric_coherence < 50
 *      → 'reject' / 'high' / HIGH_UNSUPPORTED_CONTENT
 *   3. citation_coverage < 40 OR unsupported_claim_count >= 1 OR
 *      bias_marker_count >= 2 OR numeric_coherence < 80
 *      → 'review' / 'moderate' / NEEDS_REVIEW
 *   4. citation_coverage < 70 OR bias_marker_count >= 1
 *      → 'review' / 'low' / PARTIAL_COVERAGE
 *   5. else → 'trusted' / 'low' / TRUSTED_DRAFT
 */
export function classifyTrustBand({
  citationCoveragePct,
  unsupportedClaimCount,
  numericCoherencePct,
  phiLeakageCount,
  biasMarkerCount,
} = {}) {
  const coverage = toNumber(citationCoveragePct, 0);
  const unsupported = toNumber(unsupportedClaimCount, 0);
  const coherence = toNumber(numericCoherencePct, 100);
  const phi = toNumber(phiLeakageCount, 0);
  const bias = toNumber(biasMarkerCount, 0);

  if (phi > 0) {
    return {
      trust_band: 'reject',
      severity: 'critical',
      signals: [{ code: 'PHI_LEAKAGE', detail: `phi_leakage_count=${phi}` }],
    };
  }
  if (unsupported >= 3 || coherence < 50) {
    return {
      trust_band: 'reject',
      severity: 'high',
      signals: [{
        code: 'HIGH_UNSUPPORTED_CONTENT',
        detail: `unsupported_claim_count=${unsupported}, numeric_coherence_pct=${coherence}`,
      }],
    };
  }
  if (coverage < 40 || unsupported >= 1 || bias >= 2 || coherence < 80) {
    return {
      trust_band: 'review',
      severity: 'moderate',
      signals: [{
        code: 'NEEDS_REVIEW',
        detail: `citation_coverage_pct=${coverage}, unsupported_claim_count=${unsupported}, bias_marker_count=${bias}, numeric_coherence_pct=${coherence}`,
      }],
    };
  }
  if (coverage < 70 || bias >= 1) {
    return {
      trust_band: 'review',
      severity: 'low',
      signals: [{
        code: 'PARTIAL_COVERAGE',
        detail: `citation_coverage_pct=${coverage}, bias_marker_count=${bias}`,
      }],
    };
  }
  return {
    trust_band: 'trusted',
    severity: 'low',
    signals: [{ code: 'TRUSTED_DRAFT' }],
  };
}

/**
 * Escalate a list of trust bands to the most restrictive per
 * TRUST_PRIORITY (reject > review > trusted > unknown).
 */
export function escalateTrustBand(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = TRUST_PRIORITY.indexOf('unknown');
  for (const band of arr) {
    const normalized = TRUST_BANDS.has(band) ? band : 'unknown';
    const idx = TRUST_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Escalate a list of severities to the highest per SEVERITY_PRIORITY.
 */
export function escalateSeverity(list) {
  const arr = asArray(list);
  if (!arr.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = SEVERITY_PRIORITY.indexOf('unknown');
  for (const sev of arr) {
    const normalized = SEVERITIES.has(sev) ? sev : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Build reviewer-facing action strings for a given trust band and the
 * matched signal codes. Always ends with the AI-governance disclaimer.
 */
export function buildExplainabilityActions({ trustBand, signals = [] } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const text = cleanText(line);
    if (!text || seen.has(text)) return;
    seen.add(text);
    actions.push(text);
  };

  switch (trustBand) {
    case 'reject':
      push('Reject the draft — do not promote to clinical workflow until the reviewer resolves the blocking signals.');
      push('Notify the draft author and AI governance; attach the explainability report and the failing signals.');
      break;
    case 'review':
      push('Hold the draft for AI governance review — the rule-based signals indicate partial coverage or unsupported content.');
      push('Reviewer should verify each unsupported claim and bias marker against the source chart before green-lighting.');
      break;
    case 'trusted':
      push('Draft passes rule-based explainability checks; AI governance may green-light for clinical workflow.');
      push('Continue spot-check auditing to monitor ongoing trust-band distribution.');
      break;
    case 'unknown':
    default:
      push('Trust band could not be determined — confirm the draft and citations are complete before review.');
      break;
  }

  for (const signal of asArray(signals)) {
    const code = signal?.code;
    if (!code) continue;
    if (code === 'PHI_LEAKAGE') {
      push('Reject draft — PHI indicator detected in the narrative. Redact the identifier and regenerate the draft before re-review.');
    } else if (code === 'HIGH_UNSUPPORTED_CONTENT') {
      push('Reject draft — either three or more unsupported claims are present, or numeric coherence is below 50%.');
    } else if (code === 'NEEDS_REVIEW') {
      push('Reviewer must inspect unsupported claims, low citation coverage, or bias markers before any green-light decision.');
    } else if (code === 'PARTIAL_COVERAGE') {
      push('Confirm partial citation coverage is acceptable for this module type before approving.');
    } else if (code === 'TRUSTED_DRAFT') {
      push('No reviewer action required beyond standard governance spot-check.');
    }
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence human summary of an explainability evaluation.
 */
export function summarizeExplainability({
  moduleKey,
  trustBand,
  severity,
  citationCoveragePct,
  unsupportedClaimCount,
  phiLeakageCount,
} = {}) {
  const key = cleanText(moduleKey) || 'unknown_module';
  const band = TRUST_BANDS.has(trustBand) ? trustBand : 'unknown';
  const sev = SEVERITIES.has(severity) ? severity : 'unknown';
  const cov = toNumber(citationCoveragePct, 0);
  const unsup = toNumber(unsupportedClaimCount, 0);
  const phi = toNumber(phiLeakageCount, 0);
  return `Explainability — ${key}: trust_band=${band} (${sev}), citation_coverage=${cov}%, unsupported_claims=${unsup}, phi_leakage=${phi}.`;
}

// ---------- DB helpers --------------------------------------------------

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

function normalizeReportRow(row) {
  if (!row) return row;
  return {
    ...row,
    source_generation_id: row.source_generation_id !== null && row.source_generation_id !== undefined
      ? toNumber(row.source_generation_id, null)
      : null,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    citation_coverage_pct: toNumber(row.citation_coverage_pct, 0),
    unsupported_claim_count: toNumber(row.unsupported_claim_count, 0),
    numeric_coherence_pct: toNumber(row.numeric_coherence_pct, 100),
    phi_leakage_count: toNumber(row.phi_leakage_count, 0),
    bias_marker_count: toNumber(row.bias_marker_count, 0),
  };
}

async function insertGeneration({
  tenantId,
  patientUid,
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
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $3, $4, $5,
               $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
               $13::uuid, $14, $15, $16, $17, $18::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
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
      logger.warn('AI explainability generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, NULL, 'pending', $5::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'AI_EVAL_LEAD', 'AI_GOVERNANCE'],
        source: 'ai_explainability_dashboard',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('AI explainability review placeholder failed', { error: err.message });
    }
    return null;
  }
}

// ---------- Public API --------------------------------------------------

/**
 * Evaluate a clinical AI draft for explainability signals and persist a
 * governance-ready report. Does NOT modify the underlying draft.
 */
export async function evaluateExplainability({
  req = null,
  sourceGenerationId = null,
  moduleKey = null,
  patientUid = null,
  draftText,
  citations = [],
  contextText = '',
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const cleanedDraft = String(draftText || '').trim();
  if (!cleanedDraft) {
    throw AppError.badRequest('draft_text is required');
  }
  const sourceGenId = sourceGenerationId ? optionalInt(sourceGenerationId, 'source_generation_id') : null;
  const patientUidValue = patientUid ? cleanText(patientUid) : null;
  const targetModuleKey = moduleKey ? cleanText(moduleKey) : null;

  // ---- Rule-based evaluation ----
  const coverage = computeCitationCoverage({ draftText: cleanedDraft, citations });
  const unsupported = detectUnsupportedClaims({ draftText: cleanedDraft, citations });
  const numeric = checkNumericCoherence({ draftText: cleanedDraft, citations });
  const phi = detectPhiLeakage(cleanedDraft);
  const bias = detectBiasMarkers({ draftText: cleanedDraft, contextText });

  const classification = classifyTrustBand({
    citationCoveragePct: coverage.coverage_pct,
    unsupportedClaimCount: unsupported.count,
    numericCoherencePct: numeric.coherence_pct,
    phiLeakageCount: phi.count,
    biasMarkerCount: bias.count,
  });

  const trustBand = TRUST_BANDS.has(classification.trust_band) ? classification.trust_band : 'unknown';
  const severity = SEVERITIES.has(classification.severity) ? classification.severity : 'unknown';

  // ---- Citations ----
  const builtCitations = [];
  if (sourceGenId) {
    builtCitations.push({
      source_type: 'clinical_ai_generation',
      source_id: String(sourceGenId),
      label: `Clinical AI generation #${sourceGenId}`,
      timestamp: null,
    });
  }
  for (const c of asArray(citations)) {
    if (!c) continue;
    builtCitations.push(c);
  }
  builtCitations.push({
    source_type: 'explainability_rules',
    source_id: MODULE_KEY,
    label: 'AI explainability rule reference',
    timestamp: null,
  });
  const finalCitations = uniqueCitations(builtCitations);

  // ---- Safety flags ----
  const safetyFlags = [];
  for (const leak of phi.leaks) {
    safetyFlags.push({
      severity: 'critical',
      code: 'PHI_LEAKAGE',
      message: `Potential PHI indicator (${leak.code}) present in the draft narrative.`,
    });
  }
  for (const marker of bias.markers) {
    safetyFlags.push({
      severity: 'medium',
      code: 'BIAS_MARKER',
      message: `Unsupported ${marker.code.toLowerCase()} detected in the draft: "${marker.term}".`,
    });
  }
  if (coverage.coverage_pct < 40) {
    safetyFlags.push({
      severity: 'medium',
      code: 'LOW_CITATION_COVERAGE',
      message: `Citation coverage is ${coverage.coverage_pct}% — below the 40% review threshold.`,
    });
  }
  if (!asArray(citations).length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Draft was supplied without any citations — reviewer must confirm sourcing.',
    });
  }

  const summary = summarizeExplainability({
    moduleKey: targetModuleKey || 'clinical_ai_draft',
    trustBand,
    severity,
    citationCoveragePct: coverage.coverage_pct,
    unsupportedClaimCount: unsupported.count,
    phiLeakageCount: phi.count,
  });
  const recommendedActions = buildExplainabilityActions({
    trustBand,
    signals: classification.signals,
  });

  // ---- Fallback draft (rule-based, never modifies underlying) ----
  const fallbackDraft = {
    module_key: MODULE_KEY,
    target_module_key: targetModuleKey,
    source_generation_id: sourceGenId,
    patient_uid: patientUidValue,
    trust_band: trustBand,
    severity,
    citation_coverage_pct: coverage.coverage_pct,
    unsupported_claim_count: unsupported.count,
    numeric_coherence_pct: numeric.coherence_pct,
    phi_leakage_count: phi.count,
    bias_marker_count: bias.count,
    evidence_map: coverage.evidence_map,
    unsupported_claims: unsupported.claims,
    numeric_mismatches: numeric.mismatches,
    phi_leaks: phi.leaks,
    bias_markers: bias.markers,
    signals: classification.signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // ---- Optional AI narrative (decorative only) ----
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        target_module_key: targetModuleKey,
        source_generation_id: sourceGenId,
        rule_based_evaluation: {
          trust_band: trustBand,
          severity,
          signals: classification.signals,
          citation_coverage_pct: coverage.coverage_pct,
          unsupported_claim_count: unsupported.count,
          numeric_coherence_pct: numeric.coherence_pct,
          phi_leakage_count: phi.count,
          bias_marker_count: bias.count,
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
      };
    }
  } catch (err) {
    logger.debug('AI explainability narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  // ---- Merge with output defenses ----
  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        target_module_key: targetModuleKey,
        source_generation_id: sourceGenId,
        context_text_length: String(contextText || '').length,
      },
      citations: draft.source_citations,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  // ---- Persist generation ----
  const generation = await insertGeneration({
    tenantId,
    patientUid: patientUidValue,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      module_key: targetModuleKey,
      source_generation_id: sourceGenId,
      trust_band: trustBand,
      severity,
      citation_coverage_pct: coverage.coverage_pct,
      unsupported_claim_count: unsupported.count,
      phi_leakage_count: phi.count,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      target_module_key: targetModuleKey,
      source_generation_id: sourceGenId,
      trust_band: trustBand,
      severity,
      signal_codes: asArray(classification.signals).map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // ---- Persist explainability report row ----
  let reportRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_explainability_reports
         (tenant_id, source_generation_id, module_key, patient_uid, generation_id,
          citation_coverage_pct, unsupported_claim_count, numeric_coherence_pct,
          phi_leakage_count, bias_marker_count, trust_band, severity,
          evidence_map, unsupported_claims, numeric_mismatches, phi_leaks,
          bias_markers, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5,
               $6, $7, $8,
               $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
               $17::jsonb, $18::jsonb, $19, $20::jsonb,
               $21::jsonb, $22::jsonb, 'pending', $23::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, source_generation_id, module_key, patient_uid,
                 generation_id, citation_coverage_pct, unsupported_claim_count,
                 numeric_coherence_pct, phi_leakage_count, bias_marker_count,
                 trust_band, severity, evidence_map, unsupported_claims,
                 numeric_mismatches, phi_leaks, bias_markers, signals, summary,
                 recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      sourceGenId,
      targetModuleKey,
      patientUidValue,
      generation?.id || null,
      coverage.coverage_pct,
      unsupported.count,
      numeric.coherence_pct,
      phi.count,
      bias.count,
      trustBand,
      severity,
      JSON.stringify(coverage.evidence_map),
      JSON.stringify(unsupported.claims),
      JSON.stringify(numeric.mismatches),
      JSON.stringify(phi.leaks),
      JSON.stringify(bias.markers),
      JSON.stringify(classification.signals),
      summary,
      JSON.stringify(recommendedActions),
      JSON.stringify(draft.source_citations),
      JSON.stringify(combinedFlags),
      JSON.stringify({
        target_module_key: targetModuleKey,
        source_generation_id: sourceGenId,
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    reportRow = normalizeReportRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        report_id: null,
        generation_id: generation?.id || null,
        draft,
        source_citations: draft.source_citations,
        safety_flags: combinedFlags,
        trust_band: trustBand,
        severity,
        citation_coverage_pct: coverage.coverage_pct,
        unsupported_claim_count: unsupported.count,
        numeric_coherence_pct: numeric.coherence_pct,
        phi_leakage_count: phi.count,
        bias_marker_count: bias.count,
        evidence_map: coverage.evidence_map,
        module_key: MODULE_KEY,
        prompt_version: prompt?.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_explainability_reports_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      };
    }
    throw err;
  }

  // ---- Review placeholder ----
  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid: patientUidValue,
    module,
  });

  // ---- Event publish ----
  try {
    await publishEvent({
      eventType: 'clinical_ai.explainability_evaluated',
      aggregateType: 'clinical_ai_explainability_report',
      aggregateId: reportRow?.id || generation?.id || null,
      patientUid: patientUidValue,
      payload: {
        tenant_id: tenantId,
        report_id: reportRow?.id || null,
        generation_id: generation?.id || null,
        source_generation_id: sourceGenId,
        target_module_key: targetModuleKey,
        trust_band: trustBand,
        severity,
        citation_coverage_pct: coverage.coverage_pct,
        unsupported_claim_count: unsupported.count,
        phi_leakage_count: phi.count,
      },
    });
  } catch (err) {
    logger.warn('AI explainability event publish failed', { error: err?.message });
  }

  return {
    report_id: reportRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    report: reportRow,
    trust_band: trustBand,
    severity,
    citation_coverage_pct: coverage.coverage_pct,
    unsupported_claim_count: unsupported.count,
    numeric_coherence_pct: numeric.coherence_pct,
    phi_leakage_count: phi.count,
    bias_marker_count: bias.count,
    evidence_map: coverage.evidence_map,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || reportRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

/**
 * List explainability reports for the tenant with optional filters.
 * Sorted so 'reject' bands surface first, then 'review', then 'trusted',
 * within severity-descending, within created_at DESC.
 */
export async function listExplainabilityReports({
  tenantId = null,
  moduleKey = null,
  trustBand = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedModule = moduleKey ? cleanText(moduleKey) : null;
  const normalizedBand = trustBand && TRUST_BANDS.has(cleanText(trustBand).toLowerCase())
    ? cleanText(trustBand).toLowerCase()
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
      `SELECT r.id, r.tenant_id, r.source_generation_id, r.module_key, r.patient_uid,
              r.generation_id, r.citation_coverage_pct, r.unsupported_claim_count,
              r.numeric_coherence_pct, r.phi_leakage_count, r.bias_marker_count,
              r.trust_band, r.severity, r.evidence_map, r.unsupported_claims,
              r.numeric_mismatches, r.phi_leaks, r.bias_markers, r.signals,
              r.summary, r.recommended_actions, r.source_citations, r.safety_flags,
              r.reviewer_decision, r.reviewed_by, r.reviewed_at, r.reviewer_note,
              r.metadata, r.created_at, r.updated_at
       FROM clinical_ai_explainability_reports r
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.module_key = $2)
         AND ($3::text IS NULL OR r.trust_band = $3)
         AND ($4::text IS NULL OR r.severity = $4)
         AND ($5::text IS NULL OR r.reviewer_decision = $5)
       ORDER BY
         CASE r.trust_band
           WHEN 'reject' THEN 0
           WHEN 'review' THEN 1
           WHEN 'trusted' THEN 2
           ELSE 3
         END,
         CASE r.severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         r.created_at DESC
       LIMIT $6`,
      tid,
      normalizedModule,
      normalizedBand,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeReportRow);
    return { reports: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reports: [], count: 0 };
    throw err;
  }
}

/**
 * Record an AI governance reviewer decision on an explainability report.
 */
export async function decideExplainabilityReport({
  tenantId = null,
  reportId,
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
    `UPDATE clinical_ai_explainability_reports
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, source_generation_id, module_key, patient_uid,
               generation_id, citation_coverage_pct, unsupported_claim_count,
               numeric_coherence_pct, phi_leakage_count, bias_marker_count,
               trust_band, severity, evidence_map, unsupported_claims,
               numeric_mismatches, phi_leaks, bias_markers, signals, summary,
               recommended_actions, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(reportId, 'report_id'),
    normalized,
    reviewerUid || null,
    note ? cleanText(note) : null,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Explainability report not found');
  return normalizeReportRow(rows[0]);
}

export default {
  TRUST_BANDS,
  TRUST_PRIORITY,
  SEVERITIES,
  SEVERITY_PRIORITY,
  DECISIONS,
  FINAL_DECISIONS,
  splitSentences,
  extractNumbers,
  computeCitationCoverage,
  detectUnsupportedClaims,
  checkNumericCoherence,
  detectPhiLeakage,
  detectBiasMarkers,
  classifyTrustBand,
  escalateTrustBand,
  escalateSeverity,
  buildExplainabilityActions,
  summarizeExplainability,
  evaluateExplainability,
  listExplainabilityReports,
  decideExplainabilityReport,
};
