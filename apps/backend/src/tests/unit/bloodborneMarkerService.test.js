// apps/backend/src/tests/unit/bloodborneMarkerService.test.js
import {
  CORE_MARKERS,
  DEFAULT_VALIDITY_DAYS,
  computeReuseStatus,
  normalizeSerologyValue,
  __clearExposureHandlersForTests,
  notifyExposureHandlers,
  registerExposureHandler,
} from '../../services/clinical/bloodborneMarkerService.js';

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
    expect(out.reasons).toEqual(['HCV result older than 90 days']);
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
    expect(out.reasons).toEqual(['CJD suspected']);
  });

  test('other marker reactive within window -> restricted with its label', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 1), row('hbsag', 'non_reactive', 1), row('hcv', 'non_reactive', 1),
      row('other', 'reactive', 3, { marker_label: 'HTLV-1' }),
    ], { asOf: AS_OF });
    expect(out.status).toBe('restricted');
    expect(out.reasons).toEqual([`HTLV-1 reactive ${day(3)}`]);
  });

  test('uses the latest row per marker by tested_on then id, and ignores voided rows', () => {
    const out = computeReuseStatus([
      row('hbsag', 'reactive', 30, { id: 1 }),
      row('hbsag', 'non_reactive', 5, { id: 2 }),
      row('hiv', 'non_reactive', 5, { id: 3 }),
      row('hcv', 'reactive', 5, { id: 4, voided_at: '2026-09-01T00:00:00.000Z' }),
      row('hcv', 'non_reactive', 5, { id: 5 }),
    ], { asOf: AS_OF });
    expect(out.status).toBe('clear');
  });

  test('a custom validity window is honoured', () => {
    const out = computeReuseStatus([
      row('hiv', 'non_reactive', 10), row('hbsag', 'non_reactive', 10), row('hcv', 'non_reactive', 10),
    ], { asOf: AS_OF, validityDays: 7 });
    expect(out.status).toBe('unknown');
    expect(out.validity_days).toBe(7);
  });
});

describe('exposure handlers', () => {
  afterEach(() => __clearExposureHandlersForTests());

  test('every registered handler receives every event; a throwing handler does not stop the others', async () => {
    const seen = [];
    registerExposureHandler(async (event) => { seen.push(`a:${event.marker}`); });
    registerExposureHandler(async () => { throw new Error('boom'); });
    registerExposureHandler(async (event) => { seen.push(`c:${event.marker}`); });
    await notifyExposureHandlers([{ marker: 'hiv' }, { marker: 'hcv' }]);
    expect(seen).toEqual(['a:hiv', 'c:hiv', 'a:hcv', 'c:hcv']);
  });

  test('unregister removes a handler', async () => {
    const seen = [];
    const off = registerExposureHandler(async (event) => { seen.push(event.marker); });
    off();
    await notifyExposureHandlers([{ marker: 'hiv' }]);
    expect(seen).toEqual([]);
  });
});
