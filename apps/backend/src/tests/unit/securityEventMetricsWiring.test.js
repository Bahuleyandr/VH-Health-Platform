// src/tests/unit/securityEventMetricsWiring.test.js
//
// Pins BOTH security-event counters into the GET /metrics response body.
//
// securityEventMetrics.test.js calls serializeSecurityEventMetrics() directly,
// so it stays green even when nothing serves the result. `Counter` in
// observability/metricPrimitives.js has no global registry: a family is scraped
// only because routes/metrics/metricsRoutes.js hand-imports its serializer and
// concatenates the output into the response. One serializer serves BOTH
// counters, so dropping that single import removes
// vhhealth_security_events_total AND vhhealth_security_webhook_events_total
// from /metrics together.
//
// Prometheus cannot see that happen. SecurityWebhookCounterMissing
// (infra/kubernetes/base/monitoring/alert-rules.yaml) is a paired expression —
// the events counter moving UNLESS the webhook counter moving — so when both
// counters disappear its left-hand operand is empty and it never fires. The
// other rules in the security-events group (SecurityAuditChainTampered,
// SecurityBreakGlassActivated, SecurityPagingUnconfigured,
// SecurityBruteForceDetected, SecurityAccountLockoutSurge) simply go quiet and
// read as healthy. This suite is the only guard on the export itself.

import express from 'express';
import request from 'supertest';
import {
  recordSecurityEvent,
  recordSecurityWebhookOutcome,
} from '../../observability/securityEventMetrics.js';
import metricsRouter from '../../routes/metrics/metricsRoutes.js';

function scrape() {
  const app = express();
  app.use('/metrics', metricsRouter);
  return request(app).get('/metrics');
}

describe('security-event counters reach the scrape endpoint', () => {
  it('exports both families before any security event is recorded', async () => {
    const res = await scrape();
    expect(res.statusCode).toBe(200);

    // Counter.serialize() emits its HELP/TYPE header unconditionally, so an
    // unwired serializer is distinguishable from a quiet deployment: the family
    // headers are present here while no sample line is. Anchoring HELP to the
    // start of a line also catches a broken concatenation in metricsRoutes.js —
    // Counter.serialize() does not end with a newline, so the '\n' separators
    // between serializers are what keep the exposition format parseable.
    expect(res.text).toMatch(/^# HELP vhhealth_security_events_total /m);
    expect(res.text).toContain('# TYPE vhhealth_security_events_total counter');
    expect(res.text).toMatch(/^# HELP vhhealth_security_webhook_events_total /m);
    expect(res.text).toContain('# TYPE vhhealth_security_webhook_events_total counter');

    // The premise SecurityWebhookCounterMissing is built on: headers exist but
    // no series does until something records, so absent() cannot tell "quiet"
    // apart from "broken" and the rule has to pair the two counters instead.
    expect(res.text).not.toContain('vhhealth_security_events_total{');
    expect(res.text).not.toContain('vhhealth_security_webhook_events_total{');
  });

  it('serves both counters from the same response once they have samples', async () => {
    recordSecurityEvent('UNIT_WIRING_PROBE');
    recordSecurityWebhookOutcome('UNIT_WIRING_PROBE', 'disabled');

    const res = await scrape();
    expect(res.statusCode).toBe(200);
    // Exact series spellings — these are the names the alert rules select on, so
    // a rename here must break this test rather than silently disarm the group.
    expect(res.text).toContain(
      'vhhealth_security_events_total{event_type="UNIT_WIRING_PROBE"} 1',
    );
    expect(res.text).toContain(
      'vhhealth_security_webhook_events_total{event_type="UNIT_WIRING_PROBE",outcome="disabled"} 1',
    );
  });
});
