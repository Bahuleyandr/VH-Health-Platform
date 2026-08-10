/**
 * Deterioration Early Warning.
 *
 * Layers an ML-style trend signal on top of the existing NEWS2
 * physiological score so nurses see acceleration BEFORE the rule-based
 * thresholds fire. Composite score:
 *
 *   score = 0.5 * news2_component
 *         + 0.3 * trend_component      (rate-of-change over last 4h)
 *         + 0.2 * lab_component        (recent abnormal labs)
 *
 * Bands:
 *     0–29  stable
 *    30–54  watch
 *    55–74  concerning
 *    75–100 critical
 *
 * Decision support only — never auto-silences an alarm, never changes an
 * order. Nurses and doctors act; the score informs them.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(Number(value))) return min;
  return Math.max(min, Math.min(Number(value), max));
}

function bandFor(score) {
  if (score >= 75) return 'critical';
  if (score >= 55) return 'concerning';
  if (score >= 30) return 'watch';
  return 'stable';
}

function newsComponentFromVital(vital) {
  // Mini-NEWS2 — enough for early-warning signal without fetching the full
  // scoring service. Returns 0–100 contribution.
  let total = 0;
  if (vital.heart_rate) {
    const hr = Number(vital.heart_rate);
    if (hr >= 131 || hr <= 40) total += 30;
    else if (hr >= 111 || hr <= 50) total += 15;
    else if (hr >= 91) total += 5;
  }
  if (vital.respiratory_rate) {
    const rr = Number(vital.respiratory_rate);
    if (rr >= 25 || rr <= 8) total += 30;
    else if (rr >= 21 || rr <= 11) total += 12;
  }
  if (vital.spo2) {
    const spo2 = Number(vital.spo2);
    if (spo2 < 85) total += 40;
    else if (spo2 < 92) total += 20;
    else if (spo2 < 94) total += 8;
  }
  if (vital.systolic_bp) {
    const sbp = Number(vital.systolic_bp);
    if (sbp <= 90 || sbp >= 220) total += 30;
    else if (sbp <= 100) total += 10;
  }
  if (vital.temperature) {
    const t = Number(vital.temperature);
    if (t >= 39.1 || t <= 35.0) total += 20;
    else if (t >= 38.1) total += 8;
    else if (t <= 36.0) total += 5;
  }
  return clamp(total);
}

/**
 * Rate-of-change across the last 4h of vitals. Accelerating hypoxia or
 * tachycardia get a higher trend component than a steady state, even if
 * the absolute NEWS2 hasn't crossed a rule threshold yet.
 */
function trendComponent(vitalsSeries) {
  if (vitalsSeries.length < 2) return 0;
  const recent = vitalsSeries.slice(-4);
  if (recent.length < 2) return 0;

  let trend = 0;
  const first = recent[0];
  const last = recent[recent.length - 1];

  if (first.spo2 != null && last.spo2 != null) {
    const drop = Number(first.spo2) - Number(last.spo2);
    if (drop >= 3) trend += 35;
    else if (drop >= 1.5) trend += 15;
  }
  if (first.heart_rate != null && last.heart_rate != null) {
    const rise = Number(last.heart_rate) - Number(first.heart_rate);
    if (rise >= 25) trend += 25;
    else if (rise >= 12) trend += 10;
  }
  if (first.respiratory_rate != null && last.respiratory_rate != null) {
    const rrRise = Number(last.respiratory_rate) - Number(first.respiratory_rate);
    if (rrRise >= 5) trend += 25;
    else if (rrRise >= 2) trend += 10;
  }
  if (first.systolic_bp != null && last.systolic_bp != null) {
    const drop = Number(first.systolic_bp) - Number(last.systolic_bp);
    if (drop >= 30) trend += 25;
    else if (drop >= 15) trend += 10;
  }
  return clamp(trend);
}

