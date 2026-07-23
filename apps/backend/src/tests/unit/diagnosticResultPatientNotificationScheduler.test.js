import { readFileSync } from 'node:fs';

describe('diagnostic result patient notification scheduler', () => {
  const schedulerSource = readFileSync(
    new URL('../../utils/scheduler.js', import.meta.url),
    'utf8',
  );

  test('runs through the fleet lock and per-tenant scope', () => {
    expect(schedulerSource).toContain(
      "withJobLock('diagnostic-result-patient-notification'",
    );
    expect(schedulerSource).toContain(
      "runForEachTenant(\n      'diagnostic-result-patient-notification'",
    );
    expect(schedulerSource).toContain(
      'runStructuredDiagnosticPatientNotificationSweep({ tenantId })',
    );
  });
});
