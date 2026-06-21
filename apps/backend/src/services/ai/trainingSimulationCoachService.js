/**
 * Training and Simulation Coach.
 *
 * Converts de-identified clinical incidents (mortality, near-miss, safety
 * event, delayed diagnosis, medication error, handoff failure, infection
 * outbreak, equipment failure) or RCAs into structured training/simulation
 * modules: learning objectives, decision points, debrief questions,
 * reference guidelines, and a suggested simulation format. Rules are
 * authoritative; the supplied summary is scrubbed for residual PHI (MRN,
 * phone, name, email, Aadhaar) and any detection is flagged. Review-only —
 * the training director approves before publishing to staff, and the module
 * never auto-publishes or assigns training.
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

const MODULE_KEY = 'training_simulation_coach';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You support the training and simulation coach. Rules authoritative. Training-only content. Never re-introduce PHI. Return JSON only.',
  user_prompt_template: 'Write a short narrative describing the simulation for the training director. Do not override rule-generated fields. Do not re-introduce PHI.',
};

const CASE_TYPES = new Set([
  'mortality',
  'near_miss',
  'safety_event',
  'delayed_diagnosis',
  'medication_error',
  'handoff_failure',
  'infection_outbreak',
  'equipment_failure',
  'other',
]);

const SEVERITIES = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const SEVERITY_PRIORITY = ['unknown', 'low', 'moderate', 'high', 'critical'];
const FORMATS = new Set(['tabletop', 'sim_lab', 'vr_ready', 'online', 'workshop', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
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

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(list)) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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
 * Strip residual PHI from a free-text summary. Returns the scrubbed text
 * plus the set of finding codes emitted so reviewers can see what was
 * detected and trust the module flagged it.
 */
export function scrubPhiFromSummary(text) {
  const findings = new Set();
  if (!text || typeof text !== 'string') {
    return { scrubbed: '', findings: [] };
  }
  let scrubbed = text;

  // Name capture BEFORE generic tokens so we catch the name tokens before
  // they get consumed by other regexes.
  const nameRegex = /(?:Patient|Name)\s*[:=-]?\s*([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,3})/g;
  if (nameRegex.test(scrubbed)) {
    findings.add('NAME_DETECTED');
    scrubbed = scrubbed.replace(nameRegex, (_m) => {
      return '[NAME]';
    });
  }

  // Email-like tokens.
  const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  if (emailRegex.test(scrubbed)) {
    findings.add('EMAIL_DETECTED');
    scrubbed = scrubbed.replace(emailRegex, '[EMAIL]');
  }

  // 12-digit Aadhaar (check BEFORE 10-digit phone so we don't partially
  // consume with PHONE first; match exact 12 digits with word boundaries).
  const aadhaarRegex = /\b\d{12}\b/g;
  if (aadhaarRegex.test(scrubbed)) {
    findings.add('AADHAAR_DETECTED');
    scrubbed = scrubbed.replace(aadhaarRegex, '[AADHAAR]');
  }

  // Phone: 10-digit runs OR +91 prefix.
  const phoneRegex = /(?:\+91[\s-]?\d{10})|(?:\b\d{10}\b)/g;
  if (phoneRegex.test(scrubbed)) {
    findings.add('PHONE_DETECTED');
    scrubbed = scrubbed.replace(phoneRegex, '[PHONE]');
  }

  // MRN tokens: MRN:... and VH-... patterns. Character class has `-` at
  // end to avoid no-useless-escape.
  const mrnRegex = /(?:MRN[:\s=_ -]*\w+)|(?:\bVH[-_]\w+)/gi;
  if (mrnRegex.test(scrubbed)) {
    findings.add('MRN_DETECTED');
    scrubbed = scrubbed.replace(mrnRegex, '[MRN]');
  }

  return { scrubbed, findings: Array.from(findings) };
}

/**
 * Normalize a case-type string. Lower-cased, spaces/hyphens collapsed to
 * underscore. Unknowns fall through to 'other'.
 */
export function normalizeCaseType(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'other';
  return CASE_TYPES.has(normalized) ? normalized : 'other';
}

/**
 * Normalize a format string. Unknowns fall through to 'unknown'.
 */
export function normalizeFormat(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'unknown';
  return FORMATS.has(normalized) ? normalized : 'unknown';
}

