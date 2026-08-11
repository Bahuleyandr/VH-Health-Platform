import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schedulerSource = readFileSync(join(__dirname, '..', '..', 'utils', 'scheduler.js'), 'utf8');

describe('FHIR vital effect recovery scheduler wiring', () => {
  test('runs a bounded protected tick and propagates tenant failures', () => {
    expect(schedulerSource).toContain(
      "registerCron('*/2 * * * *', withJobLock('fhir-vital-effects-recovery'",
    );
    expect(schedulerSource).toContain('await runFhirVitalEffectsRecoveryJob({ limitPerTenant: 25 });');
    expect(schedulerSource).toContain('reconcilePendingFhirVitalEffects({ tenantId, limit: limitPerTenant })');
    expect(schedulerSource).toContain("error.code = 'FHIR_VITAL_EFFECT_RECOVERY_JOB_FAILED';");
    expect(schedulerSource).toContain('throw error;');
  });
});
