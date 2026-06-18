// src/services/ai/operationalAlertEvaluators.js
//
// Per-module evaluator adapters for the operational forecast alert stream.
// Each evaluator wraps an existing forecast service / operational data source,
// applies a DETERMINISTIC threshold, and returns normalized AlertCandidates.
// The orchestrator (operationalAlertService) owns persistence + lifecycle.

/**
 * @typedef {Object} AlertCandidate
 * @property {string} module_key
 * @property {string} domain
 * @property {string|null} owner_role
 * @property {string} scope_key             dedup identity within (tenant, module)
 * @property {string} [scope_label]
 * @property {string} [horizon]             'tonight'|'24h'|'72h'|'7d'|ISO date
 * @property {Date|null} [predicted_for]
 * @property {string} alert_category
 * @property {'low'|'moderate'|'high'|'critical'} severity
 * @property {object} [metrics]
 * @property {object[]} [signals]
 * @property {string} [summary]
 * @property {string[]} [recommended_actions]
 * @property {object[]} [source_citations]
 */

// Each evaluator: async ({ tenantId, now }) => AlertCandidate[]
// Stubs return [] until Task 7 implements them.
const stub = async () => [];

// ---------------------------------------------------------------------------
// Imports for wired evaluators
// ---------------------------------------------------------------------------
import prisma from '../../lib/prisma.js';
import { scoreNoShowRisk, predictOtCaseTime } from './operationalAiService.js';

// ---------------------------------------------------------------------------
// 1. appointment_no_show_predictor
// ---------------------------------------------------------------------------
async function evaluateNoShow({ tenantId, now }) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const ymd = tomorrow.toISOString().slice(0, 10);

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM appointments
      WHERE appointment_date = $1::date AND status IN ('SCHEDULED','CONFIRMED')`,
    ymd
  );
  if (!rows.length) return [];

  let high = 0;
  for (const r of rows) {
    const s = await scoreNoShowRisk({ appointmentId: r.id, tenantId }).catch(() => null);
    if (s && s.band === 'high') high += 1;
  }

  const rate = high / rows.length;
  if (rate < 0.2) return [];

  const severity = rate >= 0.4 ? 'high' : 'moderate';
  return [{
    module_key: 'appointment_no_show_predictor',
    domain: 'opd',
    owner_role: 'RECEPTIONIST',
    scope_key: `no-show:${ymd}`,
    scope_label: `OPD no-show load ${ymd}`,
    horizon: '24h',
    predicted_for: tomorrow,
    alert_category: 'no_show_surge',
    severity,
    metrics: { booked: rows.length, high_risk: high, rate: Number(rate.toFixed(2)) },
    signals: [{ code: 'NO_SHOW_LOAD', detail: `${high}/${rows.length} high-risk for ${ymd}` }],
    summary: `Predicted elevated no-show load for ${ymd}: ${high} of ${rows.length} high-risk.`,
    recommended_actions: ['Consider overbooking buffer / confirmation calls for high-risk slots.'],
    source_citations: [{ source_type: 'appointments', source_id: ymd, label: 'Booked appointments' }],
  }];
}

// ---------------------------------------------------------------------------
// 2. inventory_intelligence — bridge clinical_ai_inventory_alerts (mig 059)
// ---------------------------------------------------------------------------
async function evaluateInventoryBridge({ tenantId }) {
  // Pick the most-recent high/critical row per item_sku within last 3 days.
  // DISTINCT ON (item_sku) ordered by item_sku, created_at DESC gives the
  // latest row per SKU; the outer WHERE then keeps high/critical only.
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT item_sku, item_name, alert_category, severity,
              days_on_hand, next_expiry_date, summary,
              recommended_actions, source_citations
       FROM (
         SELECT DISTINCT ON (item_sku)
                item_sku, item_name, alert_category, severity,
                days_on_hand, next_expiry_date, summary,
                recommended_actions, source_citations, created_at
         FROM clinical_ai_inventory_alerts
         WHERE tenant_id = $1::uuid
           AND severity IN ('high', 'critical')
           AND created_at >= NOW() - INTERVAL '3 days'
         ORDER BY item_sku, created_at DESC
       ) latest`,
      tenantId
    );
  } catch (err) {
    // Table may not exist in environments without mig 059 applied yet.
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => ({
    module_key: 'inventory_intelligence',
    domain: 'inventory',
    owner_role: 'MATERIALS_MANAGER',
    scope_key: `inv:${row.item_sku}`,
    scope_label: row.item_name,
    horizon: '72h',
    alert_category: row.alert_category,
    severity: row.severity,
    metrics: {
      days_on_hand: row.days_on_hand != null ? Number(row.days_on_hand) : null,
      next_expiry_date: row.next_expiry_date ?? null,
    },
    summary: row.summary ?? null,
    recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : [],
    source_citations: Array.isArray(row.source_citations) ? row.source_citations : [],
  }));
}

