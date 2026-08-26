import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  recordCriticalThresholdLookup,
} from '../../observability/labCriticalThresholdMetrics.js';

const CRITICAL_THRESHOLD_ALIASES = [
  {
    testCodes: ['TROP', 'TROPI'],
    loincCodes: ['6598-7', '10839-9'],
  },
];

function cleanText(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

export function normalizeLabUnit(unit) {
  if (unit == null || unit === '') return '';
  return String(unit)
    .trim()
    .toLowerCase()
    .replace(/μ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/\s+/g, '');
}

export function valueForCriticalThreshold(value, resultUnit, thresholdUnit) {
  const numericValue = Number(value);
  const result = normalizeLabUnit(resultUnit);
  const threshold = normalizeLabUnit(thresholdUnit);
  if (!Number.isFinite(numericValue)) {
    return { compatible: false, value: null, conversion: null };
  }
  if (result && result === threshold) {
    return { compatible: true, value: numericValue, conversion: null };
  }
  if (!result || !threshold) {
    return { compatible: false, value: null, conversion: null };
  }
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
  const loinc = cleanText(result?.loinc_code);
  const testCode = cleanText(result?.test_code)?.toUpperCase() || null;

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

function normalizeSex(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['m', 'male'].includes(normalized)) return 'M';
  if (['f', 'female'].includes(normalized)) return 'F';
  if (['x', 'other', 'nonbinary', 'non-binary'].includes(normalized)) return 'X';
  if (['u', 'unknown', 'undifferentiated'].includes(normalized)) return 'U';
  return null;
}

function ageDaysAt(birthday, evaluatedAt) {
  if (!birthday) return null;
  const born = new Date(birthday);
  if (Number.isNaN(born.getTime())) return null;
  const days = Math.floor((evaluatedAt.getTime() - born.getTime()) / 86_400_000);
  return days >= 0 ? days : null;
}

function normalizeSpecimen(value) {
  return cleanText(value)?.toLowerCase() || null;
}

function identityRank(entry, result) {
  const resultLoinc = cleanText(result.loinc_code);
  const resultTestCode = cleanText(result.test_code)?.toUpperCase() || null;
  const entryLoinc = cleanText(entry.loinc_code);
  const entryTestCode = cleanText(entry.test_code)?.toUpperCase() || null;
  if (resultLoinc && entryLoinc === resultLoinc) return 0;
  if (resultTestCode && entryTestCode === resultTestCode) return 1;
  const keys = criticalThresholdLookupKeys(result);
  if (entryLoinc && keys.loincCodes.includes(entryLoinc)) return 2;
  if (entryTestCode && keys.testCodes.includes(entryTestCode)) return 3;
  return Number.POSITIVE_INFINITY;
}

function demographicMatches(entry, context) {
  if (entry.sex && entry.sex !== context.sex) return false;
  if (entry.age_min_days != null) {
    if (context.ageDays == null || context.ageDays < Number(entry.age_min_days)) return false;
  }
  if (entry.age_max_days != null) {
    if (context.ageDays == null || context.ageDays >= Number(entry.age_max_days)) return false;
  }
  if (entry.pregnancy_scope === 'pregnant' && context.isPregnant !== true) return false;
  if (entry.pregnancy_scope === 'not_pregnant' && context.isPregnant !== false) return false;
  return true;
}

function populationScope(entry) {
  if (
    !entry.sex
    && entry.age_min_days == null
    && entry.age_max_days == null
    && entry.pregnancy_scope === 'all'
  ) return 'all';
  return 'governed';
}

function recordLookup(outcome, { tenantId, result }) {
  try {
    recordCriticalThresholdLookup(outcome);
  } catch (err) {
    logger.warn('lab threshold policy: lookup metric failed', {
      tenantId,
      outcome,
      test_code: result?.test_code || null,
      loinc_code: result?.loinc_code || null,
      err: err?.message,
    });
  }
}

function unmatchedAssessment({
  tenantId,
  result,
  reason,
  evaluatedAt,
  evaluatedValue,
  facilityId = null,
  specimenType = null,
  bundle = null,
  catalogEntry = null,
  details = {},
}) {
  recordLookup('unmatched', { tenantId, result });
  return {
    matched: false,
    breached: false,
    breachedSide: null,
    breachedValue: null,
    evaluatedValue,
    referenceLow: null,
    referenceHigh: null,
    criticalLow: null,
    criticalHigh: null,
    thresholdId: null,
    policyBundleId: bundle?.id || null,
    policyRuleId: null,
    catalogEntryId: catalogEntry?.id || null,
    catalogRevision: bundle?.catalog_revision == null
      ? null
      : Number(bundle.catalog_revision),
    thresholdTestCode: catalogEntry?.test_code || result.test_code || null,
    thresholdLoincCode: catalogEntry?.loinc_code || result.loinc_code || null,
    thresholdUnit: catalogEntry?.normalized_unit || null,
    thresholdAppliesTo: catalogEntry ? populationScope(catalogEntry) : null,
    conversion: null,
    evaluationMode: catalogEntry?.evaluation_mode || null,
    exemptionReason: null,
    criticalityStatus: 'threshold_unavailable',
    unmatchedReason: reason,
    evaluatedAt,
    facilityId,
    specimenType,
    details,
  };
}

async function resultContext({ client, tenantId, result }) {
  let persisted = null;
  const resultId = Number(result?.id);
  if (Number.isSafeInteger(resultId) && resultId > 0) {
    const rows = await client.$queryRawUnsafe(
      `SELECT result.id, result.patient_uid, result.facility_id AS result_facility_id,
              result.specimen_type AS result_specimen_type,
              result.performed_at, result.received_at,
              analyzer.facility_id AS analyzer_facility_id,
              specimen.specimen_type AS specimen_record_type,
              investigation_queue.facility_id AS investigation_facility_id,
              booking_queue.facility_id AS booking_facility_id,
              specimen_booking_queue.facility_id AS specimen_booking_facility_id,
              patient.gender, patient.birthday, patient.is_pregnant
         FROM lab_results AS result
         LEFT JOIN lab_analyzers AS analyzer
           ON analyzer.tenant_id = result.tenant_id
          AND analyzer.id = result.analyzer_id
         LEFT JOIN lab_specimens AS specimen
           ON specimen.tenant_id = result.tenant_id
          AND specimen.id = result.specimen_id
         LEFT JOIN investigations AS investigation
           ON investigation.tenant_id = result.tenant_id
          AND investigation.id = result.investigation_id
         LEFT JOIN appointments AS investigation_appointment
           ON investigation_appointment.tenant_id = investigation.tenant_id
          AND investigation_appointment.id = investigation.appointment_id
         LEFT JOIN appointment_queues AS investigation_queue
           ON investigation_queue.tenant_id = investigation_appointment.tenant_id
          AND investigation_queue.id = investigation_appointment.queue_id
         LEFT JOIN investigation_bookings AS booking
           ON booking.tenant_id = result.tenant_id
          AND booking.id = result.booking_id
         LEFT JOIN appointments AS booking_appointment
           ON booking_appointment.tenant_id = booking.tenant_id
          AND booking_appointment.id = booking.appointment_id
         LEFT JOIN appointment_queues AS booking_queue
           ON booking_queue.tenant_id = booking_appointment.tenant_id
          AND booking_queue.id = booking_appointment.queue_id
         LEFT JOIN investigation_bookings AS specimen_booking
           ON specimen_booking.tenant_id = specimen.tenant_id
          AND specimen_booking.id = specimen.booking_id
         LEFT JOIN appointments AS specimen_booking_appointment
           ON specimen_booking_appointment.tenant_id = specimen_booking.tenant_id
          AND specimen_booking_appointment.id = specimen_booking.appointment_id
         LEFT JOIN appointment_queues AS specimen_booking_queue
           ON specimen_booking_queue.tenant_id = specimen_booking_appointment.tenant_id
          AND specimen_booking_queue.id = specimen_booking_appointment.queue_id
         LEFT JOIN users AS patient
           ON patient.tenant_id = result.tenant_id
          AND patient.uid = result.patient_uid
        WHERE result.tenant_id = $1::uuid
          AND result.id = $2::int
        LIMIT 1`,
      tenantId,
      resultId,
    );
    persisted = rows[0] || null;
  }

  const evaluatedAt = new Date(
    persisted?.performed_at
      || result?.performed_at
      || persisted?.received_at
      || result?.received_at
      || Date.now(),
  );
  const safeEvaluatedAt = Number.isNaN(evaluatedAt.getTime()) ? new Date() : evaluatedAt;
  const facilitySources = [
    ['result', persisted?.result_facility_id ?? result?.facility_id],
    ['analyzer', persisted?.analyzer_facility_id ?? result?.analyzer_facility_id],
    ['investigation', persisted?.investigation_facility_id],
    ['booking', persisted?.booking_facility_id],
    ['specimen_booking', persisted?.specimen_booking_facility_id],
  ].filter(([, value]) => value != null)
    .map(([source, value]) => [source, Number(value)])
    .filter(([, value]) => Number.isSafeInteger(value) && value > 0);
  const distinctFacilityIds = [...new Set(facilitySources.map(([, value]) => value))];
  let facilityId = distinctFacilityIds.length === 1 ? distinctFacilityIds[0] : null;
  let facilityIssue = distinctFacilityIds.length > 1 ? 'conflicting_sources' : null;

  if (distinctFacilityIds.length === 0) {
    const facilities = await client.$queryRawUnsafe(
      `SELECT id, is_default
         FROM facilities
        WHERE tenant_id = $1::uuid
          AND lower(status) = 'active'
        ORDER BY is_default DESC, id
        LIMIT 3`,
      tenantId,
    );
    const defaults = facilities.filter((facility) => facility.is_default === true);
    if (defaults.length === 1) facilityId = Number(defaults[0].id);
    else if (facilities.length === 1) facilityId = Number(facilities[0].id);
    else facilityIssue = facilities.length === 0 ? 'no_active_facility' : 'multiple_facilities';
  }

  const specimenSources = [
    persisted?.result_specimen_type ?? result?.specimen_type,
    persisted?.specimen_record_type ?? result?.specimen_record_type,
  ].map(normalizeSpecimen).filter(Boolean);
  const specimens = [...new Set(specimenSources)];

  return {
    facilityId,
    facilityIssue,
    facilitySources: Object.fromEntries(facilitySources),
    specimenType: specimens.length === 1 ? specimens[0] : null,
    specimenConflict: specimens.length > 1,
    specimenSources,
    evaluatedAt: safeEvaluatedAt,
    sex: normalizeSex(persisted?.gender ?? result?.gender ?? result?.sex),
    ageDays: ageDaysAt(
      persisted?.birthday ?? result?.birthday,
      safeEvaluatedAt,
    ),
    isPregnant: typeof (persisted?.is_pregnant ?? result?.is_pregnant) === 'boolean'
      ? (persisted?.is_pregnant ?? result?.is_pregnant)
      : null,
  };
}

export async function evaluateCriticalThreshold({ client = prisma, tenantId, result }) {
  const context = await resultContext({ client, tenantId, result });
  const numericValue = result.value_numeric == null ? null : Number(result.value_numeric);
  const evaluatedValue = Number.isFinite(numericValue) ? numericValue : null;
  if (!context.facilityId) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'facility_unresolved',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      specimenType: context.specimenType,
      details: {
        facility_issue: context.facilityIssue,
        facility_sources: context.facilitySources,
      },
    });
  }

  const stateRows = await client.$queryRawUnsafe(
    `SELECT state.current_revision,
            (SELECT COUNT(*)::int
               FROM lab_threshold_catalog_entries AS catalog
              WHERE catalog.tenant_id = state.tenant_id
                AND catalog.facility_id = state.facility_id
                AND catalog.introduced_revision <= state.current_revision
                AND (
                  catalog.retired_revision IS NULL
                  OR catalog.retired_revision > state.current_revision
                )) AS entry_count
       FROM lab_threshold_catalog_states AS state
      WHERE state.tenant_id = $1::uuid
        AND state.facility_id = $2::int
      LIMIT 1`,
    tenantId,
    context.facilityId,
  );
  const catalogState = stateRows[0] || null;
  if (!catalogState || Number(catalogState.entry_count) === 0) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'no_catalog',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
    });
  }

  const bundleRows = await client.$queryRawUnsafe(
    `SELECT id, facility_id, bundle_version, catalog_revision,
            lifecycle_status, content_sha256, effective_from, effective_until
       FROM lab_threshold_policy_bundles
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
        AND lifecycle_status = 'active'
      LIMIT 2`,
    tenantId,
    context.facilityId,
  );
  if (bundleRows.length !== 1) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: bundleRows.length > 1 ? 'ambiguous_policy' : 'no_active_bundle',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      details: { active_bundle_count: bundleRows.length },
    });
  }
  const bundle = bundleRows[0];
  if (Number(bundle.catalog_revision) !== Number(catalogState.current_revision)) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'catalog_revision_mismatch',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
      details: {
        active_bundle_revision: Number(bundle.catalog_revision),
        current_catalog_revision: Number(catalogState.current_revision),
      },
    });
  }
  const effectiveFrom = new Date(bundle.effective_from);
  const effectiveUntil = bundle.effective_until ? new Date(bundle.effective_until) : null;
  if (
    Number.isNaN(effectiveFrom.getTime())
    || context.evaluatedAt < effectiveFrom
    || (effectiveUntil && context.evaluatedAt >= effectiveUntil)
  ) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'policy_not_effective',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
    });
  }

  const { loincCodes, testCodes } = criticalThresholdLookupKeys(result);
  const entries = await client.$queryRawUnsafe(
    `SELECT catalog.id, catalog.test_code, catalog.loinc_code,
            catalog.test_name, catalog.specimen_type, catalog.evaluation_mode,
            catalog.unit, catalog.normalized_unit, catalog.sex,
            catalog.age_min_days, catalog.age_max_days,
            catalog.pregnancy_scope, catalog.criticality_required,
            catalog.exemption_reason,
            rule.id AS rule_id, rule.reference_low, rule.reference_high,
            rule.critical_low, rule.critical_high
       FROM lab_threshold_catalog_entries AS catalog
       LEFT JOIN lab_threshold_policy_rules AS rule
         ON rule.tenant_id = catalog.tenant_id
        AND rule.facility_id = catalog.facility_id
        AND rule.bundle_id = $3::uuid
        AND rule.catalog_entry_id = catalog.id
      WHERE catalog.tenant_id = $1::uuid
        AND catalog.facility_id = $2::int
        AND catalog.introduced_revision <= $4::int
        AND (
          catalog.retired_revision IS NULL
          OR catalog.retired_revision > $4::int
        )
        AND (
          (catalog.loinc_code IS NOT NULL AND catalog.loinc_code = ANY($5::text[]))
          OR upper(catalog.test_code) = ANY($6::text[])
        )`,
    tenantId,
    context.facilityId,
    bundle.id,
    Number(bundle.catalog_revision),
    loincCodes,
    testCodes,
  );
  if (entries.length === 0) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'no_matching_rule',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
    });
  }

  const expectedMode = evaluatedValue == null ? 'qualitative_exempt' : 'numeric_threshold';
  let candidates = entries.filter((entry) => entry.evaluation_mode === expectedMode);
  if (candidates.length === 0) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: evaluatedValue == null ? 'non_numeric_value' : 'no_matching_rule',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
      catalogEntry: entries.length === 1 ? entries[0] : null,
    });
  }
  const bestRank = Math.min(...candidates.map((entry) => identityRank(entry, result)));
  candidates = candidates.filter((entry) => identityRank(entry, result) === bestRank);

  if (context.specimenConflict) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'specimen_mismatch',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      bundle,
      details: { specimen_sources: context.specimenSources },
    });
  }
  const specimenMatches = candidates.filter((entry) => {
    const configured = normalizeSpecimen(entry.specimen_type);
    return configured === 'any'
      || (context.specimenType != null && configured === context.specimenType);
  });
  if (specimenMatches.length === 0) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'specimen_mismatch',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
      catalogEntry: candidates.length === 1 ? candidates[0] : null,
      details: {
        configured_specimens: [...new Set(candidates.map((entry) => entry.specimen_type))],
      },
    });
  }
  const demographicCandidates = specimenMatches.filter(
    (entry) => demographicMatches(entry, context),
  );
  if (demographicCandidates.length === 0) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'demographic_mismatch',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
      catalogEntry: specimenMatches.length === 1 ? specimenMatches[0] : null,
      details: {
        sex: context.sex,
        age_days: context.ageDays,
        is_pregnant: context.isPregnant,
      },
    });
  }

  let matches = demographicCandidates.map((entry) => ({ entry, converted: null }));
  if (expectedMode === 'numeric_threshold') {
    matches = matches.map(({ entry }) => ({
      entry,
      converted: valueForCriticalThreshold(
        evaluatedValue,
        result.unit,
        entry.normalized_unit,
      ),
    })).filter(({ converted }) => converted.compatible);
    if (matches.length === 0) {
      return unmatchedAssessment({
        tenantId,
        result,
        reason: 'unit_mismatch',
        evaluatedAt: context.evaluatedAt,
        evaluatedValue,
        facilityId: context.facilityId,
        specimenType: context.specimenType,
        bundle,
        catalogEntry: demographicCandidates.length === 1 ? demographicCandidates[0] : null,
        details: {
          result_unit: result.unit || null,
          configured_units: [
            ...new Set(demographicCandidates.map((entry) => entry.normalized_unit)),
          ],
        },
      });
    }
  }
  if (matches.length !== 1) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'ambiguous_policy',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
      details: { catalog_entry_ids: matches.map(({ entry }) => entry.id) },
    });
  }

  const { entry, converted } = matches[0];
  if (entry.evaluation_mode === 'qualitative_exempt') {
    recordLookup('matched', { tenantId, result });
    return {
      matched: true,
      breached: false,
      breachedSide: null,
      breachedValue: null,
      evaluatedValue: null,
      referenceLow: null,
      referenceHigh: null,
      criticalLow: null,
      criticalHigh: null,
      thresholdId: null,
      policyBundleId: bundle.id,
      policyRuleId: null,
      catalogEntryId: entry.id,
      catalogRevision: Number(bundle.catalog_revision),
      thresholdTestCode: entry.test_code,
      thresholdLoincCode: entry.loinc_code || null,
      thresholdUnit: null,
      thresholdAppliesTo: 'exempt',
      conversion: null,
      evaluationMode: entry.evaluation_mode,
      exemptionReason: entry.exemption_reason,
      criticalityStatus: 'not_applicable',
      unmatchedReason: null,
      evaluatedAt: context.evaluatedAt,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      details: {},
    };
  }
  if (!entry.rule_id) {
    return unmatchedAssessment({
      tenantId,
      result,
      reason: 'no_matching_rule',
      evaluatedAt: context.evaluatedAt,
      evaluatedValue,
      facilityId: context.facilityId,
      specimenType: context.specimenType,
      bundle,
      catalogEntry: entry,
    });
  }

  const criticalLow = entry.critical_low == null ? null : Number(entry.critical_low);
  const criticalHigh = entry.critical_high == null ? null : Number(entry.critical_high);
  let breachedSide = null;
  let breachedValue = null;
  if (criticalLow != null && converted.value < criticalLow) {
    breachedSide = 'low';
    breachedValue = criticalLow;
  } else if (criticalHigh != null && converted.value > criticalHigh) {
    breachedSide = 'high';
    breachedValue = criticalHigh;
  }
  recordLookup('matched', { tenantId, result });
  return {
    matched: true,
    breached: breachedSide != null,
    breachedSide,
    breachedValue,
    evaluatedValue: converted.value,
    referenceLow: entry.reference_low == null ? null : Number(entry.reference_low),
    referenceHigh: entry.reference_high == null ? null : Number(entry.reference_high),
    criticalLow,
    criticalHigh,
    thresholdId: null,
    policyBundleId: bundle.id,
    policyRuleId: entry.rule_id,
    catalogEntryId: entry.id,
    catalogRevision: Number(bundle.catalog_revision),
    thresholdTestCode: entry.test_code,
    thresholdLoincCode: entry.loinc_code || null,
    thresholdUnit: entry.normalized_unit,
    thresholdAppliesTo: populationScope(entry),
    conversion: converted.conversion,
    evaluationMode: entry.evaluation_mode,
    exemptionReason: null,
    criticalityStatus: breachedSide == null ? 'within_policy' : 'critical',
    unmatchedReason: null,
    evaluatedAt: context.evaluatedAt,
    facilityId: context.facilityId,
    specimenType: context.specimenType,
    details: {},
  };
}

export const __testing__ = {
  ageDaysAt,
  demographicMatches,
  identityRank,
  normalizeSex,
  normalizeSpecimen,
  populationScope,
  resultContext,
};

export default {
  criticalThresholdLookupKeys,
  evaluateCriticalThreshold,
};
