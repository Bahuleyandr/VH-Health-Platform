import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { parseI16AbdmRecoveryPayload } from '../../services/integrations/externalAbdmRecoveryService.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function recoveryPayload(overrides = {}) {
  const callbackBody = Buffer.from(JSON.stringify({
    transactionId: 'txn-i16-42',
    hiRequest: {
      consent: { id: 'consent-i16-42' },
      hiTypes: ['Prescription'],
    },
  }), 'utf8');
  return {
    schema: 'vhhealth.i16.abdm-owner-reconciliation/v1',
    recovery_kind: 'stranded_processing',
    callback_path: '/health-info/on-request',
    provider_identity_kind: 'transactionId',
    provider_transaction_id: 'txn-i16-42',
    environment: 'sandbox',
    occurred_at: '2026-08-03T05:00:00.000Z',
    auth_binding_sha256: 'a'.repeat(64),
    authenticated_at: '2026-08-03T04:59:59.000Z',
    raw_body_base64: callbackBody.toString('base64'),
    raw_body_sha256: sha256(callbackBody),
    webhook_event_id: 71,
    data_request_id: 83,
    ...overrides,
  };
}

describe('I16 ABDM owner-reconciled recovery', () => {
  test('parses the exact provider transaction identity and callback bytes', () => {
    const input = recoveryPayload();
    expect(parseI16AbdmRecoveryPayload(JSON.stringify(input))).toMatchObject({
      schema: input.schema,
      recoveryKind: 'stranded_processing',
      callbackPath: '/health-info/on-request',
      providerIdentityKind: 'transactionId',
      providerTransactionId: 'txn-i16-42',
      environment: 'sandbox',
      rawBodySha256: input.raw_body_sha256,
      webhookEventId: 71,
      dataRequestId: 83,
    });
  });

  test('accepts a consentRequestId late callback without inventing transfer work', () => {
    const callbackBody = Buffer.from(JSON.stringify({
      notification: { consentRequestId: 'consent-request-i16-7' },
    }), 'utf8');
    const input = recoveryPayload({
      recovery_kind: 'late_callback',
      callback_path: '/consent/on-notify',
      provider_identity_kind: 'consentRequestId',
      provider_transaction_id: 'consent-request-i16-7',
      raw_body_base64: callbackBody.toString('base64'),
      raw_body_sha256: sha256(callbackBody),
      webhook_event_id: null,
      data_request_id: null,
    });
    expect(parseI16AbdmRecoveryPayload(JSON.stringify(input))).toMatchObject({
      recoveryKind: 'late_callback',
      providerIdentityKind: 'consentRequestId',
      providerTransactionId: 'consent-request-i16-7',
      dataRequestId: null,
    });
  });

  test.each([
    input => ({ ...input, provider_sequence: 14 }),
    input => ({ ...input, raw_body_sha256: 'b'.repeat(64) }),
    input => ({ ...input, provider_transaction_id: 'different-transaction' }),
    input => ({ ...input, provider_identity_kind: 'requestId' }),
    input => ({ ...input, webhook_event_id: null }),
    input => ({ ...input, callback_path: '/consent/on-notify' }),
  ])('rejects provider sequence, byte drift, identity drift, and unclaimable shapes', (mutate) => {
    expect(() => parseI16AbdmRecoveryPayload(JSON.stringify(mutate(recoveryPayload()))))
      .toThrow(expect.objectContaining({ code: 'I16_ABDM_PAYLOAD_INVALID' }));
  });

  test('declares pre-auth replay guarding and an owner-reconciled provider cursor', () => {
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I16' })).toMatchObject({
      cursorKind: 'owner_reconciled_provider_transaction',
      providerSequence: 'absent',
      replayGuardRole: 'pre_auth_short_ttl_only',
      replayAuthority: 'owner_directed_disposition_only',
    });
  });
});
