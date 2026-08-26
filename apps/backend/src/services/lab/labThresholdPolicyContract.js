import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';

export const LAB_THRESHOLD_PREGNANCY_SCOPES = Object.freeze([
  'all',
  'pregnant',
  'not_pregnant',
]);

export const LAB_THRESHOLD_SEX_SCOPES = Object.freeze(['M', 'F', 'X', 'U']);

export const LAB_THRESHOLD_EVALUATION_MODES = Object.freeze([
  'numeric_threshold',
  'qualitative_exempt',
]);

const MAX_AGE_DAYS = 150 * 366;

export function labThresholdAssessmentEvidence(criticality = {}) {
  return {
    matched: criticality.matched === true,
    breached: criticality.breached === true,
    threshold_id: criticality.thresholdId ?? null,
    policy_bundle_id: criticality.policyBundleId ?? null,
    policy_rule_id: criticality.policyRuleId ?? null,
    catalog_entry_id: criticality.catalogEntryId ?? null,
    catalog_revision: criticality.catalogRevision ?? null,
    facility_id: criticality.facilityId ?? null,
    threshold_test_code: criticality.thresholdTestCode ?? null,
    threshold_loinc_code: criticality.thresholdLoincCode ?? null,
    threshold_unit: criticality.thresholdUnit ?? null,
    threshold_applies_to: criticality.thresholdAppliesTo ?? null,
    reference_low: criticality.referenceLow ?? null,
    reference_high: criticality.referenceHigh ?? null,
    critical_low: criticality.criticalLow ?? null,
    critical_high: criticality.criticalHigh ?? null,
    breached_side: criticality.breachedSide ?? null,
    breached_value: criticality.breachedValue ?? null,
    evaluated_value: criticality.evaluatedValue ?? null,
    conversion: criticality.conversion ?? null,
    evaluation_mode: criticality.evaluationMode ?? null,
    criticality_status: criticality.criticalityStatus ?? null,
    unmatched_reason: criticality.unmatchedReason ?? null,
    specimen_type: criticality.specimenType ?? null,
    exemption_reason: criticality.exemptionReason ?? null,
  };
}

function requiredText(value, label, max) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw AppError.badRequest(`${label} is required`);
  if (normalized.length > max) {
    throw AppError.badRequest(`${label} must be at most ${max} characters`);
  }
  return normalized;
}

function optionalText(value, label, max) {
  if (value == null || value === '') return null;
  return requiredText(value, label, max);
}

function optionalInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw AppError.badRequest(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function optionalNumber(value, label) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be numeric`);
  return parsed;
}

function boolean(value, label, fallback) {
  if (value == null || value === '') return fallback;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  throw AppError.badRequest(`${label} must be boolean`);
}

export function normalizeLabPolicyUnit(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[μµ]/g, 'u')
    .replace(/\s+/g, '')
    .replace(/×/g, 'x');
}

export function normalizeLabSpecimenType(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

export function normalizeCatalogEntryInput(input = {}) {
  const testCode = requiredText(input.test_code ?? input.testCode, 'test_code', 50).toUpperCase();
  const loincCode = optionalText(input.loinc_code ?? input.loincCode, 'loinc_code', 20);
  const testName = requiredText(input.test_name ?? input.testName, 'test_name', 255);
  const specimenType = normalizeLabSpecimenType(input.specimen_type ?? input.specimenType);
  if (!specimenType || specimenType.length > 80) {
    throw AppError.badRequest('specimen_type is required and must be at most 80 characters');
  }
  const evaluationMode = String(
    input.evaluation_mode ?? input.evaluationMode ?? 'numeric_threshold',
  ).trim().toLowerCase();
  if (!LAB_THRESHOLD_EVALUATION_MODES.includes(evaluationMode)) {
    throw AppError.badRequest(
      `evaluation_mode must be one of: ${LAB_THRESHOLD_EVALUATION_MODES.join(', ')}`,
    );
  }
  const rawUnit = optionalText(input.unit, 'unit', 40);
  const exemptionReason = optionalText(
    input.exemption_reason ?? input.exemptionReason,
    'exemption_reason',
    1000,
  );
  let unit = rawUnit;
  let normalizedUnit = rawUnit == null ? null : normalizeLabPolicyUnit(rawUnit);
  let criticalityRequired = boolean(
    input.criticality_required ?? input.criticalityRequired,
    'criticality_required',
    evaluationMode === 'numeric_threshold',
  );
  if (evaluationMode === 'numeric_threshold') {
    if (!normalizedUnit) throw AppError.badRequest('unit is required for numeric_threshold');
    if (exemptionReason != null) {
      throw AppError.badRequest('exemption_reason is only valid for qualitative_exempt');
    }
  } else {
    if (rawUnit != null) {
      throw AppError.badRequest('unit must be omitted for qualitative_exempt');
    }
    if (!exemptionReason) {
      throw AppError.badRequest('exemption_reason is required for qualitative_exempt');
    }
    if (criticalityRequired) {
      throw AppError.badRequest('qualitative_exempt cannot require a numeric critical threshold');
    }
    unit = null;
    normalizedUnit = null;
    criticalityRequired = false;
  }

  const rawSex = optionalText(input.sex, 'sex', 10);
  const sex = rawSex == null ? null : rawSex.toUpperCase();
  if (sex != null && !LAB_THRESHOLD_SEX_SCOPES.includes(sex)) {
    throw AppError.badRequest(`sex must be one of: ${LAB_THRESHOLD_SEX_SCOPES.join(', ')}`);
  }
  const ageMinDays = optionalInteger(input.age_min_days ?? input.ageMinDays, 'age_min_days', {
    min: 0,
    max: MAX_AGE_DAYS,
  });
  const ageMaxDays = optionalInteger(input.age_max_days ?? input.ageMaxDays, 'age_max_days', {
    min: 1,
    max: MAX_AGE_DAYS,
  });
  if (ageMinDays != null && ageMaxDays != null && ageMaxDays <= ageMinDays) {
    throw AppError.badRequest('age_max_days must be greater than age_min_days');
  }
  const pregnancyScope = String(
    input.pregnancy_scope ?? input.pregnancyScope ?? 'all',
  ).trim().toLowerCase();
  if (!LAB_THRESHOLD_PREGNANCY_SCOPES.includes(pregnancyScope)) {
    throw AppError.badRequest(
      `pregnancy_scope must be one of: ${LAB_THRESHOLD_PREGNANCY_SCOPES.join(', ')}`,
    );
  }
  if (pregnancyScope === 'pregnant' && sex != null && sex !== 'F') {
    throw AppError.badRequest('pregnant scope requires sex F or an all-sex scope');
  }

  return Object.freeze({
    testCode,
    loincCode,
    testName,
    specimenType,
    evaluationMode,
    unit,
    normalizedUnit,
    sex,
    ageMinDays,
    ageMaxDays,
    pregnancyScope,
    criticalityRequired,
    exemptionReason,
  });
}

function scopesOverlap(left, right) {
  const sameIdentity = (
    (left.loinc_code && right.loinc_code && left.loinc_code === right.loinc_code)
    || String(left.test_code).toUpperCase() === String(right.test_code).toUpperCase()
  );
  if (!sameIdentity) return false;
  if (
    left.evaluation_mode
    && right.evaluation_mode
    && left.evaluation_mode !== right.evaluation_mode
  ) return false;
  if (String(left.normalized_unit) !== String(right.normalized_unit)) return false;

  const leftSpecimen = normalizeLabSpecimenType(left.specimen_type);
  const rightSpecimen = normalizeLabSpecimenType(right.specimen_type);
  if (
    leftSpecimen !== rightSpecimen
    && leftSpecimen !== 'any'
    && rightSpecimen !== 'any'
  ) return false;

  if (left.sex && right.sex && left.sex !== right.sex) return false;
  if (
    left.pregnancy_scope !== 'all'
    && right.pregnancy_scope !== 'all'
    && left.pregnancy_scope !== right.pregnancy_scope
  ) return false;

  const leftMin = left.age_min_days ?? 0;
  const leftMax = left.age_max_days ?? Number.POSITIVE_INFINITY;
  const rightMin = right.age_min_days ?? 0;
  const rightMax = right.age_max_days ?? Number.POSITIVE_INFINITY;
  return leftMin < rightMax && rightMin < leftMax;
}

export function assertNoOverlappingCatalogScopes(entries = []) {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (!scopesOverlap(left, right)) continue;
      throw AppError.badRequest(
        'Lab threshold catalogue contains overlapping analyte scopes',
        'LAB_THRESHOLD_CATALOG_SCOPE_OVERLAP',
        {
          catalog_entry_ids: [left.id ?? null, right.id ?? null],
          test_codes: [left.test_code, right.test_code],
        },
      );
    }
  }
}

export function normalizePolicyRuleInput(input = {}, catalogEntry) {
  if (!catalogEntry) throw AppError.badRequest('catalog_entry_id is not part of the bundle catalogue');
  if (catalogEntry.evaluation_mode !== 'numeric_threshold') {
    throw AppError.badRequest(
      'qualitative_exempt catalogue entries cannot have numeric policy rules',
      'LAB_THRESHOLD_EXEMPT_ENTRY_RULE_FORBIDDEN',
    );
  }
  const referenceLow = optionalNumber(input.reference_low ?? input.referenceLow, 'reference_low');
  const referenceHigh = optionalNumber(input.reference_high ?? input.referenceHigh, 'reference_high');
  const criticalLow = optionalNumber(input.critical_low ?? input.criticalLow, 'critical_low');
  const criticalHigh = optionalNumber(input.critical_high ?? input.criticalHigh, 'critical_high');

  if (referenceLow == null && referenceHigh == null) {
    throw AppError.badRequest('Each numeric catalogue entry requires a reference bound');
  }
  if (referenceLow != null && referenceHigh != null && referenceHigh <= referenceLow) {
    throw AppError.badRequest('reference_high must be greater than reference_low');
  }
  if (criticalLow != null && criticalHigh != null && criticalHigh <= criticalLow) {
    throw AppError.badRequest('critical_high must be greater than critical_low');
  }
  if (criticalLow != null && referenceLow != null && criticalLow > referenceLow) {
    throw AppError.badRequest('critical_low must be at or below reference_low');
  }
  if (criticalHigh != null && referenceHigh != null && criticalHigh < referenceHigh) {
    throw AppError.badRequest('critical_high must be at or above reference_high');
  }
  if (catalogEntry.criticality_required && criticalLow == null && criticalHigh == null) {
    throw AppError.badRequest(
      'This catalogue entry requires at least one clinically approved critical bound',
      'LAB_THRESHOLD_CRITICAL_BOUND_REQUIRED',
    );
  }

  return Object.freeze({
    catalogEntryId: String(input.catalog_entry_id ?? input.catalogEntryId),
    referenceLow,
    referenceHigh,
    criticalLow,
    criticalHigh,
    notes: optionalText(input.notes, 'notes', 2000),
  });
}

function canonicalNumber(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw AppError.badRequest('Policy content contains a non-numeric bound');
  return numeric;
}

export function policyContentSha256({ bundle, entries, rules }) {
  const entryById = new Map(entries.map((entry) => [String(entry.id), entry]));
  const canonicalEntries = entries.map((entry) => ({
    catalog_entry_id: String(entry.id),
    test_code: String(entry.test_code),
    loinc_code: entry.loinc_code ?? null,
    test_name: String(entry.test_name),
    specimen_type: String(entry.specimen_type),
    evaluation_mode: String(entry.evaluation_mode),
    unit: entry.unit ?? null,
    normalized_unit: entry.normalized_unit ?? null,
    sex: entry.sex ?? null,
    age_min_days: entry.age_min_days == null ? null : Number(entry.age_min_days),
    age_max_days: entry.age_max_days == null ? null : Number(entry.age_max_days),
    pregnancy_scope: String(entry.pregnancy_scope),
    criticality_required: entry.criticality_required === true,
    exemption_reason: entry.exemption_reason ?? null,
  })).sort((left, right) => left.catalog_entry_id.localeCompare(right.catalog_entry_id));
  const canonicalRules = rules.map((rule) => {
    const entry = entryById.get(String(rule.catalog_entry_id));
    if (!entry) throw AppError.conflict('Policy rule references a stale catalogue entry');
    return {
      catalog_entry_id: String(entry.id),
      reference_low: canonicalNumber(rule.reference_low),
      reference_high: canonicalNumber(rule.reference_high),
      critical_low: canonicalNumber(rule.critical_low),
      critical_high: canonicalNumber(rule.critical_high),
      notes: rule.notes ?? null,
    };
  }).sort((left, right) => left.catalog_entry_id.localeCompare(right.catalog_entry_id));

  const canonical = JSON.stringify({
    tenant_id: String(bundle.tenant_id),
    facility_id: Number(bundle.facility_id),
    bundle_version: Number(bundle.bundle_version),
    catalog_revision: Number(bundle.catalog_revision),
    catalog_entries: canonicalEntries,
    rules: canonicalRules,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export const __labThresholdPolicyContractForTests = Object.freeze({
  scopesOverlap,
});
