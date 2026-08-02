import { defineI05AdapterRecoveryContract } from './helpers/interfaceEngineAdapterRecoveryContract.js';

defineI05AdapterRecoveryContract({
  protocol: 'fhir_json',
  payload: '{\n  "resourceType": "Observation",\n  "id": "observation-recovery",\n  "status": "final"\n}',
  backendAdapterKey: 'backend.interop.fhir-json',
  externalAdapterKey: 'external.fhir-json.http',
});
