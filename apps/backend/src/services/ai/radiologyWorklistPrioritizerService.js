/**
 * Radiology Worklist Prioritizer.
 *
 * Scores pending radiology studies across modality, patient location
 * (ED/ICU/ward/outpatient), suspected findings severity based on request
 * indication, fragility (age, critical vitals, oxygen support,
 * immunocompromise), wait time since order, ordering clinician context
 * (trauma call, code stroke, rapid response), and prior-imaging
 * availability. Produces a per-study priority tier (stat / urgent /
 * routine / deferrable), a ranked ordered list, and a short reasoning
 * narrative.
 *
 * Rules are authoritative. Review-only — the service never changes the
 * worklist automatically. The radiologist lead reviews and accepts or
 * overrides the suggested order.
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

const MODULE_KEY = 'radiology_worklist_prioritizer';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the radiologist lead in prioritizing pending radiology studies. Rules are authoritative. Return JSON only. The AI narrative is decorative only — never modifies or releases the worklist and never changes priority_tier or priority_score.',
  user_prompt_template:
    'Given the study context and the rule-based priority evaluation, return keys: summary (a short reasoning sentence), source_citations, safety_flags. Do not override priority_tier or priority_score; the worklist is never reordered automatically.',
};

export const PRIORITY_TIERS = ['stat', 'urgent', 'routine', 'deferrable', 'unknown'];

// Higher index = higher priority. Used for ranking + tier-priority compare.
export const TIER_PRIORITY = ['unknown', 'deferrable', 'routine', 'urgent', 'stat'];

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Radiologist review required — decision support only. The worklist is never reordered automatically.';

// ---------- Small helpers -----------------------------------------------

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

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
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

function normalizeModality(value) {
  const v = normalizedText(value).replace(/[\s-]+/g, '');
  if (!v) return null;
  // Normalize common radiology modality aliases.
  if (/^(cxr|xr|x-?ray|radiograph)$/i.test(v)) return 'XR';
  if (/^ct$/i.test(v)) return 'CT';
  if (/^(mr|mri)$/i.test(v)) return 'MR';
  if (/^(us|ultrasound|sonograph)/i.test(v)) return 'US';
  if (/^(pet|petct)/i.test(v)) return 'PET';
  if (/^mam/i.test(v)) return 'MG';
  if (/^nm/i.test(v)) return 'NM';
  return v.toUpperCase();
}

// ---------- Pure helpers (exported) -------------------------------------

/**
 * Classify a patient location string into a priority bonus.
 * ED → 40, ICU → 45, ward/inpatient → 15, outpatient/opd → 0,
 * home/remote → -5, unknown → 0.
 */
export function classifyPatientLocationScore(location) {
  const loc = normalizedText(location).replace(/[\s-]+/g, '_');
  if (!loc) return 0;
  if (loc === 'ed' || loc === 'emergency' || loc === 'er' || loc === 'emergency_department') return 40;
  if (loc === 'icu' || loc === 'intensive_care' || loc === 'critical_care') return 45;
  if (loc === 'ward' || loc === 'inpatient' || loc === 'ipd') return 15;
  if (loc === 'outpatient' || loc === 'opd' || loc === 'clinic') return 0;
  if (loc === 'home' || loc === 'remote' || loc === 'tele') return -5;
  return 0;
}

/**
 * Classify modality urgency from modality, body part, and indication.
 * Returns { score, markers: string[] }.
 */
