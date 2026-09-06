/**
 * The calendar-date rail (src/utils/calendarDate.js).
 *
 * Every assertion here is a FIXED instant, never "now": the defect this rail
 * exists to remove is only reachable for 5h30m of each day (18:30Z-24:00Z on
 * Asia/Kolkata), so a suite dated from the clock would pass three quarters of
 * the time on code that is wrong all of it.
 */

import {
  FACILITY_CALENDAR_ZONE,
  calendarDateIso,
  calendarDateMs,
  calendarDayOf,
  calendarDayStartMs,
  calendarDaysSince,
  calendarDaysUntil,
} from '../../utils/calendarDate.js';

// 01:35 IST on the 6th, which is 20:05Z on the 5th: inside the window where UTC
// and the ward disagree about what day it is. This instant is the whole point.
const NIGHT_SHIFT = new Date('2026-09-05T20:05:00.000Z');
// IST midnight of 2026-09-06 is 18:30Z on the 5th.
const SEP_6_IST_MIDNIGHT = Date.parse('2026-09-05T18:30:00.000Z');

describe('calendarDateIso — both shapes of the same column', () => {
  it('reads the driver-materialised Date in UTC, not in the process zone', () => {
    // `SELECT '2026-09-06'::date` arrives as this Date. Reading it with
    // getFullYear()/getDate() would answer the 5th or the 6th depending on
    // where the server happens to be.
    expect(calendarDateIso(new Date('2026-09-06T00:00:00.000Z'))).toBe('2026-09-06');
  });

  it('reads the plain string a body or a ::text cast carries', () => {
    expect(calendarDateIso('2026-09-06')).toBe('2026-09-06');
    expect(calendarDateIso('2026-09-06T11:22:33.000Z')).toBe('2026-09-06');
  });

  it('answers empty for anything that names no day', () => {
    for (const value of [null, undefined, '', 'not a date', new Date(NaN)]) {
      expect(calendarDateIso(value)).toBe('');
    }
  });
});

describe('calendarDateMs — a DATE is the ward day, not UTC midnight', () => {
  it('resolves the day to midnight in the facility zone', () => {
    expect(calendarDateMs('2026-09-06')).toBe(SEP_6_IST_MIDNIGHT);
    expect(calendarDateMs(new Date('2026-09-06T00:00:00.000Z'))).toBe(SEP_6_IST_MIDNIGHT);
  });

  it('is the same answer whichever shape the column arrived in', () => {
    expect(calendarDateMs(new Date('2026-09-06T00:00:00.000Z')))
      .toBe(calendarDateMs('2026-09-06'));
  });

  it('is 5h30m away from the UTC midnight the driver handed over', () => {
    // The defect, stated as arithmetic: reading the driver's Date as an instant
    // puts the start of the ward's day five and a half hours late.
    expect(Date.parse('2026-09-06T00:00:00.000Z') - calendarDateMs('2026-09-06'))
      .toBe(5.5 * 60 * 60 * 1000);
  });

  it('returns NaN, never 0, for a missing or impossible day', () => {
    // 0 is finite and reads as 1970 — "long ago" — which silently expires
    // everything with a NULL date. That is the trap dbInstant.js names too.
    for (const value of [null, undefined, '', 'nope', '2026-02-31', '2026-13-01']) {
      expect(calendarDateMs(value)).toBeNaN();
    }
  });

  it('honours a zone argument, which is the multi-region seam', () => {
    expect(calendarDateMs('2026-09-06', 'UTC')).toBe(Date.parse('2026-09-06T00:00:00.000Z'));
    expect(calendarDateMs('2026-09-06', 'America/New_York'))
      .toBe(Date.parse('2026-09-06T04:00:00.000Z'));
    // A DST zone gets the offset in force on THAT day, not a frozen one:
    // New York is UTC-5 in January and UTC-4 in September.
    expect(calendarDateMs('2026-01-06', 'America/New_York'))
      .toBe(Date.parse('2026-01-06T05:00:00.000Z'));
  });

  it('defaults to the facility zone', () => {
    expect(calendarDateMs('2026-09-06')).toBe(calendarDateMs('2026-09-06', FACILITY_CALENDAR_ZONE));
  });
});

describe('calendarDayOf / calendarDayStartMs — the clock, reduced to a day', () => {
  it('answers the WARD day, which is already tomorrow by UTC reckoning', () => {
    expect(calendarDayOf(NIGHT_SHIFT)).toBe('2026-09-06');
    expect(NIGHT_SHIFT.toISOString().slice(0, 10)).toBe('2026-09-05');
  });

  it('starts the ward day at 18:30Z the evening before', () => {
    expect(calendarDayStartMs(NIGHT_SHIFT)).toBe(SEP_6_IST_MIDNIGHT);
  });

  it('is NaN for an unusable instant rather than some default day', () => {
    expect(calendarDayStartMs(new Date(NaN))).toBeNaN();
    expect(calendarDayOf(new Date(NaN))).toBe('');
  });
});

describe('the comparison the rail exists for', () => {
  const expired = (date, at) => {
    const day = calendarDateMs(date);
    const today = calendarDayStartMs(at);
    // The fail-CLOSED shape: absence denies.
    return !Number.isFinite(day) || day < today;
  };

  it('a date-of-today is not expired during the window UTC disagrees', () => {
    expect(expired('2026-09-06', NIGHT_SHIFT)).toBe(false);
    // ...and the naive comparison the rail replaces gets this wrong: UTC
    // midnight of the 6th (00:00Z) is AFTER the instant, so a reader that
    // compared the driver Date to the clock would call today's date FUTURE.
    expect(new Date('2026-09-06T00:00:00.000Z').getTime() > NIGHT_SHIFT.getTime()).toBe(true);
  });

  it('yesterday is expired, tomorrow is not', () => {
    expect(expired('2026-09-05', NIGHT_SHIFT)).toBe(true);
    expect(expired('2026-09-07', NIGHT_SHIFT)).toBe(false);
  });

  it('a missing date denies', () => {
    expect(expired(null, NIGHT_SHIFT)).toBe(true);
  });
});

describe('calendarDaysSince / calendarDaysUntil', () => {
  it('counts whole ward days, in both directions', () => {
    expect(calendarDaysSince('2026-09-01', NIGHT_SHIFT)).toBe(5);
    expect(calendarDaysSince('2026-09-06', NIGHT_SHIFT)).toBe(0);
    expect(calendarDaysSince('2026-09-08', NIGHT_SHIFT)).toBe(-2);
    expect(calendarDaysUntil('2026-09-08', NIGHT_SHIFT)).toBe(2);
  });

  it('does not depend on the time of day at either end', () => {
    const morning = new Date('2026-09-06T04:00:00.000Z'); // 09:30 IST, same ward day
    expect(calendarDaysSince('2026-09-01', morning))
      .toBe(calendarDaysSince('2026-09-01', NIGHT_SHIFT));
  });

  it('is NaN when either end names no day', () => {
    expect(calendarDaysSince(null, NIGHT_SHIFT)).toBeNaN();
    expect(calendarDaysUntil('2026-09-06', new Date(NaN))).toBeNaN();
  });

  it('crosses a DST boundary as whole days, not as 24-hour blocks', () => {
    // US DST ends 2026-11-01: the 1st is 25 hours long in New York, so a
    // millisecond subtraction would answer 1.04 days and floor to 1 by luck.
    // Both ends are reduced to days first, so the count is exact.
    expect(calendarDaysSince('2026-10-31', new Date('2026-11-02T12:00:00.000Z'), 'America/New_York'))
      .toBe(2);
  });
});
