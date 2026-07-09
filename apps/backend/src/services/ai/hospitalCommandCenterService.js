/**
 * Hospital Command Center AI.
 *
 * Cross-department operational command center. Takes a snapshot of six
 * departments and classifies each to a tier (normal / watch / elevated /
 * crisis / unknown), then rolls up to a hospital-wide command_status.
 *
 *   - beds          (occupancy %, discharge-ready wait, admission queue)
 *   - ED            (wait minutes, boarding count, LWBS %)
 *   - OR/theatre    (utilization %, overrun count, add-on pressure)
 *   - housekeeping  (pending turnovers, avg turnover time)
 *   - radiology     (pending studies, stat wait minutes)
 *   - pharmacy      (dispense backlog minutes, critical meds late)
 *
 * Rules are authoritative. Review-only — the duty officer reviews every
 * snapshot; the module never auto-triggers ED diversion, staffing
 * changes, inter-facility transfer, or any OR/bed reassignment.
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

const MODULE_KEY = 'hospital_command_center';
const CENSUS_LOS_SETTINGS_KEY = 'nl8_census_los';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the hospital duty officer review of cross-department operational status. Rules are authoritative. Return JSON only and never auto-trigger diversion, staffing changes, or transfers.',
  user_prompt_template:
    'Given the six-department snapshot and the rule-based per-department tiers + rolled-up command_status, return short reasoning under keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

export const COMMAND_STATUSES = new Set(['normal', 'watch', 'elevated', 'crisis', 'unknown']);
export const STATUS_PRIORITY = ['unknown', 'normal', 'watch', 'elevated', 'crisis'];
export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Duty officer review required — decision support only; no automatic diversion, staffing change, or transfer.';
const CENSUS_LOS_REVIEW_DISCLAIMER =
  'Census/LOS forecast is decision support only; duty officer and bed-manager review remains required.';
const CENSUS_LOS_SOURCE_MODULES = Object.freeze(['bed_discharge_forecast', MODULE_KEY]);
const DEFAULT_CENSUS_LOS_SETTINGS = Object.freeze({
  governance_owner_role: 'BED_MANAGER',
  freshness_threshold_minutes: 120,
  hide_stale_forecasts: true,
  stale_forecasts_hidden_locked: true,
  decision_support_only: true,
  review_required: true,
});

// ---------- Small helpers ------------------------------------------------

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
  if (value && typeof value === 'object' && typeof value.toNumber === 'function') {
    try {
      const decimalNumber = value.toNumber();
      return Number.isFinite(decimalNumber) ? decimalNumber : fallback;
    } catch {
      return fallback;
    }
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
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

function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
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

function normalizeStatus(value) {
  const text = cleanText(value).toLowerCase();
  return COMMAND_STATUSES.has(text) ? text : 'unknown';
}

function normalizeDateIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeCensusLosSettings(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    governance_owner_role:
      cleanText(value.governance_owner_role) || DEFAULT_CENSUS_LOS_SETTINGS.governance_owner_role,
    freshness_threshold_minutes: clampInt(value.freshness_threshold_minutes, {
      min: 15,
      max: 1440,
      fallback: DEFAULT_CENSUS_LOS_SETTINGS.freshness_threshold_minutes,
    }),
    hide_stale_forecasts: true,
    stale_forecasts_hidden_locked: true,
    decision_support_only: true,
    review_required: true,
  };
}

function normalizeBedForecastPayload(raw = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const patients = asArray(value.patients).map((patient) => ({
    admission_id: toNumber(patient?.admission_id, null),
    patient_uid: cleanText(patient?.patient_uid) || null,
    ward: cleanText(patient?.ward) || null,
    bed_number: cleanText(patient?.bed_number) || null,
    likely_discharge_24h: Boolean(patient?.likely_discharge_24h),
    likely_discharge_48h: Boolean(patient?.likely_discharge_48h),
    remaining_hours_estimate: toNumber(patient?.remaining_hours_estimate, null),
  }));
  return {
    ward: cleanText(value.ward) || 'all',
    forecast_window_hours: clampInt(value.forecast_window_hours, {
      min: 1,
      max: 168,
      fallback: 24,
    }),
    admitted_count: toNumber(value.admitted_count, patients.length),
    likely_discharges_24h: toNumber(
      value.likely_discharges_24h,
      patients.filter((item) => item.likely_discharge_24h).length
    ),
    likely_discharges_48h: toNumber(
      value.likely_discharges_48h,
      patients.filter((item) => item.likely_discharge_48h).length
    ),
    patients,
    generated_at: normalizeDateIso(value.generated_at),
  };
}

function confidenceBandForCensusLos({ visible, ageMinutes, thresholdMinutes }) {
  if (!visible) return 'hidden';
  if (!Number.isFinite(ageMinutes)) return 'unknown';
  if (ageMinutes <= Math.min(60, Math.max(15, thresholdMinutes / 2))) return 'high';
  return 'moderate';
}

export function buildCensusLosSignals(censusLos = {}) {
  if (!censusLos || typeof censusLos !== 'object') return [];
  if (censusLos.hidden_reason === 'stale_forecast') {
    return [{
      code: 'CENSUS_LOS_FORECAST_STALE',
      detail: `Census/LOS forecast hidden because it is ${censusLos.age_minutes ?? 'unknown'} min old; ${censusLos.governance_owner_role || 'BED_MANAGER'} owns review.`,
    }];
  }
  if (censusLos.hidden_reason === 'missing_forecast') {
    return [{
      code: 'CENSUS_LOS_FORECAST_MISSING',
      detail: `No current census/LOS forecast is available; ${censusLos.governance_owner_role || 'BED_MANAGER'} owns review.`,
    }];
  }
  const summary = censusLos.summary || {};
  const signals = [];
  if (toNumber(summary.likely_discharges_24h, 0) > 0) {
    signals.push({
      code: 'CENSUS_LOS_24H_DISCHARGES',
      detail: `${toNumber(summary.likely_discharges_24h, 0)} likely discharges in 24h from the latest bed forecast.`,
    });
  }
  if (toNumber(summary.likely_discharges_48h, 0) > toNumber(summary.likely_discharges_24h, 0)) {
    signals.push({
      code: 'CENSUS_LOS_48H_DISCHARGES',
      detail: `${toNumber(summary.likely_discharges_48h, 0)} likely discharges in 48h from the latest bed forecast.`,
    });
  }
  return signals;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Classify bed department status.
 *   occupancy >= 98 OR admission_queue >= 15 -> 'crisis'
 *   occupancy >= 92 OR admission_queue >= 10 -> 'elevated'
 *   discharge_ready_wait >= 180 OR occupancy >= 85 OR admission_queue >= 5 -> 'watch'
 *   else -> 'normal'
 */
