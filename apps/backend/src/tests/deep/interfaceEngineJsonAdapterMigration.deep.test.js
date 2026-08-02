import { defineI05AdapterMigrationContract } from '../helpers/interfaceEngineAdapterMigrationContract.js';

defineI05AdapterMigrationContract({
  migrationNumber: 613,
  migrationFilename: '613_interop_engine_json_adapter.sql',
  previousMigrationFilename: '612_interop_engine_csv_adapter.sql',
  protocol: 'json',
  inboundAdapterKey: 'backend.interop.json',
  externalAdapterKey: 'external.json.http',
  adapterVersion: 'vhhealth.i05.json/v1',
  unsupportedProtocol: 'fhir_json',
});
