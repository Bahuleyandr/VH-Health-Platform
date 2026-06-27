// src/tests/unit/metricPrimitives.test.js
import { Histogram, Counter, Gauge } from '../../observability/metricPrimitives.js';

describe('metricPrimitives', () => {
  it('Counter serializes labelled increments', () => {
    const c = new Counter('demo_total', 'demo', ['reason']);
    c.inc({ reason: 'a' });
    c.inc({ reason: 'a' });
    c.inc({ reason: 'b' }, 3);
    const out = c.serialize();
    expect(out).toContain('# TYPE demo_total counter');
    expect(out).toContain('demo_total{reason="a"} 2');
    expect(out).toContain('demo_total{reason="b"} 3');
  });

  it('Gauge serializes a label-free series', () => {
    const g = new Gauge('demo_depth', 'demo');
    g.set({}, 42);
    expect(g.serialize()).toContain('demo_depth 42');
  });

  it('Histogram emits cumulative buckets + sum + count', () => {
    const h = new Histogram('demo_seconds', 'demo', ['route'], [0.1, 0.5, 1]);
    h.observe({ route: '/x' }, 0.2);
    h.observe({ route: '/x' }, 0.7);
    const out = h.serialize();
    expect(out).toContain('demo_seconds_bucket{route="/x",le="0.5"} 1');
    expect(out).toContain('demo_seconds_bucket{route="/x",le="+Inf"} 2');
    expect(out).toContain('demo_seconds_count{route="/x"} 2');
  });
});
