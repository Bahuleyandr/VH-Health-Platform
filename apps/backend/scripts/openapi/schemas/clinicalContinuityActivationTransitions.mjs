import { envelope } from './_helpers.mjs';

const base = '/api/v1/clinical-continuity/activation-transitions/facilities/{facilityId}';

const facilityPath = {
  facilityId: { type: 'integer', minimum: 1, maximum: 2147483647 }
};

const idempotencyHeader = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Stable identity for this exact authenticated transition command.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$'
  }
};

const error = description => ({ description });

export const schemas = {
  ClinicalContinuityActivationEvidenceReference: {
    type: 'object',
    additionalProperties: false,
    required: ['reference', 'sha256'],
    properties: {
      reference: { type: 'string', minLength: 1, maxLength: 255 },
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    }
  },
  ClinicalContinuityActivationAdvanceIntentRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'target_policy_id',
      'roster_entry_id',
      'expected_state_fingerprint',
      'evidence_references',
      'reason_code',
      'reason_detail'
    ],
    properties: {
      target_policy_id: { type: 'string', format: 'uuid' },
      roster_entry_id: { type: 'string', format: 'uuid' },
      evidence_gate_config_id: { type: 'string', format: 'uuid', nullable: true },
      expected_state_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      evidence_references: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
        items: { $ref: '#/components/schemas/ClinicalContinuityActivationEvidenceReference' }
      },
      reason_code: {
        type: 'string',
        enum: ['enter_shadow', 'enforcement_evidence_satisfied', 'staged_enforcement_widening']
      },
      reason_detail: { type: 'string', minLength: 10, maxLength: 500 }
    }
  },
  ClinicalContinuityActivationAdvanceCountersignRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['roster_entry_id', 'expected_state_fingerprint', 'reason_code', 'reason_detail'],
    properties: {
      roster_entry_id: { type: 'string', format: 'uuid' },
      expected_state_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      reason_code: {
        type: 'string',
        enum: ['enter_shadow', 'enforcement_evidence_satisfied', 'staged_enforcement_widening']
      },
      reason_detail: { type: 'string', minLength: 10, maxLength: 500 }
    }
  },
  ClinicalContinuityActivationHaltRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['roster_entry_id', 'expected_state_fingerprint', 'reason_code'],
    properties: {
      roster_entry_id: { type: 'string', format: 'uuid' },
      expected_state_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      evidence_references: {
        type: 'array',
        maxItems: 20,
        uniqueItems: true,
        items: { $ref: '#/components/schemas/ClinicalContinuityActivationEvidenceReference' }
      },
      reason_code: {
        type: 'string',
        enum: [
          'clinical_lead_veto',
          'patient_safety_incident',
          'silent_failure',
          'unreconciled_window_breach',
          'listed_signoff_role_halt'
        ]
      },
      reason_detail: { type: 'string', minLength: 10, maxLength: 500, nullable: true }
    }
  },
  ClinicalContinuityActivationState: {
    type: 'object',
    additionalProperties: false,
    required: [
      'tenant_id',
      'facility_id',
      'state',
      'policy_id',
      'policy_version',
      'policy_checksum',
      'mode',
      'enforced_action_ids',
      'state_fingerprint'
    ],
    properties: {
      tenant_id: { type: 'string', format: 'uuid' },
      facility_id: { type: 'integer', minimum: 1 },
      state: { type: 'string', enum: ['off', 'shadow', 'active'] },
      policy_id: { type: 'string', format: 'uuid', nullable: true },
      policy_version: { type: 'integer', minimum: 1, nullable: true },
      policy_checksum: { type: 'string', pattern: '^[a-f0-9]{64}$', nullable: true },
      mode: { type: 'string', enum: ['shadow', 'enforce'], nullable: true },
      enforced_action_ids: { type: 'array', items: { type: 'string' } },
      state_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    }
  },
  ClinicalContinuityActivationTransitionReceipt: {
    type: 'object',
    additionalProperties: true,
    required: ['disposition', 'tenant_id', 'facility_id', 'transition_kind'],
    properties: {
      disposition: { type: 'string', enum: ['awaiting_counterkey', 'applied', 'exact_duplicate'] },
      tenant_id: { type: 'string', format: 'uuid' },
      facility_id: { type: 'integer', minimum: 1 },
      event_id: { type: 'string', format: 'uuid' },
      intent_event_id: { type: 'string', format: 'uuid' },
      transition_kind: {
        type: 'string',
        enum: [
          'off_to_shadow',
          'shadow_to_active',
          'active_to_active',
          'shadow_to_off',
          'active_to_off'
        ]
      },
      expected_state_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      effect_identity: { type: 'string', pattern: '^[a-f0-9]{64}$' }
    }
  },
  ClinicalContinuityActivationStateResponse: envelope('ClinicalContinuityActivationState'),
  ClinicalContinuityActivationTransitionResponse: envelope(
    'ClinicalContinuityActivationTransitionReceipt'
  )
};

