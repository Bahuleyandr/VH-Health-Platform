import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  getRosterDepartmentPolicy,
  normalizeRosterDepartment,
} from '../../config/rosterDepartmentConfig.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { generateClinicalText } from './localLlmClient.js';

export const STAFF_LEAVE_FORECAST_MODULE_KEY = 'staff_roster_optimizer';
const DEFAULT_FORECAST_DAYS = 84;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STAFF_SCORE_LIMIT = 500;

const COMMUTE_BAND_WEIGHTS = {
  unknown: 0,
  onsite: 0,
  near: 2,
  medium: 6,
  long: 12,
  very_long: 18,
};

const WEATHER_SEVERITY_WEIGHTS = {
  normal: 0,
  watch: 5,
  moderate: 10,
  high: 18,
  severe: 28,
};

function resolveTenantId(tenantId) {
  return requireTenantId(tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist|column .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeDepartment(department) {
  return normalizeRosterDepartment(cleanText(department, 'housekeeping'));
}

function rolesForDepartment(department) {
  return getRosterDepartmentPolicy(department)?.staffRoles || [];
}

function assertIsoDate(value, fieldName) {
  const text = cleanText(value);
  if (!ISO_DATE.test(text)) {
    throw AppError.badRequest(`${fieldName} must be YYYY-MM-DD`);
  }
  return text;
}

function addDays(dateText, amount) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  const days = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    days.push(date);
  }
  return days;
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}

