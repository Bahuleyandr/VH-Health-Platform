import { defineI05AdapterRuntimeContract } from './helpers/interfaceEngineAdapterRuntimeContract.js';

defineI05AdapterRuntimeContract({
  protocol: 'fhir_json',
  payload: '{\n  "resourceType": "Patient",\n  "id": "patient-runtime",\n  "active": true\n}',
  backendAdapterKey: 'backend.interop.fhir-json',
  adapterVersion: 'vhhealth.i05.fhir-json/v1',
  expectedEvidence: {
    resource_type: 'Patient',
    resource_id: 'patient-runtime',
    bundle_type: null,
    entry_count: null,
  },
});
