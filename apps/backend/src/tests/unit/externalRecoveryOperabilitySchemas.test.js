import {
  parseExternalRecoveryRegister,
  parseExternalRecoveryResume,
  parseExternalRecoveryWorkbenchQuery
} from '../../validators/externalRecoveryOperabilitySchemas.js';

function registration(overrides = {}) {
  return {
    interface_family: 'I10',
    source_partition: 'cold-chain:facility-41',
    generation: 2,
    facility_id: 41,
    initial_position: '17',
    initial_token: 'source-token-17',
    retained_from_position: '1',
    retained_from_token: 'source-token-1',
    policy_version: 'owner-policy-v3',
    policy_signature: 'signed-policy-evidence',
    retention_policy: 'tenant-signed-retention',
    retention_until: '2027-08-05T00:00:00.000Z',
    owner_evidence_reference: 'owner-packet-bv-41',
    owner_evidence_signature: 'signed-owner-evidence',
    reason_code: 'initial_marker_reconciled',
    reason_detail: 'The exact source marker was reconciled with the owner.',
    ...overrides
  };
}

function expectCode(fn, code) {
  try {
    fn();
    throw new Error('Expected parser to reject the command');
  } catch (error) {
    expect(error.code).toBe(code);
  }
}

describe('external-recovery operability closed request schemas', () => {
  it('normalizes one exact partition without accepting server-derived authority fields', () => {
    const parsed = parseExternalRecoveryRegister(registration());

    expect(parsed).toMatchObject({
      interfaceFamily: 'I10',
      sourcePartition: 'cold-chain:facility-41',
      generation: 2,
      facilityId: 41,
      initialPosition: '17',
      retainedFromPosition: '1',
      reasonCode: 'initial_marker_reconciled'
    });
    expect(parsed).not.toHaveProperty('scopeKind');
    expect(parsed).not.toHaveProperty('recoveryState');
    expect(parsed).not.toHaveProperty('commandClass');
    expect(parsed).not.toHaveProperty('actorUid');
  });

  it.each(['scope_kind', 'recovery_state', 'command_class', 'actor_uid', 'apply_all'])(
    'rejects caller-supplied %s before any command runs',
    field => {
      expectCode(
        () => parseExternalRecoveryRegister(registration({ [field]: 'forged' })),
        'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID'
      );
    }
  );

  it('requires marker absence to be an explicit typed reconciliation outcome', () => {
    const parsed = parseExternalRecoveryRegister(
      registration({
        initial_position: null,
        initial_token: null,
        reason_code: 'marker_absence_recorded',
        reason_detail: 'The owner confirmed that no initial marker can be recovered.'
      })
    );
    expect(parsed.initialPosition).toBeNull();
    expect(parsed.reasonCode).toBe('marker_absence_recorded');

    expectCode(
      () =>
        parseExternalRecoveryRegister(
          registration({ initial_position: null, initial_token: null })
        ),
      'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID'
    );
  });

  it('rejects half-markers, control characters, and non-positive generations', () => {
    for (const value of [
      registration({ initial_token: null }),
      registration({ reason_detail: 'unsafe\nreason detail' }),
      registration({ generation: 0 })
    ]) {
      expectCode(
        () => parseExternalRecoveryRegister(value),
        'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID'
      );
    }
  });

  it('requires an exact fingerprint and complete cutoff marker for resume', () => {
    const parsed = parseExternalRecoveryResume({
      expected_state_fingerprint: 'a'.repeat(64),
      resume_cutoff_position: '25',
      resume_cutoff_token: 'source-token-25',
      owner_evidence_reference: 'owner-packet-bv-41',
      owner_evidence_signature: 'signed-owner-evidence',
      reason_code: 'resume_cutoff_reconciled',
      reason_detail: 'The exact replay cutoff was reconciled with the source.'
    });
    expect(parsed).toMatchObject({
      expectedStateFingerprint: 'a'.repeat(64),
      resumeCutoffPosition: '25',
      resumeCutoffToken: 'source-token-25'
    });

    expectCode(
      () =>
        parseExternalRecoveryResume({
          expected_state_fingerprint: 'not-a-hash',
          resume_cutoff_position: '25',
          resume_cutoff_token: 'source-token-25',
          owner_evidence_reference: 'owner-packet-bv-41',
          owner_evidence_signature: 'signed-owner-evidence',
          reason_code: 'resume_cutoff_reconciled',
          reason_detail: 'The exact replay cutoff was reconciled with the source.'
        }),
      'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID'
    );
  });

  it('keeps workbench filters read-only and exact', () => {
    expect(parseExternalRecoveryWorkbenchQuery({ interface_family: 'i01' })).toEqual({
      interfaceFamily: 'I01',
      recoveryState: null
    });
    expectCode(
      () => parseExternalRecoveryWorkbenchQuery({ apply_all: 'true' }),
      'EXTERNAL_RECOVERY_OPERABILITY_INPUT_INVALID'
    );
  });
});