function scoreToBand(score) {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function normalizeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function stableHash(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function overlapsDate(row, dateText, startKey = 'start_date', endKey = 'end_date') {
  const start = cleanText(row?.[startKey]);
  const end = cleanText(row?.[endKey], start);
  return start <= dateText && end >= dateText;
}

function sourceState(count, unavailable = false) {
  if (unavailable) return 'schema-unavailable';
  return count > 0 ? 'available' : 'empty';
}

function eventAppliesToDepartment(event, department) {
  const applies = Array.isArray(event.applies_departments)
    ? event.applies_departments
    : normalizeJson(event.applies_departments, []);
  if (!applies.length) return true;
  return applies.map((item) => normalizeDepartment(item)).includes(normalizeDepartment(department));
}

function factor(code, label, weight, source, dates = []) {
  return {
    code,
    label,
    weight: clamp(weight, 0, 100),
    source,
    dates: dates.slice(0, 8),
  };
}

function topFactors(factors, limit = 5) {
  return [...factors]
    .filter((item) => Number(item.weight) > 0)
    .sort((a, b) => Number(b.weight) - Number(a.weight))
    .slice(0, limit);
}

function leaveDatesFor(rows, forecastDates, status = null) {
  const result = [];
  for (const dateText of forecastDates) {
    if (rows.some((row) => overlapsDate(row, dateText) && (!status || cleanText(row.leave_status).toLowerCase() === status))) {
      result.push(dateText);
    }
  }
  return result;
}

function calendarRiskForDate(events, dateText, department) {
  const matching = events.filter((event) => overlapsDate(event, dateText) && eventAppliesToDepartment(event, department));
  const weight = matching.reduce((max, event) => Math.max(max, Number(event.risk_weight || 0)), 0);
  return {
    weight: clamp(weight, 0, 40),
    events: matching.map((event) => ({
      id: event.id,
      title: event.title,
      event_type: event.event_type,
      risk_weight: Number(event.risk_weight || 0),
    })).slice(0, 5),
  };
}

function weatherRiskForDate(signals, dateText) {
  const matching = signals.filter((signal) => cleanText(signal.signal_date) === dateText);
  const weight = matching.reduce((max, signal) => {
    const severity = cleanText(signal.severity, 'normal').toLowerCase();
    return Math.max(max, Number(signal.risk_weight ?? WEATHER_SEVERITY_WEIGHTS[severity] ?? 0));
  }, 0);
  return {
    weight: clamp(weight, 0, 40),
    signals: matching.map((signal) => ({
      id: signal.id,
      signal_type: signal.signal_type,
      severity: signal.severity,
      provider_status: signal.provider_status,
      risk_weight: Number(signal.risk_weight || 0),
    })).slice(0, 5),
  };
}

function reasonSuggestsSeasonalLeave(reason) {
  return /(festival|holiday|school|exam|travel|marriage|function|christmas|diwali|eid|pongal|vacation|family)/i.test(
    cleanText(reason)
  );
}

export function scoreStaffLeaveRisk({
  staff,
  forecastDates,
  department,
  leaveRows = [],
  rosterRequests = [],
  rosterLoad = {},
  calendarEvents = [],
  weatherSignals = [],
  commuteProfile = null,
} = {}) {
  const approvedLeaves = leaveRows.filter((row) => cleanText(row.leave_status).toLowerCase() === 'approved');
  const pendingLeaves = leaveRows.filter((row) => cleanText(row.leave_status).toLowerCase() === 'pending');
  const historicalLeaves = leaveRows.filter((row) => cleanText(row.leave_status).toLowerCase() !== 'rejected');
  const knownApprovedDates = leaveDatesFor(approvedLeaves, forecastDates, 'approved');
  const pendingDates = leaveDatesFor(pendingLeaves, forecastDates, 'pending');
  const seasonalReasonCount = historicalLeaves.filter((row) => reasonSuggestsSeasonalLeave(row.reason)).length;
  const requestCount = rosterRequests.length;
  const nightShiftCount = Number(rosterLoad.night_shift_count || 0);
  const recentShiftCount = Number(rosterLoad.recent_shift_count || 0);
  const commuteBand = cleanText(commuteProfile?.commute_band, 'unknown').toLowerCase();
  const commuteWeight = clamp(
    Number(commuteProfile?.risk_weight ?? COMMUTE_BAND_WEIGHTS[commuteBand] ?? 0),
    0,
    30
  );

  const factors = [];
  let score = 8;

  if (historicalLeaves.length > 0) {
    const weight = clamp(historicalLeaves.length * 4, 4, 20);
    score += weight;
    factors.push(factor('leave_history', `${historicalLeaves.length} historical leave record${historicalLeaves.length === 1 ? '' : 's'}`, weight, 'leave_applications'));
  }
  if (pendingDates.length > 0) {
    const weight = clamp(18 + pendingDates.length, 18, 28);
    score += weight;
    factors.push(factor('pending_leave', 'Pending leave overlaps this forecast window', weight, 'leave_applications', pendingDates));
  }
  if (knownApprovedDates.length > 0) {
    const weight = clamp(50 + knownApprovedDates.length, 50, 70);
    score += weight;
    factors.push(factor('approved_leave', 'Approved leave already creates known coverage need', weight, 'leave_applications', knownApprovedDates));
  }
  if (seasonalReasonCount > 0) {
    const weight = clamp(seasonalReasonCount * 3, 3, 12);
    score += weight;
    factors.push(factor('seasonal_reasons', 'Prior reasons mention travel, festival, school, or family events', weight, 'leave_applications'));
  }
  if (requestCount > 0) {
    const weight = clamp(requestCount * 5, 5, 15);
    score += weight;
    factors.push(factor('duty_preferences', 'Pending or approved duty preference requests', weight, 'staff_shift_roster_requests'));
  }
  if (nightShiftCount >= 2) {
    const weight = clamp(nightShiftCount * 3, 6, 15);
    score += weight;
    factors.push(factor('night_load', `${nightShiftCount} recent night shift${nightShiftCount === 1 ? '' : 's'}`, weight, 'staff_shift_roster_assignments'));
  }
  if (recentShiftCount >= 6) {
    const weight = clamp(recentShiftCount - 4, 2, 10);
    score += weight;
    factors.push(factor('recent_load', `${recentShiftCount} recent roster assignment${recentShiftCount === 1 ? '' : 's'}`, weight, 'staff_shift_roster_assignments'));
  }
  if (commuteWeight > 0) {
    score += commuteWeight;
    factors.push(factor('commute', `${commuteBand.replace('_', ' ')} commute profile`, commuteWeight, 'staff_commute_profiles'));
  }

  const dateRisks = forecastDates.map((dateText) => {
    const calendarRisk = calendarRiskForDate(calendarEvents, dateText, department);
    const weatherRisk = weatherRiskForDate(weatherSignals, dateText);
    const approvedOnDate = approvedLeaves.some((row) => overlapsDate(row, dateText));
    const pendingOnDate = pendingLeaves.some((row) => overlapsDate(row, dateText));
    const dateScore = clamp(
      (score * 0.35)
        + calendarRisk.weight
        + weatherRisk.weight
        + (approvedOnDate ? 45 : 0)
        + (pendingOnDate ? 20 : 0),
      0,
      100
    );
    return {
      date: dateText,
      score: Math.round(dateScore),
      risk_band: scoreToBand(dateScore),
      known_approved_leave: approvedOnDate,
      pending_leave: pendingOnDate,
      calendar_events: calendarRisk.events,
      weather_signals: weatherRisk.signals,
    };
  });

  const sourceCount = [
    historicalLeaves.length,
    rosterRequests.length,
    recentShiftCount,
    calendarEvents.length,
    weatherSignals.length,
    commuteProfile?.id ? 1 : 0,
  ].filter(Boolean).length;
  const finalScore = Math.round(clamp(score, 0, 100));
  const confidence = Math.round(clamp(35 + (sourceCount * 9) + Math.min(historicalLeaves.length * 2, 16), 35, 92));

  return {
    staff_id: Number(staff.id),
    staff_uid: staff.uid || null,
    staff_name: staff.name || null,
    staff_role: staff.role || null,
    score: finalScore,
    risk_band: scoreToBand(finalScore),
    confidence_pct: confidence,
    top_factors: topFactors(factors),
    date_risks: dateRisks,
    source_snapshot: {
      leave_record_count: historicalLeaves.length,
      pending_leave_count: pendingLeaves.length,
      approved_leave_count: approvedLeaves.length,
      roster_request_count: rosterRequests.length,
      recent_shift_count: recentShiftCount,
      night_shift_count: nightShiftCount,
      commute_band: commuteBand,
      source_count: sourceCount,
    },
  };
}

export function summarizeShiftRisks({ scores, forecastDates, department } = {}) {
  return forecastDates.map((dateText) => {
    const dateRows = scores.map((score) => score.date_risks.find((risk) => risk.date === dateText)).filter(Boolean);
    const highRiskCount = dateRows.filter((risk) => risk.risk_band === 'high').length;
    const mediumRiskCount = dateRows.filter((risk) => risk.risk_band === 'medium').length;
    const knownAbsences = dateRows.filter((risk) => risk.known_approved_leave).length;
    const pendingAbsences = dateRows.filter((risk) => risk.pending_leave).length;
    const weatherFactors = dateRows.flatMap((risk) => risk.weather_signals || []);
    const calendarFactors = dateRows.flatMap((risk) => risk.calendar_events || []);
    const averageScore = dateRows.length
      ? dateRows.reduce((sum, risk) => sum + Number(risk.score || 0), 0) / dateRows.length
      : 0;
    const riskScore = clamp(
      averageScore + (highRiskCount * 4) + (knownAbsences * 5) + (pendingAbsences * 3),
      0,
      100
    );
    const top = [
      ...calendarFactors.map((event) => factor('calendar_event', event.title, event.risk_weight || 10, 'roster_calendar_events', [dateText])),
      ...weatherFactors.map((signal) => factor('weather_signal', `${signal.severity} ${signal.signal_type}`, signal.risk_weight || 8, 'roster_weather_signals', [dateText])),
      knownAbsences ? factor('known_absence', `${knownAbsences} approved leave${knownAbsences === 1 ? '' : 's'}`, knownAbsences * 8, 'leave_applications', [dateText]) : null,
      pendingAbsences ? factor('pending_absence', `${pendingAbsences} pending leave${pendingAbsences === 1 ? '' : 's'}`, pendingAbsences * 5, 'leave_applications', [dateText]) : null,
    ].filter(Boolean);
    return {
      department,
      forecast_date: dateText,
      shift_label: 'all',
      risk_score: Math.round(riskScore),
      risk_band: scoreToBand(riskScore),
      predicted_absences: knownAbsences + pendingAbsences,
      recommended_buffer_count: Math.max(0, Math.ceil((highRiskCount + mediumRiskCount * 0.5 + knownAbsences) / 4)),
      top_factors: topFactors(top, 4),
      source_snapshot: {
        staff_scored: scores.length,
        high_risk_staff_count: highRiskCount,
        medium_risk_staff_count: mediumRiskCount,
        known_absences: knownAbsences,
        pending_absences: pendingAbsences,
      },
    };
  });
}

async function resolveActor(user) {
  if (!user?.uid) return { id: Number(user?.id) || null, uid: null };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid FROM users WHERE uid = $1::uuid LIMIT 1`,
    user.uid
  ).catch(() => []);
  return rows[0] || { id: Number(user?.id) || null, uid: user.uid };
}

async function loadStaffPool({ tenantId, department }) {
  const roles = rolesForDepartment(department);
  if (!roles.length) {
    throw AppError.notFound('Roster department is not configured for forecasting');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.role,
            s.employee_id, s.department, s.position, s.designation
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE u.is_active = true
        AND u.tenant_id = $1::uuid
        AND u.role = ANY($2::text[])
      ORDER BY u.role, u.name
      LIMIT ${STAFF_SCORE_LIMIT}`,
    tenantId,
    roles
  ).catch(async (err) => {
    if (!isMissingSchemaError(err)) throw err;
    return prisma.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.name, u.role,
              s.employee_id, s.department, s.position, s.designation
         FROM users u
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE u.is_active = true
          AND u.role = ANY($1::text[])
        ORDER BY u.role, u.name
        LIMIT ${STAFF_SCORE_LIMIT}`,
      roles
    );
  });
  return rows || [];
}

async function loadLeaveRows({ staffIds, startDate, endDate }) {
  if (!staffIds.length) return [];
  const lookbackStart = addDays(startDate, -365);
  return prisma.$queryRawUnsafe(
    `SELECT la.id AS leave_application_id,
            la.staff_id,
            LOWER(la.status) AS leave_status,
            la.leave_type,
            la.reason,
            la.start_date::text AS start_date,
            la.end_date::text AS end_date,
            la.created_at
       FROM leave_applications la
      WHERE la.staff_id = ANY($1::int[])
        AND la.end_date >= $2::date
        AND la.start_date <= $3::date
      ORDER BY la.staff_id, la.start_date DESC`,
    staffIds,
    lookbackStart,
    endDate
  ).catch((err) => {
    if (isMissingSchemaError(err)) return [];
    throw err;
  });
}

async function loadRosterRequests({ staffIds, department, startDate, endDate }) {
  if (!staffIds.length) return [];
  return prisma.$queryRawUnsafe(
    `SELECT id, staff_id, status, request_type, period_type, shift_label,
            reason, requested_start_date::text AS requested_start_date,
            requested_end_date::text AS requested_end_date
       FROM staff_shift_roster_requests
      WHERE department = $1
        AND staff_id = ANY($2::int[])
        AND requested_start_date <= $4::date
        AND requested_end_date >= $3::date
        AND status IN ('pending', 'approved')
      ORDER BY created_at DESC`,
    department,
    staffIds,
    startDate,
    endDate
  ).catch((err) => {
    if (isMissingSchemaError(err)) return [];
    throw err;
  });
}

async function loadRosterLoad({ staffIds, department, startDate }) {
  if (!staffIds.length) return new Map();
  const lookbackStart = addDays(startDate, -28);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.staff_id,
            COUNT(*)::int AS recent_shift_count,
            COUNT(*) FILTER (WHERE LOWER(b.shift_label) LIKE '%night%')::int AS night_shift_count
       FROM staff_shift_roster_assignments a
       JOIN staff_shift_roster_boards b ON b.id = a.roster_id
      WHERE a.staff_id = ANY($1::int[])
        AND b.department = $2
        AND b.roster_date >= $3::date
        AND b.roster_date < $4::date
        AND a.status IN ('planned', 'published')
      GROUP BY a.staff_id`,
    staffIds,
    department,
    lookbackStart,
    startDate
  ).catch((err) => {
    if (isMissingSchemaError(err)) return [];
    throw err;
  });
  return new Map(rows.map((row) => [Number(row.staff_id), row]));
}

async function loadCalendarEvents({ tenantId, department, startDate, endDate }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, title, event_type, start_date::text AS start_date, end_date::text AS end_date,
            risk_weight, applies_departments, notes
       FROM roster_calendar_events
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND start_date <= $3::date
        AND end_date >= $2::date
      ORDER BY start_date ASC, risk_weight DESC`,
    tenantId,
    startDate,
    endDate
  );
  return rows.filter((event) => eventAppliesToDepartment(event, department));
}

async function loadCommuteProfiles({ tenantId, staffIds }) {
  if (!staffIds.length) return new Map();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, staff_id, staff_uid, commute_band, travel_mode, area_label, risk_weight, notes
       FROM staff_commute_profiles
      WHERE tenant_id = $1::uuid
        AND staff_id = ANY($2::int[])
        AND is_active = true`,
    tenantId,
    staffIds
  );
  return new Map(rows.map((row) => [Number(row.staff_id), row]));
}

async function loadWeatherSignals({ tenantId, startDate, endDate }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, signal_date::text AS signal_date, area_label, signal_type, severity,
            provider, provider_status, confidence_pct, risk_weight, is_manual, notes
       FROM roster_weather_signals
      WHERE tenant_id = $1::uuid
        AND signal_date >= $2::date
        AND signal_date <= $3::date
      ORDER BY signal_date ASC, risk_weight DESC`,
    tenantId,
    startDate,
    endDate
  );
}

async function loadSourceData({ tenantId, department, startDate, endDate }) {
  const staff = await loadStaffPool({ tenantId, department });
  const staffIds = staff.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
  const [leaveRows, rosterRequests, rosterLoad, calendarEvents, commuteProfiles, weatherSignals] = await Promise.all([
    loadLeaveRows({ staffIds, startDate, endDate }),
    loadRosterRequests({ staffIds, department, startDate, endDate }),
    loadRosterLoad({ staffIds, department, startDate }),
    loadCalendarEvents({ tenantId, department, startDate, endDate }),
    loadCommuteProfiles({ tenantId, staffIds }),
    loadWeatherSignals({ tenantId, startDate, endDate }),
  ]);
  return {
    staff,
    leaveRows,
    rosterRequests,
    rosterLoad,
    calendarEvents,
    commuteProfiles,
    weatherSignals,
    sourceBreakdown: {
      staff_pool: { state: sourceState(staff.length), count: staff.length },
      leave_history: { state: sourceState(leaveRows.length), count: leaveRows.length },
      roster_requests: { state: sourceState(rosterRequests.length), count: rosterRequests.length },
      roster_load: { state: sourceState(rosterLoad.size), count: rosterLoad.size },
      admin_calendar: { state: sourceState(calendarEvents.length), count: calendarEvents.length },
      commute_profiles: { state: sourceState(commuteProfiles.size), count: commuteProfiles.size },
      weather_forecasts: { state: sourceState(weatherSignals.length), count: weatherSignals.length },
    },
  };
}

function groupByStaffId(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.staff_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function buildFallbackSummary({ department, scores, shiftRisks, sourceBreakdown }) {
  const highStaff = scores.filter((score) => score.risk_band === 'high').length;
  const mediumStaff = scores.filter((score) => score.risk_band === 'medium').length;
  const highDays = shiftRisks.filter((risk) => risk.risk_band === 'high').length;
  const maxBuffer = shiftRisks.reduce((max, risk) => Math.max(max, risk.recommended_buffer_count), 0);
  const sourceNames = Object.entries(sourceBreakdown)
    .filter(([, value]) => value.state === 'available')
    .map(([key]) => key.replace(/_/g, ' '));
  return {
    title: `${department} leave and roster forecast`,
    narrative: highDays > 0
      ? `${highDays} day${highDays === 1 ? '' : 's'} show high staffing risk. Plan up to ${maxBuffer} buffer staff where possible.`
      : `No high-risk days detected. Keep ${mediumStaff} medium-risk staff under review while approving the weekly roster.`,
    high_risk_staff_count: highStaff,
    medium_risk_staff_count: mediumStaff,
    high_risk_day_count: highDays,
    recommended_max_buffer: maxBuffer,
    source_labels: sourceNames,
    decision_support_only: true,
  };
}

async function generateNarrative({ tenantId, department, startDate, endDate, summary, sourceBreakdown }) {
  const systemPrompt = [
    'You are an operations roster assistant for a hospital.',
    'Summarize staffing risk for HR/incharge review only.',
    'Do not approve or deny leave. Do not recommend punishment or payroll actions.',
    'Mention that the output is advisory and human-reviewed.',
  ].join(' ');
  const userPrompt = JSON.stringify({
    department,
    start_date: startDate,
    end_date: endDate,
    aggregate_summary: summary,
    source_breakdown: sourceBreakdown,
  });
  try {
    const aiResult = await generateClinicalText({
      systemPrompt,
      userPrompt,
      taskType: STAFF_LEAVE_FORECAST_MODULE_KEY,
      tenantId,
    });
    if (aiResult.usedAi && cleanText(aiResult.text)) {
      return { aiResult, narrative: cleanText(aiResult.text) };
    }
    return { aiResult, narrative: summary.narrative };
  } catch (err) {
    logger.warn('Staff leave forecast AI narrative failed', { error: err.message });
    return {
      aiResult: {
        usedAi: false,
        provider: 'template',
        model: null,
        generation_mode: 'template_fallback',
        provider_status: 'error',
        fallback_reason: err.message,
        reason: err.message,
        usage: {},
      },
      narrative: summary.narrative,
    };
  }
}

async function insertGeneration({ tenantId, actor, summary, sourceHashValue, sourceBreakdown, aiResult }) {
  const usage = aiResult?.usage || {};
  const metadata = {
    tier: aiResult?.tier || 'quick',
    model_tier: aiResult?.tier || 'quick',
    generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'template_fallback'),
    provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'template_fallback'),
    fallback_reason: aiResult?.usedAi ? null : aiResult?.fallback_reason || aiResult?.reason || 'deterministic_rules_forecast',
    source_breakdown: sourceBreakdown,
    decision_support_only: true,
    payroll_or_discipline_use: false,
  };
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
        prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
        generated_by, prompt_tokens, completion_tokens, total_tokens,
        estimated_cost_minor, metadata, created_at, updated_at)
     VALUES ($1::uuid, NULL, NULL, $2, $2, $3, $4,
             'staff-leave-forecast-v1', $5, 'draft', $6, '[]'::jsonb, $7::jsonb, $8::jsonb,
             $9::uuid, $10, $11, $12, $13, $14::jsonb, NOW(), NOW())
     RETURNING id`,
    tenantId,
    STAFF_LEAVE_FORECAST_MODULE_KEY,
    aiResult?.provider || 'template',
    aiResult?.model || null,
    sourceHashValue,
    Boolean(aiResult?.usedAi),
    JSON.stringify([
      { source: 'leave_applications', label: 'Historical leave and reasons' },
      { source: 'roster_calendar_events', label: 'Admin calendar' },
      { source: 'staff_commute_profiles', label: 'Coarse commute band' },
      { source: 'roster_weather_signals', label: 'Climate/weather signal' },
    ]),
    JSON.stringify(summary),
    actor.uid,
    usage.prompt_tokens || 0,
    usage.completion_tokens || 0,
    usage.total_tokens || 0,
    aiResult?.estimatedCostMinor ?? 0,
    JSON.stringify(metadata)
  );
  return rows[0]?.id || null;
}

