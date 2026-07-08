import { _internal } from '../../services/clinical/physioService.js';

const { computeOutcomeTrend, normalizeMeasureEntries } = _internal;

describe('physio measure validation', () => {
  test('normalizes ROM entries with numeric units', () => {
    expect(normalizeMeasureEntries([
      { joint: 'knee', movement: 'flexion', degrees: '118', pain_score: '2' },
    ], 'rom_measures')).toEqual([
      expect.objectContaining({
        label: 'knee',
        degrees: 118,
        pain_score: 2,
      }),
    ]);
  });

  test('rejects non-array and out-of-range values', () => {
    expect(() => normalizeMeasureEntries({ joint: 'knee' }, 'rom_measures')).toThrow(/array/);
    expect(() => normalizeMeasureEntries([{ label: 'knee', degrees: 361 }], 'rom_measures')).toThrow(/degrees/);
    expect(() => normalizeMeasureEntries([{ label: 'knee', pain_score: 11 }], 'rom_measures')).toThrow(/pain_score/);
    expect(() => normalizeMeasureEntries([{ degrees: 90 }], 'rom_measures')).toThrow(/requires label/);
  });
});

describe('physio outcome trend math', () => {
  test('higher functional score is improvement', () => {
    const trend = computeOutcomeTrend([
      { id: 1, score_value: 42, score_label: 'Functional', score_unit: 'score', scored_at: '2026-07-01T00:00:00Z' },
      { id: 2, score_value: 57, score_label: 'Functional', score_unit: 'score', scored_at: '2026-07-03T00:00:00Z' },
    ], 'functional');
    expect(trend).toMatchObject({
      count: 2,
      first_score: 42,
      latest_score: 57,
      change: 15,
      direction: 'improved',
    });
  });

  test('lower pain score is improvement', () => {
    const trend = computeOutcomeTrend([
      { id: 1, score_value: 8, score_label: 'Pain', score_unit: '0-10', scored_at: '2026-07-01T00:00:00Z' },
      { id: 2, score_value: 3, score_label: 'Pain', score_unit: '0-10', scored_at: '2026-07-03T00:00:00Z' },
    ], 'pain');
    expect(trend).toMatchObject({
      change: -5,
      direction: 'improved',
    });
  });
});
