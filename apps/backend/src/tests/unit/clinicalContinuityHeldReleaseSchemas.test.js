import {
  HELD_MESSAGE_FAMILIES,
  HELD_MESSAGE_RELEASE_SCHEMA,
  parseHeldMessageAttestation,
  parseHeldMessageBinding,
  parseHeldMessageRelease,
} from '../../validators/clinicalContinuityHeldReleaseSchemas.js';

const UUID = '10000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

describe('C5.2 held-message command schemas', () => {
  test('publishes only I04, I05, and I19 with a stable schema checksum', () => {
    expect(HELD_MESSAGE_FAMILIES).toEqual(['I04', 'I05', 'I19']);
    expect(HELD_MESSAGE_RELEASE_SCHEMA).toMatchObject({
      id: 'clinical-continuity-held-message-release',
      version: 1,
    });
    expect(HELD_MESSAGE_RELEASE_SCHEMA.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(HELD_MESSAGE_FAMILIES).not.toContain('I18');
  });

  test('parses one exact binding and refuses an unclassified I18 subscription', () => {
    expect(parseHeldMessageBinding({
      incident_interface_id: UUID,
      interface_family: 'i05',
      message_id: '42',
      expected_incident_interface_version: 3,
      expected_source_state_fingerprint: HASH,
    })).toEqual({
      incidentInterfaceId: UUID,
      interfaceFamily: 'I05',
      messageId: 42,
      expectedIncidentInterfaceVersion: 3,
      sourceStateFingerprint: HASH,
    });
    expect(() => parseHeldMessageBinding({
      incident_interface_id: UUID,
      interface_family: 'I18',
      message_id: 42,
      expected_incident_interface_version: 3,
      expected_source_state_fingerprint: HASH,
    })).toThrow('I04, I05, or I19');
    expect(() => parseHeldMessageBinding({
      incident_interface_id: UUID,
      interface_family: 'I18',
      message_id: 42,
      expected_incident_interface_version: 3,
      expected_source_state_fingerprint: HASH,
      downstream_effect_classification: 'unclassified',
    })).toThrow('unknown fields');
    expect(() => parseHeldMessageBinding({
      incident_interface_id: UUID,
      interface_family: 'I04',
      message_id: 42,
      expected_incident_interface_version: 3,
      expected_source_state_fingerprint: HASH,
      where: { status: 'held' },
    })).toThrow('unknown fields');
  });

  test('normalizes typed reasons and requires bounded detail', () => {
    expect(parseHeldMessageAttestation({
      expected_version: 4,
      release_reason_code: 'duplicate_delivery_risk_reviewed',
      release_reason_detail: '  Duplicate delivery evidence was reviewed.  ',
      expected_source_state_fingerprint: HASH,
    })).toEqual({
      expectedVersion: 4,
      releaseReasonCode: 'duplicate_delivery_risk_reviewed',
      releaseReasonDetail: 'Duplicate delivery evidence was reviewed.',
      sourceStateFingerprint: HASH,
    });
    expect(() => parseHeldMessageRelease({
      expected_version: 4,
      release_reason_code: 'other',
      release_reason_detail: 'A sufficiently long but untyped reason.',
      expected_source_state_fingerprint: HASH,
    })).toThrow('release_reason_code is invalid');
    expect(() => parseHeldMessageRelease({
      expected_version: 4,
      release_reason_code: 'downstream_readiness_confirmed',
      release_reason_detail: 'too short',
      expected_source_state_fingerprint: HASH,
    })).toThrow('10-500');
  });

  test('accepts an optional safety attestation but no client-derived safety or outcome', () => {
    expect(parseHeldMessageRelease({
      expected_version: 5,
      release_reason_code: 'downstream_readiness_confirmed',
      release_reason_detail: 'Downstream readiness has been confirmed.',
      expected_source_state_fingerprint: HASH,
      safety_attestation_id: UUID,
    }).safetyAttestationId).toBe(UUID);
    expect(() => parseHeldMessageRelease({
      expected_version: 5,
      release_reason_code: 'downstream_readiness_confirmed',
      release_reason_detail: 'Downstream readiness has been confirmed.',
      expected_source_state_fingerprint: HASH,
      hold_safety_class: 'routine_operational',
    })).toThrow('unknown fields');
  });
});
