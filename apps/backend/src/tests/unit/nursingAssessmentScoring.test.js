// Unit tests for the Sprint-15 nursing assessment scoring (NEWS2,
// Braden, Morse, sepsis screen). These functions are pure compute,
// so the tests don't need a DB.

import {
  scoreNews2,
  scoreBraden,
  scoreMorse,
  scoreSepsisScreen,
  score,
} from '../../services/clinical/nursingAssessmentService.js';

describe('NEWS2', () => {
  it('healthy adult vitals → low band, total 0', () => {
    const r = scoreNews2({
      rr: 16, spo2: 98, supplemental_o2: false, temp_c: 36.8,
      sbp: 120, hr: 72, consciousness: 'awake',
    });
    expect(r.total_score).toBe(0);
    expect(r.band).toBe('low');
  });

  it('aggregate ≥7 → high band', () => {
    const r = scoreNews2({
      rr: 26, spo2: 90, supplemental_o2: true, temp_c: 39.5,
      sbp: 95, hr: 125, consciousness: 'awake',
    });
    // RR 3 + SpO2 3 + supp O2 2 + temp 2 + SBP 2 + HR 2 = 14
    expect(r.total_score).toBeGreaterThanOrEqual(7);
    expect(r.band).toBe('high');
  });

  it('any single +3 score forces band high', () => {
    // Just SBP = 85 → +3
    const r = scoreNews2({
      rr: 16, spo2: 98, supplemental_o2: false, temp_c: 36.8,
      sbp: 85, hr: 72, consciousness: 'awake',
    });
    expect(r.total_score).toBe(3);
    expect(r.band).toBe('high');
  });

  it('reassessment frequency drops to 15min for high', () => {
    const r = scoreNews2({
      rr: 26, spo2: 88, temp_c: 39, sbp: 80, hr: 130,
    });
    expect(r.band).toBe('high');
    expect(r.reassessmentMins).toBe(15);
  });

  it('low band gets 12-hourly reassessment', () => {
    const r = scoreNews2({
      rr: 16, spo2: 98, temp_c: 36.8, sbp: 120, hr: 72, consciousness: 'awake',
    });
    expect(r.reassessmentMins).toBe(720);
  });
});

describe('Braden', () => {
  it('total 23 (max) → no_risk', () => {
    expect(
      scoreBraden({
        sensory: 4, moisture: 4, activity: 4, mobility: 4,
        nutrition: 4, friction: 3,
      }).band,
    ).toBe('no_risk');
  });

  it('total 9 → severe_risk', () => {
    const r = scoreBraden({
      sensory: 1, moisture: 2, activity: 1, mobility: 2,
      nutrition: 2, friction: 1,
    });
    expect(r.total_score).toBe(9);
    expect(r.band).toBe('severe_risk');
  });

  it('rejects out-of-range component', () => {
    expect(() =>
      scoreBraden({ sensory: 5, moisture: 4, activity: 4, mobility: 4, nutrition: 4, friction: 3 }),
    ).toThrow();
  });
});

describe('Morse Falls', () => {
  it('all yes + impaired gait → high_risk', () => {
    const r = scoreMorse({
      history_falls: true,
      secondary_dx: true,
      ambulatory_aid: 'furniture',
      iv_therapy: true,
      gait: 'impaired',
      mental_status: 'forgets_limits',
    });
    expect(r.total_score).toBe(125);
    expect(r.band).toBe('high_risk');
  });

  it('boundary at 25 → moderate_risk', () => {
    const r = scoreMorse({
      history_falls: true, // 25
    });
    expect(r.total_score).toBe(25);
    expect(r.band).toBe('moderate_risk');
  });

  it('zero score → low_risk', () => {
    expect(scoreMorse({}).band).toBe('low_risk');
  });
});

describe('Sepsis screen', () => {
  it('SIRS ≥2 + suspected source → sepsis_likely', () => {
    const r = scoreSepsisScreen({
      rr_over_22: true,
      hr_over_90: true,
      source_suspected: true,
    });
    expect(r.band).toBe('sepsis_likely');
  });

  it('qSOFA ≥2 + suspected source → septic_shock_risk', () => {
    const r = scoreSepsisScreen({
      rr_over_22: true,
      altered_mentation: true,
      source_suspected: true,
    });
    expect(r.band).toBe('septic_shock_risk');
  });

  it('lactate > 2 alone bumps to monitor_closely', () => {
    expect(
      scoreSepsisScreen({ lactate_over_2: true }).band,
    ).toBe('monitor_closely');
  });

  it('nothing positive → no_concern', () => {
    expect(scoreSepsisScreen({}).band).toBe('no_concern');
  });
});

describe('score() router', () => {
  it('routes to the right scorer', () => {
    expect(score('news2', { rr: 16 }).band).toBeDefined();
    expect(score('braden', { sensory: 4, moisture: 4, activity: 4, mobility: 4, nutrition: 4, friction: 3 }).band).toBe('no_risk');
    expect(score('morse', {}).band).toBe('low_risk');
    expect(score('sepsis_screen', {}).band).toBe('no_concern');
  });

  it('rejects unknown kind', () => {
    expect(() => score('made_up', {})).toThrow();
  });
});
