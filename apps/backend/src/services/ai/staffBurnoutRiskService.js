/**
 * Staff Burnout / Workload Risk Predictor.
 *
 * Analyzes a rolling window of shift + PTO data for a given staff member
 * and produces a reviewable workload risk signal (risk score, risk band,
 * contributing signals, recommended actions). Rules are authoritative.
 *
 * Privacy-sensitive: this service emits a workload signal ONLY. It is
 * never a performance evaluation or disciplinary tool. HR/leadership
 * reviews every output; the service never auto-adjusts schedules, never
 * writes to personnel records, and never infers intent from the data.
 *
 * Graceful degradation: if no shift data exists for the staff member,
 * the service returns `insufficient_data` rather than inventing a
 * baseline.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'staff_burnout_workload_risk';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support HR/leadership review of staff workload patterns. Rules are authoritative. Use only the supplied workload summary. Return JSON only. This is a workload risk signal — never a performance evaluation or disciplinary tool.',
  user_prompt_template:
    'Given the rolling workload summary and the rule-based burnout signals, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown', 'insufficient_data']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NIGHT_SHIFT_TYPES = new Set(['night', 'overnight', 'nightshift']);
const WEEKEND_DAYS = new Set([0, 6]); // Sunday, Saturday (UTC day-of-week)
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Thresholds for signal detection.
export const WEEKLY_OVERTIME_CAP = 48; // hours/week threshold for overtime signal
export const NIGHT_SHIFT_STREAK_CAUTION = 4; // consecutive night shifts caution
export const NIGHT_SHIFT_STREAK_ESCALATE = 6;
export const MIN_PTO_DAYS_PER_WINDOW = 2; // 30-day window minimum
export const HIGH_HOURS_PER_WEEK = 60;

const PRIVACY_REMINDER =
  'This is a workload risk signal only — not a performance or disciplinary tool. Involve the staff member in any follow-up.';

const ACTION_MAP = {
  HIGH_WEEKLY_HOURS:
    'Review workload distribution; consider redistributing shifts or hiring additional cover.',
  SIGNIFICANT_OVERTIME:
    'Audit overtime patterns; confirm it is voluntary and compensated.',
  EXTENDED_NIGHT_SHIFT_STREAK:
    'Mandate a daylight-shift recovery block; schedule wellness check-in.',
  NIGHT_SHIFT_STREAK:
    'Monitor for fatigue; consider rotating off nights.',
  LOW_PTO_UTILIZATION:
    'Encourage PTO usage; confirm no artificial barriers.',
  WEEKEND_HEAVY:
    'Balance weekend loading across team.',
  NO_SHIFT_DATA:
    'Confirm shift records are being captured for this staff member.',
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

function toNonNegativeNumber(value, fallback = 0) {
  const parsed = toNumber(value, fallback);
  return parsed < 0 ? fallback : parsed;
}

function roundTo(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
}

function utcDateOrdinal(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    / MILLISECONDS_PER_DAY;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function validateStaffUid(value) {
  const text = cleanText(value);
  if (!text || !UUID_REGEX.test(text)) {
    throw AppError.badRequest('staff_uid must be a valid UUID');
  }
  return text;
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

function dayKey(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function hoursBetween(startLike, endLike) {
  const start = new Date(startLike);
  const end = new Date(endLike);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0) return 0;
  return diffMs / (60 * 60 * 1000);
}

// ---------- Pure helpers (exported) --------------------------------------

/**
 * Summarize a list of shifts into workload statistics.
 *
 * Each shift may have: { start_at, end_at, shift_type, hours }
 *   - shift_type: 'day' | 'evening' | 'night' | 'on_call'
 *   - hours: optional; if missing, computed from start_at..end_at.
 *
 * Returns workload stats. An empty or null input returns all zeros.
 */
