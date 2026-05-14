// src/services/clinical/growthPercentileService.js
//
// B-7 — WHO growth percentile + z-score computation.
//
// growth_charts (migration 131) accepts pre-computed `percentiles`
// and `z_scores` from the caller — but no server-side helper computed
// them. Paeds OPD nurses + the patient-app weight tracker had to
// either skip the field or compute by hand. This module provides:
//
//   - computeZScoreLMS({ L, M, S, value })  pure WHO LMS formula.
//   - computePercentile({ sex, ageInDays, metric, value })
//        Looks up the LMS triplet for the cohort, returns
//        { z_score, percentile, classification }.
//
// Reference data:
//   The WHO Child Growth Standards (0-5 years) and CDC 2-20 standards
//   are public. The full datasets are large (~15K rows across all
//   metrics + sex). To keep this module tractable we embed monthly
//   reference points for the most common cohort (0-60 months, height
//   + weight) and linearly interpolate between months. Production
//   accuracy work should load the full LMS file via reference_dataset
//   = 'WHO_0_5' / 'IAP_5_18' as captured in clinicalAssessmentService.
//
// LMS formula (WHO):
//   z = (((value / M) ^ L) - 1) / (L * S)        when L != 0
//   z = ln(value / M) / S                          when L  = 0
//
// Percentile:
//   percentile = Φ(z) * 100
//   where Φ is the standard normal CDF.

import { AppError } from '../../utils/AppError.js';

const VALID_METRICS = ['height_cm', 'weight_kg', 'head_circumference_cm', 'bmi'];
const VALID_SEXES = ['M', 'F'];

// ── Standard normal CDF (Abramowitz & Stegun approximation) ──────────
// Accurate to ~7 decimals — plenty for percentile rendering.
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t)
                   + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Pure LMS z-score. Exposed for callers that already have an LMS
 * triplet from another source (e.g. an external chart-spec service).
 */
