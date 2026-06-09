/**
 * Unit tests for clinicalAwareTracesSampler (roadmap A6) — clinical WRITE
 * transactions must trace at 100%; everything else keeps the configured
 * base rate; parent sampling decisions propagate.
 */

import { clinicalAwareTracesSampler } from '../../utils/sentry.js';

describe('clinicalAwareTracesSampler', () => {
  it('samples clinical writes at 100%', () => {
    for (const name of [
      'POST /api/v1/emr/vitals',
      'PUT /api/v1/clinical/mar/123',
      'POST /api/v1/prescriptions/create',
      'PATCH /api/v1/pharmacy-orders/55/status',
      'POST /api/v1/downtime/generate',
      'DELETE /api/v1/theatre/cases/9',
    ]) {
      expect(clinicalAwareTracesSampler({ name, baseRate: 0.1 })).toBe(1.0);
    }
  });

  it('keeps the base rate for clinical READS and non-clinical traffic', () => {
    for (const name of [
      'GET /api/v1/emr/timeline/abc',
      'GET /api/v1/appointments/list',
      'POST /api/v1/feedback',
      'GET /health/metrics',
    ]) {
      expect(clinicalAwareTracesSampler({ name, baseRate: 0.1 })).toBe(0.1);
    }
  });

  it('honors an upstream parent sampling decision', () => {
    expect(clinicalAwareTracesSampler({ name: 'POST /api/v1/emr/vitals', parentSampled: false, baseRate: 0.1 })).toBe(false);
    expect(clinicalAwareTracesSampler({ name: 'GET /api/v1/users/1', parentSampled: true, baseRate: 0.1 })).toBe(true);
  });

  it('handles missing names safely', () => {
    expect(clinicalAwareTracesSampler({ name: '', baseRate: 0.25 })).toBe(0.25);
    expect(clinicalAwareTracesSampler({ baseRate: 0.25 })).toBe(0.25);
  });
});
