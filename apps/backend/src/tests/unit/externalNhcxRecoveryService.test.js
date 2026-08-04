import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import {
  parseI19NhcxOutboundRecoveryPayload,
} from '../../services/integrations/externalNhcxRecoveryService.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recoveryPayload(overrides = {}) {
  const ciphertext = Buffer.from('eyJhbGciOiJSU0EtT0FFUC0yNTYifQ.fixture.ciphertext', 'utf8');
  return {
    schema: 'vhhealth.i19.nhcx-outbound-owner-reconciliation/v1',
    nhcx_message_id: '42',
    direction: 'outbound',
    environment: 'sandbox',
    endpoint: 'claim/submit',
    occurred_at: '2026-08-03T06:00:00.000Z',
    hcx_api_call_id: 'claim-i19-42',
    payload_hash: 'a'.repeat(64),
    payload_ciphertext_base64: ciphertext.toString('base64'),
    payload_ciphertext_sha256: sha256(ciphertext),
    ...overrides,
  };
}

describe('I19 NHCX owner-directed recovery', () => {
  test('parses exact outbound ciphertext and the local message position', () => {
    const input = recoveryPayload();
    expect(parseI19NhcxOutboundRecoveryPayload(JSON.stringify(input))).toMatchObject({
      schema: input.schema,
      messageId: '42',
      direction: 'outbound',
      environment: 'sandbox',
      endpoint: 'claim/submit',
      hcxApiCallId: 'claim-i19-42',
      payloadHash: input.payload_hash,
      ciphertextSha256: input.payload_ciphertext_sha256,
    });
  });

  test.each([
    input => ({ ...input, provider_sequence: 14 }),
    input => ({ ...input, direction: 'inbound' }),
    input => ({ ...input, nhcx_message_id: '0' }),
    input => ({ ...input, payload_ciphertext_sha256: 'b'.repeat(64) }),
    input => ({ ...input, payload_ciphertext_base64: `${input.payload_ciphertext_base64}=` }),
  ])('rejects provider sequence, inbound replay, identity drift, and byte drift', (mutate) => {
    expect(() => parseI19NhcxOutboundRecoveryPayload(JSON.stringify(mutate(recoveryPayload()))))
      .toThrow(expect.objectContaining({ code: 'I19_NHCX_RECOVERY_INVALID' }));
  });

  test('declares outbound local positions and blocks inbound cursor substitution', () => {
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I19' })).toMatchObject({
      direction: 'outbound',
      cursorKind: 'local_nhcx_message_id',
      inboundProviderSequence: 'absent',
      inboundRecovery: 'blocked_owner_claim_only',
      inboundIdentityKind: 'correlation_workflow_api_call_and_payload_sha256',
      replayAuthority: 'owner_directed_outbound_only',
      paymentNoticeRecovery: 'manual_only',
    });
  });
});
