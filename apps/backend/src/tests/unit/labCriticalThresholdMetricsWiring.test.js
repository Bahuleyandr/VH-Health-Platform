// src/tests/unit/labCriticalThresholdMetricsWiring.test.js
//
// Pins that the critical-threshold lookup counter actually reaches GET /metrics.
//
// Same rationale as staffPushFanoutMetrics.test.js: `Counter` in
// observability/metricPrimitives.js has NO global registry — a family is scraped
// only because its serializer is hand-imported and concatenated in
// routes/metrics/metricsRoutes.js. Here the stake is specific: this counter is
// the ONLY signal that a tenant holds no lab_critical_thresholds at all and can
// therefore never raise a critical lab alert. Auto-copying the default tenant's
// thresholds was tried and withdrawn (docs/ROADMAP.md, "Explicitly parked"), so
// if this wiring is dropped the gap goes back to being invisible.

import express from 'express';
import request from 'supertest';
import {
  recordCriticalThresholdLookup,
} from '../../observability/labCriticalThresholdMetrics.js';
import metricsRouter from '../../routes/metrics/metricsRoutes.js';

function appWithMetrics() {
  const app = express();
  app.use('/metrics', metricsRouter);
  return app;
}

describe('lab critical-threshold lookup metrics reach the scrape endpoint', () => {
  it('exports the unmatched series — the alertable one', async () => {
    recordCriticalThresholdLookup('unmatched');
    const res = await request(appWithMetrics()).get('/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('# TYPE vhhealth_lab_critical_threshold_lookups_total counter');
    expect(res.text).toContain(
      'vhhealth_lab_critical_threshold_lookups_total{outcome="unmatched"} 1',
    );
  });

  it('collapses an unrecognised outcome instead of minting a label', async () => {
    // An unrecognised outcome collapses into `unmatched` rather than becoming a
    // new time series — tenant/analyte cardinality stays out of the labels.
    recordCriticalThresholdLookup('something_new');
    const res = await request(appWithMetrics()).get('/metrics');
    expect(res.text).not.toContain('outcome="something_new"');
    expect(res.text).toContain(
      'vhhealth_lab_critical_threshold_lookups_total{outcome="unmatched"} 2',
    );
  });
});
