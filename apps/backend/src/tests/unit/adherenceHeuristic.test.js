// Unit tests for the medication-adherence heuristic scorer.
//
// The heuristic is the ALWAYS-RUNNING path. The optional ONNX model overrides
// it when `models/adherence-risk.onnx` is present (it isn't, in this repo —
// see ROADMAP 3D follow-through for the training pipeline). Even after the
// model lands, this heuristic remains the fallback if the .onnx file fails
// to load, so its arithmetic must stay regression-tested.

import { bandFor, computeHeuristicScore } from '../../services/gamification/adherenceRiskService.js';

describe('computeHeuristicScore', () => {
  it('returns 0 for a perfectly compliant patient (and the score is 0, not just low)', () => {
    const { score, contribution } = computeHeuristicScore({
      missedDoses30: 0,
      marOverrides30: 0,
      lateRefills90: 0,
      daysSinceLastVital: 0,
    });
    expect(score).toBe(0);
    expect(contribution).toEqual({ missed: 0, overrides: 0, refills: 0, silent: 0 });
  });

  it('caps at 100 even with absurdly bad inputs', () => {
    const { score } = computeHeuristicScore({
      missedDoses30: 1000,
      marOverrides30: 1000,
      lateRefills90: 1000,
      daysSinceLastVital: 1000,
    });
    expect(score).toBe(100);
  });

  it('caps each factor at its individual maximum so no single signal dominates', () => {
    const { contribution } = computeHeuristicScore({
      missedDoses30: 100,
      marOverrides30: 0,
      lateRefills90: 0,
      daysSinceLastVital: 0,
    });
    expect(contribution.missed).toBe(30);   // capped at 30 even with 100 missed doses
    expect(contribution.overrides).toBe(0);
    expect(contribution.refills).toBe(0);
    expect(contribution.silent).toBe(0);
  });

  it('totals weights linearly within their caps', () => {
    // 3 missed doses (weight 6 each) = 18 pts, no other factors
    const { score, contribution } = computeHeuristicScore({
      missedDoses30: 3,
      marOverrides30: 0,
      lateRefills90: 0,
      daysSinceLastVital: 0,
    });
    expect(contribution.missed).toBe(18);
    expect(score).toBe(18);
  });

  it('treats missing factor values as 0 (not NaN)', () => {
    const { score } = computeHeuristicScore({}); // empty object
    expect(score).toBe(0);
  });

  it('accumulates daysSinceLastVital at 0.5 pts/day capped at 30', () => {
    expect(computeHeuristicScore({ daysSinceLastVital: 10 }).contribution.silent).toBe(5);
    expect(computeHeuristicScore({ daysSinceLastVital: 60 }).contribution.silent).toBe(30);
    expect(computeHeuristicScore({ daysSinceLastVital: 120 }).contribution.silent).toBe(30); // still capped
  });

  it('rounds the final score to an integer', () => {
    const { score } = computeHeuristicScore({ daysSinceLastVital: 3 }); // 3 * 0.5 = 1.5 → 2
    expect(Number.isInteger(score)).toBe(true);
  });
});

describe('bandFor', () => {
  it('returns "high" at and above 70', () => {
    expect(bandFor(70)).toBe('high');
    expect(bandFor(85)).toBe('high');
    expect(bandFor(100)).toBe('high');
  });

  it('returns "medium" between 40 and 69', () => {
    expect(bandFor(40)).toBe('medium');
    expect(bandFor(55)).toBe('medium');
    expect(bandFor(69)).toBe('medium');
  });

  it('returns "low" below 40', () => {
    expect(bandFor(0)).toBe('low');
    expect(bandFor(20)).toBe('low');
    expect(bandFor(39)).toBe('low');
  });
});
