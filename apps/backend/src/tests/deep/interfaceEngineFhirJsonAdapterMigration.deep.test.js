import { defineI05AdapterMigrationContract } from '../helpers/interfaceEngineAdapterMigrationContract.js';

defineI05AdapterMigrationContract({
  migrationNumber: 614,
  migrationFilename: '614_interop_engine_fhir_json_adapter.sql',
  previousMigrationFilename: '613_interop_engine_json_adapter.sql',
  protocol: 'fhir_json',
  inboundAdapterKey: 'backend.interop.fhir-json',
  externalAdapterKey: 'external.fhir-json.http',
  adapterVersion: 'vhhealth.i05.fhir-json/v1',
  unsupportedProtocol: 'xml',
});