export function classifyModalityUrgency({ modality = null, bodyPart = null, indication = null } = {}) {
  const modalityKey = normalizeModality(modality) || '';
  const body = normalizedText(bodyPart);
  const indicationText = normalizedText(indication);

  if (!indicationText) {
    return { score: 0, markers: [] };
  }

  // CT head + stroke / tPA / intracranial / bleed / head trauma
  if (modalityKey === 'CT' && (/head|brain|cranial|skull/.test(body) || /head|brain/.test(indicationText))) {
    if (/stroke|tpa|intracranial|bleed|head trauma/i.test(indicationText)) {
      return { score: 60, markers: ['STROKE_PROTOCOL'] };
    }
  }

  // CT chest + pulmonary embolism / PE / hemoptysis
  if (modalityKey === 'CT' && (/chest|thorax|pulmonary|lung/.test(body) || /chest|thorax|pulmonary|lung/.test(indicationText))) {
    if (/pulmonary embolism|\bpe\b|hemoptysis/i.test(indicationText)) {
      return { score: 45, markers: ['PE_SUSPICION'] };
    }
  }

  // CT abdomen + appendicitis / trauma / aortic / ischemia
  if (modalityKey === 'CT' && (/abdomen|abdo|pelvis/.test(body) || /abdomen|abdo|pelvis/.test(indicationText))) {
    if (/appendicitis|trauma|aortic|ischemia/i.test(indicationText)) {
      return { score: 40, markers: ['ACUTE_ABDOMEN'] };
    }
  }

  // XR/CXR + tube position / line placement / pneumothorax / tension
  if (modalityKey === 'XR') {
    if (/tube position|line placement|pneumothorax|tension/i.test(indicationText)) {
      return { score: 35, markers: ['LINE_TUBE_CHECK'] };
    }
  }

  // MR/MRI brain + stroke / cord compression / meningitis / abscess
  if (modalityKey === 'MR' && (/brain|head|cord|spine/.test(body) || /brain|head|cord|spine/.test(indicationText))) {
    if (/stroke|cord compression|meningitis|abscess/i.test(indicationText)) {
      return { score: 50, markers: ['NEURO_EMERGENCY'] };
    }
  }

  // US + testicular torsion / ectopic / ovarian torsion / DVT
  if (modalityKey === 'US') {
    if (/testicular torsion|ectopic|ovarian torsion|dvt/i.test(indicationText)) {
      return { score: 45, markers: ['US_EMERGENCY'] };
    }
  }

  return { score: 0, markers: [] };
}

/**
 * Scan the indication text for severity keywords.
 * Returns { score, matchedTerms, band }. Score is capped at 35.
 */
export function classifyIndicationSeverity(indication) {
  const text = normalizedText(indication);
  if (!text) {
    return { score: 0, matchedTerms: [], band: 'low' };
  }

  const criticalTerms = ['stroke', 'code', 'trauma activation', 'massive', 'unstable', 'collapse', 'arrest', 'hemorrhage', 'torsion'];
  const highTerms = ['severe', 'acute', 'new onset', 'worsening', 'perforation', 'sepsis', 'hypoxia'];
  const moderateTerms = ['pain', 'fever', 'persistent', 'chronic acute'];

  const matched = [];
  let score = 0;
  let band = 'low';

  for (const term of criticalTerms) {
    if (text.includes(term)) {
      matched.push(term);
      score += 35;
      band = 'critical';
    }
  }
  for (const term of highTerms) {
    if (text.includes(term)) {
      matched.push(term);
      score += 20;
      if (band !== 'critical') band = 'high';
    }
  }
  for (const term of moderateTerms) {
    if (text.includes(term)) {
      matched.push(term);
      score += 10;
      if (band !== 'critical' && band !== 'high') band = 'moderate';
    }
  }

  // Cap score at 35.
  if (score > 35) score = 35;

  return { score, matchedTerms: matched, band };
}

/**
 * Classify fragility signals. Accepts undefined inputs → score 0, factors [].
 * Returns { score, factors: string[] }.
 */
