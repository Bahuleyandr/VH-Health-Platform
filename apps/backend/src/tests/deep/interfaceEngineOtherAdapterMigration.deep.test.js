import { defineI05AdapterMigrationContract } from '../helpers/interfaceEngineAdapterMigrationContract.js';

defineI05AdapterMigrationContract({
  migrationNumber: 615,
  migrationFilename: '615_interop_engine_other_adapter.sql',
  previousMigrationFilename: '614_interop_engine_fhir_json_adapter.sql',
  protocol: 'other',
  inboundAdapterKey: 'backend.interop.other-envelope',
  externalAdapterKey: 'external.other-envelope.http',
  adapterVersion: 'vhhealth.i05.other-envelope/v1',
  unsupportedProtocol: 'xml',
});
