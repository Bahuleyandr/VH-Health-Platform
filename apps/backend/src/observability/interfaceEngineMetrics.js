import { Counter, Gauge } from './metricPrimitives.js';

const outboundAttempts = new Counter(
  'interface_engine_outbound_attempts_total',
  'Interface-engine outbound attempts by truthful terminal or retry outcome',
  ['outcome'],
);
const outboundClaims = new Counter(
  'interface_engine_outbound_claims_total',
  'Interface-engine outbound claim events, including lease expiry and capacity backpressure',
  ['result'],
);
const replayMessages = new Counter(
  'interface_engine_replay_messages_total',
  'Interface-engine messages considered by replay batches by result',
  ['result'],
);
const inboundSourceRejections = new Counter(
  'interface_engine_inbound_source_rejections_total',
  'Interface-engine inbound requests rejected by the source-address policy',
  ['reason'],
);
const outboundInFlight = new Gauge(
  'interface_engine_outbound_in_flight',
  'Active interface-engine outbound delivery leases observed by the latest worker tick',
  ['tenant_id'],
);

const ATTEMPT_OUTCOMES = new Set([
  'accepted', 'definitive_retryable', 'definitive_permanent', 'ambiguous',
]);
const CLAIM_RESULTS = new Set(['leased', 'lease_expired', 'backpressured']);
const REPLAY_RESULTS = new Set(['queued', 'skipped']);
const SOURCE_REJECTION_REASONS = new Set([
  'missing_source', 'inactive_source', 'empty_allowlist', 'not_allowed',
]);

export function recordInterfaceOutboundAttempt(outcome) {
  outboundAttempts.inc({ outcome: ATTEMPT_OUTCOMES.has(outcome) ? outcome : 'ambiguous' });
}

export function recordInterfaceOutboundClaims(result, count = 1) {
  const value = Number(count);
  if (!CLAIM_RESULTS.has(result) || !Number.isFinite(value) || value <= 0) return;
  outboundClaims.inc({ result }, value);
}

export function recordInterfaceReplayMessages(result, count = 1) {
  const value = Number(count);
  if (!REPLAY_RESULTS.has(result) || !Number.isFinite(value) || value <= 0) return;
  replayMessages.inc({ result }, value);
}

export function recordInterfaceSourceRejection(reason) {
  inboundSourceRejections.inc({
    reason: SOURCE_REJECTION_REASONS.has(reason) ? reason : 'not_allowed',
  });
}

export function observeInterfaceOutboundInFlight(tenantId, count) {
  const value = Number(count);
  outboundInFlight.set(
    { tenant_id: String(tenantId || 'unknown') },
    Number.isFinite(value) && value >= 0 ? value : 0,
  );
}

export function serializeInterfaceEngineMetrics() {
  return [
    outboundAttempts,
    outboundClaims,
    replayMessages,
    inboundSourceRejections,
    outboundInFlight,
  ].map(metric => metric.serialize()).join('\n');
}

export default Object.freeze({
  observeInterfaceOutboundInFlight,
  recordInterfaceOutboundAttempt,
  recordInterfaceOutboundClaims,
  recordInterfaceReplayMessages,
  recordInterfaceSourceRejection,
  serializeInterfaceEngineMetrics,
});
