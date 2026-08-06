import {
  parseClinicalContinuityAdvanceCountersign,
  parseClinicalContinuityAdvanceIntent,
  parseClinicalContinuityHalt,
} from '../../validators/clinicalContinuityActivationTransitionSchemas.js';

const POLICY = '11111111-1111-4111-8111-111111111111';
const ROSTER = '22222222-2222-4222-8222-222222222222';
const GATE = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

describe('clinicalContinuityActivationTransitionSchemas', () => {
  test('parses a closed advance intent and canonicalizes exact evidence references', () => {
    expect(parseClinicalContinuityAdvanceIntent({
      target_policy_id: POLICY,
      roster_entry_id: ROSTER,
      evidence_gate_config_id: GATE,
      expected_state_fingerprint: HASH.toUpperCase(),
      evidence_references: [
        { reference: 'runbook:phase-h', sha256: 'c'.repeat(64) },
        { reference: 'drill:planned-1', sha256: 'b'.repeat(64) },
      ],
      reason_code: 'enforcement_evidence_satisfied',
      reason_detail: 'Both C-D11 evidence requirements were independently verified.',
    })).toEqual({
      targetPolicyId: POLICY,
      rosterEntryId: ROSTER,
      evidenceGateConfigId: GATE,
      expectedStateFingerprint: HASH,
      evidenceReferences: [
        { reference: 'drill:planned-1', sha256: 'b'.repeat(64) },
        { reference: 'runbook:phase-h', sha256: 'c'.repeat(64) },
      ],
      reasonCode: 'enforcement_evidence_satisfied',
      reasonDetail: 'Both C-D11 evidence requirements were independently verified.',
    });
  });

  test('requires the countersigner to bind the same expected state', () => {
    expect(() => parseClinicalContinuityAdvanceCountersign({
      roster_entry_id: ROSTER,
      expected_state_fingerprint: 'stale',
      reason_code: 'enter_shadow',
      reason_detail: 'The exact facility shadow intent was reviewed and accepted.',
    })).toThrow('expected_state_fingerprint must be a SHA-256 digest');
  });

  test('allows a unilateral clinical-lead veto without caller-supplied justification', () => {
    expect(parseClinicalContinuityHalt({
      roster_entry_id: ROSTER,
      expected_state_fingerprint: HASH,
      reason_code: 'clinical_lead_veto',
    })).toEqual({
      rosterEntryId: ROSTER,
      expectedStateFingerprint: HASH,
      evidenceReferences: [],
      reasonCode: 'clinical_lead_veto',
      reasonDetail: null,
    });
  });

  test('rejects unknown fields and duplicate evidence', () => {
    expect(() => parseClinicalContinuityAdvanceIntent({
      target_policy_id: POLICY,
      roster_entry_id: ROSTER,
      expected_state_fingerprint: HASH,
      evidence_references: [
        { reference: 'same', sha256: HASH },
        { reference: 'same', sha256: HASH },
      ],
      reason_code: 'enter_shadow',
      reason_detail: 'The exact facility shadow intent was reviewed and accepted.',
      actor_uid: POLICY,
    })).toThrow('contains unknown fields');
  });
});
