/**
 * Ward downtime-pack OUTPUT probe.
 *
 * The `ward-downtime-packs` CronJob can complete successfully having produced
 * no packs at all: it calls `generateWardDowntimePacks()` with zero arguments,
 * which branches to the governed C3 sweep, and that sweep returns [] before
 * touching the database whenever `CLINICAL_CONTINUITY_PACKS_ENABLED` is not
 * "true" (it is unset in the ConfigMap and pinned "false" by the publication
 * component). The job exits 0, so a CronJob-liveness alert stays green forever
 * while no ward has anything to print.
 *
 * These tests pin the replacement signal: the probe must measure pack OUTPUT —
 * exists, fresh, non-empty — and must publish every series on every
 * observation, including the zeros, so the alert can never lose an arm at the
 * exact moment it is needed.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const {
  observeWardDowntimePackOutput,
  WARD_PACK_FRESHNESS_WINDOW_MINUTES,
} = await import('../../services/downtime/wardDowntimePackOutputProbe.js');
const {
  recordWardDowntimePackOutputObservation,
  serializeWardDowntimePackMetrics,
} = await import('../../observability/wardDowntimePackMetrics.js');

function sampleValue(text, metricName) {
  const line = text
    .split('\n')
    .find((entry) => entry.startsWith(`${metricName} `));
  return line === undefined ? undefined : Number(line.slice(metricName.length + 1));
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
});

describe('observeWardDowntimePackOutput — measures output, not job liveness', () => {
  it('reports every occupied ward as missing when generation produced nothing', async () => {
    // The live state this defect describes: wards are occupied, the CronJob
    // reported success, and not one pack exists.
    queryUnsafeMock
      .mockResolvedValueOnce([{ wards_expected: 6, wards_covered: 0 }])
      .mockResolvedValueOnce([
        { tenant_id: '00000000-0000-4000-8000-000000000001', ward_id: 7, ward_name: 'ICU-1' },
      ]);

    const result = await observeWardDowntimePackOutput();

    expect(result).toEqual({ wardsExpected: 6, wardsCovered: 0, wardsMissing: 6 });

    const text = serializeWardDowntimePackMetrics();
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_expected')).toBe(6);
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_covered')).toBe(0);
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_missing')).toBe(6);

    // The gap is named in the log, since the series deliberately carries no
    // tenant/ward labels.
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Ward downtime packs missing for 6 occupied ward(s)'),
      expect.objectContaining({
        wards_missing: 6,
        uncovered_sample: [
          expect.objectContaining({ ward_id: 7, ward_name: 'ICU-1' }),
        ],
      }),
    );
  });

  it('reports a partially covered deployment as partially missing', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ wards_expected: 4, wards_covered: 3 }])
      .mockResolvedValueOnce([]);

    await expect(observeWardDowntimePackOutput()).resolves.toEqual({
      wardsExpected: 4,
      wardsCovered: 3,
      wardsMissing: 1,
    });
    expect(sampleValue(serializeWardDowntimePackMetrics(), 'vhhealth_ward_downtime_pack_wards_missing'))
      .toBe(1);
  });

  it('publishes zeros — not silence — when every ward is covered', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ wards_expected: 4, wards_covered: 4 }]);

    await expect(observeWardDowntimePackOutput()).resolves.toEqual({
      wardsExpected: 4,
      wardsCovered: 4,
      wardsMissing: 0,
    });

    const text = serializeWardDowntimePackMetrics();
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_missing')).toBe(0);
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_expected')).toBe(4);
    // No uncovered-ward enumeration and no alarm when nothing is missing.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).not.toHaveBeenCalled();
  });

  it('publishes 0/0/0 for a deployment with no occupied beds', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ wards_expected: 0, wards_covered: 0 }]);

    await expect(observeWardDowntimePackOutput()).resolves.toEqual({
      wardsExpected: 0,
      wardsCovered: 0,
      wardsMissing: 0,
    });

    const text = serializeWardDowntimePackMetrics();
    // An empty hospital is provably healthy, not indistinguishable from an
    // unobserved one — every series is present.
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_expected')).toBe(0);
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_covered')).toBe(0);
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_wards_missing')).toBe(0);
    expect(sampleValue(text, 'vhhealth_ward_downtime_pack_observation_timestamp_seconds'))
      .toBeGreaterThan(0);
  });

  it.each([
    ['no rows', []],
    ['a row with null counts', [{ wards_expected: null, wards_covered: null }]],
    ['a row with string counts', [{ wards_expected: '', wards_covered: '' }]],
    ['a row missing the covered count', [{ wards_expected: 3 }]],
    ['a non-array result', undefined],
  ])('reports nothing rather than a fabricated all-clear when the read returns %s', async (
    _label,
    result,
  ) => {
    queryUnsafeMock.mockResolvedValueOnce([{ wards_expected: 3, wards_covered: 1 }]);
    await observeWardDowntimePackOutput();
    const before = serializeWardDowntimePackMetrics();

    queryUnsafeMock.mockResolvedValueOnce(result);

    // Defaulting a missing coverage row to 0/0 would publish "no wards need
    // packs, none are missing" — exactly the fabricated all-clear this probe
    // exists to end.
    await expect(observeWardDowntimePackOutput()).resolves.toBeNull();
    expect(serializeWardDowntimePackMetrics()).toBe(before);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Ward downtime pack output probe returned no usable coverage row',
      expect.any(Object),
    );
  });

  it('leaves the series untouched when the observation itself fails', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ wards_expected: 3, wards_covered: 1 }]);
    await observeWardDowntimePackOutput();
    const before = serializeWardDowntimePackMetrics();

    queryUnsafeMock.mockRejectedValueOnce(new Error('connection terminated'));

    // A failed probe must not overwrite the last real reading with a
    // fabricated one, and must not report a value it did not measure.
    await expect(observeWardDowntimePackOutput()).resolves.toBeNull();
    expect(serializeWardDowntimePackMetrics()).toBe(before);
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Ward downtime pack output probe failed',
      expect.objectContaining({ error: 'connection terminated' }),
    );
  });
});

describe('observeWardDowntimePackOutput — the coverage predicate', () => {
  it('counts a pack only when it exists, is fresh, is unexpired, and is non-empty', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ wards_expected: 1, wards_covered: 1 }]);
    await observeWardDowntimePackOutput();

    const [sql, ...params] = queryUnsafeMock.mock.calls[0];

    // Exists — the right scope, matched on both tenant and ward.
    expect(sql).toMatch(/FROM downtime_snapshots s/);
    expect(sql).toMatch(/s\.tenant_id = occupied_wards\.tenant_id/);
    expect(sql).toMatch(/s\.ward_id = occupied_wards\.ward_id/);
    // Fresh — window parameterized, never spliced into the SQL (house rule:
    // no interpolated INTERVAL).
    expect(sql).toMatch(/s\.created_at > NOW\(\) - \(\$2::int \* INTERVAL '1 minute'\)/);
    // The only interval literal in the statement is the unit multiplicand — a
    // window count spliced in as `INTERVAL '45 minutes'` would show up here.
    expect(sql.match(/INTERVAL '[^']*'/g)).toEqual(["INTERVAL '1 minute'"]);
    expect(sql).not.toContain('${');
    // Unexpired, and non-empty.
    expect(sql).toMatch(/s\.expires_at > NOW\(\)/);
    expect(sql).toMatch(/jsonb_array_length\(COALESCE\(s\.payload->'beds', '\[\]'::jsonb\)\) > 0/);

    // Spread params, not an array (lint:raw-params class).
    expect(params).toEqual(['ward_pack', WARD_PACK_FRESHNESS_WINDOW_MINUTES]);
  });

  it('defines an expected ward exactly as the generator census does', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ wards_expected: 0, wards_covered: 0 }]);
    await observeWardDowntimePackOutput();

    const [sql] = queryUnsafeMock.mock.calls[0];
    // wardDowntimePackService's census: occupied status + a patient on the bed.
    // If these drift apart the probe measures a different population than the
    // one packs are produced for, and the alert stops meaning anything.
    expect(sql).toMatch(/LOWER\(COALESCE\(b\.status, ''\)\) = 'occupied'/);
    expect(sql).toMatch(/b\.patient_uid IS NOT NULL/);
  });

  it('keeps the freshness window tighter than the 24h validity window', () => {
    // A pack is valid for 24 hours but is supposed to be regenerated every 15
    // minutes. Waiting for hard expiry would leave a stalled producer
    // undetected for most of a day.
    expect(WARD_PACK_FRESHNESS_WINDOW_MINUTES).toBe(45);
    expect(WARD_PACK_FRESHNESS_WINDOW_MINUTES).toBeLessThan(24 * 60);
  });
});

describe('recordWardDowntimePackOutputObservation — refuses impossible readings', () => {
  it.each([
    ['a negative expected count', { wardsExpected: -1, wardsCovered: 0 }],
    ['a fractional count', { wardsExpected: 1.5, wardsCovered: 0 }],
    ['a non-numeric count', { wardsExpected: 'many', wardsCovered: 0 }],
  ])('rejects %s', (_label, observation) => {
    expect(() => recordWardDowntimePackOutputObservation({
      ...observation,
      observedAt: new Date(),
    })).toThrow(TypeError);
  });

  it('rejects more covered wards than expected wards', () => {
    expect(() => recordWardDowntimePackOutputObservation({
      wardsExpected: 2,
      wardsCovered: 3,
      observedAt: new Date(),
    })).toThrow(RangeError);
  });

  it('rejects an unusable observation timestamp', () => {
    expect(() => recordWardDowntimePackOutputObservation({
      wardsExpected: 1,
      wardsCovered: 1,
      observedAt: 'never',
    })).toThrow(TypeError);
  });
});
