// Roadmap D2 — scheduling pure helpers.

import {
  addMinutes,
  expandTemplateSlots,
  computeOverbookAllowance,
} from '../../services/scheduling/schedulingOptimizationService.js';

describe('scheduling expandTemplateSlots', () => {
  test('expands a 09:00-11:00 / 30min template into 4 slots', () => {
    expect(expandTemplateSlots('09:00', '11:00', 30)).toEqual(['09:00', '09:30', '10:00', '10:30']);
  });
  test('drops a trailing partial slot and tolerates HH:MM:SS times', () => {
    expect(expandTemplateSlots('09:00:00', '09:50:00', 20)).toEqual(['09:00', '09:20']);
  });
  test('addMinutes rolls over hours', () => {
    expect(addMinutes('09:45', 30)).toBe('10:15');
    expect(addMinutes('23:50', 20)).toBe('00:10');
  });
});

describe('scheduling computeOverbookAllowance', () => {
  test('floors expected no-shows from risk scores', () => {
    // 0.8 + 0.7 + 0.6 = 2.1 expected → 2, cap 15% of 20 = 3.
    expect(computeOverbookAllowance(20, [0.8, 0.7, 0.6])).toBe(2);
  });
  test('caps at the configured fraction of capacity', () => {
    expect(computeOverbookAllowance(10, [0.9, 0.9, 0.9, 0.9, 0.9], 0.15)).toBe(1);
  });
  test('ignores junk scores and never goes negative', () => {
    expect(computeOverbookAllowance(10, [NaN, -1, 2, null])).toBe(0);
    expect(computeOverbookAllowance(0, [0.9])).toBe(0);
  });
});
