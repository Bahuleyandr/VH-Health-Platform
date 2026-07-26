import process from 'node:process';

import {
  carePathwayRegistrationDatabaseUrl,
  registerCarePathwayDefinition,
} from './lib/register-care-pathway-definition.mjs';

async function main() {
  process.env.DATABASE_URL ||= carePathwayRegistrationDatabaseUrl();
  const [{
    OP_CONTACT_TO_RECOVERY_DEFINITION,
    compileOpContactToRecoveryDefinition,
  }, {
    workflowRuntimeRegistryV4,
  }] = await Promise.all([
    import('../src/services/pathways/opPathwayDefinition.js'),
    import('../src/services/workflow/workflowRuntimeRegistry.js'),
  ]);
  return registerCarePathwayDefinition({
    definition: OP_CONTACT_TO_RECOVERY_DEFINITION,
    compiled: compileOpContactToRecoveryDefinition({
      registry: workflowRuntimeRegistryV4,
    }),
    displayName: 'Outpatient contact to recovery',
    label: 'OP',
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
