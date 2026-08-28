import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');

describe('MED-03 ward-indent notification coverage recovery scheduler', () => {
  test('runs a bounded tenant fan-out under the fleet advisory lock', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('ward-indent-notification-coverage-recovery'",
    );
    expect(scheduler).toContain(
      "'ward-indent-notification-coverage-recovery',\n      (tenantId) => sweepWardIndentNotificationCoverage({ tenantId, limit: 25 })",
    );
  });

  test('supports the guarded scheduler:run-now operator path', () => {
    expect(scheduler).toContain(
      "runManualTask('ward-indent-notification-coverage-recovery'",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('ward-indent-notification-coverage-recovery'",
    );
  });
});