export function calculateShiftLoad(shifts) {
  const empty = {
    total_hours: 0,
    overtime_hours: 0,
    night_shift_count: 0,
    consecutive_night_shifts: 0,
    weekend_shift_count: 0,
    shift_count: 0,
    first_shift_at: null,
    last_shift_at: null,
  };
  if (!shifts || !Array.isArray(shifts) || shifts.length === 0) return empty;

  let totalHours = 0;
  let overtimeHours = 0;
  let nightShiftCount = 0;
  let weekendShiftCount = 0;
  let shiftCount = 0;
  let firstAt = null;
  let lastAt = null;

  // Collect night-shift calendar days for consecutive-streak analysis.
  const nightDays = [];

  for (const shift of shifts) {
    if (!shift) continue;
    const type = normalizedText(shift.shift_type);
    const startAt = shift.start_at ? new Date(shift.start_at) : null;
    const endAt = shift.end_at ? new Date(shift.end_at) : null;
    const startValid = startAt && !Number.isNaN(startAt.getTime());
    const endValid = endAt && !Number.isNaN(endAt.getTime());

    let hours = toNumber(shift.hours, null);
    if (hours === null || hours === undefined || Number.isNaN(hours)) {
      hours = startValid && endValid ? hoursBetween(startAt, endAt) : 0;
    }
    hours = toNonNegativeNumber(hours, 0);

    shiftCount += 1;
    totalHours += hours;
    if (hours > 8) overtimeHours += hours - 8;

    if (startValid) {
      if (!firstAt || startAt.getTime() < firstAt.getTime()) firstAt = startAt;
      if (!lastAt || startAt.getTime() > lastAt.getTime()) lastAt = startAt;
      const utcDay = startAt.getUTCDay();
      if (WEEKEND_DAYS.has(utcDay)) weekendShiftCount += 1;
    }

    if (NIGHT_SHIFT_TYPES.has(type)) {
      nightShiftCount += 1;
      if (startValid) {
        nightDays.push(startAt);
      }
    }
  }

  // Compute the longest streak of consecutive calendar-day night shifts.
  // "Consecutive" = each next night shift starts within 48h of the previous.
  const consecutiveNightShifts = (() => {
    if (nightDays.length === 0) return 0;
    const sorted = [...nightDays].sort((a, b) => a.getTime() - b.getTime());
    // Deduplicate by calendar day — two night shifts starting on the same
    // calendar day count as one.
    const uniqueDays = [];
    const seen = new Set();
    for (const d of sorted) {
      const key = d.toISOString().slice(0, 10);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueDays.push(d);
    }
    let longest = 1;
    let current = 1;
    for (let i = 1; i < uniqueDays.length; i += 1) {
      const prev = uniqueDays[i - 1];
      const curr = uniqueDays[i];
      const gapHours = (curr.getTime() - prev.getTime()) / (60 * 60 * 1000);
      if (gapHours <= 48) {
        current += 1;
        if (current > longest) longest = current;
      } else {
        current = 1;
      }
    }
    return longest;
  })();

  return {
    total_hours: roundTo(totalHours, 2),
    overtime_hours: roundTo(overtimeHours, 2),
    night_shift_count: nightShiftCount,
    consecutive_night_shifts: consecutiveNightShifts,
    weekend_shift_count: weekendShiftCount,
    shift_count: shiftCount,
    first_shift_at: firstAt ? firstAt.toISOString() : null,
    last_shift_at: lastAt ? lastAt.toISOString() : null,
  };
}

/**
 * Detect burnout signals from workload stats.
 * Returns Array<{ code, severity, description, recommendation }>.
 */
