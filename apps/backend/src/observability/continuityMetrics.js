// src/observability/continuityMetrics.js
// Prometheus series for continuity publication and continuity-edge replication.
//
// Every series carries facility_id. The continuity-edge alert rules aggregate
// `by (facility_id)`, so a sample emitted without one lands in a phantom group
// where one facility's max()/min() masks another facility's failure — a healthy
// site would hide an expired pack or a stalled edge next door. Label
// cardinality is bounded by the number of facilities a deployment runs.
// tenant_id is deliberately NOT a label — it is unbounded in a multi-tenant
// deployment and belongs in the log line, which carries the full per-event
// detail (the escalationMetrics.js precedent).

import { Counter, Gauge } from './metricPrimitives.js';

const packFreshUntil = new Gauge(
  'vhhealth_continuity_pack_fresh_until_timestamp_seconds',
  'Unix timestamp through which the latest atomically published continuity pack remains valid',
  ['facility_id']
);
const verificationFailures = new Counter(
  'vhhealth_continuity_verification_failures_total',
  'Continuity verification failures by stable bounded reason',
  ['facility_id', 'reason']
);
const coverageComplete = new Gauge(
  'vhhealth_continuity_coverage_complete',
  'Whether the latest continuity publication had exact required coverage (1 complete, 0 incomplete)',
  ['facility_id']
);
// ContinuityCoverageIncomplete alerts on this counter, not on the gauge above.
// The gauge needed a `pack_fresh_until > 0` companion to tell a real coverage
// failure apart from a facility that had simply never published, and a facility
// that has never published successfully has no such companion series — so its
// coverage failure could not fire the alert at all (#710). A counter only ever
// moves when a real coverage check fails, so it needs no join and no guard.
// The gauge stays for dashboards.
const coverageIncomplete = new Counter(
  'vhhealth_continuity_coverage_incomplete_total',
  'Continuity publication attempts rejected because required coverage was not exact',
  ['facility_id']
);
const edgeLastSyncSuccess = new Gauge(
  'vhhealth_continuity_edge_last_sync_success_timestamp_seconds',
  'Unix timestamp of the latest successful continuity edge sync',
  ['facility_id']
);
const edgeReplicationLag = new Gauge(
  'vhhealth_continuity_edge_replication_lag_seconds',
  'Observed continuity edge replication lag in seconds',
  ['facility_id']
);

const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

// Facility ids are positive integers. An unusable one collapses to a single
// bounded 'unknown' series rather than throwing or dropping the sample: these
// recorders run on the failure path, and a dropped sample would be invisible to
// a `by (facility_id)` rule — silence is exactly what must not happen.
function facilityLabel(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 'unknown';
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) return 'unknown';
  return String(normalized);
}

function finiteNonNegative(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
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

export function recordContinuityPublication({ facilityId, freshUntil, complete } = {}) {
  const labels = { facility_id: facilityLabel(facilityId) };
  packFreshUntil.set(labels, unixSeconds(freshUntil, 'freshUntil'));
  coverageComplete.set(labels, complete === true ? 1 : 0);
}

export function recordContinuityCoverageIncomplete({ facilityId } = {}) {
  const labels = { facility_id: facilityLabel(facilityId) };
  coverageComplete.set(labels, 0);
  coverageIncomplete.inc(labels);
}

export function recordContinuityVerificationFailure({ facilityId, reason } = {}) {
  const normalized = String(reason || '');
  if (!REASON_PATTERN.test(normalized)) {
    throw new TypeError('reason must be a stable upper-snake-case code');
  }
  verificationFailures.inc({
    facility_id: facilityLabel(facilityId),
    reason: normalized
  });
}

export function recordContinuityEdgeSyncSuccess({
  facilityId,
  succeededAt,
  replicationLagSeconds
} = {}) {
  const labels = { facility_id: facilityLabel(facilityId) };
  edgeLastSyncSuccess.set(labels, unixSeconds(succeededAt, 'succeededAt'));
  edgeReplicationLag.set(
    labels,
    finiteNonNegative(replicationLagSeconds, 'replicationLagSeconds')
  );
}

export function setContinuityEdgeReplicationLag({
  facilityId,
  replicationLagSeconds
} = {}) {
  edgeReplicationLag.set(
    { facility_id: facilityLabel(facilityId) },
    finiteNonNegative(replicationLagSeconds, 'replicationLagSeconds')
  );
}

export function serializeContinuityMetrics() {
  return [
    packFreshUntil,
    verificationFailures,
    coverageComplete,
    coverageIncomplete,
    edgeLastSyncSuccess,
    edgeReplicationLag
  ]
    .map(metric => metric.serialize())
    .filter(Boolean)
    .join('\n\n') + '\n';
}

export default {
  recordContinuityCoverageIncomplete,
  recordContinuityEdgeSyncSuccess,
  recordContinuityPublication,
  recordContinuityVerificationFailure,
  serializeContinuityMetrics,
  setContinuityEdgeReplicationLag
};