export function classifyFragility({
  ageYears = undefined,
  criticalVitalsFlag = undefined,
  oxygenSupport = undefined,
  immunocompromised = undefined,
} = {}) {
  const factors = [];
  let score = 0;

  const age = ageYears !== undefined && ageYears !== null ? toNumber(ageYears, null) : null;

  if (age !== null && Number.isFinite(age)) {
    if (age >= 80) {
      score += 10;
      factors.push('EXTREME_AGE');
    }
    if (age <= 1) {
      score += 15;
      factors.push('INFANT');
    } else if (age <= 5) {
      score += 10;
      factors.push('YOUNG_CHILD');
    }
  }

  if (criticalVitalsFlag === true) {
    score += 20;
    factors.push('CRITICAL_VITALS');
  }

  if (oxygenSupport === true) {
    score += 10;
    factors.push('OXYGEN_SUPPORT');
  }

  if (immunocompromised === true) {
    score += 10;
    factors.push('IMMUNOCOMPROMISED');
  }

  return { score, factors };
}

/**
 * Classify wait time in minutes. Returns { score, band }.
 * >= 240 → 25 breach, >= 120 → 15 warning, >= 60 → 5 watch,
 * < 60 → 0 ok, null/undefined → 0 unknown.
 */
export function classifyWaitTime(minutes) {
  if (minutes === null || minutes === undefined) {
    return { score: 0, band: 'unknown' };
  }
  const mins = toNumber(minutes, null);
  if (mins === null || !Number.isFinite(mins)) {
    return { score: 0, band: 'unknown' };
  }
  if (mins >= 240) return { score: 25, band: 'breach' };
  if (mins >= 120) return { score: 15, band: 'warning' };
  if (mins >= 60) return { score: 5, band: 'watch' };
  return { score: 0, band: 'ok' };
}

/**
 * Classify ordering-context tags. Unknown tags ignored.
 * Returns { score, matchedTags: string[] }.
 */
export function classifyOrderingContext({ contextTags = [] } = {}) {
  const tags = asArray(contextTags).map((t) => normalizedText(t).replace(/[\s-]+/g, '_')).filter(Boolean);
  const bonusByTag = {
    code_stroke: 25,
    trauma_call: 25,
    rapid_response: 20,
    code_blue: 30,
    pre_op_same_day: 10,
    routine: 0,
  };
  const matched = [];
  let score = 0;
  for (const tag of tags) {
    if (Object.prototype.hasOwnProperty.call(bonusByTag, tag)) {
      matched.push(tag);
      score += bonusByTag[tag];
    }
  }
  return { score, matchedTags: matched };
}

/**
 * Priors-available bonus. true → -5 with factor 'PRIORS_AVAILABLE',
 * else 0 with factor null.
 */
export function classifyPriorsBonus({ priorsAvailable = false } = {}) {
  if (priorsAvailable === true) {
    return { score: -5, factor: 'PRIORS_AVAILABLE' };
  }
  return { score: 0, factor: null };
}

/**
 * Combine all helpers into a priority score + tier + signals.
 *
 * Inputs shape:
 *   { modality, bodyPart, indication, location, waitMinutes,
 *     fragility: { ageYears, criticalVitalsFlag, oxygenSupport, immunocompromised },
 *     contextTags, priorsAvailable, isStatOverride }
 *
 * Tier thresholds: >= 120 → 'stat', >= 80 → 'urgent', >= 30 → 'routine',
 * else 'deferrable'.
 *
 * If isStatOverride is true, tier is forced to 'stat' and a STAT_OVERRIDE
 * signal is added.
 */