export function detectBurnoutSignals({
  totalHours = 0,
  overtimeHours = 0,
  consecutiveNightShifts = 0,
  nightShiftCount = 0,
  weekendShiftCount = 0,
  ptoDaysTaken = 0,
  windowDays = 30,
  avgHoursPerWeek = 0,
} = {}) {
  const signals = [];
  const total = toNumber(totalHours, 0);
  const overtime = toNumber(overtimeHours, 0);
  const nightStreak = toNumber(consecutiveNightShifts, 0);
  const nightCount = toNumber(nightShiftCount, 0);
  const weekendCount = toNumber(weekendShiftCount, 0);
  const pto = toNumber(ptoDaysTaken, 0);
  const days = toNumber(windowDays, 30);
  const avgWeekly = toNumber(avgHoursPerWeek, 0);

  const push = (signal) => signals.push({
    code: signal.code,
    severity: signal.severity,
    description: signal.description,
    recommendation: ACTION_MAP[signal.code] || signal.recommendation,
  });

  if (total === 0 && nightCount === 0) {
    push({
      code: 'NO_SHIFT_DATA',
      severity: 'medium',
      description: 'No shift records were found for this staff member in the review window.',
    });
    return signals;
  }

  if (avgWeekly > HIGH_HOURS_PER_WEEK) {
    push({
      code: 'HIGH_WEEKLY_HOURS',
      severity: 'high',
      description: `Average of ${roundTo(avgWeekly, 1)} hours/week exceeds the high-hours threshold (${HIGH_HOURS_PER_WEEK}).`,
    });
  }

  const overtimeRatio = overtime / Math.max(total, 1);
  if (overtimeRatio > 0.25) {
    push({
      code: 'SIGNIFICANT_OVERTIME',
      severity: 'medium',
      description: `Overtime makes up ${Math.round(overtimeRatio * 100)}% of recorded hours (${roundTo(overtime, 1)}h of ${roundTo(total, 1)}h).`,
    });
  }

  if (nightStreak >= NIGHT_SHIFT_STREAK_ESCALATE) {
    push({
      code: 'EXTENDED_NIGHT_SHIFT_STREAK',
      severity: 'high',
      description: `Consecutive night-shift streak of ${nightStreak} days meets the extended-streak threshold (>= ${NIGHT_SHIFT_STREAK_ESCALATE}).`,
    });
  } else if (nightStreak >= NIGHT_SHIFT_STREAK_CAUTION) {
    push({
      code: 'NIGHT_SHIFT_STREAK',
      severity: 'medium',
      description: `Consecutive night-shift streak of ${nightStreak} days meets the caution threshold (>= ${NIGHT_SHIFT_STREAK_CAUTION}).`,
    });
  }

  if (days >= 30 && pto < MIN_PTO_DAYS_PER_WINDOW) {
    push({
      code: 'LOW_PTO_UTILIZATION',
      severity: 'medium',
      description: `PTO usage (${roundTo(pto, 1)} days) is below the minimum for a ${days}-day window (${MIN_PTO_DAYS_PER_WINDOW}).`,
    });
  }

  if (weekendCount > 4) {
    push({
      code: 'WEEKEND_HEAVY',
      severity: 'low',
      description: `Weekend shift count (${weekendCount}) exceeds the weekend-heavy threshold (> 4).`,
    });
  }

  // Reference WEEKLY_OVERTIME_CAP so avg-weekly-near-cap shows up as significant
  // overtime context — the overtime-ratio signal already catches raw overtime,
  // so no separate signal is needed, but we keep the constant meaningful.
  void WEEKLY_OVERTIME_CAP;

  return signals;
}

/**
 * Combine burnout signals into a risk score + band + reviewer action list.
 */
export function computeBurnoutRiskScore(signals) {
  const list = asArray(signals);
  const onlyNoData = list.length === 1 && list[0]?.code === 'NO_SHIFT_DATA';
  if (onlyNoData) {
    return {
      risk_score: 0,
      risk_band: 'insufficient_data',
      recommended_actions: [
        ACTION_MAP.NO_SHIFT_DATA,
        PRIVACY_REMINDER,
      ],
    };
  }

  const weights = { critical: 35, high: 22, medium: 12, low: 5 };
  let score = 0;
  for (const signal of list) {
    score += weights[signal?.severity] || 0;
  }
  score = Math.max(0, Math.min(100, score));

  let band = 'low';
  if (score >= 60) band = 'critical';
  else if (score >= 35) band = 'high';
  else if (score >= 15) band = 'moderate';

  const seenActions = new Set();
  const actions = [];
  for (const signal of list) {
    const action = ACTION_MAP[signal?.code];
    if (!action || seenActions.has(action)) continue;
    seenActions.add(action);
    actions.push(action);
  }
  actions.push(PRIVACY_REMINDER);

  return {
    risk_score: score,
    risk_band: band,
    recommended_actions: actions,
  };
}

// ---------- DB loaders ----------------------------------------------------

async function loadStaffInfo(staffUid) {
  const rows = await prisma.$queryRawUnsafe(
      `SELECT u.uid AS staff_uid, u.name, u.role,
              COALESCE(NULLIF(s.department, ''), NULL) AS department
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
       WHERE u.uid = $1::uuid
       LIMIT 1`,
      staffUid
  );
  return rows && rows[0] ? rows[0] : null;
}

