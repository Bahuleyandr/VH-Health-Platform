// apps/backend/src/tests/unit/bloodborneMarkerService.test.js
//
// The rules live in bloodborneMarkerRules.js so these cases run without a
// database: importing the service itself would pull in prisma.
import {
  CORE_MARKERS,
  DEFAULT_VALIDITY_DAYS,
  computeReuseStatus,
  normalizeSerologyValue,
  __clearExposureHandlersForTests,
  notifyExposureHandlers,
  registerExposureHandler,
} from '../../services/clinical/bloodborneMarkerRules.js';

const AS_OF = new Date('2026-09-04T10:00:00.000Z');
const day = (n) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString().slice(0, 10);

function row(marker, result, daysAgo, extra = {}) {
  return {
    id: extra.id ?? Math.floor(Math.random() * 1e6),
    marker,
    marker_label: extra.marker_label ?? null,
    result,
    tested_on: day(daysAgo),
    source: extra.source ?? 'lab_result',
    voided_at: extra.voided_at ?? null,
  };
}

describe('normalizeSerologyValue', () => {
  test.each([
    ['Reactive', 'reactive'], ['POSITIVE', 'reactive'], ['Detected', 'reactive'],
    ['Weakly reactive', 'reactive'], ['reactive (repeat)', 'reactive'],
    ['Non-reactive', 'non_reactive'], ['nonreactive', 'non_reactive'],
    ['Non Reactive', 'non_reactive'], ['Negative', 'non_reactive'], ['Not detected', 'non_reactive'],
    ['non_reactive', 'non_reactive'],
    ['Indeterminate', 'indeterminate'], ['equivocal', 'indeterminate'],
    ['Borderline', 'indeterminate'], ['grey zone', 'indeterminate'], ['Gray Zone', 'indeterminate'],
    ['pending', 'pending'], ['Awaited', 'pending'], ['', 'pending'], [null, 'pending'], [undefined, 'pending'],
    ['1.23', 'indeterminate'], ['see comment', 'indeterminate'],
    ['result pending', 'pending'], ['Report pending', 'pending'],
    ['Reactive - not detected on repeat', 'indeterminate'],
    ['Reactive; negative on repeat dilution', 'indeterminate'],
    ['HIV: Non-reactive, HBsAg: Reactive, HCV: Non-reactive', 'indeterminate'],
    ['NON REACTIVE (repeat)', 'non_reactive'], ['REACTIVE*', 'reactive'], ['Non reactive.', 'non_reactive'],
    ['Positive (confirm)', 'reactive'], ['Indeterminate - repeat', 'indeterminate'],
    ['NEG', 'indeterminate'], ['NR', 'indeterminate'], ['+', 'indeterminate'],
  ])('%p -> %s', (input, expected) => {
    expect(normalizeSerologyValue(input)).toBe(expected);
  });
});

