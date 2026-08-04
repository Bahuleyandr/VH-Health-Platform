import { createHash, randomUUID } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { parseI13ScimRecoveryPayload } from '../../services/integrations/externalScimRecoveryService.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function payload(overrides = {}) {
  const body = Buffer.from('{"active":false}', 'utf8');
  return {
    schema: 'vhhealth.i13.scim-owner-list-diff/v1',
    provider_id: '42',
    provider_key: 'workforce-idp',
    direction: 'inbound',
    realm: 'staff',
    command_kind: 'deactivate',
    method: 'PATCH',
    resource_uid: randomUUID(),
    external_id: 'workforce-42',
    auth_binding_sha256: 'a'.repeat(64),
    authenticated_at: '2026-08-03T02:00:00.000Z',
    occurred_at: '2026-08-03T01:59:00.000Z',
    scim_body_base64: body.toString('base64'),
    scim_body_sha256: sha256(body),
    ...overrides,
  };
}

describe('I13 SCIM owner list/diff recovery', () => {
  test('parses only the exact registered byte-preserving payload', () => {
    const input = payload();
    expect(parseI13ScimRecoveryPayload(JSON.stringify(input))).toMatchObject({
      schema: input.schema,
      providerId: '42',
      providerKey: 'workforce-idp',
      direction: 'inbound',
      realm: 'staff',
      commandKind: 'deactivate',
      method: 'PATCH',
      resourceUid: input.resource_uid,
      externalId: input.external_id,
      bodySha256: input.scim_body_sha256,
    });
  });

  test.each([
    input => ({ ...input, schema: 'vhhealth.i13.scim-owner-list-diff/v2' }),
    input => ({ ...input, direction: 'outbound' }),
    input => ({ ...input, scim_body_sha256: 'b'.repeat(64) }),
    input => ({ ...input, provider_sequence: 23 }),
    input => ({ ...input, command_kind: 'enable', method: 'DELETE' }),
  ])('rejects provider sequence, byte drift, and unregistered command shapes', (mutate) => {
    expect(() => parseI13ScimRecoveryPayload(JSON.stringify(mutate(payload()))))
      .toThrow(expect.objectContaining({ code: 'I13_SCIM_PAYLOAD_INVALID' }));
  });

  test('declares owner list/diff only and no provider-side sequence', () => {
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I13' })).toMatchObject({
      cursorKind: 'owner_reconciled_list_diff',
      providerSequence: 'absent',
      replayAuthority: 'owner_directed_list_diff_only',
    });
  });
});
