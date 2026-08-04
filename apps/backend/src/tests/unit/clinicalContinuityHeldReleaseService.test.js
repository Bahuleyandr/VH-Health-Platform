import { __testing__ } from '../../services/downtime/clinicalContinuityHeldReleaseService.js';

const IDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  assignee: '10000000-0000-4000-8000-000000000002',
  incident: '10000000-0000-4000-8000-000000000003',
  item: '10000000-0000-4000-8000-000000000004',
  requirement: '10000000-0000-4000-8000-000000000005',
  tenant: '10000000-0000-4000-8000-000000000006',
});

const I04_SNAPSHOT = Object.freeze({
  interface_family: 'I04',
  message_id: '42',
  ledger_version: 1,
  status: 'reconciliation_required',
  send_authority: 'held_owner_reconciliation',
  claim_token: null,
  positive_ack_exists: false,
  payload_sha256: 'a'.repeat(64),
  recovery_inbox_id: '10000000-0000-4000-8000-000000000007',
  source_partition: 'hl7:subscription:5',
  offset_id: '10000000-0000-4000-8000-000000000008',
});

function item(overrides = {}) {
  return {
    id: IDS.item,
    tenant_id: IDS.tenant,
    facility_id: 1,
    incident_id: IDS.incident,
    incident_interface_id: IDS.requirement,
    interface_family: 'I04',
    hl7_outbound_message_id: 42,
    interop_message_id: null,
    nhcx_message_id: null,
    hold_safety_class: 'safety_critical',
    assigned_to_uid: IDS.assignee,
    owner_principal: 'role:it_admin',
    source_state_snapshot: I04_SNAPSHOT,
    ...overrides,
  };
}

const PARSED = Object.freeze({
  expectedVersion: 4,
  releaseReasonCode: 'duplicate_delivery_risk_reviewed',
  releaseReasonDetail: 'Duplicate delivery evidence was reviewed.',
  sourceStateFingerprint: 'b'.repeat(64),
});

describe('C5.2 held-message release service contracts', () => {
  test('derives safety class on the server and refuses malformed held state', () => {
    expect(__testing__.assertSourceReleaseable('I04', I04_SNAPSHOT)).toEqual({
      holdReasonCode: 'acknowledgement_or_delivery_uncertainty',
      safetyClass: 'safety_critical',
    });
    expect(() => __testing__.assertSourceReleaseable('I04', {
      ...I04_SNAPSHOT,
      positive_ack_exists: true,
    })).toThrow('not releaseable');
    expect(__testing__.assertSourceReleaseable('I19', {
      interface_family: 'I19',
      status: 'recovery_pending',
      direction: 'outbound',
      cycle: 'claim',
      recovery_disposition: 'manual_redrive_requested',
      payload_ciphertext_present: true,
      payload_hash: 'c'.repeat(64),
      recovery_inbox_id: IDS.requirement,
    })).toEqual({
      holdReasonCode: 'outbound_recovery_owner_reconciliation',
      safetyClass: 'routine_operational',
    });
  });

  test.each(['hl7v2', 'csv', 'json', 'fhir_json', 'other'])(
    'keeps I05 %s recovery safety-critical and rejects inbound claims',
    protocol => {
      const snapshot = {
        interface_family: 'I05',
        recovery_ledger_version: 1,
        status: 'quarantined',
        arrival_class: 'recovery_backlog',
        effect_disposition: 'late_pending_only',
        send_authority: 'held',
        owner_reconciliation_required: true,
        direction: 'outbound',
        protocol,
        delivery_claim_token: null,
        channel_status: 'active',
        channel_version_status: 'active',
        channel_active_version_id: 8,
        channel_version_id: 8,
        raw_payload_retained: true,
        payload_hash: 'd'.repeat(64),
        recovery_inbox_id: IDS.requirement,
      };
      expect(__testing__.assertSourceReleaseable('I05', snapshot)).toEqual({
        holdReasonCode: 'recovery_backlog_owner_reconciliation',
        safetyClass: 'safety_critical',
      });
      expect(() => __testing__.assertSourceReleaseable('I05', {
        ...snapshot,
        direction: 'inbound',
      })).toThrow('not releaseable');
    },
  );

  test('binds fingerprints to actor, reason, item version, authority, and attestation', () => {
    const requirement = { version: 2 };
    const base = __testing__.commandFingerprint({
      item: item(),
      requirement,
      actorUid: IDS.assignee,
      actorRole: 'IT_ADMIN',
      parsed: PARSED,
      attestationId: IDS.actor,
      releaseVersion: 4,
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(__testing__.commandFingerprint({
      item: item(),
      requirement,
      actorUid: IDS.assignee,
      actorRole: 'IT_ADMIN',
      parsed: { ...PARSED, releaseReasonDetail: 'A different reviewed release reason.' },
      attestationId: IDS.actor,
      releaseVersion: 4,
    })).not.toBe(base);
    expect(__testing__.commandFingerprint({
      item: item(),
      requirement,
      actorUid: IDS.assignee,
      actorRole: 'IT_ADMIN',
      parsed: PARSED,
      attestationId: IDS.actor,
      releaseVersion: 5,
    })).not.toBe(base);
  });

  test('keeps I18 absent and has no batch or predicate source identity', () => {
    expect(Object.keys(__testing__.SOURCE_FIELDS).sort()).toEqual(['I04', 'I05', 'I19']);
    expect(__testing__.SOURCE_FIELDS.I18).toBeUndefined();
    expect([...__testing__.FAMILY_REASON_CODES.I04]).not.toContain('transport_configuration_corrected');
    expect(__testing__.AUTHORITY_STATES.I04.next).toEqual({
      status: 'queued',
      send_authority: 'authorized',
    });
  });
});
