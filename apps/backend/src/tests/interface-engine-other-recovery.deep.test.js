import { createHash } from 'node:crypto';

import { defineI05AdapterRecoveryContract } from './helpers/interfaceEngineAdapterRecoveryContract.js';

const innerPayload = Buffer.from('opaque-recovery-payload', 'utf8');

defineI05AdapterRecoveryContract({
  protocol: 'other',
  payload: JSON.stringify({
    schema: 'vhhealth.i05.other/v1',
    message_id: 'other-recovery-1',
    media_type: 'application/octet-stream',
    content_encoding: 'base64',
    payload: innerPayload.toString('base64'),
    payload_sha256: createHash('sha256').update(innerPayload).digest('hex'),
  }),
  backendAdapterKey: 'backend.interop.other-envelope',
  externalAdapterKey: 'external.other-envelope.http',
});
