import { jest } from '@jest/globals';

const resolveDialysisIsolationForPatient = jest.fn();
jest.unstable_mockModule('../../services/clinical/dialysisIsolationAdapter.js', () => ({
  resolveDialysisIsolationForPatient,
  resolveDialysisIsolation: jest.fn(),
}));

const { reuseEligibilityTx } = await import('../../services/clinical/dialysisReuseService.js');
const TENANT = '00000000-0000-4000-8000-000000000201';
const PATIENT = '00000000-0000-4000-8000-000000000202';
const REPORTER = '00000000-0000-4000-8000-000000000203';
const REFUSAL = { verdict: 'not_established', reason_codes: ['RPD_REUSE_EVIDENCE_REQUIRED'] };
const decision = {
  contract_version: 2, status: 'restricted', isolation_class: 'hcv',
  asOf: '2026-09-08T10:00:00.000Z', evidence: 'marker', evidence_dated_on: '2026-09-08',
  reasons: ['DIALYSIS_HCV_POSITIVE'],
  markers: [{
    marker: 'hcv', result: 'reactive', tested_on: '2026-09-08',
    marker_row_id: 1, source: 'lab_result',
  }],
};
const protocol = {
  domain: 'dialysis', category: 'dialyser', status: 'active',
  reuse_matrix: { hbsag: 'no_reuse', hcv: 'dedicated_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse' },
  surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
};
const persisted = {
  id: 1, hcv_pcr: 'not_detected', test_date: '2026-09-08', reported_by: REPORTER,
};
let db;

