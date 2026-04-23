import {
  calculateShiftLoad,
  detectBurnoutSignals,
  computeBurnoutRiskScore,
  NIGHT_SHIFT_STREAK_CAUTION,
  NIGHT_SHIFT_STREAK_ESCALATE,
  HIGH_HOURS_PER_WEEK,
} from '../../services/ai/staffBurnoutRiskService.js';

function hoursAround(baseHour, durationHours, dayOffset = 0) {
  const base = new Date('2026-04-01T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const start = new Date(base);
  start.setUTCHours(baseHour, 0, 0, 0);
  const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
  return { start_at: start.toISOString(), end_at: end.toISOString() };
}

describe('staff burnout risk helpers', () => {
  describe('calculateShiftLoad', () => {
    it('returns all zeros for an empty array', () => {
      const result = calculateShiftLoad([]);
      expect(result.total_hours).toBe(0);
      expect(result.overtime_hours).toBe(0);
      expect(result.night_shift_count).toBe(0);
      expect(result.consecutive_night_shifts).toBe(0);
      expect(result.weekend_shift_count).toBe(0);
      expect(result.shift_count).toBe(0);
      expect(result.first_shift_at).toBeNull();
      expect(result.last_shift_at).toBeNull();
    });

    it('sums total_hours and overtime across multiple shifts', () => {
      const shifts = [
        { ...hoursAround(9, 8, 0), shift_type: 'day' },     // 8h → 0h overtime
        { ...hoursAround(9, 10, 1), shift_type: 'day' },    // 10h → 2h overtime
        { ...hoursAround(9, 12, 2), shift_type: 'day' },    // 12h → 4h overtime
      ];
      const result = calculateShiftLoad(shifts);
      expect(result.total_hours).toBe(30);
      expect(result.overtime_hours).toBe(6);
      expect(result.shift_count).toBe(3);
    });

    it('identifies night_shift_count correctly', () => {
      const shifts = [
        { ...hoursAround(9, 8, 0), shift_type: 'day' },
        { ...hoursAround(22, 8, 1), shift_type: 'night' },
        { ...hoursAround(22, 8, 2), shift_type: 'night' },
      ];
      const result = calculateShiftLoad(shifts);
      expect(result.night_shift_count).toBe(2);
    });

    it('identifies the longest consecutive_night_shifts streak', () => {
      // 4 consecutive night shifts, then a gap, then 2 more.
      const shifts = [
        { ...hoursAround(22, 8, 0), shift_type: 'night' },
        { ...hoursAround(22, 8, 1), shift_type: 'night' },
        { ...hoursAround(22, 8, 2), shift_type: 'night' },
        { ...hoursAround(22, 8, 3), shift_type: 'night' },
        // 5-day gap
        { ...hoursAround(22, 8, 9), shift_type: 'night' },
        { ...hoursAround(22, 8, 10), shift_type: 'night' },
      ];
      const result = calculateShiftLoad(shifts);
      expect(result.consecutive_night_shifts).toBe(4);
    });

    it('handles null input gracefully', () => {
      const result = calculateShiftLoad(null);
      expect(result.total_hours).toBe(0);
      expect(result.shift_count).toBe(0);
    });

    it('counts weekend shifts using UTC day-of-week', () => {
      // Seed starts Wednesday 2026-04-01. Day offsets 3 (Sat) and 4 (Sun) are weekend.
      const shifts = [
        { ...hoursAround(9, 8, 0), shift_type: 'day' },  // Wed
        { ...hoursAround(9, 8, 3), shift_type: 'day' },  // Sat
        { ...hoursAround(9, 8, 4), shift_type: 'day' },  // Sun
      ];
      const result = calculateShiftLoad(shifts);
      expect(result.weekend_shift_count).toBe(2);
    });

    it('honors explicit hours field when provided', () => {
      const shifts = [
        { start_at: '2026-04-01T09:00:00Z', end_at: '2026-04-01T17:00:00Z', hours: 10, shift_type: 'day' },
      ];
      const result = calculateShiftLoad(shifts);
      expect(result.total_hours).toBe(10);
      expect(result.overtime_hours).toBe(2);
    });
  });

  describe('detectBurnoutSignals', () => {
    it('emits HIGH_WEEKLY_HOURS when avgHoursPerWeek exceeds the threshold', () => {
      const signals = detectBurnoutSignals({
        totalHours: 260,
        overtimeHours: 10,
        consecutiveNightShifts: 0,
        nightShiftCount: 1,
        weekendShiftCount: 1,
        ptoDaysTaken: 3,
        windowDays: 30,
        avgHoursPerWeek: HIGH_HOURS_PER_WEEK + 5,
      });
      expect(signals.some((s) => s.code === 'HIGH_WEEKLY_HOURS' && s.severity === 'high')).toBe(true);
    });

    it('emits EXTENDED_NIGHT_SHIFT_STREAK at or above the escalate threshold', () => {
      const signals = detectBurnoutSignals({
        totalHours: 120,
        overtimeHours: 5,
        consecutiveNightShifts: NIGHT_SHIFT_STREAK_ESCALATE,
        nightShiftCount: NIGHT_SHIFT_STREAK_ESCALATE,
        weekendShiftCount: 1,
        ptoDaysTaken: 3,
        windowDays: 30,
        avgHoursPerWeek: 40,
      });
      expect(signals.some((s) => s.code === 'EXTENDED_NIGHT_SHIFT_STREAK' && s.severity === 'high')).toBe(true);
    });

    it('emits NIGHT_SHIFT_STREAK (medium) at the caution threshold but below escalate', () => {
      const signals = detectBurnoutSignals({
        totalHours: 120,
        overtimeHours: 2,
        consecutiveNightShifts: NIGHT_SHIFT_STREAK_CAUTION,
        nightShiftCount: NIGHT_SHIFT_STREAK_CAUTION,
        weekendShiftCount: 1,
        ptoDaysTaken: 3,
        windowDays: 30,
        avgHoursPerWeek: 40,
      });
      expect(signals.some((s) => s.code === 'NIGHT_SHIFT_STREAK' && s.severity === 'medium')).toBe(true);
      expect(signals.some((s) => s.code === 'EXTENDED_NIGHT_SHIFT_STREAK')).toBe(false);
    });

    it('emits LOW_PTO_UTILIZATION for a 30-day window with zero PTO', () => {
      const signals = detectBurnoutSignals({
        totalHours: 140,
        overtimeHours: 4,
        consecutiveNightShifts: 0,
        nightShiftCount: 0,
        weekendShiftCount: 1,
        ptoDaysTaken: 0,
        windowDays: 30,
        avgHoursPerWeek: 35,
      });
      expect(signals.some((s) => s.code === 'LOW_PTO_UTILIZATION')).toBe(true);
    });

    it('emits NO_SHIFT_DATA when totalHours === 0 AND nightShiftCount === 0', () => {
      const signals = detectBurnoutSignals({
        totalHours: 0,
        overtimeHours: 0,
        consecutiveNightShifts: 0,
        nightShiftCount: 0,
        weekendShiftCount: 0,
        ptoDaysTaken: 0,
        windowDays: 30,
        avgHoursPerWeek: 0,
      });
      expect(signals.length).toBe(1);
      expect(signals[0].code).toBe('NO_SHIFT_DATA');
    });

    it('returns no signals for a well-balanced worker', () => {
      const signals = detectBurnoutSignals({
        totalHours: 160,
        overtimeHours: 8, // 5% overtime — well under the 25% threshold
        consecutiveNightShifts: 1,
        nightShiftCount: 2,
        weekendShiftCount: 2,
        ptoDaysTaken: 3,
        windowDays: 30,
        avgHoursPerWeek: 40,
      });
      expect(signals.length).toBe(0);
    });

    it('emits SIGNIFICANT_OVERTIME when overtime ratio exceeds 25%', () => {
      const signals = detectBurnoutSignals({
        totalHours: 160,
        overtimeHours: 50, // ~31% overtime
        consecutiveNightShifts: 0,
        nightShiftCount: 0,
        weekendShiftCount: 1,
        ptoDaysTaken: 3,
        windowDays: 30,
        avgHoursPerWeek: 40,
      });
      expect(signals.some((s) => s.code === 'SIGNIFICANT_OVERTIME' && s.severity === 'medium')).toBe(true);
    });

    it('emits WEEKEND_HEAVY when weekendShiftCount exceeds 4', () => {
      const signals = detectBurnoutSignals({
        totalHours: 160,
        overtimeHours: 4,
        consecutiveNightShifts: 0,
        nightShiftCount: 0,
        weekendShiftCount: 5,
        ptoDaysTaken: 3,
        windowDays: 30,
        avgHoursPerWeek: 40,
      });
      expect(signals.some((s) => s.code === 'WEEKEND_HEAVY' && s.severity === 'low')).toBe(true);
    });
  });

  describe('computeBurnoutRiskScore', () => {
    it("returns 'insufficient_data' when the only signal is NO_SHIFT_DATA", () => {
      const result = computeBurnoutRiskScore([
        { code: 'NO_SHIFT_DATA', severity: 'medium', description: '', recommendation: '' },
      ]);
      expect(result.risk_band).toBe('insufficient_data');
      expect(result.risk_score).toBe(0);
      expect(result.recommended_actions.some((a) => /shift records/i.test(a))).toBe(true);
    });

    it("returns 'low' band + score 0 when no signals are present", () => {
      const result = computeBurnoutRiskScore([]);
      expect(result.risk_band).toBe('low');
      expect(result.risk_score).toBe(0);
    });

    it("returns 'critical' when multiple high-severity signals are present", () => {
      // 3 high-severity signals × 22 = 66 → critical (>= 60 threshold).
      const result = computeBurnoutRiskScore([
        { code: 'HIGH_WEEKLY_HOURS', severity: 'high', description: '', recommendation: '' },
        { code: 'EXTENDED_NIGHT_SHIFT_STREAK', severity: 'high', description: '', recommendation: '' },
        { code: 'SIGNIFICANT_OVERTIME', severity: 'high', description: '', recommendation: '' },
      ]);
      expect(result.risk_band).toBe('critical');
      expect(result.risk_score).toBeGreaterThanOrEqual(60);
    });

    it("returns 'high' when two high-severity signals are present", () => {
      // 2 high-severity signals × 22 = 44 → high band (>= 35 threshold).
      const result = computeBurnoutRiskScore([
        { code: 'HIGH_WEEKLY_HOURS', severity: 'high', description: '', recommendation: '' },
        { code: 'EXTENDED_NIGHT_SHIFT_STREAK', severity: 'high', description: '', recommendation: '' },
      ]);
      expect(result.risk_band).toBe('high');
      expect(result.risk_score).toBeGreaterThanOrEqual(35);
    });

    it('always appends the privacy reminder to recommended_actions', () => {
      const result = computeBurnoutRiskScore([
        { code: 'SIGNIFICANT_OVERTIME', severity: 'medium', description: '', recommendation: '' },
      ]);
      const last = result.recommended_actions[result.recommended_actions.length - 1];
      expect(last).toMatch(/workload risk signal only/i);
      expect(last).toMatch(/not a performance or disciplinary tool/i);
    });

    it('clamps the risk score to the 0-100 range', () => {
      const result = computeBurnoutRiskScore([
        { code: 'HIGH_WEEKLY_HOURS', severity: 'critical' },
        { code: 'EXTENDED_NIGHT_SHIFT_STREAK', severity: 'critical' },
        { code: 'SIGNIFICANT_OVERTIME', severity: 'critical' },
        { code: 'LOW_PTO_UTILIZATION', severity: 'critical' },
      ]);
      expect(result.risk_score).toBeLessThanOrEqual(100);
      expect(result.risk_score).toBeGreaterThanOrEqual(0);
    });

    it('produces moderate band for a single medium signal and keeps suggestions deduped', () => {
      const result = computeBurnoutRiskScore([
        { code: 'NIGHT_SHIFT_STREAK', severity: 'medium' },
        { code: 'NIGHT_SHIFT_STREAK', severity: 'medium' },
      ]);
      // Score from two medium signals = 24 → moderate band (>= 15).
      expect(result.risk_band).toBe('moderate');
      // The dedupe in recommended_actions should not repeat the same action string.
      const recCount = result.recommended_actions.filter(
        (a) => a === 'Monitor for fatigue; consider rotating off nights.'
      ).length;
      expect(recCount).toBe(1);
    });
  });
});
