import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  recordCriticalThresholdLookup,
} from '../../observability/labCriticalThresholdMetrics.js';

const CRITICAL_THRESHOLD_ALIASES = [
  {
    testCodes: ['TROP', 'TROPI'],
    loincCodes: ['6598-7', '10839-9'],
  },
];

function normalizeLabUnit(unit) {
  if (unit == null || unit === '') return '';
  return String(unit)
    .trim()
    .toLowerCase()
    .replace(/μ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/\s+/g, '');
}

function valueForCriticalThreshold(value, resultUnit, thresholdUnit) {
  const numericValue = Number(value);
  const result = normalizeLabUnit(resultUnit);
  const threshold = normalizeLabUnit(thresholdUnit);
  // A legacy threshold with no declared unit retains its historical raw-value
  // behavior. Two explicit but different units are never assumed equivalent
  // unless this service has an already-supported deterministic conversion.
  if (!threshold || result === threshold) {
    return { compatible: true, value: numericValue, conversion: null };
  }
  if (!result) return { compatible: false, value: null, conversion: null };
  const thresholdIsThousandsPerMicroliter = ['10^3/ul', 'x10^3/ul', '10^9/l'].includes(threshold);
  const resultIsPerMicroliter = ['/ul', 'cells/ul', 'count/ul'].includes(result);
  if (thresholdIsThousandsPerMicroliter && resultIsPerMicroliter) {
    return {
      compatible: true,
      value: numericValue / 1000,
      conversion: 'per_microliter_to_thousands_per_microliter',
    };
  }
  const resultIsThousandsPerMicroliter = ['10^3/ul', 'x10^3/ul', '10^9/l'].includes(result);
  const thresholdIsPerMicroliter = ['/ul', 'cells/ul', 'count/ul'].includes(threshold);
  if (resultIsThousandsPerMicroliter && thresholdIsPerMicroliter) {
    return {
      compatible: true,
      value: numericValue * 1000,
      conversion: 'thousands_per_microliter_to_per_microliter',
    };
  }
  return { compatible: false, value: null, conversion: null };
}

export function criticalThresholdLookupKeys(result) {
  const loincCodes = new Set();
  const testCodes = new Set();
  const loinc = result.loinc_code ? String(result.loinc_code).trim() : null;
  const testCode = result.test_code ? String(result.test_code).trim().toUpperCase() : null;

  if (loinc) loincCodes.add(loinc);
  if (testCode) testCodes.add(testCode);
  for (const alias of CRITICAL_THRESHOLD_ALIASES) {
    if (
      (loinc && alias.loincCodes.includes(loinc))
      || (testCode && alias.testCodes.includes(testCode))
    ) {
      alias.loincCodes.forEach((code) => loincCodes.add(code));
      alias.testCodes.forEach((code) => testCodes.add(code));
    }
  }
  return { loincCodes: [...loincCodes], testCodes: [...testCodes] };
}

export async function assertConfiguredCriticalAnalytesNumeric({
  client = prisma,
  tenantId,
  results,
}) {
  const loincCodes = new Set();
  const testCodes = new Set();
  for (const result of Array.isArray(results) ? results : []) {
    if (result?.value_numeric != null) continue;
    const keys = criticalThresholdLookupKeys(result || {});
    keys.loincCodes.forEach((code) => loincCodes.add(code));
    keys.testCodes.forEach((code) => testCodes.add(code));
  }
  if (loincCodes.size === 0 && testCodes.size === 0) return;

  const configured = await client.$queryRawUnsafe(
    `SELECT id
       FROM lab_critical_thresholds
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND (
          (loinc_code IS NOT NULL AND loinc_code = ANY($2::text[])) OR
          (test_code IS NOT NULL AND UPPER(test_code) = ANY($3::text[]))
        )
      LIMIT 1`,
    tenantId,
    [...loincCodes],
    [...testCodes],
  );
  if (configured.length > 0) {
    throw AppError.badRequest(
      'A configured critical-threshold analyte requires a numeric result value',
      'NON_NUMERIC_FOR_CRITICAL_THRESHOLD',
    );
  }
}

/**
 * Count one lookup that matched no active threshold for this tenant.
 *
 * DELIBERATELY ISSUES NO QUERY. An earlier revision probed here to separate
 * "this analyte has no limit" (ordinary) from "this tenant has none at all"
 * (the tenancy defect) — but every production caller passes its OPEN
 * TRANSACTION as `client`, and a failed statement aborts that transaction in
 * Postgres. The catch swallowed the JS rejection while the next write died
 * with 25P02, so an observability probe could stop a lab result being
 * recorded — the exact failure this whole change set exists to prevent, and
 * the transaction-boundary trap documented in apps/backend/CLAUDE.md.
 *
 * The tenant-wide question is answered out of band by the canary check, which
 * runs on its own connection outside any clinical transaction.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {object} args.result   the lab result row being evaluated
 * @returns {void}
 */
function noteUnmatchedCriticalThreshold({ tenantId, result }) {
  try {
    recordCriticalThresholdLookup('unmatched');
  } catch (err) {
    logger.warn('lab critical threshold: lookup metric failed', {
      tenantId,
      outcome: 'unmatched',
      test_code: result?.test_code || null,
      loinc_code: result?.loinc_code || null,
      err: err?.message,
    });
  }
}

