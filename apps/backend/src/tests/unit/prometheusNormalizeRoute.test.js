/**
 * Unit tests for prometheusMiddleware.normalizeRoute (audit 2026-06-18 §4
 * Observability): the fallback path label must collapse high-cardinality /
 * PHI-bearing segments (UUIDs, phones, MRNs, VH-#### hospital ids, long
 * numeric ids) to stable placeholders so Prometheus labels neither explode
 * in cardinality nor carry PHI.
 */

import { normalizeRoute } from '../../middleware/prometheusMiddleware.js';

describe('prometheusMiddleware.normalizeRoute', () => {
  it('uses the matched Express route pattern when available (no PHI leak)', () => {
    const req = { baseUrl: '/api/v1/patients', route: { path: '/:id/timeline' }, path: '/api/v1/patients/123456/timeline' };
    expect(normalizeRoute(req)).toBe('/api/v1/patients/:id/timeline');
  });

  it('collapses a UUID path segment to a placeholder in the fallback', () => {
    const req = { path: '/api/v1/emr/vitals/a1f04cf1-3f2a-4a85-a2d3-7fd06c928017' };
    const out = normalizeRoute(req);
    expect(out).not.toContain('a1f04cf1-3f2a-4a85-a2d3-7fd06c928017');
    expect(out).toBe('/api/v1/emr/vitals/:uuid');
  });

  it('collapses a phone-number path segment so PHI never becomes a label', () => {
    const req = { path: '/api/v1/notifications/9876543210' };
    const out = normalizeRoute(req);
    expect(out).not.toContain('9876543210');
    // 10-digit id collapses to the numeric :id placeholder
    expect(out).toBe('/api/v1/notifications/:id');
  });

  it('collapses an E.164 phone-in-path to a redaction placeholder', () => {
    const req = { path: '/api/v1/lookup/+919876543210/profile' };
    const out = normalizeRoute(req);
    expect(out).not.toContain('919876543210');
    expect(out).toContain('/api/v1/lookup/');
    expect(out).toContain('/profile');
  });

  it('collapses a VH-#### hospital id segment', () => {
    const req = { path: '/api/v1/records/VH-000123' };
    const out = normalizeRoute(req);
    expect(out).not.toContain('VH-000123');
    expect(out).toBe('/api/v1/records/:hospitalId');
  });

  it('collapses single short numeric ids too (legacy SERIAL keys)', () => {
    const req = { path: '/api/v1/appointments/42' };
    expect(normalizeRoute(req)).toBe('/api/v1/appointments/:id');
  });

  it('caps unknown deep paths so a never-matched route cannot blow up cardinality', () => {
    // A path that did NOT match any Express route and has many segments must
    // not become a unique label per request.
    const req = { path: '/totally/unmatched/deeply/nested/unknown/surface/here' };
    const out = normalizeRoute(req);
    expect(out).toBe('/__unmatched__');
  });

  it('leaves a normal shallow known-shaped path intact', () => {
    const req = { path: '/api/v1/health' };
    expect(normalizeRoute(req)).toBe('/api/v1/health');
  });
});
