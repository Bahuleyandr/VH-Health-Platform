// C-M7 — ONE clinically correct NEWS2 scorer (RCP NEWS2 2017).
//
// Defects fixed:
//   * news2Service.calculateNEWS2 ignored supplemental_o2 in its Scale-2
//     branch, so a hypercapnic-risk patient on ROOM AIR with a normal
//     saturation (SpO2 >= 97) scored 3 — a false red parameter that fired the
//     single-red escalation (PR #751 rule) for a perfectly oxygenated patient.
//   * nursingAssessmentService.scoreNews2 was a divergent second scorer; it
//     now delegates here (adapter pinned below).
//   * Scale selection was caller-supplied per reading with no patient-level
//     source of truth; resolveSpo2ScaleForPatient reads the new
//     users.news2_spo2_scale flag (migration 643), defaulting to Scale 1.
//
// Correct Scale-2 SpO2 behavior (RCP): on room air 93-100% scores 0; the
// elevated bands 93-94→1 / 95-96→2 / >=97→3 apply ONLY on supplemental O2.
// Scale-1 bands are unchanged.

import { jest } from '@jest/globals';

const queryMock = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryMock },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { calculateNEWS2, normalizeSpo2Scale, resolveSpo2ScaleForPatient } =
  await import('../../services/clinical/news2Service.js');
const { scoreNews2 } = await import('../../services/clinical/nursingAssessmentService.js');

// Every other parameter dead-normal so the SpO2 sub-score is the only signal.
const NORMAL = { respiration_rate: 16, temperature: 37, systolic_bp: 120, heart_rate: 72, consciousness: 'A' };

describe('Scale 1 SpO2 bands (unchanged)', () => {
  test.each([
    [91, 3], [92, 2], [93, 2], [94, 1], [95, 1], [96, 0], [97, 0], [100, 0],
  ])('spo2 %i → %i', (spo2, expected) => {
    const r = calculateNEWS2({ ...NORMAL, spo2 });
    expect(r.scores.spo2).toBe(expected);
  });

  test('default scale is 1 when nothing is supplied', () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 91 });
    expect(r.scores.spo2).toBe(3); // Scale-2 would give 0
  });
});

describe('Scale 2 SpO2 on ROOM AIR (the C-M7 regression case)', () => {
  test.each([97, 98, 99, 100])('spo2 %i on room air → 0 points, NO red param', (spo2) => {
    const r = calculateNEWS2({ ...NORMAL, spo2, supplemental_o2: false }, { spo2Scale: 2 });
    expect(r.scores.spo2).toBe(0);
    expect(r.anyParamThree).toBe(false);
    expect(r.totalScore).toBe(0);
    expect(r.clinicalRisk).toBe('low');
  });

  test.each([
    [88, 0], [92, 0], [93, 0], [94, 0], [95, 0], [96, 0],
  ])('spo2 %i on room air → %i (>=93 must not score up)', (spo2, expected) => {
    const r = calculateNEWS2({ ...NORMAL, spo2 }, { spo2Scale: 2 });
    expect(r.scores.spo2).toBe(expected);
  });

  test.each([
    [83, 3], [84, 2], [85, 2], [86, 1], [87, 1],
  ])('low-side band spo2 %i → %i (unchanged, air or O2)', (spo2, expected) => {
    const onAir = calculateNEWS2({ ...NORMAL, spo2 }, { spo2Scale: 2 });
    const onO2 = calculateNEWS2({ ...NORMAL, spo2, supplemental_o2: true }, { spo2Scale: 2 });
    expect(onAir.scores.spo2).toBe(expected);
    expect(onO2.scores.spo2).toBe(expected);
  });
});

describe('Scale 2 SpO2 on SUPPLEMENTAL O2 (elevated bands apply)', () => {
  test.each([
    [93, 1], [94, 1], [95, 2], [96, 2], [97, 3], [100, 3],
  ])('spo2 %i on O2 → %i', (spo2, expected) => {
    const r = calculateNEWS2({ ...NORMAL, spo2, supplemental_o2: true }, { spo2Scale: 2 });
    expect(r.scores.spo2).toBe(expected);
    // The O2 modifier itself stays a separate +2.
    expect(r.scores.supplemental_o2).toBe(2);
  });

  test('spo2 97 on O2 is a red param → single-red escalation preserved', () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 97, supplemental_o2: true }, { spo2Scale: 2 });
    expect(r.anyParamThree).toBe(true);
    expect(r.totalScore).toBe(5); // 3 (spo2) + 2 (O2 modifier)
  });

  test('spo2 92 on O2 is in target range → 0 + only the O2 modifier', () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 92, supplemental_o2: true }, { spo2Scale: 2 });
    expect(r.scores.spo2).toBe(0);
    expect(r.totalScore).toBe(2);
  });
});

