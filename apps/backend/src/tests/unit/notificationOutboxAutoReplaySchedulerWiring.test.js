// src/tests/unit/notificationOutboxAutoReplaySchedulerWiring.test.js
//
// Wiring pin for the notification-outbox-auto-replay sweep, mirroring the
// sos-alert-age-escalation pin: cron registration is skipped entirely under
// NODE_ENV=test (CI-8 open-handle guard), so the kill-switch shape can only
// be verified against the scheduler source.
import { readFileSync } from 'node:fs';

const scheduler = readFileSync(
  new URL('../../utils/scheduler.js', import.meta.url),
  'utf8',
);

describe('notification outbox auto-replay scheduler wiring', () => {
  // Anchor to the registration block: the env-var name first appears inside
  // the block's own comment, and the next registration is the FHIR recovery
  // job that follows the drain section.
  const start = scheduler.indexOf('bounded auto-replay of RECONCILIATION_REQUIRED');
  const block = scheduler.slice(
    start,
    scheduler.indexOf('fhir-vital-effects-recovery', start),
  );

  it('locates the sweep registration block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(200);
  });

  it('is gated by an opt-OUT kill switch: unset env keeps the remediation live', () => {
    expect(scheduler).toMatch(
      /process\.env\.NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED \?\? 'true'/,
    );
    expect(block).toMatch(/!==\s*'false'/);
    expect(block).not.toMatch(/===\s*'true'/);
  });

  it('registers a 15-minute per-tenant sweep under the advisory job lock', () => {
    // Deliberately slower than the 2-minute drain — duplicate-risk requeues
    // must not be hot-looped — and single-runner across the fleet.
    expect(block).toContain(
      "registerCron('*/15 * * * *', withJobLock('notification-outbox-auto-replay'",
    );
    expect(block).toContain("runForEachTenant('notification-outbox-auto-replay'");
    expect(block).toContain('autoReplayReconciliationRequiredRows({ tenantId, limit: 25 })');
    // Lazy import only — the sweep must not pull the notification admin
    // service into the scheduler's eager module graph (existing
    // partial-module test mocks depend on that graph staying unchanged).
    expect(scheduler).not.toMatch(/^import .*notificationOutboxAdminService\.js/m);
  });

  it('says so loudly when an operator has disabled it', () => {
    expect(block).toMatch(/logger\.warn\(/);
    expect(block).toMatch(/DISABLED by NOTIFICATION_OUTBOX_AUTO_REPLAY_ENABLED/);
  });
});
