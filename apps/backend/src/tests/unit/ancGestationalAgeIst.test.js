// Unit test for the P2 finding: ANC uses UTC not IST for visit-number/GA.
//
// Gestational age and the ANC schedule are calendar-day computations. They
// defaulted "today" to a UTC instant (new Date()), so the day only rolled at
// UTC midnight = 05:30 IST — between IST midnight and 05:30 the GA read one
// day behind the clinic's (IST) calendar. The default now anchors to the IST
// date. Pure functions — no DB.

import { jest } from '@jest/globals';
import {
  computeGestationalAge,
  computeAncScheduleMilestones,
  istDateString,
} from '../../services/maternity/maternityService.js';

describe('ANC gestational age / schedule use IST not UTC', () => {
  it('istDateString rolls to the next IST day for late-UTC instants', () => {
    // 20:00Z → 01:30 IST next day.
    expect(istDateString(new Date('2026-05-21T20:00:00Z'))).toBe('2026-05-22');
    // 10:00Z → 15:30 IST same day.
    expect(istDateString(new Date('2026-05-21T10:00:00Z'))).toBe('2026-05-21');
    // 18:31Z → 00:01 IST next day (just past IST midnight).
    expect(istDateString(new Date('2026-05-21T18:31:00Z'))).toBe('2026-05-22');
  });

  it('computeGestationalAge with explicit onDate is an exact calendar diff', () => {
    const ga = computeGestationalAge('2026-01-01', '2026-05-22');
    expect(ga.total_days).toBe(141); // Jan1 → May22
    expect(ga.weeks).toBe(20);
    expect(ga.days).toBe(1);
    expect(ga.label).toBe('GA 20+1');
  });

  describe('default "today" anchors to IST (early-IST-morning window)', () => {
    afterEach(() => jest.useRealTimers());

    it('GA reflects the IST calendar date, not the lagging UTC date', () => {
      // 2026-05-21T20:00:00Z = 2026-05-22 01:30 IST. The UTC date is still
      // 05-21 (140 days from LMP); the IST date is 05-22 (141 days).
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-21T20:00:00Z'));

      const ga = computeGestationalAge('2026-01-01'); // no onDate → default
      expect(ga.total_days).toBe(141); // IST date, not the UTC 140
      expect(ga.label).toBe('GA 20+1');

      // Schedule milestones derive from the same GA — the 20-week milestone
      // is now "current"/"past", consistent with the IST calendar.
      const milestones = computeAncScheduleMilestones('2026-01-01');
      const wk20 = milestones.find((m) => m.ga_weeks === 20);
      expect(wk20).toBeTruthy();
      expect(['current', 'past']).toContain(wk20.status);
    });
  });
});
