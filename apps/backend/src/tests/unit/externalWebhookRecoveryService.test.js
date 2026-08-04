import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { parseI18WebhookRecoveryPayload } from '../../services/integrations/externalWebhookRecoveryService.js';

function payload() {
  return {
    schema: 'vhhealth.i18.webhook-owner-reconciliation/v1',
    subscription_id: 42,
    event_outbox_id: '9007199254740993',
    event_type: 'patient.updated',
    payload_sha256: createHash('sha256').update('{"patient":"held"}').digest('hex'),
    occurred_at: '2026-08-01T12:00:00.000Z',
  };
}

describe('I18 subscriber webhook owner recovery', () => {
  it('parses the exact source occurrence without losing BIGINT precision', () => {
    expect(parseI18WebhookRecoveryPayload(JSON.stringify(payload()))).toMatchObject({
      subscriptionId: 42,
      eventOutboxId: '9007199254740993',
      eventType: 'patient.updated',
      occurredAt: '2026-08-01T12:00:00.000Z',
    });
  });

  it.each([
    value => ({ ...value, schema: 'unknown' }),
    value => ({ ...value, subscription_id: 0 }),
    value => ({ ...value, event_outbox_id: '-1' }),
    value => ({ ...value, payload_sha256: 'not-a-hash' }),
    value => ({ ...value, extra: true }),
  ])('rejects altered or incomplete source evidence', mutate => {
    expect(() => parseI18WebhookRecoveryPayload(JSON.stringify(mutate(payload()))))
      .toThrow(expect.objectContaining({ code: 'I18_WEBHOOK_RECOVERY_INVALID' }));
  });

  it('keeps HTTP transport evidence separate from subscriber acknowledgement', () => {
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I18' })).toMatchObject({
      transportEvidence: 'http_2xx_only',
      acknowledgementPolicy: 'per_subscription_owner_contract',
      lateRelease: 'blocked_while_unclassified_and_owner_directed_only',
    });
  });
});
