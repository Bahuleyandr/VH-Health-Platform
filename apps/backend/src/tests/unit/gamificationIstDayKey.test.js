/**
 * P7 fix (2026-08-18): the gamification/check-in/step "day" is the IST
 * (Asia/Kolkata) calendar day, not the UTC day. The old UTC keying put the
 * day boundary at 05:30 IST: a patient who checked in at 23:00 IST could not
 * check in again before 05:30 the next morning, and a 05:00 IST check-in
 * counted toward the PREVIOUS day — silently breaking streaks.
 *
 * These tests pin the two boundary cases the bug lived in:
 *   - 23:00 IST (17:30 UTC — UTC and IST agree on the date)
 *   - 05:00 IST (23:30 UTC of the PREVIOUS UTC date — the divergence window)
 * for hasCheckedInToday's key derivation and getCheckInStreak's day walk.
 */

import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const { hasCheckedInToday, getCheckInStreak } =
  await import('../../services/gamification/wellnessService.js');
const { istDateString } = await import('../../utils/dateUtils.js');

const USER_UID = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  jest.useRealTimers();
  queryRawUnsafe.mockReset();
});

function freezeAt(iso) {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.setSystemTime(new Date(iso));
}

describe('istDateString boundary behavior (the P7 day key)', () => {
  it('23:00 IST stays on the same calendar day as UTC', () => {
    // 2026-08-18T23:00 IST == 2026-08-18T17:30Z
    expect(istDateString(new Date('2026-08-18T17:30:00Z'))).toBe('2026-08-18');
  });

  it('05:00 IST is the NEXT calendar day relative to the UTC date', () => {
    // 2026-08-19T05:00 IST == 2026-08-18T23:30Z — the UTC key would have said
    // 2026-08-18 and filed the check-in on the previous day.
    expect(istDateString(new Date('2026-08-18T23:30:00Z'))).toBe('2026-08-19');
  });

  it('the old 05:30 IST boundary is exactly the IST midnight', () => {
    expect(istDateString(new Date('2026-08-18T18:29:59Z'))).toBe('2026-08-18'); // 23:59:59 IST
    expect(istDateString(new Date('2026-08-18T18:30:00Z'))).toBe('2026-08-19'); // 00:00:00 IST
  });
});

describe('hasCheckedInToday keys the ledger lookup on the IST day', () => {
  it.each([
    // [frozen instant, expected IST day key, label]
    ['2026-08-18T17:30:00Z', '2026-08-18', '23:00 IST'],
    ['2026-08-18T23:30:00Z', '2026-08-19', '05:00 IST (UTC date is still the 18th)'],
  ])('at %s queries with day %s (%s)', async (instant, expectedDay) => {
    freezeAt(instant);
    queryRawUnsafe.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(hasCheckedInToday(USER_UID)).resolves.toBe(true);

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [, uidArg, dayArg] = queryRawUnsafe.mock.calls[0];
    expect(uidArg).toBe(USER_UID);
    expect(dayArg).toBe(expectedDay);
  });
});

describe('getCheckInStreak walks consecutive IST days', () => {
  it('at 05:00 IST an evening-before check-in still continues the streak', async () => {
    // Now: 2026-08-19T05:00 IST (2026-08-18T23:30Z). Ledger holds IST-keyed
    // check-ins for the 19th (today, done at 00:30 IST), 18th, and 17th.
    freezeAt('2026-08-18T23:30:00Z');
    queryRawUnsafe.mockResolvedValueOnce([
      { day: '2026-08-19' },
      { day: '2026-08-18' },
      { day: '2026-08-17' },
    ]);

    await expect(getCheckInStreak(USER_UID)).resolves.toBe(3);
  });

  it('at 23:00 IST the walk starts from the same IST day', async () => {
    freezeAt('2026-08-18T17:30:00Z'); // 23:00 IST on the 18th
    queryRawUnsafe.mockResolvedValueOnce([
      { day: '2026-08-18' },
      { day: '2026-08-17' },
    ]);

    await expect(getCheckInStreak(USER_UID)).resolves.toBe(2);
  });

  it('a real gap still breaks the streak', async () => {
    freezeAt('2026-08-18T17:30:00Z'); // 23:00 IST on the 18th
    queryRawUnsafe.mockResolvedValueOnce([
      { day: '2026-08-18' },
      { day: '2026-08-16' }, // 17th missing
    ]);

    await expect(getCheckInStreak(USER_UID)).resolves.toBe(1);
  });

  it('no rows means no streak', async () => {
    freezeAt('2026-08-18T23:30:00Z');
    queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(getCheckInStreak(USER_UID)).resolves.toBe(0);
  });
});