function request(overrides = {}) {
  return {
    tenantId: TENANT, patientUid: PATIENT, dedicatedPatientUid: PATIENT,
    db, protocol, asOf: decision.asOf,
    device: { domain: 'dialysis', category: 'dialyser', cycle_count: 0, max_cycles_snapshot: 4 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveDialysisIsolationForPatient.mockResolvedValue(decision);
  db = { $queryRawUnsafe: jest.fn().mockResolvedValue([persisted]) };
});

describe('persisted HCV RNA evidence for dedicated dialysis reuse', () => {
  test('reuseEligibilityRnaFailureIsMarkerFreeByValue', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    const result = await reuseEligibilityTx(request());
    expect(Object.keys(result)).toEqual(['verdict', 'reason_codes']);
    expect(JSON.stringify(result)).not.toMatch(/hbsag|\bhbv\b|hcv|hiv|hepatitis|isolation_mixed/i);
    expect(result).toEqual(REFUSAL);
  });

  test('reuseEligibilityFingerprintCallbackReceivesOnlyOpaqueHashAndNeverChangesReturnShape', async () => {
    const captureDecisionFingerprint = jest.fn();
    const result = await reuseEligibilityTx(request({ captureDecisionFingerprint }));
    expect(captureDecisionFingerprint).toHaveBeenCalledTimes(1);
    expect(captureDecisionFingerprint.mock.calls[0]).toHaveLength(1);
    expect(captureDecisionFingerprint.mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({ verdict: 'eligible', reason_codes: [] });
    expect(JSON.stringify(result)).not.toContain(captureDecisionFingerprint.mock.calls[0][0]);
    const nonFunctions = ['client-callback', true, { includeMarkers: true }, 1];
    expect(nonFunctions).toHaveLength(4);
    for (const input of nonFunctions) {
      await expect(reuseEligibilityTx(request({ captureDecisionFingerprint: input })))
        .resolves.toEqual({ verdict: 'eligible', reason_codes: [] });
    }
  });

  test('reuseEligibilityFingerprintBindsPersistedRnaIdentityResultDateAndAttribution', async () => {
    const captureDecisionFingerprint = jest.fn();
    await reuseEligibilityTx(request({ captureDecisionFingerprint }));
    const original = captureDecisionFingerprint.mock.calls.at(-1)[0];
    const cases = [
      { id: 2 }, { hcv_pcr: 'detected' }, { test_date: '2026-09-07' }, { reported_by: PATIENT },
    ];
    expect(cases).toHaveLength(4);
    for (const overrides of cases) {
      db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, ...overrides }]);
      await reuseEligibilityTx(request({ captureDecisionFingerprint }));
      expect(captureDecisionFingerprint.mock.calls.at(-1)[0]).not.toBe(original);
    }
    expect(captureDecisionFingerprint).toHaveBeenCalledTimes(5);
  });

  test('reuseEligibilityFingerprintIgnoresWallClockAndRequestBodyRnaAssertions', async () => {
    const captureDecisionFingerprint = jest.fn();
    await reuseEligibilityTx(request({ captureDecisionFingerprint }));
    const original = captureDecisionFingerprint.mock.calls.at(-1)[0];
    resolveDialysisIsolationForPatient.mockResolvedValue({ ...decision, asOf: '2026-09-08T10:05:00.000Z' });
    await reuseEligibilityTx(request({
      captureDecisionFingerprint,
      hcvEvidence: { rna_result: 'detected', recorded_independently: false, marker_row_id: 88 },
    }));
    expect(captureDecisionFingerprint.mock.calls.at(-1)[0]).toBe(original);
  });

  test('reuseEligibilityPreschedulingFingerprintIncludesRnaWithoutFabricatingDeviceEligibility', async () => {
    const captureDecisionFingerprint = jest.fn();
    const input = request({ device: undefined, captureDecisionFingerprint });
    await expect(reuseEligibilityTx(input)).resolves.toEqual({
      verdict: 'ineligible', reason_codes: ['RPD_DEVICE_UNAVAILABLE'],
    });
    const original = captureDecisionFingerprint.mock.calls.at(-1)[0];
    db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, id: 2 }]);
    await expect(reuseEligibilityTx(input)).resolves.toEqual({
      verdict: 'ineligible', reason_codes: ['RPD_DEVICE_UNAVAILABLE'],
    });
    expect(captureDecisionFingerprint).toHaveBeenCalledTimes(2);
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(captureDecisionFingerprint.mock.calls.at(-1)[0]).not.toBe(original);
  });

  test('hcvDedicatedReuseAcceptsPersistedDatedAttributedRnaEvidence', async () => {
    const result = await reuseEligibilityTx(request());
    expect(result).toEqual({ verdict: 'eligible', reason_codes: [] });
    expect(db.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = db.$queryRawUnsafe.mock.calls[0];
    expect(params).toEqual([TENANT, PATIENT]);
    expect(sql).toContain('serology.tenant_id = $1::uuid');
    expect(sql).toContain('patient.tenant_id = serology.tenant_id');
    expect(sql).toContain('patient.patient_uid = $2::uuid');
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
    expect(JSON.stringify(result)).not.toMatch(/hbsag|hcv|hiv|isolation_mixed|not_detected/i);
  });

  test('hcvDedicatedReuseNeverAcceptsRequestBodyRnaAssertions', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    await expect(reuseEligibilityTx(request({
      hcvEvidence: { rna_result: 'not_detected', recorded_independently: true },
    }))).resolves.toEqual(REFUSAL);
  });

  test('hcvDedicatedReuseRejectsMissingRnaEvidence', async () => {
    db.$queryRawUnsafe.mockResolvedValue([]);
    const result = await reuseEligibilityTx(request());
    expect(result).toEqual(REFUSAL);
    expect(JSON.stringify(result)).not.toMatch(/hbsag|\bhbv\b|hcv|hiv|hepatitis|isolation_mixed/i);
  });

  test('hcvDedicatedReuseRejectsPendingRnaEvidence', async () => {
    db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, hcv_pcr: 'pending' }]);
    await expect(reuseEligibilityTx(request())).resolves.toEqual(REFUSAL);
  });

  test('hcvDedicatedReuseRejectsInvalidRnaEvidence', async () => {
    const values = [null, undefined, '', 'negative', 'NOT_DETECTED', 'not detected', true];
    expect(values).toHaveLength(7);
    const outcomes = [];
    for (const hcvPcr of values) {
      db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, hcv_pcr: hcvPcr }]);
      outcomes.push(await reuseEligibilityTx(request()));
    }
    expect(outcomes).toEqual(values.map(() => REFUSAL));
  });

  test('hcvDedicatedReuseRejectsUnattributedRnaEvidence', async () => {
    const values = [null, undefined, '', ' ', 'not-a-clinician-uid'];
    expect(values).toHaveLength(5);
    const outcomes = [];
    for (const reportedBy of values) {
      db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, reported_by: reportedBy }]);
      outcomes.push(await reuseEligibilityTx(request()));
    }
    expect(outcomes).toEqual(values.map(() => REFUSAL));
  });

  test('hcvDedicatedReuseRejectsUndatedInvalidOrFutureRnaEvidence', async () => {
    const values = [null, undefined, '', '2026-02-30', 'infinity', '2026-09-09'];
    expect(values).toHaveLength(6);
    const outcomes = [];
    for (const testDate of values) {
      db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, test_date: testDate }]);
      outcomes.push(await reuseEligibilityTx(request()));
    }
    expect(outcomes).toEqual(values.map(() => REFUSAL));
  });

  test('hcvDedicatedReuseRejectsContradictoryLatestDetectedEvidence', async () => {
    db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, hcv_pcr: 'detected' }]);
    await expect(reuseEligibilityTx(request())).resolves.toEqual(REFUSAL);
  });

  test('hcvDedicatedReuseRejectsSameDateContradictoryEvidenceInBothOrders', async () => {
    const contradictory = { ...persisted, id: 2, hcv_pcr: 'detected' };
    const cases = [[persisted, contradictory], [contradictory, persisted]];
    expect(cases).toHaveLength(2);
    const outcomes = [];
    for (const rows of cases) {
      db.$queryRawUnsafe.mockResolvedValue(rows);
      outcomes.push(await reuseEligibilityTx(request()));
    }
    expect(outcomes).toEqual(cases.map(() => REFUSAL));
  });

  test('hcvDedicatedReuseRejectsOverdueRnaEvenWhenOtherSurveillanceIsOptional', async () => {
    db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, test_date: '2026-06-09' }]);
    await expect(reuseEligibilityTx(request({
      protocol: { ...protocol, surveillance_overdue_blocks_reuse: false },
    }))).resolves.toEqual(REFUSAL);
  });

  test('hcvDedicatedReuseUsesResolverTimeInsteadOfCallerRnaCurrencyAssertion', async () => {
    db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, test_date: '2026-06-09' }]);
    await expect(reuseEligibilityTx(request({ asOf: '2026-06-09T10:00:00.000Z' })))
      .resolves.toEqual(REFUSAL);
  });

  test('hcvDedicatedReuseRequiresValidProtocolIntervalAndAcceptsItsExactBoundary', async () => {
    const values = [undefined, null, 0, -1, Infinity, 'invalid'];
    expect(values).toHaveLength(6);
    const outcomes = [];
    for (const interval of values) {
      outcomes.push(await reuseEligibilityTx(request({
        protocol: { ...protocol, surveillance_intervals_days: { hcv: interval } },
      })));
    }
    expect(outcomes).toEqual(values.map(() => REFUSAL));
    db.$queryRawUnsafe.mockResolvedValue([{ ...persisted, test_date: '2026-06-10' }]);
    await expect(reuseEligibilityTx(request())).resolves.toEqual({ verdict: 'eligible', reason_codes: [] });
  });

  test('hcvRnaNotDetectedNeverOverridesHoldsDedicationCeilingsOrIndependentRestrictions', async () => {
    const cases = [
      [{ activeHolds: [{ status: 'active' }] }, 'RPD_ACTIVE_HOLD'],
      [{ dedicatedPatientUid: REPORTER }, 'RPD_DIALYSER_DEDICATION_MISMATCH'],
      [{ device: { ...request().device, cycle_count: 4 } }, 'RPD_MAX_CYCLES_REACHED'],
      [{ protocol: { ...protocol, reuse_matrix: { ...protocol.reuse_matrix, hcv: 'no_reuse' } } }, 'RPD_REUSE_MATRIX_NO_REUSE'],
    ];
    expect(cases).toHaveLength(4);
    for (const [overrides, code] of cases) {
      await expect(reuseEligibilityTx(request(overrides)))
        .resolves.toEqual({ verdict: 'ineligible', reason_codes: [code] });
    }
    const independentClasses = ['hbsag', 'hiv', 'isolation_mixed'];
    expect(independentClasses).toHaveLength(3);
    for (const isolationClass of independentClasses) {
      resolveDialysisIsolationForPatient.mockResolvedValue({ ...decision, isolation_class: isolationClass });
      await expect(reuseEligibilityTx(request()))
        .resolves.toEqual({ verdict: 'ineligible', reason_codes: ['RPD_REUSE_MATRIX_NO_REUSE'] });
    }
  });
});
