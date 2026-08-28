import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');

describe('MED-03 clinical alert delivery obligation scheduler', () => {
  test('runs bounded tenant recovery behind the fleet job lock', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('clinical-alert-delivery-obligation-recovery'",
    );
    expect(scheduler).toContain(
      "'clinical-alert-delivery-obligation-recovery',\n      (tenantId) => sweepClinicalAlertDeliveryObligations({ tenantId, limit: 25 })",
    );
  });

  test('keeps the guarded scheduler run-now path wired', () => {
    expect(scheduler).toContain(
      "runManualTask('clinical-alert-delivery-obligation-recovery'",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('clinical-alert-delivery-obligation-recovery'",
    );
  });
});