export const operations = {
  [`GET ${base}/state`]: {
    summary: 'Read the canonical facility activation state and CAS fingerprint',
    description:
      'Authenticated staff read of the existing signed facility-policy projection. Absence is off; ' +
      'shadow is an active shadow-mode policy with no enforced action IDs; active is enforce mode ' +
      'for the exact non-empty action-ID set. This operation does not grant transition authority.',
    pathParameters: facilityPath,
    response: 'ClinicalContinuityActivationStateResponse'
  },
  [`POST ${base}/advance-intents`]: {
    summary: 'Record the first key of a governed activation advance',
    description:
      'Records an inert advance intent after exact roster, approved-policy, expected-state CAS, ' +
      'lineage, and evidence-gate checks. A distinct complementary clinical or technical roster ' +
      'identity must countersign before state changes. Empty roster fails closed.',
    pathParameters: facilityPath,
    parameters: [idempotencyHeader],
    request: 'ClinicalContinuityActivationAdvanceIntentRequest',
    response: 'ClinicalContinuityActivationTransitionResponse',
    responseStatus: 201,
    additionalResponses: {
      200: error('Exact duplicate intent receipt'),
      400: error('Malformed command or missing Idempotency-Key'),
      403: error('Current staff or roster authority was not verified'),
      409: error('State, policy, lineage, or evidence gate conflict')
    }
  },
  [`POST ${base}/advance-intents/{intentEventId}/countersign`]: {
    summary: 'Apply an activation advance with the complementary roster key',
    description:
      'Countersigns the exact stored intent reason and expected-state fingerprint with a distinct ' +
      'identity holding the complementary clinical or technical key. The applied transition and ' +
      'mandatory clinical audit event commit atomically.',
    pathParameters: {
      ...facilityPath,
      intentEventId: { type: 'string', format: 'uuid' }
    },
    parameters: [idempotencyHeader],
    request: 'ClinicalContinuityActivationAdvanceCountersignRequest',
    response: 'ClinicalContinuityActivationTransitionResponse',
    responseStatus: 201,
    additionalResponses: {
      200: error('Exact duplicate applied receipt'),
      400: error('Malformed command or missing Idempotency-Key'),
      403: error('Distinct complementary roster authority was not verified'),
      404: error('Advance intent was not found'),
      409: error('State, intent, policy, or evidence gate conflict')
    }
  },
  [`POST ${base}/halt`]: {
    summary: 'Halt a facility activation with one authorized rollback voice',
    description:
      'A single authenticated listed sign-off identity or affected-unit clinical lead may retire ' +
      'the current active policy to off using expected-state CAS. Caller-supplied justification is ' +
      'optional so the C-D11 veto remains unilateral; audit evidence is mandatory and atomic.',
    pathParameters: facilityPath,
    parameters: [idempotencyHeader],
    request: 'ClinicalContinuityActivationHaltRequest',
    response: 'ClinicalContinuityActivationTransitionResponse',
    responseStatus: 201,
    additionalResponses: {
      200: error('Exact duplicate halt receipt'),
      400: error('Malformed command or missing Idempotency-Key'),
      403: error('Rollback roster authority was not verified'),
      409: error('State or policy conflict')
    }
  }
};