async function labComponent(patientUid) {
  // Recent abnormal labs add a moderate push. We inspect structured_results
  // if investigations carries them; otherwise fall back to priority=urgent.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, priority, result_summary
     FROM investigations
     WHERE patient_uid = $1::uuid
       AND requested_at >= NOW() - INTERVAL '24 hours'
     ORDER BY requested_at DESC
     LIMIT 20`,
    patientUid
  );
  let score = 0;
  for (const row of rows) {
    const priority = String(row.priority || '').toLowerCase();
    const status = String(row.status || '').toLowerCase();
    if (priority === 'urgent') score += 10;
    if (status === 'critical') score += 20;
    if (/lactate|acidosis|hypotension|hyperkalem|creatinine/i.test(String(row.result_summary || ''))) {
      score += 15;
    }
  }
  return { score: clamp(score), abnormal_signals: rows.length };
}

function recommendations(band, contributors) {
  const recs = [];
  if (band === 'critical') {
    recs.push({
      severity: 'critical',
      message: 'Call rapid response. Score is CRITICAL — re-assess within 15 minutes.',
    });
  } else if (band === 'concerning') {
    recs.push({
      severity: 'high',
      message: 'Notify treating doctor. Re-vital every 30 minutes until trend reverses.',
    });
  } else if (band === 'watch') {
    recs.push({
      severity: 'medium',
      message: 'Increase vital-sign frequency. Review for sepsis bundle if fever or lactate abnormal.',
    });
  }
  if (contributors?.trend_component >= 30) {
    recs.push({
      severity: 'medium',
      message: 'Trend acceleration detected — deterioration may precede absolute threshold crossing.',
    });
  }
  if (contributors?.lab_component >= 30) {
    recs.push({
      severity: 'high',
      message: 'Multiple abnormal lab signals in the last 24h. Review for sepsis / AKI / electrolyte crisis.',
    });
  }
  return recs;
}

export async function scoreDeterioration({ patientUid, admissionId = null, tenantId = null } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const tid = resolveTenantId({ tenantId });

  const vitalsSeries = await prisma.$queryRawUnsafe(
    `SELECT heart_rate, systolic_bp, diastolic_bp, temperature, spo2,
            respiratory_rate, recorded_at
     FROM vitals_chart
     WHERE patient_uid = $1::uuid
       AND recorded_at >= NOW() - INTERVAL '4 hours'
     ORDER BY recorded_at ASC`,
    patientUid
  );

  if (!vitalsSeries.length) {
    return {
      patient_uid: patientUid,
      score: 0,
      band: 'stable',
      contributors: { reason: 'no_vitals_in_last_4h' },
      recommendations: [{
        severity: 'medium',
        message: 'No vitals recorded in the last 4 hours — take a fresh set before relying on this score.',
      }],
      vitals_sample_count: 0,
      decision_support_only: true,
      module_key: 'deterioration_early_warning',
    };
  }

  const latest = vitalsSeries[vitalsSeries.length - 1];
  const newsComp = newsComponentFromVital(latest);
  const trendComp = trendComponent(vitalsSeries);
  const labComp = await labComponent(patientUid);
  const score = clamp(
    0.5 * newsComp + 0.3 * trendComp + 0.2 * labComp.score
  );
  const band = bandFor(score);

  const contributors = {
    news2_component: newsComp,
    trend_component: trendComp,
    lab_component: labComp.score,
    latest_vital: latest,
    series_length: vitalsSeries.length,
    abnormal_labs_24h: labComp.abnormal_signals,
  };
  const recs = recommendations(band, contributors);

  let snapshotId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_deterioration_snapshots
         (tenant_id, patient_uid, admission_id, score, band, news2_component,
          trend_component, lab_component, contributors, recommendations,
          vitals_sample_count, scored_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, NOW())
       RETURNING id`,
      tid,
      patientUid,
      admissionId ? Number.parseInt(admissionId, 10) : null,
      score,
      band,
      newsComp,
      trendComp,
      labComp.score,
      JSON.stringify(contributors),
      JSON.stringify(recs),
      vitalsSeries.length
    );
    snapshotId = rows[0]?.id || null;
  } catch (err) {
    if (!/does not exist|relation/i.test(String(err?.message || ''))) {
      logger.warn('Deterioration snapshot persist failed', { error: err.message });
    }
  }

  return {
    snapshot_id: snapshotId,
    patient_uid: patientUid,
    admission_id: admissionId || null,
    score,
    band,
    contributors,
    recommendations: recs,
    vitals_sample_count: vitalsSeries.length,
    module_key: 'deterioration_early_warning',
    decision_support_only: true,
  };
}

export async function listDeteriorationSnapshots({ tenantId = null, band = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (patient_uid)
              id, patient_uid, admission_id, score, band, news2_component,
              trend_component, lab_component, contributors, recommendations,
              vitals_sample_count, scored_at
       FROM clinical_ai_deterioration_snapshots
       WHERE tenant_id = $1::uuid
         AND ($2::text IS NULL OR band = $2)
       ORDER BY patient_uid, scored_at DESC
       LIMIT $3`,
      tid,
      band,
      safeLimit
    );
    const bandOrder = { critical: 0, concerning: 1, watch: 2, stable: 3 };
    const sorted = rows.sort((a, b) => (bandOrder[a.band] ?? 4) - (bandOrder[b.band] ?? 4));
    return { snapshots: sorted, count: sorted.length };
  } catch (err) {
    if (/does not exist|relation/i.test(String(err?.message || ''))) {
      return { snapshots: [], count: 0 };
    }
    throw err;
  }
}

export default {
  listDeteriorationSnapshots,
  scoreDeterioration,
};