describe('computeReuseStatus', () => {
  test('defaults: 90-day window, core markers are hiv/hbsag/hcv', () => {
    expect(DEFAULT_VALIDITY_DAYS).toBe(90);
    expect(CORE_MARKERS).toEqual(['hiv', 'hbsag', 'hcv']);
  });

  test('no rows -> unknown, naming every core marker as not on record', () => {
    const out = computeReuseStatus([], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual([
      'HIV not on record', 'HBsAg not on record', 'HCV not on record',
    ]);
    expect(out.markers).toEqual([]);
    expect(out.validity_days).toBe(90);
  });

  test('all three core markers non-reactive within window -> clear', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 20), row('hcv', 'non_reactive', 89),
    ], { asOf: AS_OF });
    expect(out.status).toBe('clear');
    expect(out.markers.map((m) => m.within_window)).toEqual([true, true, true]);
  });

  test('a stale non-reactive core marker -> unknown, reason names the age', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 20), row('hcv', 'non_reactive', 91),
    ], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual([`HCV result older than 90 days (${day(91)})`]);
  });

  test('any reactive core marker -> restricted, even outside the window', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'reactive', 400), row('hcv', 'non_reactive', 5),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HBsAg reactive ${day(400)}`]);
  });

  test('pending or indeterminate core marker -> unknown with a specific reason', () => {
    const out = computeReuseStatus([
      row('hiv', 'pending', 1), row('hbsag', 'non_reactive', 2), row('hcv', 'indeterminate', 3),
    ], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual(['HIV pending', 'HCV indeterminate']);
  });

  test('cjd_suspected reactive -> restricted regardless of age or other markers', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 1), row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
      row('cjd_suspected', 'reactive', 2000),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`CJD suspected ${day(2000)}`]);
  });

  test('other marker reactive within window -> restricted with its label', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 1), row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
      row('other', 'reactive', 3, { marker_label: 'HTLV-1' }),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HTLV-1 reactive ${day(3)}`]);
  });

  test('a reactive row latches even when a later non-reactive exists; voided reactive rows do not count', () => {
    const rows = [
      row('hbsag', 'reactive', 30, { id: 1 }),
      row('hbsag', 'non_reactive', 5, { id: 2 }),
      row('hiv', 'non_reactive', 5, { id: 3 }),
      row('hcv', 'reactive', 5, { id: 4, voided_at: '2026-09-01T00:00:00.000Z' }),
      row('hcv', 'non_reactive', 5, { id: 5 }),
    ];
    const out = computeReuseStatus(rows, { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HBsAg reactive ${day(30)}`]);

    const voided = computeReuseStatus([
      { ...rows[0], voided_at: '2026-09-02T00:00:00.000Z' }, ...rows.slice(1),
    ], { asOf: AS_OF });
    expect(voided.status).toBe('clear');
  });

  test('a custom validity window is honoured', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 10), row('hcv', 'non_reactive', 10),
    ], { asOf: AS_OF, validityDays: 7 });
    expect(out.status).toBe('unknown');
    expect(out.validity_days).toBe(7);
  });

  test('same tested_on: the higher id wins for the non-reactive/pending decision', () => {
    const out = computeReuseStatus([
      row('hiv', 'pending', 5, { id: 10 }),
      row('hiv', 'non_reactive', 5, { id: 9 }),
      row('hbsag', 'non_reactive', 5, { id: 11 }), row('hcv', 'non_reactive', 5, { id: 12 }),
    ], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual(['HIV pending']);
  });

  test('a reactive HIV followed by a later non-reactive still restricts (latching)', () => {
    const out = computeReuseStatus([
      row('hiv', 'reactive', 240, { id: 1 }), row('hiv', 'non_reactive', 3, { id: 2 }),
      row('hbsag', 'non_reactive', 3), row('hcv', 'non_reactive', 3),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HIV reactive ${day(240)}`]);
  });

  test('unknown never comes back with an empty reasons list', () => {
    const out = computeReuseStatus([
      row('hiv', 'REACTIVE', 1), row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
    ], { asOf: AS_OF });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual(['HIV result cannot be interpreted']);
    const undated = computeReuseStatus([
      { ...row('hiv', 'non_reactive', 1), tested_on: 'garbage' }, row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
    ], { asOf: AS_OF });
    expect(undated.status).toBe('unknown');
    expect(undated.reasons).toEqual(['HIV result date cannot be read']);
  });

  test('a null or absurd validity window falls back to 90 days', () => {
    const rows = [row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 10), row('hcv', 'non_reactive', 10)];
    expect(computeReuseStatus(rows, { asOf: AS_OF, validityDays: null }).validity_days).toBe(90);
    expect(computeReuseStatus(rows, { asOf: AS_OF, validityDays: 0 }).validity_days).toBe(90);
    expect(computeReuseStatus(rows, { asOf: AS_OF, validityDays: 'x' }).validity_days).toBe(90);
  });

  test('null rows resolve to unknown instead of throwing', () => {
    expect(computeReuseStatus(null, { asOf: AS_OF }).status).toBe('unknown');
  });

  test('ages are counted in Asia/Kolkata calendar days', () => {
    // 2026-09-03T20:30Z is 02:00 on 2026-09-04 in IST: a result dated
    // 2026-06-05 is 91 IST days old, so it is outside a 90-day window.
    const lateNightUtc = new Date('2026-09-03T20:30:00.000Z');
    const rows = [
      { ...row('hiv', 'non_reactive', 0), tested_on: '2026-06-05' },
      { ...row('hbsag', 'non_reactive', 0), tested_on: '2026-09-01' },
      { ...row('hcv', 'non_reactive', 0), tested_on: '2026-09-01' },
    ];
    const out = computeReuseStatus(rows, { asOf: lateNightUtc });
    expect(out.status).toBe('unknown');
    expect(out.reasons).toEqual(['HIV result older than 90 days (2026-06-05)']);
    expect(out.markers.find((m) => m.marker === 'hiv').age_days).toBe(91);
  });

  test('markers are listed in a stable order and other-labels are trimmed into one key', () => {
    const out = computeReuseStatus([
      row('other', 'non_reactive', 1, { id: 1, marker_label: 'HTLV-1 ' }),
      row('other', 'non_reactive', 2, { id: 2, marker_label: 'htlv-1' }),
      row('hcv', 'non_reactive', 1, { id: 3 }), row('hiv', 'non_reactive', 1, { id: 4 }), row('hbsag', 'non_reactive', 1, { id: 5 }),
    ], { asOf: AS_OF });
    expect(out.markers.map((m) => m.marker)).toEqual(['hiv', 'hbsag', 'hcv', 'other']);
    expect(out.markers[3].label).toBe('HTLV-1');
  });
});

describe('exposure handlers', () => {
  afterEach(() => __clearExposureHandlersForTests());

  test('handlers are awaited in registration order for every event; a throwing handler does not stop the others', async () => {
    const seen = [];
    registerExposureHandler(async (event) => {
      await new Promise((resolve) => setImmediate(resolve));
      seen.push(`a:${event.marker}`);
    });
    registerExposureHandler(async () => { throw new Error('boom'); });
    registerExposureHandler(async (event) => { seen.push(`c:${event.marker}`); });
    await notifyExposureHandlers([{ marker: 'hiv' }, { marker: 'hcv' }]);
    expect(seen).toEqual(['a:hiv', 'c:hiv', 'a:hcv', 'c:hcv']);
  });

  test('a non-function handler is rejected at registration', () => {
    expect(() => registerExposureHandler('nope')).toThrow(TypeError);
  });

  test('unregister removes a handler', async () => {
    const seen = [];
    const off = registerExposureHandler(async (event) => { seen.push(event.marker); });
    off();
    await notifyExposureHandlers([{ marker: 'hiv' }]);
    expect(seen).toEqual([]);
  });
});
