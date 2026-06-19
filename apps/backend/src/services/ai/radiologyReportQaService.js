/**
 * Radiology Report QA / Discrepancy Assistant.
 *
 * Reviews a draft (or signed) radiology report against the study metadata and
 * request indication. Produces rules-authoritative discrepancy flags for the
 * radiologist: laterality mismatch (request vs report), missing impression
 * section, missing critical-finding communication note, indication not
 * addressed in report, missing comparison-to-prior when priors exist,
 * vague/incomplete measurement reporting, findings-vs-impression
 * inconsistency, and missing follow-up recommendation when findings warrant
 * one. Review-only -- the service never modifies, signs, or releases a
 * report, and always requires radiologist/reviewer signoff.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'radiology_report_qa';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support rule-authoritative radiology report QA. Rules are authoritative. Return JSON only and never modify, sign, or release a report.',
  user_prompt_template: 'Summarize the radiology report QA discrepancy findings. Do not invent findings; defer to the supplied rule-based evaluation.',
};

const DISCREPANCY_SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);
const REPORT_STATUSES = new Set(['draft', 'preliminary', 'final', 'amended', 'unknown']);

// Priority order: higher index = higher priority (escalate towards it).
const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];

const REVIEW_DISCLAIMER = 'Radiologist review required before finalization — decision support only.';

const INDICATION_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'evaluate', 'assess',
  'please', 'patient', 'history', 'study', 'evaluation', 'assessment', 'due', 'regarding',
  'about', 'rule', 'ruleout', 'clinical', 'any', 'per', 'suspected', 'possible',
]);

const IMPRESSION_ABNORMAL_TERMS = [
  'pneumonia', 'mass', 'fracture', 'hemorrhage', 'pneumothorax',
  'nodule', 'lesion', 'consolidation', 'edema',
];

const FOLLOWUP_WARRANT_TERMS = ['nodule', 'mass', 'lesion', 'indeterminate'];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
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

/**
 * normalizeLaterality(text) -> 'left' | 'right' | 'bilateral' | 'unspecified' | null
 *
 * Detects laterality from free text. Returns null when ambiguous (both 'left'
 * and 'right' appear without a bilateral cue).
 */
export function normalizeLaterality(text) {
  const raw = String(text || '');
  if (!cleanText(raw)) return null;
  const lower = ` ${raw.toLowerCase()} `;

  const hasBilateral = /\b(bilateral|both sides|both side)\b/.test(lower);
  if (hasBilateral) return 'bilateral';

  // Standalone "L " and "R " as full-word tokens, preserving original case.
  const paddedOriginal = ` ${raw} `;
  const hasStandaloneLCase = /\bL\b/.test(paddedOriginal);
  const hasStandaloneRCase = /\bR\b/.test(paddedOriginal);

  const hasLeft = /\b(left|lt)\b/.test(lower) || hasStandaloneLCase;
  const hasRight = /\b(right|rt)\b/.test(lower) || hasStandaloneRCase;

  if (hasLeft && hasRight) return null;
  if (hasLeft) return 'left';
  if (hasRight) return 'right';
  return 'unspecified';
}

/**
 * detectLateralityMismatch({ indication, reportText })
 *   -> { mismatch, indication_side, report_side, detail }
 *
 * Mismatch when both sides are non-null, neither is 'unspecified'/'bilateral',
 * and they differ.
 */
export function detectLateralityMismatch({ indication, reportText } = {}) {
  const indicationSide = normalizeLaterality(indication);
  const reportSide = normalizeLaterality(reportText);
  const mismatch = Boolean(
    indicationSide && reportSide
    && indicationSide !== 'unspecified' && reportSide !== 'unspecified'
    && indicationSide !== 'bilateral' && reportSide !== 'bilateral'
    && indicationSide !== reportSide
  );
  return {
    mismatch,
    indication_side: indicationSide,
    report_side: reportSide,
    detail: mismatch
      ? `Request indication specifies ${indicationSide}; report describes ${reportSide}.`
      : null,
  };
}

/**
 * hasImpressionSection(reportText) -> boolean
 *
 * Matches /\bimpression\s*[:\-]/i OR a line literally "IMPRESSION".
 */
