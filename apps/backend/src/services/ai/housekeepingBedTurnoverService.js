/**
 * Housekeeping and Bed Turnover Optimizer.
 *
 * Operations decision-support for post-discharge bed turnover. Given the
 * previous admission's isolation precautions / diagnoses / surgical status,
 * the staffing load, bed demand (ED boarding, OR queue), time-since-
 * discharge, and whether the bed is an ED doorway or isolation-ward bed,
 * this module:
 *
 *   1. Determines the required cleaning level (standard / terminal /
 *      isolation / deep_clean).
 *   2. Predicts expected turnover minutes.
 *   3. Computes a cleaning priority score + band (low / moderate / high /
 *      critical) and a short list of recommended actions.
 *
 * Rules are authoritative. This service never reassigns housekeeping staff,
 * never marks a bed ready, and never updates room status on its own. Every
 * output is reviewed by the charge nurse / bed manager / housekeeping
 * supervisor before action.
 *
 * Graceful degradation: if the bed/ward/admission schema is missing, the
 * service falls back to the parameters provided by the caller. If no usable
 * inputs are supplied, the cleaning level is marked `unknown` and a
 * conservative turnover default is returned.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'housekeeping_bed_turnover';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support bed-manager / housekeeping-supervisor / charge-nurse review of post-discharge bed turnover. Rules are authoritative. Return JSON only and never reassign housekeeping staff, never mark a bed ready, and never update room status.',
  user_prompt_template:
    'Given the bed turnover context and the rule-based cleaning level + predicted turnover minutes + priority score, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

const CLEANING_LEVELS = new Set(['standard', 'terminal', 'isolation', 'deep_clean', 'unknown']);
const PRIORITY_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const BED_DEMAND = new Set(['low', 'normal', 'high', 'critical']);
const STAFFING_LOADS = new Set(['low', 'normal', 'high']);
const CURRENT_STATUSES = new Set([
  'occupied', 'discharged_pending_clean', 'cleaning', 'ready', 'blocked', 'unknown',
]);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);

// Base turnover minutes by cleaning level (before staffing + bathroom adjustments).
const BASE_TURNOVER_MINUTES = {
  standard: 25,
  terminal: 55,
  isolation: 75,
  deep_clean: 90,
};
const UNKNOWN_TURNOVER_DEFAULT_MINUTES = 45;
const PRIVATE_BATHROOM_ADDER_MINUTES = 10;

const REVIEW_DISCLAIMER =
  'Decision-support only — confirm with charge nurse before reassignment.';

// ---------- Small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
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

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeBedDemand(value) {
  const v = normalizedText(value);
  return BED_DEMAND.has(v) ? v : 'normal';
}

function normalizeStaffingLoad(value) {
  const v = normalizedText(value);
  return STAFFING_LOADS.has(v) ? v : 'normal';
}

function normalizeCurrentStatus(value) {
  const v = normalizedText(value);
  return CURRENT_STATUSES.has(v) ? v : 'unknown';
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function minutesSince(dateLike) {
  const d = toDate(dateLike);
  if (!d) return null;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 0;
  return diffMs / (60 * 1000);
}

// ---------- Pure helpers (exported) --------------------------------------

const ISOLATION_KEYWORDS = [
  /\bmrsa\b/i,
  /\bmethicillin[-\s]*resistant\b/i,
  /\bc\.?\s*diff(icile)?\b/i,
  /\bclostridium\s+difficile\b/i,
  /\btb\b/i,
  /\btuberculosis\b/i,
  /\bcovid\b/i,
  /\bsars[-\s]*cov[-\s]*2\b/i,
  /\bisolation\b/i,
  /\bcontact\s+precaution/i,
  /\bdroplet\s+precaution/i,
  /\bairborne\s+precaution/i,
  /\bvre\b/i, // vancomycin-resistant enterococci — often isolated too
];

const DEEP_CLEAN_KEYWORDS = [
  /\bc\.?\s*diff(icile)?\b/i,
  /\bclostridium\s+difficile\b/i,
];

const HIGH_RISK_TERMINAL_KEYWORDS = [
  /\bopen\s+wound\b/i,
  /\bpost[-\s]*op\b/i,
  /\bpost[-\s]*surgical\b/i,
  /\bpost[-\s]*procedure\b/i,
];

function anyMatch(patterns, items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  for (const item of items) {
    const text = String(item || '');
    if (!text) continue;
    for (const re of patterns) {
      if (re.test(text)) return true;
    }
  }
  return false;
}

/**
 * Determine the cleaning level required for this bed turnover.
 *
 * Priority order:
 *   - deep_clean  -> explicit C. diff / clostridium difficile in diagnoses
 *   - isolation   -> MRSA, C. diff (non-explicit), TB, COVID, or explicit
 *                    isolation precaution in inputs
 *   - terminal    -> post-surgical admission, or an explicit high-risk
 *                    condition that warrants terminal cleaning
 *   - standard    -> default when inputs are present but none of the above
 *   - unknown     -> no inputs supplied at all
 *
 * mrsaStatus: string / boolean — 'positive' / true forces isolation.
 */
