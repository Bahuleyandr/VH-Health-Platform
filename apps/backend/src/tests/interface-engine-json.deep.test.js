import { defineI05AdapterRuntimeContract } from './helpers/interfaceEngineAdapterRuntimeContract.js';

defineI05AdapterRuntimeContract({
  protocol: 'json',
  payload: '{\n  "patient_id": "p-json-1",\n  "values": [1, 2],\n  "active": true\n}',
  backendAdapterKey: 'backend.interop.json',
  adapterVersion: 'vhhealth.i05.json/v1',
  expectedEvidence: { root_type: 'object', key_count: 3 },
});
