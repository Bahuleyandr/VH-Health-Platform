import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');

describe('Cath inventory shortfall assignment recovery scheduler', () => {
  test('runs the bounded tenant sweep behind the fleet advisory lock', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('cath-inventory-shortfall-assignment-recovery'",
    );
    expect(scheduler).toContain(
      "'cath-inventory-shortfall-assignment-recovery',\n"
        + '      (tenantId) => sweepCathInventoryShortfallAssignments({ tenantId, limit: 25 })',
    );
    expect(scheduler.match(/sweepCathInventoryShortfallAssignments/g)).toHaveLength(4);
  });

  test('keeps the run-now path super-admin and advisory-lock guarded', () => {
    expect(scheduler).toContain(
      "runManualTask('cath-inventory-shortfall-assignment-recovery'",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('cath-inventory-shortfall-assignment-recovery'",
    );
    expect(scheduler.indexOf("if (!runStartupTasks)")).toBeLessThan(
      scheduler.indexOf("runManualTask('cath-inventory-shortfall-assignment-recovery'"),
    );
  });
});
