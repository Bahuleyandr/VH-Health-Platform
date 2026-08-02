import { createHash } from 'node:crypto';

import { defineI05AdapterRuntimeContract } from './helpers/interfaceEngineAdapterRuntimeContract.js';

const innerPayload = Buffer.from('opaque-runtime-payload', 'utf8');
const innerHash = createHash('sha256').update(innerPayload).digest('hex');

defineI05AdapterRuntimeContract({
  protocol: 'other',
  payload: JSON.stringify({
    schema: 'vhhealth.i05.other/v1',
    message_id: 'other-runtime-1',
    media_type: 'application/octet-stream',
    content_encoding: 'base64',
    payload: innerPayload.toString('base64'),
    payload_sha256: innerHash,
  }),
  backendAdapterKey: 'backend.interop.other-envelope',
  adapterVersion: 'vhhealth.i05.other-envelope/v1',
  expectedEvidence: {
    envelope_schema: 'vhhealth.i05.other/v1',
    envelope_message_id: 'other-runtime-1',
    inner_payload_sha256: innerHash,
    inner_payload_bytes: innerPayload.length,
  },
});
