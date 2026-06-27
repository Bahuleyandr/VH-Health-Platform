// src/tests/unit/reliabilityMetrics.test.js
import {
  recordWsBroadcastDropped,
  recordEventDeadLettered,
  recordWsFanoutSubscriberError,
  serializeReliabilityMetrics,
} from '../../observability/reliabilityMetrics.js';

describe('reliabilityMetrics serialization', () => {
  it('emits HELP/TYPE for every gauge + counter', () => {
    const out = serializeReliabilityMetrics();
    for (const name of [
      'event_outbox_pending_rows',
      'event_outbox_oldest_pending_age_seconds',
      'event_outbox_dead_letter_rows',
      'notification_outbox_pending_rows',
      'webhook_deliveries_pending_rows',
      'webhook_deliveries_failed_rows',
      'webhook_deliveries_dead_rows',
      'db_circuit_breaker_open',
      'ws_broadcast_dropped_total',
      'ws_fanout_subscriber_errors_total',
      'event_outbox_dead_lettered_total',
    ]) {
      expect(out).toContain(`# TYPE ${name}`);
    }
  });

  it('counters increment with bounded labels', () => {
    recordWsBroadcastDropped('backpressure');
    recordWsBroadcastDropped('backpressure');
    recordWsBroadcastDropped('fanout_local_fallback');
    recordWsFanoutSubscriberError();
    recordEventDeadLettered();
    const out = serializeReliabilityMetrics();
    expect(out).toContain('ws_broadcast_dropped_total{reason="backpressure"} 2');
    expect(out).toContain('ws_broadcast_dropped_total{reason="fanout_local_fallback"} 1');
    expect(out).toContain('ws_fanout_subscriber_errors_total 1');
    expect(out).toContain('event_outbox_dead_lettered_total 1');
  });
});

import request from 'supertest';
describe('metrics route composition', () => {
  it('GET /metrics includes both RED and reliability sections', async () => {
    // requireProductionMonitoringAccess always requires a token (fails closed in all envs).
    // Set a test token before importing the app so the gate lets the request through.
    const TEST_MONITORING_TOKEN = 'test-monitoring-token';
    process.env.MONITORING_TOKEN = TEST_MONITORING_TOKEN;

    const app = (await import('../../app.js')).default;
    const res = await request(app)
      .get('/metrics')
      .set('x-monitoring-token', TEST_MONITORING_TOKEN)
      .set('x-api-key', process.env.API_KEY || 'test-api-key');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
    expect(res.text).toContain('# TYPE event_outbox_pending_rows gauge');
    expect(res.text).toContain('# TYPE ws_broadcast_dropped_total counter');
  }, 30_000);
});

import { jest } from '@jest/globals';

describe('collectReliabilityMetrics tolerance', () => {
  it('does not throw when the DB query fails', async () => {
    const prismaMod = await import('../../lib/prisma.js');
    // ESM: jest.spyOn on a PrismaClient method does not attach mock methods in
    // experimental-vm-modules; overwrite the method directly on the instance.
    const original = prismaMod.default.$queryRawUnsafe.bind(prismaMod.default);
    prismaMod.default.$queryRawUnsafe = () => Promise.reject(new Error('db down'));
    const { collectReliabilityMetrics } = await import('../../observability/reliabilityMetrics.js');
    await expect(collectReliabilityMetrics()).resolves.toBeUndefined();
    prismaMod.default.$queryRawUnsafe = original;
  });
});
