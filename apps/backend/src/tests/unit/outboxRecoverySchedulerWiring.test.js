import { readFileSync } from 'node:fs';

const schedulerSource = readFileSync(
  new URL('../../utils/scheduler.js', import.meta.url),
  'utf8',
);

describe('outbox recovery scheduler wiring', () => {
  test('registers source drain and source stale reaping under distinct fleet locks', () => {
    expect(schedulerSource).toContain("withJobLock('event-outbox-drain'");
    expect(schedulerSource).toContain('drainEventOutbox({ limit: 100 })');
    expect(schedulerSource).toContain("withJobLock('event-outbox-stale-lease-reaper'");
    expect(schedulerSource).toContain('reapStaleProcessingEvents({ limit: 200 })');
  });

  test('registers webhook dispatch and lease-expiry reaping under distinct fleet locks', () => {
    expect(schedulerSource).toContain("withJobLock('webhook-delivery-dispatch'");
    expect(schedulerSource).toContain('dispatchPendingDeliveries({ batchSize: 25 })');
    expect(schedulerSource).toContain("withJobLock('webhook-reap-stale-inflight'");
    expect(schedulerSource).toContain('reapStaleInFlightDeliveries({ limit: 200 })');
  });

  test('does not use the public ad-hoc enqueue service for source fan-out', () => {
    expect(schedulerSource).not.toMatch(/import\s*\{[^}]*enqueueDelivery[^}]*\}\s*from\s*['"]\.\.\/services\/integrations\/webhookDeliveryService\.js/);
    expect(schedulerSource).toContain('completeClaimedEventFanout');
    expect(schedulerSource).toContain('failClaimedEvent');
  });
});
