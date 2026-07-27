import process from 'node:process';

import {
  carePathwayRegistrationDatabaseUrl,
  registerCarePathwayDefinition,
} from './lib/register-care-pathway-definition.mjs';

async function main() {
  process.env.DATABASE_URL ||= carePathwayRegistrationDatabaseUrl();
  const [{
    EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2,
    compileEmergencyArrivalToAftercareDefinitionV2,
  }, {
    workflowRuntimeRegistryV6,
  }] = await Promise.all([
    import('../src/services/pathways/emergencyPathwayDefinition.js'),
    import('../src/services/workflow/workflowRuntimeRegistry.js'),
  ]);
  return registerCarePathwayDefinition({
    definition: EMERGENCY_ARRIVAL_TO_AFTERCARE_DEFINITION_V2,
    compiled: compileEmergencyArrivalToAftercareDefinitionV2({
      registry: workflowRuntimeRegistryV6,
    }),
    displayName: 'Emergency arrival to aftercare',
    label: 'Emergency',
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