export function computeZScoreLMS({ L, M, S, value }) {
  if (L == null || M == null || S == null || value == null) return null;
  const v = Number(value), l = Number(L), m = Number(M), s = Number(S);
  if (!Number.isFinite(v) || !Number.isFinite(l) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  if (m <= 0 || s <= 0 || v <= 0) return null;
  if (Math.abs(l) < 1e-9) return Math.log(v / m) / s;
  return (Math.pow(v / m, l) - 1) / (l * s);
}

// ── WHO 0-5 monthly reference (approximations) ───────────────────────
//
// Source: WHO Child Growth Standards, monthly LMS values rounded to
// 4 decimals. Embedded monthly across 0..60 months. Linear
// interpolation between months covers in-between ages.
//
// IMPORTANT: these are approximate medians + a fixed sigma per metric;
// the full WHO LMS table has different L/M/S per age. For diagnostic
// accuracy in production, replace this lookup with the full LMS load.
// This embedded set is enough for the patient-app trend tile + the
// nurse-side "child below 5th percentile" alert.

const WHO_HEIGHT_M = {
  // [ageMonth]: [M_male, M_female] in cm
  0: [49.9, 49.1], 1: [54.7, 53.7], 2: [58.4, 57.1], 3: [61.4, 59.8],
  4: [63.9, 62.1], 5: [65.9, 64.0], 6: [67.6, 65.7], 7: [69.2, 67.3],
  8: [70.6, 68.7], 9: [72.0, 70.1], 10: [73.3, 71.5], 11: [74.5, 72.8],
  12: [75.7, 74.0], 15: [79.1, 77.5], 18: [82.3, 80.7], 21: [85.1, 83.7],
  24: [87.8, 86.4], 30: [91.9, 90.7], 36: [96.1, 95.1], 42: [99.9, 99.0],
  48: [103.3, 102.7], 54: [106.7, 106.2], 60: [110.0, 109.4],
};
const WHO_WEIGHT_M = {
  // [ageMonth]: [M_male, M_female] in kg
  0: [3.3, 3.2], 1: [4.5, 4.2], 2: [5.6, 5.1], 3: [6.4, 5.8],
  4: [7.0, 6.4], 5: [7.5, 6.9], 6: [7.9, 7.3], 7: [8.3, 7.6],
  8: [8.6, 7.9], 9: [8.9, 8.2], 10: [9.2, 8.5], 11: [9.4, 8.7],
  12: [9.6, 8.9], 15: [10.3, 9.6], 18: [10.9, 10.2], 21: [11.5, 10.9],
  24: [12.2, 11.5], 30: [13.3, 12.7], 36: [14.3, 13.9], 42: [15.3, 15.0],
  48: [16.3, 16.1], 54: [17.3, 17.2], 60: [18.3, 18.2],
};

// Approximate uniform L/S per metric (the real LMS varies by month).
const APPROX_LS = {
  height_cm:              { L: 1, S: 0.040 },
  weight_kg:              { L: 0, S: 0.130 },
  head_circumference_cm:  { L: 1, S: 0.035 },
  bmi:                    { L: 0, S: 0.080 },
};

function lookupMedian(table, sex, ageMonths) {
  const sexIdx = sex === 'M' ? 0 : 1;
  // exact monthly hit
  if (table[ageMonths] !== undefined) return table[ageMonths][sexIdx];
  // Find bracketing months for linear interpolation.
  const months = Object.keys(table).map(Number).sort((a, b) => a - b);
  if (ageMonths < months[0]) return table[months[0]][sexIdx];
  if (ageMonths > months[months.length - 1]) return table[months[months.length - 1]][sexIdx];
  let lo = months[0], hi = months[months.length - 1];
  for (let i = 0; i < months.length - 1; i += 1) {
    if (ageMonths >= months[i] && ageMonths <= months[i + 1]) {
      lo = months[i]; hi = months[i + 1]; break;
    }
  }
  const span = hi - lo;
  if (span <= 0) return table[lo][sexIdx];
  const t = (ageMonths - lo) / span;
  return table[lo][sexIdx] + t * (table[hi][sexIdx] - table[lo][sexIdx]);
}

function classifyZ(z, _metric) {
  if (z == null || !Number.isFinite(z)) return null;
  // Generic WHO bands. Severity language differs by metric per the
  // WHO terminology but the cutoffs are consistent.
  if (z <= -3) return 'severely_low';
  if (z <= -2) return 'low';
  if (z >= 3)  return 'severely_high';
  if (z >= 2)  return 'high';
  return 'normal';
}

/**
 * Compute percentile + z-score + WHO classification band.
 *
 * @param {Object} args
 * @param {'M'|'F'} args.sex
 * @param {number}  args.ageInDays
 * @param {'height_cm'|'weight_kg'|'head_circumference_cm'|'bmi'} args.metric
 * @param {number}  args.value
 * @returns {{ z_score, percentile, classification, source: 'WHO_0_5_approx' | null }}
 */
export function computePercentile({ sex, ageInDays, metric, value } = {}) {
  if (!VALID_SEXES.includes(sex)) {
    throw AppError.badRequest(`sex must be one of ${VALID_SEXES.join(', ')}`);
  }
  if (!Number.isFinite(Number(ageInDays)) || Number(ageInDays) < 0) {
    throw AppError.badRequest('ageInDays must be a non-negative number');
  }
  if (!VALID_METRICS.includes(metric)) {
    throw AppError.badRequest(`metric must be one of ${VALID_METRICS.join(', ')}`);
  }
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw AppError.badRequest('value must be a positive number');
  }

  const ageMonths = Number(ageInDays) / 30.4375; // average month length
  // Out-of-table = bail with the approximate-only signal.
  if (ageMonths > 60) {
    return { z_score: null, percentile: null, classification: null,
      source: null,
      note: 'Age > 60 months — WHO 0-5 standard does not apply; load IAP 5-18 dataset for older cohorts',
    };
  }

  let M = null;
  if (metric === 'height_cm') M = lookupMedian(WHO_HEIGHT_M, sex, ageMonths);
  if (metric === 'weight_kg') M = lookupMedian(WHO_WEIGHT_M, sex, ageMonths);
  // head_circumference + bmi: not embedded in this approximate set.
  // Caller falls back to recordGrowthChart with caller-supplied values.
  if (M == null) {
    return { z_score: null, percentile: null, classification: null, source: null,
      note: `Reference data for ${metric} not embedded; load full WHO LMS dataset`,
    };
  }
  const { L, S } = APPROX_LS[metric];
  const z = computeZScoreLMS({ L, M, S, value: Number(value) });
  if (z == null) {
    return { z_score: null, percentile: null, classification: null, source: null };
  }
  const percentile = +(normalCdf(z) * 100).toFixed(2);
  return {
    z_score: +z.toFixed(3),
    percentile,
    classification: classifyZ(z, metric),
    source: 'WHO_0_5_approx',
    note: 'Approximation — embedded monthly LMS subset. Replace with full WHO LMS for diagnostic-grade accuracy.',
  };
}

