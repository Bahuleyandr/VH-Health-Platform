// src/tests/unit/reliabilityMetrics.test.js
import {
  recordWsBroadcastDropped,
  recordEventDeadLettered,
  recordWsFanoutSubscriberError,
  recordEventOutboxLeaseReaped,
  recordNoteDraftJanitorDeletions,
  recordNoteDraftSaveError,
  recordOutboxOperatorRedrive,
  recordWebhookDeliveryLeaseReaped,
  serializeReliabilityMetrics,
} from '../../observability/reliabilityMetrics.js';

describe('reliabilityMetrics serialization', () => {
  it('emits HELP/TYPE for every gauge + counter', () => {
    const out = serializeReliabilityMetrics();
    for (const name of [
      'event_outbox_pending_rows',
      'event_outbox_oldest_pending_age_seconds',
      'event_outbox_dead_letter_rows',
      'event_outbox_processing_rows',
      'event_outbox_stale_processing_rows',
      'notification_outbox_pending_rows',
      'notification_outbox_failed_rows',
      'notification_outbox_reconciliation_required_rows',
      'notification_outbox_dead_letter_rows',
      'webhook_deliveries_pending_rows',
      'webhook_deliveries_failed_rows',
      'webhook_deliveries_dead_rows',
      'webhook_deliveries_in_flight_rows',
      'webhook_deliveries_stale_in_flight_rows',
      'webhook_deliveries_parked_rows',
      'pathway_projector_inbox_pending_rows',
      'pathway_projector_inbox_oldest_pending_age_seconds',
      'pathway_projector_inbox_leased_rows',
      'pathway_projector_inbox_dead_rows',
      'pathway_projector_inbox_retired_pending_rows',
      'care_pathway_reconciliation_failing_shadow_tenants',
      'care_pathway_reconciliation_technical_error_tenants',
      'care_pathway_reconciliation_current_findings',
      'care_pathway_reconciliation_current_repairs',
      'care_pathway_reconciliation_latest_registry_evidence_age_seconds',
      'care_pathway_reconciliation_active_without_authority_tenants',
      'db_circuit_breaker_open',
      'ws_broadcast_dropped_total',
      'ws_fanout_subscriber_errors_total',
      'event_outbox_dead_lettered_total',
      'event_outbox_stale_lease_reaped_total',
      'webhook_deliveries_stale_lease_reaped_total',
      'outbox_operator_redrive_total',
      'note_draft_janitor_deletions_total',
      'note_draft_save_errors_total',
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
    recordEventOutboxLeaseReaped(2);
    recordWebhookDeliveryLeaseReaped(3);
    recordOutboxOperatorRedrive('event_outbox');
    recordOutboxOperatorRedrive('notification_outbox');
    recordOutboxOperatorRedrive('unexpected');
    const out = serializeReliabilityMetrics();
    expect(out).toContain('ws_broadcast_dropped_total{reason="backpressure"} 2');
    expect(out).toContain('ws_broadcast_dropped_total{reason="fanout_local_fallback"} 1');
    expect(out).toContain('ws_fanout_subscriber_errors_total 1');
    expect(out).toContain('event_outbox_dead_lettered_total 1');
    expect(out).toContain('event_outbox_stale_lease_reaped_total 2');
    expect(out).toContain('webhook_deliveries_stale_lease_reaped_total 3');
    expect(out).toContain('outbox_operator_redrive_total{queue="event_outbox"} 1');
    expect(out).toContain('outbox_operator_redrive_total{queue="notification_outbox"} 1');
    expect(out).toContain('outbox_operator_redrive_total{queue="other"} 1');
  });

  // Read a no-label counter's current value from the serialized exposition text
  // (0 if the metric hasn't been touched yet — a Counter emits no sample line
  // until its first inc). Lets us assert relative deltas on the module-level
  // singletons without depending on test ordering.
  function counterValue(out, name) {
    const m = out.match(new RegExp(`^${name} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : 0;
  }

  it('recordNoteDraftJanitorDeletions(n) increments note_draft_janitor_deletions_total by n', () => {
    const before = counterValue(serializeReliabilityMetrics(), 'note_draft_janitor_deletions_total');
    recordNoteDraftJanitorDeletions(3);
    const after = counterValue(serializeReliabilityMetrics(), 'note_draft_janitor_deletions_total');
    expect(after - before).toBe(3);
  });

  it('recordNoteDraftJanitorDeletions ignores a 0 / non-positive / non-finite count (no-op)', () => {
    const before = counterValue(serializeReliabilityMetrics(), 'note_draft_janitor_deletions_total');
    recordNoteDraftJanitorDeletions(0);
    recordNoteDraftJanitorDeletions(-5);
    recordNoteDraftJanitorDeletions(Number.NaN);
    const after = counterValue(serializeReliabilityMetrics(), 'note_draft_janitor_deletions_total');
    expect(after).toBe(before);
  });

  it('recordNoteDraftSaveError() increments note_draft_save_errors_total by 1', () => {
    const before = counterValue(serializeReliabilityMetrics(), 'note_draft_save_errors_total');
    recordNoteDraftSaveError();
    const after = counterValue(serializeReliabilityMetrics(), 'note_draft_save_errors_total');
    expect(after - before).toBe(1);
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
    expect(res.text).toContain('# TYPE teleconsult_ops_active_count gauge');
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