/**
 * Normalize a severity string. Unknowns fall through to 'unknown'.
 */
export function normalizeSeverity(value) {
  const normalized = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'unknown';
  return SEVERITIES.has(normalized) ? normalized : 'unknown';
}

/**
 * Classify incident risk from case_type + severity. Returns both a numeric
 * score and the discrete risk band.
 */
export function classifyIncidentRisk({ caseType, severity }) {
  const ct = normalizeCaseType(caseType);
  const sev = normalizeSeverity(severity);
  let base = 10;
  switch (ct) {
    case 'mortality':
      base = 40;
      break;
    case 'safety_event':
      base = 25;
      break;
    case 'delayed_diagnosis':
      base = 25;
      break;
    case 'medication_error':
      base = 25;
      break;
    case 'handoff_failure':
      base = 20;
      break;
    case 'infection_outbreak':
      base = 20;
      break;
    case 'equipment_failure':
      base = 20;
      break;
    case 'near_miss':
      base = 15;
      break;
    default:
      base = 10;
      break;
  }
  let bonus = 0;
  if (sev === 'critical') bonus = 30;
  else if (sev === 'high') bonus = 20;
  else if (sev === 'moderate') bonus = 10;
  else bonus = 0;
  const risk_score = base + bonus;
  let risk_band;
  if (risk_score >= 60) risk_band = 'critical';
  else if (risk_score >= 40) risk_band = 'high';
  else if (risk_score >= 20) risk_band = 'moderate';
  else risk_band = 'low';
  return { risk_band, risk_score };
}

/**
 * Suggest a simulation format from the case_type + severity mix.
 */
export function suggestFormat({ caseType, severity }) {
  const ct = normalizeCaseType(caseType);
  const sev = normalizeSeverity(severity);
  if (sev === 'critical' && (ct === 'mortality' || ct === 'safety_event' || ct === 'delayed_diagnosis')) {
    return 'sim_lab';
  }
  if (ct === 'medication_error' || ct === 'handoff_failure') {
    return 'tabletop';
  }
  if (ct === 'infection_outbreak') {
    return 'workshop';
  }
  if (ct === 'equipment_failure') {
    return 'sim_lab';
  }
  return 'online';
}

/**
 * Suggest a simulation duration (minutes) from case_type + severity +
 * format. Capped at 180.
 */
export function suggestDuration({ caseType, severity, format }) {
  const ct = normalizeCaseType(caseType);
  const sev = normalizeSeverity(severity);
  const fmt = normalizeFormat(format);
  let base;
  switch (fmt) {
    case 'sim_lab':
      base = 60;
      break;
    case 'workshop':
      base = 90;
      break;
    case 'tabletop':
      base = 45;
      break;
    case 'vr_ready':
      base = 60;
      break;
    case 'online':
      base = 30;
      break;
    default:
      base = 30;
      break;
  }
  let total = base;
  if (sev === 'critical') total += 15;
  if (ct === 'mortality') total += 10;
  return Math.min(total, 180);
}

/**
 * Base target roles per case_type with incident-category additions.
 * Dedupes the final list.
 */