export function determineCleaningLevel({
  priorDiagnoses = [],
  isolationPrecautions = [],
  hadSurgicalProcedure = false,
  mrsaStatus = null,
} = {}) {
  const diagnoses = asArray(priorDiagnoses);
  const precautions = asArray(isolationPrecautions);
  const mrsa = mrsaStatus === true
    || (typeof mrsaStatus === 'string' && /positive|detected|present/i.test(mrsaStatus));

  const hasAnyInput = diagnoses.length > 0
    || precautions.length > 0
    || hadSurgicalProcedure === true
    || mrsa
    || (typeof mrsaStatus === 'string' && mrsaStatus.length > 0);

  if (!hasAnyInput) return 'unknown';

  // Deep clean wins over isolation when C. diff is explicitly named in diagnoses.
  if (anyMatch(DEEP_CLEAN_KEYWORDS, diagnoses)) {
    return 'deep_clean';
  }

  // Isolation: MRSA status / isolation keywords in either list.
  if (mrsa) return 'isolation';
  if (anyMatch(ISOLATION_KEYWORDS, diagnoses)) return 'isolation';
  if (anyMatch(ISOLATION_KEYWORDS, precautions)) return 'isolation';

  // Terminal: surgical procedure or explicit post-procedure markers.
  if (hadSurgicalProcedure === true) return 'terminal';
  if (anyMatch(HIGH_RISK_TERMINAL_KEYWORDS, diagnoses)) return 'terminal';

  return 'standard';
}

/**
 * Estimate turnover minutes for the given cleaning level, staffing load,
 * and bed geometry (private bathroom adds area to clean).
 *
 * Returns an integer number of minutes.
 *   - Base by level: standard 25, terminal 55, isolation 75, deep_clean 90
 *   - staffingLoad='high' → base * 1.2 (fewer staff available → slower)
 *   - staffingLoad='low'  → base * 0.9 (more staff available → faster)
 *   - hasPrivateBathroom   → +10 min (larger physical area)
 *   - Unknown level        → conservative 45 min default.
 */
export function estimateTurnoverMinutes({
  cleaningLevel,
  staffingLoad = 'normal',
  hasPrivateBathroom = true,
} = {}) {
  const level = CLEANING_LEVELS.has(cleaningLevel) ? cleaningLevel : 'unknown';
  if (level === 'unknown') return UNKNOWN_TURNOVER_DEFAULT_MINUTES;

  const base = BASE_TURNOVER_MINUTES[level] || UNKNOWN_TURNOVER_DEFAULT_MINUTES;
  const load = normalizeStaffingLoad(staffingLoad);
  let multiplier = 1;
  if (load === 'high') multiplier = 1.2;
  else if (load === 'low') multiplier = 0.9;

  let minutes = base * multiplier;
  if (hasPrivateBathroom === true) minutes += PRIVATE_BATHROOM_ADDER_MINUTES;

  return Math.max(0, Math.round(minutes));
}

/**
 * Compute a cleaning priority score + band + contributing signals and
 * reviewer-facing recommended actions.
 *
 * Factors:
 *   - bedDemand 'critical' → +40, 'high' → +20
 *   - discharge older than 60 min → +15
 *   - cleaningLevel isolation / deep_clean → +10 (urgent turn)
 *   - isEdDoorway → +15 (near ED, high throughput)
 *   - isIsolationWard → +5
 *
 * Band: >=75 critical, >=50 high, >=25 moderate, else low.
 *
 * recommended_actions always ends with the review-only disclaimer.
 */