async function insertAudit({ tenantId, runId, actor, action, reason = null, before = {}, after = {} }) {
  await prisma.$queryRawUnsafe(
    `INSERT INTO staff_leave_forecast_audit
       (tenant_id, run_id, actor_id, actor_uid, action, reason, before_snapshot, after_snapshot, created_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8::jsonb, NOW())`,
    tenantId,
    runId,
    actor?.id || null,
    actor?.uid || null,
    action,
    reason,
    JSON.stringify(before || {}),
    JSON.stringify(after || {})
  ).catch((err) => {
    if (!isMissingSchemaError(err)) throw err;
  });
}

async function persistForecast({ tenantId, department, startDate, endDate, actor, scores, shiftRisks, summary, sourceBreakdown, aiResult, sourceHashValue }) {
  const generationId = await insertGeneration({
    tenantId,
    actor,
    summary,
    sourceHashValue,
    sourceBreakdown,
    aiResult,
  }).catch((err) => {
    if (!isMissingSchemaError(err)) throw err;
    return null;
  });

  const governanceState = aiResult?.usedAi ? 'ai' : 'fallback';
  const generationMode = aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'rules_forecast');
  const providerStatus = aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'not_used');
  const fallbackReason = aiResult?.usedAi ? null : aiResult?.fallback_reason || aiResult?.reason || 'deterministic_rules_forecast';
  const sourceCount = Object.values(sourceBreakdown).filter((source) => source.state === 'available').length;

  const runRows = await prisma.$queryRawUnsafe(
    `INSERT INTO staff_leave_forecast_runs
       (tenant_id, department, start_date, end_date, forecast_window_days, generation_id,
        governance_state, generation_mode, provider_status, fallback_reason, source_count,
        review_status, requested_by, requested_by_uid, summary, source_breakdown, safety_flags, metadata,
        created_at, updated_at)
     VALUES ($1::uuid, $2, $3::date, $4::date, $5, $6,
             $7, $8, $9, $10, $11,
             'pending', $12, $13::uuid, $14::jsonb, $15::jsonb, '[]'::jsonb, $16::jsonb,
             NOW(), NOW())
     RETURNING id, created_at`,
    tenantId,
    department,
    startDate,
    endDate,
    daysBetween(startDate, endDate).length,
    generationId,
    governanceState,
    generationMode,
    providerStatus,
    fallbackReason,
    sourceCount,
    actor.id,
    actor.uid,
    JSON.stringify(summary),
    JSON.stringify(sourceBreakdown),
    JSON.stringify({
      score_visibility: 'hr_and_responsible_incharges_only',
      advisory_only: true,
      approved_leave_is_only_hard_roster_block: true,
      payroll_or_discipline_use: false,
    })
  );
  const runId = runRows[0]?.id;

  for (const score of scores) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_leave_forecast_scores
         (run_id, tenant_id, department, staff_id, staff_uid, staff_name, staff_role,
          score, risk_band, confidence_pct, top_factors, date_risks, source_snapshot, created_at)
       VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6, $7,
               $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, NOW())`,
      runId,
      tenantId,
      department,
      score.staff_id,
      score.staff_uid,
      score.staff_name,
      score.staff_role,
      score.score,
      score.risk_band,
      score.confidence_pct,
      JSON.stringify(score.top_factors),
      JSON.stringify(score.date_risks),
      JSON.stringify(score.source_snapshot)
    );
  }

  for (const risk of shiftRisks) {
    await prisma.$queryRawUnsafe(
      `INSERT INTO staff_leave_forecast_shift_risks
         (run_id, tenant_id, department, forecast_date, shift_label, risk_score, risk_band,
          predicted_absences, recommended_buffer_count, top_factors, source_snapshot, created_at)
       VALUES ($1, $2::uuid, $3, $4::date, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, NOW())`,
      runId,
      tenantId,
      department,
      risk.forecast_date,
      risk.shift_label,
      risk.risk_score,
      risk.risk_band,
      risk.predicted_absences,
      risk.recommended_buffer_count,
      JSON.stringify(risk.top_factors),
      JSON.stringify(risk.source_snapshot)
    );
  }

  await insertAudit({
    tenantId,
    runId,
    actor,
    action: 'FORECAST_CREATED',
    after: { department, start_date: startDate, end_date: endDate, governance_state: governanceState },
  });

  return runId;
}

function normalizeRun(row) {
  if (!row) return null;
  return {
    ...row,
    start_date: row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : row.start_date,
    end_date: row.end_date instanceof Date ? row.end_date.toISOString().slice(0, 10) : row.end_date,
    summary: normalizeJson(row.summary, {}),
    source_breakdown: normalizeJson(row.source_breakdown, {}),
    safety_flags: normalizeJson(row.safety_flags, []),
    metadata: normalizeJson(row.metadata, {}),
  };
}

function normalizeScore(row) {
  return {
    ...row,
    staff_id: Number(row.staff_id),
    score: Number(row.score),
    confidence_pct: Number(row.confidence_pct),
    top_factors: normalizeJson(row.top_factors, []),
    date_risks: normalizeJson(row.date_risks, []),
    source_snapshot: normalizeJson(row.source_snapshot, {}),
  };
}

function normalizeShiftRisk(row) {
  return {
    ...row,
    forecast_date: row.forecast_date instanceof Date ? row.forecast_date.toISOString().slice(0, 10) : row.forecast_date,
    risk_score: Number(row.risk_score),
    predicted_absences: Number(row.predicted_absences),
    recommended_buffer_count: Number(row.recommended_buffer_count),
    top_factors: normalizeJson(row.top_factors, []),
    source_snapshot: normalizeJson(row.source_snapshot, {}),
  };
}

export async function createRosterLeaveForecast({
  tenantId = null,
  department,
  startDate,
  endDate = null,
  actorUser = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const dept = normalizeDepartment(department);
  const start = assertIsoDate(startDate, 'start_date');
  const end = assertIsoDate(endDate || addDays(start, DEFAULT_FORECAST_DAYS - 1), 'end_date');
  if (end < start) throw AppError.badRequest('end_date must be on or after start_date');

  try {
    const actor = await resolveActor(actorUser);
    const forecastDates = daysBetween(start, end);
    const sourceData = await loadSourceData({ tenantId: tid, department: dept, startDate: start, endDate: end });
    const leaveByStaff = groupByStaffId(sourceData.leaveRows);
    const requestsByStaff = groupByStaffId(sourceData.rosterRequests);

    const scores = sourceData.staff.map((staff) => scoreStaffLeaveRisk({
      staff,
      forecastDates,
      department: dept,
      leaveRows: leaveByStaff.get(Number(staff.id)) || [],
      rosterRequests: requestsByStaff.get(Number(staff.id)) || [],
      rosterLoad: sourceData.rosterLoad.get(Number(staff.id)) || {},
      calendarEvents: sourceData.calendarEvents,
      weatherSignals: sourceData.weatherSignals,
      commuteProfile: sourceData.commuteProfiles.get(Number(staff.id)) || null,
    }));
    const shiftRisks = summarizeShiftRisks({ scores, forecastDates, department: dept });
    const fallbackSummary = buildFallbackSummary({
      department: dept,
      scores,
      shiftRisks,
      sourceBreakdown: sourceData.sourceBreakdown,
    });
    const { aiResult, narrative } = await generateNarrative({
      tenantId: tid,
      department: dept,
      startDate: start,
      endDate: end,
      summary: fallbackSummary,
      sourceBreakdown: sourceData.sourceBreakdown,
    });
    const summary = { ...fallbackSummary, narrative };
    const sourceHashValue = stableHash({
      dept,
      start,
      end,
      scores: scores.map((score) => ({
        staff_id: score.staff_id,
        score: score.score,
        top_factors: score.top_factors,
      })),
      shiftRisks,
      sourceBreakdown: sourceData.sourceBreakdown,
    });
    const runId = await persistForecast({
      tenantId: tid,
      department: dept,
      startDate: start,
      endDate: end,
      actor,
      scores,
      shiftRisks,
      summary,
      sourceBreakdown: sourceData.sourceBreakdown,
      aiResult,
      sourceHashValue,
    });

    return {
      run_id: runId,
      department: dept,
      start_date: start,
      end_date: end,
      governance_state: aiResult?.usedAi ? 'ai' : 'fallback',
      generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'rules_forecast'),
      provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'not_used'),
      fallback_reason: aiResult?.usedAi ? null : aiResult?.fallback_reason || aiResult?.reason || 'deterministic_rules_forecast',
      review_status: 'pending',
      source_count: Object.values(sourceData.sourceBreakdown).filter((source) => source.state === 'available').length,
      summary,
      source_breakdown: sourceData.sourceBreakdown,
      staff_scores: scores,
      date_risks: shiftRisks,
      score_visibility: 'hr_and_responsible_incharges_only',
      decision_support_only: true,
    };
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      run_id: null,
      department: dept,
      start_date: start,
      end_date: end,
      governance_state: 'schema-unavailable',
      generation_mode: 'schema-unavailable',
      provider_status: 'schema-unavailable',
      fallback_reason: err.message,
      review_status: 'blocked',
      source_count: 0,
      summary: {
        title: `${dept} leave and roster forecast unavailable`,
        narrative: 'Forecast schema is unavailable. Run the latest migration before using this planning surface.',
        decision_support_only: true,
      },
      source_breakdown: {
        schema: { state: 'schema-unavailable', count: 0, reason: err.message },
      },
      staff_scores: [],
      date_risks: [],
      score_visibility: 'hr_and_responsible_incharges_only',
      decision_support_only: true,
    };
  }
}

export async function getLatestRosterLeaveForecast({
  tenantId = null,
  department,
  rosterDate = null,
  includeStaffScores = true,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const dept = normalizeDepartment(department);
  const date = rosterDate ? assertIsoDate(rosterDate, 'roster_date') : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT *
         FROM staff_leave_forecast_runs
        WHERE tenant_id = $1::uuid
          AND department = $2
          AND review_status <> 'discarded'
          AND ($3::date IS NULL OR (start_date <= $3::date AND end_date >= $3::date))
        ORDER BY created_at DESC
        LIMIT 1`,
      tid,
      dept,
      date
    );
    const run = normalizeRun(rows[0]);
    if (!run) {
      return {
        run_id: null,
        department: dept,
        selected_date: date,
        governance_state: 'blocked',
        generation_mode: 'blocked',
        provider_status: 'not_generated',
        fallback_reason: 'forecast_not_generated',
        review_status: 'pending',
        source_count: 0,
        summary: {
          title: `${dept} forecast not generated`,
          narrative: 'Generate a 12-week forecast before using AI/rules roster planning signals.',
          decision_support_only: true,
        },
        source_breakdown: {},
        staff_scores: [],
        date_risks: [],
        selected_date_risk: null,
        score_visibility: 'hr_and_responsible_incharges_only',
        decision_support_only: true,
      };
    }

    const [scores, shiftRisks, audit] = await Promise.all([
      includeStaffScores
        ? prisma.$queryRawUnsafe(
          `SELECT * FROM staff_leave_forecast_scores WHERE run_id = $1 ORDER BY score DESC, staff_name ASC`,
          run.id
        )
        : Promise.resolve([]),
      prisma.$queryRawUnsafe(
        `SELECT * FROM staff_leave_forecast_shift_risks WHERE run_id = $1 ORDER BY forecast_date ASC, shift_label ASC`,
        run.id
      ),
      prisma.$queryRawUnsafe(
        `SELECT id, action, reason, actor_id, actor_uid, created_at
           FROM staff_leave_forecast_audit
          WHERE tenant_id = $1::uuid AND run_id = $2
          ORDER BY created_at DESC
          LIMIT 20`,
        tid,
        run.id
      ).catch(() => []),
    ]);
    const normalizedShiftRisks = shiftRisks.map(normalizeShiftRisk);
    return {
      run_id: run.id,
      department: run.department,
      start_date: run.start_date,
      end_date: run.end_date,
      selected_date: date,
      governance_state: run.governance_state,
      generation_mode: run.generation_mode,
      provider_status: run.provider_status,
      fallback_reason: run.fallback_reason,
      review_status: run.review_status,
      reviewed_by: run.reviewed_by,
      reviewed_by_uid: run.reviewed_by_uid,
      reviewed_at: run.reviewed_at,
      reviewer_notes: run.reviewer_notes,
      source_count: Number(run.source_count || 0),
      summary: run.summary,
      source_breakdown: run.source_breakdown,
      safety_flags: run.safety_flags,
      staff_scores: scores.map(normalizeScore),
      date_risks: normalizedShiftRisks,
      selected_date_risk: date
        ? normalizedShiftRisks.find((risk) => cleanText(risk.forecast_date) === date && risk.shift_label === 'all') || null
        : null,
      audit,
      score_visibility: 'hr_and_responsible_incharges_only',
      decision_support_only: true,
    };
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      run_id: null,
      department: dept,
      selected_date: date,
      governance_state: 'schema-unavailable',
      generation_mode: 'schema-unavailable',
      provider_status: 'schema-unavailable',
      fallback_reason: err.message,
      review_status: 'blocked',
      source_count: 0,
      summary: {
        title: `${dept} forecast schema unavailable`,
        narrative: 'Forecast schema is unavailable. Run the latest migration before using this surface.',
        decision_support_only: true,
      },
      source_breakdown: {
        schema: { state: 'schema-unavailable', count: 0, reason: err.message },
      },
      staff_scores: [],
      date_risks: [],
      selected_date_risk: null,
      score_visibility: 'hr_and_responsible_incharges_only',
      decision_support_only: true,
    };
  }
}