export function deriveTargetRoles({ caseType, incidentCategory = null }) {
  const ct = normalizeCaseType(caseType);
  let roles;
  switch (ct) {
    case 'medication_error':
      roles = ['DOCTOR', 'NURSE', 'PHARMACY_STAFF'];
      break;
    case 'handoff_failure':
      roles = ['DOCTOR', 'NURSE'];
      break;
    case 'equipment_failure':
      roles = ['NURSE', 'BIOMED'];
      break;
    case 'infection_outbreak':
      roles = ['DOCTOR', 'NURSE', 'INFECTION_CONTROL'];
      break;
    default:
      roles = ['DOCTOR', 'NURSE'];
      break;
  }
  const cat = cleanText(incidentCategory).toLowerCase();
  if (cat === 'airway') roles.push('ANESTHESIOLOGIST');
  if (cat === 'obstetric' || cat === 'pph') roles.push('OBSTETRICIAN');
  if (cat === 'pediatric') roles.push('PEDIATRICIAN');
  // Dedupe preserving order.
  const seen = new Set();
  const out = [];
  for (const r of roles) {
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

/**
 * Build 3-6 "Given..." learning objectives scoped to case_type and incident
 * category.
 */
export function buildLearningObjectives({ caseType, incidentCategory = null, severity = 'low' }) {
  const ct = normalizeCaseType(caseType);
  const sev = normalizeSeverity(severity);
  const cat = cleanText(incidentCategory).toLowerCase();
  const out = [];
  out.push('Given a de-identified incident scenario, the learner will identify the contributing system factors and describe one mitigation for each.');
  out.push('Given an ambiguous clinical handoff, the learner will apply a structured communication tool (SBAR or I-PASS) and document the critical facts in a standard format.');
  switch (ct) {
    case 'mortality':
      out.push('Given a mortality review, the learner will perform a structured root-cause walk-through and distinguish proximate cause from latent system contributors.');
      break;
    case 'medication_error':
      out.push('Given a medication error scenario, the learner will reconcile the order, check allergies, and apply the five rights of medication administration before simulated execution.');
      break;
    case 'handoff_failure':
      out.push('Given a high-acuity handoff, the learner will deliver a complete I-PASS / SBAR handoff and prioritize the unstable findings explicitly.');
      break;
    case 'infection_outbreak':
      out.push('Given a suspected cluster, the learner will activate standard isolation, notify infection control, and describe the reporting chain within the tenant.');
      break;
    case 'equipment_failure':
      out.push('Given a device malfunction, the learner will remove the device from patient use, document the failure, and escalate to biomed per policy.');
      break;
    case 'delayed_diagnosis':
      out.push('Given a delayed-diagnosis scenario, the learner will identify the cognitive and process contributors and describe one forcing function to reduce recurrence.');
      break;
    case 'near_miss':
      out.push('Given a near-miss scenario, the learner will describe why the event did not harm the patient and identify the recovery mechanism for reinforcement.');
      break;
    case 'safety_event':
      out.push('Given a safety event, the learner will apply a "just culture" analytic frame and distinguish human error, at-risk behavior, and reckless conduct.');
      break;
    default:
      out.push('Given the scenario, the learner will apply standard incident-review principles and articulate two systemic improvements.');
      break;
  }
  if (cat === 'airway') {
    out.push('Given a difficult airway scenario, the learner will call the appropriate assistance and execute the institution\'s difficult-airway algorithm step by step.');
  } else if (cat === 'obstetric' || cat === 'pph') {
    out.push('Given postpartum hemorrhage, the learner will activate the massive transfusion pathway and coordinate obstetric, anesthesia, and blood-bank resources in parallel.');
  } else if (cat === 'pediatric') {
    out.push('Given a pediatric emergency, the learner will apply length-based dosing and age-appropriate resuscitation parameters.');
  }
  if (sev === 'critical') {
    out.push('Given a critical-severity scenario, the learner will demonstrate closed-loop communication and explicit role assignment during resuscitation.');
  }
  // Guarantee 3-6.
  const trimmed = out.slice(0, 6);
  while (trimmed.length < 3) {
    trimmed.push('Given the scenario, the learner will reflect on one process or system improvement and describe how to measure its effect.');
  }
  return trimmed;
}

/**
 * Build 3-5 decision-point objects. Each has a stage (from a fixed pool),
 * a prompt, options, and the correct path label.
 */
export function buildDecisionPoints({ caseType, incidentCategory = null }) {
  const ct = normalizeCaseType(caseType);
  const cat = cleanText(incidentCategory).toLowerCase();
  const points = [];
  points.push({
    stage: 'arrival',
    prompt: 'Incident/patient first arrives at the scenario — what is the first concrete action?',
    key_options: ['Initiate primary survey and assign roles', 'Wait for senior arrival', 'Begin documentation only'],
    correct_path: 'Initiate primary survey and assign roles',
  });
  points.push({
    stage: 'recognition',
    prompt: 'Given the presenting findings, what is the highest-priority concern to verbalize?',
    key_options: ['The primary deterioration driver', 'A secondary finding', 'Defer until labs return'],
    correct_path: 'The primary deterioration driver',
  });
  points.push({
    stage: 'stabilization',
    prompt: 'Which stabilization bundle should be executed now?',
    key_options: ['Institution bundle for this pathway', 'Institution bundle for an unrelated pathway', 'No bundle — wait for consult'],
    correct_path: 'Institution bundle for this pathway',
  });
  if (ct === 'handoff_failure' || ct === 'delayed_diagnosis') {
    points.push({
      stage: 'handoff',
      prompt: 'At shift change, how should this patient be handed off?',
      key_options: ['Structured SBAR/I-PASS with explicit unstable findings', 'Verbal summary only', 'Skip handoff — note in chart'],
      correct_path: 'Structured SBAR/I-PASS with explicit unstable findings',
    });
  } else {
    points.push({
      stage: 'escalation',
      prompt: 'Deterioration continues — whom and when do you escalate?',
      key_options: ['Activate rapid response now per criteria', 'Page primary team and wait', 'Increase observation frequency and reassess in 1 hour'],
      correct_path: 'Activate rapid response now per criteria',
    });
  }
  if (cat === 'airway' || ct === 'medication_error') {
    points.push({
      stage: 'escalation',
      prompt: 'A high-risk medication / airway decision is required — who owns the call?',
      key_options: ['Designated senior (anesthesia/pharmacy) per policy', 'First available clinician', 'Defer to family'],
      correct_path: 'Designated senior (anesthesia/pharmacy) per policy',
    });
  }
  return points.slice(0, 5);
}

/**
 * Build 4-6 debrief questions. Critical severity always includes at least
 * one communication/escalation question.
 */
export function buildDebriefQuestions({ caseType, severity = 'low' }) {
  const ct = normalizeCaseType(caseType);
  const sev = normalizeSeverity(severity);
  const qs = [];
  qs.push('What went well in the team response, and what would you preserve for the next similar case?');
  qs.push('What system factors (staffing, equipment, processes, handoff) contributed to the outcome?');
  qs.push('Where did the mental model of the team diverge, and how did you detect or recover from that?');
  qs.push('If this case recurred tomorrow, what one change would have the largest effect on patient safety?');
  if (sev === 'critical') {
    qs.push('How did closed-loop communication and escalation unfold — what would you do differently to escalate earlier or more clearly?');
  }
  if (ct === 'medication_error' || ct === 'handoff_failure') {
    qs.push('What forcing functions (technology, protocol, or checklist) could eliminate the root cause you identified?');
  }
  if (sev !== 'critical') {
    qs.push('How would you coach a junior colleague who was placed in this exact scenario for the first time?');
  }
  return qs.slice(0, 6);
}

/**
 * Build a concrete list of reference / guideline citations per case_type.
 */
export function buildReferences({ caseType, incidentCategory = null }) {
  const ct = normalizeCaseType(caseType);
  const cat = cleanText(incidentCategory).toLowerCase();
  const refs = [];
  switch (ct) {
    case 'mortality':
      refs.push({ source_type: 'guideline', label: 'Institutional mortality review SOP', citation_id: 'INST_MM_REVIEW_SOP' });
      refs.push({ source_type: 'framework', label: 'RCA² — improving root cause analyses and actions to prevent harm (IHI)', citation_id: 'IHI_RCA2' });
      break;
    case 'medication_error':
      refs.push({ source_type: 'guideline', label: 'ISMP medication-error prevention toolkit', citation_id: 'ISMP_MED_ERROR' });
      refs.push({ source_type: 'framework', label: 'WHO Medication Without Harm — five rights', citation_id: 'WHO_MED_SAFETY' });
      break;
    case 'handoff_failure':
      refs.push({ source_type: 'framework', label: 'I-PASS handoff bundle (Starmer et al.)', citation_id: 'IPASS' });
      refs.push({ source_type: 'framework', label: 'SBAR structured communication', citation_id: 'SBAR' });
      break;
    case 'infection_outbreak':
      refs.push({ source_type: 'guideline', label: 'CDC healthcare infection control guidelines', citation_id: 'CDC_HAI' });
      refs.push({ source_type: 'guideline', label: 'Institutional outbreak escalation pathway', citation_id: 'INST_OUTBREAK' });
      break;
    case 'equipment_failure':
      refs.push({ source_type: 'guideline', label: 'Biomed device reporting and removal policy', citation_id: 'INST_BIOMED_REPORTING' });
      refs.push({ source_type: 'guideline', label: 'ECRI medical device safety reports', citation_id: 'ECRI_DEVICE_SAFETY' });
      break;
    case 'delayed_diagnosis':
      refs.push({ source_type: 'framework', label: 'Society to Improve Diagnosis in Medicine toolkit', citation_id: 'SIDM_TOOLKIT' });
      refs.push({ source_type: 'guideline', label: 'Institutional diagnostic safety escalation pathway', citation_id: 'INST_DX_SAFETY' });
      break;
    case 'near_miss':
      refs.push({ source_type: 'framework', label: 'AHRQ near-miss reporting and learning guide', citation_id: 'AHRQ_NEAR_MISS' });
      break;
    case 'safety_event':
      refs.push({ source_type: 'framework', label: 'Just Culture algorithm (Marx)', citation_id: 'JUST_CULTURE' });
      refs.push({ source_type: 'framework', label: 'Swiss cheese model of organizational accidents', citation_id: 'REASON_SWISS_CHEESE' });
      break;
    default:
      refs.push({ source_type: 'guideline', label: 'Institutional incident review SOP', citation_id: 'INST_INCIDENT_SOP' });
      break;
  }
  if (cat === 'airway') {
    refs.push({ source_type: 'guideline', label: 'Difficult Airway Society / ASA difficult airway algorithm', citation_id: 'DAS_ASA_DIFFICULT_AIRWAY' });
  } else if (cat === 'obstetric' || cat === 'pph') {
    refs.push({ source_type: 'guideline', label: 'RCOG / FIGO postpartum hemorrhage management', citation_id: 'RCOG_PPH' });
  } else if (cat === 'pediatric') {
    refs.push({ source_type: 'guideline', label: 'PALS pediatric resuscitation algorithm', citation_id: 'PALS' });
  }
  return uniqueBy(refs, (r) => r.citation_id);
}

/**
 * Compose the full rule-based training module shape in-memory. Pure; does
 * not read or write the database.
 */
export function buildTrainingModule({ title, caseType, incidentCategory = null, severity = 'low', summary = null }) {
  const normalizedTitle = cleanText(title);
  const case_type = normalizeCaseType(caseType);
  const severityNormalized = normalizeSeverity(severity);
  const { risk_band, risk_score } = classifyIncidentRisk({ caseType: case_type, severity: severityNormalized });
  const format = suggestFormat({ caseType: case_type, severity: severityNormalized });
  const duration_minutes = suggestDuration({ caseType: case_type, severity: severityNormalized, format });
  const target_roles = deriveTargetRoles({ caseType: case_type, incidentCategory });
  const learning_objectives = buildLearningObjectives({ caseType: case_type, incidentCategory, severity: severityNormalized });
  const decision_points = buildDecisionPoints({ caseType: case_type, incidentCategory });
  const debrief_questions = buildDebriefQuestions({ caseType: case_type, severity: severityNormalized });
  const references = buildReferences({ caseType: case_type, incidentCategory });
  const { scrubbed, findings } = scrubPhiFromSummary(summary);
  return {
    title: normalizedTitle,
    case_type,
    incident_category: cleanText(incidentCategory) || null,
    severity: severityNormalized,
    risk_band,
    risk_score,
    format,
    duration_minutes,
    target_roles,
    learning_objectives,
    decision_points,
    debrief_questions,
    references,
    scrubbed_summary: summary ? scrubbed : null,
    phi_findings: findings,
  };
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

async function insertGeneration({
  tenantId,
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
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4, $5, $6, $7, $8,
               $9::jsonb, $10::jsonb, $11::jsonb, $12::uuid, $13, $14, $15,
               $16, $17, $18, $19, $20::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
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
      logger.warn('Training simulation coach: generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'TRAINING_LEAD', 'DOCTOR'],
        source: 'training_simulation_coach',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
        training_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Training simulation coach: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function buildNarrativePrompt({ prompt, draft }) {
  return `${prompt.user_prompt_template}\n\n${JSON.stringify({
    rules_authoritative: true,
    decision_support_only: true,
    training_only: true,
    title: draft.title,
    case_type: draft.case_type,
    incident_category: draft.incident_category,
    severity: draft.severity,
    risk_band: draft.risk_band,
    format: draft.format,
    duration_minutes: draft.duration_minutes,
    target_roles: draft.target_roles,
    learning_objectives_count: asArray(draft.learning_objectives).length,
    decision_points_count: asArray(draft.decision_points).length,
    debrief_questions_count: asArray(draft.debrief_questions).length,
    references_count: asArray(draft.references).length,
    phi_findings: draft.phi_findings,
  })}`;
}

export async function generateTrainingModule({
  req = null,
  title,
  caseType,
  incidentCategory = null,
  severity = 'low',
  summary = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const cleanedTitle = cleanText(title);
  if (!cleanedTitle) {
    throw AppError.badRequest('title is required');
  }

  const moduleDraft = buildTrainingModule({
    title: cleanedTitle,
    caseType,
    incidentCategory,
    severity,
    summary,
  });

  const citations = [
    ...asArray(moduleDraft.references).map((r) => ({
      source_type: r.source_type || 'guideline',
      source_id: r.citation_id || r.label,
      label: r.label,
      timestamp: null,
    })),
    {
      source_type: 'training_rules',
      source_id: MODULE_KEY,
      label: `Training rules — ${moduleDraft.case_type}`,
      timestamp: null,
    },
  ];

  const safetyFlags = [];
  for (const finding of asArray(moduleDraft.phi_findings)) {
    safetyFlags.push({
      severity: 'high',
      code: 'PHI_DETECTED_IN_SUMMARY',
      message: `Residual PHI detected and scrubbed in supplied summary: ${finding}.`,
    });
  }
  if (moduleDraft.severity === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'CRITICAL_INCIDENT_TRAINING',
      message: 'Source incident is critical severity — training content requires training-director review before publication.',
    });
  }
  if (!citations.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Training module has no reference citations.',
    });
  }

  const draft = {
    module_key: MODULE_KEY,
    title: moduleDraft.title,
    case_type: moduleDraft.case_type,
    incident_category: moduleDraft.incident_category,
    severity: moduleDraft.severity,
    risk_band: moduleDraft.risk_band,
    risk_score: moduleDraft.risk_score,
    format: moduleDraft.format,
    duration_minutes: moduleDraft.duration_minutes,
    target_roles: moduleDraft.target_roles,
    learning_objectives: moduleDraft.learning_objectives,
    decision_points: moduleDraft.decision_points,
    debrief_questions: moduleDraft.debrief_questions,
    references: moduleDraft.references,
    scrubbed_summary: moduleDraft.scrubbed_summary,
    phi_findings: moduleDraft.phi_findings,
    source_citations: citations,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
    training_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildNarrativePrompt({ prompt, draft }),
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Training simulation coach: AI narrative failed (non-fatal)', { error: err.message });
  }
  // AI narrative is decorative only — never override rule-built sections.
  const parsed = safeJsonParse(aiResult?.text, {});
  if (parsed && typeof parsed === 'object' && cleanText(parsed.narrative)) {
    draft.ai_narrative = cleanText(parsed.narrative);
  }

  const combinedFlags = [
    ...safetyFlags,
    ...runOutputDefenses({
      draft,
      module,
      context: {
        training_only: true,
        case_type: moduleDraft.case_type,
        severity: moduleDraft.severity,
      },
      citations,
    }),
  ];
  draft.safety_flags = combinedFlags;

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      module_key: MODULE_KEY,
      title: cleanedTitle,
      case_type: moduleDraft.case_type,
      incident_category: moduleDraft.incident_category,
      severity: moduleDraft.severity,
    }),
    draft,
    citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      case_type: moduleDraft.case_type,
      severity: moduleDraft.severity,
      format: moduleDraft.format,
      incident_category: moduleDraft.incident_category,
      tenant_region: req?.tenant?.region || null,
      rules_authoritative: true,
      decision_support_only: true,
      training_only: true,
    },
  });

  let moduleRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_training_modules
         (tenant_id, title, case_type, incident_category, severity, target_roles,
          format, duration_minutes, generation_id, learning_objectives,
          decision_points, debrief_questions, reference_guidelines, scrubbed_summary,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14,
               $15::jsonb, $16::jsonb, 'pending', $17::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, title, case_type, incident_category, severity,
                 target_roles, format, duration_minutes, generation_id,
                 learning_objectives, decision_points, debrief_questions,
                 reference_guidelines, scrubbed_summary, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      moduleDraft.title,
      moduleDraft.case_type,
      moduleDraft.incident_category,
      moduleDraft.severity,
      JSON.stringify(moduleDraft.target_roles || []),
      moduleDraft.format,
      moduleDraft.duration_minutes,
      generation?.id || null,
      JSON.stringify(moduleDraft.learning_objectives || []),
      JSON.stringify(moduleDraft.decision_points || []),
      JSON.stringify(moduleDraft.debrief_questions || []),
      JSON.stringify(moduleDraft.references || []),
      moduleDraft.scrubbed_summary,
      JSON.stringify(citations),
      JSON.stringify(combinedFlags),
      JSON.stringify({
        risk_band: moduleDraft.risk_band,
        risk_score: moduleDraft.risk_score,
        phi_findings: moduleDraft.phi_findings,
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        rules_authoritative: true,
        decision_support_only: true,
        training_only: true,
      })
    );
    moduleRow = rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      module_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: citations,
      safety_flags: combinedFlags,
      phi_findings: moduleDraft.phi_findings,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_training_modules_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.training_module_generated',
    aggregateType: 'clinical_ai_training_module',
    aggregateId: moduleRow?.id || generation?.id || null,
    payload: {
      tenant_id: tenantId,
      module_id: moduleRow?.id || null,
      generation_id: generation?.id || null,
      case_type: moduleDraft.case_type,
      incident_category: moduleDraft.incident_category,
      severity: moduleDraft.severity,
      risk_band: moduleDraft.risk_band,
      format: moduleDraft.format,
      duration_minutes: moduleDraft.duration_minutes,
      phi_findings_count: asArray(moduleDraft.phi_findings).length,
    },
  });

  return {
    module_id: moduleRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    module: moduleRow,
    case_type: moduleDraft.case_type,
    severity: moduleDraft.severity,
    risk_band: moduleDraft.risk_band,
    risk_score: moduleDraft.risk_score,
    format: moduleDraft.format,
    duration_minutes: moduleDraft.duration_minutes,
    target_roles: moduleDraft.target_roles,
    phi_findings: moduleDraft.phi_findings,
    source_citations: citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || moduleRow?.reviewer_decision || 'pending',
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

export async function listTrainingModules({
  tenantId = null,
  caseType = null,
  severity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedCaseType = caseType && CASE_TYPES.has(normalizeCaseType(caseType))
    ? normalizeCaseType(caseType)
    : null;
  const normalizedSeverity = severity && SEVERITIES.has(normalizeSeverity(severity))
    ? normalizeSeverity(severity)
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, title, case_type, incident_category, severity,
              target_roles, format, duration_minutes, generation_id,
              learning_objectives, decision_points, debrief_questions,
              reference_guidelines, scrubbed_summary, source_citations, safety_flags,
              reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
              metadata, created_at, updated_at
       FROM clinical_ai_training_modules
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR case_type = $2)
         AND ($3::text IS NULL OR severity = $3)
         AND ($4::text IS NULL OR reviewer_decision = $4)
       ORDER BY
         CASE severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         created_at DESC
       LIMIT $5`,
      tid,
      normalizedCaseType,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    return { modules: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { modules: [], count: 0 };
    throw err;
  }
}

export async function decideTrainingModule({
  tenantId = null,
  moduleId,
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
    `UPDATE clinical_ai_training_modules
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, title, case_type, incident_category, severity, format,
               duration_minutes, generation_id, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(moduleId, 'module_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Training module not found');
  const row = rows[0];
  return {
    ...row,
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

export {
  CASE_TYPES,
  SEVERITIES,
  SEVERITY_PRIORITY,
  FORMATS,
  DECISIONS,
  FINAL_DECISIONS,
  MODULE_KEY,
};

export default {
  CASE_TYPES,
  SEVERITIES,
  SEVERITY_PRIORITY,
  FORMATS,
  DECISIONS,
  FINAL_DECISIONS,
  MODULE_KEY,
  scrubPhiFromSummary,
  normalizeCaseType,
  normalizeFormat,
  normalizeSeverity,
  classifyIncidentRisk,
  suggestFormat,
  suggestDuration,
  deriveTargetRoles,
  buildLearningObjectives,
  buildDecisionPoints,
  buildDebriefQuestions,
  buildReferences,
  buildTrainingModule,
  generateTrainingModule,
  listTrainingModules,
  decideTrainingModule,
};