export async function evaluateCriticalThreshold({ client = prisma, tenantId, result }) {
  if (result.value_numeric == null) {
    return { matched: false, breached: false, evaluatedValue: null };
  }

  const { loincCodes, testCodes } = criticalThresholdLookupKeys(result);
  const thresholds = await client.$queryRawUnsafe(
    `SELECT id, loinc_code, test_code, critical_low, critical_high, test_name,
            unit, applies_to,
            CASE
              WHEN loinc_code = $4 THEN 0
              WHEN UPPER(test_code) = $5 THEN 1
              WHEN loinc_code = ANY($2::text[]) THEN 2
              ELSE 3
            END AS match_rank
       FROM lab_critical_thresholds
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND (
          (loinc_code IS NOT NULL AND loinc_code = ANY($2::text[])) OR
          (test_code IS NOT NULL AND UPPER(test_code) = ANY($3::text[]))
        )
      ORDER BY
        CASE
          WHEN loinc_code = $4 THEN 0
          WHEN UPPER(test_code) = $5 THEN 1
          WHEN loinc_code = ANY($2::text[]) THEN 2
          ELSE 3
        END,
        id ASC`,
    tenantId,
    loincCodes,
    testCodes,
    result.loinc_code || null,
    result.test_code ? String(result.test_code).trim().toUpperCase() : null,
  );
  if (!thresholds.length) {
    // Observability only: an in-memory counter, no statement on the caller's
    // transaction. See noteUnmatchedCriticalThreshold above.
    noteUnmatchedCriticalThreshold({ tenantId, result });
    return {
      matched: false,
      breached: false,
      evaluatedValue: Number(result.value_numeric),
    };
  }
  try {
    recordCriticalThresholdLookup('matched');
  } catch (err) {
    logger.warn('lab critical threshold: lookup metric failed', {
      tenantId, outcome: 'matched', err: err?.message,
    });
  }

  const bestRank = Math.min(...thresholds.map((row) => Number(row.match_rank ?? 0)));
  const bestMatches = thresholds.filter(
    (row) => Number(row.match_rank ?? 0) === bestRank,
  );
  const scopedMatches = bestMatches.filter(
    (row) => !['', 'all'].includes(String(row.applies_to || 'all').trim().toLowerCase()),
  );
  if (scopedMatches.length > 0) {
    throw AppError.badRequest(
      'Lab critical-threshold population scope cannot be resolved; result was not recorded',
      'LAB_CRITICAL_POLICY_MISMATCH',
      {
        reasons: ['population_scope'],
        test_code: result.test_code || null,
        loinc_code: result.loinc_code || null,
        configured_scopes: [...new Set(scopedMatches.map((row) => row.applies_to))],
      },
    );
  }
  if (bestMatches.length !== 1) {
    throw AppError.badRequest(
      'Lab critical-threshold policy is ambiguous; result was not recorded',
      'LAB_CRITICAL_POLICY_MISMATCH',
      {
        reasons: ['threshold_ambiguous'],
        test_code: result.test_code || null,
        loinc_code: result.loinc_code || null,
        threshold_ids: bestMatches.map((row) => Number(row.id)).filter(Number.isFinite),
      },
    );
  }
  const threshold = bestMatches[0];
  const criticalLow = threshold.critical_low == null ? null : Number(threshold.critical_low);
  const criticalHigh = threshold.critical_high == null ? null : Number(threshold.critical_high);
  const converted = valueForCriticalThreshold(
    result.value_numeric,
    result.unit,
    threshold.unit,
  );
  if (!converted.compatible) {
    throw AppError.badRequest(
      'Lab result unit does not match the configured critical-threshold unit; result was not recorded',
      'LAB_CRITICAL_POLICY_MISMATCH',
      {
        reasons: ['threshold_unit'],
        test_code: result.test_code || null,
        loinc_code: result.loinc_code || null,
        result_unit: result.unit || null,
        threshold_unit: threshold.unit || null,
      },
    );
  }
  const evaluatedValue = converted.value;
  let breachedSide = null;
  let breachedValue = null;
  if (criticalLow != null && evaluatedValue < criticalLow) {
    breachedSide = 'low';
    breachedValue = criticalLow;
  } else if (criticalHigh != null && evaluatedValue > criticalHigh) {
    breachedSide = 'high';
    breachedValue = criticalHigh;
  }

  return {
    matched: true,
    breached: breachedSide != null,
    breachedSide,
    breachedValue,
    evaluatedValue,
    criticalLow,
    criticalHigh,
    thresholdId: Number(threshold.id),
    thresholdTestCode: threshold.test_code || null,
    thresholdLoincCode: threshold.loinc_code || null,
    thresholdUnit: threshold.unit || null,
    thresholdAppliesTo: threshold.applies_to ?? null,
    conversion: converted.conversion,
  };
}

export default {
  assertConfiguredCriticalAnalytesNumeric,
  criticalThresholdLookupKeys,
  evaluateCriticalThreshold,
};
