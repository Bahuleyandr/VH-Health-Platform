// MEDIUM (audit 2026-06-18 §4) — NEWS2 must compute a PARTIAL score when
// alarming params are present, instead of silently skipping (or, worse,
// mis-scoring an absent parameter as the worst band).
//
// Defect: calculateNEWS2 scored every parameter through a fall-through if/else;
// an ABSENT respiration_rate (undefined) fell to the final `else` and scored 3,
// and the vitals path only ran NEWS2 when RR+SpO2+SBP+HR were ALL present, so a
// partial vitals set (e.g. just a critically-low SpO2) produced NO score at all.
//
// Fix proven here (pure unit test of calculateNEWS2):
//   1. An absent parameter is NOT scored (no phantom +3 for missing RR).
//   2. A partial set still yields a correct partial total over present params,
//      flagged `partial: true` with the missing params listed.
//   3. A complete set is unchanged (partial: false) and still honours the
//      single-parameter-3 escalation rule.

import { calculateNEWS2 } from '../../services/clinical/news2Service.js';

describe('NEWS2 partial scoring (MEDIUM §4)', () => {
  test('absent respiration_rate is NOT mis-scored as the worst band (no phantom +3)', () => {
    // Only SpO2 present, and it is healthy (scale 1, 98% → 0). The total must be
    // 0, NOT 3 — previously a missing RR fell through to `else => 3`.
    const out = calculateNEWS2({ spo2: 98 });
    expect(out.scores.respiration_rate).toBeUndefined();
    expect(out.totalScore).toBe(0);
    expect(out.partial).toBe(true);
    expect(out.missingParams).toEqual(expect.arrayContaining(['respiration_rate']));
  });

  test('a partial set with an alarming param yields a correct partial total', () => {
    // SpO2 88 on scale 1 → 3. Nothing else present. Partial total = 3.
    const out = calculateNEWS2({ spo2: 88 });
    expect(out.scores.spo2).toBe(3);
    expect(out.totalScore).toBe(3);
    expect(out.partial).toBe(true);
    expect(out.anyParamThree).toBe(true);
  });

  test('a complete vitals set scores fully and is not flagged partial', () => {
    // RR 26→3, SpO2 90 (scale1)→3, T37→0, SBP95→2, HR130→2, A→0 = 10.
    const out = calculateNEWS2({
      respiration_rate: 26,
      spo2: 90,
      temperature: 37,
      systolic_bp: 95,
      heart_rate: 130,
      consciousness: 'A',
    });
    expect(out.partial).toBe(false);
    expect(out.missingParams).toEqual([]);
    expect(out.totalScore).toBe(10);
    expect(out.clinicalRisk).toBe('high');
  });

  test('no alarming/usable params present → not scorable (no NEWS2 to record)', () => {
    const out = calculateNEWS2({});
    expect(out.scorable).toBe(false);
    expect(out.totalScore).toBe(0);
  });
});
