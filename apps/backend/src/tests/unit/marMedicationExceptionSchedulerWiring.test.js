import { readFileSync } from 'node:fs';

const scheduler = readFileSync(new URL('../../utils/scheduler.js', import.meta.url), 'utf8');

describe('MED-03 MAR medication exception reconciliation scheduler', () => {
  test('runs a bounded tenant sweep behind the fleet advisory lock', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withJobLock('mar-medication-exception-reconciliation'",
    );
    expect(scheduler).toContain(
      "'mar-medication-exception-reconciliation',\n      (tenantId) => reconcileMarMedicationExceptions({",
    );
    expect(scheduler).toMatch(
      /tenantId,\s+limit: 25,\s+createTaskTx: createMarMedicationExceptionTaskTx/,
    );
  });

  test('keeps the guarded scheduler run-now path wired to the typed task factory', () => {
    expect(scheduler).toContain(
      "runManualTask('mar-medication-exception-reconciliation'",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('mar-medication-exception-reconciliation'",
    );
    expect(scheduler.match(/createTaskTx: createMarMedicationExceptionTaskTx/g)).toHaveLength(2);
  });
});
