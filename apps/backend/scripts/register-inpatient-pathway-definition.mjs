import process from 'node:process';

import {
  carePathwayRegistrationDatabaseUrl,
  registerCarePathwayDefinition,
} from './lib/register-care-pathway-definition.mjs';

async function main() {
  process.env.DATABASE_URL ||= carePathwayRegistrationDatabaseUrl();
  const [{
    INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION,
    compileInpatientAdmissionToRecoveryDefinition,
  }, {
    workflowRuntimeRegistryV4,
  }] = await Promise.all([
    import('../src/services/pathways/inpatientPathwayDefinition.js'),
    import('../src/services/workflow/workflowRuntimeRegistry.js'),
  ]);
  return registerCarePathwayDefinition({
    definition: INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION,
    compiled: compileInpatientAdmissionToRecoveryDefinition({
      registry: workflowRuntimeRegistryV4,
    }),
    displayName: 'Inpatient admission to recovery',
    label: 'Inpatient',
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
