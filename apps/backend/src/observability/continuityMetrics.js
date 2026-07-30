import { Counter, Gauge } from './metricPrimitives.js';

const packFreshUntil = new Gauge(
  'vhhealth_continuity_pack_fresh_until_timestamp_seconds',
  'Unix timestamp through which the latest atomically published continuity pack remains valid'
);
const verificationFailures = new Counter(
  'vhhealth_continuity_verification_failures_total',
  'Continuity verification failures by stable bounded reason',
  ['reason']
);
const coverageComplete = new Gauge(
  'vhhealth_continuity_coverage_complete',
  'Whether the latest continuity publication had exact required coverage (1 complete, 0 incomplete)'
);
const edgeLastSyncSuccess = new Gauge(
  'vhhealth_continuity_edge_last_sync_success_timestamp_seconds',
  'Unix timestamp of the latest successful continuity edge sync'
);
const edgeReplicationLag = new Gauge(
  'vhhealth_continuity_edge_replication_lag_seconds',
  'Observed continuity edge replication lag in seconds'
);

const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;

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

packFreshUntil.set({}, 0);
coverageComplete.set({}, 0);
edgeLastSyncSuccess.set({}, 0);
edgeReplicationLag.set({}, 0);

export function recordContinuityPublication({ freshUntil, complete }) {
  packFreshUntil.set({}, unixSeconds(freshUntil, 'freshUntil'));
  coverageComplete.set({}, complete === true ? 1 : 0);
}

export function recordContinuityCoverageIncomplete() {
  coverageComplete.set({}, 0);
}

export function recordContinuityVerificationFailure(reason) {
  const normalized = String(reason || '');
  if (!REASON_PATTERN.test(normalized)) {
    throw new TypeError('reason must be a stable upper-snake-case code');
  }
  verificationFailures.inc({ reason: normalized });
}

export function recordContinuityEdgeSyncSuccess({ succeededAt, replicationLagSeconds }) {
  edgeLastSyncSuccess.set({}, unixSeconds(succeededAt, 'succeededAt'));
  edgeReplicationLag.set(
    {},
    finiteNonNegative(replicationLagSeconds, 'replicationLagSeconds')
  );
}

export function setContinuityEdgeReplicationLag(replicationLagSeconds) {
  edgeReplicationLag.set(
    {},
    finiteNonNegative(replicationLagSeconds, 'replicationLagSeconds')
  );
}

export function serializeContinuityMetrics() {
  return [
    packFreshUntil,
    verificationFailures,
    coverageComplete,
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
