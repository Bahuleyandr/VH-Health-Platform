import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');

describe('MED-03 gateway refund reconciliation notification scheduler', () => {
  test('runs a bounded tenant sweep behind the fleet advisory lock', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('gateway-refund-reconciliation-notification'",
    );
    expect(scheduler).toContain(
      "'gateway-refund-reconciliation-notification',\n      (tenantId) => sweepGatewayRefundReconciliationNotifications({ tenantId, limit: 25 })",
    );
  });

  test('keeps the guarded scheduler run-now path wired', () => {
    expect(scheduler).toContain(
      "runManualTask('gateway-refund-reconciliation-notification'",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('gateway-refund-reconciliation-notification'",
    );
  });
});
