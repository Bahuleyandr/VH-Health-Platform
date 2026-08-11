import { readFileSync } from 'node:fs';

const alerts = readFileSync(
  new URL('../../../../../infra/kubernetes/base/monitoring/backend-reliability-alerts.yaml', import.meta.url),
  'utf8',
);
const dashboard = readFileSync(
  new URL('../../../../../infra/kubernetes/base/monitoring/dashboards/vhhealth-backend-reliability.json', import.meta.url),
  'utf8',
);
const runbook = readFileSync(
  new URL('../../../../../docs/RUNBOOK_ONCALL.md', import.meta.url),
  'utf8',
);

describe('notification outbox operational monitoring contract', () => {
  it('alerts on dead letters, reconciliation, paused cursors, and stale collector data', () => {
    for (const alert of [
      'NotificationOutboxDeadLetters',
      'NotificationOutboxReconciliationRequired',
      'NotificationDeliveryCursorPaused',
      'ReliabilityMetricsStale',
    ]) {
      expect(alerts).toContain(`alert: ${alert}`);
      expect(runbook).toContain(`## ${alert}`);
    }
    expect(alerts).toContain('reliability_metrics_last_success_timestamp_seconds');
    expect(alerts).toContain('max(time() - reliability_metrics_last_success_timestamp_seconds) > 300');
  });

  it('shows the notification delivery ledger and collector freshness on the reliability dashboard', () => {
    expect(dashboard).toContain('notification_outbox_dead_letter_rows');
    expect(dashboard).toContain('notification_outbox_reconciliation_required_rows');
    expect(dashboard).toContain('notification_delivery_paused_cursors');
    expect(dashboard).toContain('max(time() - reliability_metrics_last_success_timestamp_seconds)');
  });
});
