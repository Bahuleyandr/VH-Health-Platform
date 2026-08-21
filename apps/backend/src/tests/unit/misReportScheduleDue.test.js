// Due-schedule computation for MIS report email delivery (migration 679).
//
// localClock + computeDueOccurrence are the pure core of the hourly dispatch
// sweep: wall-clock evaluation in the tenant's IANA timezone, cadence-day
// matching, at-or-after-send-hour catch-up, and the lastOccurrenceKey fence
// that makes an occurrence single-shot.

import {
  computeDueOccurrence,
  localClock,
  listMisReportCatalog,
  MIS_REPORT_DEFINITIONS,
} from '../../services/dashboards/misReportScheduleService.js';

const IST = 'Asia/Kolkata';

function schedule(overrides = {}) {
  return {
    enabled: true,
    cadence: 'daily',
    sendHour: 7,
    sendWeekday: null,
    sendDayOfMonth: null,
    lastOccurrenceKey: null,
    ...overrides,
  };
}

describe('localClock', () => {
  it('converts UTC into tenant-local wall-clock parts (IST +05:30)', () => {
    // 2026-08-16T01:30Z = 2026-08-16 07:00 IST (a Sunday).
    const clock = localClock(new Date('2026-08-16T01:30:00Z'), IST);
    expect(clock).toEqual({ date: '2026-08-16', hour: 7, weekday: 0, dayOfMonth: 16 });
  });

  it('crosses the date boundary with the timezone, not UTC', () => {
    // 18:31Z on the 15th is already 00:01 on the 16th in IST.
    const clock = localClock(new Date('2026-08-15T18:31:00Z'), IST);
    expect(clock.date).toBe('2026-08-16');
    expect(clock.hour).toBe(0);
  });

  it('handles a non-IST timezone', () => {
    const clock = localClock(new Date('2026-08-16T01:30:00Z'), 'America/New_York');
    // 2026-08-15 21:30 EDT (a Saturday).
    expect(clock).toEqual({ date: '2026-08-15', hour: 21, weekday: 6, dayOfMonth: 15 });
  });
});

describe('computeDueOccurrence', () => {
  const sundayMorning = localClock(new Date('2026-08-16T01:30:00Z'), IST); // 07:00 Sun 16th

  it('daily: due at the send hour', () => {
    expect(computeDueOccurrence(schedule({ sendHour: 7 }), sundayMorning)).toBe('2026-08-16');
  });

  it('daily: not due before the send hour', () => {
    expect(computeDueOccurrence(schedule({ sendHour: 8 }), sundayMorning)).toBeNull();
  });

  it('daily: still due after the send hour (same-day catch-up)', () => {
    const evening = localClock(new Date('2026-08-16T13:30:00Z'), IST); // 19:00 IST
    expect(computeDueOccurrence(schedule({ sendHour: 7 }), evening)).toBe('2026-08-16');
  });

  it('disabled schedules are never due', () => {
    expect(computeDueOccurrence(schedule({ enabled: false }), sundayMorning)).toBeNull();
  });

  it('an already-claimed occurrence is fenced by lastOccurrenceKey', () => {
    expect(
      computeDueOccurrence(schedule({ lastOccurrenceKey: '2026-08-16' }), sundayMorning),
    ).toBeNull();
  });

  it('a prior occurrence key does not fence a new day', () => {
    expect(
      computeDueOccurrence(schedule({ lastOccurrenceKey: '2026-08-15' }), sundayMorning),
    ).toBe('2026-08-16');
  });

  it('weekly: due only on the configured weekday', () => {
    const weekly = schedule({ cadence: 'weekly', sendWeekday: 0 }); // Sunday
    expect(computeDueOccurrence(weekly, sundayMorning)).toBe('2026-08-16');
    const monday = localClock(new Date('2026-08-17T01:30:00Z'), IST);
    expect(computeDueOccurrence(weekly, monday)).toBeNull();
  });

  it('monthly: due only on the configured day of month', () => {
    const monthly = schedule({ cadence: 'monthly', sendDayOfMonth: 16 });
    expect(computeDueOccurrence(monthly, sundayMorning)).toBe('2026-08-16');
    const seventeenth = localClock(new Date('2026-08-17T01:30:00Z'), IST);
    expect(computeDueOccurrence(monthly, seventeenth)).toBeNull();
  });
});

describe('report catalog', () => {
  it('exposes every pinned report key with a title and fetcher', () => {
    const catalog = listMisReportCatalog();
    expect(catalog.map((entry) => entry.key).sort()).toEqual([
      'daily-ops',
      'doctor-productivity-30d',
      'ip-occupancy',
      'lab-tat',
      'opd-daily',
      'payer-mix-monthly',
      'teleconsult-ops',
    ]);
    for (const entry of catalog) {
      expect(entry.title).toBeTruthy();
      expect(typeof MIS_REPORT_DEFINITIONS[entry.key].fetch).toBe('function');
    }
  });
});
