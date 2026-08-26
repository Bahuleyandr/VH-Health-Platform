import {
  assertNoOverlappingCatalogScopes,
  labThresholdAssessmentEvidence,
  normalizeCatalogEntryInput,
  normalizeLabPolicyUnit,
  normalizePolicyRuleInput,
  policyContentSha256,
} from '../../services/lab/labThresholdPolicyContract.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_A = '00000000-0000-4000-8000-000000000101';
const ENTRY_B = '00000000-0000-4000-8000-000000000102';

function catalogEntry(overrides = {}) {
  return {
    id: ENTRY_A,
    test_code: 'K',
    loinc_code: '2823-3',
    test_name: 'Potassium',
    specimen_type: 'serum',
    evaluation_mode: 'numeric_threshold',
    unit: 'mmol/L',
    normalized_unit: 'mmol/l',
    sex: null,
    age_min_days: null,
    age_max_days: null,
    pregnancy_scope: 'all',
    criticality_required: true,
    exemption_reason: null,
    ...overrides,
  };
}

function policyRule(overrides = {}) {
  return {
    catalog_entry_id: ENTRY_A,
    reference_low: 3.5,
    reference_high: 5.1,
    critical_low: 2.5,
    critical_high: 6.5,
    notes: null,
    ...overrides,
  };
}