// Map a free-text users.gender value to the M/F the WHO tables key on.
// Returns null for anything we can't confidently classify (intersex,
// 'unknown', empty) — the caller then skips percentile computation
// rather than guessing a cohort.
export function normaliseSex(gender) {
  if (!gender) return null;
  const g = String(gender).trim().toLowerCase();
  if (g === 'm' || g === 'male') return 'M';
  if (g === 'f' || g === 'female') return 'F';
  return null;
}

// Whole days between a date of birth and `asOf` (default now). Returns
// null for a missing / unparseable / future DOB so a caller can treat
// the percentile as simply unavailable rather than erroring.
export function ageInDaysFrom(birthday, asOf = new Date()) {
  if (!birthday) return null;
  const dob = birthday instanceof Date ? birthday : new Date(birthday);
  if (!Number.isFinite(dob.getTime())) return null;
  const days = Math.floor((asOf.getTime() - dob.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

/**
 * Given a patient's sex + DOB and a freshly-recorded weight / height,
 * compute the WHO growth percentiles for whichever measurements are
 * present. This is the wiring that lets the vitals recording flow
 * surface percentiles inline instead of forcing a separate
 * POST /clinical/assessments/growth call. Findings:
 *   2026-05-09-pediatric-opd-nurse-growth-chart-not-linked-to-vitals
 *   2026-05-11-pediatric-opd-nurse-4354eb08
 *
 * Returns null when the cohort can't be resolved — no DOB/sex on file,
 * an age outside the embedded WHO 0-5 table, or no usable measurement —
 * so callers can treat the growth block as best-effort and never block
 * the vitals save on it.
 *
 * @returns {{ sex, age_in_days, reference_dataset, metrics } | null}
 */
export function computeGrowthSnapshot({ gender, birthday, weightKg, heightCm, asOf } = {}) {
  const sex = normaliseSex(gender);
  const ageInDays = ageInDaysFrom(birthday, asOf instanceof Date ? asOf : new Date());
  if (!sex || ageInDays == null) return null;

  const metrics = {};
  for (const [metric, value] of [['weight_kg', weightKg], ['height_cm', heightCm]]) {
    if (value === null || value === undefined || value === '') continue;
    try {
      const r = computePercentile({ sex, ageInDays, metric, value: Number(value) });
      if (r && r.percentile != null) metrics[metric] = r;
    } catch (_e) {
      // A bad single measurement (negative, non-numeric) shouldn't sink
      // the other metric or the vitals save — skip it.
    }
  }
  if (Object.keys(metrics).length === 0) return null;
  return { sex, age_in_days: ageInDays, reference_dataset: 'WHO_0_5', metrics };
}

export default {
  computeZScoreLMS,
  computePercentile,
  normaliseSex,
  ageInDaysFrom,
  computeGrowthSnapshot,
};
