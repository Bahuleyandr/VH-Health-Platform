/**
 * S3 unit tests: per-slice metrics and bias-signal escalation in
 * driftCanaryService. The full runCanary flow needs a real DB so these
 * tests target the pure helpers (computeSliceMetrics, computeBiasSignals)
 * which carry the bias-detection contract.
 */

import {
  computeSliceMetrics,
  computeBiasSignals,
} from '../../services/ai/driftCanaryService.js';

function makeCase(id, attrs) {
  return {
    id,
    module_key: 'discharge_summary',
    label: `case-${id}`,
    slice_attributes: attrs,
  };
}

function makeFinding(caseId, passed) {
  return { case_id: caseId, label: `case-${caseId}`, passed };
}

describe('driftCanaryService bias monitoring', () => {
  describe('computeSliceMetrics', () => {
    it('returns an empty array when no findings declare slices', () => {
      const cases = [makeCase(1, {}), makeCase(2, {})];
      const findings = [makeFinding(1, true), makeFinding(2, false)];
      expect(computeSliceMetrics(findings, cases)).toEqual([]);
    });

    it('groups findings by every recognised demographic axis', () => {
      const cases = [
        makeCase(1, { age_band: 'pediatric', sex: 'F', language: 'en' }),
        makeCase(2, { age_band: 'pediatric', sex: 'M', language: 'ta' }),
        makeCase(3, { age_band: 'adult', sex: 'F', language: 'en' }),
        makeCase(4, { age_band: 'adult', sex: 'M', language: 'en' }),
      ];
      const findings = [
        makeFinding(1, false),
        makeFinding(2, false),
        makeFinding(3, true),
        makeFinding(4, true),
      ];
      const slices = computeSliceMetrics(findings, cases);
      const pediatric = slices.find((s) => s.axis === 'age_band' && s.value === 'pediatric');
      const adult = slices.find((s) => s.axis === 'age_band' && s.value === 'adult');
      expect(pediatric).toMatchObject({ sample_count: 2, pass_count: 0, pass_rate_pct: 0 });
      expect(adult).toMatchObject({ sample_count: 2, pass_count: 2, pass_rate_pct: 100 });
      // Sex axis represented for both M and F.
      expect(slices.some((s) => s.axis === 'sex' && s.value === 'F')).toBe(true);
      expect(slices.some((s) => s.axis === 'sex' && s.value === 'M')).toBe(true);
    });

    it('skips axes that are not recognised demographic dimensions', () => {
      const cases = [makeCase(1, { custom_axis: 'x', age_band: 'adult' })];
      const findings = [makeFinding(1, true)];
      const slices = computeSliceMetrics(findings, cases);
      expect(slices.some((s) => s.axis === 'custom_axis')).toBe(false);
      expect(slices.some((s) => s.axis === 'age_band')).toBe(true);
    });

    it('treats missing slice_attributes as no-op', () => {
      const cases = [{ id: 1 }, { id: 2 }];
      const findings = [makeFinding(1, true), makeFinding(2, false)];
      expect(computeSliceMetrics(findings, cases)).toEqual([]);
    });
  });

  describe('computeBiasSignals', () => {
    it('does not fire below the medium threshold (15pp)', () => {
      const slices = [
        { axis: 'age_band', value: 'pediatric', sample_count: 4, pass_count: 3, pass_rate_pct: 75 },
        { axis: 'age_band', value: 'adult', sample_count: 4, pass_count: 4, pass_rate_pct: 100 },
      ];
      // Overall is 87% (rounded). Pediatric is 75% — only 12pp below; should not fire.
      const signals = computeBiasSignals(slices, 87);
      expect(signals).toEqual([]);
    });

    it('fires medium when 15-24pp below', () => {
      const slices = [
        { axis: 'language', value: 'ta', sample_count: 4, pass_count: 2, pass_rate_pct: 50 },
      ];
      const signals = computeBiasSignals(slices, 70);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ severity: 'medium', delta_pct: 20 });
    });

    it('fires high when 25-34pp below', () => {
      const slices = [
        { axis: 'sex', value: 'F', sample_count: 6, pass_count: 3, pass_rate_pct: 50 },
      ];
      const signals = computeBiasSignals(slices, 80);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ severity: 'high', delta_pct: 30 });
    });

    it('fires critical when 35pp or more below', () => {
      const slices = [
        { axis: 'age_band', value: 'pediatric', sample_count: 5, pass_count: 1, pass_rate_pct: 20 },
      ];
      const signals = computeBiasSignals(slices, 80);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ severity: 'critical', delta_pct: 60 });
    });

    it('skips slices with fewer than the minimum sample count (3)', () => {
      const slices = [
        { axis: 'language', value: 'kn', sample_count: 2, pass_count: 0, pass_rate_pct: 0 },
      ];
      // Single-pass, but only 2 samples — too noisy to fire.
      const signals = computeBiasSignals(slices, 80);
      expect(signals).toEqual([]);
    });

    it('orders critical signals before high before medium, then by delta', () => {
      const slices = [
        { axis: 'age_band', value: 'adult', sample_count: 5, pass_count: 4, pass_rate_pct: 80 },   // -5pp, no signal
        { axis: 'language', value: 'ta', sample_count: 5, pass_count: 1, pass_rate_pct: 20 },      // -65pp, critical
        { axis: 'sex', value: 'F', sample_count: 5, pass_count: 3, pass_rate_pct: 60 },            // -25pp, high
        { axis: 'language', value: 'hi', sample_count: 5, pass_count: 3, pass_rate_pct: 60 },      // -25pp, high
        { axis: 'age_band', value: 'pediatric', sample_count: 5, pass_count: 4, pass_rate_pct: 80 }, // -5pp, no signal
      ];
      const signals = computeBiasSignals(slices, 85);
      expect(signals[0].severity).toBe('critical');
      expect(signals[0].axis).toBe('language');
      expect(signals[0].value).toBe('ta');
      expect(signals.slice(1).every((s) => s.severity === 'high')).toBe(true);
    });

    it('returns an empty list when overallPassRate is null/undefined', () => {
      const slices = [
        { axis: 'age_band', value: 'pediatric', sample_count: 5, pass_count: 0, pass_rate_pct: 0 },
      ];
      expect(computeBiasSignals(slices, null)).toEqual([]);
      expect(computeBiasSignals(slices, undefined)).toEqual([]);
      expect(computeBiasSignals(slices, NaN)).toEqual([]);
    });

    it('every signal has a human-readable message naming axis and value', () => {
      const slices = [
        { axis: 'language', value: 'ta', sample_count: 5, pass_count: 1, pass_rate_pct: 20 },
      ];
      const [signal] = computeBiasSignals(slices, 80);
      expect(signal.message).toContain('language=ta');
      expect(signal.message).toContain('60');
      expect(signal.message).toContain('80');
    });
  });

  describe('end-to-end slice → signal pipeline', () => {
    it('catches a real demographic gap from raw findings', () => {
      const cases = [
        ...Array.from({ length: 10 }, (_, i) => makeCase(100 + i, { age_band: 'adult' })),
        ...Array.from({ length: 5 }, (_, i) => makeCase(200 + i, { age_band: 'pediatric' })),
      ];
      // Adult: 9/10 pass. Pediatric: 1/5 pass.
      const findings = [
        ...Array.from({ length: 10 }, (_, i) => makeFinding(100 + i, i !== 0)),
        ...Array.from({ length: 5 }, (_, i) => makeFinding(200 + i, i === 0)),
      ];
      const slices = computeSliceMetrics(findings, cases);
      const overallPassPct = Math.round(((9 + 1) / 15) * 100);
      const signals = computeBiasSignals(slices, overallPassPct);
      const pediatricSignal = signals.find((s) => s.value === 'pediatric');
      expect(pediatricSignal).toBeDefined();
      expect(['high', 'critical']).toContain(pediatricSignal.severity);
    });
  });
});
