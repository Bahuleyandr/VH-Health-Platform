/**
 * Multimodal Patient Timeline.
 *
 * Unifies events from multiple sources (chart notes, imaging studies,
 * voice/ambient notes, claims/billing, patient messages, device telemetry,
 * documents, prescriptions, labs, vitals) into a single patient timeline
 * snapshot. Classifies each event by kind + clinical relevance band
 * (critical / high / moderate / low / informational), detects patient-
 * safety signals (red-flag vitals, critical labs, abnormal imaging,
 * missed meds, PHI leakage risk in messages), and orders events by
 * (time, relevance).
 *
 * Rules are authoritative. Review-only — the care team reviews the
 * rolled-up timeline, and the module never modifies the source events
 * or the chart.
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

const MODULE_KEY = 'multimodal_patient_timeline';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support the care team review of a multimodal patient timeline. Rules are authoritative. Return JSON only and never modify the source events or the chart.',
  user_prompt_template:
    'Given the unified timeline events and the rule-based per-event relevance bands + rolled-up overall_severity, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags. Do not override the rule-based classification or event ordering.',
};

export const EVENT_KINDS = new Set([
  'note',
  'imaging',
  'voice',
  'claim',
  'message',
  'telemetry',
  'document',
  'prescription',
  'lab',
  'vital',
  'other',
]);

export const RELEVANCE_BANDS = new Set([
  'critical',
  'high',
  'moderate',
  'low',
  'informational',
  'unknown',
]);

// Priority order: higher index = higher priority (escalate towards it).
export const RELEVANCE_PRIORITY = [
  'unknown',
  'informational',
  'low',
  'moderate',
  'high',
  'critical',
];

export const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
export const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);

const REVIEW_DISCLAIMER =
  'Clinician review required — decision support only; the module never modifies source events or the chart.';

// PHI-leak regex probes (applied to free-text message bodies).
// Note: 10-digit phone and 12-digit Aadhaar are Indian-context defaults.
// Hyphen is the LAST character inside the character class to avoid needing
// to escape it.
const PHI_PATTERNS = [
  /\b\d{10}\b/, // Indian-style 10-digit phone
  /\b\d{12}\b/, // Aadhaar
  /\bMRN[:\s0-9A-Z-]*\d{4,}\b/i, // MRN-prefixed identifier
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, // Email
];

const IMAGING_SIGNIFICANT_PATTERN =
  /(pulmonary embolism|intracranial hemorrhage|pneumothorax|perforation|mass|tumor|fracture)/i;

const MESSAGE_CONCERN_PATTERN =
  /(urgent|emergency|pain|worsening|bleeding|breathing)/i;

const PRESCRIPTION_CRITICAL_PATTERN =
  /(insulin|warfarin|heparin|chemotherapy)/i;

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

function toIsoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Lowercases and trims the event kind; returns a known kind or 'other'.
 */
export function normalizeEventKind(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return 'other';
  return EVENT_KINDS.has(text) ? text : 'other';
}

/**
 * Parse a Date or ISO string. Returns Date or null if invalid/missing.
 */
export function parseEventTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Classify a vital-sign event.
 *   spo2 < 85 OR hr > 180 OR hr < 35 OR sbp < 80 OR sbp > 220
 *     OR temp_c > 40 OR temp_c < 34                           -> critical
 *   spo2 < 92 OR hr > 140 OR sbp > 180 OR sbp < 90
 *     OR temp_c > 39                                          -> high
 *   spo2 < 95 OR hr > 110 OR temp_c > 38                      -> moderate
 *   else                                                       -> low
 * All fields are optional; nulls/undefined are ignored.
 */
