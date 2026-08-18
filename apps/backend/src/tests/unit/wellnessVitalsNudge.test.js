/**
 * computeHealthInsights — the vitals-logging nudge.
 *
 * The nudge is driven by `last_at_epoch_ms`, the absolute-instant twin of
 * `MAX(recorded_at)`, not by the driver-materialised `last_at` (PR #881).
 * wellnessService had no unit tests at all, so this branch was never exercised:
 * `epochMsOrNull(undefined)` is null, and a dropped twin therefore tells every
 * patient with a full vitals history to "log your first vitals".
 *
 * NULL here is legitimate — MAX() over no rows — which is exactly why the read
 * uses the permissive shape. Both sides of that are pinned below.
 */

import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const { computeHealthInsights } = await import('../../services/gamification/wellnessService.js');

const USER_UID = '11111111-1111-4111-8111-111111111111';
const DAY_MS = 24 * 3600 * 1000;

beforeEach(() => {
  queryRawUnsafe.mockReset();
});

/**
 * computeHealthInsights issues five reads in a fixed order; only the second
 * carries the twin under test. `daysAgo: null` models a patient with no vitals
 * at all, where MAX(recorded_at) is a genuine SQL NULL.
 */
function mockInsightRun({ daysAgo }) {
  let lastVitals = [{ last_at: null, last_at_epoch_ms: null }];
  if (daysAgo != null) {
    const at = new Date(Date.now() - daysAgo * DAY_MS);
    lastVitals = [{ last_at: at.toISOString(), last_at_epoch_ms: BigInt(at.getTime()) }];
  }
  queryRawUnsafe
    .mockResolvedValueOnce([])                  // expiring prescriptions
    .mockResolvedValueOnce(lastVitals)          // MAX(recorded_at) + twin
    .mockResolvedValueOnce([])                  // appointment adherence
    .mockResolvedValueOnce([{ days: 0 }])       // check-in streak
    .mockResolvedValueOnce([]);                 // recent blood sugars
}

const typesOf = (insights) => insights.map((i) => i.type);

test('a patient who has not logged vitals for 7 days gets the nudge, with the real gap', async () => {
  mockInsightRun({ daysAgo: 7 });

  const insights = await computeHealthInsights(USER_UID, 10);

  expect(typesOf(insights)).toContain('vitals_nudge');
  const nudge = insights.find((i) => i.type === 'vitals_nudge');
  // The day count is the twin's whole job — a dropped twin cannot produce it.
  expect(nudge.title).toBe("It's been 7 days since you logged vitals");
  expect(typesOf(insights)).not.toContain('log_first_vitals');
});

test('a patient who logged vitals two days ago is left alone', async () => {
  mockInsightRun({ daysAgo: 2 });

  const insights = await computeHealthInsights(USER_UID, 10);

  expect(typesOf(insights)).not.toContain('vitals_nudge');
  expect(typesOf(insights)).not.toContain('log_first_vitals');
});

test('the nudge fires exactly on the fifth day, not the fourth', async () => {
  mockInsightRun({ daysAgo: 4 });
  expect(typesOf(await computeHealthInsights(USER_UID, 10))).not.toContain('vitals_nudge');

  queryRawUnsafe.mockReset();
  mockInsightRun({ daysAgo: 5 });
  expect(typesOf(await computeHealthInsights(USER_UID, 10))).toContain('vitals_nudge');
});

test('a patient with no vitals at all is asked to log their first', async () => {
  // MAX() over zero rows is a genuine SQL NULL, not an absent twin.
  mockInsightRun({ daysAgo: null });

  const insights = await computeHealthInsights(USER_UID, 10);

  expect(typesOf(insights)).toContain('log_first_vitals');
  expect(typesOf(insights)).not.toContain('vitals_nudge');
});