export function hasImpressionSection(reportText) {
  const text = String(reportText || '');
  if (!text) return false;
  if (/\bimpression\s*[:-]/i.test(text)) return true;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*impression\s*$/i.test(line)) return true;
  }
  return false;
}

/**
 * hasCriticalCommunicationNote(reportText) -> boolean
 *
 * Matches critical-finding communication language with a clinician reference.
 */
export function hasCriticalCommunicationNote(reportText) {
  const text = String(reportText || '');
  if (!text) return false;
  const lower = text.toLowerCase();
  const phrases = [
    'communicated to',
    'called to',
    'notified',
    'paged',
    'discussed with',
    'critical result',
  ];
  const hasPhrase = phrases.some((phrase) => lower.includes(phrase));
  if (!hasPhrase) return false;
  // Require a clinician/provider reference nearby to avoid false positives on
  // generic "notified the patient" language. Accept Dr/MD/clinician/physician
  // or an explicit phone/pager context.
  const clinicianRefs = /\b(dr\.?|doctor|md|clinician|physician|provider|radiologist|surgeon|referring|pager|phone)\b/i;
  return clinicianRefs.test(text);
}

/**
 * extractFollowUpRecommendations(reportText) -> string[]
 *
 * Regex-based extraction of follow-up recommendation phrases.
 */