export function classifyBedStatus({
  occupancyPct = null,
  dischargeReadyWaitMinutes = null,
  admissionQueueCount = null,
} = {}) {
  const occupancy = toNumber(occupancyPct, 0);
  const dischargeWait = toNumber(dischargeReadyWaitMinutes, 0);
  const queue = toNumber(admissionQueueCount, 0);

  let tier = 'normal';
  let score_delta = 0;
  const signals = [];

  if (occupancy >= 98 || queue >= 15) {
    tier = 'crisis';
    score_delta = 40;
    signals.push({
      code: 'BED_CRISIS',
      detail: `Beds at crisis: occupancy ${occupancy}%, admission queue ${queue}.`,
    });
  } else if (occupancy >= 92 || queue >= 10) {
    tier = 'elevated';
    score_delta = 25;
    signals.push({
      code: 'BED_ELEVATED',
      detail: `Bed pressure elevated: occupancy ${occupancy}%, admission queue ${queue}.`,
    });
  } else if (dischargeWait >= 180 || occupancy >= 85 || queue >= 5) {
    tier = 'watch';
    score_delta = 10;
    signals.push({
      code: 'BED_WATCH',
      detail: `Bed watch: occupancy ${occupancy}%, admission queue ${queue}, discharge-ready wait ${dischargeWait} min.`,
    });
  } else {
    tier = 'normal';
    score_delta = 0;
    signals.push({
      code: 'BED_NORMAL',
      detail: `Beds normal: occupancy ${occupancy}%, admission queue ${queue}.`,
    });
  }

  return { tier, score_delta, signals };
}

/**
 * Classify ED department status.
 *   wait >= 240 OR boarding >= 20 OR lwbs >= 5 -> 'crisis'
 *   wait >= 120 OR boarding >= 10 OR lwbs >= 3 -> 'elevated'
 *   wait >= 60  OR boarding >= 5  OR lwbs >= 1 -> 'watch'
 *   else -> 'normal'
 */
export function classifyEdStatus({
  waitMinutes = null,
  boardingCount = null,
  lwbsPct = null,
} = {}) {
  const wait = toNumber(waitMinutes, 0);
  const boarding = toNumber(boardingCount, 0);
  const lwbs = toNumber(lwbsPct, 0);

  let tier = 'normal';
  let score_delta = 0;
  const signals = [];

  if (wait >= 240 || boarding >= 20 || lwbs >= 5) {
    tier = 'crisis';
    score_delta = 40;
    signals.push({
      code: 'ED_CRISIS',
      detail: `ED at crisis: wait ${wait} min, boarding ${boarding}, LWBS ${lwbs}%.`,
    });
  } else if (wait >= 120 || boarding >= 10 || lwbs >= 3) {
    tier = 'elevated';
    score_delta = 25;
    signals.push({
      code: 'ED_ELEVATED',
      detail: `ED elevated: wait ${wait} min, boarding ${boarding}, LWBS ${lwbs}%.`,
    });
  } else if (wait >= 60 || boarding >= 5 || lwbs >= 1) {
    tier = 'watch';
    score_delta = 10;
    signals.push({
      code: 'ED_WATCH',
      detail: `ED watch: wait ${wait} min, boarding ${boarding}, LWBS ${lwbs}%.`,
    });
  } else {
    tier = 'normal';
    score_delta = 0;
    signals.push({
      code: 'ED_NORMAL',
      detail: `ED normal: wait ${wait} min, boarding ${boarding}, LWBS ${lwbs}%.`,
    });
  }

  return { tier, score_delta, signals };
}

