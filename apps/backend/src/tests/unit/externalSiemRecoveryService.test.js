import { createHash } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import {
  parseI25SiemRecoveryPayload,
} from '../../services/integrations/externalSiemRecoveryService.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function payload() {
  return {
    schema: 'vhhealth.i25.siem-attempt-owner-reconciliation/v1',
    attempt_id: 93,
    event_id: 51,
    target_id: 7,
    attempt_number: 2,
    source_name: 'audit_log',
    source_id: '1842',
    payload_sha256: sha256('minimized-siem-event'),
    acknowledgement_state: 'uncertain',
    occurred_at: '2026-08-04T04:31:00.000Z',
  };
}

describe('I25 SIEM per-target attempt recovery', () => {
  it('parses the exact closed per-target attempt envelope', () => {
    expect(parseI25SiemRecoveryPayload(JSON.stringify(payload()))).toEqual({
      schema: 'vhhealth.i25.siem-attempt-owner-reconciliation/v1',
      attemptId: 93,
      eventId: 51,
      targetId: 7,
      attemptNumber: 2,
      sourceName: 'audit_log',
      sourceId: '1842',
      payloadSha256: sha256('minimized-siem-event'),
      acknowledgementState: 'uncertain',
      occurredAt: '2026-08-04T04:31:00.000Z',
    });
  });

  it.each([
    value => ({ ...value, extra: true }),
    value => ({ ...value, payload_sha256: 'A'.repeat(64) }),
    value => ({ ...value, acknowledgement_state: 'positive' }),
    value => ({ ...value, attempt_id: 0 }),
    value => ({ ...value, occurred_at: 'not-a-timestamp' }),
  ])('fails closed on malformed or already-positive evidence', mutate => {
    expect(() => parseI25SiemRecoveryPayload(JSON.stringify(mutate(payload()))))
      .toThrow(expect.objectContaining({ code: 'I25_SIEM_RECOVERY_INVALID' }));
  });

  it('records capture, delivery, lease, and late-release semantics in the catalog', () => {
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I25' })).toMatchObject({
      implemented: true,
      cursorEvidence: 'positive_acknowledgement_attempt_lineage_only',
      captureCursorSemantics: 'capture_into_event_ledger_not_delivery',
      deliveryTruth: 'per_target_attempts_never_shared_export_status',
      captureScheduling: 'owner_activation_required_no_automatic_caller',
      leaseSemantics: 'expiring_fenced_attempt_claim_with_reaper',
      lateRelease: 'owner_directed_pending_review_only',
    });
  });
});
