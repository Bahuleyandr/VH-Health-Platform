// src/services/clinical/growthPercentileService.js
//
// B-7 / NL-5 P4 growth percentile + z-score computation.
//
// Reference data posture:
//   1. Prefer full LMS rows in growth_reference_lms.
//   2. Fall back to the embedded WHO 0-5 approximation when DB reference
//      rows are absent, so dev/offline behavior remains unchanged.
//   3. IAP 5-18 cohorts require imported LMS rows.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';

const VALID_METRICS = ['height_cm', 'weight_kg', 'head_circumference_cm', 'bmi'];
const VALID_SEXES = ['M', 'F'];
const GROWTH_DATASETS = ['WHO_0_5', 'IAP_5_18', 'CDC_2_20', 'FENTON'];
const AVERAGE_MONTH_DAYS = 30.4375;
const WHO_MAX_AGE_DAYS = Math.round(60 * AVERAGE_MONTH_DAYS);
const IAP_MAX_AGE_DAYS = Math.round(18 * 365.25);
const lmsCache = new Map();
let loggedLmsLookupFailure = false;

// Standard normal CDF (Abramowitz & Stegun approximation). Accurate to
// ~7 decimals, which is plenty for percentile rendering.
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + 0.3275911 * x);
  const y = 1.0 - (((((1.061405429 * t - 1.453152027) * t)
                   + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

export function computeZScoreLMS({ L, M, S, value }) {
  if (L == null || M == null || S == null || value == null) return null;
  const v = Number(value), l = Number(L), m = Number(M), s = Number(S);
  if (!Number.isFinite(v) || !Number.isFinite(l) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  if (m <= 0 || s <= 0 || v <= 0) return null;
  if (Math.abs(l) < 1e-9) return Math.log(v / m) / s;
  return (Math.pow(v / m, l) - 1) / (l * s);
}

// WHO 0-5 monthly reference approximation. The full WHO LMS table should be
// imported into growth_reference_lms for diagnostic-grade accuracy.
const WHO_HEIGHT_M = {
  0: [49.9, 49.1], 1: [54.7, 53.7], 2: [58.4, 57.1], 3: [61.4, 59.8],
  4: [63.9, 62.1], 5: [65.9, 64.0], 6: [67.6, 65.7], 7: [69.2, 67.3],
  8: [70.6, 68.7], 9: [72.0, 70.1], 10: [73.3, 71.5], 11: [74.5, 72.8],
  12: [75.7, 74.0], 15: [79.1, 77.5], 18: [82.3, 80.7], 21: [85.1, 83.7],
  24: [87.8, 86.4], 30: [91.9, 90.7], 36: [96.1, 95.1], 42: [99.9, 99.0],
  48: [103.3, 102.7], 54: [106.7, 106.2], 60: [110.0, 109.4],
};
const WHO_WEIGHT_M = {
  0: [3.3, 3.2], 1: [4.5, 4.2], 2: [5.6, 5.1], 3: [6.4, 5.8],
  4: [7.0, 6.4], 5: [7.5, 6.9], 6: [7.9, 7.3], 7: [8.3, 7.6],
  8: [8.6, 7.9], 9: [8.9, 8.2], 10: [9.2, 8.5], 11: [9.4, 8.7],
  12: [9.6, 8.9], 15: [10.3, 9.6], 18: [10.9, 10.2], 21: [11.5, 10.9],
  24: [12.2, 11.5], 30: [13.3, 12.7], 36: [14.3, 13.9], 42: [15.3, 15.0],
  48: [16.3, 16.1], 54: [17.3, 17.2], 60: [18.3, 18.2],
};

const APPROX_LS = {
  height_cm:              { L: 1, S: 0.040 },
  weight_kg:              { L: 0, S: 0.130 },
  head_circumference_cm:  { L: 1, S: 0.035 },
  bmi:                    { L: 0, S: 0.080 },
};

function lookupMedian(table, sex, ageMonths) {
  const sexIdx = sex === 'M' ? 0 : 1;
  if (table[ageMonths] !== undefined) return table[ageMonths][sexIdx];
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
  if (z <= -3) return 'severely_low';
  if (z <= -2) return 'low';
  if (z >= 3) return 'severely_high';
  if (z >= 2) return 'high';
  return 'normal';
}

function numberFromDb(value) {
  if (value == null) return null;
  if (typeof value.toNumber === 'function') return value.toNumber();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function datasetForAge(ageInDays) {
  const age = Number(ageInDays);
  if (age <= WHO_MAX_AGE_DAYS) return 'WHO_0_5';
  if (age <= IAP_MAX_AGE_DAYS) return 'IAP_5_18';
  return null;
}

function lmsCacheKey(dataset, sex, metric) {
  return `${dataset}:${sex}:${metric}`;
}

async function loadLmsRows(dataset, sex, metric) {
  const key = lmsCacheKey(dataset, sex, metric);
  if (lmsCache.has(key)) return lmsCache.get(key);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT age_days, l, m, s, source_version
         FROM growth_reference_lms
        WHERE dataset = $1
          AND sex = $2
          AND metric = $3
        ORDER BY age_days ASC`,
      dataset, sex, metric,
    );
    const normalized = rows.map((row) => ({
      age_days: Number(row.age_days),
      L: numberFromDb(row.l),
      M: numberFromDb(row.m),
      S: numberFromDb(row.s),
      source_version: row.source_version || null,
    })).filter((row) => Number.isFinite(row.age_days)
      && Number.isFinite(row.L)
      && Number.isFinite(row.M)
      && Number.isFinite(row.S));
    lmsCache.set(key, normalized);
    return normalized;
  } catch (err) {
    if (!loggedLmsLookupFailure) {
      logger.warn(`growthPercentileService: growth_reference_lms lookup unavailable; using fallback where possible (${err?.message ?? err})`);
      loggedLmsLookupFailure = true;
    }
    return [];
  }
}

function interpolateLms(rows, ageInDays) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const age = Number(ageInDays);
  const exact = rows.find((row) => row.age_days === age);
  if (exact) return exact;
  if (age < rows[0].age_days || age > rows[rows.length - 1].age_days) return null;
  let lo = rows[0], hi = rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (age >= rows[i].age_days && age <= rows[i + 1].age_days) {
      lo = rows[i]; hi = rows[i + 1]; break;
    }
  }
  const span = hi.age_days - lo.age_days;
  if (span <= 0) return lo;
  const t = (age - lo.age_days) / span;
  return {
    L: lo.L + t * (hi.L - lo.L),
    M: lo.M + t * (hi.M - lo.M),
    S: lo.S + t * (hi.S - lo.S),
    source_version: hi.source_version || lo.source_version || null,
  };
}

function shapeResult({ z, metric, source, sourceVersion = null, referenceDataset = null, note = null }) {
  if (z == null) {
    return { z_score: null, percentile: null, classification: null, source, reference_dataset: referenceDataset, note };
  }
  const result = {
    z_score: +z.toFixed(3),
    percentile: +(normalCdf(z) * 100).toFixed(2),
    classification: classifyZ(z, metric),
    source,
    reference_dataset: referenceDataset,
  };
  if (sourceVersion) result.source_version = sourceVersion;
  if (note) result.note = note;
  return result;
}

async function computeFromReferenceTable({ dataset, sex, ageInDays, metric, value }) {
  const rows = await loadLmsRows(dataset, sex, metric);
  const lms = interpolateLms(rows, Number(ageInDays));
  if (!lms) return null;
  const z = computeZScoreLMS({ L: lms.L, M: lms.M, S: lms.S, value: Number(value) });
  return shapeResult({
    z,
    metric,
    source: dataset,
    sourceVersion: lms.source_version,
    referenceDataset: dataset,
  });
}

function computeApproximateWho({ sex, ageInDays, metric, value }) {
  const ageMonths = Number(ageInDays) / AVERAGE_MONTH_DAYS;
  let M = null;
  if (metric === 'height_cm') M = lookupMedian(WHO_HEIGHT_M, sex, ageMonths);
  if (metric === 'weight_kg') M = lookupMedian(WHO_WEIGHT_M, sex, ageMonths);
  if (M == null) {
    return shapeResult({
      z: null,
      metric,
      source: null,
      referenceDataset: 'WHO_0_5',
      note: `Reference data for ${metric} not embedded; load full WHO LMS dataset`,
    });
  }
  const { L, S } = APPROX_LS[metric];
  const z = computeZScoreLMS({ L, M, S, value: Number(value) });
  return shapeResult({
    z,
    metric,
    source: 'WHO_0_5_approx',
    referenceDataset: 'WHO_0_5',
    note: 'Approximation - embedded monthly LMS subset. Replace with full WHO LMS for diagnostic-grade accuracy.',
  });
}

export function clearGrowthReferenceCache() {
  lmsCache.clear();
  loggedLmsLookupFailure = false;
}

export async function computePercentile({ sex, ageInDays, metric, value } = {}) {
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

  const dataset = datasetForAge(ageInDays);
  if (!dataset || !GROWTH_DATASETS.includes(dataset)) {
    return {
      z_score: null,
      percentile: null,
      classification: null,
      source: null,
      reference_dataset: null,
      note: 'Age is outside the configured WHO 0-5 and IAP 5-18 pediatric LMS cohorts',
    };
  }

  const tableResult = await computeFromReferenceTable({ dataset, sex, ageInDays, metric, value });
  if (tableResult) return tableResult;

  if (dataset === 'WHO_0_5') {
    return computeApproximateWho({ sex, ageInDays, metric, value });
  }

  return {
    z_score: null,
    percentile: null,
    classification: null,
    source: null,
    reference_dataset: dataset,
    note: `${dataset} LMS rows are not loaded for ${sex}/${metric}`,
  };
}

export function normaliseSex(gender) {
  if (!gender) return null;
  const g = String(gender).trim().toLowerCase();
  if (g === 'm' || g === 'male') return 'M';
  if (g === 'f' || g === 'female') return 'F';
  return null;
}

export function ageInDaysFrom(birthday, asOf = new Date()) {
  if (!birthday) return null;
  const dob = birthday instanceof Date ? birthday : new Date(birthday);
  if (!Number.isFinite(dob.getTime())) return null;
  const days = Math.floor((asOf.getTime() - dob.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

export async function computeGrowthSnapshot({
  gender,
  birthday,
  weightKg,
  heightCm,
  headCircumferenceCm,
  bmi,
  asOf,
} = {}) {
  const sex = normaliseSex(gender);
  const ageInDays = ageInDaysFrom(birthday, asOf instanceof Date ? asOf : new Date());
  if (!sex || ageInDays == null) return null;

  const metrics = {};
  for (const [metric, value] of [
    ['weight_kg', weightKg],
    ['height_cm', heightCm],
    ['head_circumference_cm', headCircumferenceCm],
    ['bmi', bmi],
  ]) {
    if (value === null || value === undefined || value === '') continue;
    try {
      const r = await computePercentile({ sex, ageInDays, metric, value: Number(value) });
      if (r && r.percentile != null) metrics[metric] = r;
    } catch (err) {
      logger.warn(
        `growthPercentileService: skipping ${metric} percentile (sex=${sex}, ageInDays=${ageInDays}, value=${value}): ${err?.message ?? err}`,
      );
    }
  }
  if (Object.keys(metrics).length === 0) return null;
  return { sex, age_in_days: ageInDays, reference_dataset: datasetForAge(ageInDays), metrics };
}

export default {
  computeZScoreLMS,
  computePercentile,
  normaliseSex,
  ageInDaysFrom,
  computeGrowthSnapshot,
  clearGrowthReferenceCache,
};
