import { Counter, Gauge, Histogram } from './metricPrimitives.js';

export const mllpConnectionsActive = new Gauge(
  'mllp_connections_active',
  'Active MLLP TCP connections',
  ['listener'],
);
export const mllpMessagesReceived = new Counter(
  'mllp_messages_received_total',
  'MLLP messages by opaque source reference and bounded result',
  ['source_ref', 'status'],
);
export const gatewayAckLatency = new Histogram(
  'gateway_ack_latency_seconds',
  'MLLP acknowledgement latency after frame receipt',
);
// Depth/age carry an optional `scope` label so legacy NDJSON spools export on
// the SAME metric names the I09 partitions use (scope="legacy") — the
// DeviceGatewaySpoolDepthHigh / ...OldestAgeHigh alerts match on the bare
// metric name and therefore see both. I09 partition series omit the label
// (empty labels are not serialized), keeping their exposition unchanged.
export const gatewaySpoolDepth = new Gauge(
  'gateway_spool_depth',
  'Queued durable entries by opaque partition reference',
  ['scope', 'partition_ref'],
);
export const gatewaySpoolOldestAge = new Gauge(
  'gateway_spool_oldest_age_seconds',
  'Age of the oldest queued entry by opaque partition reference',
  ['scope', 'partition_ref'],
);
export const gatewaySpoolCapacity = new Gauge(
  'gateway_spool_capacity_bytes',
  'Configured spool hard capacity by scope and opaque partition reference',
  ['scope', 'partition_ref'],
);
export const gatewayChainHealth = new Gauge(
  'gateway_chain_health',
  'Whether the durable chain is healthy by opaque partition reference',
  ['partition_ref'],
);
export const gatewayHighWaterLag = new Gauge(
  'gateway_high_water_lag',
  'Local head minus authenticated backend high-water position',
  ['partition_ref'],
);
export const gatewayRecoveryState = new Gauge(
  'gateway_recovery_state',
  'Authenticated backend recovery state by opaque partition reference',
  ['partition_ref', 'state'],
);
export const gatewayRecoveryComplete = new Gauge(
  'gateway_recovery_complete',
  'Backend-authoritative recovery completion by opaque partition reference',
  ['partition_ref'],
);
export const gatewayInFlight = new Gauge(
  'gateway_in_flight',
  'In-flight recovery writes by opaque partition reference',
  ['partition_ref'],
);
export const gatewayForwardFailures = new Counter(
  'gateway_forward_failures_total',
  'Backend forwarding failures by bounded reason',
  ['reason'],
);
export const gatewayRefusals = new Counter(
  'gateway_refusals_total',
  'Gateway refusals by bounded non-PHI reason',
  ['reason'],
);
export const gatewayReconciliation = new Counter(
  'gateway_reconciliation_total',
  'Partitions held for reconciliation by bounded non-PHI reason',
  ['reason'],
);
export const gatewayCredentialEvents = new Counter(
  'gateway_credential_events_total',
  'Gateway or device credential outcomes without credential material',
  ['kind', 'status'],
);
// LIS analyzer transport (ASTM E1394 over TCP + MLLP HL7 ORU). Labels stay
// bounded: listener names come from operator config, protocol/status/reason
// from closed in-code sets — never from wire content.
export const lisConnectionsActive = new Gauge(
  'lis_connections_active',
  'Active LIS analyzer TCP connections by listener',
  ['listener'],
);
export const lisMessagesReceived = new Counter(
  'lis_messages_received_total',
  'Complete LIS analyzer messages by listener, protocol, and bounded result',
  ['listener', 'protocol', 'status'],
);
export const lisFrameNaks = new Counter(
  'lis_frame_naks_total',
  'ASTM frames answered NAK by listener and bounded reason',
  ['listener', 'reason'],
);

const all = [
  mllpConnectionsActive,
  mllpMessagesReceived,
  gatewayAckLatency,
  gatewaySpoolDepth,
  gatewaySpoolOldestAge,
  gatewaySpoolCapacity,
  gatewayChainHealth,
  gatewayHighWaterLag,
  gatewayRecoveryState,
  gatewayRecoveryComplete,
  gatewayInFlight,
  gatewayForwardFailures,
  gatewayRefusals,
  gatewayReconciliation,
  gatewayCredentialEvents,
  lisConnectionsActive,
  lisMessagesReceived,
  lisFrameNaks,
];

export function serializeMetrics() {
  return `${all.map((metric) => metric.serialize()).filter(Boolean).join('\n\n')}\n`;
}