// ---------------------------------------------------------------------------
// 3. ot_case_time_predictor — aggregate tomorrow's OT list overrun risk
// ---------------------------------------------------------------------------
// predictOtCaseTime({ scheduleId, tenantId }) → { predicted_minutes, ... }
// Available block per OT day assumed 480 min (8 h) per room when not
// explicitly stored. If multiple rooms are scheduled, group by ot_room and
// threshold each room independently.
const OT_BLOCK_MINUTES_DEFAULT = 480;

async function evaluateOtOverrun({ tenantId, now }) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const ymd = tomorrow.toISOString().slice(0, 10);

  let schedules;
  try {
    schedules = await prisma.$queryRawUnsafe(
      `SELECT id, ot_room, estimated_duration
       FROM ot_schedules
       WHERE scheduled_date = $1::date
         AND status NOT IN ('cancelled', 'completed')`,
      ymd
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!schedules || !schedules.length) return [];

  // Group by room (null room → 'DEFAULT').
  const roomMap = new Map();
  for (const s of schedules) {
    const room = s.ot_room || 'DEFAULT';
    if (!roomMap.has(room)) roomMap.set(room, []);
    roomMap.get(room).push(s);
  }

  const candidates = [];
  for (const [room, cases] of roomMap.entries()) {
    let totalPredicted = 0;
    for (const c of cases) {
      // Call the producer; fall back to estimated_duration if it throws/cold-starts.
      const pred = await predictOtCaseTime({ scheduleId: c.id, tenantId }).catch(() => null);
      const mins = pred?.predicted_minutes ?? (Number(c.estimated_duration) > 0 ? Number(c.estimated_duration) : 60);
      totalPredicted += mins;
    }

    const overrun = totalPredicted - OT_BLOCK_MINUTES_DEFAULT;
    if (overrun <= 20) continue;

    const severity = overrun >= 60 ? 'high' : 'moderate';
    const scopeRoom = room === 'DEFAULT' ? '' : `:${room}`;
    candidates.push({
      module_key: 'ot_case_time_predictor',
      domain: 'ot',
      owner_role: 'OT_INCHARGE',
      scope_key: `ot-overrun:${ymd}${scopeRoom}`,
      scope_label: `OT overrun risk ${ymd}${room !== 'DEFAULT' ? ` (${room})` : ''}`,
      horizon: '24h',
      predicted_for: tomorrow,
      alert_category: 'ot_overrun',
      severity,
      metrics: {
        predicted_minutes: Math.round(totalPredicted),
        block_minutes: OT_BLOCK_MINUTES_DEFAULT,
        overrun_minutes: Math.round(overrun),
        case_count: cases.length,
        room,
      },
      signals: [{
        code: 'OT_OVERRUN',
        detail: `Predicted ${Math.round(totalPredicted)} min for ${cases.length} cases vs ${OT_BLOCK_MINUTES_DEFAULT} min block (room: ${room}).`,
      }],
      summary: `OT list for ${ymd}${room !== 'DEFAULT' ? ` (${room})` : ''} predicted to overrun by ~${Math.round(overrun)} min.`,
      recommended_actions: [
        'Review case order; consider moving elective add-ons to next available slot.',
        'Notify anaesthesia team and OT coordinator of predicted overrun.',
      ],
      source_citations: [{
        source_type: 'ot_schedules',
        source_id: ymd,
        label: `Planned OT list ${ymd}`,
      }],
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// 4. acuity_staffing_forecast — promote pending high/critical ward forecasts
// ---------------------------------------------------------------------------
// classifyAcuityStaffing is a pure function; we bridge the stored
// clinical_ai_acuity_staffing_forecasts rows produced by the service. Rows
// with severity 'high' or 'critical' and reviewer_decision 'pending' that
// were created within the last 24 h surface as alert candidates.
//
// Threshold: total_deficit ≥ 2 → 'high', ≥ 1 → 'moderate', else none.
// We map stored severity directly when rows already exist, or recompute from
// the stored deficit fields when available.
async function evaluateAcuityStaffingBridge({ tenantId, now }) {
  const since = new Date(now);
  since.setHours(since.getHours() - 24);
  const sinceIso = since.toISOString();

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT unit, shift_label, total_deficit, severity, signals,
              recommended_actions, source_citations, summary, created_at
       FROM clinical_ai_acuity_staffing_forecasts
       WHERE tenant_id = $1::uuid
         AND severity IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= $2::timestamptz
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
         created_at DESC`,
      tenantId,
      sinceIso
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) {
    // No stored high/critical forecasts: run a lightweight live census check
    // using classifyAcuityStaffing on available ward snapshots from
    // clinical_ai_acuity_staffing_forecasts (any severity, last 24 h) to
    // catch wards that have data but weren't persisted as high/critical yet.
    return await _evaluateAcuityLive({ tenantId, now });
  }

  // Deduplicate by unit+shift (keep highest severity per (unit, shift)).
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.unit || 'hospital'}:${row.shift_label || 'any'}`;
    if (!seen.has(key)) seen.set(key, row);
  }

  const candidates = [];
  for (const [, row] of seen.entries()) {
    const deficit = Number(row.total_deficit ?? 0);
    // Use stored severity but also apply threshold guard: deficit < 1 → skip.
    if (deficit < 1) continue;

    const severity = deficit >= 2 ? 'high' : 'moderate';
    const unit = row.unit || 'hospital';
    const shift = row.shift_label || 'shift';
    const dateStr = new Date(now).toISOString().slice(0, 10);

    candidates.push({
      module_key: 'acuity_staffing_forecast',
      domain: 'staffing',
      owner_role: 'HOUSE_SUPERVISOR',
      scope_key: `staffing:${unit}:${shift}`,
      scope_label: `Staffing gap ${unit} / ${shift}`,
      horizon: '24h',
      alert_category: 'staffing_gap',
      severity,
      metrics: { total_deficit: deficit, unit, shift_label: shift },
      signals: Array.isArray(row.signals) ? row.signals : [],
      summary: row.summary ?? `Staffing deficit of ${deficit} on ${unit} (${shift}).`,
      recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : [],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'acuity_staffing_forecasts', source_id: `${unit}:${dateStr}`, label: `Acuity staffing snapshot — ${unit}` },
      ],
    });
  }
  return candidates;
}

// Live fallback: query the most-recent forecast per unit and recompute threshold.
async function _evaluateAcuityLive({ tenantId, now }) {
  const since = new Date(now);
  since.setHours(since.getHours() - 24);
  const sinceIso = since.toISOString();

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (unit, shift_label)
              unit, shift_label, total_deficit, severity, census_total,
              signals, recommended_actions, source_citations, summary, created_at
       FROM clinical_ai_acuity_staffing_forecasts
       WHERE tenant_id = $1::uuid
         AND created_at >= $2::timestamptz
       ORDER BY unit, shift_label, created_at DESC`,
      tenantId,
      sinceIso
    );
  } catch {
    return [];
  }
  if (!rows || !rows.length) return [];

  const candidates = [];
  const dateStr = new Date(now).toISOString().slice(0, 10);
  for (const row of rows) {
    const deficit = Number(row.total_deficit ?? 0);
    if (deficit < 1) continue;
    const severity = deficit >= 2 ? 'high' : 'moderate';
    const unit = row.unit || 'hospital';
    const shift = row.shift_label || 'shift';
    candidates.push({
      module_key: 'acuity_staffing_forecast',
      domain: 'staffing',
      owner_role: 'HOUSE_SUPERVISOR',
      scope_key: `staffing:${unit}:${shift}`,
      scope_label: `Staffing gap ${unit} / ${shift}`,
      horizon: '24h',
      alert_category: 'staffing_gap',
      severity,
      metrics: { total_deficit: deficit, unit, shift_label: shift },
      signals: Array.isArray(row.signals) ? row.signals : [],
      summary: row.summary ?? `Staffing deficit of ${deficit} on ${unit} (${shift}).`,
      recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : [],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'acuity_staffing_forecasts', source_id: `${unit}:${dateStr}`, label: `Acuity staffing snapshot — ${unit}` },
      ],
    });
  }
  return candidates;
}

export const OPERATIONAL_ALERT_EVALUATORS = [
  { module_key: 'pharmacy_stockout_predictor',       domain: 'pharmacy',     owner_role: 'MATERIALS_MANAGER',    evaluate: stub },
  { module_key: 'blood_bank_demand_forecast',        domain: 'blood_bank',   owner_role: 'BLOOD_BANK_STAFF',     evaluate: stub },
  { module_key: 'bed_discharge_forecast',            domain: 'beds',         owner_role: 'BED_MANAGER',          evaluate: stub },
  { module_key: 'housekeeping_bed_turnover',         domain: 'housekeeping', owner_role: 'HOUSEKEEPING_STAFF',   evaluate: stub },
  { module_key: 'acuity_staffing_forecast',          domain: 'staffing',     owner_role: 'HOUSE_SUPERVISOR',     evaluate: evaluateAcuityStaffingBridge },
  { module_key: 'staff_roster_optimizer',            domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'staff_burnout_workload_risk',       domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'ot_case_time_predictor',            domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: evaluateOtOverrun },
  { module_key: 'ot_block_scheduling',               domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: stub },
  { module_key: 'appointment_no_show_predictor',     domain: 'opd',          owner_role: 'RECEPTIONIST',         evaluate: evaluateNoShow },
  { module_key: 'biomed_device_maintenance',         domain: 'biomed',       owner_role: 'BIOMEDICAL_STAFF',     evaluate: stub },
  { module_key: 'inventory_intelligence',            domain: 'inventory',    owner_role: 'MATERIALS_MANAGER',    evaluate: evaluateInventoryBridge },
  { module_key: 'procurement_negotiation_assistant', domain: 'procurement',  owner_role: 'PROCUREMENT_LEAD',     evaluate: stub },
];
