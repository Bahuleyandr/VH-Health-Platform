/**
 * Biomedical Device Maintenance Predictor.
 *
 * Maintains a biomedical device registry and produces reviewable
 * failure-risk predictions for each device from usage hours, fault
 * clusters, MTBF, age, and warranty status.
 *
 * Rules are authoritative: the risk score, risk band, recommended
 * service window, and actions are derived from the registry +
 * override inputs. The AI layer (when available) only supplies a
 * short narrative summary.
 *
 * Decision-support only — the service never auto-schedules maintenance,
 * never takes a device out of service, and never modifies the
 * maintenance log. Every output is reviewed by biomedical staff /
 * facility manager.
 *
 * Graceful degradation: if the maintenance-prediction or device
 * schema is missing, the service returns a schema_unavailable payload
 * rather than crashing.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'biomed_device_maintenance';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support biomedical staff / facility-manager review of medical device maintenance risk. Rules are authoritative. Use only the supplied device registry data. Return JSON only. Never auto-schedule maintenance, never take a device out of service, and never modify the maintenance log.',
  user_prompt_template:
    'Given the device context and the rule-based failure-risk signals, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);
const DEVICE_STATUSES = new Set([
  'in_service', 'out_of_service', 'retired', 'pending_inspection', 'unknown',
]);
const URGENCIES = new Set(['immediate', 'within_7_days', 'within_30_days', 'routine']);

const REVIEW_DISCLAIMER =
  'Decision-support only — biomedical staff / facility manager review every maintenance action before it is taken.';

// Exported device-type catalog + default service intervals (hours).
export const DEVICE_TYPES = [
  'ventilator',
  'defibrillator',
  'infusion_pump',
  'ecg_monitor',
  'ultrasound',
  'x_ray',
  'mri',
  'ct_scanner',
  'dialysis',
  'anesthesia_machine',
  'other',
];

export const DEFAULT_SERVICE_INTERVALS_HOURS = {
  ventilator: 1000,
  defibrillator: 500,
  infusion_pump: 2000,
  ecg_monitor: 3000,
  ultrasound: 2500,
  x_ray: 1500,
  mri: 1200,
  ct_scanner: 1200,
  dialysis: 800,
  anesthesia_machine: 1000,
  other: 2000,
};

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

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNonNegativeNumber(value, fallback = 0) {
  const parsed = toNumber(value, fallback);
  return parsed < 0 ? fallback : parsed;
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

function normalizeDeviceType(value) {
  const text = normalizedText(value).replace(/[\s-]+/g, '_');
  if (DEVICE_TYPES.includes(text)) return text;
  return 'other';
}

function normalizeStatus(value) {
  const text = normalizedText(value);
  return DEVICE_STATUSES.has(text) ? text : 'in_service';
}

function addDaysIso(base, days) {
  const d = base instanceof Date ? new Date(base.getTime()) : new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Return the integer number of days between `timestamp` and now.
 * Returns null for null / undefined / invalid input.
 */