export function classifyVitalEvent({ payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  const num = (v) => Number(v);

  const spo2 = has(p.spo2) ? num(p.spo2) : null;
  const hr = has(p.hr) ? num(p.hr) : null;
  const sbp = has(p.sbp) ? num(p.sbp) : null;
  const temp = has(p.temp_c) ? num(p.temp_c) : null;

  const breach = (cond) => cond === true;

  const critical =
    (spo2 !== null && breach(spo2 < 85)) ||
    (hr !== null && (breach(hr > 180) || breach(hr < 35))) ||
    (sbp !== null && (breach(sbp < 80) || breach(sbp > 220))) ||
    (temp !== null && (breach(temp > 40) || breach(temp < 34)));

  if (critical) {
    return {
      relevance: 'critical',
      signals: [
        {
          code: 'RED_FLAG_VITAL',
          detail: `Red-flag vital: spo2=${spo2 ?? 'n/a'}, hr=${hr ?? 'n/a'}, sbp=${sbp ?? 'n/a'}, temp_c=${temp ?? 'n/a'}.`,
        },
      ],
    };
  }

  const high =
    (spo2 !== null && breach(spo2 < 92)) ||
    (hr !== null && breach(hr > 140)) ||
    (sbp !== null && (breach(sbp > 180) || breach(sbp < 90))) ||
    (temp !== null && breach(temp > 39));

  if (high) {
    return {
      relevance: 'high',
      signals: [
        {
          code: 'ABNORMAL_VITAL',
          detail: `Abnormal vital: spo2=${spo2 ?? 'n/a'}, hr=${hr ?? 'n/a'}, sbp=${sbp ?? 'n/a'}, temp_c=${temp ?? 'n/a'}.`,
        },
      ],
    };
  }

  const moderate =
    (spo2 !== null && breach(spo2 < 95)) ||
    (hr !== null && breach(hr > 110)) ||
    (temp !== null && breach(temp > 38));

  if (moderate) {
    return {
      relevance: 'moderate',
      signals: [
        {
          code: 'WATCH_VITAL',
          detail: `Watch vital: spo2=${spo2 ?? 'n/a'}, hr=${hr ?? 'n/a'}, sbp=${sbp ?? 'n/a'}, temp_c=${temp ?? 'n/a'}.`,
        },
      ],
    };
  }

  return {
    relevance: 'low',
    signals: [
      {
        code: 'STABLE_VITAL',
        detail: `Stable vital: spo2=${spo2 ?? 'n/a'}, hr=${hr ?? 'n/a'}, sbp=${sbp ?? 'n/a'}, temp_c=${temp ?? 'n/a'}.`,
      },
    ],
  };
}

/**
 * Classify a lab event. abnormal_flag values:
 *   'critical_high' | 'critical_low' -> critical
 *   'high' | 'low'                   -> high
 *   'normal' | undefined             -> low
 *   anything else                    -> moderate
 */
export function classifyLabEvent({ payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const flag = cleanText(p.abnormal_flag).toLowerCase();
  const name = cleanText(p.name) || 'lab';

  if (flag === 'critical_high' || flag === 'critical_low') {
    return {
      relevance: 'critical',
      signals: [
        { code: 'CRITICAL_LAB', detail: `Critical lab result for ${name} (${flag}).` },
      ],
    };
  }
  if (flag === 'high' || flag === 'low') {
    return {
      relevance: 'high',
      signals: [
        { code: 'ABNORMAL_LAB', detail: `Abnormal lab result for ${name} (${flag}).` },
      ],
    };
  }
  if (flag === 'normal' || flag === '') {
    return {
      relevance: 'low',
      signals: [
        { code: 'NORMAL_LAB', detail: `Lab ${name} within reference range.` },
      ],
    };
  }
  return {
    relevance: 'moderate',
    signals: [
      { code: 'LAB_REVIEW', detail: `Lab ${name} requires review (flag=${flag}).` },
    ],
  };
}

/**
 * Classify an imaging event.
 *   flagged_critical === true                           -> critical
 *   impression matches IMAGING_SIGNIFICANT_PATTERN      -> high
 *   else                                                -> moderate
 */
export function classifyImagingEvent({ payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const modality = cleanText(p.modality) || 'imaging';
  const impression = cleanText(p.impression);

  if (p.flagged_critical === true) {
    return {
      relevance: 'critical',
      signals: [
        {
          code: 'CRITICAL_IMAGING_FINDING',
          detail: `Critical imaging finding (${modality})${impression ? `: ${impression}` : ''}.`,
        },
      ],
    };
  }
  if (impression && IMAGING_SIGNIFICANT_PATTERN.test(impression)) {
    return {
      relevance: 'high',
      signals: [
        {
          code: 'SIGNIFICANT_IMAGING_FINDING',
          detail: `Significant imaging finding (${modality}): ${impression}.`,
        },
      ],
    };
  }
  return {
    relevance: 'moderate',
    signals: [
      {
        code: 'IMAGING_READ',
        detail: `Imaging read (${modality})${impression ? `: ${impression}` : ''}.`,
      },
    ],
  };
}

/**
 * Classify a patient-message event.
 *   PHI detected (phone / MRN / email / Aadhaar) -> high, MESSAGE_PHI_RISK
 *   concern keywords (urgent/emergency/pain/worsening/bleeding/breathing)
 *                                                -> moderate, PATIENT_CONCERN
 *   else                                         -> informational, ROUTINE_MESSAGE
 */
export function classifyMessageEvent({ payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const text = cleanText(p.text);
  const channel = cleanText(p.channel) || 'unknown';

  if (text) {
    for (const pattern of PHI_PATTERNS) {
      if (pattern.test(text)) {
        return {
          relevance: 'high',
          signals: [
            {
              code: 'MESSAGE_PHI_RISK',
              detail: `Potential PHI leak in ${channel} message (pattern=${pattern.source}).`,
            },
          ],
        };
      }
    }
    if (MESSAGE_CONCERN_PATTERN.test(text)) {
      return {
        relevance: 'moderate',
        signals: [
          {
            code: 'PATIENT_CONCERN',
            detail: `Patient concern keywords detected in ${channel} message.`,
          },
        ],
      };
    }
  }

  return {
    relevance: 'informational',
    signals: [
      {
        code: 'ROUTINE_MESSAGE',
        detail: `Routine ${channel} message.`,
      },
    ],
  };
}

/**
 * Classify a prescription-administration event.
 *   (critical === true OR medication is critical) AND missed === true
 *                                    -> critical, CRITICAL_MED_MISSED
 *   missed === true                  -> high, MED_MISSED
 *   else                             -> low, MED_ADMINISTERED
 */
export function classifyPrescriptionEvent({ payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const medicationName = cleanText(p.medication_name) || 'medication';
  const missed = p.missed === true;
  const explicitCritical = p.critical === true;
  const nameCritical = PRESCRIPTION_CRITICAL_PATTERN.test(medicationName);

  if (missed && (explicitCritical || nameCritical)) {
    return {
      relevance: 'critical',
      signals: [
        {
          code: 'CRITICAL_MED_MISSED',
          detail: `Critical medication missed: ${medicationName}.`,
        },
      ],
    };
  }
  if (missed) {
    return {
      relevance: 'high',
      signals: [
        {
          code: 'MED_MISSED',
          detail: `Medication missed: ${medicationName}.`,
        },
      ],
    };
  }
  return {
    relevance: 'low',
    signals: [
      {
        code: 'MED_ADMINISTERED',
        detail: `Medication administered: ${medicationName}.`,
      },
    ],
  };
}

/**
 * Catch-all classifier for kinds not covered by the specific classifiers
 * (note / voice / document / telemetry / claim / other).
 */
export function classifyGenericEvent({ kind, payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const normalized = normalizeEventKind(kind);

  switch (normalized) {
    case 'note':
    case 'voice':
    case 'document': {
      const relevance = p.critical === true ? 'moderate' : 'informational';
      return {
        relevance,
        signals: [
          {
            code: relevance === 'moderate' ? 'SOURCE_FLAGGED' : 'SOURCE_ROUTINE',
            detail: `${normalized} event${p.critical === true ? ' flagged for review' : ''}.`,
          },
        ],
      };
    }
    case 'telemetry': {
      const relevance = p.anomaly_flag ? 'moderate' : 'low';
      return {
        relevance,
        signals: [
          {
            code: relevance === 'moderate' ? 'TELEMETRY_ANOMALY' : 'TELEMETRY_NORMAL',
            detail: p.anomaly_flag
              ? 'Device telemetry anomaly flagged.'
              : 'Device telemetry nominal.',
          },
        ],
      };
    }
    case 'claim':
      return {
        relevance: 'informational',
        signals: [{ code: 'CLAIM_EVENT', detail: 'Claim / billing event recorded.' }],
      };
    case 'other':
    default:
      return {
        relevance: 'informational',
        signals: [{ code: 'OTHER_EVENT', detail: 'Unclassified event.' }],
      };
  }
}

/**
 * Single-event dispatcher. Normalizes kind + time, routes to the
 * appropriate classifier, and returns the classified event:
 *
 *   { ...event, kind, occurred_at, relevance, signals }
 */
export function classifyEvent(event = {}) {
  const kind = normalizeEventKind(event?.kind);
  const occurred_at = parseEventTime(event?.occurred_at);
  const payload = event && typeof event.payload === 'object' && event.payload !== null
    ? event.payload
    : {};

  let result;
  switch (kind) {
    case 'vital':
      result = classifyVitalEvent({ payload });
      break;
    case 'lab':
      result = classifyLabEvent({ payload });
      break;
    case 'imaging':
      result = classifyImagingEvent({ payload });
      break;
    case 'message':
      result = classifyMessageEvent({ payload });
      break;
    case 'prescription':
      result = classifyPrescriptionEvent({ payload });
      break;
    default:
      result = classifyGenericEvent({ kind, payload });
      break;
  }

  const relevance = RELEVANCE_BANDS.has(result?.relevance) ? result.relevance : 'unknown';
  const signals = asArray(result?.signals);

  return {
    ...event,
    kind,
    occurred_at,
    relevance,
    signals,
  };
}

/**
 * Given a list of relevance bands, return the highest-priority one.
 * Unknown entries are treated as the lowest.
 */
export function escalateRelevance(list) {
  const items = asArray(list);
  if (!items.length) return 'unknown';
  let best = 'unknown';
  let bestIdx = RELEVANCE_PRIORITY.indexOf('unknown');
  for (const entry of items) {
    const normalized = RELEVANCE_BANDS.has(entry) ? entry : 'unknown';
    const idx = RELEVANCE_PRIORITY.indexOf(normalized);
    if (idx > bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best;
}

/**
 * Return a NEW array sorted by (occurred_at ASC, relevance DESC).
 * Events with null occurred_at sort to the end.
 */
export function sortTimeline(events) {
  const list = asArray(events).slice();
  return list.sort((a, b) => {
    const at = a?.occurred_at instanceof Date ? a.occurred_at.getTime() : parseEventTime(a?.occurred_at)?.getTime() ?? null;
    const bt = b?.occurred_at instanceof Date ? b.occurred_at.getTime() : parseEventTime(b?.occurred_at)?.getTime() ?? null;

    if (at === null && bt === null) {
      // Same null-bucket: sort by relevance DESC.
      const ar = RELEVANCE_PRIORITY.indexOf(RELEVANCE_BANDS.has(a?.relevance) ? a.relevance : 'unknown');
      const br = RELEVANCE_PRIORITY.indexOf(RELEVANCE_BANDS.has(b?.relevance) ? b.relevance : 'unknown');
      return br - ar;
    }
    if (at === null) return 1;
    if (bt === null) return -1;
    if (at !== bt) return at - bt;

    const ar = RELEVANCE_PRIORITY.indexOf(RELEVANCE_BANDS.has(a?.relevance) ? a.relevance : 'unknown');
    const br = RELEVANCE_PRIORITY.indexOf(RELEVANCE_BANDS.has(b?.relevance) ? b.relevance : 'unknown');
    return br - ar;
  });
}

/**
 * Build the reviewer-facing action list. Always ends with the disclaimer.
 * Includes one extra action per CRITICAL_* signal code.
 */
export function buildTimelineActions({
  overallSeverity = 'low',
  criticalCount = 0,
  highCount = 0,
  signals = [],
} = {}) {
  const severity = RELEVANCE_BANDS.has(overallSeverity) ? overallSeverity : 'unknown';
  const actions = [];

  switch (severity) {
    case 'critical':
      actions.push(
        `Timeline severity critical — ${criticalCount || 0} critical event(s); escalate to the responsible clinician immediately for patient-safety review.`
      );
      break;
    case 'high':
      actions.push(
        `Timeline severity high — ${highCount || 0} high-relevance event(s); review with the responsible clinician at the next handover.`
      );
      break;
    case 'moderate':
      actions.push('Timeline severity moderate — review signals during the scheduled round.');
      break;
    case 'low':
      actions.push('Timeline severity low — continue routine monitoring.');
      break;
    case 'informational':
      actions.push('Timeline severity informational — no urgent review required.');
      break;
    default:
      actions.push('Timeline severity unknown — confirm inputs before reviewing.');
      break;
  }

  const seenCritical = new Set();
  for (const sig of asArray(signals)) {
    const code = cleanText(sig?.code);
    if (!code || !code.startsWith('CRITICAL_')) continue;
    if (seenCritical.has(code)) continue;
    seenCritical.add(code);
    actions.push(
      `Critical signal ${code} — review the associated event and confirm clinical response.${
        sig?.detail ? ` (${cleanText(sig.detail)})` : ''
      }`
    );
  }

  actions.push(REVIEW_DISCLAIMER);
  return actions;
}

/**
 * One-sentence summary starting with [timeline].
 */
export function summarizeTimeline({
  patientUid = '',
  eventCount = 0,
  overallSeverity = 'low',
  criticalCount = 0,
} = {}) {
  const severity = RELEVANCE_BANDS.has(overallSeverity) ? overallSeverity : 'unknown';
  const pid = cleanText(patientUid) || 'unknown-patient';
  const count = toNumber(eventCount, 0);
  const crit = toNumber(criticalCount, 0);
  return `[timeline] Patient ${pid}: ${count} event(s), overall severity ${severity}, ${crit} critical.`;
}

/**
 * Compose everything. Pure: no DB, no side effects.
 *   { overall_severity, event_count, critical_count, high_count,
 *     moderate_count, low_count, informational_count, timeline_events,
 *     source_breakdown, signals }
 */
export function evaluateTimeline({ events = [] } = {}) {
  const classified = asArray(events).map((e) => classifyEvent(e || {}));

  const counts = {
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    informational: 0,
    unknown: 0,
  };
  const source_breakdown = {};
  const signals = [];

  for (const e of classified) {
    const band = RELEVANCE_BANDS.has(e.relevance) ? e.relevance : 'unknown';
    if (band in counts) counts[band] += 1;
    else counts.unknown += 1;
    const kind = normalizeEventKind(e.kind);
    source_breakdown[kind] = (source_breakdown[kind] || 0) + 1;
    for (const sig of asArray(e.signals)) {
      if (sig) signals.push(sig);
    }
  }

  const overall_severity = escalateRelevance(classified.map((e) => e.relevance));
  const timeline_events = sortTimeline(classified);

  return {
    overall_severity,
    event_count: classified.length,
    critical_count: counts.critical,
    high_count: counts.high,
    moderate_count: counts.moderate,
    low_count: counts.low,
    informational_count: counts.informational,
    timeline_events,
    source_breakdown,
    signals,
  };
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
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17,
               $18, $19, $20, $21, $22::jsonb, NOW(), NOW())
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
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      usage.latency_ms || aiResult?.latencyMs || null,
      usage.provider_request_id || aiResult?.requestId || null,
      usage.finish_reason || aiResult?.finishReason || null,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Multimodal patient timeline generation persist failed', { error: err.message });
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
        source: 'multimodal_patient_timeline',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        approval_policy: module?.settings?.approvalPolicy || 'clinician_review',
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Multimodal patient timeline review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizeSnapshotRow(row) {
  if (!row) return row;
  return {
    ...row,
    event_count: toNumber(row.event_count, 0),
    critical_count: toNumber(row.critical_count, 0),
    high_count: toNumber(row.high_count, 0),
    moderate_count: toNumber(row.moderate_count, 0),
    low_count: toNumber(row.low_count, 0),
    informational_count: toNumber(row.informational_count, 0),
    generation_id: row.generation_id !== null && row.generation_id !== undefined
      ? toNumber(row.generation_id, null)
      : null,
    admission_id: row.admission_id !== null && row.admission_id !== undefined
      ? toNumber(row.admission_id, null)
      : null,
  };
}

async function insertTimelineSnapshot({
  tenantId,
  patientUid,
  admissionId,
  generationId,
  windowStart,
  windowEnd,
  evaluation,
  summary,
  recommendedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_patient_timeline_snapshots
         (tenant_id, patient_uid, admission_id, generation_id,
          window_start, window_end,
          event_count, critical_count, high_count, moderate_count,
          low_count, informational_count, overall_severity,
          timeline_events, source_breakdown, signals, summary,
          recommended_actions, source_citations, safety_flags,
          reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4,
               $5::timestamptz, $6::timestamptz,
               $7, $8, $9, $10,
               $11, $12, $13,
               $14::jsonb, $15::jsonb, $16::jsonb, $17,
               $18::jsonb, $19::jsonb, $20::jsonb,
               'pending', $21::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, generation_id,
                 window_start, window_end, event_count, critical_count,
                 high_count, moderate_count, low_count, informational_count,
                 overall_severity, timeline_events, source_breakdown, signals,
                 summary, recommended_actions, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      admissionId,
      generationId,
      toIsoOrNull(windowStart),
      toIsoOrNull(windowEnd),
      evaluation.event_count,
      evaluation.critical_count,
      evaluation.high_count,
      evaluation.moderate_count,
      evaluation.low_count,
      evaluation.informational_count,
      RELEVANCE_BANDS.has(evaluation.overall_severity) ? evaluation.overall_severity : 'low',
      JSON.stringify(evaluation.timeline_events || []),
      JSON.stringify(evaluation.source_breakdown || {}),
      JSON.stringify(evaluation.signals || []),
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

export async function generateTimelineSnapshot({
  req = null,
  patientUid,
  admissionId = null,
  windowStart = null,
  windowEnd = null,
  events = [],
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const safeAdmissionId = admissionId === null || admissionId === undefined || admissionId === ''
    ? null
    : optionalIntOrNull(admissionId);

  // Pure evaluation.
  const evaluation = evaluateTimeline({ events });
  const {
    overall_severity,
    event_count,
    critical_count,
    high_count,
    moderate_count,
    low_count,
    informational_count,
    timeline_events,
    source_breakdown,
    signals,
  } = evaluation;

  // Citations: patient record + one per unique source kind + rules ref.
  const citations = [
    {
      source_type: 'patient',
      source_id: String(patientUid),
      label: 'Patient record',
      timestamp: null,
    },
  ];
  const seenKinds = new Set();
  for (const e of asArray(timeline_events)) {
    const kind = normalizeEventKind(e?.kind);
    if (seenKinds.has(kind)) continue;
    seenKinds.add(kind);
    citations.push({
      source_type: `patient_timeline_${kind}`,
      source_id: `${patientUid}:${kind}`,
      label: `Timeline source — ${kind}`,
      timestamp: null,
    });
  }
  citations.push({
    source_type: 'patient_timeline_rules',
    source_id: MODULE_KEY,
    label: 'Multimodal patient timeline classification rules',
    timestamp: null,
  });
  const uniqueCits = uniqueCitations(citations);

  // Safety flags: one critical flag per critical-band event, plus sentinels.
  const safetyFlags = [];
  for (const e of asArray(timeline_events)) {
    if (e?.relevance === 'critical') {
      const kind = normalizeEventKind(e?.kind).toUpperCase();
      safetyFlags.push({
        severity: 'critical',
        code: `CRITICAL_${kind}_EVENT`,
        message: `Critical ${kind.toLowerCase()} event on the timeline; clinician review required.`,
      });
    }
  }
  if (!uniqueCits.length) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_CITATIONS',
      message: 'Timeline snapshot has no source citations.',
    });
  }
  if (event_count === 0) {
    safetyFlags.push({
      severity: 'medium',
      code: 'NO_EVENTS',
      message: 'No events supplied; timeline snapshot is empty.',
    });
  }

  const recommendedActions = buildTimelineActions({
    overallSeverity: overall_severity,
    criticalCount: critical_count,
    highCount: high_count,
    signals,
  });

  const summary = summarizeTimeline({
    patientUid,
    eventCount: event_count,
    overallSeverity: overall_severity,
    criticalCount: critical_count,
  });

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: patientUid,
    admission_id: safeAdmissionId,
    overall_severity,
    event_count,
    critical_count,
    high_count,
    moderate_count,
    low_count,
    informational_count,
    timeline_events,
    source_breakdown,
    signals,
    summary,
    recommended_actions: recommendedActions,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  let draft = fallbackDraft;
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        rules_authoritative: true,
        decision_support_only: true,
        patient_uid: patientUid,
        admission_id: safeAdmissionId,
        window_start: toIsoOrNull(windowStart),
        window_end: toIsoOrNull(windowEnd),
        rule_based_evaluation: {
          overall_severity,
          event_count,
          critical_count,
          high_count,
          moderate_count,
          low_count,
          informational_count,
          source_breakdown,
          signal_codes: asArray(signals).map((s) => s?.code).filter(Boolean),
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        // Narrative only — never let AI override bands, counts, ordering, or signals.
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
      };
    }
  } catch (err) {
    logger.debug('Multimodal patient timeline AI narrative unavailable; using rule summary fallback', {
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
        patient: { uid: patientUid, admission_id: safeAdmissionId },
        timeline: {
          overall_severity,
          event_count,
          critical_count,
        },
      },
      citations: uniqueCits,
    }),
  ];
  draft.safety_flags = combinedFlags;
  draft.source_citations = uniqueCitations(asArray(draft.source_citations));

  const generation = await insertGeneration({
    tenantId,
    patientUid,
    admissionId: safeAdmissionId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: patientUid,
      admission_id: safeAdmissionId,
      window_start: toIsoOrNull(windowStart),
      window_end: toIsoOrNull(windowEnd),
      events: asArray(timeline_events).map((e) => ({
        kind: e?.kind,
        occurred_at: toIsoOrNull(e?.occurred_at),
        source_ref_type: e?.source_ref_type || null,
        source_ref_id: e?.source_ref_id || null,
        relevance: e?.relevance,
      })),
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      patient_uid: patientUid,
      admission_id: safeAdmissionId,
      overall_severity,
      event_count,
      critical_count,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const snapshotRow = await insertTimelineSnapshot({
    tenantId,
    patientUid,
    admissionId: safeAdmissionId,
    generationId: generation?.id || null,
    windowStart,
    windowEnd,
    evaluation: {
      overall_severity,
      event_count,
      critical_count,
      high_count,
      moderate_count,
      low_count,
      informational_count,
      timeline_events,
      source_breakdown,
      signals,
    },
    summary: draft.summary,
    recommendedActions,
    citations: draft.source_citations,
    safetyFlags: combinedFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      window_start: toIsoOrNull(windowStart),
      window_end: toIsoOrNull(windowEnd),
      rules_authoritative: true,
      decision_support_only: true,
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
      overall_severity,
      event_count,
      critical_count,
      high_count,
      moderate_count,
      low_count,
      informational_count,
      timeline_events,
      source_breakdown,
      signals,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_patient_timeline_snapshots_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid,
    admissionId: safeAdmissionId,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.timeline_snapshot_generated',
      aggregateType: 'clinical_ai_patient_timeline_snapshot',
      aggregateId: snapshotRow.id,
      patientUid,
      payload: {
        tenant_id: tenantId,
        snapshot_id: snapshotRow.id,
        generation_id: generation?.id || null,
        patient_uid: patientUid,
        admission_id: safeAdmissionId,
        overall_severity,
        event_count,
        critical_count,
        high_count,
        moderate_count,
        low_count,
        informational_count,
        source_breakdown,
        signal_codes: asArray(signals).map((s) => s?.code).filter(Boolean),
      },
    });
  } catch (err) {
    logger.warn('Multimodal patient timeline event publish failed', { error: err?.message });
  }

  return {
    snapshot_id: snapshotRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    snapshot: snapshotRow,
    overall_severity,
    event_count,
    critical_count,
    high_count,
    moderate_count,
    low_count,
    informational_count,
    timeline_events,
    source_breakdown,
    signals,
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
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listTimelineSnapshots({
  tenantId = null,
  patientUid = null,
  overallSeverity = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedSeverity =
    overallSeverity && RELEVANCE_BANDS.has(cleanText(overallSeverity).toLowerCase())
      ? cleanText(overallSeverity).toLowerCase()
      : null;
  const normalizedDecision =
    reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
      ? cleanText(reviewerDecision).toLowerCase()
      : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.tenant_id, s.patient_uid, s.admission_id, s.generation_id,
              s.window_start, s.window_end, s.event_count, s.critical_count,
              s.high_count, s.moderate_count, s.low_count, s.informational_count,
              s.overall_severity, s.timeline_events, s.source_breakdown,
              s.signals, s.summary, s.recommended_actions, s.source_citations,
              s.safety_flags, s.reviewer_decision, s.reviewed_by, s.reviewed_at,
              s.reviewer_note, s.metadata, s.created_at, s.updated_at
       FROM clinical_ai_patient_timeline_snapshots s
       WHERE s.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR s.patient_uid = $2::uuid)
         AND ($3::text IS NULL OR s.overall_severity = $3)
         AND ($4::text IS NULL OR s.reviewer_decision = $4)
       ORDER BY
         CASE s.overall_severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           WHEN 'informational' THEN 4
           ELSE 5
         END,
         s.created_at DESC
       LIMIT $5`,
      tid,
      patientUid || null,
      normalizedSeverity,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeSnapshotRow);
    return { snapshots: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { snapshots: [], count: 0 };
    throw err;
  }
}

export async function decideTimelineSnapshot({
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
    `UPDATE clinical_ai_patient_timeline_snapshots
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, patient_uid, admission_id, generation_id,
               window_start, window_end, event_count, critical_count,
               high_count, moderate_count, low_count, informational_count,
               overall_severity, timeline_events, source_breakdown, signals,
               summary, recommended_actions, source_citations, safety_flags,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
               metadata, created_at, updated_at`,
    optionalInt(snapshotId, 'snapshot_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Multimodal patient timeline snapshot not found');
  return normalizeSnapshotRow(rows[0]);
}

// Reference `toDateOrNull` so the helper is exported-usable if a caller
// passes a Date/string through the classify pipeline manually.
void toDateOrNull;

export default {
  EVENT_KINDS,
  RELEVANCE_BANDS,
  RELEVANCE_PRIORITY,
  normalizeEventKind,
  parseEventTime,
  classifyVitalEvent,
  classifyLabEvent,
  classifyImagingEvent,
  classifyMessageEvent,
  classifyPrescriptionEvent,
  classifyGenericEvent,
  classifyEvent,
  escalateRelevance,
  sortTimeline,
  buildTimelineActions,
  summarizeTimeline,
  evaluateTimeline,
  generateTimelineSnapshot,
  listTimelineSnapshots,
  decideTimelineSnapshot,
};
