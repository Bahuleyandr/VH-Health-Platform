import { readFileSync } from 'node:fs';

describe('care pathway reconciliation scheduler wiring', () => {
  const schedulerSource = readFileSync(
    new URL('../../utils/scheduler.js', import.meta.url),
    'utf8',
  );
  const envExample = readFileSync(
    new URL('../../../.env.example', import.meta.url),
    'utf8',
  );

  test('awaits one default-off job behind both fleet and tenant/pathway fences', () => {
    expect(schedulerSource).toContain("withJobLock('care-pathway-reconciliation'");
    expect(schedulerSource).toContain('if (!isPathwayReconciliationEnabled()) return');
    expect(schedulerSource).toContain('await runCarePathwayReconciliationSweep()');
    expect(schedulerSource).toContain('pathwayReconciliationCron()');
  });

  test('documents disabled observation and repair gates without production enablement', () => {
    expect(envExample).toContain('CARE_PATHWAY_RECONCILIATION_ENABLED=false');
    expect(envExample).toContain('CARE_PATHWAY_RECONCILIATION_REPAIR_ENABLED=false');
    expect(envExample).toContain('Operational collection cadence only');
  });
});
