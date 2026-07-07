import { Counter, Gauge, Histogram } from './metricPrimitives.js';

export const mllpConnectionsActive = new Gauge('mllp_connections_active', 'Active MLLP TCP connections', ['listener']);
export const mllpMessagesReceived = new Counter('mllp_messages_received_total', 'MLLP messages received by source and status', ['source', 'status']);
export const gatewayAckLatency = new Histogram('gateway_ack_latency_seconds', 'MLLP ACK latency after frame receipt');
export const gatewaySpoolDepth = new Gauge('gateway_spool_depth', 'Queued durable spool entries by source', ['source']);
export const gatewaySpoolOldestAge = new Gauge('gateway_spool_oldest_age_seconds', 'Oldest queued durable spool entry age in seconds');
export const gatewayForwardFailures = new Counter('gateway_forward_failures_total', 'Gateway backend forwarding failures by reason', ['reason']);
export const gatewayDeadLetter = new Counter('gateway_dead_letter_total', 'Gateway entries moved to dead letter', []);

const all = [
  mllpConnectionsActive,
  mllpMessagesReceived,
  gatewayAckLatency,
  gatewaySpoolDepth,
  gatewaySpoolOldestAge,
  gatewayForwardFailures,
  gatewayDeadLetter,
];

export function serializeMetrics() {
  return `${all.map((metric) => metric.serialize()).filter(Boolean).join('\n\n')}\n`;
}