describe('scale selection + normalization', () => {
  test('options.spo2Scale wins over vitals.spo2_scale', () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 91, spo2_scale: 2 }, { spo2Scale: 1 });
    expect(r.scores.spo2).toBe(3); // scored on Scale 1
  });

  test('per-reading vitals.spo2_scale still honored when no option passed', () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 91, spo2_scale: 2 });
    expect(r.scores.spo2).toBe(0); // Scale 2 target band
  });

  test("string '2' (JSON body / inputs blob) is accepted", () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 91, spo2_scale: '2' });
    expect(r.scores.spo2).toBe(0);
  });

  test('an unrecognized scale falls back to Scale 1, never Scale 2', () => {
    const r = calculateNEWS2({ ...NORMAL, spo2: 91, spo2_scale: 3 });
    expect(r.scores.spo2).toBe(3); // Scale-1 band, not Scale-2's 0
  });

  test('normalizeSpo2Scale', () => {
    expect(normalizeSpo2Scale(1)).toBe(1);
    expect(normalizeSpo2Scale(2)).toBe(2);
    expect(normalizeSpo2Scale('1')).toBe(1);
    expect(normalizeSpo2Scale('2')).toBe(2);
    expect(normalizeSpo2Scale(3)).toBeNull();
    expect(normalizeSpo2Scale('x')).toBeNull();
    expect(normalizeSpo2Scale(undefined)).toBeNull();
    expect(normalizeSpo2Scale(null)).toBeNull();
  });
});

describe('resolveSpo2ScaleForPatient (users.news2_spo2_scale, migration 643)', () => {
  beforeEach(() => queryMock.mockReset());

  test('flag = 2 → Scale 2', async () => {
    queryMock.mockResolvedValueOnce([{ news2_spo2_scale: 2 }]);
    await expect(resolveSpo2ScaleForPatient('11111111-1111-4111-8111-111111111111')).resolves.toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toMatch(/news2_spo2_scale FROM users/);
  });

  test('flag = 1 → Scale 1', async () => {
    queryMock.mockResolvedValueOnce([{ news2_spo2_scale: 1 }]);
    await expect(resolveSpo2ScaleForPatient('11111111-1111-4111-8111-111111111111')).resolves.toBe(1);
  });

  test('unknown patient → Scale 1', async () => {
    queryMock.mockResolvedValueOnce([]);
    await expect(resolveSpo2ScaleForPatient('11111111-1111-4111-8111-111111111111')).resolves.toBe(1);
  });

  test('lookup failure → Scale 1 (fail-safe, never blocks the clinical write)', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveSpo2ScaleForPatient('11111111-1111-4111-8111-111111111111')).resolves.toBe(1);
  });

  test('no patientUid → Scale 1 without a query', async () => {
    await expect(resolveSpo2ScaleForPatient(null)).resolves.toBe(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  test('uses the supplied db client (in-tx callers)', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{ news2_spo2_scale: 2 }]);
    await expect(resolveSpo2ScaleForPatient('11111111-1111-4111-8111-111111111111', { db: { $queryRawUnsafe: txQuery } })).resolves.toBe(2);
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('nursingAssessmentService.scoreNews2 delegates to the unified scorer', () => {
  test('Scale-2 patient on room air with spo2 97 no longer scores a red (the divergence)', () => {
    const r = scoreNews2({
      rr: 16, spo2: 97, spo2_scale: '2', supplemental_o2: false,
      temp_c: 37, sbp: 120, hr: 72, consciousness: 'awake',
    });
    expect(r.total_score).toBe(0);
    expect(r.band).toBe('low');
  });

  test('Scale-2 patient ON O2 with spo2 97 stays a red → band high', () => {
    const r = scoreNews2({
      rr: 16, spo2: 97, spo2_scale: 2, supplemental_o2: true,
      temp_c: 37, sbp: 120, hr: 72, consciousness: 'awake',
    });
    expect(r.total_score).toBe(5); // spo2 3 + O2 modifier 2
    expect(r.band).toBe('high');
    expect(r.reassessmentMins).toBe(15);
  });

  test('options.spo2Scale (resolved patient flag) wins over inputs', () => {
    const r = scoreNews2(
      { rr: 16, spo2: 97, supplemental_o2: false, temp_c: 37, sbp: 120, hr: 72, consciousness: 'awake' },
      { spo2Scale: 2 },
    );
    expect(r.total_score).toBe(0);
    expect(r.band).toBe('low');
  });

  test("keeps the 'awake' consciousness vocabulary (scores 0)", () => {
    const r = scoreNews2({ rr: 16, spo2: 98, temp_c: 37, sbp: 120, hr: 72, consciousness: 'awake' });
    expect(r.total_score).toBe(0);
    expect(r.band).toBe('low');
  });

  test('band vocabulary preserved for the overdue-or-high-risk dashboard SQL', () => {
    // low
    expect(scoreNews2({ rr: 16, spo2: 98, temp_c: 37, sbp: 120, hr: 72, consciousness: 'A' }).band).toBe('low');
    // low_medium at >=3 aggregate without a red
    expect(scoreNews2({ rr: 22, spo2: 98, temp_c: 37, sbp: 105, hr: 72, consciousness: 'A' }).band).toBe('low_medium');
    // medium at >=5 aggregate without a red
    expect(scoreNews2({ rr: 22, spo2: 93, temp_c: 35.5, sbp: 120, hr: 72, consciousness: 'A' }).band).toBe('medium');
    // single red forces high even at aggregate 3
    expect(scoreNews2({ rr: 16, spo2: 98, temp_c: 37, sbp: 85, hr: 72, consciousness: 'A' }).band).toBe('high');
  });
});
