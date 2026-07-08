/**
 * Tier H — operational forecasting AI assistants. 8 modules.
 * (Backlog calls out 6 named items; expanded to 8 to cover patient
 * feedback + sentiment as separate modules per the listing.)
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { runExplainerPipeline } from './patientExplainersService.js';

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}
function normalizeId(value, label, { fallback = null, min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}
function requireText(value, label, { min = 1, max = 24_000 } = {}) {
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
// 1 + 2. Lab / Radiology TAT delay prediction
// ---------------------------------------------------------------------------
async function tatDelayPrediction({
  moduleKey, queueRows, queueLabel, prompt, tenantId, generatedBy, req,
}) {
  if (!Array.isArray(queueRows)) {
    queueRows = [];
  }

  return runExplainerPipeline({
    moduleKey, tenantId, patientUid: null, admissionId: null,
    systemPrompt: prompt,
    userPromptPayload: { queue_label: queueLabel, queue_rows: queueRows.slice(0, 50) },
    contextForDefenses: { queue_rows: queueRows },
    citations: [{ source_type: 'queue_snapshot', source_id: shortHash(queueRows),
      label: `${queueLabel} queue (${queueRows.length} rows)`, timestamp: null }],
    metadata: { queue_label: queueLabel, queue_size: queueRows.length },
    generatedBy, req,
  });
}

export async function generateLabTatDelayPrediction({
  tenantId = null, queueSnapshot = null,
  generatedBy = null, req = null,
} = {}) {
  let snap = Array.isArray(queueSnapshot) ? queueSnapshot : null;
  if (!snap) {
    snap = await safeQuery(
      `SELECT id, test_name, status, requested_at,
              EXTRACT(EPOCH FROM NOW() - requested_at)/3600 AS hours_pending
       FROM investigations
       WHERE status IN ('ordered', 'in_progress', 'pending')
       ORDER BY requested_at ASC LIMIT 100`, [],
    );
  }
  return tatDelayPrediction({
    moduleKey: 'lab_tat_delay_prediction', queueRows: snap, queueLabel: 'lab',
    prompt: [
      'You are a hospital operations analyst. Forecast lab TAT delays for the next shift.',
      'Output: explanation_summary, expected_delay_per_test (object), backlog_classification (clearable_in_shift|spillover|critical), recommended_actions.',
      'Use ONLY the supplied queue snapshot.',
    ].join('\n'),
    tenantId, generatedBy, req,
  });
}

export async function generateRadiologyTatDelayPrediction({
  tenantId = null, queueSnapshot = null,
  generatedBy = null, req = null,
} = {}) {
  let snap = Array.isArray(queueSnapshot) ? queueSnapshot : null;
  if (!snap) {
    snap = await safeQuery(
      `SELECT id, modality, body_part, status, ordered_date,
              EXTRACT(EPOCH FROM NOW() - ordered_date)/3600 AS hours_pending
       FROM radiology_orders
       WHERE status IN ('ordered', 'scheduled', 'in_progress', 'awaiting_report')
       ORDER BY ordered_date ASC LIMIT 100`, [],
    );
  }
  return tatDelayPrediction({
    moduleKey: 'radiology_tat_delay_prediction', queueRows: snap, queueLabel: 'radiology',
    prompt: [
      'You are a hospital operations analyst. Forecast radiology TAT delays per modality.',
      'Output: explanation_summary, per_modality_forecast (object), bottleneck_modality, recommended_actions.',
      'Use ONLY the supplied queue snapshot.',
    ].join('\n'),
    tenantId, generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. Ambulance demand forecast
// ---------------------------------------------------------------------------
export async function generateAmbulanceDemandForecast({
  tenantId = null, horizonHours = 24, recentDispatches = null,
  generatedBy = null, req = null,
} = {}) {
  const horizon = normalizeId(horizonHours, 'horizon_hours', { min: 1, max: 168, fallback: 24 });
  let dispatches = Array.isArray(recentDispatches) ? recentDispatches : null;
  if (!dispatches) {
    dispatches = await safeQuery(
      `SELECT id, dispatched_at, dispatch_kind, status
       FROM ambulance_requests
       WHERE dispatched_at >= NOW() - INTERVAL '30 days'
       ORDER BY dispatched_at DESC LIMIT 500`, [],
    );
  }

  return runExplainerPipeline({
    moduleKey: 'ambulance_demand_forecast',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a hospital operations analyst. Forecast ambulance demand for the next ${horizon} hours.`,
      'Output: explanation_summary, forecast_buckets (array of { hour_window, expected_dispatches, confidence }), peak_window, recommended_staffing.',
      'Use ONLY the supplied dispatch history.',
    ].join('\n'),
    userPromptPayload: { horizon_hours: horizon, recent_dispatch_count: dispatches.length,
      dispatches_sample: dispatches.slice(0, 100) },
    contextForDefenses: { dispatches },
    citations: [{ source_type: 'dispatch_history', source_id: shortHash(dispatches),
      label: `Last 30d ambulance dispatches`, timestamp: null }],
    metadata: { horizon_hours: horizon, dispatch_history_size: dispatches.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Smart queue optimization
// ---------------------------------------------------------------------------
export async function generateSmartQueueOptimization({
  tenantId = null, queueLabel = 'opd', queueSnapshot, serviceRate = null,
  generatedBy = null, req = null,
} = {}) {
  if (!Array.isArray(queueSnapshot)) {
    throw AppError.badRequest('queue_snapshot must be an array');
  }
  return runExplainerPipeline({
    moduleKey: 'smart_queue_optimization',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a hospital queue-optimisation analyst. Suggest reorderings of the ${queueLabel} queue to reduce wait time.`,
      'Output: explanation_summary, suggested_order (array of { position, original_id, rationale }), expected_wait_reduction_minutes, fairness_concerns (any reordering that disadvantages a specific group).',
      'NEVER reorder by patient identity. Order by clinical urgency + service-rate fit.',
    ].join('\n'),
    userPromptPayload: { queue_label: queueLabel, queue_snapshot: queueSnapshot.slice(0, 100),
      service_rate: serviceRate },
    contextForDefenses: { queue_snapshot: queueSnapshot, service_rate: serviceRate },
    citations: [{ source_type: 'queue_snapshot', source_id: shortHash(queueSnapshot),
      label: `${queueLabel} queue (${queueSnapshot.length} rows)`, timestamp: null }],
    metadata: { queue_label: queueLabel, queue_size: queueSnapshot.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. Tariff optimization insights
// ---------------------------------------------------------------------------
export async function generateTariffOptimizationInsights({
  tenantId = null, payerId = null,
  generatedBy = null, req = null,
} = {}) {
  const tariffItems = await safeQuery(
    `SELECT id, service_code, service_name, unit_price_minor, currency, status
     FROM tariff_plan_items
     WHERE status = 'active'
     ORDER BY service_name LIMIT 200`, [],
  );

  return runExplainerPipeline({
    moduleKey: 'tariff_optimization_insights',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a revenue-cycle analyst. Surface underpriced + overpriced tariff lines.',
      'Output: explanation_summary, underpriced (array), overpriced (array), recommended_review_priority, payer_alignment_notes.',
      'NEVER set a recommended price; surface the gap and let the tariff committee decide.',
    ].join('\n'),
    userPromptPayload: { payer_id: payerId, tariff_item_count: tariffItems.length,
      tariff_items_sample: tariffItems.slice(0, 100) },
    contextForDefenses: { tariff_items: tariffItems, payer_id: payerId },
    citations: [{ source_type: 'tariff_plan_snapshot', source_id: shortHash(tariffItems),
      label: `Tariff plan (${tariffItems.length} items)`, timestamp: null }],
    metadata: { payer_id: payerId, tariff_item_count: tariffItems.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 6. Package compliance check
// ---------------------------------------------------------------------------
export async function generatePackageComplianceCheck({
  tenantId = null, admissionId, packageCode = null,
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id', { min: 1 });
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, discharge_date, primary_diagnosis,
            package_code, total_charges
     FROM admissions WHERE id = $1 LIMIT 1`, [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const billed = await safeQuery(
    `SELECT id, line_items FROM invoices
     WHERE patient_uid = $1::uuid AND created_at >= $2::timestamptz - INTERVAL '60 days'
     ORDER BY created_at DESC LIMIT 5`,
    [adm.patient_uid, adm.discharge_date || adm.admission_date],
  );

  return runExplainerPipeline({
    moduleKey: 'package_compliance_check',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      'You are a revenue-cycle auditor. Check the admission billing against the contracted package.',
      'Output: explanation_summary, package_status: compliant|deviation|non_compliant, included_utilised (array), excluded_billed_separately (array), justification_required (array of { item, reason }).',
      'Cite each line item from the invoice. Never fabricate package contents.',
    ].join('\n'),
    userPromptPayload: { package_code: packageCode || adm.package_code,
      admission: { primary_diagnosis: adm.primary_diagnosis,
                   total_charges: adm.total_charges,
                   package_code: adm.package_code },
      billed_invoices: billed },
    contextForDefenses: { admission: adm, billed },
    citations: [{ source_type: 'admission', source_id: String(admId),
      label: `Admission #${admId}`, timestamp: adm.admission_date }],
    metadata: { admission_id: admId, package_code: packageCode || adm.package_code },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 7 + 8. Patient feedback summary + sentiment analysis
// ---------------------------------------------------------------------------
export async function generatePatientFeedbackSummary({
  tenantId = null, periodDays = 30,
  generatedBy = null, req = null,
} = {}) {
  const days = normalizeId(periodDays, 'period_days', { min: 7, max: 365, fallback: 30 });
  const feedback = await safeQuery(
    `SELECT n.id::text AS id,
            COALESCE(n.comment, f.comment) AS comment,
            f.rating,
            n.score AS nps_score,
            n.nps_bucket,
            n.submitted_at AS created_at
       FROM feedback_nps_responses n
       LEFT JOIN feedback f ON f.id = n.feedback_id AND f.tenant_id = n.tenant_id
      WHERE ($1::uuid IS NULL OR n.tenant_id = $1::uuid)
        AND n.submitted_at >= NOW() - $2::int * INTERVAL '1 day'
      ORDER BY n.submitted_at DESC
      LIMIT 200`, [tenantId, days],
  );
  if (!feedback.length) {
    throw AppError.notFound(`No feedback in the last ${days} days`);
  }

  return runExplainerPipeline({
    moduleKey: 'patient_feedback_summary',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are a quality analyst. Summarise the last ${days} days of patient feedback.`,
      'Output: explanation_summary, themes (array of { theme, frequency, sample_count, action_priority: low|medium|high }), nps_band_shifts, urgent_complaints (count + nature, redact identifiers).',
      'NEVER include patient names / phones in the summary. Redact even if present in the feedback comment.',
    ].join('\n'),
    userPromptPayload: { period_days: days,
      feedback_count: feedback.length,
      feedback_sample: feedback.slice(0, 100) },
    contextForDefenses: { feedback },
    citations: [{ source_type: 'feedback_window', source_id: shortHash({ days, n: feedback.length }),
      label: `Feedback last ${days}d (${feedback.length} entries)`, timestamp: null }],
    metadata: { period_days: days, sample_size: feedback.length },
    generatedBy, req,
  });
}

export async function generateSentimentAnalysis({
  tenantId = null, text,
  generatedBy = null, req = null,
} = {}) {
  const cleanText = requireText(text, 'text', { min: 5, max: 8000 });

  return runExplainerPipeline({
    moduleKey: 'sentiment_analysis',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a feedback sentiment classifier.',
      'Output: explanation_summary, sentiment: positive|neutral|negative|urgent, confidence: 0..1, theme_tags (array of short labels), redact_flag: true if PHI shapes detected.',
      'Mark urgent for any safety / complication / harassment language. PHI shapes (10-digit numbers, emails, names) trigger redact_flag=true.',
    ].join('\n'),
    userPromptPayload: { text: cleanText },
    contextForDefenses: { text: cleanText },
    citations: [{ source_type: 'feedback_text', source_id: shortHash(cleanText),
      label: `Feedback text (${cleanText.length} chars)`, timestamp: null }],
    metadata: { chars: cleanText.length },
    generatedBy, req,
  });
}

export const __testing__ = { shortHash };

export default {
  generateLabTatDelayPrediction,
  generateRadiologyTatDelayPrediction,
  generateAmbulanceDemandForecast,
  generateSmartQueueOptimization,
  generateTariffOptimizationInsights,
  generatePackageComplianceCheck,
  generatePatientFeedbackSummary,
  generateSentimentAnalysis,
};
