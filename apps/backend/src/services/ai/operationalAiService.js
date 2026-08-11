/**
 * Operational AI — Batch 2.
 *
 *   scoreNoShowRisk:     per-appointment no-show score from patient history
 *                        + lead time + day-of-week. Heuristic today; ONNX
 *                        can drop in later behind the same interface.
 *
 *   predictOtCaseTime:   duration estimate per planned OT case using past
 *                        actual_duration windowed by (surgeon, procedure).
 *                        Confidence-weighted by sample size.
 *
 *   auditChargeCapture:  scans signed clinical notes on an admission for
 *                        procedure codes not yet reflected in invoices;
 *                        flags missed charges for coder review.
 *
 * All three are tenant-scoped. Scores never auto-action — they surface in
 * the admin UI as decision support.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.max(min, Math.min(Number(value), max));
}

function noShowBand(score) {
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// No-show predictor
// ---------------------------------------------------------------------------
export async function scoreNoShowRisk({ appointmentId, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_id, appointment_date, appointment_time, status, created_at, reason
     FROM appointments
     WHERE id = $1
     LIMIT 1`,
    Number.parseInt(appointmentId, 10)
  );
  const apt = rows[0];
  if (!apt) throw AppError.notFound('Appointment not found');

  const contributors = {};
  let score = 0;

  // Lead time: appointments booked <24h ahead are far more likely to no-show.
  const leadMs = new Date(apt.appointment_date).getTime() - new Date(apt.created_at).getTime();
  const leadHours = Math.max(0, Math.floor(leadMs / (60 * 60 * 1000)));
  if (leadHours < 12) {
    score += 30;
    contributors.lead_hours_under_12 = leadHours;
  } else if (leadHours > 168) {
    score += 20;
    contributors.lead_hours_over_week = leadHours;
  }

  // Prior no-show rate on same patient_id in last 365 days.
  if (apt.patient_id) {
    const [history] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status IN ('NO_SHOW', 'CANCELLED'))::int AS missed
       FROM appointments
       WHERE patient_id = $1
         AND appointment_date >= CURRENT_DATE - INTERVAL '365 days'
         AND appointment_date < CURRENT_DATE`,
      apt.patient_id
    );
    const priorTotal = Number(history?.total || 0);
    const priorMissed = Number(history?.missed || 0);
    if (priorTotal >= 3) {
      const rate = priorMissed / priorTotal;
      if (rate >= 0.5) {
        score += 40;
        contributors.prior_no_show_rate = Number(rate.toFixed(2));
      } else if (rate >= 0.25) {
        score += 20;
        contributors.prior_no_show_rate = Number(rate.toFixed(2));
      }
    }
    contributors.prior_appointments = priorTotal;
    contributors.prior_missed = priorMissed;
  }

  // Day-of-week: Mondays + Saturdays slightly higher.
  const dow = new Date(apt.appointment_date).getDay();
  if (dow === 1 || dow === 6) {
    score += 5;
    contributors.monday_or_saturday = true;
  }

  // Morning slots perform better than afternoon; naive parser of HH:MM.
  if (typeof apt.appointment_time === 'string') {
    const hourMatch = /^(\d{1,2}):/.exec(apt.appointment_time);
    const hour = hourMatch ? Number(hourMatch[1]) : null;
    if (hour != null && hour >= 16) {
      score += 5;
      contributors.late_afternoon_slot = hour;
    }
  }

  const overall = clamp(score);
  const band = noShowBand(overall);

  const recommendation = band === 'high'
    ? 'Place reminder call + consider overbooking adjacent slot.'
    : band === 'medium'
      ? 'Standard SMS reminder 24h prior is likely sufficient.'
      : 'No additional action required.';

  await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_no_show_predictions
         (tenant_id, appointment_id, patient_uid, risk_score, band, contributors,
          recommended_action, scored_at)
       VALUES ($1::uuid, $2, NULL, $3, $4, $5::jsonb, $6, NOW())
       ON CONFLICT (tenant_id, appointment_id, scored_at) DO NOTHING`,
      tid,
      apt.id,
      overall,
      band,
      JSON.stringify(contributors),
      recommendation
  );

  return {
    appointment_id: apt.id,
    risk_score: overall,
    band,
    contributors,
    recommended_action: recommendation,
    module_key: 'appointment_no_show_predictor',
    decision_support_only: true,
  };
}

// ---------------------------------------------------------------------------
// OT case-time predictor
// ---------------------------------------------------------------------------
export async function predictOtCaseTime({ scheduleId, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, surgeon, procedure_name, procedure_code,
            scheduled_date, estimated_duration
     FROM ot_schedules
     WHERE id = $1
     LIMIT 1`,
    Number.parseInt(scheduleId, 10)
  );
  const schedule = rows[0];
  if (!schedule) throw AppError.notFound('OT schedule not found');

  const contributors = {};
  let sample = [];

  if (schedule.surgeon && schedule.procedure_code) {
    sample = await prisma.$queryRawUnsafe(
      `SELECT actual_duration
       FROM ot_schedules
       WHERE surgeon = $1::uuid
         AND procedure_code = $2
         AND status IN ('completed')
         AND actual_duration IS NOT NULL
       ORDER BY scheduled_date DESC
       LIMIT 30`,
      schedule.surgeon,
      schedule.procedure_code
    );
    contributors.source = 'surgeon_procedure';
  }

  // Fallback — any surgeon, same procedure code.
  if (sample.length < 5 && schedule.procedure_code) {
    sample = await prisma.$queryRawUnsafe(
      `SELECT actual_duration
       FROM ot_schedules
       WHERE procedure_code = $1
         AND status IN ('completed')
         AND actual_duration IS NOT NULL
       ORDER BY scheduled_date DESC
       LIMIT 60`,
      schedule.procedure_code
    );
    contributors.source = 'procedure_code_only';
  }

  // Last-resort fallback — same procedure_name (free-text).
  if (sample.length < 5 && schedule.procedure_name) {
    sample = await prisma.$queryRawUnsafe(
      `SELECT actual_duration
       FROM ot_schedules
       WHERE procedure_name = $1
         AND status IN ('completed')
         AND actual_duration IS NOT NULL
       ORDER BY scheduled_date DESC
       LIMIT 60`,
      schedule.procedure_name
    );
    contributors.source = 'procedure_name_fallback';
  }

  let predicted;
  let confidence;
  if (sample.length >= 5) {
    const durations = sample.map((row) => Number(row.actual_duration)).filter(Number.isFinite);
    durations.sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    predicted = Math.round(median);
    // Confidence scales with sample size; caps at 80% without proper ML.
    confidence = Math.min(80, 30 + sample.length * 2);
    contributors.sample_size = durations.length;
    contributors.median_minutes = median;
    contributors.min_minutes = durations[0];
    contributors.max_minutes = durations[durations.length - 1];
  } else {
    // Cold start — fall back to scheduler's estimated_duration or a generic 60.
    predicted = Number(schedule.estimated_duration) > 0 ? Number(schedule.estimated_duration) : 60;
    confidence = 20;
    contributors.cold_start = true;
  }

  await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_ot_duration_predictions
         (tenant_id, ot_schedule_id, procedure_name, predicted_minutes, confidence_pct,
          sample_size, contributors, scored_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       ON CONFLICT (tenant_id, ot_schedule_id, scored_at) DO NOTHING`,
      tid,
      schedule.id,
      schedule.procedure_name,
      predicted,
      confidence,
      sample.length,
      JSON.stringify(contributors)
  );

  return {
    ot_schedule_id: schedule.id,
    procedure_name: schedule.procedure_name,
    predicted_minutes: predicted,
    confidence_pct: confidence,
    sample_size: sample.length,
    contributors,
    module_key: 'ot_case_time_predictor',
    decision_support_only: true,
  };
}

// ---------------------------------------------------------------------------
// Charge-capture audit
// ---------------------------------------------------------------------------
const PROCEDURE_CODE_HINTS = [
  { regex: /\bchest\s*x-?ray\b/i, code: 'RAD-CXR', description: 'Chest X-ray', estRevenueMinor: 50000 },
  { regex: /\bct\s*scan\b/i, code: 'RAD-CT', description: 'CT scan', estRevenueMinor: 300000 },
  { regex: /\bmri\b/i, code: 'RAD-MRI', description: 'MRI scan', estRevenueMinor: 500000 },
  { regex: /\becho(?:cardiogram)?\b/i, code: 'CAR-ECHO', description: 'Echocardiogram', estRevenueMinor: 200000 },
  { regex: /\becg\b/i, code: 'CAR-ECG', description: 'ECG', estRevenueMinor: 30000 },
  { regex: /\bendoscopy\b/i, code: 'GAS-ENDO', description: 'Endoscopy', estRevenueMinor: 400000 },
  { regex: /\bdialysis\b/i, code: 'NEP-HD', description: 'Hemodialysis session', estRevenueMinor: 350000 },
  { regex: /\bblood\s*transfusion\b/i, code: 'BLD-TRX', description: 'Blood transfusion', estRevenueMinor: 250000 },
  { regex: /\bventilator\b/i, code: 'ICU-VENT', description: 'Mechanical ventilation', estRevenueMinor: 600000 },
];

export async function auditChargeCapture({ admissionId, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid
     FROM admissions
     WHERE id = $1
     LIMIT 1`,
    Number.parseInt(admissionId, 10)
  );
  const admission = rows[0];
  if (!admission) throw AppError.notFound('Admission not found');

  // Pull signed notes + discharge summary text.
  const notes = await prisma.$queryRawUnsafe(
    `SELECT note_type, content
     FROM clinical_notes
     WHERE encounter_id = (SELECT encounter_id FROM admissions WHERE id = $1 LIMIT 1)
       AND is_signed = true`,
    admission.id
  );

  const noteText = notes.map((n) => JSON.stringify(n.content || {})).join(' \n ');

  // Pull invoiced codes from any invoices linked to this admission.
  const invoicedRows = await prisma.$queryRawUnsafe(
    `SELECT items
     FROM invoices
     WHERE patient_uid = $1::uuid
       AND created_at >= NOW() - INTERVAL '60 days'`,
    admission.patient_uid
  );
  const invoicedText = invoicedRows
    .map((row) => JSON.stringify(row.items || []))
    .join(' ')
    .toLowerCase();

  const mentioned = [];
  const missed = [];
  let estimatedRevenue = 0;

  for (const hint of PROCEDURE_CODE_HINTS) {
    if (hint.regex.test(noteText)) {
      mentioned.push({ code: hint.code, description: hint.description });
      // Rough match — if the code doesn't show up anywhere in any invoice
      // items JSON for this patient within 60 days, flag as missed.
      if (!invoicedText.includes(hint.code.toLowerCase())
          && !invoicedText.includes(hint.description.toLowerCase())) {
        missed.push({
          code: hint.code,
          description: hint.description,
          est_revenue_minor: hint.estRevenueMinor,
        });
        estimatedRevenue += hint.estRevenueMinor;
      }
    }
  }

  const saved = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_charge_capture_audits
         (tenant_id, admission_id, patient_uid, mentioned_codes, invoiced_codes,
          missed_codes, estimated_revenue_minor, scanned_at, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, '[]'::jsonb, $5::jsonb, $6, NOW(), $7::jsonb)
       RETURNING id`,
      tid,
      admission.id,
      admission.patient_uid,
      JSON.stringify(mentioned),
      JSON.stringify(missed),
      estimatedRevenue,
      JSON.stringify({ note_sample_count: notes.length })
  );
  const savedId = saved[0]?.id || null;

  return {
    audit_id: savedId,
    admission_id: admission.id,
    mentioned_codes: mentioned,
    missed_codes: missed,
    estimated_revenue_minor: estimatedRevenue,
    module_key: 'charge_capture_audit',
    reviewer_decision: 'pending',
    decision_support_only: true,
  };
}

export async function listChargeCaptureAudits({ tenantId = null, decision = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
      `SELECT id, admission_id, patient_uid, mentioned_codes, missed_codes,
              estimated_revenue_minor, reviewer_decision, reviewed_by, reviewed_at, scanned_at
       FROM clinical_ai_charge_capture_audits
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR reviewer_decision = $2)
       ORDER BY scanned_at DESC
       LIMIT $3`,
      tid,
      decision,
      safeLimit
  );
  return { audits: rows, count: rows.length };
}

export async function decideChargeCaptureAudit({ auditId, decision, reviewerUid = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(decision || '').toLowerCase();
  if (!['captured', 'rejected'].includes(normalized)) {
    throw AppError.badRequest('decision must be captured or rejected');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_charge_capture_audits
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid
       AND reviewer_decision = 'pending'
     RETURNING id, admission_id, reviewer_decision, reviewed_by, reviewed_at, missed_codes, estimated_revenue_minor`,
    Number.parseInt(auditId, 10),
    normalized,
    reviewerUid,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Pending charge-capture audit not found');
  return rows[0];
}

export default {
  auditChargeCapture,
  decideChargeCaptureAudit,
  listChargeCaptureAudits,
  predictOtCaseTime,
  scoreNoShowRisk,
};