export async function reviewRosterLeaveForecast({
  tenantId = null,
  runId,
  decision,
  reviewerNotes = null,
  actorUser = null,
} = {}) {
  const tid = resolveTenantId(tenantId);
  const id = Number.parseInt(String(runId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('run_id is required');
  const normalizedDecision = cleanText(decision).toLowerCase();
  if (!['accepted', 'discarded'].includes(normalizedDecision)) {
    throw AppError.badRequest('decision must be accepted or discarded');
  }
  const actor = await resolveActor(actorUser);
  const beforeRows = await prisma.$queryRawUnsafe(
    `SELECT id, review_status, summary FROM staff_leave_forecast_runs WHERE tenant_id = $1::uuid AND id = $2 LIMIT 1`,
    tid,
    id
  );
  if (!beforeRows[0]) throw AppError.notFound('Forecast run not found');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE staff_leave_forecast_runs
        SET review_status = $3,
            reviewed_by = $4,
            reviewed_by_uid = $5::uuid,
            reviewed_at = NOW(),
            reviewer_notes = $6,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2
      RETURNING *`,
    tid,
    id,
    normalizedDecision,
    actor.id,
    actor.uid,
    reviewerNotes
  );
  const run = normalizeRun(rows[0]);
  await insertAudit({
    tenantId: tid,
    runId: id,
    actor,
    action: normalizedDecision === 'accepted' ? 'FORECAST_ACCEPTED' : 'FORECAST_DISCARDED',
    reason: reviewerNotes,
    before: beforeRows[0],
    after: { id, review_status: normalizedDecision },
  });
  if (run.generation_id) {
    await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_generations
          SET status = $2, reviewed_by = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $4`,
      tid,
      normalizedDecision === 'accepted' ? 'accepted' : 'rejected',
      actor.uid,
      run.generation_id
    ).catch((err) => {
      if (!isMissingSchemaError(err)) throw err;
    });
  }
  return run;
}

