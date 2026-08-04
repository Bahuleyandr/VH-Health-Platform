// src/observability/wardDowntimePackMetrics.js
// Prometheus series describing ward downtime-pack OUTPUT — the packs a ward
// would actually print during an outage — rather than the liveness of the job
// that is supposed to produce them.
//
// Why this file exists: `ward-downtime-packs` is a CronJob whose sweep can
// complete successfully having produced nothing at all (see
// services/downtime/wardDowntimePackOutputProbe.js for the preconditions).
// `kube_cronjob_status_last_successful_time` then stays fresh forever and the
// only alert that watched it could never fire. An outage-critical artifact has
// to be monitored by its existence, not by its producer's exit code.
//
// These series are deliberately UNLABELLED aggregates, unlike the per-facility
// series in continuityMetrics.js. That file's warning — one healthy facility's
// max()/min() masking a sick one — is about aggregating a per-entity gauge.
// The alerting series here is instead a COUNT OF WARDS IN THE BAD STATE, so a
// single uncovered ward anywhere raises it above zero and no healthy peer can
// pull it back down. Naming the ward is the log line's job (the probe logs
// tenant + ward for every gap); `tenant_id` and `ward_id` are both unbounded
// label spaces in a multi-tenant deployment.

import { Gauge } from './metricPrimitives.js';

const wardsExpected = new Gauge(
  'vhhealth_ward_downtime_pack_wards_expected',
  'Wards with at least one occupied bed, which therefore require a downtime pack'
);
const wardsCovered = new Gauge(
  'vhhealth_ward_downtime_pack_wards_covered',
  'Wards requiring a downtime pack that have a fresh, unexpired, non-empty pack'
);
const wardsMissing = new Gauge(
  'vhhealth_ward_downtime_pack_wards_missing',
  'Wards requiring a downtime pack that have no fresh, unexpired, non-empty pack'
);
const observedAtSeconds = new Gauge(
  'vhhealth_ward_downtime_pack_observation_timestamp_seconds',
  'Unix timestamp of the latest completed ward downtime-pack output observation'
);

function wholeCount(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a non-negative whole number`);
  }
  return normalized;
}

function unixSeconds(value, label) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return milliseconds / 1000;
}

/**
 * Publish one complete observation. All four series are written together, on
 * every observation, including the zeros.
 *
 * That is load-bearing, not tidiness: `WardDowntimePacksMissing` is read
 * against `wards_expected`, and a gauge that is only emitted when non-zero
 * leaves the rule with a missing arm exactly when the system is in the state
 * the rule exists to catch (the #710 lesson, one subsystem over). A deployment
 * with no occupied beds publishes 0/0/0 and is provably healthy; a deployment
 * that has never observed publishes nothing at all and trips the absent()
 * guard instead of reading as healthy.
 */
export function recordWardDowntimePackOutputObservation({
  wardsExpected: expected,
  wardsCovered: covered,
  observedAt
} = {}) {
  const expectedCount = wholeCount(expected, 'wardsExpected');
  const coveredCount = wholeCount(covered, 'wardsCovered');
  if (coveredCount > expectedCount) {
    throw new RangeError('wardsCovered cannot exceed wardsExpected');
  }

  wardsExpected.set({}, expectedCount);
  wardsCovered.set({}, coveredCount);
  wardsMissing.set({}, expectedCount - coveredCount);
  observedAtSeconds.set({}, unixSeconds(observedAt, 'observedAt'));
}

export function serializeWardDowntimePackMetrics() {
  return [wardsExpected, wardsCovered, wardsMissing, observedAtSeconds]
    .map(metric => metric.serialize())
    .filter(Boolean)
    .join('\n\n') + '\n';
}

export default {
  recordWardDowntimePackOutputObservation,
  serializeWardDowntimePackMetrics
};