describe('labThresholdPolicyContract', () => {
  test('serializes one stable snake-case policy evidence contract for every ingest rail', () => {
    expect(labThresholdAssessmentEvidence({
      matched: true,
      breached: true,
      policyBundleId: 'bundle-1',
      policyRuleId: 'rule-1',
      catalogEntryId: 'entry-1',
      facilityId: 7,
      criticalityStatus: 'critical',
      breachedSide: 'high',
      breachedValue: 6.5,
    })).toMatchObject({
      matched: true,
      breached: true,
      policy_bundle_id: 'bundle-1',
      policy_rule_id: 'rule-1',
      catalog_entry_id: 'entry-1',
      facility_id: 7,
      criticality_status: 'critical',
      breached_side: 'high',
      breached_value: 6.5,
    });
  });

  test('normalizes units, specimen, demographic scope, and analyte identity', () => {
    expect(normalizeLabPolicyUnit(' µmol / L ')).toBe('umol/l');
    expect(normalizeCatalogEntryInput({
      test_code: ' k ',
      loinc_code: '2823-3',
      test_name: 'Potassium',
      specimen_type: 'Venous Plasma',
      unit: 'mmol / L',
      sex: 'f',
      age_min_days: 18 * 366,
      pregnancy_scope: 'not_pregnant',
      criticality_required: false,
    })).toMatchObject({
      testCode: 'K',
      specimenType: 'venous_plasma',
      normalizedUnit: 'mmol/l',
      sex: 'F',
      pregnancyScope: 'not_pregnant',
      criticalityRequired: false,
    });
  });

  test('rejects overlapping analyte scopes before a policy can be authored', () => {
    expect(() => assertNoOverlappingCatalogScopes([
      catalogEntry({ age_min_days: 0, age_max_days: 365 }),
      catalogEntry({ id: ENTRY_B, age_min_days: 180, age_max_days: 730 }),
    ])).toThrow(expect.objectContaining({
      code: 'LAB_THRESHOLD_CATALOG_SCOPE_OVERLAP',
    }));
  });

  test('accepts adjacent age scopes and mutually exclusive pregnancy scopes', () => {
    expect(() => assertNoOverlappingCatalogScopes([
      catalogEntry({ age_min_days: 0, age_max_days: 365 }),
      catalogEntry({ id: ENTRY_B, age_min_days: 365, age_max_days: 730 }),
    ])).not.toThrow();

    expect(() => assertNoOverlappingCatalogScopes([
      catalogEntry({ sex: 'F', pregnancy_scope: 'pregnant' }),
      catalogEntry({ id: ENTRY_B, sex: 'F', pregnancy_scope: 'not_pregnant' }),
    ])).not.toThrow();
  });

  test('requires a critical bound when the catalogue says criticality is required', () => {
    expect(() => normalizePolicyRuleInput({
      catalog_entry_id: ENTRY_A,
      reference_low: 3.5,
      reference_high: 5.1,
    }, catalogEntry())).toThrow(expect.objectContaining({
      code: 'LAB_THRESHOLD_CRITICAL_BOUND_REQUIRED',
    }));
  });

  test('requires and signs an explicit clinical exemption for qualitative analytes', () => {
    const exempt = normalizeCatalogEntryInput({
      test_code: 'CULTURE',
      test_name: 'Culture',
      specimen_type: 'blood',
      evaluation_mode: 'qualitative_exempt',
      exemption_reason: 'Qualitative organism identification has no numeric critical interval.',
    });
    expect(exempt).toMatchObject({
      evaluationMode: 'qualitative_exempt',
      unit: null,
      normalizedUnit: null,
      criticalityRequired: false,
    });
    expect(() => normalizePolicyRuleInput(
      policyRule(),
      catalogEntry({
        evaluation_mode: 'qualitative_exempt',
        unit: null,
        normalized_unit: null,
        criticality_required: false,
        exemption_reason: 'Clinically exempt qualitative result.',
      }),
    )).toThrow(expect.objectContaining({
      code: 'LAB_THRESHOLD_EXEMPT_ENTRY_RULE_FORBIDDEN',
    }));
  });

  test('rejects critical bounds that sit inside the signed reference interval', () => {
    expect(() => normalizePolicyRuleInput({
      catalog_entry_id: ENTRY_A,
      reference_low: 3.5,
      reference_high: 5.1,
      critical_low: 4,
    }, catalogEntry())).toThrow(/critical_low must be at or below reference_low/);

    expect(() => normalizePolicyRuleInput({
      catalog_entry_id: ENTRY_A,
      reference_low: 3.5,
      reference_high: 5.1,
      critical_high: 5,
    }, catalogEntry())).toThrow(/critical_high must be at or above reference_high/);
  });

  test('hashes policy content deterministically and detects a clinical-value change', () => {
    const bundle = {
      tenant_id: TENANT_ID,
      facility_id: 1,
      bundle_version: 1,
      catalog_revision: 2,
    };
    const entries = [
      catalogEntry(),
      catalogEntry({
        id: ENTRY_B,
        test_code: 'NA',
        loinc_code: '2951-2',
      }),
    ];
    const rules = [
      policyRule({
        catalog_entry_id: ENTRY_B,
        reference_low: 135,
        reference_high: 145,
        critical_low: 120,
        critical_high: 160,
      }),
      policyRule(),
    ];

    const digest = policyContentSha256({ bundle, entries, rules });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(policyContentSha256({ bundle, entries: [...entries].reverse(), rules: [...rules].reverse() }))
      .toBe(digest);
    expect(policyContentSha256({
      bundle,
      entries,
      rules: [rules[0], policyRule({ critical_high: 7 })],
    })).not.toBe(digest);
  });

  test('includes qualitative exemption evidence in the signed policy digest', () => {
    const bundle = {
      tenant_id: TENANT_ID,
      facility_id: 1,
      bundle_version: 1,
      catalog_revision: 1,
    };
    const exempt = catalogEntry({
      evaluation_mode: 'qualitative_exempt',
      unit: null,
      normalized_unit: null,
      criticality_required: false,
      exemption_reason: 'Clinically approved qualitative exemption.',
    });
    const digest = policyContentSha256({ bundle, entries: [exempt], rules: [] });
    expect(policyContentSha256({
      bundle,
      entries: [{ ...exempt, exemption_reason: 'Different clinical rationale.' }],
      rules: [],
    })).not.toBe(digest);
  });
});