export function daysSince(timestamp) {
  if (timestamp === null || timestamp === undefined) return null;
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return null;
  const diffMs = Date.now() - then.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * Detect maintenance signals from a device's usage + fault profile.
 *
 * Returns Array<{ code, severity, description }>.
 *
 * Signals:
 *   - OVERDUE_MAINTENANCE: hoursSinceLastService > interval → high
 *   - APPROACHING_SERVICE: 80%-100% of interval → medium
 *   - FAULT_CLUSTER: faultEventsLast90d >= 5 → critical; >= 3 → high
 *   - LOW_MTBF: mtbfHours < 500 → high
 *   - END_OF_LIFE: installedYearsAgo >= 10 → medium
 *   - WARRANTY_EXPIRING: warrantyExpiresOn within warrantyGraceDays → low
 *   - NO_SERVICE_HISTORY: hoursSinceLastService === null AND usageHours > 500 → medium
 */
export function detectMaintenanceSignals({
  deviceType,
  usageHours = 0,
  hoursSinceLastService = null,
  faultEventsLast90d = 0,
  mtbfHours = null,
  installedYearsAgo = null,
  warrantyExpiresOn = null,
  warrantyGraceDays = 30,
} = {}) {
  const signals = [];
  const type = normalizeDeviceType(deviceType);
  const interval = DEFAULT_SERVICE_INTERVALS_HOURS[type] || DEFAULT_SERVICE_INTERVALS_HOURS.other;
  const usage = toNonNegativeNumber(usageHours, 0);
  const hoursSince = hoursSinceLastService === null || hoursSinceLastService === undefined
    ? null
    : toNonNegativeNumber(hoursSinceLastService, 0);
  const faults = toNonNegativeNumber(faultEventsLast90d, 0);
  const mtbf = toNullableNumber(mtbfHours);
  const age = toNullableNumber(installedYearsAgo);
  const grace = toNonNegativeNumber(warrantyGraceDays, 30);

  // OVERDUE_MAINTENANCE / APPROACHING_SERVICE
  if (hoursSince !== null && hoursSince > interval) {
    signals.push({
      code: 'OVERDUE_MAINTENANCE',
      severity: 'high',
      description: `Hours since last preventive service (${Math.round(hoursSince)}h) exceed the ${type} service interval (${interval}h).`,
    });
  } else if (hoursSince !== null && hoursSince >= interval * 0.8 && hoursSince <= interval) {
    signals.push({
      code: 'APPROACHING_SERVICE',
      severity: 'medium',
      description: `Hours since last service (${Math.round(hoursSince)}h) are within the pre-service window (${Math.round(interval * 0.8)}-${interval}h).`,
    });
  }

  // FAULT_CLUSTER — critical at >= 5, high at >= 3
  if (faults >= 5) {
    signals.push({
      code: 'FAULT_CLUSTER',
      severity: 'critical',
      description: `Fault events in the last 90 days (${faults}) meet the critical fault-cluster threshold (>= 5).`,
    });
  } else if (faults >= 3) {
    signals.push({
      code: 'FAULT_CLUSTER',
      severity: 'high',
      description: `Fault events in the last 90 days (${faults}) meet the fault-cluster threshold (>= 3).`,
    });
  }

  // LOW_MTBF
  if (mtbf !== null && mtbf > 0 && mtbf < 500) {
    signals.push({
      code: 'LOW_MTBF',
      severity: 'high',
      description: `Mean time between failures (${Math.round(mtbf)}h) is below the low-MTBF threshold (500h).`,
    });
  }

  // END_OF_LIFE
  if (age !== null && age >= 10) {
    signals.push({
      code: 'END_OF_LIFE',
      severity: 'medium',
      description: `Device age (${Math.round(age)} years) meets the end-of-life threshold (>= 10 years).`,
    });
  }

  // WARRANTY_EXPIRING — only when within (but not past) the grace window.
  if (warrantyExpiresOn) {
    const expiresIso = toNullableDate(warrantyExpiresOn);
    if (expiresIso) {
      const expiresMs = new Date(expiresIso).getTime();
      const now = Date.now();
      const diffDays = Math.floor((expiresMs - now) / (24 * 60 * 60 * 1000));
      if (diffDays >= 0 && diffDays <= grace) {
        signals.push({
          code: 'WARRANTY_EXPIRING',
          severity: 'low',
          description: `Warranty expires in ${diffDays} day(s) (grace window ${grace} days).`,
        });
      }
    }
  }

  // NO_SERVICE_HISTORY
  if (hoursSince === null && usage > 500) {
    signals.push({
      code: 'NO_SERVICE_HISTORY',
      severity: 'medium',
      description: `No preventive-maintenance history recorded, and usage (${Math.round(usage)}h) exceeds the minimum (500h).`,
    });
  }

  // Reference usage so the lint pass treats it as read.
  void usage;

  return signals;
}

/**
 * Combine maintenance signals into a failure-risk score + band.
 *
 * Weights: critical +35, high +20, medium +10, low +5 (clamped 0-100).
 * Bands: >= 65 critical, >= 40 high, >= 15 moderate, else low.
 * With no signals, returns { risk_score: 0, risk_band: 'low' } (well-maintained).
 */
export function computeFailureRiskScore(signals) {
  const list = asArray(signals);
  if (list.length === 0) {
    return { risk_score: 0, risk_band: 'low' };
  }
  const weights = { critical: 35, high: 20, medium: 10, low: 5 };
  let score = 0;
  for (const signal of list) {
    score += weights[signal?.severity] || 0;
  }
  score = Math.max(0, Math.min(100, score));

  let band = 'low';
  if (score >= 65) band = 'critical';
  else if (score >= 40) band = 'high';
  else if (score >= 15) band = 'moderate';

  return { risk_score: score, risk_band: band };
}

/**
 * Recommend a service window based on the risk score/band.
 *
 * critical → immediate (today)
 * high     → within 7 days
 * moderate → within 30 days
 * low      → routine (90 days out or next scheduled window)
 *
 * Returns { earliest_date (ISO, yyyy-mm-dd), latest_date, urgency }.
 */
export function recommendServiceWindow({
  riskScore = 0,
  riskBand = 'low',
  lastServiceAt = null,
} = {}) {
  const band = RISK_BANDS.has(riskBand) ? riskBand : 'low';
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  void riskScore;
  void lastServiceAt;

  if (band === 'critical') {
    return {
      earliest_date: todayIso,
      latest_date: todayIso,
      urgency: 'immediate',
    };
  }
  if (band === 'high') {
    return {
      earliest_date: todayIso,
      latest_date: addDaysIso(today, 7),
      urgency: 'within_7_days',
    };
  }
  if (band === 'moderate') {
    return {
      earliest_date: todayIso,
      latest_date: addDaysIso(today, 30),
      urgency: 'within_30_days',
    };
  }
  // low / unknown → routine window, 90 days out.
  return {
    earliest_date: addDaysIso(today, 30),
    latest_date: addDaysIso(today, 90),
    urgency: 'routine',
  };
}

const SIGNAL_ACTION_MAP = {
  OVERDUE_MAINTENANCE:
    'Schedule the overdue preventive maintenance and document the completion in the device log.',
  APPROACHING_SERVICE:
    'Plan the next preventive-maintenance slot before the service interval is exceeded.',
  FAULT_CLUSTER:
    'Investigate the fault cluster — pull recent error logs and confirm whether the device needs to be pulled from service for inspection.',
  LOW_MTBF:
    'Escalate to the manufacturer / OEM — low MTBF may indicate an underlying component failure or end-of-service-life.',
  END_OF_LIFE:
    'Flag for replacement planning — the device has reached its end-of-life age threshold.',
  WARRANTY_EXPIRING:
    'Coordinate with procurement / biomedical admin before warranty expiry to confirm extended support options.',
  NO_SERVICE_HISTORY:
    'Capture baseline preventive-maintenance records for this device; historical gaps limit the confidence of future forecasts.',
};

/**
 * Build a deduped list of maintenance actions from the signal list.
 * Always appends the review disclaimer last.
 */
export function buildMaintenanceActions({ signals = [], urgency = 'routine' } = {}) {
  const actions = [];
  const seen = new Set();
  const push = (text) => {
    if (!text) return;
    const key = String(text);
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(key);
  };

  // Urgency banner first.
  if (urgency === 'immediate') {
    push('Dispatch biomedical staff for immediate inspection and possible removal from service.');
  } else if (urgency === 'within_7_days') {
    push('Schedule biomedical service within 7 days; prioritize over routine maintenance.');
  } else if (urgency === 'within_30_days') {
    push('Schedule biomedical service within 30 days as part of the next planned maintenance block.');
  }

  for (const signal of asArray(signals)) {
    const mapped = SIGNAL_ACTION_MAP[signal?.code];
    if (mapped) push(mapped);
  }

  push(REVIEW_DISCLAIMER);
  return actions;
}

// ---------- DB loaders ---------------------------------------------------

function normalizeDeviceRow(row) {
  if (!row) return row;
  return {
    ...row,
    installed_at: toNullableDate(row.installed_at),
    warranty_expires_on: toNullableDate(row.warranty_expires_on),
    usage_hours: toNumber(row.usage_hours, 0),
    fault_events_last_90d: toNumber(row.fault_events_last_90d, 0),
    mean_time_between_failures_hours: row.mean_time_between_failures_hours !== null
      && row.mean_time_between_failures_hours !== undefined
      ? toNumber(row.mean_time_between_failures_hours, null)
      : null,
  };
}

function normalizePredictionRow(row) {
  if (!row) return row;
  return {
    ...row,
    predicted_failure_risk_score: toNumber(row.predicted_failure_risk_score, 0),
    predicted_downtime_hours: toNumber(row.predicted_downtime_hours, 0),
  };
}

async function loadDeviceById(tenantId, deviceId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, device_code, device_type, manufacturer, model, serial_number,
              location, installed_at, warranty_expires_on, last_preventive_maintenance_at,
              next_scheduled_maintenance_at, usage_hours, fault_events_last_90d,
              mean_time_between_failures_hours, status, metadata, created_at, updated_at
       FROM clinical_ai_biomed_devices
       WHERE tenant_id = $1::uuid AND id = $2
       LIMIT 1`,
      tenantId,
      deviceId
    );
    return normalizeDeviceRow(rows && rows[0] ? rows[0] : null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function loadDeviceByCode(tenantId, deviceCode) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, device_code, device_type, manufacturer, model, serial_number,
              location, installed_at, warranty_expires_on, last_preventive_maintenance_at,
              next_scheduled_maintenance_at, usage_hours, fault_events_last_90d,
              mean_time_between_failures_hours, status, metadata, created_at, updated_at
       FROM clinical_ai_biomed_devices
       WHERE tenant_id = $1::uuid AND device_code = $2
       LIMIT 1`,
      tenantId,
      deviceCode
    );
    return normalizeDeviceRow(rows && rows[0] ? rows[0] : null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
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
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
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
      aiResult?.usage?.prompt_tokens || 0,
      aiResult?.usage?.completion_tokens || 0,
      aiResult?.usage?.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Biomed maintenance generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, deviceCode, module }) {
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
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'BIOMEDICAL_STAFF', 'FACILITY_MANAGER'],
        source: 'biomed_device_maintenance',
        device_code: deviceCode || null,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Biomed maintenance review placeholder failed', { error: err.message });
    }
    return null;
  }
}