export async function listRosterForecastAudit({ tenantId = null, runId }) {
  const tid = resolveTenantId(tenantId);
  const id = Number.parseInt(String(runId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('run_id is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.*, u.name AS actor_name
       FROM staff_leave_forecast_audit a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.tenant_id = $1::uuid AND a.run_id = $2
      ORDER BY a.created_at DESC`,
    tid,
    id
  );
  return rows.map((row) => ({
    ...row,
    before_snapshot: normalizeJson(row.before_snapshot, {}),
    after_snapshot: normalizeJson(row.after_snapshot, {}),
  }));
}

export async function listRosterCalendarEvents({ tenantId = null, startDate = null, endDate = null, department = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const start = startDate ? assertIsoDate(startDate, 'start_date') : addDays(new Date().toISOString().slice(0, 10), -30);
  const end = endDate ? assertIsoDate(endDate, 'end_date') : addDays(start, DEFAULT_FORECAST_DAYS);
  const dept = department ? normalizeDepartment(department) : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM roster_calendar_events
      WHERE tenant_id = $1::uuid
        AND start_date <= $3::date
        AND end_date >= $2::date
        AND is_active = true
      ORDER BY start_date ASC, risk_weight DESC`,
    tid,
    start,
    end
  );
  return dept ? rows.filter((row) => eventAppliesToDepartment(row, dept)) : rows;
}

export async function upsertRosterCalendarEvent({ tenantId = null, eventId = null, payload = {}, actorUser = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = await resolveActor(actorUser);
  const id = eventId ? Number.parseInt(String(eventId), 10) : null;
  const title = cleanText(payload.title);
  if (!title) throw AppError.badRequest('title is required');
  const start = assertIsoDate(payload.start_date, 'start_date');
  const end = assertIsoDate(payload.end_date || payload.start_date, 'end_date');
  if (end < start) throw AppError.badRequest('end_date must be on or after start_date');
  const applies = Array.isArray(payload.applies_departments)
    ? payload.applies_departments.map((item) => normalizeDepartment(item)).filter(Boolean)
    : [];
  const args = [
    tid,
    title,
    cleanText(payload.event_type, 'custom').slice(0, 60),
    start,
    end,
    clamp(payload.risk_weight ?? 10, 0, 40),
    applies,
    payload.notes || null,
    actor.id,
    actor.uid,
  ];
  if (id) {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE roster_calendar_events
          SET title = $2, event_type = $3, start_date = $4::date, end_date = $5::date,
              risk_weight = $6, applies_departments = $7::text[], notes = $8,
              updated_by = $9, updated_by_uid = $10::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $11
        RETURNING *`,
      ...args,
      id
    );
    if (!rows[0]) throw AppError.notFound('Calendar event not found');
    return rows[0];
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO roster_calendar_events
       (tenant_id, title, event_type, start_date, end_date, risk_weight, applies_departments,
        notes, created_by, created_by_uid, updated_by, updated_by_uid, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::date, $5::date, $6, $7::text[], $8, $9, $10::uuid, $9, $10::uuid, NOW(), NOW())
     RETURNING *`,
    ...args
  );
  return rows[0];
}

export async function listStaffCommuteProfiles({ tenantId = null, staffId = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const id = staffId ? Number.parseInt(String(staffId), 10) : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT cp.*, u.name AS staff_name, u.role AS staff_role, s.employee_id
       FROM staff_commute_profiles cp
       LEFT JOIN users u ON u.id = cp.staff_id
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE cp.tenant_id = $1::uuid
        AND cp.is_active = true
        AND ($2::int IS NULL OR cp.staff_id = $2::int)
      ORDER BY u.name ASC NULLS LAST, cp.staff_id ASC`,
    tid,
    id
  );
  return rows;
}

export async function upsertStaffCommuteProfile({ tenantId = null, payload = {}, actorUser = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const staffId = Number.parseInt(String(payload.staff_id || ''), 10);
  if (!Number.isInteger(staffId) || staffId <= 0) throw AppError.badRequest('staff_id is required');
  const actor = await resolveActor(actorUser);
  const staffRows = await prisma.$queryRawUnsafe(
    `SELECT id, uid FROM users WHERE id = $1 LIMIT 1`,
    staffId
  );
  if (!staffRows[0]) throw AppError.notFound('Staff not found');
  const beforeRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM staff_commute_profiles WHERE tenant_id = $1::uuid AND staff_id = $2 LIMIT 1`,
    tid,
    staffId
  );
  const commuteBand = cleanText(payload.commute_band, 'unknown').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(COMMUTE_BAND_WEIGHTS, commuteBand)) {
    throw AppError.badRequest('commute_band must be unknown, onsite, near, medium, long, or very_long');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO staff_commute_profiles
       (tenant_id, staff_id, staff_uid, commute_band, travel_mode, area_label, risk_weight,
        notes, is_active, updated_by, updated_by_uid, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, true, $9, $10::uuid, NOW(), NOW())
     ON CONFLICT (tenant_id, staff_id)
     DO UPDATE SET commute_band = EXCLUDED.commute_band,
                   travel_mode = EXCLUDED.travel_mode,
                   area_label = EXCLUDED.area_label,
                   risk_weight = EXCLUDED.risk_weight,
                   notes = EXCLUDED.notes,
                   is_active = true,
                   updated_by = EXCLUDED.updated_by,
                   updated_by_uid = EXCLUDED.updated_by_uid,
                   updated_at = NOW()
     RETURNING *`,
    tid,
    staffId,
    staffRows[0].uid,
    commuteBand,
    payload.travel_mode || null,
    payload.area_label || null,
    clamp(payload.risk_weight ?? COMMUTE_BAND_WEIGHTS[commuteBand], 0, 30),
    payload.notes || null,
    actor.id,
    actor.uid
  );
  await prisma.$queryRawUnsafe(
    `INSERT INTO staff_commute_profile_audit
       (tenant_id, commute_profile_id, staff_id, actor_id, actor_uid, action, reason,
        before_snapshot, after_snapshot, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, NOW())`,
    tid,
    rows[0].id,
    staffId,
    actor.id,
    actor.uid,
    beforeRows[0] ? 'COMMUTE_PROFILE_UPDATED' : 'COMMUTE_PROFILE_CREATED',
    payload.reason || null,
    JSON.stringify(beforeRows[0] || {}),
    JSON.stringify(rows[0] || {})
  );
  return rows[0];
}

export async function listRosterWeatherSignals({ tenantId = null, startDate = null, endDate = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const start = startDate ? assertIsoDate(startDate, 'start_date') : new Date().toISOString().slice(0, 10);
  const end = endDate ? assertIsoDate(endDate, 'end_date') : addDays(start, 14);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM roster_weather_signals
      WHERE tenant_id = $1::uuid
        AND signal_date >= $2::date
        AND signal_date <= $3::date
      ORDER BY signal_date ASC, risk_weight DESC`,
    tid,
    start,
    end
  );
}

export async function upsertRosterWeatherSignal({ tenantId = null, payload = {}, actorUser = null } = {}) {
  const tid = resolveTenantId(tenantId);
  const actor = await resolveActor(actorUser);
  const signalDate = assertIsoDate(payload.signal_date, 'signal_date');
  const signalType = cleanText(payload.signal_type);
  if (!signalType) throw AppError.badRequest('signal_type is required');
  const severity = cleanText(payload.severity, 'normal').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(WEATHER_SEVERITY_WEIGHTS, severity)) {
    throw AppError.badRequest('severity must be normal, watch, moderate, high, or severe');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO roster_weather_signals
       (tenant_id, signal_date, area_label, signal_type, severity, provider, provider_status,
        confidence_pct, risk_weight, is_manual, payload, notes, created_by, created_by_uid, created_at, updated_at)
     VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14::uuid, NOW(), NOW())
     RETURNING *`,
    tid,
    signalDate,
    payload.area_label || null,
    signalType.slice(0, 80),
    severity,
    payload.provider || 'manual',
    payload.provider_status || 'manual',
    clamp(payload.confidence_pct ?? 60, 0, 100),
    clamp(payload.risk_weight ?? WEATHER_SEVERITY_WEIGHTS[severity], 0, 40),
    payload.is_manual !== false,
    JSON.stringify(payload.payload || {}),
    payload.notes || null,
    actor.id,
    actor.uid
  );
  return rows[0];
}

export default {
  createRosterLeaveForecast,
  getLatestRosterLeaveForecast,
  reviewRosterLeaveForecast,
  listRosterForecastAudit,
  listRosterCalendarEvents,
  upsertRosterCalendarEvent,
  listStaffCommuteProfiles,
  upsertStaffCommuteProfile,
  listRosterWeatherSignals,
  upsertRosterWeatherSignal,
  scoreStaffLeaveRisk,
  summarizeShiftRisks,
};