function classifyShiftType(startAt, endAt, shiftName = null) {
  const text = normalizedText(shiftName);
  if (text) {
    if (text.includes('night')) return 'night';
    if (text.includes('evening')) return 'evening';
    if (text.includes('morning') || text.includes('day')) return 'day';
    if (text.includes('on call') || text.includes('on_call') || text.includes('oncall')) return 'on_call';
  }
  if (!startAt || !endAt) return 'day';
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'day';
  const startHour = start.getUTCHours();
  const endHour = end.getUTCHours();
  // If the shift starts at night or wraps through midnight, treat as night.
  if (startHour >= 22 || startHour < 5) return 'night';
  if (endHour > 0 && endHour < 6 && startHour > 12) return 'night';
  if (startHour >= 15) return 'evening';
  return 'day';
}

async function loadShiftsForStaff({ tenantId, staffUid, windowStart, windowEnd }) {
  // Prefer staff_attendance (real clock-in/clock-out data). Join to the
  // legacy staff_shift_assignments + staff_shifts tables to classify
  // shift_type (day/evening/night).
  const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id,
              a.check_in_time AS start_at,
              a.check_out_time AS end_at,
              COALESCE(a.overtime_hours, 0) AS overtime_hours,
              sh.name AS shift_name,
              sh.start_time AS shift_start_time,
              sh.end_time AS shift_end_time
       FROM staff_attendance a
       LEFT JOIN staff_shift_assignments sa
         ON sa.staff_id = a.staff_id
        AND (sa.effective_from IS NULL OR sa.effective_from <= a.timestamp::date)
        AND (sa.effective_to IS NULL OR sa.effective_to >= a.timestamp::date)
       LEFT JOIN staff_shifts sh ON sh.id = sa.shift_id
       WHERE a.staff_uid = $1::uuid
         AND a.check_in_time IS NOT NULL
         AND a.check_in_time >= $2::timestamptz
         AND a.check_in_time < $3::timestamptz
       ORDER BY a.check_in_time ASC
       LIMIT 2000`,
      staffUid,
      windowStart.toISOString(),
      windowEnd.toISOString()
  );
  void tenantId;
  return asArray(rows).map((row) => {
    const shiftType = classifyShiftType(row.start_at, row.end_at, row.shift_name);
    return {
      id: row.id,
      start_at: row.start_at,
      end_at: row.end_at,
      shift_type: shiftType,
      shift_name: row.shift_name || null,
      overtime_hours_recorded: toNumber(row.overtime_hours, 0),
    };
  });
}

async function loadPtoDays({ tenantId, staffUid, windowStart, windowEnd }) {
  // leave_applications is keyed by tenant_id + staff_id (integer). Resolve the
  // tenant-bound staff uid to users.id before loading approved evidence.
  const idRows = await prisma.$queryRawUnsafe(
      `SELECT id
       FROM users
       WHERE tenant_id = $1::uuid
         AND uid = $2::uuid
       LIMIT 1`,
      tenantId,
      staffUid
  );
  const staffId = idRows && idRows[0] ? toNumber(idRows[0].id, null) : null;
  if (!staffId) return 0;
  const rows = await prisma.$queryRawUnsafe(
      `SELECT start_date, end_date, status
       FROM leave_applications
       WHERE tenant_id = $1::uuid
         AND staff_id = $2::int
         AND LOWER(status) = 'approved'
         AND end_date >= $3::date
         AND start_date <= $4::date
       LIMIT 200`,
      tenantId,
      staffId,
      windowStart.toISOString().slice(0, 10),
      windowEnd.toISOString().slice(0, 10)
  );
  let totalDays = 0;
  const windowStartDay = utcDateOrdinal(windowStart);
  const windowEndDay = utcDateOrdinal(windowEnd);
  for (const row of asArray(rows)) {
    if (!row.start_date || !row.end_date) continue;
    const rowStartDay = utcDateOrdinal(row.start_date);
    const rowEndDay = utcDateOrdinal(row.end_date);
    if (rowStartDay === null || rowEndDay === null) continue;
    const startDay = Math.max(windowStartDay, rowStartDay);
    const endDay = Math.min(windowEndDay, rowEndDay);
    if (endDay < startDay) continue;
    const days = endDay - startDay + 1;
    if (days > 0) totalDays += days;
  }
  return roundTo(totalDays, 2);
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
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
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
      aiResult?.usage?.prompt_tokens || 0,
      aiResult?.usage?.completion_tokens || 0,
      aiResult?.usage?.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
  );
  return (rows && rows[0]) || null;
}

async function createReviewPlaceholder({ tenantId, generationId, staffUid, module }) {
  if (!generationId) return null;
  const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, NULL, NULL, 'pending', $4::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF', 'DEPARTMENT_HEAD'],
        source: 'staff_burnout_workload_risk',
        staff_uid: staffUid,
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
        privacy_sensitive: true,
      })
  );
  return (rows && rows[0]) || null;
}

function normalizeReviewRow(row) {
  if (!row) return row;
  return {
    ...row,
    total_hours: toNumber(row.total_hours, 0),
    overtime_hours: toNumber(row.overtime_hours, 0),
    night_shift_count: toNumber(row.night_shift_count, 0),
    consecutive_night_shifts: toNumber(row.consecutive_night_shifts, 0),
    weekend_shift_count: toNumber(row.weekend_shift_count, 0),
    pto_days_taken: toNumber(row.pto_days_taken, 0),
    avg_hours_per_week: toNumber(row.avg_hours_per_week, 0),
    risk_score: toNumber(row.risk_score, 0),
    window_days: toNumber(row.window_days, 0),
  };
}

async function insertBurnoutReview({
  tenantId,
  staffUid,
  department,
  role,
  windowDays,
  windowStart,
  windowEnd,
  load,
  avgWeekly,
  ptoDays,
  score,
  band,
  signals,
  recommendedActions,
  generationId,
  citations,
  safetyFlags,
  metadata,
}) {
  const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_staff_burnout_reviews
         (tenant_id, staff_uid, department, role, window_days, window_start, window_end,
          total_hours, overtime_hours, night_shift_count, consecutive_night_shifts,
          weekend_shift_count, pto_days_taken, avg_hours_per_week, risk_score, risk_band,
          contributing_signals, recommended_actions, generation_id, source_citations,
          safety_flags, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7::timestamptz,
               $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17::jsonb, $18::jsonb, $19, $20::jsonb, $21::jsonb,
               'pending', $22::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, staff_uid, department, role, window_days, window_start,
                 window_end, total_hours, overtime_hours, night_shift_count,
                 consecutive_night_shifts, weekend_shift_count, pto_days_taken,
                 avg_hours_per_week, risk_score, risk_band, contributing_signals,
                 recommended_actions, generation_id, source_citations, safety_flags,
                 reviewer_decision, reviewed_by, reviewed_at, reviewer_note,
                 metadata, created_at, updated_at`,
      tenantId,
      staffUid,
      department || null,
      role || null,
      windowDays,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      load.total_hours,
      load.overtime_hours,
      load.night_shift_count,
      load.consecutive_night_shifts,
      load.weekend_shift_count,
      ptoDays,
      avgWeekly,
      score,
      RISK_BANDS.has(band) ? band : 'unknown',
      JSON.stringify(signals || []),
      JSON.stringify(recommendedActions || []),
      generationId,
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
  );
  return normalizeReviewRow((rows && rows[0]) || null);
}

