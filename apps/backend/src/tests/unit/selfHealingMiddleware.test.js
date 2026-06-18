// src/tests/unit/selfHealingMiddleware.test.js
//
// Unit tests for the self-healing observability middleware. Pins the bounded
// routeErrors Map (audit §5 reliability): the Map must not grow without bound
// one entry per distinct route key. It is capped at __MAX_TRACKED_ROUTES with
// LRU eviction (oldest-touched key dropped first).

import { jest } from '@jest/globals';

// Keep the logger quiet — triggerHealing logs at error level on threshold.
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// circuitBreakerStatus is dynamically imported inside triggerHealing; stub it
// so a threshold breach doesn't touch the real Prisma client.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: () => ({ open: false }),
  default: {},
}));

const {
  __MAX_TRACKED_ROUTES,
  __recordErrorForTest,
  __resetForTest,
  getHealthReport,
} = await import('../../middleware/selfHealingMiddleware.js');

describe('selfHealingMiddleware routeErrors map bounding', () => {
  beforeEach(() => {
    __resetForTest();
  });

  test('tracks one entry per distinct route under the cap', () => {
    for (let i = 0; i < 10; i++) {
      __recordErrorForTest(`/api/v1/route-${i}`, 500);
    }
    expect(getHealthReport().monitoredRoutes).toBe(10);
  });

  test('never exceeds the cap even when far more distinct keys are seen', () => {
    const overflow = __MAX_TRACKED_ROUTES + 250;
    for (let i = 0; i < overflow; i++) {
      // Each path is unique (simulates path-fuzzing where req.path varies).
      __recordErrorForTest(`/api/v1/fuzz/${i}`, 500);
    }
    expect(getHealthReport().monitoredRoutes).toBe(__MAX_TRACKED_ROUTES);
  });

  test('evicts the least-recently-used key first', () => {
    // Fill exactly to the cap.
    for (let i = 0; i < __MAX_TRACKED_ROUTES; i++) {
      __recordErrorForTest(`/k/${i}`, 500);
    }
    // Touch the oldest key (/k/0) so it becomes most-recently-used.
    __recordErrorForTest('/k/0', 500);
    // Insert one new key → cap exceeded → the now-oldest (/k/1) is evicted,
    // NOT the freshly-touched /k/0.
    __recordErrorForTest('/k/new', 500);

    const tracked = getHealthReport().routeErrors;
    expect(Object.keys(tracked)).toHaveLength(__MAX_TRACKED_ROUTES);
    expect(tracked['/k/0']).toBeDefined();   // survived (was touched)
    expect(tracked['/k/new']).toBeDefined(); // just inserted
    expect(tracked['/k/1']).toBeUndefined(); // evicted as LRU
  });

  test('preserves per-route count accumulation across repeated errors', () => {
    for (let i = 0; i < 3; i++) {
      __recordErrorForTest('/api/v1/flaky', 500);
    }
    expect(getHealthReport().routeErrors['/api/v1/flaky'].count).toBe(3);
  });
});