/**
 * Classify OR/theatre department status.
 *   utilization >= 110 OR overrun >= 6 -> 'crisis'
 *   utilization >= 100 OR overrun >= 3 OR addonPressure === 'excessive' -> 'elevated'
 *   utilization >= 85 OR addonPressure === 'high' -> 'watch'
 *   else -> 'normal'
 */
export function classifyOrStatus({
  utilizationPct = null,
  overrunCount = null,
  addonPressure = null,
} = {}) {
  const utilization = toNumber(utilizationPct, 0);
  const overruns = toNumber(overrunCount, 0);
  const pressure = cleanText(addonPressure).toLowerCase();

  let tier = 'normal';
  let score_delta = 0;
  const signals = [];

  if (utilization >= 110 || overruns >= 6) {
    tier = 'crisis';
    score_delta = 30;
    signals.push({
      code: 'OR_CRISIS',
      detail: `OR at crisis: utilization ${utilization}%, overruns ${overruns}.`,
    });
  } else if (utilization >= 100 || overruns >= 3 || pressure === 'excessive') {
    tier = 'elevated';
    score_delta = 20;
    signals.push({
      code: 'OR_ELEVATED',
      detail: `OR elevated: utilization ${utilization}%, overruns ${overruns}, add-on pressure ${pressure || 'n/a'}.`,
    });
  } else if (utilization >= 85 || pressure === 'high') {
    tier = 'watch';
    score_delta = 10;
    signals.push({
      code: 'OR_WATCH',
      detail: `OR watch: utilization ${utilization}%, add-on pressure ${pressure || 'n/a'}.`,
    });
  } else {
    tier = 'normal';
    score_delta = 0;
    signals.push({
      code: 'OR_NORMAL',
      detail: `OR normal: utilization ${utilization}%, overruns ${overruns}.`,
    });
  }

  return { tier, score_delta, signals };
}

/**
 * Classify housekeeping department status.
 *   pending >= 15 OR avg >= 60 -> 'crisis'
 *   pending >= 10 OR avg >= 45 -> 'elevated'
 *   pending >= 5  OR avg >= 35 -> 'watch'
 *   else -> 'normal'
 */
export function classifyHousekeepingStatus({
  pendingTurnovers = null,
  avgTurnoverMinutes = null,
} = {}) {
  const pending = toNumber(pendingTurnovers, 0);
  const avg = toNumber(avgTurnoverMinutes, 0);

  let tier = 'normal';
  let score_delta = 0;
  const signals = [];

  if (pending >= 15 || avg >= 60) {
    tier = 'crisis';
    score_delta = 25;
    signals.push({
      code: 'HOUSEKEEPING_CRISIS',
      detail: `Housekeeping at crisis: ${pending} pending turnovers, avg ${avg} min.`,
    });
  } else if (pending >= 10 || avg >= 45) {
    tier = 'elevated';
    score_delta = 15;
    signals.push({
      code: 'HOUSEKEEPING_ELEVATED',
      detail: `Housekeeping elevated: ${pending} pending turnovers, avg ${avg} min.`,
    });
  } else if (pending >= 5 || avg >= 35) {
    tier = 'watch';
    score_delta = 8;
    signals.push({
      code: 'HOUSEKEEPING_WATCH',
      detail: `Housekeeping watch: ${pending} pending turnovers, avg ${avg} min.`,
    });
  } else {
    tier = 'normal';
    score_delta = 0;
    signals.push({
      code: 'HOUSEKEEPING_NORMAL',
      detail: `Housekeeping normal: ${pending} pending turnovers, avg ${avg} min.`,
    });
  }

  return { tier, score_delta, signals };
}

/**
 * Classify radiology department status.
 *   pending >= 40 OR stat_wait >= 60 -> 'crisis'
 *   pending >= 25 OR stat_wait >= 30 -> 'elevated'
 *   pending >= 15 OR stat_wait >= 15 -> 'watch'
 *   else -> 'normal'
 */
export function classifyRadiologyStatus({
  pendingStudies = null,
  statWaitMinutes = null,
} = {}) {
  const pending = toNumber(pendingStudies, 0);
  const statWait = toNumber(statWaitMinutes, 0);

  let tier = 'normal';
  let score_delta = 0;
  const signals = [];

  if (pending >= 40 || statWait >= 60) {
    tier = 'crisis';
    score_delta = 25;
    signals.push({
      code: 'RADIOLOGY_CRISIS',
      detail: `Radiology at crisis: ${pending} pending studies, stat wait ${statWait} min.`,
    });
  } else if (pending >= 25 || statWait >= 30) {
    tier = 'elevated';
    score_delta = 15;
    signals.push({
      code: 'RADIOLOGY_ELEVATED',
      detail: `Radiology elevated: ${pending} pending studies, stat wait ${statWait} min.`,
    });
  } else if (pending >= 15 || statWait >= 15) {
    tier = 'watch';
    score_delta = 8;
    signals.push({
      code: 'RADIOLOGY_WATCH',
      detail: `Radiology watch: ${pending} pending studies, stat wait ${statWait} min.`,
    });
  } else {
    tier = 'normal';
    score_delta = 0;
    signals.push({
      code: 'RADIOLOGY_NORMAL',
      detail: `Radiology normal: ${pending} pending studies, stat wait ${statWait} min.`,
    });
  }

  return { tier, score_delta, signals };
}