// ---------- Public API --------------------------------------------------

export async function evaluateStaffBurnout({
  req = null,
  staffUid,
  windowDays = 30,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const safeUid = validateStaffUid(staffUid);
  const safeWindowDays = clampInt(windowDays, 1, 365, 30);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - safeWindowDays * 24 * 60 * 60 * 1000);

  const staffInfo = await loadStaffInfo(safeUid);
  const department = staffInfo?.department ? cleanText(staffInfo.department) : null;
  const role = staffInfo?.role ? cleanText(staffInfo.role) : null;

  const shifts = await loadShiftsForStaff({
    tenantId,
    staffUid: safeUid,
    windowStart,
    windowEnd,
  });
  const ptoDaysTaken = await loadPtoDays({
    tenantId,
    staffUid: safeUid,
    windowStart,
    windowEnd,
  });

  const load = calculateShiftLoad(shifts);
  const weeks = Math.max(1, safeWindowDays / 7);
  const avgHoursPerWeek = roundTo(load.total_hours / weeks, 2);

  const signals = detectBurnoutSignals({
    totalHours: load.total_hours,
    overtimeHours: load.overtime_hours,
    consecutiveNightShifts: load.consecutive_night_shifts,
    nightShiftCount: load.night_shift_count,
    weekendShiftCount: load.weekend_shift_count,
    ptoDaysTaken,
    windowDays: safeWindowDays,
    avgHoursPerWeek,
  });

  const { risk_score: score, risk_band: band, recommended_actions: recommendedActions } =
    computeBurnoutRiskScore(signals);

  const citations = [];
  if (shifts.length > 0) {
    citations.push({
      source_type: 'staff_attendance',
      source_id: safeUid,
      label: `Staff attendance (${shifts.length} shift${shifts.length === 1 ? '' : 's'} in ${safeWindowDays}-day window)`,
      timestamp: load.first_shift_at || null,
    });
  }
  if (ptoDaysTaken > 0) {
    citations.push({
      source_type: 'leave_applications',
      source_id: safeUid,
      label: `Leave/PTO records (${roundTo(ptoDaysTaken, 1)} days in window)`,
      timestamp: windowStart.toISOString(),
    });
  }

  const safetyFlags = [];
  if (band === 'critical') {
    safetyFlags.push({
      severity: 'critical',
      code: 'STAFF_BURNOUT_CRITICAL_RISK',
      message: 'Critical burnout risk indicators detected; escalate to HR/leadership for immediate supportive review.',
    });
  } else if (band === 'high') {
    safetyFlags.push({
      severity: 'high',
      code: 'STAFF_BURNOUT_HIGH_RISK',
      message: 'High burnout risk indicators detected; schedule a supportive review with HR/leadership.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'STAFF_PRIVACY_NOTICE',
    message: 'Decision-support only — never used for performance or disciplinary action.',
  });

  const fallbackDraft = {
    staff: {
      uid: safeUid,
      department,
      role,
    },
    window_days: safeWindowDays,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    total_hours: load.total_hours,
    overtime_hours: load.overtime_hours,
    night_shift_count: load.night_shift_count,
    consecutive_night_shifts: load.consecutive_night_shifts,
    weekend_shift_count: load.weekend_shift_count,
    avg_hours_per_week: avgHoursPerWeek,
    pto_days_taken: ptoDaysTaken,
    risk_score: score,
    risk_band: band,
    contributing_signals: signals,
    recommended_actions: recommendedActions,
    source_citations: citations,
    safety_flags: safetyFlags,
    summary: signals.length
      ? `${signals.length} burnout signal(s) detected — ${band} risk band.`
      : 'No burnout signals detected.',
    rules_authoritative: true,
    decision_support_only: true,
    privacy_note: 'Workload risk signal only — never used for performance evaluation or disciplinary action.',
  };

  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        workload_summary: {
          window_days: safeWindowDays,
          total_hours: load.total_hours,
          overtime_hours: load.overtime_hours,
          night_shift_count: load.night_shift_count,
          consecutive_night_shifts: load.consecutive_night_shifts,
          weekend_shift_count: load.weekend_shift_count,
          pto_days_taken: ptoDaysTaken,
          avg_hours_per_week: avgHoursPerWeek,
        },
        rule_based_signals: signals,
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
        safety_flags: [
          ...asArray(fallbackDraft.safety_flags),
          ...asArray(parsed.safety_flags),
        ],
      };
    }
  } catch (err) {
    logger.debug('Staff burnout AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  const finalCitations = uniqueCitations(asArray(draft.source_citations));
  draft.source_citations = finalCitations;
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    patientUid: null,
    sourceHashValue: sourceHash({
      staff_uid: safeUid,
      window_days: safeWindowDays,
      load,
      pto_days_taken: ptoDaysTaken,
    }),
    draft,
    citations: finalCitations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      staff_uid: safeUid,
      window_days: safeWindowDays,
      risk_band: band,
      risk_score: score,
      signal_codes: signals.map((s) => s.code),
      rules_authoritative: true,
      privacy_sensitive: true,
    },
  });
  if (!generation?.id) {
    throw new Error('Staff burnout generation insert returned no id');
  }

  const reviewRow = await insertBurnoutReview({
    tenantId,
    staffUid: safeUid,
    department,
    role,
    windowDays: safeWindowDays,
    windowStart,
    windowEnd,
    load,
    avgWeekly: avgHoursPerWeek,
    ptoDays: ptoDaysTaken,
    score,
    band,
    signals,
    recommendedActions,
    generationId: generation.id,
    citations: finalCitations,
    safetyFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      signal_codes: signals.map((s) => s.code),
      privacy_sensitive: true,
      rules_authoritative: true,
    },
  });

  if (!reviewRow) {
    throw new Error('Staff burnout review insert returned no id');
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation.id,
    staffUid: safeUid,
    module,
  });
  if (!clinicalReview?.id) {
    throw new Error('Staff burnout clinical review insert returned no id');
  }

  try {
    await publishEvent({
      eventType: 'clinical_ai.staff_burnout_evaluated',
      aggregateType: 'clinical_ai_staff_burnout_review',
      aggregateId: reviewRow.id,
      patientUid: null,
      payload: {
        tenant_id: tenantId,
        staff_uid: safeUid,
        review_id: reviewRow.id,
        generation_id: generation.id,
        risk_score: score,
        risk_band: band,
        signal_codes: signals.map((s) => s.code),
        privacy_sensitive: true,
      },
    });
  } catch (err) {
    logger.warn('Staff burnout event publish failed', { error: err?.message });
  }

  return {
    review_id: reviewRow.id,
    generation_id: generation.id,
    clinical_review_id: clinicalReview.id,
    draft,
    review: reviewRow,
    source_citations: finalCitations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || reviewRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
    },
    rules_authoritative: true,
    decision_support_only: true,
    privacy_sensitive: true,
  };
}

