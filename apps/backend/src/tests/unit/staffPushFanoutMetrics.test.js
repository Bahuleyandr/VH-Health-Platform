// src/tests/unit/staffPushFanoutMetrics.test.js
//
// Pins that the staff push fan-out counters actually reach GET /metrics.
//
// This is not a formality. `Counter` in observability/metricPrimitives.js has NO
// global registry — a counter only gets scraped because a serializer is
// hand-imported and concatenated in routes/metrics/metricsRoutes.js. A counter
// that is incremented but never wired increments happily forever and is never
// exported, so the alert it was added to enable would silently never fire and
// nothing would indicate why. This test fails if that wiring is dropped.

import express from 'express';
import request from 'supertest';
import {
  recordStaffPushRecipientsTrimmed,
  recordStaffPushZeroRecipients,
  recordStaffPushFanoutFailure,
} from '../../observability/staffPushFanoutMetrics.js';
import metricsRouter from '../../routes/metrics/metricsRoutes.js';

function appWithMetrics() {
  const app = express();
  app.use('/metrics', metricsRouter);
  return app;
}

describe('staff push fan-out metrics reach the scrape endpoint', () => {
  it('exports the trimmed counter with the EXACT dropped count', async () => {
    recordStaffPushRecipientsTrimmed('unit_trim_probe', 7);
    const res = await request(appWithMetrics()).get('/metrics');
    expect(res.statusCode).toBe(200);
    // The value must be the number dropped, not 1 — the counter reports lost
    // reach, not "a trim happened".
    expect(res.text).toContain(
      'vhhealth_staff_push_recipients_trimmed_total{alert="unit_trim_probe"} 7',
    );
  });

  it('exports the zero-recipient counter', async () => {
    recordStaffPushZeroRecipients('unit_zero_probe');
    const res = await request(appWithMetrics()).get('/metrics');
    expect(res.text).toContain(
      'vhhealth_staff_push_zero_recipients_total{alert="unit_zero_probe"} 1',
    );
  });

  it('exports the fan-out failure counter', async () => {
    recordStaffPushFanoutFailure('unit_fail_probe');
    const res = await request(appWithMetrics()).get('/metrics');
    expect(res.text).toContain(
      'vhhealth_staff_push_fanout_failures_total{alert="unit_fail_probe"} 1',
    );
  });

  it('does not emit a trim sample when nothing was dropped', async () => {
    recordStaffPushRecipientsTrimmed('unit_nodrop_probe', 0);
    const res = await request(appWithMetrics()).get('/metrics');
    expect(res.text).not.toContain('alert="unit_nodrop_probe"');
  });
});