export function extractFollowUpRecommendations(reportText) {
  const text = String(reportText || '');
  if (!text) return [];
  const patterns = [
    /recommend(?:ed|s|ing)?\s+follow[- ]?up[^.\n]*/gi,
    /follow[- ]?up[^.\n]*/gi,
    /recommend(?:ed|s|ing)?\s+further[^.\n]*/gi,
    /suggest(?:ed|s|ing)?\s+(?:mri|ct|ultrasound|us|mammogram|biopsy)[^.\n]*/gi,
    /consider\s+(?:biopsy|mri|ct|ultrasound|us|mammogram|follow[- ]?up)[^.\n]*/gi,
    /recommend(?:ed|s|ing)?\s+(?:mri|ct|ultrasound|us|mammogram|biopsy)[^.\n]*/gi,
  ];
  const seen = new Set();
  const out = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    for (const match of matches) {
      const cleaned = cleanText(match);
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

/**
 * detectIndicationAddressed({ indication, reportText })
 *   -> { addressed: boolean, matched_terms: string[] }
 *
 * Meaningful words are len >= 4 and not stopwords. Addressed if >= 50% of
 * meaningful terms appear in the report text, or fewer than 2 meaningful
 * terms (not enough to score).
 */
export function detectIndicationAddressed({ indication, reportText } = {}) {
  const indicationText = cleanText(indication);
  const reportLower = normalizedText(reportText);
  if (!indicationText || !reportLower) {
    return { addressed: true, matched_terms: [] };
  }
  const tokens = indicationText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const meaningful = [];
  const seen = new Set();
  for (const token of tokens) {
    if (token.length < 4) continue;
    if (INDICATION_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    meaningful.push(token);
  }
  if (meaningful.length < 2) {
    return { addressed: true, matched_terms: meaningful.filter((term) => reportLower.includes(term)) };
  }
  const matched = meaningful.filter((term) => reportLower.includes(term));
  const ratio = matched.length / meaningful.length;
  return {
    addressed: ratio >= 0.5,
    matched_terms: matched,
  };
}

/**
 * detectMeasurementCompleteness(reportText)
 *   -> { hasMeasurements, vague, vagueTerms }
 *
 * Looks for numeric mm/cm measurements. Flags vague if size descriptors like
 * 'small', 'moderate', 'large', 'enlarged' appear without a numeric nearby.
 */
export function detectMeasurementCompleteness(reportText) {
  const text = String(reportText || '');
  if (!text) return { hasMeasurements: false, vague: false, vagueTerms: [] };
  const hasMeasurements = /\d+(?:\.\d+)?\s*(?:mm|cm)\b/i.test(text);
  const lower = text.toLowerCase();
  const vagueTerms = [];

  // Check "enlarged" without a nearby number.
  const enlargedMatches = [...lower.matchAll(/\benlarged\b/g)];
  for (const match of enlargedMatches) {
    const start = Math.max(0, match.index - 40);
    const end = Math.min(lower.length, match.index + 40);
    const window = lower.slice(start, end);
    if (!/\d+(?:\.\d+)?\s*(?:mm|cm)\b/.test(window)) {
      vagueTerms.push('enlarged');
      break;
    }
  }

  // Check primary size descriptors (small/moderate/large) without numeric nearby.
  const sizeDescriptors = ['small', 'moderate', 'large'];
  for (const descriptor of sizeDescriptors) {
    const pattern = new RegExp(`\\b${descriptor}\\b`, 'g');
    const matches = [...lower.matchAll(pattern)];
    for (const match of matches) {
      const start = Math.max(0, match.index - 40);
      const end = Math.min(lower.length, match.index + 40);
      const window = lower.slice(start, end);
      if (!/\d+(?:\.\d+)?\s*(?:mm|cm)\b/.test(window)) {
        if (!vagueTerms.includes(descriptor)) vagueTerms.push(descriptor);
        break;
      }
    }
  }

  // "approximately without value" check.
  if (/\bapproximately\b(?![^.\n]*\d+(?:\.\d+)?\s*(?:mm|cm)\b)/i.test(text)) {
    if (!vagueTerms.includes('approximately')) vagueTerms.push('approximately');
  }

  return {
    hasMeasurements,
    vague: vagueTerms.length > 0,
    vagueTerms,
  };
}

function extractSectionBody(reportText, sectionName) {
  const text = String(reportText || '');
  if (!text) return null;
  const pattern = new RegExp(`(^|\\n)\\s*${sectionName}\\s*[:\\-]?\\s*([\\s\\S]*?)(?=(\\n\\s*(findings|impression|technique|comparison|history|clinical|recommendation|conclusion)\\s*[:\\-])|$)`, 'i');
  const match = text.match(pattern);
  if (!match) return null;
  return cleanText(match[2] || '');
}

/**
 * detectFindingsImpressionConsistency({ reportText })
 *   -> { consistent, flaggedTerms }
 *
 * If both Findings and Impression sections are present, flag key abnormal
 * terms that appear in one but not the other.
 */
export function detectFindingsImpressionConsistency({ reportText } = {}) {
  const findings = extractSectionBody(reportText, 'findings');
  const impression = extractSectionBody(reportText, 'impression');
  if (!findings || !impression) {
    return { consistent: true, flaggedTerms: [] };
  }
  const findingsLower = findings.toLowerCase();
  const impressionLower = impression.toLowerCase();
  const flaggedTerms = [];
  for (const term of IMPRESSION_ABNORMAL_TERMS) {
    const inFindings = findingsLower.includes(term);
    const inImpression = impressionLower.includes(term);
    if (inFindings !== inImpression) {
      flaggedTerms.push(term);
    }
  }
  return {
    consistent: flaggedTerms.length === 0,
    flaggedTerms,
  };
}

/**
 * classifyReportQaDiscrepancies({
 *   indication, reportText, priorsAvailable, isCritical, reportStatus
 * }) -> Array<{ code, severity, message, detail? }>
 */
export function classifyReportQaDiscrepancies({
  indication = null,
  reportText = '',
  priorsAvailable = false,
  isCritical = false,
  reportStatus = 'draft',
} = {}) {
  const discrepancies = [];
  const text = String(reportText || '');
  const normStatus = REPORT_STATUSES.has(normalizedText(reportStatus)) ? normalizedText(reportStatus) : 'unknown';

  const lateralityResult = detectLateralityMismatch({ indication, reportText: text });
  if (lateralityResult.mismatch) {
    discrepancies.push({
      code: 'LATERALITY_MISMATCH',
      severity: 'critical',
      message: 'Laterality mismatch between request indication and report.',
      detail: lateralityResult.detail,
    });
  }

  if (!hasImpressionSection(text) && ['preliminary', 'final', 'amended'].includes(normStatus)) {
    discrepancies.push({
      code: 'MISSING_IMPRESSION',
      severity: 'high',
      message: 'Report has no Impression section.',
    });
  }

  if (isCritical && !hasCriticalCommunicationNote(text)) {
    discrepancies.push({
      code: 'MISSING_CRITICAL_COMMUNICATION',
      severity: 'critical',
      message: 'Critical finding is not accompanied by a documented communication note.',
    });
  }

  const indicationResult = detectIndicationAddressed({ indication, reportText: text });
  if (!indicationResult.addressed) {
    discrepancies.push({
      code: 'INDICATION_NOT_ADDRESSED',
      severity: 'moderate',
      message: 'Report does not appear to address the request indication.',
      detail: indicationResult.matched_terms.length
        ? `Matched indication terms: ${indicationResult.matched_terms.join(', ')}.`
        : 'No indication terms matched in report text.',
    });
  }

  if (priorsAvailable) {
    const lower = text.toLowerCase();
    const hasComparison = lower.includes('compared to')
      || lower.includes('comparison')
      || lower.includes('prior study');
    if (!hasComparison) {
      discrepancies.push({
        code: 'MISSING_COMPARISON_TO_PRIOR',
        severity: 'moderate',
        message: 'Prior studies are available, but the report lacks a comparison.',
      });
    }
  }

  const measurementResult = detectMeasurementCompleteness(text);
  if (measurementResult.vague) {
    discrepancies.push({
      code: 'VAGUE_MEASUREMENTS',
      severity: 'low',
      message: 'Report contains vague or incomplete size descriptors.',
      detail: `Vague terms: ${measurementResult.vagueTerms.join(', ')}.`,
    });
  }

  const consistencyResult = detectFindingsImpressionConsistency({ reportText: text });
  if (!consistencyResult.consistent) {
    discrepancies.push({
      code: 'FINDINGS_IMPRESSION_INCONSISTENT',
      severity: 'high',
      message: 'Findings section and Impression section disagree on key abnormal terms.',
      detail: `Inconsistent terms: ${consistencyResult.flaggedTerms.join(', ')}.`,
    });
  }

  const followUps = extractFollowUpRecommendations(text);
  const lower = text.toLowerCase();
  const findingsWarrant = FOLLOWUP_WARRANT_TERMS.some((term) => lower.includes(term));
  if (!followUps.length && findingsWarrant) {
    discrepancies.push({
      code: 'MISSING_FOLLOW_UP',
      severity: 'moderate',
      message: 'Findings warrant a follow-up recommendation, but none is documented.',
    });
  }

  return discrepancies;
}

/**
 * computeOverallSeverity(discrepancies) -> string
 *
 * Returns the highest severity across discrepancies using SEVERITY_PRIORITY.
 * Returns 'low' when no discrepancies.
 */
export function computeOverallSeverity(discrepancies) {
  const list = asArray(discrepancies);
  if (!list.length) return 'low';
  let best = 'low';
  let bestIdx = SEVERITY_PRIORITY.indexOf('low');
  for (const item of list) {
    const sev = DISCREPANCY_SEVERITIES.has(item?.severity) ? item.severity : 'unknown';
    const idx = SEVERITY_PRIORITY.indexOf(sev);
    if (idx > bestIdx) {
      best = sev;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * buildReportQaActions(discrepancies) -> string[]
 *
 * Always appends the REVIEW_DISCLAIMER.
 */
export function buildReportQaActions(discrepancies) {
  const list = asArray(discrepancies);
  const actions = [];
  for (const item of list) {
    switch (item?.code) {
      case 'LATERALITY_MISMATCH':
        actions.push('Resolve laterality mismatch between request and report before signoff.');
        break;
      case 'MISSING_IMPRESSION':
        actions.push('Add an Impression section summarizing the findings.');
        break;
      case 'MISSING_CRITICAL_COMMUNICATION':
        actions.push('Document the critical-finding communication (who was notified, when, and by whom).');
        break;
      case 'INDICATION_NOT_ADDRESSED':
        actions.push('Address the request indication explicitly in the report.');
        break;
      case 'MISSING_COMPARISON_TO_PRIOR':
        actions.push('Add a comparison to the available prior studies.');
        break;
      case 'VAGUE_MEASUREMENTS':
        actions.push('Replace vague size descriptors with concrete numeric measurements (mm/cm).');
        break;
      case 'FINDINGS_IMPRESSION_INCONSISTENT':
        actions.push('Reconcile Findings and Impression — key abnormal terms should be consistent between sections.');
        break;
      case 'MISSING_FOLLOW_UP':
        actions.push('Add a follow-up recommendation appropriate to the findings.');
        break;
      default:
        break;
    }
  }
  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

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
    return rows[0] || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

function buildSafetyFlags({ discrepancies, citations }) {
  const flags = [];
  for (const d of asArray(discrepancies)) {
    switch (d?.severity) {
      case 'critical':
        flags.push({
          severity: 'critical',
          code: `RADIOLOGY_${d.code}`,
          message: d.message,
        });
        break;
      case 'high':
        flags.push({
          severity: 'high',
          code: `RADIOLOGY_${d.code}`,
          message: d.message,
        });
        break;
      case 'moderate':
        flags.push({
          severity: 'medium',
          code: `RADIOLOGY_${d.code}`,
          message: d.message,
        });
        break;
      case 'low':
        flags.push({
          severity: 'low',
          code: `RADIOLOGY_${d.code}`,
          message: d.message,
        });
        break;
      default:
        break;
    }
  }
  if (!citations || !citations.length) {
    flags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Radiology report QA output has no source citations.',
    });
  }
  return flags;
}

function buildNarrativePrompt({ prompt, draft }) {
  return `${prompt.user_prompt_template}\n\n${JSON.stringify({
    rules_authoritative: true,
    decision_support_only: true,
    study_id: draft.study_id,
    accession_number: draft.accession_number,
    modality: draft.modality,
    body_part: draft.body_part,
    patient_uid: draft.patient_uid,
    report_status: draft.report_status,
    overall_severity: draft.overall_severity,
    discrepancy_count: draft.discrepancy_count,
    discrepancies: draft.discrepancies,
    rule_based_summary: draft.summary,
    rule_based_actions: draft.recommended_actions,
  })}`;
}

function normalizeAiDraft(parsed, fallbackDraft) {
  if (!parsed || typeof parsed !== 'object') return fallbackDraft;
  return {
    ...fallbackDraft,
    // Narrative is decorative; never let AI override discrepancies or severity.
    summary: cleanText(parsed.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed.source_citations),
    ]),
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
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $3, $4, $5, $6, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::uuid, $14, $15, $16,
               $17, $18, $19, $20, $21::jsonb, NOW(), NOW())
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
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      usage.latency_ms || aiResult?.latencyMs || null,
      usage.provider_request_id || aiResult?.requestId || null,
      usage.finish_reason || aiResult?.finishReason || null,
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Radiology Report QA: generation persist failed', { error: err.message });
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
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'RADIOLOGIST', 'ADMIN'],
        source: 'radiology_report_qa',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Radiology Report QA: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

export async function evaluateRadiologyReport({
  req = null,
  patientUid = null,
  studyId = null,
  accessionNumber = null,
  modality = null,
  bodyPart = null,
  indication = null,
  reportText,
  reportStatus = 'draft',
  priorsAvailable = false,
  isCritical = false,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const cleanedReport = cleanText(reportText);
  if (!cleanedReport) {
    throw AppError.badRequest('report_text is required');
  }
  const normalizedStatus = REPORT_STATUSES.has(normalizedText(reportStatus))
    ? normalizedText(reportStatus)
    : 'unknown';

  const discrepancies = classifyReportQaDiscrepancies({
    indication,
    reportText: cleanedReport,
    priorsAvailable: Boolean(priorsAvailable),
    isCritical: Boolean(isCritical),
    reportStatus: normalizedStatus,
  });
  const overallSeverity = computeOverallSeverity(discrepancies);
  const actions = buildReportQaActions(discrepancies);

  const citationsRaw = [
    {
      source_type: 'radiology_report',
      source_id: studyId ? String(studyId) : (accessionNumber ? String(accessionNumber) : 'report'),
      label: `Radiology report${modality ? ` (${modality})` : ''}${bodyPart ? ` — ${bodyPart}` : ''}`,
      timestamp: null,
    },
  ];
  if (indication) {
    citationsRaw.push({
      source_type: 'request_indication',
      source_id: studyId ? String(studyId) : 'indication',
      label: 'Request indication',
      timestamp: null,
    });
  }
  if (studyId) {
    citationsRaw.push({
      source_type: 'radiology_study',
      source_id: String(studyId),
      label: accessionNumber ? `Study ${studyId} (accession ${accessionNumber})` : `Study ${studyId}`,
      timestamp: null,
    });
  }
  if (patientUid) {
    citationsRaw.push({
      source_type: 'patient',
      source_id: String(patientUid),
      label: 'Patient record',
      timestamp: null,
    });
  }
  citationsRaw.push({
    source_type: 'radiology_report_qa_rules',
    source_id: MODULE_KEY,
    label: 'Radiology Report QA rule reference',
    timestamp: null,
  });
  const citations = uniqueCitations(citationsRaw);

  const baseSafetyFlags = buildSafetyFlags({ discrepancies, citations });

  const summary = discrepancies.length
    ? `${discrepancies.length} discrepancy flag(s) detected — overall severity ${overallSeverity}.`
    : 'No discrepancies detected by rule-based evaluation.';

  const safeStudyId = studyId ? cleanText(String(studyId)).slice(0, 200) : null;
  const safeAccession = accessionNumber ? cleanText(String(accessionNumber)).slice(0, 100) : null;
  const safeModality = modality ? cleanText(String(modality)).slice(0, 40) : null;
  const safeBodyPart = bodyPart ? cleanText(String(bodyPart)).slice(0, 100) : null;

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: patientUid || null,
    study_id: safeStudyId,
    accession_number: safeAccession,
    modality: safeModality,
    body_part: safeBodyPart,
    report_status: normalizedStatus,
    overall_severity: overallSeverity,
    discrepancy_count: discrepancies.length,
    discrepancies,
    summary,
    recommended_actions: actions,
    source_citations: citations,
    safety_flags: baseSafetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildNarrativePrompt({ prompt, draft: fallbackDraft }),
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Radiology Report QA: AI narrative failed (non-fatal)', { error: err.message });
  }
  const parsed = safeJsonParse(aiResult?.text, {});
  const draft = normalizeAiDraft(parsed, fallbackDraft);

  const combinedFlags = [
    ...baseSafetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        patient: { uid: patientUid || null },
        study: {
          study_id: safeStudyId,
          accession_number: safeAccession,
          modality: safeModality,
          body_part: safeBodyPart,
        },
        indication: indication ? cleanText(indication) : null,
        report_status: normalizedStatus,
      },
      citations,
    }),
  ];
  draft.safety_flags = combinedFlags;

  const generation = await insertGeneration({
    tenantId,
    patientUid: patientUid || null,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: patientUid || null,
      study_id: safeStudyId,
      accession_number: safeAccession,
      modality: safeModality,
      body_part: safeBodyPart,
      report_status: normalizedStatus,
      indication_norm: normalizedText(indication),
      report_norm: normalizedText(cleanedReport),
      priors_available: Boolean(priorsAvailable),
      is_critical: Boolean(isCritical),
    }),
    draft,
    citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      study_id: safeStudyId,
      accession_number: safeAccession,
      modality: safeModality,
      body_part: safeBodyPart,
      report_status: normalizedStatus,
      tenant_region: req?.tenant?.region || null,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  let reviewRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_radiology_report_reviews
         (tenant_id, patient_uid, study_id, accession_number, modality, body_part,
          generation_id, report_status, overall_severity, discrepancy_count,
          discrepancies, summary, recommended_actions, source_citations, safety_flags,
          reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb,
               'pending', $16::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, study_id, accession_number, modality,
                 body_part, generation_id, report_status, overall_severity,
                 discrepancy_count, discrepancies, summary, recommended_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      patientUid || null,
      safeStudyId,
      safeAccession,
      safeModality,
      safeBodyPart,
      generation?.id || null,
      normalizedStatus,
      DISCREPANCY_SEVERITIES.has(overallSeverity) ? overallSeverity : 'unknown',
      discrepancies.length,
      JSON.stringify(discrepancies),
      draft.summary,
      JSON.stringify(draft.recommended_actions),
      JSON.stringify(citations),
      JSON.stringify(combinedFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        priors_available: Boolean(priorsAvailable),
        is_critical: Boolean(isCritical),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    reviewRow = rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      review_id: null,
      generation_id: generation?.id || null,
      clinical_review_id: null,
      draft,
      review: null,
      source_citations: citations,
      safety_flags: combinedFlags,
      discrepancies,
      overall_severity: overallSeverity,
      discrepancy_count: discrepancies.length,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_radiology_report_reviews_unavailable',
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

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid: patientUid || null,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.radiology_report_qa_evaluated',
    aggregateType: 'clinical_ai_radiology_report_review',
    aggregateId: reviewRow?.id || generation?.id || null,
    patientUid: patientUid || null,
    payload: {
      tenant_id: tenantId,
      review_id: reviewRow?.id || null,
      generation_id: generation?.id || null,
      study_id: safeStudyId,
      accession_number: safeAccession,
      modality: safeModality,
      body_part: safeBodyPart,
      report_status: normalizedStatus,
      overall_severity: overallSeverity,
      discrepancy_count: discrepancies.length,
      discrepancy_codes: discrepancies.map((d) => d.code),
    },
  });

  return {
    review_id: reviewRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    review: reviewRow,
    source_citations: citations,
    safety_flags: combinedFlags,
    discrepancies,
    overall_severity: overallSeverity,
    discrepancy_count: discrepancies.length,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || reviewRow?.reviewer_decision || 'pending',
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

export async function listRadiologyReportReviews({
  tenantId = null,
  patientUid = null,
  modality = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedModality = modality ? cleanText(modality) : null;
  const normalizedSeverity = severity && DISCREPANCY_SEVERITIES.has(normalizedText(severity))
    ? normalizedText(severity)
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(normalizedText(reviewerDecision))
    ? normalizedText(reviewerDecision)
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.patient_uid, u.name AS patient_name,
              a.study_id, a.accession_number, a.modality, a.body_part,
              a.generation_id, a.report_status, a.overall_severity,
              a.discrepancy_count, a.discrepancies, a.summary,
              a.recommended_actions, a.source_citations, a.safety_flags,
              a.reviewer_decision, a.reviewed_by, a.reviewed_at, a.reviewer_note,
              a.metadata, a.created_at, a.updated_at
       FROM clinical_ai_radiology_report_reviews a
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR a.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR a.modality = $3)
         AND ($4::text IS NULL OR a.overall_severity = $4)
         AND ($5::text IS NULL OR a.reviewer_decision = $5)
       ORDER BY
         CASE a.overall_severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $6`,
      tid,
      patientUid || null,
      normalizedModality,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    return { reviews: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { reviews: [], count: 0 };
    throw err;
  }
}

export async function decideRadiologyReportReview({
  tenantId = null,
  reviewId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = normalizedText(decision);
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_radiology_report_reviews
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, patient_uid, study_id, accession_number, modality, body_part,
               generation_id, report_status, overall_severity, discrepancy_count,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(reviewId, 'review_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Radiology report review not found');
  const row = rows[0];
  return {
    ...row,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    discrepancy_count: row.discrepancy_count !== null && row.discrepancy_count !== undefined
      ? toNumber(row.discrepancy_count, 0)
      : 0,
  };
}

export default {
  normalizeLaterality,
  detectLateralityMismatch,
  hasImpressionSection,
  hasCriticalCommunicationNote,
  extractFollowUpRecommendations,
  detectIndicationAddressed,
  detectMeasurementCompleteness,
  detectFindingsImpressionConsistency,
  classifyReportQaDiscrepancies,
  computeOverallSeverity,
  buildReportQaActions,
  evaluateRadiologyReport,
  listRadiologyReportReviews,
  decideRadiologyReportReview,
};
