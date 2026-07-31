process.env.DATABASE_URL ||= 'postgresql://localhost/vhhealth_registry_validation';

const {
  CLINICAL_CONTINUITY_ACTION_CATALOG,
  CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES
} = await import('../src/config/clinicalContinuityActionCatalog.js');
const { assertClinicalContinuityActionBindings } = await import(
  '../src/services/downtime/clinicalContinuityActionBindingRegistry.js'
);
await import('../src/routes/emr/clinicalNotesRoutes.js');

const bindings = assertClinicalContinuityActionBindings();
process.stdout.write(
  `${JSON.stringify(
    {
      actionIds: CLINICAL_CONTINUITY_ACTION_CATALOG.map(action => action.actionId),
      catalogueSchemaVersion: 1,
      negativeLegacyAliasCount: CLINICAL_CONTINUITY_NEGATIVE_LEGACY_ALIASES.length,
      ...bindings
    },
    null,
    2
  )}\n`
);