export function computePriorityScore({
  bedDemand = 'normal',
  discharge = null,
  cleaningLevel = 'standard',
  isEdDoorway = false,
  isIsolationWard = false,
} = {}) {
  const demand = normalizeBedDemand(bedDemand);
  const level = CLEANING_LEVELS.has(cleaningLevel) ? cleaningLevel : 'standard';
  const minsSinceDischarge = minutesSince(discharge);

  let score = 0;
  const contributing_signals = [];

  if (demand === 'critical') {
    score += 40;
    contributing_signals.push({
      code: 'BED_DEMAND_CRITICAL',
      severity: 'critical',
      description: 'Downstream bed demand is critical (ED boarding / OR queue saturated).',
    });
  } else if (demand === 'high') {
    score += 20;
    contributing_signals.push({
      code: 'BED_DEMAND_HIGH',
      severity: 'high',
      description: 'Downstream bed demand is high (ED boarding or OR queue elevated).',
    });
  }

  if (minsSinceDischarge !== null && minsSinceDischarge > 60) {
    score += 15;
    contributing_signals.push({
      code: 'DISCHARGE_WAIT_LONG',
      severity: 'medium',
      description: `Bed has been awaiting cleaning for ${Math.round(minsSinceDischarge)} minutes since discharge.`,
    });
  }

  if (level === 'isolation' || level === 'deep_clean') {
    score += 10;
    contributing_signals.push({
      code: 'URGENT_CLEANING_LEVEL',
      severity: 'medium',
      description: `Cleaning level ${level} requires priority scheduling due to infection-control risk.`,
    });
  }

  if (isEdDoorway === true) {
    score += 15;
    contributing_signals.push({
      code: 'ED_DOORWAY_BED',
      severity: 'high',
      description: 'Bed feeds the ED doorway — high-throughput position.',
    });
  }

  if (isIsolationWard === true) {
    score += 5;
    contributing_signals.push({
      code: 'ISOLATION_WARD',
      severity: 'low',
      description: 'Bed is in an isolation ward; coordinate PPE + airflow checks.',
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let priority_band = 'low';
  if (score >= 75) priority_band = 'critical';
  else if (score >= 50) priority_band = 'high';
  else if (score >= 25) priority_band = 'moderate';

  const recommended_actions = [];
  if (priority_band === 'critical') {
    recommended_actions.push('Dispatch housekeeping now; notify bed manager and charge nurse of critical turnover priority.');
  } else if (priority_band === 'high') {
    recommended_actions.push('Queue housekeeping ahead of lower-priority turns; notify bed manager.');
  } else if (priority_band === 'moderate') {
    recommended_actions.push('Standard housekeeping queue; confirm staffing matches predicted minutes.');
  } else {
    recommended_actions.push('Routine turnover; no escalation required.');
  }

  if (level === 'isolation' || level === 'deep_clean') {
    recommended_actions.push('Stage isolation PPE and EPA-registered disinfectant cart before entering the room.');
  }
  if (level === 'deep_clean') {
    recommended_actions.push('Use bleach-based disinfectant for C. diff turnover; follow contact time on product label.');
  }
  if (isEdDoorway === true) {
    recommended_actions.push('Coordinate with ED charge nurse to pull the next boarding patient once turnover is complete.');
  }
  // Always-on review disclaimer (last).
  recommended_actions.push(REVIEW_DISCLAIMER);

  return {
    priority_score: score,
    priority_band,
    contributing_signals,
    recommended_actions,
  };
}

/**
 * Facade that composes determineCleaningLevel → estimateTurnoverMinutes →
 * computePriorityScore and returns a flat payload.
 */
export function classifyTurnoverPriority(turnoverRequest = {}) {
  const cleaning_level = determineCleaningLevel({
    priorDiagnoses: turnoverRequest.priorDiagnoses,
    isolationPrecautions: turnoverRequest.isolationPrecautions,
    hadSurgicalProcedure: turnoverRequest.hadSurgicalProcedure,
    mrsaStatus: turnoverRequest.mrsaStatus,
  });

  const predicted_minutes = estimateTurnoverMinutes({
    cleaningLevel: cleaning_level,
    staffingLoad: turnoverRequest.staffingLoad,
    hasPrivateBathroom: turnoverRequest.hasPrivateBathroom,
  });

  const {
    priority_score,
    priority_band,
    contributing_signals,
    recommended_actions,
  } = computePriorityScore({
    bedDemand: turnoverRequest.bedDemand,
    discharge: turnoverRequest.discharge,
    cleaningLevel: cleaning_level,
    isEdDoorway: turnoverRequest.isEdDoorway,
    isIsolationWard: turnoverRequest.isIsolationWard,
  });

  return {
    cleaning_level,
    predicted_minutes,
    priority_score,
    priority_band,
    contributing_signals,
    recommended_actions,
  };
}

// ---------- DB loaders --------------------------------------------------

async function loadPreviousAdmission(admissionId) {
  if (!admissionId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, ward, bed_id, bed_number,
              admitting_diagnosis, discharge_diagnosis, allergies,
              admission_type, status, admitted_at, discharged_at
       FROM admissions
       WHERE id = $1
       LIMIT 1`,
      admissionId
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.debug('Housekeeping bed turnover: admission load failed', { error: err.message });
    return null;
  }
}

async function loadBedInfo(bedId) {
  if (!bedId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT b.id, b.bed_number, b.status, b.ward_id,
              w.name AS ward_name
       FROM beds b
       LEFT JOIN wards w ON w.id = b.ward_id
       WHERE b.id = $1
       LIMIT 1`,
      bedId
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.debug('Housekeeping bed turnover: bed load failed', { error: err.message });
    return null;
  }
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
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  admissionId = null,
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
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
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
      logger.warn('Housekeeping bed turnover generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, admissionId, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, $4, 'pending', $5::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      admissionId,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles
          || ['ADMIN', 'HOUSEKEEPING_STAFF', 'BED_MANAGER', 'DEPARTMENT_HEAD'],
        source: 'housekeeping_bed_turnover',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Housekeeping bed turnover review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizePredictionRow(row) {
  if (!row) return row;
  return {
    ...row,
    bed_id: row.bed_id !== null && row.bed_id !== undefined ? toNumber(row.bed_id, null) : null,
    previous_admission_id: row.previous_admission_id !== null && row.previous_admission_id !== undefined
      ? toNumber(row.previous_admission_id, null)
      : null,
    predicted_turnover_minutes: toNumber(row.predicted_turnover_minutes, 0),
    priority_score: toNumber(row.priority_score, 0),
  };
}

async function insertBedTurnoverPrediction({
  tenantId,
  bedId,
  ward,
  roomNumber,
  previousAdmissionId,
  dischargeTime,
  currentStatus,
  cleaningLevel,
  predictedMinutes,
  priorityScore,
  priorityBand,
  contributingSignals,
  recommendedActions,
  generationId,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_bed_turnover_predictions
         (tenant_id, bed_id, ward, room_number, previous_admission_id,
          discharge_time, current_status, required_cleaning_level,
          predicted_turnover_minutes, priority_score, priority_band,
          contributing_signals, recommended_actions, generation_id,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5,
               $6::timestamptz, $7, $8,
               $9, $10, $11,
               $12::jsonb, $13::jsonb, $14,
               $15::jsonb, $16::jsonb, 'pending', $17::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, bed_id, ward, room_number, previous_admission_id,
                 discharge_time, current_status, required_cleaning_level,
                 predicted_turnover_minutes, priority_score, priority_band,
                 contributing_signals, recommended_actions, generation_id,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      bedId,
      ward,
      roomNumber,
      previousAdmissionId,
      dischargeTime ? new Date(dischargeTime).toISOString() : null,
      CURRENT_STATUSES.has(currentStatus) ? currentStatus : 'unknown',
      CLEANING_LEVELS.has(cleaningLevel) ? cleaningLevel : 'unknown',
      predictedMinutes,
      priorityScore,
      PRIORITY_BANDS.has(priorityBand) ? priorityBand : 'unknown',
      JSON.stringify(contributingSignals || []),
      JSON.stringify(recommendedActions || []),
      generationId,
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizePredictionRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateBedTurnover({
  req = null,
  bedId = null,
  ward = null,
  roomNumber = null,
  previousAdmissionId = null,
  currentStatus = 'discharged_pending_clean',
  priorDiagnoses = [],
  isolationPrecautions = [],
  hadSurgicalProcedure = false,
  mrsaStatus = null,
  dischargeTime = null,
  bedDemand = 'normal',
  staffingLoad = 'normal',
  hasPrivateBathroom = true,
  isEdDoorway = false,
  isIsolationWard = false,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const safeBedId = bedId !== null && bedId !== undefined && bedId !== ''
    ? toNullableInt(bedId)
    : null;
  const safePrevAdmissionId = previousAdmissionId !== null
    && previousAdmissionId !== undefined
    && previousAdmissionId !== ''
    ? optionalInt(previousAdmissionId, 'previous_admission_id')
    : null;
  const safeWard = ward ? cleanText(ward) : null;
  const safeRoomNumber = roomNumber ? cleanText(roomNumber) : null;
  const safeCurrentStatus = normalizeCurrentStatus(currentStatus);

  // 1. Hydrate from previous admission if provided (diagnoses + allergies).
  let mergedDiagnoses = asArray(priorDiagnoses).map((d) => cleanText(d)).filter(Boolean);
  let mergedPrecautions = asArray(isolationPrecautions).map((d) => cleanText(d)).filter(Boolean);
  let resolvedWard = safeWard;
  let resolvedDischargeTime = dischargeTime || null;
  let patientUid = null;

  if (safePrevAdmissionId) {
    const admission = await loadPreviousAdmission(safePrevAdmissionId);
    if (admission) {
      patientUid = admission.patient_uid || null;
      if (!resolvedWard && admission.ward) resolvedWard = cleanText(admission.ward);
      if (!resolvedDischargeTime && admission.discharged_at) {
        resolvedDischargeTime = admission.discharged_at;
      }
      if (admission.admitting_diagnosis) mergedDiagnoses.push(cleanText(admission.admitting_diagnosis));
      if (admission.discharge_diagnosis) mergedDiagnoses.push(cleanText(admission.discharge_diagnosis));
      if (Array.isArray(admission.allergies)) {
        for (const a of admission.allergies) {
          const t = cleanText(a);
          if (t) mergedDiagnoses.push(t);
        }
      }
    }
  }

  // Best-effort bed metadata (ward, room if known)
  let bedInfo = null;
  if (safeBedId) {
    bedInfo = await loadBedInfo(safeBedId);
    if (bedInfo && !resolvedWard && bedInfo.ward_name) resolvedWard = cleanText(bedInfo.ward_name);
  }

  // Deduplicate diagnosis/precaution text to avoid double-weighting.
  mergedDiagnoses = Array.from(new Set(mergedDiagnoses));
  mergedPrecautions = Array.from(new Set(mergedPrecautions));

  // 2. Classify (pure compute).
  const classification = classifyTurnoverPriority({
    priorDiagnoses: mergedDiagnoses,
    isolationPrecautions: mergedPrecautions,
    hadSurgicalProcedure,
    mrsaStatus,
    staffingLoad,
    hasPrivateBathroom,
    bedDemand,
    discharge: resolvedDischargeTime,
    isEdDoorway,
    isIsolationWard,
  });

  // 3. Citations.
  const citations = [];
  if (safeBedId) {
    citations.push({
      source_type: 'bed',
      source_id: String(safeBedId),
      label: `Bed #${safeBedId}${bedInfo?.bed_number ? ` (${bedInfo.bed_number})` : ''}`,
      timestamp: null,
    });
  }
  if (safePrevAdmissionId) {
    citations.push({
      source_type: 'admission',
      source_id: String(safePrevAdmissionId),
      label: `Previous admission #${safePrevAdmissionId}`,
      timestamp: resolvedDischargeTime || null,
    });
  }
  const finalCitations = uniqueCitations(citations);

  // 4. Safety flags.
  const safetyFlags = [];
  if (classification.priority_band === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'TURNOVER_CRITICAL',
      message: 'Critical cleaning priority; notify bed manager + charge nurse and dispatch housekeeping immediately.',
    });
  }
  if (classification.cleaning_level === 'isolation') {
    safetyFlags.push({
      severity: 'medium',
      code: 'ISOLATION_TURNOVER',
      message: 'Isolation-level turnover; use full PPE and EPA-registered disinfectant per protocol.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'BED_TURNOVER_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — never auto-assigns housekeeping, never marks beds ready.',
  });

  // 5. Fallback draft.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    bed_id: safeBedId,
    ward: resolvedWard,
    room_number: safeRoomNumber,
    previous_admission_id: safePrevAdmissionId,
    discharge_time: resolvedDischargeTime || null,
    current_status: safeCurrentStatus,
    required_cleaning_level: classification.cleaning_level,
    predicted_turnover_minutes: classification.predicted_minutes,
    priority_score: classification.priority_score,
    priority_band: classification.priority_band,
    contributing_signals: classification.contributing_signals,
    recommended_actions: classification.recommended_actions,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    summary: classification.cleaning_level === 'unknown'
      ? 'Insufficient bed turnover context — capture prior diagnoses / isolation precautions before repeating the forecast.'
      : `${classification.cleaning_level} turnover — ${classification.predicted_minutes} min predicted (${classification.priority_band} priority).`,
    rules_authoritative: true,
    decision_support_only: true,
  };

  // 6. Optional AI narrative.
  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        bed_context: {
          bed_id: safeBedId,
          ward: resolvedWard,
          room_number: safeRoomNumber,
          previous_admission_id: safePrevAdmissionId,
          discharge_time: resolvedDischargeTime,
          current_status: safeCurrentStatus,
          had_surgical_procedure: hadSurgicalProcedure === true,
          mrsa_status: mrsaStatus,
          prior_diagnoses: mergedDiagnoses,
          isolation_precautions: mergedPrecautions,
        },
        operations: {
          bed_demand: normalizeBedDemand(bedDemand),
          staffing_load: normalizeStaffingLoad(staffingLoad),
          has_private_bathroom: hasPrivateBathroom === true,
          is_ed_doorway: isEdDoorway === true,
          is_isolation_ward: isIsolationWard === true,
        },
        rule_based_evaluation: {
          cleaning_level: classification.cleaning_level,
          predicted_turnover_minutes: classification.predicted_minutes,
          priority_score: classification.priority_score,
          priority_band: classification.priority_band,
          contributing_signals: classification.contributing_signals,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
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
        // Never let the AI override the rule-based numeric / categorical fields.
      };
    }
  } catch (err) {
    logger.debug('Bed turnover AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  draft.source_citations = uniqueCitations(asArray(draft.source_citations));
  draft.safety_flags = safetyFlags;

  // 7. Persist.
  const generation = await insertGeneration({
    tenantId,
    admissionId: safePrevAdmissionId,
    patientUid,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      bed_id: safeBedId,
      previous_admission_id: safePrevAdmissionId,
      ward: resolvedWard,
      room_number: safeRoomNumber,
      cleaning_level: classification.cleaning_level,
      priority_band: classification.priority_band,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      bed_id: safeBedId,
      previous_admission_id: safePrevAdmissionId,
      ward: resolvedWard,
      cleaning_level: classification.cleaning_level,
      priority_band: classification.priority_band,
      predicted_turnover_minutes: classification.predicted_minutes,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const predictionRow = await insertBedTurnoverPrediction({
    tenantId,
    bedId: safeBedId,
    ward: resolvedWard,
    roomNumber: safeRoomNumber,
    previousAdmissionId: safePrevAdmissionId,
    dischargeTime: resolvedDischargeTime,
    currentStatus: safeCurrentStatus,
    cleaningLevel: classification.cleaning_level,
    predictedMinutes: classification.predicted_minutes,
    priorityScore: classification.priority_score,
    priorityBand: classification.priority_band,
    contributingSignals: classification.contributing_signals,
    recommendedActions: classification.recommended_actions,
    generationId: generation?.id || null,
    citations: draft.source_citations,
    safetyFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      bed_demand: normalizeBedDemand(bedDemand),
      staffing_load: normalizeStaffingLoad(staffingLoad),
      has_private_bathroom: hasPrivateBathroom === true,
      is_ed_doorway: isEdDoorway === true,
      is_isolation_ward: isIsolationWard === true,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  if (!predictionRow) {
    return {
      prediction_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: safetyFlags,
      cleaning_level: classification.cleaning_level,
      predicted_turnover_minutes: classification.predicted_minutes,
      priority_score: classification.priority_score,
      priority_band: classification.priority_band,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_bed_turnover_predictions_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safePrevAdmissionId,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.bed_turnover_predicted',
      aggregateType: 'clinical_ai_bed_turnover_prediction',
      aggregateId: predictionRow.id,
      patientUid,
      payload: {
        tenant_id: tenantId,
        prediction_id: predictionRow.id,
        generation_id: generation?.id || null,
        bed_id: safeBedId,
        previous_admission_id: safePrevAdmissionId,
        ward: resolvedWard,
        cleaning_level: classification.cleaning_level,
        predicted_turnover_minutes: classification.predicted_minutes,
        priority_score: classification.priority_score,
        priority_band: classification.priority_band,
      },
    });
  } catch (err) {
    logger.warn('Bed turnover event publish failed', { error: err?.message });
  }

  return {
    prediction_id: predictionRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    prediction: predictionRow,
    source_citations: draft.source_citations,
    safety_flags: safetyFlags,
    cleaning_level: classification.cleaning_level,
    predicted_turnover_minutes: classification.predicted_minutes,
    priority_score: classification.priority_score,
    priority_band: classification.priority_band,
    contributing_signals: classification.contributing_signals,
    recommended_actions: classification.recommended_actions,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || predictionRow.reviewer_decision || 'pending',
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

export async function listBedTurnoverPredictions({
  tenantId = null,
  ward = null,
  bedId = null,
  priorityBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedWard = ward ? cleanText(ward) : null;
  const normalizedBedId = bedId !== null && bedId !== undefined && bedId !== ''
    ? toNullableInt(bedId)
    : null;
  const normalizedBand = priorityBand && PRIORITY_BANDS.has(cleanText(priorityBand).toLowerCase())
    ? cleanText(priorityBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.tenant_id, p.bed_id, p.ward, p.room_number,
              p.previous_admission_id, p.discharge_time, p.current_status,
              p.required_cleaning_level, p.predicted_turnover_minutes,
              p.priority_score, p.priority_band, p.contributing_signals,
              p.recommended_actions, p.generation_id, p.source_citations,
              p.safety_flags, p.reviewer_decision, p.reviewed_by,
              p.reviewed_at, p.reviewer_note, p.metadata,
              p.created_at, p.updated_at
       FROM clinical_ai_bed_turnover_predictions p
       WHERE p.tenant_id = $1::uuid
         AND ($2::text IS NULL OR p.ward = $2)
         AND ($3::int IS NULL OR p.bed_id = $3)
         AND ($4::text IS NULL OR p.priority_band = $4)
         AND ($5::text IS NULL OR p.reviewer_decision = $5)
       ORDER BY
         CASE p.priority_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         p.created_at DESC
       LIMIT $6`,
      tid,
      normalizedWard,
      normalizedBedId,
      normalizedBand,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizePredictionRow);
    return { predictions: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { predictions: [], count: 0 };
    throw err;
  }
}

export async function decideBedTurnoverPrediction({
  tenantId = null,
  predictionId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or escalated');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_bed_turnover_predictions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, bed_id, ward, room_number, previous_admission_id,
               discharge_time, current_status, required_cleaning_level,
               predicted_turnover_minutes, priority_score, priority_band,
               contributing_signals, recommended_actions, generation_id,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(predictionId, 'prediction_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Bed turnover prediction not found');
  return normalizePredictionRow(rows[0]);
}

export default {
  classifyTurnoverPriority,
  computePriorityScore,
  decideBedTurnoverPrediction,
  determineCleaningLevel,
  estimateTurnoverMinutes,
  evaluateBedTurnover,
  listBedTurnoverPredictions,
};