async function insertMaintenancePrediction({
  tenantId,
  deviceId,
  deviceCode,
  generationId,
  riskScore,
  riskBand,
  predictedDowntimeHours,
  recommendedServiceWindow,
  contributingSignals,
  recommendedActions,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_biomed_maintenance_predictions
         (tenant_id, device_id, device_code, generation_id, predicted_failure_risk_score,
          risk_band, predicted_downtime_hours, recommended_service_window,
          contributing_signals, recommended_actions, source_citations, safety_flags,
          reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
               $11::jsonb, $12::jsonb, 'pending', $13::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, device_id, device_code, generation_id,
                 predicted_failure_risk_score, risk_band, predicted_downtime_hours,
                 recommended_service_window, contributing_signals, recommended_actions,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      deviceId,
      deviceCode,
      generationId,
      riskScore,
      RISK_BANDS.has(riskBand) ? riskBand : 'unknown',
      predictedDowntimeHours,
      JSON.stringify(recommendedServiceWindow || {}),
      JSON.stringify(contributingSignals || []),
      JSON.stringify(recommendedActions || []),
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

// ---------- Public API (device registry) ---------------------------------

export async function upsertBiomedDevice({
  tenantId = null,
  deviceCode,
  deviceType,
  manufacturer = null,
  model = null,
  serialNumber = null,
  location = null,
  installedAt = null,
  warrantyExpiresOn = null,
  lastPreventiveMaintenanceAt = null,
  nextScheduledMaintenanceAt = null,
  usageHours = 0,
  faultEventsLast90d = 0,
  mtbfHours = null,
  status = 'in_service',
  metadata = {},
} = {}) {
  const code = cleanText(deviceCode);
  if (!code) throw AppError.badRequest('device_code is required');
  const type = normalizeDeviceType(deviceType);
  if (!DEVICE_TYPES.includes(type)) {
    throw AppError.badRequest(`device_type must be one of: ${DEVICE_TYPES.join(', ')}`);
  }
  const tid = resolveTenantId({ tenantId });
  const usage = toNonNegativeNumber(usageHours, 0);
  const faults = Math.max(0, Number.parseInt(faultEventsLast90d, 10) || 0);
  const mtbf = toNullableNumber(mtbfHours);
  const normalizedStatus = normalizeStatus(status);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_biomed_devices
         (tenant_id, device_code, device_type, manufacturer, model, serial_number,
          location, installed_at, warranty_expires_on, last_preventive_maintenance_at,
          next_scheduled_maintenance_at, usage_hours, fault_events_last_90d,
          mean_time_between_failures_hours, status, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::date,
               $10::timestamptz, $11::timestamptz, $12, $13, $14, $15, $16::jsonb, NOW(), NOW())
       ON CONFLICT (tenant_id, device_code)
       DO UPDATE SET
         device_type = EXCLUDED.device_type,
         manufacturer = EXCLUDED.manufacturer,
         model = EXCLUDED.model,
         serial_number = EXCLUDED.serial_number,
         location = EXCLUDED.location,
         installed_at = EXCLUDED.installed_at,
         warranty_expires_on = EXCLUDED.warranty_expires_on,
         last_preventive_maintenance_at = EXCLUDED.last_preventive_maintenance_at,
         next_scheduled_maintenance_at = EXCLUDED.next_scheduled_maintenance_at,
         usage_hours = EXCLUDED.usage_hours,
         fault_events_last_90d = EXCLUDED.fault_events_last_90d,
         mean_time_between_failures_hours = EXCLUDED.mean_time_between_failures_hours,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, tenant_id, device_code, device_type, manufacturer, model, serial_number,
                 location, installed_at, warranty_expires_on, last_preventive_maintenance_at,
                 next_scheduled_maintenance_at, usage_hours, fault_events_last_90d,
                 mean_time_between_failures_hours, status, metadata, created_at, updated_at`,
      tid,
      code,
      type,
      manufacturer ? cleanText(manufacturer) : null,
      model ? cleanText(model) : null,
      serialNumber ? cleanText(serialNumber) : null,
      location ? cleanText(location) : null,
      toNullableDate(installedAt),
      toNullableDate(warrantyExpiresOn),
      lastPreventiveMaintenanceAt ? new Date(lastPreventiveMaintenanceAt).toISOString() : null,
      nextScheduledMaintenanceAt ? new Date(nextScheduledMaintenanceAt).toISOString() : null,
      usage,
      faults,
      mtbf,
      normalizedStatus,
      JSON.stringify(metadata || {})
    );
    return normalizeDeviceRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function listBiomedDevices({
  tenantId = null,
  deviceType = null,
  status = null,
  limit = 100,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const normalizedType = deviceType && DEVICE_TYPES.includes(normalizeDeviceType(deviceType))
    ? normalizeDeviceType(deviceType)
    : null;
  const normalizedStatusFilter = status && DEVICE_STATUSES.has(normalizedText(status))
    ? normalizedText(status)
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, device_code, device_type, manufacturer, model, serial_number,
              location, installed_at, warranty_expires_on, last_preventive_maintenance_at,
              next_scheduled_maintenance_at, usage_hours, fault_events_last_90d,
              mean_time_between_failures_hours, status, metadata, created_at, updated_at
       FROM clinical_ai_biomed_devices
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR device_type = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY device_type ASC, device_code ASC
       LIMIT $4`,
      tid,
      normalizedType,
      normalizedStatusFilter,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizeDeviceRow);
    return { devices: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { devices: [], count: 0 };
    throw err;
  }
}

// ---------- Public API (maintenance predictions) -------------------------

export async function evaluateDeviceMaintenanceRisk({
  req = null,
  deviceId = null,
  deviceCode = null,
  overrideInputs = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const normalizedDeviceId = deviceId ? optionalInt(deviceId, 'device_id') : null;
  const normalizedDeviceCode = deviceCode ? cleanText(deviceCode) : null;
  const overrides = overrideInputs && typeof overrideInputs === 'object' ? overrideInputs : null;

  if (!normalizedDeviceId && !normalizedDeviceCode && !overrides) {
    throw AppError.badRequest('Either device_id, device_code, or overrideInputs must be supplied');
  }

  // 1) Load the device row (if identifiable).
  let device = null;
  if (normalizedDeviceId) {
    device = await loadDeviceById(tenantId, normalizedDeviceId);
  }
  if (!device && normalizedDeviceCode) {
    device = await loadDeviceByCode(tenantId, normalizedDeviceCode);
  }
  if (!device && !overrides) {
    throw AppError.notFound('Biomedical device not found for the supplied id/code');
  }

  // 2) Merge device + override inputs.
  const deviceType = normalizeDeviceType(overrides?.deviceType || device?.device_type || 'other');
  const usageHours = toNonNegativeNumber(
    overrides?.usageHours ?? device?.usage_hours,
    0
  );
  const faultEvents = Math.max(0, Number.parseInt(
    overrides?.faultEventsLast90d ?? device?.fault_events_last_90d ?? 0,
    10,
  ) || 0);
  const mtbfHours = toNullableNumber(
    overrides?.mtbfHours ?? device?.mean_time_between_failures_hours
  );
  const hoursSinceLastService = overrides?.hoursSinceLastService !== undefined
    && overrides?.hoursSinceLastService !== null
    ? toNullableNumber(overrides.hoursSinceLastService)
    : null;
  const installedAtRaw = overrides?.installedAt ?? device?.installed_at ?? null;
  const warrantyExpiresOn = overrides?.warrantyExpiresOn ?? device?.warranty_expires_on ?? null;
  const lastServiceAt = overrides?.lastServiceAt ?? device?.last_preventive_maintenance_at ?? null;
  const deviceCodeForPrediction = device?.device_code || normalizedDeviceCode || overrides?.deviceCode || null;

  // Derive installedYearsAgo from installed_at when the caller didn't pass it directly.
  let installedYearsAgo = toNullableNumber(overrides?.installedYearsAgo);
  if (installedYearsAgo === null && installedAtRaw) {
    const installedDate = new Date(installedAtRaw);
    if (!Number.isNaN(installedDate.getTime())) {
      const years = (Date.now() - installedDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (Number.isFinite(years)) {
        installedYearsAgo = Math.floor(years);
      }
    }
  }

  // Derive hoursSinceLastService from last_service timestamp when not overridden.
  let derivedHoursSinceLastService = hoursSinceLastService;
  if (derivedHoursSinceLastService === null && lastServiceAt) {
    const lsDays = daysSince(lastServiceAt);
    if (lsDays !== null) {
      // Assume 8 operating hours/day as a conservative default to translate
      // calendar days since last service into rough usage hours.
      derivedHoursSinceLastService = lsDays * 8;
    }
  }

  // 3) Signals → score → band → service window → actions.
  const signals = detectMaintenanceSignals({
    deviceType,
    usageHours,
    hoursSinceLastService: derivedHoursSinceLastService,
    faultEventsLast90d: faultEvents,
    mtbfHours,
    installedYearsAgo,
    warrantyExpiresOn,
  });
  const { risk_score: riskScore, risk_band: riskBand } = computeFailureRiskScore(signals);
  const serviceWindow = recommendServiceWindow({
    riskScore,
    riskBand,
    lastServiceAt,
  });
  const recommendedActions = buildMaintenanceActions({
    signals,
    urgency: URGENCIES.has(serviceWindow.urgency) ? serviceWindow.urgency : 'routine',
  });
  // Rough predicted downtime: weighted by band (critical worst-case).
  const downtimeTable = { critical: 16, high: 8, moderate: 4, low: 1, unknown: 2 };
  const predictedDowntimeHours = downtimeTable[riskBand] || 2;

  // 4) Citations + safety flags.
  const citations = [];
  if (device) {
    citations.push({
      source_type: 'biomed_device',
      source_id: String(device.id),
      label: `${device.device_code} (${device.device_type})`,
      timestamp: device.updated_at || device.created_at || null,
    });
  } else if (deviceCodeForPrediction) {
    citations.push({
      source_type: 'biomed_device_override',
      source_id: deviceCodeForPrediction,
      label: `${deviceCodeForPrediction} (override, no registry record)`,
      timestamp: null,
    });
  }

  const safetyFlags = [];
  if (riskBand === 'critical') {
    safetyFlags.push({
      severity: 'high',
      code: 'BIOMED_DEVICE_CRITICAL_RISK',
      message: 'Critical failure-risk indicators detected; dispatch biomedical staff for immediate inspection.',
    });
  } else if (riskBand === 'high') {
    safetyFlags.push({
      severity: 'medium',
      code: 'BIOMED_DEVICE_HIGH_RISK',
      message: 'High failure-risk indicators detected; schedule biomedical service within 7 days.',
    });
  }
  if (!device) {
    safetyFlags.push({
      severity: 'medium',
      code: 'BIOMED_DEVICE_NO_REGISTRY_RECORD',
      message: 'No registry record matched; operating on override inputs only.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'BIOMED_DEVICE_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — biomedical staff review every maintenance action before it is taken.',
  });

  // 5) Compose draft + optional AI narrative.
  const fallbackDraft = {
    module_key: MODULE_KEY,
    device: device ? {
      id: device.id,
      device_code: device.device_code,
      device_type: device.device_type,
      manufacturer: device.manufacturer,
      model: device.model,
      location: device.location,
      status: device.status,
    } : (deviceCodeForPrediction ? { device_code: deviceCodeForPrediction } : null),
    inputs: {
      device_type: deviceType,
      usage_hours: usageHours,
      hours_since_last_service: derivedHoursSinceLastService,
      fault_events_last_90d: faultEvents,
      mtbf_hours: mtbfHours,
      installed_years_ago: installedYearsAgo,
      warranty_expires_on: toNullableDate(warrantyExpiresOn),
    },
    predicted_failure_risk_score: riskScore,
    risk_band: riskBand,
    predicted_downtime_hours: predictedDowntimeHours,
    recommended_service_window: serviceWindow,
    contributing_signals: signals,
    recommended_actions: recommendedActions,
    source_citations: uniqueCitations(citations),
    safety_flags: safetyFlags,
    summary: signals.length
      ? `${signals.length} maintenance signal(s) detected — ${riskBand} risk band; service urgency ${serviceWindow.urgency}.`
      : `No maintenance signals detected for ${deviceCodeForPrediction || 'device'}; routine schedule applies.`,
    rules_authoritative: true,
    decision_support_only: true,
  };

  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        device_context: fallbackDraft.device,
        inputs: fallbackDraft.inputs,
        rule_based_evaluation: {
          predicted_failure_risk_score: riskScore,
          risk_band: riskBand,
          predicted_downtime_hours: predictedDowntimeHours,
          recommended_service_window: serviceWindow,
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
        // Never let the AI override the numeric / categorical rule-based fields.
      };
    }
  } catch (err) {
    logger.debug('Biomed maintenance AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  draft.source_citations = uniqueCitations(asArray(draft.source_citations));
  draft.safety_flags = safetyFlags;

  // 6) Persist generation + prediction + review placeholder.
  const generation = await insertGeneration({
    tenantId,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      device_id: device?.id || null,
      device_code: deviceCodeForPrediction,
      inputs: fallbackDraft.inputs,
      risk_band: riskBand,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      device_id: device?.id || null,
      device_code: deviceCodeForPrediction,
      device_type: deviceType,
      risk_band: riskBand,
      risk_score: riskScore,
      signal_codes: signals.map((s) => s.code),
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const predictionRow = await insertMaintenancePrediction({
    tenantId,
    deviceId: device?.id || null,
    deviceCode: deviceCodeForPrediction,
    generationId: generation?.id || null,
    riskScore,
    riskBand,
    predictedDowntimeHours,
    recommendedServiceWindow: serviceWindow,
    contributingSignals: signals,
    recommendedActions,
    citations: draft.source_citations,
    safetyFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      inputs: fallbackDraft.inputs,
      signal_codes: signals.map((s) => s.code),
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
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_biomed_maintenance_predictions_unavailable',
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    deviceCode: deviceCodeForPrediction,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.biomed_device_maintenance_predicted',
      aggregateType: 'clinical_ai_biomed_maintenance_prediction',
      aggregateId: predictionRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        device_id: device?.id || null,
        device_code: deviceCodeForPrediction,
        prediction_id: predictionRow.id,
        generation_id: generation?.id || null,
        risk_score: riskScore,
        risk_band: riskBand,
        signal_codes: signals.map((s) => s.code),
      },
    });
  } catch (err) {
    logger.warn('Biomed maintenance event publish failed', { error: err?.message });
  }

  return {
    prediction_id: predictionRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    prediction: predictionRow,
    device,
    source_citations: draft.source_citations,
    safety_flags: safetyFlags,
    predicted_failure_risk_score: riskScore,
    risk_band: riskBand,
    predicted_downtime_hours: predictedDowntimeHours,
    recommended_service_window: serviceWindow,
    contributing_signals: signals,
    recommended_actions: recommendedActions,
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

export async function listMaintenancePredictions({
  tenantId = null,
  deviceId = null,
  deviceCode = null,
  riskBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const did = deviceId ? optionalInt(deviceId, 'device_id') : null;
  const normalizedCode = deviceCode ? cleanText(deviceCode) : null;
  const normalizedBand = riskBand && RISK_BANDS.has(cleanText(riskBand).toLowerCase())
    ? cleanText(riskBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.tenant_id, p.device_id, p.device_code, p.generation_id,
              p.predicted_failure_risk_score, p.risk_band, p.predicted_downtime_hours,
              p.recommended_service_window, p.contributing_signals, p.recommended_actions,
              p.source_citations, p.safety_flags, p.reviewer_decision,
              p.reviewed_by, p.reviewed_at, p.reviewer_note, p.metadata,
              p.created_at, p.updated_at,
              d.device_type AS device_type, d.manufacturer AS manufacturer,
              d.model AS model, d.location AS location
       FROM clinical_ai_biomed_maintenance_predictions p
       LEFT JOIN clinical_ai_biomed_devices d ON d.id = p.device_id
       WHERE p.tenant_id = $1::uuid
         AND ($2::int IS NULL OR p.device_id = $2)
         AND ($3::text IS NULL OR p.device_code = $3)
         AND ($4::text IS NULL OR p.risk_band = $4)
         AND ($5::text IS NULL OR p.reviewer_decision = $5)
       ORDER BY
         CASE p.risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         p.created_at DESC
       LIMIT $6`,
      tid,
      did,
      normalizedCode,
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

export async function decideMaintenancePrediction({
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
    `UPDATE clinical_ai_biomed_maintenance_predictions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, device_id, device_code, generation_id,
               predicted_failure_risk_score, risk_band, predicted_downtime_hours,
               recommended_service_window, contributing_signals, recommended_actions,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(predictionId, 'prediction_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Biomed maintenance prediction not found');
  return normalizePredictionRow(rows[0]);
}

export default {
  DEVICE_TYPES,
  DEFAULT_SERVICE_INTERVALS_HOURS,
  buildMaintenanceActions,
  computeFailureRiskScore,
  daysSince,
  decideMaintenancePrediction,
  detectMaintenanceSignals,
  evaluateDeviceMaintenanceRisk,
  listBiomedDevices,
  listMaintenancePredictions,
  recommendServiceWindow,
  upsertBiomedDevice,
};
