import { defineI05AdapterRecoveryContract } from './helpers/interfaceEngineAdapterRecoveryContract.js';

defineI05AdapterRecoveryContract({
  protocol: 'json',
  payload: '{\n  "patient_id": "p-json-recovery",\n  "values": [1, 2]\n}',
  backendAdapterKey: 'backend.interop.json',
  externalAdapterKey: 'external.json.http',
});
