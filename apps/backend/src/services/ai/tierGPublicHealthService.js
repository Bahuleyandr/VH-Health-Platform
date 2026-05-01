/**
 * Tier G — public / population health AI assistants. 5 modules.
 *
 * The cohort / report / registry modules surface AGGREGATE counts only;
 * none of them returns row-level PHI in the draft. The de-identification
 * module operates on free-text and applies HIPAA Safe Harbor + India
 * (Aadhaar / ABHA) redactions.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { runExplainerPipeline } from './patientExplainersService.js';

const TEXT_INPUT_MAX = 24_000;
const CHRONIC_CONDITIONS = ['diabetes', 'hypertension', 'ckd', 'heart_failure', 'copd', 'asthma'];

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}
function normalizeInt(value, label, { min = null, max = null, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}
function requireText(value, label, { min = 1, max = TEXT_INPUT_MAX } = {}) {
  const text = String(value || '').trim();
  if (text.length < min) throw AppError.badRequest(`${label} must be at least ${min} characters`);
  return text.slice(0, max);
}
function shortHash(p) { return crypto.createHash('sha256').update(JSON.stringify(p || {})).digest('hex').slice(0, 16); }
async function safeQuery(sql, params = [], fallback = []) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : fallback;
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. Chronic disease registry — aggregate counts only
// ---------------------------------------------------------------------------
export async function generateChronicDiseaseRegistry({
  tenantId = null, condition,
  generatedBy = null, req = null,
} = {}) {
  const cond = String(condition || '').toLowerCase().trim();
  if (!CHRONIC_CONDITIONS.includes(cond)) {
    throw AppError.badRequest(`condition must be one of: ${CHRONIC_CONDITIONS.join(', ')}`);
  }

  const counts = await safeQuery(
    `SELECT COUNT(DISTINCT patient_uid)::int AS active_patients
     FROM admissions
     WHERE LOWER(primary_diagnosis) LIKE $1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(secondary_diagnoses::jsonb) elem
          WHERE LOWER(elem) LIKE $1
        )`,
    [`%${cond}%`],
  );

  return runExplainerPipeline({
    moduleKey: 'chronic_disease_registry',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a population-health analyst. Summarise the ${cond} registry.`,
      'Output: explanation_summary, registry_overview (object with cohort_size, average_review_gap_days_estimate, suspected_under_screened), recommended_outreach_actions (array).',
      'Use ONLY the supplied counts. NEVER list individual patient identifiers.',
    ].join('\n'),
    userPromptPayload: { condition: cond, counts: counts[0] || { active_patients: 0 } },
    contextForDefenses: { condition: cond, counts },
    citations: [{ source_type: 'aggregate_count', source_id: shortHash({ cond, counts }),
      label: `${cond} cohort count`, timestamp: null }],
    metadata: { condition: cond, cohort_size: counts[0]?.active_patients || 0 },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. Screening gap detection — aggregate
// ---------------------------------------------------------------------------
export async function generateScreeningGapDetection({
  tenantId = null, screeningType,
  generatedBy = null, req = null,
} = {}) {
  const allowed = ['cervical', 'breast', 'colon', 'bp', 'lipids', 'diabetes', 'hba1c'];
  const t = String(screeningType || '').toLowerCase().trim();
  if (!allowed.includes(t)) {
    throw AppError.badRequest(`screening_type must be one of: ${allowed.join(', ')}`);
  }

  return runExplainerPipeline({
    moduleKey: 'screening_gap_detection',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a population-health analyst. Identify patients due / overdue for ${t} screening based on age + sex + risk factors.`,
      'Output: explanation_summary, due_now_count, overdue_count, suggested_outreach_pathway (SMS / call / clinic visit), guideline_used.',
      'NEVER list individual patient identifiers. Cite the guideline (USPSTF / IAP / MoHFW) you referenced.',
    ].join('\n'),
    userPromptPayload: { screening_type: t },
    contextForDefenses: { screening_type: t },
    citations: [{ source_type: 'screening_label', source_id: t, label: `${t} screening guideline`, timestamp: null }],
    metadata: { screening_type: t },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. High-risk patient cohorts
// ---------------------------------------------------------------------------
export async function generateHighRiskCohorts({
  tenantId = null, criteria = null,
  generatedBy = null, req = null,
} = {}) {
  return runExplainerPipeline({
    moduleKey: 'high_risk_patient_cohorts',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a population-health analyst. Build a high-risk cohort definition.',
      'Output: explanation_summary, cohort_definition (object: inclusion_criteria, exclusion_criteria), estimated_size_band: small|medium|large, recommended_outreach_pattern, governance_review_required: true|false.',
      'NEVER list individual patient identifiers. If criteria conflict (e.g. exclude all children but include peds-rheum) flag as ambiguous.',
    ].join('\n'),
    userPromptPayload: { criteria: criteria || {} },
    contextForDefenses: { criteria },
    citations: [{ source_type: 'cohort_criteria', source_id: shortHash(criteria),
      label: 'cohort criteria payload', timestamp: null }],
    metadata: { criteria_hash: shortHash(criteria) },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Public health report generator
// ---------------------------------------------------------------------------
export async function generatePublicHealthReport({
  tenantId = null, reportType, periodDays = 30,
  generatedBy = null, req = null,
} = {}) {
  const allowed = ['notifiable_disease', 'immunisation_coverage', 'anc_compliance',
    'maternal_outcomes', 'pediatric_growth', 'tb_dots'];
  const t = String(reportType || '').toLowerCase().trim();
  if (!allowed.includes(t)) {
    throw AppError.badRequest(`report_type must be one of: ${allowed.join(', ')}`);
  }
  const days = normalizeInt(periodDays, 'period_days', { min: 7, max: 365, fallback: 30 });

  return runExplainerPipeline({
    moduleKey: 'public_health_report_generator',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a public-health reporter. Produce the ${t.replace(/_/g, ' ')} report for the last ${days} days.`,
      'Output: explanation_summary, report (object — schema appropriate to report_type), regulatory_recipients (array — IDSP / state health office), de_identification_check (object).',
      'NEVER include patient names or DOBs. If a per-patient breakdown is requested, refuse and mark requires_deidentification=true.',
    ].join('\n'),
    userPromptPayload: { report_type: t, period_days: days },
    contextForDefenses: { report_type: t, period_days: days },
    citations: [{ source_type: 'report_type_label', source_id: t,
      label: t.replace(/_/g, ' '), timestamp: null }],
    metadata: { report_type: t, period_days: days },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. PHI de-identification
// ---------------------------------------------------------------------------
const PHI_REGEXES_DEFENSE = [
  { name: 'phone_in', re: /\b\+?\d{1,3}\s*[-.\s]?\d{4}[-.\s]?\d{4,6}\b/g },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { name: 'aadhaar', re: /\b\d{4}\s?\d{4}\s?\d{4}\b/g },
  { name: 'abha', re: /\b\d{2}-\d{4}-\d{4}-\d{4}\b/g },
  { name: 'dob_iso', re: /\b\d{4}-\d{2}-\d{2}\b/g },
];

export async function generatePhiDeidentification({
  tenantId = null, sourceText, retainSafeHarbor = false,
  generatedBy = null, req = null,
} = {}) {
  const text = requireText(sourceText, 'source_text', { min: 30 });

  const found = [];
  for (const { name, re } of PHI_REGEXES_DEFENSE) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches && matches.length) found.push({ pattern: name, count: matches.length });
  }

  return runExplainerPipeline({
    moduleKey: 'phi_deidentification',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a HIPAA-aware de-identifier. Remove HIPAA Safe Harbor 18 identifiers + India-specific (Aadhaar, ABHA).',
      'Replace identifiers with stable tokens [PERSON_1], [PHONE_1], [DATE_1], etc. so co-references survive.',
      'Output: explanation_summary, deidentified_text, redactions (array of { kind, count }), residual_concerns (array — anything ambiguous you saw but couldn\'t confidently classify).',
      'When retain_safe_harbor=true, preserve geographic regions larger than the first 3 ZIP digits + dates of year only (drop month/day).',
      'NEVER add information that was not in the source. If unsure, redact more aggressively, not less.',
    ].join('\n'),
    userPromptPayload: { source_text: text, retain_safe_harbor: Boolean(retainSafeHarbor),
      regex_pre_scan: found },
    contextForDefenses: { source_text: text, regex_pre_scan: found },
    citations: [{ source_type: 'source_text', source_id: shortHash(text),
      label: `Source (${text.length} chars)`, timestamp: null }],
    metadata: { source_chars: text.length, retain_safe_harbor: Boolean(retainSafeHarbor),
      pre_scan_hits: found.length },
    generatedBy, req,
  });
}

export const __testing__ = { CHRONIC_CONDITIONS, PHI_REGEXES_DEFENSE, shortHash };

export default {
  generateChronicDiseaseRegistry,
  generateScreeningGapDetection,
  generateHighRiskCohorts,
  generatePublicHealthReport,
  generatePhiDeidentification,
};