export function scorePriority(inputs = {}) {
  const {
    modality = null,
    bodyPart = null,
    indication = null,
    location = null,
    waitMinutes = null,
    fragility = {},
    contextTags = [],
    priorsAvailable = false,
    isStatOverride = false,
  } = inputs;

  const signals = [];

  // Location
  const locationScore = classifyPatientLocationScore(location);
  if (locationScore !== 0) {
    signals.push({
      code: 'PATIENT_LOCATION',
      score_delta: locationScore,
      detail: normalizedText(location) || 'unknown',
    });
  }

  // Modality urgency
  const modalityResult = classifyModalityUrgency({ modality, bodyPart, indication });
  if (modalityResult.score !== 0) {
    signals.push({
      code: 'MODALITY_URGENCY',
      score_delta: modalityResult.score,
      detail: modalityResult.markers.join(',') || null,
    });
    for (const marker of modalityResult.markers) {
      signals.push({ code: marker, score_delta: 0 });
    }
  }

  // Indication severity
  const indicationResult = classifyIndicationSeverity(indication);
  if (indicationResult.score !== 0) {
    signals.push({
      code: 'INDICATION_SEVERITY',
      score_delta: indicationResult.score,
      detail: `band=${indicationResult.band};terms=${indicationResult.matchedTerms.join(',')}`,
    });
  }

  // Fragility
  const fragilityResult = classifyFragility(fragility || {});
  if (fragilityResult.score !== 0) {
    signals.push({
      code: 'FRAGILITY',
      score_delta: fragilityResult.score,
      detail: fragilityResult.factors.join(','),
    });
    for (const factor of fragilityResult.factors) {
      signals.push({ code: factor, score_delta: 0 });
    }
  }

  // Wait time
  const waitResult = classifyWaitTime(waitMinutes);
  if (waitResult.score !== 0) {
    signals.push({
      code: 'WAIT_TIME',
      score_delta: waitResult.score,
      detail: `band=${waitResult.band}`,
    });
  }

  // Ordering context
  const contextResult = classifyOrderingContext({ contextTags });
  if (contextResult.score !== 0) {
    signals.push({
      code: 'ORDERING_CONTEXT',
      score_delta: contextResult.score,
      detail: contextResult.matchedTags.join(','),
    });
    for (const tag of contextResult.matchedTags) {
      signals.push({ code: `CONTEXT_${tag.toUpperCase()}`, score_delta: 0 });
    }
  }

  // Priors
  const priorsResult = classifyPriorsBonus({ priorsAvailable });
  if (priorsResult.score !== 0) {
    signals.push({
      code: priorsResult.factor || 'PRIORS',
      score_delta: priorsResult.score,
    });
  }

  // Sum + clamp.
  let rawScore = (
    locationScore
    + modalityResult.score
    + indicationResult.score
    + fragilityResult.score
    + waitResult.score
    + contextResult.score
    + priorsResult.score
  );
  if (rawScore < 0) rawScore = 0;
  if (rawScore > 200) rawScore = 200;
  const priority_score = roundTo(rawScore, 2);

  let priority_tier;
  if (priority_score >= 120) priority_tier = 'stat';
  else if (priority_score >= 80) priority_tier = 'urgent';
  else if (priority_score >= 30) priority_tier = 'routine';
  else priority_tier = 'deferrable';

  if (isStatOverride === true) {
    priority_tier = 'stat';
    signals.push({ code: 'STAT_OVERRIDE', score_delta: 0 });
  }

  return {
    priority_score,
    priority_tier,
    signals,
    band_breakdown: {
      location: { score: locationScore },
      modality: modalityResult,
      indication: indicationResult,
      fragility: fragilityResult,
      wait: waitResult,
      ordering_context: contextResult,
      priors: priorsResult,
    },
  };
}

/**
 * Build reviewer actions from the priority tier + signals.
 * Always appends the review disclaimer.
 */
