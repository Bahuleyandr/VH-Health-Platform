// src/observability/securityEventMetrics.js
// Prometheus counters for the security-event pipeline.
//
// The 2026-08-23 once-over found the webhook paging channel inert in every
// deployment (env-name mismatch + enable flag set nowhere) with NO second
// channel: brute-force, break-glass, and audit-chain-tamper events reached
// only log lines. These counters make the pipeline observable independently
// of webhook configuration, so alert rules can page on the events themselves
// AND on the "events occurred while paging is unconfigured" condition.
//
//   * securityEventsTotal      — every logSecurityEvent() call (the audit_log
//     funnel), labelled by event type.
//   * securityWebhookEvents    — every sendSecurityWebhook() call, labelled by
//     event type and outcome: 'sent' | 'send_failed' | 'disabled'. 'disabled'
//     rising while critical events occur is itself an alertable condition.
//
// Label cardinality: event types are code-authored upper-snake constants, but
// shape-guard anyway (continuityMetrics REASON_PATTERN precedent) so a bad
// caller cannot mint unbounded label dimensions. tenant_id is deliberately not
// a label (unbounded); the full detail lives in the audit_log row.

import { Counter } from './metricPrimitives.js';

const securityEventsTotal = new Counter(
  'vhhealth_security_events_total',
  'Security events recorded through the central security audit funnel',
  ['event_type'],
);

const securityWebhookEvents = new Counter(
  'vhhealth_security_webhook_events_total',
  'Security webhook delivery attempts by outcome (disabled = event occurred but paging is unconfigured)',
  ['event_type', 'outcome'],
);

const EVENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function eventTypeLabel(eventType) {
  const normalized = String(eventType ?? '').trim().toUpperCase();
  return EVENT_TYPE_PATTERN.test(normalized) ? normalized : 'UNKNOWN';
}

export function recordSecurityEvent(eventType) {
  securityEventsTotal.inc({ event_type: eventTypeLabel(eventType) }, 1);
}

export function recordSecurityWebhookOutcome(eventType, outcome) {
  const allowed = new Set(['sent', 'send_failed', 'disabled']);
  securityWebhookEvents.inc(
    {
      event_type: eventTypeLabel(eventType),
      outcome: allowed.has(outcome) ? outcome : 'send_failed',
    },
    1,
  );
}

export function serializeSecurityEventMetrics() {
  return [securityEventsTotal, securityWebhookEvents]
    .map((metric) => metric.serialize())
    .filter(Boolean)
    .join('\n\n');
}

export default {
  recordSecurityEvent,
  recordSecurityWebhookOutcome,
  serializeSecurityEventMetrics,
};
