import {
  DEVICE_ACTIONS,
  DEVICE_STATUSES,
  deriveIsolationProfile,
  deviceTransition,
  evaluateDeviceEligibility,
  evaluateReleaseCriteria,
  validateIsolationSettingRevision,
  validateProtocolDeviceScope,
} from '../../services/clinical/reprocessableDeviceRules.js';

const protocol = {
  domain: 'dialysis', category: 'dialyser', status: 'active', basis: 'manufacturer_ifu',
  reference: 'IFU-1', tcv_min_pct: 80, baseline_tcv_required: true,
  residual_test_required: true, integrity_test_required: true,
  agents: [{
    agent: 'peracetic_acid', min_concentration_pct: 0.2,
    max_concentration_pct: 0.4, min_contact_minutes: 11,
  }],
  reuse_matrix: {
    hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse',
  },
  surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
};

describe('reprocessable device pure rules', () => {
  test('cohortProfilePreservesHistoricalReactiveAcrossDatesAndInputOrder', () => {
    const markers = ['hbsag', 'hcv', 'hiv'];
    const orders = ['reactive_first', 'reactive_last'];
    expect(markers).toHaveLength(3);
    expect(orders).toHaveLength(2);
    const cases = markers.flatMap((marker) => orders.map((order) => ({ marker, order })));
    expect(cases).toHaveLength(6);
    const profiles = cases.map(({ marker, order }) => {
      const reactive = { marker, result: 'reactive', tested_on: '2026-09-01' };
      const nonReactive = { marker, result: 'non_reactive', tested_on: '2026-09-07' };
      return deriveIsolationProfile({
        markers: order === 'reactive_first' ? [reactive, nonReactive] : [nonReactive, reactive],
      })[marker];
    });
    expect(profiles).toEqual(cases.map(() => 'reactive'));
  });

  test('cohortProfileUsesConservativeSameDayPrecedenceInEveryInputOrder', () => {
    const markers = ['hbsag', 'hcv', 'hiv'];
    const results = ['reactive', 'indeterminate', 'pending', 'non_reactive'];
    expect(markers).toHaveLength(3);
    expect(results).toHaveLength(4);
    const pairs = results.flatMap((stronger, index) => results.slice(index + 1)
      .map((weaker) => ({ stronger, weaker })));
    expect(pairs).toHaveLength(6);
    const orders = ['stronger_first', 'stronger_last'];
    expect(orders).toHaveLength(2);
    const cases = markers.flatMap((marker) => pairs.flatMap((pair) => orders
      .map((order) => ({ marker, ...pair, order }))));
    expect(cases).toHaveLength(36);
    const profiles = cases.map(({ marker, stronger, weaker, order }) => {
      const evidence = [stronger, weaker].map((result) => ({
        marker, result, tested_on: '2026-09-07',
      }));
      return deriveIsolationProfile({
        markers: order === 'stronger_first' ? evidence : evidence.reverse(),
      })[marker];
    });
    expect(profiles).toEqual(cases.map(({ stronger }) => stronger));
  });

  test('pins every state transition and keeps quarantine out of in_case', () => {
    const cases = [
      ['available', 'reserve', 'in_case'],
      ['in_case', 'return', 'awaiting_reprocessing'],
      ['awaiting_reprocessing', 'receive', 'in_cssd'],
      ['quarantined', 'release_hold', 'awaiting_reprocessing'],
      ['in_case', 'restore_unused', 'available'],
    ];
    expect(cases).toHaveLength(5);
    for (const [from, action, to] of cases) {
      expect(deviceTransition(from, action)).toMatchObject({ ok: true, to });
    }
    expect(DEVICE_ACTIONS.quarantine.from).not.toContain('in_case');
    expect(DEVICE_STATUSES).toHaveLength(6);
  });

  test('separates use and reprocess ceiling semantics with an explicit null guard', () => {
    const atCeiling = { status: 'awaiting_reprocessing', cycle_count: 2, max_cycles_snapshot: 2 };
    expect(evaluateDeviceEligibility({ action: 'use', device: atCeiling }))
      .toEqual({ verdict: 'ineligible', reason_codes: ['RPD_DEVICE_NOT_READY'] });
    expect(evaluateDeviceEligibility({ action: 'reprocess', device: atCeiling }))
      .toEqual({ verdict: 'ineligible', reason_codes: ['RPD_MAX_CYCLES_REACHED'] });
    expect(evaluateDeviceEligibility({
      action: 'reprocess', device: { ...atCeiling, max_cycles_snapshot: null },
    })).toEqual({ verdict: 'eligible', reason_codes: [] });
    expect(() => evaluateDeviceEligibility({ device: atCeiling }))
      .toThrow(expect.objectContaining({ code: 'RPD_ELIGIBILITY_ACTION_REQUIRED' }));

    const lifecycles = [
      { max: 1, lastUseCycle: 1 },
      { max: 2, lastUseCycle: 2 },
      { max: null, lastUseCycle: 1000 },
    ];
    expect(lifecycles).toHaveLength(3);
    for (const lifecycle of lifecycles) {
      expect(evaluateDeviceEligibility({
        action: 'use',
        device: { status: 'available', cycle_count: lifecycle.lastUseCycle, max_cycles_snapshot: lifecycle.max },
      })).toEqual({ verdict: 'eligible', reason_codes: [] });
      expect(evaluateDeviceEligibility({
        action: 'reprocess',
        device: {
          status: 'awaiting_reprocessing',
          cycle_count: lifecycle.lastUseCycle,
          max_cycles_snapshot: lifecycle.max,
        },
      }).verdict).toBe(lifecycle.max == null ? 'eligible' : 'ineligible');
    }
  });

  test('treats missing release evidence as not established and applies the 80 percent floor', () => {
    const scope = {
      category: 'dialyser', manufacturer: 'M', model_name: 'X',
      ifu_reference: 'IFU-1', single_use: false, nominal_tcv_ml: 100,
    };
    const complete = {
      baseline_tcv_ml: 100,
      baseline_tcv_source: 'pre_use',
      measured_tcv_ml: 80,
      integrity_test_result: 'pass',
      residual_test_result: 'negative',
      reprocessing_agent: 'peracetic_acid',
      disinfectant_concentration_pct: 0.3,
      disinfectant_contact_minutes: 11,
    };
    expect(evaluateReleaseCriteria({ protocol, scope, evidence: complete }))
      .toEqual({ verdict: 'released', missing_evidence: [] });
    expect(evaluateReleaseCriteria({
      protocol, scope, evidence: { ...complete, measured_tcv_ml: 79.9 },
    })).toEqual({ verdict: 'not_established', missing_evidence: ['tcv_threshold'] });
    expect(evaluateReleaseCriteria({ protocol, scope, evidence: {} }).verdict)
      .toBe('not_established');
  });

  test('requires a non-single-use manufacturer/model/IFU scope', () => {
    const scope = {
      category: 'dialyser', manufacturer: 'M', model_name: 'X',
      ifu_reference: 'IFU-1', single_use: false, nominal_tcv_ml: 100,
    };
    expect(validateProtocolDeviceScope(scope, protocol)).toMatchObject(scope);
    expect(() => validateProtocolDeviceScope({ ...scope, single_use: true }, protocol))
      .toThrow(expect.objectContaining({ code: 'RPD_PROTOCOL_SCOPE_INVALID' }));
  });

  test('releaseCriteriaRejectsMissingProcessMeasurements', () => {
    const scope = { ifu_reference: 'IFU-1', single_use: false };
    const complete = {
      baseline_tcv_ml: 100,
      baseline_tcv_source: 'pre_use',
      measured_tcv_ml: 85,
      integrity_test_result: 'pass',
      residual_test_result: 'negative',
      reprocessing_agent: 'peracetic_acid',
      disinfectant_concentration_pct: 0.3,
      disinfectant_contact_minutes: 11,
    };
    const fields = ['disinfectant_concentration_pct', 'disinfectant_contact_minutes'];
    const invalidValues = [undefined, null, '', ' ', 'not measured', NaN, Infinity, -Infinity, -1, 0];
    expect(fields).toHaveLength(2);
    expect(invalidValues).toHaveLength(10);
    const cases = fields.flatMap((field) => invalidValues.map((value) => ({ field, value })));
    expect(cases).toHaveLength(20);
    expect(evaluateReleaseCriteria({ protocol, scope, evidence: complete }))
      .toEqual({ verdict: 'released', missing_evidence: [] });

    const results = cases.map(({ field, value }) => evaluateReleaseCriteria({
      protocol, scope, evidence: { ...complete, [field]: value },
    }));
    expect(results).toEqual(cases.map(() => ({
      verdict: 'not_established', missing_evidence: ['process_parameters'],
    })));
  });

  test('releaseCriteriaRejectsNonFiniteTcvMeasurements', () => {
    const scope = { ifu_reference: 'IFU-1', single_use: false };
    const complete = {
      baseline_tcv_ml: 100,
      baseline_tcv_source: 'pre_use',
      measured_tcv_ml: 85,
      integrity_test_result: 'pass',
      residual_test_result: 'negative',
      reprocessing_agent: 'peracetic_acid',
      disinfectant_concentration_pct: 0.3,
      disinfectant_contact_minutes: 11,
    };
    const cases = [
      { measured_tcv_ml: Infinity },
      { measured_tcv_ml: 'Infinity' },
      { baseline_tcv_ml: Infinity, measured_tcv_ml: Infinity },
      { baseline_tcv_ml: 'Infinity', measured_tcv_ml: 'Infinity' },
    ];
    expect(cases).toHaveLength(4);
    expect(evaluateReleaseCriteria({ protocol, scope, evidence: complete }))
      .toEqual({ verdict: 'released', missing_evidence: [] });
    const results = cases.map((overrides) => evaluateReleaseCriteria({
      protocol, scope, evidence: { ...complete, ...overrides },
    }));
    expect(results).toEqual(cases.map(() => ({
      verdict: 'not_established', missing_evidence: ['tcv_threshold'],
    })));
  });

  test('requires both immutable infection-control approvals and rejects clinical group tokens', () => {
    const revision = {
      revision: 1,
      approved_isolation_groups: ['Bay 1', 'Bay 2'],
      isolation_groups: {
        hbsag: 'Bay 1', hcv: 'Bay 2', hiv: 'Bay 2', isolation_mixed: 'Bay 2',
      },
      vocabulary_approved_by: '00000000-0000-4000-8000-000000000001',
      vocabulary_approved_role: 'INFECTION_CONTROL_OFFICER',
      vocabulary_approved_at: '2026-09-07T10:00:00.000Z',
      mapping_approved_by: '00000000-0000-4000-8000-000000000002',
      mapping_approved_role: 'INFECTION_CONTROL_OFFICER',
      mapping_approved_at: '2026-09-07T10:01:00.000Z',
    };
    expect(validateIsolationSettingRevision(revision).approved_isolation_groups).toHaveLength(2);
    expect(() => validateIsolationSettingRevision({
      ...revision, mapping_approved_role: 'ADMIN',
    })).toThrow(expect.objectContaining({ code: 'RPD_ISOLATION_APPROVAL_REQUIRED' }));
    expect(() => validateIsolationSettingRevision({
      ...revision,
      approved_isolation_groups: ['HCV Bay'],
      isolation_groups: {
        hbsag: 'HCV Bay', hcv: 'HCV Bay', hiv: 'HCV Bay', isolation_mixed: 'HCV Bay',
      },
    })).toThrow(expect.objectContaining({ code: 'RPD_ISOLATION_GROUP_DISCLOSURE' }));
  });
});
