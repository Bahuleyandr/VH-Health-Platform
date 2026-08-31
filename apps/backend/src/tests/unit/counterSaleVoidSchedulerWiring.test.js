import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');

describe('MED-03 counter-sale void reconciliation scheduler', () => {
  test('runs a bounded tenant sweep behind the fleet advisory lock', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('counter-sale-void-reconciliation'",
    );
    expect(scheduler).toContain(
      "'counter-sale-void-reconciliation',\n      (tenantId) => reconcileCounterSaleVoidsForTenant({ tenantId, limit: 25 })",
    );
    expect(scheduler.match(/reconcileCounterSaleVoidsForTenant/g)).toHaveLength(4);
  });

  test('keeps the guarded RUN_STARTUP_TASKS operator path wired', () => {
    expect(scheduler).toContain(
      "runManualTask('counter-sale-void-reconciliation'",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('counter-sale-void-reconciliation'",
    );
    expect(scheduler.indexOf("if (!runStartupTasks)")).toBeLessThan(
      scheduler.indexOf("runManualTask('counter-sale-void-reconciliation'"),
    );
  });
});