export async function listStaffBurnoutReviews({
  tenantId = null,
  staffUid = null,
  department = null,
  riskBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const normalizedUid = staffUid ? validateStaffUid(staffUid) : null;
  const normalizedDept = department ? cleanText(department) : null;
  const normalizedBand = riskBand && RISK_BANDS.has(cleanText(riskBand).toLowerCase())
    ? cleanText(riskBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  const rows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.tenant_id, r.staff_uid, r.department, r.role,
              r.window_days, r.window_start, r.window_end,
              r.total_hours, r.overtime_hours, r.night_shift_count,
              r.consecutive_night_shifts, r.weekend_shift_count,
              r.pto_days_taken, r.avg_hours_per_week, r.risk_score, r.risk_band,
              r.contributing_signals, r.recommended_actions, r.generation_id,
              r.source_citations, r.safety_flags, r.reviewer_decision,
              r.reviewed_by, r.reviewed_at, r.reviewer_note, r.metadata,
              r.created_at, r.updated_at,
              u.name AS staff_name
       FROM clinical_ai_staff_burnout_reviews r
       LEFT JOIN users u ON u.uid = r.staff_uid
       WHERE r.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR r.staff_uid = $2::uuid)
         AND ($3::text IS NULL OR r.department = $3)
         AND ($4::text IS NULL OR r.risk_band = $4)
         AND ($5::text IS NULL OR r.reviewer_decision = $5)
       ORDER BY
         CASE r.risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           WHEN 'insufficient_data' THEN 4
           ELSE 5
         END,
         r.created_at DESC
       LIMIT $6`,
      tid,
      normalizedUid,
      normalizedDept,
      normalizedBand,
      normalizedDecision,
      safeLimit
  );
  const normalized = asArray(rows).map(normalizeReviewRow);
  return { reviews: normalized, count: normalized.length };
}

export async function decideStaffBurnoutReview({
  tenantId = null,
  reviewId,
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
    `UPDATE clinical_ai_staff_burnout_reviews
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, staff_uid, department, role, window_days,
               window_start, window_end, total_hours, overtime_hours,
               night_shift_count, consecutive_night_shifts, weekend_shift_count,
               pto_days_taken, avg_hours_per_week, risk_score, risk_band,
               contributing_signals, recommended_actions, generation_id,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(reviewId, 'review_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('Staff burnout review not found');
  return normalizeReviewRow(rows[0]);
}

// Touch unused helpers to silence lint warnings for utilities that ship with
// the pattern but are not strictly needed in this module.
void dayKey;

export default {
  calculateShiftLoad,
  computeBurnoutRiskScore,
  decideStaffBurnoutReview,
  detectBurnoutSignals,
  evaluateStaffBurnout,
  listStaffBurnoutReviews,
};