/**
 * Classify pharmacy department status.
 *   critical_meds_late >= 3 OR backlog >= 60 -> 'crisis'
 *   critical_meds_late >= 1 OR backlog >= 30 -> 'elevated'
 *   backlog >= 15 -> 'watch'
 *   else -> 'normal'
 */
export function classifyPharmacyStatus({
  dispenseBacklogMinutes = null,
  criticalMedsLate = null,
} = {}) {
  const backlog = toNumber(dispenseBacklogMinutes, 0);
  const criticalLate = toNumber(criticalMedsLate, 0);

  let tier = 'normal';
  let score_delta = 0;
  const signals = [];

  if (criticalLate >= 3 || backlog >= 60) {
    tier = 'crisis';
    score_delta = 30;
    signals.push({
      code: 'PHARMACY_CRISIS',
      detail: `Pharmacy at crisis: ${criticalLate} critical meds late, backlog ${backlog} min.`,
    });
  } else if (criticalLate >= 1 || backlog >= 30) {
    tier = 'elevated';
    score_delta = 20;
    signals.push({
      code: 'PHARMACY_ELEVATED',
      detail: `Pharmacy elevated: ${criticalLate} critical meds late, backlog ${backlog} min.`,
    });
  } else if (backlog >= 15) {
    tier = 'watch';
    score_delta = 10;
    signals.push({
      code: 'PHARMACY_WATCH',
      detail: `Pharmacy watch: backlog ${backlog} min.`,
    });
  } else {
    tier = 'normal';
    score_delta = 0;
    signals.push({
      code: 'PHARMACY_NORMAL',
      detail: `Pharmacy normal: backlog ${backlog} min, ${criticalLate} critical meds late.`,
    });
  }

  return { tier, score_delta, signals };
}

/**
 * Return the highest-priority command status from STATUS_PRIORITY.
 * Higher index = more severe.
 */
