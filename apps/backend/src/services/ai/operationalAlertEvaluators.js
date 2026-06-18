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
// 5. pharmacy_stockout_predictor — bridge clinical_ai_pharmacy_forecasts
// ---------------------------------------------------------------------------
// Table has NO severity/reviewer_decision/summary columns. Threshold on
// risk_level: 'high' → severity 'high', 'critical' → severity 'critical'.
// Rows within 3 days with risk_level in ('high','critical') surface as alerts.
// Identity: medication_name (the unique drug being forecast).
async function evaluatePharmacyStockoutBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (medication_name)
              medication_name, risk_level, forecast, created_at
       FROM clinical_ai_pharmacy_forecasts
       WHERE tenant_id = $1::uuid
         AND risk_level IN ('high', 'critical')
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY medication_name, created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => {
    const severity = row.risk_level === 'critical' ? 'critical' : 'high';
    const name = row.medication_name || 'unknown';
    const forecast = (row.forecast && typeof row.forecast === 'object') ? row.forecast : {};
    return {
      module_key: 'pharmacy_stockout_predictor',
      domain: 'pharmacy',
      owner_role: 'MATERIALS_MANAGER',
      scope_key: `rx:${name}`,
      scope_label: name,
      horizon: '72h',
      alert_category: 'stockout_risk',
      severity,
      metrics: {
        risk_level: row.risk_level,
        days_on_hand: forecast.days_on_hand ?? null,
        reorder_quantity: forecast.reorder_quantity ?? null,
      },
      summary: forecast.summary ?? `Pharmacy stockout risk (${row.risk_level}) for ${name}.`,
      recommended_actions: Array.isArray(forecast.recommended_actions) ? forecast.recommended_actions : ['Review stock levels and initiate reorder.'],
      source_citations: Array.isArray(forecast.source_citations) ? forecast.source_citations : [
        { source_type: 'pharmacy_forecasts', source_id: name, label: `Pharmacy forecast — ${name}` },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// 6. blood_bank_demand_forecast — bridge clinical_ai_blood_bank_forecast_reviews
// ---------------------------------------------------------------------------
// Table uses risk_band (not severity), reviewer_decision (present). The
// identity of a blood bank forecast is its temporal window (forecast_start date
// + forecast_end date) — no per-component row identity. Dedupe by
// forecast_start date (keep newest row per start date).
async function evaluateBloodBankBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (forecast_start::date)
              id, forecast_start, forecast_end, risk_band,
              stockout_risks, recommendations, source_citations,
              mtp_readiness, predicted_demand, created_at
       FROM clinical_ai_blood_bank_forecast_reviews
       WHERE tenant_id = $1::uuid
         AND risk_band IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY forecast_start::date, created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => {
    const severity = row.risk_band === 'critical' ? 'critical' : 'high';
    const startDate = row.forecast_start ? new Date(row.forecast_start).toISOString().slice(0, 10) : String(row.id);
    return {
      module_key: 'blood_bank_demand_forecast',
      domain: 'blood_bank',
      owner_role: 'BLOOD_BANK_STAFF',
      scope_key: `blood:${startDate}`,
      scope_label: `Blood bank demand ${startDate}`,
      horizon: '72h',
      alert_category: 'blood_shortage',
      severity,
      metrics: {
        risk_band: row.risk_band,
        stockout_risks: Array.isArray(row.stockout_risks) ? row.stockout_risks.length : 0,
      },
      summary: `Blood bank demand forecast (${row.risk_band}) for window starting ${startDate}.`,
      recommended_actions: Array.isArray(row.recommendations) ? row.recommendations : ['Review blood inventory and notify blood bank staff.'],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'blood_bank_forecast_reviews', source_id: String(row.id), label: `Blood bank forecast ${startDate}` },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// 7. bed_discharge_forecast — bridge clinical_ai_bed_forecasts
// ---------------------------------------------------------------------------
// Table has NO severity, NO reviewer_decision, NO summary. Has ward + forecast
// (jsonb). Threshold: extract forecast.predicted_occupancy_pct or
// forecast.available_beds from jsonb; if available_beds <= 2 → 'critical',
// <= 5 → 'high'. Identity: ward.
async function evaluateBedForecastBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (COALESCE(ward, 'hospital'))
              ward, forecast, forecast_window_hours, created_at
       FROM clinical_ai_bed_forecasts
       WHERE tenant_id = $1::uuid
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY COALESCE(ward, 'hospital'), created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  const candidates = [];
  for (const row of rows) {
    const forecast = (row.forecast && typeof row.forecast === 'object') ? row.forecast : {};
    const availBeds = forecast.available_beds != null ? Number(forecast.available_beds) : null;
    const occupancyPct = forecast.predicted_occupancy_pct != null ? Number(forecast.predicted_occupancy_pct) : null;

    // Threshold: available_beds ≤ 5 OR occupancy ≥ 90%
    let severity = null;
    if (availBeds != null) {
      if (availBeds <= 2) severity = 'critical';
      else if (availBeds <= 5) severity = 'high';
    } else if (occupancyPct != null) {
      if (occupancyPct >= 95) severity = 'critical';
      else if (occupancyPct >= 90) severity = 'high';
    }

    if (!severity) continue;

    const ward = row.ward || 'hospital';
    candidates.push({
      module_key: 'bed_discharge_forecast',
      domain: 'beds',
      owner_role: 'BED_MANAGER',
      scope_key: `beds:${ward}`,
      scope_label: `Bed crunch — ${ward}`,
      horizon: '72h',
      alert_category: 'bed_crunch',
      severity,
      metrics: {
        ward,
        available_beds: availBeds,
        predicted_occupancy_pct: occupancyPct,
        forecast_window_hours: row.forecast_window_hours ?? 24,
      },
      summary: forecast.summary ?? `Bed capacity critical on ${ward}: ${availBeds != null ? `${availBeds} beds available` : `${occupancyPct}% occupancy`}.`,
      recommended_actions: Array.isArray(forecast.recommended_actions) ? forecast.recommended_actions : ['Expedite discharge planning and coordinate bed management.'],
      source_citations: Array.isArray(forecast.source_citations) ? forecast.source_citations : [
        { source_type: 'bed_forecasts', source_id: ward, label: `Bed forecast — ${ward}` },
      ],
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// 8. housekeeping_bed_turnover — bridge clinical_ai_bed_turnover_predictions
// ---------------------------------------------------------------------------
// Table uses priority_band (not severity), reviewer_decision (present).
// Threshold: priority_band in ('high','critical'). Identity: bed_id (or
// COALESCE(bed_id::text, ward) when bed_id is null).
async function evaluateHousekeepingTurnoverBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (COALESCE(bed_id::text, COALESCE(ward, 'unknown')))
              bed_id, ward, room_number, priority_band, priority_score,
              predicted_turnover_minutes, recommended_actions, source_citations,
              contributing_signals, created_at
       FROM clinical_ai_bed_turnover_predictions
       WHERE tenant_id = $1::uuid
         AND priority_band IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY COALESCE(bed_id::text, COALESCE(ward, 'unknown')), created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => {
    const severity = row.priority_band === 'critical' ? 'critical' : 'high';
    const bedId = row.bed_id != null ? String(row.bed_id) : (row.ward || 'unknown');
    const label = row.ward ? `${row.ward}${row.room_number ? ` / ${row.room_number}` : ''}` : `Bed ${bedId}`;
    return {
      module_key: 'housekeeping_bed_turnover',
      domain: 'housekeeping',
      owner_role: 'HOUSEKEEPING_STAFF',
      scope_key: `hk:${bedId}`,
      scope_label: label,
      horizon: '24h',
      alert_category: 'turnover_backlog',
      severity,
      metrics: {
        bed_id: row.bed_id ?? null,
        ward: row.ward ?? null,
        priority_band: row.priority_band,
        priority_score: Number(row.priority_score ?? 0),
        predicted_turnover_minutes: Number(row.predicted_turnover_minutes ?? 0),
      },
      summary: `Bed turnover delay predicted (${row.priority_band} priority, ~${row.predicted_turnover_minutes} min) for ${label}.`,
      recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : ['Assign housekeeping team immediately.'],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'bed_turnover_predictions', source_id: bedId, label: `Turnover prediction — ${label}` },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// 9. staff_burnout_workload_risk — bridge clinical_ai_staff_burnout_reviews
// ---------------------------------------------------------------------------
// Table uses risk_band (not severity), reviewer_decision (present).
// Identity: staff_uid (dedupe to latest per staff member).
async function evaluateBurnoutBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (staff_uid)
              staff_uid, department, role, risk_band, risk_score,
              total_hours, overtime_hours, recommended_actions, source_citations,
              contributing_signals, created_at
       FROM clinical_ai_staff_burnout_reviews
       WHERE tenant_id = $1::uuid
         AND risk_band IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY staff_uid, created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => {
    const severity = row.risk_band === 'critical' ? 'critical' : 'high';
    const uid = String(row.staff_uid);
    const dept = row.department || 'unknown';
    return {
      module_key: 'staff_burnout_workload_risk',
      domain: 'staffing',
      owner_role: 'HR_STAFF',
      scope_key: `burnout:${uid}`,
      scope_label: `Burnout risk — ${dept}${row.role ? ` / ${row.role}` : ''}`,
      horizon: '7d',
      alert_category: 'burnout_risk',
      severity,
      metrics: {
        staff_uid: uid,
        department: dept,
        role: row.role ?? null,
        risk_band: row.risk_band,
        risk_score: Number(row.risk_score ?? 0),
        total_hours: row.total_hours != null ? Number(row.total_hours) : null,
        overtime_hours: row.overtime_hours != null ? Number(row.overtime_hours) : null,
      },
      summary: `Staff burnout risk (${row.risk_band}) detected in ${dept}${row.role ? ` for ${row.role}` : ''}.`,
      recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : ['Review workload schedule and consider relief coverage.'],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'staff_burnout_reviews', source_id: uid, label: `Burnout review — ${dept}` },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// 10. ot_block_scheduling — bridge clinical_ai_ot_block_suggestions
// ---------------------------------------------------------------------------
// Table has severity (present), reviewer_decision (present), summary (present).
// Identity: block_label (the OR block identifier).
async function evaluateOtBlockBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (COALESCE(block_label, surgeon_uid::text))
              block_label, surgeon_name, service_line, or_room,
              severity, recommendation, utilization_pct, overrun_count,
              summary, recommended_actions, source_citations, signals,
              surgeon_uid, created_at
       FROM clinical_ai_ot_block_suggestions
       WHERE tenant_id = $1::uuid
         AND severity IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY COALESCE(block_label, surgeon_uid::text), created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => {
    const blockId = row.block_label || (row.surgeon_uid ? String(row.surgeon_uid) : String(row.id ?? 'unknown'));
    const label = row.block_label || (row.surgeon_name ? `Dr. ${row.surgeon_name}` : blockId);
    return {
      module_key: 'ot_block_scheduling',
      domain: 'ot',
      owner_role: 'OT_INCHARGE',
      scope_key: `ot-block:${blockId}`,
      scope_label: label,
      horizon: '7d',
      alert_category: 'block_imbalance',
      severity: row.severity,
      metrics: {
        block_label: row.block_label ?? null,
        service_line: row.service_line ?? null,
        or_room: row.or_room ?? null,
        utilization_pct: row.utilization_pct != null ? Number(row.utilization_pct) : null,
        overrun_count: Number(row.overrun_count ?? 0),
        recommendation: row.recommendation ?? null,
      },
      signals: Array.isArray(row.signals) ? row.signals : [],
      summary: row.summary ?? `OT block imbalance (${row.severity}) for ${label}.`,
      recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : ['Review block schedule and rebalance OR time.'],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'ot_block_suggestions', source_id: blockId, label: `OT block suggestion — ${label}` },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// 11. biomed_device_maintenance — bridge clinical_ai_biomed_maintenance_predictions
// ---------------------------------------------------------------------------
// Table uses risk_band (not severity), reviewer_decision (present).
// Identity: device_code (or device_id when code is null).
async function evaluateBiomedMaintenanceBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (COALESCE(device_code, device_id::text))
              device_id, device_code, risk_band, predicted_failure_risk_score,
              predicted_downtime_hours, recommended_actions, source_citations,
              contributing_signals, created_at
       FROM clinical_ai_biomed_maintenance_predictions
       WHERE tenant_id = $1::uuid
         AND risk_band IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY COALESCE(device_code, device_id::text), created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => {
    const severity = row.risk_band === 'critical' ? 'critical' : 'high';
    const deviceId = row.device_code || (row.device_id != null ? String(row.device_id) : 'unknown');
    return {
      module_key: 'biomed_device_maintenance',
      domain: 'biomed',
      owner_role: 'BIOMEDICAL_STAFF',
      scope_key: `biomed:${deviceId}`,
      scope_label: `Device ${deviceId}`,
      horizon: '72h',
      alert_category: 'pm_due',
      severity,
      metrics: {
        device_id: row.device_id ?? null,
        device_code: row.device_code ?? null,
        risk_band: row.risk_band,
        predicted_failure_risk_score: Number(row.predicted_failure_risk_score ?? 0),
        predicted_downtime_hours: row.predicted_downtime_hours != null ? Number(row.predicted_downtime_hours) : null,
      },
      summary: `Biomed device maintenance predicted (${row.risk_band} risk) for device ${deviceId}.`,
      recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : ['Schedule preventive maintenance immediately.'],
      source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
        { source_type: 'biomed_maintenance_predictions', source_id: deviceId, label: `Biomed maintenance — ${deviceId}` },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// 12. procurement_negotiation_assistant — bridge clinical_ai_procurement_opportunities
// ---------------------------------------------------------------------------
// Table has severity (present), reviewer_decision (present), summary (present).
// Identity: item_sku.
async function evaluateProcurementBridge({ tenantId }) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (item_sku)
              item_sku, item_name, category, vendor_name, severity,
              opportunity_category, price_delta_pct, estimated_annual_savings,
              summary, recommended_actions, source_citations, signals, created_at
       FROM clinical_ai_procurement_opportunities
       WHERE tenant_id = $1::uuid
         AND severity IN ('high', 'critical')
         AND reviewer_decision = 'pending'
         AND created_at >= NOW() - INTERVAL '3 days'
       ORDER BY item_sku, created_at DESC`,
      tenantId
    );
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) return [];
    throw err;
  }

  if (!rows || !rows.length) return [];

  return rows.map((row) => ({
    module_key: 'procurement_negotiation_assistant',
    domain: 'procurement',
    owner_role: 'PROCUREMENT_LEAD',
    scope_key: `proc:${row.item_sku}`,
    scope_label: row.item_name,
    horizon: '7d',
    alert_category: 'contract_risk',
    severity: row.severity,
    metrics: {
      item_sku: row.item_sku,
      category: row.category ?? null,
      vendor_name: row.vendor_name ?? null,
      opportunity_category: row.opportunity_category ?? null,
      price_delta_pct: row.price_delta_pct != null ? Number(row.price_delta_pct) : null,
      estimated_annual_savings: row.estimated_annual_savings != null ? Number(row.estimated_annual_savings) : null,
    },
    signals: Array.isArray(row.signals) ? row.signals : [],
    summary: row.summary ?? `Procurement opportunity (${row.severity}) for ${row.item_name}.`,
    recommended_actions: Array.isArray(row.recommended_actions) ? row.recommended_actions : ['Review contract terms and initiate negotiation.'],
    source_citations: Array.isArray(row.source_citations) ? row.source_citations : [
      { source_type: 'procurement_opportunities', source_id: row.item_sku, label: `Procurement opportunity — ${row.item_name}` },
    ],
  }));
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
  { module_key: 'pharmacy_stockout_predictor',       domain: 'pharmacy',     owner_role: 'MATERIALS_MANAGER',    evaluate: evaluatePharmacyStockoutBridge },
  { module_key: 'blood_bank_demand_forecast',        domain: 'blood_bank',   owner_role: 'BLOOD_BANK_STAFF',     evaluate: evaluateBloodBankBridge },
  { module_key: 'bed_discharge_forecast',            domain: 'beds',         owner_role: 'BED_MANAGER',          evaluate: evaluateBedForecastBridge },
  { module_key: 'housekeeping_bed_turnover',         domain: 'housekeeping', owner_role: 'HOUSEKEEPING_STAFF',   evaluate: evaluateHousekeepingTurnoverBridge },
  { module_key: 'acuity_staffing_forecast',          domain: 'staffing',     owner_role: 'HOUSE_SUPERVISOR',     evaluate: evaluateAcuityStaffingBridge },
  // DEFERRED (7b): no clinical_ai roster-forecast table; needs a dedicated uncovered-shift source.
  // staff_shift_roster_assignments rows use status 'planned'/'published'/'cancelled' (no 'unfilled'
  // signal) and have no tenant_id. staff_shift_roster_requests tracks preferences/coverage-requests
  // but no roster board gaps. Wire when a clinical_ai_roster_forecasts table or gap-detection signal exists.
  { module_key: 'staff_roster_optimizer',            domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: stub },
  { module_key: 'staff_burnout_workload_risk',       domain: 'staffing',     owner_role: 'HR_STAFF',             evaluate: evaluateBurnoutBridge },
  { module_key: 'ot_case_time_predictor',            domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: evaluateOtOverrun },
  { module_key: 'ot_block_scheduling',               domain: 'ot',           owner_role: 'OT_INCHARGE',          evaluate: evaluateOtBlockBridge },
  { module_key: 'appointment_no_show_predictor',     domain: 'opd',          owner_role: 'RECEPTIONIST',         evaluate: evaluateNoShow },
  { module_key: 'biomed_device_maintenance',         domain: 'biomed',       owner_role: 'BIOMEDICAL_STAFF',     evaluate: evaluateBiomedMaintenanceBridge },
  { module_key: 'inventory_intelligence',            domain: 'inventory',    owner_role: 'MATERIALS_MANAGER',    evaluate: evaluateInventoryBridge },
  { module_key: 'procurement_negotiation_assistant', domain: 'procurement',  owner_role: 'PROCUREMENT_LEAD',     evaluate: evaluateProcurementBridge },
];