export function buildPriorityActions({ priorityTier = 'routine', signals = [] } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (line) => {
    const clean = cleanText(line);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    actions.push(clean);
  };

  const tier = PRIORITY_TIERS.includes(priorityTier) ? priorityTier : 'routine';

  switch (tier) {
    case 'stat':
      push('Flag for immediate radiologist read; escalate to on-call attending now.');
      push('Pre-notify ordering clinician and bed manager of the expected read window.');
      break;
    case 'urgent':
      push('Bring study forward on the worklist; target urgent read within 60 minutes.');
      push('Confirm priors are staged and the reporting bay is available.');
      break;
    case 'routine':
      push('Route to routine queue; reassess if wait crosses the breach threshold.');
      break;
    case 'deferrable':
      push('Defer to standard outpatient reading window; no expedited action required.');
      break;
    default:
      push('Route to routine queue; reassess if wait crosses the breach threshold.');
      break;
  }

  const signalCodes = new Set(asArray(signals).map((s) => s && s.code).filter(Boolean));

  if (signalCodes.has('STAT_OVERRIDE')) {
    push('STAT override in effect — escalate immediately to the on-call radiologist for attention.');
  }
  if (signalCodes.has('STROKE_PROTOCOL')) {
    push('Suspected stroke protocol — coordinate with neurology / code-stroke team before read.');
  }
  if (signalCodes.has('PE_SUSPICION')) {
    push('Suspected pulmonary embolism — confirm protocol and contrast readiness.');
  }
  if (signalCodes.has('ACUTE_ABDOMEN')) {
    push('Acute abdominal indication — coordinate with the surgical / ED team on read timing.');
  }
  if (signalCodes.has('LINE_TUBE_CHECK')) {
    push('Tube / line placement check — report position findings directly to the ordering clinician.');
  }
  if (signalCodes.has('NEURO_EMERGENCY')) {
    push('Neuro-emergency MRI — verify MR safety and escalate for urgent neuroradiology read.');
  }
  if (signalCodes.has('US_EMERGENCY')) {
    push('Time-critical ultrasound indication — perform bedside scan or expedite as appropriate.');
  }
  if (signalCodes.has('CRITICAL_VITALS')) {
    push('Patient has critical vitals flag — coordinate with the bedside team on read urgency.');
  }
  if (signalCodes.has('WAIT_TIME')) {
    push('Wait-time signal triggered — audit the worklist backlog for breach risk.');
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * Rank a list of { study_id, score_result } by (tier priority desc,
 * score desc, stable study_id tiebreak).
 */
export function rankWorklist(studies) {
  const list = asArray(studies).map((item, index) => ({ ...item, _originalIndex: index }));
  list.sort((a, b) => {
    const ar = a && a.score_result ? a.score_result : {};
    const br = b && b.score_result ? b.score_result : {};
    const at = TIER_PRIORITY.indexOf(ar.priority_tier || 'unknown');
    const bt = TIER_PRIORITY.indexOf(br.priority_tier || 'unknown');
    if (at !== bt) return bt - at;
    const asc = toNumber(ar.priority_score, 0);
    const bsc = toNumber(br.priority_score, 0);
    if (asc !== bsc) return bsc - asc;
    const aid = String(a && a.study_id ? a.study_id : '');
    const bid = String(b && b.study_id ? b.study_id : '');
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return a._originalIndex - b._originalIndex;
  });
  return list.map((item) => {
    const { _originalIndex, ...rest } = item;
    void _originalIndex;
    return rest;
  });
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

async function insertGeneration({
  tenantId,
  patientUid = null,
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
  const hasCritical = asArray(safetyFlags).some((flag) => flag && flag.severity === 'critical');
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
      logger.warn('Radiology worklist: generation persist failed', { error: err.message });
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
        source: 'radiology_worklist_prioritizer',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Radiology worklist: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizePriorityRow(row) {
  if (!row) return row;
  return {
    ...row,
    priority_score: row.priority_score !== null && row.priority_score !== undefined
      ? toNumber(row.priority_score, 0)
      : 0,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

// ---------- Public API --------------------------------------------------

export async function evaluateWorklistStudy({
  req = null,
  patientUid = null,
  studyId = null,
  accessionNumber = null,
  modality = null,
  bodyPart = null,
  indication = null,
  location = null,
  waitMinutes = null,
  fragility = {},
  contextTags = [],
  priorsAvailable = false,
  isStatOverride = false,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const cleanedStudyId = studyId ? cleanText(studyId) : null;
  const cleanedAccession = accessionNumber ? cleanText(accessionNumber) : null;
  if (!cleanedStudyId && !cleanedAccession) {
    throw AppError.badRequest('At least one of study_id or accession_number is required');
  }

  const cleanedPatientUid = patientUid ? cleanText(patientUid) : null;
  const cleanedModality = modality ? cleanText(modality) : null;
  const cleanedBodyPart = bodyPart ? cleanText(bodyPart) : null;
  const cleanedIndication = indication ? cleanText(indication) : null;
  const cleanedLocation = location ? cleanText(location) : null;
  const safeWaitMinutes = waitMinutes !== null && waitMinutes !== undefined
    ? toNumber(waitMinutes, null)
    : null;
  const safeContextTags = asArray(contextTags);
  const safePriorsAvailable = Boolean(priorsAvailable);
  const safeIsStatOverride = Boolean(isStatOverride);
  const safeFragility = fragility && typeof fragility === 'object' ? fragility : {};

  // Rules-authoritative compute.
  const scoreResult = scorePriority({
    modality: cleanedModality,
    bodyPart: cleanedBodyPart,
    indication: cleanedIndication,
    location: cleanedLocation,
    waitMinutes: safeWaitMinutes,
    fragility: safeFragility,
    contextTags: safeContextTags,
    priorsAvailable: safePriorsAvailable,
    isStatOverride: safeIsStatOverride,
  });

  const recommendedActions = buildPriorityActions({
    priorityTier: scoreResult.priority_tier,
    signals: scoreResult.signals,
  });

  // Citations.
  const citations = [];
  if (cleanedIndication) {
    citations.push({
      source_type: 'radiology_request_indication',
      source_id: cleanedAccession || cleanedStudyId || 'unknown',
      label: `Radiology request indication: ${cleanedIndication}`,
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'radiology_study',
    source_id: cleanedStudyId || cleanedAccession || 'unknown',
    label: `Radiology study${cleanedModality ? ` (${cleanedModality}${cleanedBodyPart ? ` ${cleanedBodyPart}` : ''})` : ''}`,
    timestamp: null,
  });
  if (cleanedPatientUid) {
    citations.push({
      source_type: 'patient',
      source_id: String(cleanedPatientUid),
      label: 'Patient record',
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'radiology_worklist_rules',
    source_id: MODULE_KEY,
    label: 'Radiology worklist prioritization rule reference',
    timestamp: null,
  });
  const uniqueCits = uniqueCitations(citations);

  // Safety flags.
  const markerCodes = new Set(asArray(scoreResult.signals).map((s) => s && s.code).filter(Boolean));
  const urgencyMarkerSet = new Set(['STROKE_PROTOCOL', 'PE_SUSPICION', 'ACUTE_ABDOMEN', 'LINE_TUBE_CHECK', 'NEURO_EMERGENCY', 'US_EMERGENCY']);
  const hasUrgencyMarker = Array.from(markerCodes).some((code) => urgencyMarkerSet.has(code));
  const safetyFlags = [];
  if (scoreResult.priority_tier === 'stat' && !hasUrgencyMarker) {
    safetyFlags.push({
      severity: 'critical',
      code: 'STAT_NO_MARKERS',
      message: 'Study is scored as STAT but no modality urgency marker was detected; radiologist lead must confirm before acting.',
    });
  }
  if (uniqueCits.length === 0) {
    safetyFlags.push({
      severity: 'medium',
      code: 'RADIOLOGY_PRIORITY_NO_CITATIONS',
      message: 'Radiology priority evaluation has no source citations.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'RADIOLOGY_PRIORITY_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — worklist is never reordered automatically.',
  });

  // Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: cleanedPatientUid,
    study_id: cleanedStudyId,
    accession_number: cleanedAccession,
    modality: cleanedModality,
    body_part: cleanedBodyPart,
    indication: cleanedIndication,
    location: cleanedLocation,
    wait_minutes: safeWaitMinutes,
    context_tags: safeContextTags,
    priors_available: safePriorsAvailable,
    priority_tier: scoreResult.priority_tier,
    priority_score: scoreResult.priority_score,
    signals: scoreResult.signals,
    band_breakdown: scoreResult.band_breakdown,
    recommended_actions: recommendedActions,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    summary: `Study ${cleanedStudyId || cleanedAccession || 'unknown'} scored ${scoreResult.priority_score} (${scoreResult.priority_tier}) based on rule-based signals.`,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // Optional AI narrative (decorative).
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        rules_authoritative: true,
        decision_support_only: true,
        study: {
          study_id: cleanedStudyId,
          accession_number: cleanedAccession,
          modality: cleanedModality,
          body_part: cleanedBodyPart,
          indication: cleanedIndication,
          location: cleanedLocation,
          wait_minutes: safeWaitMinutes,
          context_tags: safeContextTags,
          priors_available: safePriorsAvailable,
        },
        rule_based_priority: {
          priority_tier: scoreResult.priority_tier,
          priority_score: scoreResult.priority_score,
          signals: scoreResult.signals,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        // Narrative is decorative; never let AI override priority_tier / priority_score / signals.
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
      };
    }
  } catch (err) {
    logger.debug('Radiology worklist: AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  // Merge output-defense safety flags.
  const defenseFlags = runOutputDefenses({
    draft,
    module,
    context: {
      patient: { uid: cleanedPatientUid },
      study: {
        study_id: cleanedStudyId,
        accession_number: cleanedAccession,
        modality: cleanedModality,
        body_part: cleanedBodyPart,
      },
    },
    citations: uniqueCits,
  });
  const combinedFlags = [...safetyFlags, ...asArray(defenseFlags)];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  // Persist generation.
  const generation = await insertGeneration({
    tenantId,
    patientUid: cleanedPatientUid,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      study_id: cleanedStudyId,
      accession_number: cleanedAccession,
      modality: cleanedModality,
      body_part: cleanedBodyPart,
      indication: normalizedText(cleanedIndication),
      location: normalizedText(cleanedLocation),
      wait_minutes: safeWaitMinutes,
      priority_tier: scoreResult.priority_tier,
      priority_score: scoreResult.priority_score,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      study_id: cleanedStudyId,
      accession_number: cleanedAccession,
      priority_tier: scoreResult.priority_tier,
      priority_score: scoreResult.priority_score,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  // Persist priority row.
  let priorityRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_radiology_worklist_priorities
         (tenant_id, patient_uid, study_id, accession_number, modality, body_part,
          generation_id, priority_tier, priority_score, signals, summary,
          recommended_actions, source_citations, safety_flags, reviewer_decision,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
               $10::jsonb, $11, $12::jsonb, $13::jsonb, $14::jsonb, 'pending',
               $15::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, study_id, accession_number, modality,
                 body_part, generation_id, priority_tier, priority_score, signals,
                 summary, recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      cleanedPatientUid,
      cleanedStudyId,
      cleanedAccession,
      cleanedModality,
      cleanedBodyPart,
      generation?.id || null,
      PRIORITY_TIERS.includes(scoreResult.priority_tier) ? scoreResult.priority_tier : 'unknown',
      scoreResult.priority_score,
      JSON.stringify(scoreResult.signals),
      cleanText(draft.summary),
      JSON.stringify(recommendedActions),
      JSON.stringify(draft.source_citations),
      JSON.stringify(combinedFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        band_breakdown: scoreResult.band_breakdown,
        context_tags: safeContextTags,
        wait_minutes: safeWaitMinutes,
        priors_available: safePriorsAvailable,
        is_stat_override: safeIsStatOverride,
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    priorityRow = normalizePriorityRow((rows && rows[0]) || null);
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      priority_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_radiology_worklist_priorities_unavailable',
      priority_tier: scoreResult.priority_tier,
      priority_score: scoreResult.priority_score,
      signals: scoreResult.signals,
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid: cleanedPatientUid,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.radiology_worklist_priority_evaluated',
      aggregateType: 'clinical_ai_radiology_worklist_priority',
      aggregateId: priorityRow?.id || generation?.id || null,
      patientUid: cleanedPatientUid,
      payload: {
        tenant_id: tenantId,
        priority_id: priorityRow?.id || null,
        generation_id: generation?.id || null,
        study_id: cleanedStudyId,
        accession_number: cleanedAccession,
        modality: cleanedModality,
        body_part: cleanedBodyPart,
        priority_tier: scoreResult.priority_tier,
        priority_score: scoreResult.priority_score,
      },
    });
  } catch (err) {
    logger.warn('Radiology worklist: event publish failed', { error: err?.message });
  }

  return {
    priority_id: priorityRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    priority: priorityRow,
    priority_tier: scoreResult.priority_tier,
    priority_score: scoreResult.priority_score,
    signals: scoreResult.signals,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || priorityRow?.reviewer_decision || 'pending',
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

export async function listWorklistPriorities({
  tenantId = null,
  patientUid = null,
  modality = null,
  priorityTier = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedPatient = patientUid ? cleanText(patientUid) : null;
  const normalizedModality = modality ? cleanText(modality) : null;
  const tierText = priorityTier ? cleanText(priorityTier).toLowerCase() : null;
  const normalizedTier = tierText && PRIORITY_TIERS.includes(tierText) ? tierText : null;
  const decisionText = reviewerDecision ? cleanText(reviewerDecision).toLowerCase() : null;
  const normalizedDecision = decisionText && DECISIONS.has(decisionText) ? decisionText : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.tenant_id, p.patient_uid, u.name AS patient_name,
              p.study_id, p.accession_number, p.modality, p.body_part,
              p.generation_id, p.priority_tier, p.priority_score, p.signals,
              p.summary, p.recommended_actions, p.source_citations, p.safety_flags,
              p.reviewer_decision, p.reviewed_by, p.reviewed_at, p.reviewer_note,
              p.metadata, p.created_at, p.updated_at
       FROM clinical_ai_radiology_worklist_priorities p
       LEFT JOIN users u ON u.uid = p.patient_uid
       WHERE p.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR p.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR p.modality = $3)
         AND ($4::text IS NULL OR p.priority_tier = $4)
         AND ($5::text IS NULL OR p.reviewer_decision = $5)
       ORDER BY
         CASE p.priority_tier
           WHEN 'stat' THEN 0
           WHEN 'urgent' THEN 1
           WHEN 'routine' THEN 2
           WHEN 'deferrable' THEN 3
           ELSE 4
         END,
         p.priority_score DESC,
         p.created_at DESC
       LIMIT $6`,
      tid,
      normalizedPatient,
      normalizedModality,
      normalizedTier,
      normalizedDecision,
      safeLimit
    );
    const priorities = asArray(rows).map(normalizePriorityRow);
    return { priorities, count: priorities.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { priorities: [], count: 0 };
    throw err;
  }
}

export async function decideWorklistPriority({
  tenantId = null,
  priorityId,
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
    `UPDATE clinical_ai_radiology_worklist_priorities
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, patient_uid, study_id, accession_number, modality,
               body_part, generation_id, priority_tier, priority_score, signals,
               summary, recommended_actions, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(priorityId, 'priority_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Radiology worklist priority not found');
  return normalizePriorityRow(rows[0]);
}

export default {
  PRIORITY_TIERS,
  TIER_PRIORITY,
  classifyPatientLocationScore,
  classifyModalityUrgency,
  classifyIndicationSeverity,
  classifyFragility,
  classifyWaitTime,
  classifyOrderingContext,
  classifyPriorsBonus,
  scorePriority,
  buildPriorityActions,
  rankWorklist,
  evaluateWorklistStudy,
  listWorklistPriorities,
  decideWorklistPriority,
};