export function escalateCommandStatus(list) {
  const items = asArray(list);
  if (!items.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = STATUS_PRIORITY.indexOf('unknown');
  for (const entry of items) {
    const normalized = COMMAND_STATUSES.has(entry) ? entry : 'unknown';
    const idx = STATUS_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Roll up a list of per-department tier strings into the hospital-wide
 * command_status.
 *
 *   any tier === 'crisis'                                  -> 'crisis'
 *   any tier === 'elevated' OR 3+ tiers are 'watch'        -> 'elevated'
 *   any tier === 'watch'                                   -> 'watch'
 *   all 'normal'                                           -> 'normal'
 *   otherwise (unknowns with nothing else)                 -> 'unknown'
 */
export function rollupCommandStatus(perDeptTiers) {
  const tiers = asArray(perDeptTiers).map((t) => (COMMAND_STATUSES.has(t) ? t : 'unknown'));
  if (!tiers.length) return 'unknown';

  const crisisCount = tiers.filter((t) => t === 'crisis').length;
  const elevatedCount = tiers.filter((t) => t === 'elevated').length;
  const watchCount = tiers.filter((t) => t === 'watch').length;
  const normalCount = tiers.filter((t) => t === 'normal').length;

  if (crisisCount >= 1) return 'crisis';
  if (elevatedCount >= 1 || watchCount >= 3) return 'elevated';
  if (watchCount >= 1) return 'watch';
  if (normalCount === tiers.length) return 'normal';
  return 'unknown';
}

/**
 * Sum score_delta values across department results, rounded 2dp.
 */
export function computeOverallScore(perDeptResults) {
  const list = asArray(perDeptResults);
  if (!list.length) return 0;
  let total = 0;
  for (const entry of list) {
    total += toNumber(entry?.score_delta, 0);
  }
  return roundTo(total, 2);
}

/**
 * Run each department classifier over the supplied sub-objects and roll
 * up the result. Pure: no side effects, no DB.
 */
export function evaluateCommandCenter(inputs = {}) {
  const bed_status = classifyBedStatus(inputs.bed || {});
  const ed_status = classifyEdStatus(inputs.ed || {});
  const ot_status = classifyOrStatus(inputs.ot || {});
  const housekeeping_status = classifyHousekeepingStatus(inputs.housekeeping || {});
  const radiology_status = classifyRadiologyStatus(inputs.radiology || {});
  const pharmacy_status = classifyPharmacyStatus(inputs.pharmacy || {});

  const perDeptResults = [
    bed_status,
    ed_status,
    ot_status,
    housekeeping_status,
    radiology_status,
    pharmacy_status,
  ];

  const command_status = rollupCommandStatus(perDeptResults.map((r) => r.tier));
  const overall_score = computeOverallScore(perDeptResults);

  const department_status = {
    bed: bed_status,
    ed: ed_status,
    ot: ot_status,
    housekeeping: housekeeping_status,
    radiology: radiology_status,
    pharmacy: pharmacy_status,
  };

  const signals = [];
  for (const entry of perDeptResults) {
    for (const sig of asArray(entry?.signals)) {
      signals.push(sig);
    }
  }

  return {
    command_status,
    overall_score,
    department_status,
    signals,
  };
}

/**
 * Build a reviewer-facing action list. Always ends with the disclaimer.
 */
export function buildCommandActions({
  commandStatus = 'normal',
  departmentStatus = {},
  signals = [],
} = {}) {
  const status = normalizeStatus(commandStatus);
  const actions = [];
  const signalCodes = new Set(asArray(signals).map((signal) => signal?.code).filter(Boolean));

  switch (status) {
    case 'crisis':
      actions.push('Command status crisis — convene duty-officer bridge now; review surge and escalation protocols.');
      actions.push('Notify house supervisor, bed manager, ED charge nurse, and OR coordinator; align on shared priorities.');
      break;
    case 'elevated':
      actions.push('Command status elevated — hold a short operational huddle; reassess within 30-60 minutes.');
      actions.push('Notify house supervisor and department leads; surface blockers proactively.');
      break;
    case 'watch':
      actions.push('Command status watch — monitor trending signals; prepare contingency leads if any department escalates.');
      break;
    case 'normal':
      actions.push('Command status normal — continue routine operational monitoring.');
      break;
    default:
      actions.push('Command status unknown — confirm inputs across all departments before reviewing.');
      break;
  }

  const dept = departmentStatus && typeof departmentStatus === 'object' ? departmentStatus : {};
  const bedTier = normalizeStatus(dept.bed?.tier);
  const edTier = normalizeStatus(dept.ed?.tier);
  const otTier = normalizeStatus(dept.ot?.tier);
  const hkTier = normalizeStatus(dept.housekeeping?.tier);
  const radTier = normalizeStatus(dept.radiology?.tier);
  const pharmTier = normalizeStatus(dept.pharmacy?.tier);

  if (bedTier === 'crisis') {
    actions.push('Beds crisis — escalate to bed manager; expedite discharges and review transfer-in hold criteria.');
  } else if (bedTier === 'elevated') {
    actions.push('Beds elevated — accelerate discharge rounds and hold elective admissions where possible.');
  }

  if (edTier === 'crisis') {
    actions.push('ED crisis — notify ED leadership; review surge capacity and consider slowing non-urgent intake.');
  } else if (edTier === 'elevated') {
    actions.push('ED elevated — flag boarding volume to inpatient units and pull forward discharges.');
  }

  if (otTier === 'crisis') {
    actions.push('OR/theatre crisis — notify OR coordinator; review run-sheet and anaesthesia/nursing capacity.');
  } else if (otTier === 'elevated') {
    actions.push('OR/theatre elevated — reassess add-on queue and overrun drivers with the OR coordinator.');
  }

  if (hkTier === 'crisis') {
    actions.push('Housekeeping crisis — activate EVS escalation; redeploy turnover crews toward highest-impact beds.');
  } else if (hkTier === 'elevated') {
    actions.push('Housekeeping elevated — prioritise turnover on the highest-demand units.');
  }

  if (radTier === 'crisis') {
    actions.push('Radiology crisis — expedite stat reads; confirm tech staffing and modality availability.');
  } else if (radTier === 'elevated') {
    actions.push('Radiology elevated — triage the stat queue with radiology lead.');
  }

  if (pharmTier === 'crisis') {
    actions.push('Pharmacy crisis — escalate to pharmacy manager; prioritise critical-med dispenses ahead of routine backlog.');
  } else if (pharmTier === 'elevated') {
    actions.push('Pharmacy elevated — flag critical-med backlog and confirm runner/tube-system throughput.');
  }

  if (signalCodes.has('CENSUS_LOS_FORECAST_STALE')) {
    actions.push('Census/LOS forecast stale — keep predictive LOS tiles hidden and ask the governance owner to refresh before review.');
  } else if (signalCodes.has('CENSUS_LOS_FORECAST_MISSING')) {
    actions.push('Census/LOS forecast missing — generate the bed discharge forecast before relying on predictive patient-flow signals.');
  } else if (signalCodes.has('CENSUS_LOS_24H_DISCHARGES')) {
    actions.push('Census/LOS forecast active — review likely 24h discharges with bed management before taking operational action.');
  }

  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence summary for the reviewer / event payload.
 */
export function summarizeCommandCenter({
  commandStatus = 'normal',
  overallScore = 0,
  departmentStatus = {},
} = {}) {
  const status = normalizeStatus(commandStatus);
  const score = toNumber(overallScore, 0);
  const dept = departmentStatus && typeof departmentStatus === 'object' ? departmentStatus : {};
  const parts = [];
  for (const key of ['bed', 'ed', 'ot', 'housekeeping', 'radiology', 'pharmacy']) {
    const tier = normalizeStatus(dept[key]?.tier);
    if (tier === 'crisis' || tier === 'elevated' || tier === 'watch') {
      parts.push(`${key}=${tier}`);
    }
  }
  const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
  return `Hospital command status ${status} — overall score ${score}${breakdown}.`;
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

async function persistDefaultCensusLosSettings(tenantId, settings) {
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE tenants
       SET settings = jsonb_set(
             COALESCE(settings, '{}'::jsonb),
             '{nl8_census_los}',
             ($2::jsonb || COALESCE(settings->'nl8_census_los', '{}'::jsonb) || $3::jsonb),
             true
           ),
           updated_at = NOW()
       WHERE id = $1::uuid`,
      tenantId,
      JSON.stringify({
        governance_owner_role: settings.governance_owner_role,
        freshness_threshold_minutes: settings.freshness_threshold_minutes,
        decision_support_only: true,
        review_required: true,
        settings_version: 'nl8-p5-2026-07-07',
      }),
      JSON.stringify({
        hide_stale_forecasts: true,
        stale_forecasts_hidden_locked: true,
      })
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Census/LOS forecast settings default persist failed', { error: err.message });
    }
  }
}

async function getCensusLosSettings(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT settings->'nl8_census_los' AS census_los_settings,
              (settings ? 'nl8_census_los') AS has_census_los_settings
       FROM tenants
       WHERE id = $1::uuid
       LIMIT 1`,
      tenantId
    );
    const row = rows?.[0] || {};
    const settings = normalizeCensusLosSettings(row.census_los_settings || {});
    if (!row.has_census_los_settings) {
      await persistDefaultCensusLosSettings(tenantId, settings);
    }
    return settings;
  } catch (err) {
    if (isMissingSchemaError(err)) return normalizeCensusLosSettings();
    throw err;
  }
}

async function getLatestBedForecastRow(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, ward, forecast_window_hours, forecast, created_at
       FROM clinical_ai_bed_forecasts
       WHERE tenant_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
      tenantId
    );
    return rows?.[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function getCommandCenterCensusLosBridge({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const settings = await getCensusLosSettings(tid);
  const latest = await getLatestBedForecastRow(tid);
  const base = {
    settings_key: CENSUS_LOS_SETTINGS_KEY,
    source_modules: [...CENSUS_LOS_SOURCE_MODULES],
    governance_owner_role: settings.governance_owner_role,
    freshness_threshold_minutes: settings.freshness_threshold_minutes,
    hide_stale_forecasts: true,
    stale_forecasts_hidden_locked: true,
    decision_support_only: true,
    review_required: true,
  };
  if (!latest) {
    return {
      ...base,
      visible: false,
      hidden: true,
      hidden_reason: 'missing_forecast',
      latest_forecast_id: null,
      generated_at: null,
      stored_at: null,
      age_minutes: null,
      confidence_band: 'hidden',
      summary: null,
      patients: [],
      recommended_actions: [
        `Ask ${settings.governance_owner_role} to generate a fresh bed discharge forecast before reviewing census/LOS pressure.`,
        CENSUS_LOS_REVIEW_DISCLAIMER,
      ],
    };
  }

  const forecast = normalizeBedForecastPayload(latest.forecast || {});
  const storedAt = normalizeDateIso(latest.created_at);
  const generatedAt = forecast.generated_at || storedAt;
  const generatedTime = generatedAt ? new Date(generatedAt).getTime() : NaN;
  const ageMinutes = Number.isFinite(generatedTime)
    ? Math.max(0, Math.round((Date.now() - generatedTime) / 60_000))
    : null;
  const stale = ageMinutes === null || ageMinutes > settings.freshness_threshold_minutes;
  const hidden = stale && settings.hide_stale_forecasts;
  const summary = {
    ward: forecast.ward || latest.ward || 'all',
    forecast_window_hours: toNumber(
      forecast.forecast_window_hours,
      toNumber(latest.forecast_window_hours, 24)
    ),
    admitted_count: toNumber(forecast.admitted_count, 0),
    likely_discharges_24h: toNumber(forecast.likely_discharges_24h, 0),
    likely_discharges_48h: toNumber(forecast.likely_discharges_48h, 0),
  };

  return {
    ...base,
    visible: !hidden,
    hidden,
    hidden_reason: hidden ? 'stale_forecast' : null,
    latest_forecast_id: toNumber(latest.id, null),
    generated_at: generatedAt,
    stored_at: storedAt,
    age_minutes: ageMinutes,
    confidence_band: confidenceBandForCensusLos({
      visible: !hidden,
      ageMinutes: toNumber(ageMinutes, NaN),
      thresholdMinutes: settings.freshness_threshold_minutes,
    }),
    summary: hidden ? null : summary,
    patients: hidden ? [] : forecast.patients,
    recommended_actions: hidden
      ? [
        `Stale census/LOS forecast hidden after ${settings.freshness_threshold_minutes} min; ${settings.governance_owner_role} must refresh before review.`,
        CENSUS_LOS_REVIEW_DISCLAIMER,
      ]
      : [
        `Review ${summary.likely_discharges_24h} likely 24h discharges and ${summary.likely_discharges_48h} likely 48h discharges before acting.`,
        CENSUS_LOS_REVIEW_DISCLAIMER,
      ],
  };
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
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4,
               $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb,
               $12::uuid, $13, $14, $15, $16, $17::jsonb, NOW(), NOW())
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
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Hospital command center generation persist failed', { error: err.message });
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'HOUSE_SUPERVISOR', 'DOCTOR'],
        source: 'hospital_command_center',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        approval_policy: module?.settings?.approvalPolicy || 'duty_officer_review',
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Hospital command center review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeSnapshotRow(row) {
  if (!row) return row;
  return {
    ...row,
    overall_score: toNumber(row.overall_score, 0),
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
  };
}

async function insertCommandSnapshot({
  tenantId,
  generationId,
  commandStatus,
  overallScore,
  departmentStatus,
  signals,
  summary,
  recommendedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_command_center_snapshots
         (tenant_id, generation_id, command_status, overall_score,
          department_status, signals, summary, recommended_actions,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4,
               $5::jsonb, $6::jsonb, $7, $8::jsonb,
               $9::jsonb, $10::jsonb, 'pending', $11::jsonb,
               NOW(), NOW())
       RETURNING id, tenant_id, snapshot_at, generation_id, command_status,
                 overall_score, department_status, signals, summary,
                 recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      generationId,
      COMMAND_STATUSES.has(commandStatus) ? commandStatus : 'unknown',
      overallScore,
      JSON.stringify(departmentStatus || {}),
      JSON.stringify(signals || []),
      summary,
      JSON.stringify(recommendedActions || []),
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizeSnapshotRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API --------------------------------------------------

export async function evaluateCommandSnapshot({
  req = null,
  bed = {},
  ed = {},
  ot = {},
  housekeeping = {},
  radiology = {},
  pharmacy = {},
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const censusLos = await getCommandCenterCensusLosBridge({ tenantId });
  const evaluation = evaluateCommandCenter({ bed, ed, ot, housekeeping, radiology, pharmacy });
  const {
    command_status,
    overall_score,
    department_status,
    signals: ruleSignals,
  } = evaluation;
  const censusLosSignals = buildCensusLosSignals(censusLos);
  const signals = [
    ...asArray(ruleSignals),
    ...censusLosSignals,
  ];

  const recommendedActions = buildCommandActions({
    commandStatus: command_status,
    departmentStatus: department_status,
    signals,
  });

  const summary = summarizeCommandCenter({
    commandStatus: command_status,
    overallScore: overall_score,
    departmentStatus: department_status,
  });

  // Citations: per-department record types + command_center_rules.
  const citations = [
    {
      source_type: 'bed_occupancy',
      source_id: 'beds',
      label: 'Bed occupancy / admission queue snapshot',
      timestamp: null,
    },
    {
      source_type: 'bed_discharge_forecast',
      source_id: censusLos.latest_forecast_id ? String(censusLos.latest_forecast_id) : 'latest',
      label: 'Latest census/LOS bed discharge forecast',
      timestamp: censusLos.generated_at || censusLos.stored_at || null,
    },
    {
      source_type: 'ed_operations',
      source_id: 'ed',
      label: 'ED wait / boarding / LWBS snapshot',
      timestamp: null,
    },
    {
      source_type: 'or_operations',
      source_id: 'ot',
      label: 'OR/theatre utilization / overrun / add-on snapshot',
      timestamp: null,
    },
    {
      source_type: 'housekeeping',
      source_id: 'housekeeping',
      label: 'Housekeeping pending turnover snapshot',
      timestamp: null,
    },
    {
      source_type: 'radiology',
      source_id: 'radiology',
      label: 'Radiology pending / stat wait snapshot',
      timestamp: null,
    },
    {
      source_type: 'pharmacy',
      source_id: 'pharmacy',
      label: 'Pharmacy dispense backlog / critical meds snapshot',
      timestamp: null,
    },
    {
      source_type: 'command_center_rules',
      source_id: MODULE_KEY,
      label: 'Hospital command center classification rules',
      timestamp: null,
    },
  ];
  const uniqueCits = uniqueCitations(citations);

  // Safety flags.
  const safetyFlags = [];
  if (command_status === 'crisis') {
    safetyFlags.push({
      severity: 'critical',
      code: 'COMMAND_CRISIS',
      message: 'Hospital-wide command status crisis; duty officer must convene bridge immediately.',
    });
  }
  const deptKeyToFlag = {
    bed: 'BED_CRISIS',
    ed: 'ED_CRISIS',
    ot: 'OT_CRISIS',
    housekeeping: 'HOUSEKEEPING_CRISIS',
    radiology: 'RADIOLOGY_CRISIS',
    pharmacy: 'PHARMACY_CRISIS',
  };
  for (const [deptKey, flagCode] of Object.entries(deptKeyToFlag)) {
    const entry = department_status[deptKey];
    if (entry && entry.tier === 'crisis') {
      safetyFlags.push({
        severity: 'critical',
        code: flagCode,
        message: `Department at crisis: ${deptKey}. Duty officer review required.`,
      });
    }
  }
  if (!uniqueCits.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Hospital command center snapshot has no source citations.',
    });
  }
  if (censusLos.hidden_reason === 'stale_forecast') {
    safetyFlags.push({
      severity: 'medium',
      code: 'CENSUS_LOS_FORECAST_HIDDEN_STALE',
      message: 'Stale census/LOS forecast is hidden until the governance owner refreshes it.',
    });
  } else if (censusLos.hidden_reason === 'missing_forecast') {
    safetyFlags.push({
      severity: 'low',
      code: 'CENSUS_LOS_FORECAST_MISSING',
      message: 'No census/LOS forecast is available for command-center review.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'COMMAND_CENTER_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — never auto-triggers diversion, staffing changes, or transfers.',
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    command_status,
    overall_score,
    department_status,
    signals,
    summary,
    recommended_actions: recommendedActions,
    census_los: censusLos,
    source_citations: uniqueCits,
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
        snapshot_context: {
          bed,
          ed,
          ot,
          housekeeping,
          radiology,
          pharmacy,
          census_los: censusLos,
        },
        rule_based_evaluation: {
          command_status,
          overall_score,
          department_status,
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
        // Never let AI override rule-based command_status, department_status, or signals.
      };
    }
  } catch (err) {
    logger.debug('Hospital command center AI narrative unavailable; using rule summary fallback', {
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
        command_center: {
          command_status,
          overall_score,
        },
      },
      citations: uniqueCits,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      bed,
      ed,
      ot,
      housekeeping,
      radiology,
      pharmacy,
      census_los: {
        latest_forecast_id: censusLos.latest_forecast_id,
        generated_at: censusLos.generated_at,
        hidden_reason: censusLos.hidden_reason,
        summary: censusLos.summary,
      },
      command_status,
      overall_score,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      command_status,
      overall_score,
      census_los: {
        latest_forecast_id: censusLos.latest_forecast_id,
        generated_at: censusLos.generated_at,
        hidden_reason: censusLos.hidden_reason,
        summary: censusLos.summary,
      },
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const snapshotRow = await insertCommandSnapshot({
    tenantId,
    generationId: generation?.id || null,
    commandStatus: command_status,
    overallScore: overall_score,
    departmentStatus: department_status,
    signals,
    summary: draft.summary,
    recommendedActions,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      rules_authoritative: true,
      decision_support_only: true,
      census_los: {
        latest_forecast_id: censusLos.latest_forecast_id,
        generated_at: censusLos.generated_at,
        hidden_reason: censusLos.hidden_reason,
        summary: censusLos.summary,
      },
    },
  });

  if (!snapshotRow) {
    return {
      snapshot_id: null,
      generation_id: generation?.id || null,
      clinical_review_id: null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: combinedFlags,
      command_status,
      overall_score,
      department_status,
      signals,
      census_los: censusLos,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_command_center_snapshots_unavailable',
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

  try {
    await publishEvent({
      eventType: 'clinical_ai.command_center_evaluated',
      aggregateType: 'clinical_ai_command_center_snapshot',
      aggregateId: snapshotRow.id,
      payload: {
        tenant_id: tenantId,
        snapshot_id: snapshotRow.id,
        generation_id: generation?.id || null,
        command_status,
        overall_score,
        department_tiers: Object.fromEntries(
          Object.entries(department_status).map(([k, v]) => [k, v?.tier || 'unknown'])
        ),
        signal_codes: asArray(signals).map((s) => s?.code).filter(Boolean),
      },
    });
  } catch (err) {
    logger.warn('Hospital command center event publish failed', { error: err?.message });
  }

  return {
    snapshot_id: snapshotRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    snapshot: snapshotRow,
    command_status,
    overall_score,
    department_status,
    signals,
    census_los: censusLos,
    source_citations: draft.source_citations,
    safety_flags: combinedFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || snapshotRow.reviewer_decision || 'pending',
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

export async function listCommandSnapshots({
  tenantId = null,
  commandStatus = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedStatus = commandStatus
    && COMMAND_STATUSES.has(cleanText(commandStatus).toLowerCase())
    ? cleanText(commandStatus).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision
    && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.tenant_id, s.snapshot_at, s.generation_id, s.command_status,
              s.overall_score, s.department_status, s.signals, s.summary,
              s.recommended_actions, s.source_citations, s.safety_flags,
              s.reviewer_decision, s.reviewed_by, s.reviewed_at, s.reviewer_note,
              s.metadata, s.created_at, s.updated_at
       FROM clinical_ai_command_center_snapshots s
       WHERE s.tenant_id = $1::uuid
         AND ($2::text IS NULL OR s.command_status = $2)
         AND ($3::text IS NULL OR s.reviewer_decision = $3)
       ORDER BY
         CASE s.command_status
           WHEN 'crisis' THEN 0
           WHEN 'elevated' THEN 1
           WHEN 'watch' THEN 2
           WHEN 'normal' THEN 3
           ELSE 4
         END,
         s.snapshot_at DESC
       LIMIT $4`,
      tid,
      normalizedStatus,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeSnapshotRow);
    const censusLos = await getCommandCenterCensusLosBridge({ tenantId: tid });
    return { snapshots: normalized, count: normalized.length, census_los: censusLos };
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        snapshots: [],
        count: 0,
        census_los: await getCommandCenterCensusLosBridge({ tenantId: tid }),
      };
    }
    throw err;
  }
}

export async function decideCommandSnapshot({
  tenantId = null,
  snapshotId,
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
    `UPDATE clinical_ai_command_center_snapshots
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, snapshot_at, generation_id, command_status,
               overall_score, department_status, signals, summary,
               recommended_actions, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(snapshotId, 'snapshot_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Hospital command center snapshot not found');
  return normalizeSnapshotRow(rows[0]);
}

export default {
  classifyBedStatus,
  classifyEdStatus,
  classifyOrStatus,
  classifyHousekeepingStatus,
  classifyRadiologyStatus,
  classifyPharmacyStatus,
  escalateCommandStatus,
  rollupCommandStatus,
  computeOverallScore,
  evaluateCommandCenter,
  buildCommandActions,
  buildCensusLosSignals,
  summarizeCommandCenter,
  getCommandCenterCensusLosBridge,
  evaluateCommandSnapshot,
  listCommandSnapshots,
  decideCommandSnapshot,
};
