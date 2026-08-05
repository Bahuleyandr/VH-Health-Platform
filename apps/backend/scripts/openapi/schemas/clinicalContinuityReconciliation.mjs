import { envelope } from './_helpers.mjs';

const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { ...uuid, nullable: true };
const dateTime = { type: 'string', format: 'date-time' };
const nullableDateTime = { ...dateTime, nullable: true };
const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const expectedVersion = { type: 'integer', minimum: 1 };
const bigintPositive = {
  oneOf: [
    { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    { type: 'string', pattern: '^[1-9][0-9]*$' },
  ],
};
const bigintNonNegative = {
  oneOf: [
    { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
  ],
};

const commonPaperProperties = {
  expected_version: expectedVersion,
  occurred_at: dateTime,
  original_actor_uid: uuid,
  original_actor_role: { type: 'string', minLength: 1, maxLength: 80 },
  patient_uid: uuid,
  encounter_id: nullableUuid,
  evidence_hash: sha256,
};
const commonPaperRequired = [
  'expected_version', 'occurred_at', 'original_actor_uid',
  'original_actor_role', 'patient_uid', 'encounter_id', 'evidence_hash',
];

export const schemas = {
  ClinicalContinuityIncidentState: {
    type: 'string',
    enum: ['declared', 'restored', 'reconciling', 'closed'],
  },
  ClinicalContinuityQueueType: {
    type: 'string',
    enum: ['needs_review', 'identity', 'interface'],
  },
  ClinicalContinuityPaperDisposition: {
    type: 'string',
    enum: ['unentered', 'claimed', 'applied', 'needs_review', 'excluded', 'voided', 'lost_revoked'],
  },
  ClinicalContinuityHeldMessageFamily: {
    type: 'string',
    enum: ['I04', 'I05', 'I19'],
  },
  ClinicalContinuityHeldMessageSafetyClass: {
    type: 'string',
    enum: ['routine_operational', 'safety_critical', 'unclassified'],
  },
  ClinicalContinuityHeldMessageReleaseReason: {
    type: 'string',
    enum: [
      'downstream_readiness_confirmed',
      'transport_configuration_corrected',
      'duplicate_delivery_risk_reviewed',
      'acknowledgement_uncertainty_reviewed',
      'owner_recovery_evidence_reconciled',
    ],
  },
  ClinicalContinuityIncident: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'facility_id', 'commander_uid', 'lifecycle_state', 'version', 'declared_at'],
    properties: {
      id: uuid,
      facility_id: { type: 'integer', minimum: 1 },
      packet_id: uuid,
      canonical_incident_id: nullableUuid,
      commander_uid: uuid,
      commander_role: { type: 'string' },
      lifecycle_state: { $ref: '#/components/schemas/ClinicalContinuityIncidentState' },
      version: expectedVersion,
      declared_at: dateTime,
      restored_at: nullableDateTime,
      reconciliation_started_at: nullableDateTime,
      closed_at: nullableDateTime,
      closure_snapshot_hash: { ...sha256, nullable: true },
    },
  },
  ClinicalContinuityIncidentPacket: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'facility_id', 'reserved_incident_id', 'range_prefix', 'range_first', 'range_last', 'status', 'valid_from', 'valid_until'],
    properties: {
      id: uuid,
      facility_id: { type: 'integer', minimum: 1 },
      reserved_incident_id: uuid,
      range_prefix: { type: 'string' },
      range_first: bigintPositive,
      range_last: bigintPositive,
      status: { type: 'string', enum: ['unused', 'used', 'revoked', 'expired'] },
      valid_from: dateTime,
      valid_until: dateTime,
      revoked_at: nullableDateTime,
      revocation_reason: { type: 'string', nullable: true },
      packet_schema_version: { type: 'integer', enum: [1], nullable: true },
      policy_id: nullableUuid,
      policy_version: { ...bigintPositive, nullable: true },
      policy_checksum: { ...sha256, nullable: true },
      contact_sheet_id: nullableUuid,
      contact_sheet_checksum: { ...sha256, nullable: true },
      artifact_sha256: { ...sha256, nullable: true },
      allowed_copy_count: { type: 'integer', minimum: 1, nullable: true },
      authorization_audit_id: nullableUuid,
      supersedes_packet_id: nullableUuid,
    },
  },
  ClinicalContinuityIncidentContactSheetRequest: {
    type: 'object', additionalProperties: false, required: ['content'],
    properties: {
      content: {
        type: 'object', additionalProperties: false,
        description: 'Owner-supplied phone-tree authority. Patient data is prohibited.',
        required: ['schemaVersion', 'source', 'custodyLocation', 'contacts', 'instructions'],
        properties: {
          schemaVersion: { type: 'integer', enum: [1] },
          source: { type: 'string', minLength: 1, maxLength: 240 },
          custodyLocation: { type: 'string', minLength: 1, maxLength: 240 },
          instructions: { type: 'string', minLength: 1, maxLength: 1000 },
          contacts: {
            type: 'array', minItems: 1, maxItems: 50,
            items: {
              type: 'object', additionalProperties: false,
              required: ['role', 'label', 'escalationOrder', 'channels'],
              properties: {
                role: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,79}$' },
                label: { type: 'string', minLength: 1, maxLength: 120 },
                escalationOrder: { type: 'integer', minimum: 1 },
                channels: {
                  type: 'array', minItems: 2, maxItems: 10,
                  items: {
                    type: 'object', additionalProperties: false,
                    required: ['kind', 'value'],
                    properties: {
                      kind: { type: 'string', enum: ['phone', 'sms', 'messaging', 'radio'] },
                      value: { type: 'string', minLength: 1, maxLength: 160 },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  ClinicalContinuityIncidentPacketProvisionRequest: {
    type: 'object', additionalProperties: false,
    required: ['request_id', 'contact_sheet_id'],
    properties: { request_id: uuid, contact_sheet_id: uuid },
  },
  ClinicalContinuityIncidentPacketCustodyRequest: {
    type: 'object', additionalProperties: false,
    required: ['event_type', 'copy_number', 'evidence_hash', 'occurred_at'],
    properties: {
      event_type: {
        type: 'string',
        enum: ['downloaded', 'printed', 'handed_over', 'received', 'destroyed'],
      },
      copy_number: { type: 'integer', minimum: 1 },
      evidence_hash: sha256,
      notes: { type: 'string', maxLength: 500, nullable: true },
      occurred_at: dateTime,
    },
  },
  ClinicalContinuityIncidentPacketRevokeRequest: {
    type: 'object', additionalProperties: false, required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 160 } },
  },
  ClinicalContinuityIncidentPacketCommand: {
    type: 'object', additionalProperties: true,
  },
  ClinicalContinuityIncidentPacketArtifact: {
    type: 'object', additionalProperties: true,
  },
  ClinicalContinuityIncidentPacketCommandResponse: envelope('ClinicalContinuityIncidentPacketCommand'),
  ClinicalContinuityIncidentPacketArtifactResponse: envelope('ClinicalContinuityIncidentPacketArtifact'),
  ClinicalContinuityPaperRange: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'incident_id', 'range_prefix', 'range_first', 'range_last', 'status', 'version'],
    properties: {
      id: uuid,
      incident_id: uuid,
      range_prefix: { type: 'string' },
      range_first: bigintPositive,
      range_last: bigintPositive,
      status: { type: 'string', enum: ['allocated', 'in_use', 'accounted', 'lost', 'revoked', 'exhausted'] },
      last_accounted_number: { ...bigintPositive, nullable: true },
      reason: { type: 'string', nullable: true },
      version: expectedVersion,
    },
  },
  ClinicalContinuityPaperItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'incident_id', 'paper_item_id', 'item_kind', 'evidence_hash', 'reconciliation_disposition', 'version'],
    properties: {
      id: uuid,
      incident_id: uuid,
      paper_item_id: { type: 'string', minLength: 1, maxLength: 128 },
      item_kind: { type: 'string', enum: ['temporary_identity', 'medication_administration', 'specimen_collection', 'transfusion_verification', 'other'] },
      action_id: { type: 'string', nullable: true },
      patient_uid: nullableUuid,
      temporary_identity_id: nullableUuid,
      occurred_at: nullableDateTime,
      recorded_at: nullableDateTime,
      reviewed_at: nullableDateTime,
      evidence_hash: sha256,
      payload_fingerprint: { ...sha256, nullable: true },
      reconciliation_disposition: { $ref: '#/components/schemas/ClinicalContinuityPaperDisposition' },
      version: expectedVersion,
    },
  },
  ClinicalContinuityReconciliationItem: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'incident_id', 'queue_type', 'disposition', 'reason_code', 'safety_critical', 'owner_principal', 'version'],
    properties: {
      id: uuid,
      incident_id: uuid,
      queue_type: { $ref: '#/components/schemas/ClinicalContinuityQueueType' },
      disposition: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'excluded', 'superseded'] },
      reason_code: { type: 'string' },
      paper_item_row_id: nullableUuid,
      temporary_identity_id: nullableUuid,
      patient_uid: nullableUuid,
      safety_critical: { type: 'boolean' },
      owner_principal: { type: 'string' },
      assigned_to_uid: nullableUuid,
      task_id: { type: 'integer', minimum: 1, nullable: true },
      task_status: { type: 'string', nullable: true },
      task_due_at: nullableDateTime,
      sla_completion_semantics: { type: 'string', enum: ['none', 'acknowledgement', 'domain_evidence'], nullable: true },
      incident_interface_id: nullableUuid,
      interface_item_kind: { type: 'string', enum: ['held_message_release'], nullable: true },
      interface_family: {
        allOf: [{ $ref: '#/components/schemas/ClinicalContinuityHeldMessageFamily' }],
        nullable: true,
      },
      hl7_outbound_message_id: { type: 'integer', minimum: 1, nullable: true },
      interop_message_id: { type: 'integer', minimum: 1, nullable: true },
      nhcx_message_id: { ...bigintPositive, nullable: true },
      hold_reason_code: { type: 'string', nullable: true },
      hold_safety_class: {
        allOf: [{ $ref: '#/components/schemas/ClinicalContinuityHeldMessageSafetyClass' }],
        nullable: true,
      },
      source_state_fingerprint: { ...sha256, nullable: true },
      source_safe_evidence: { type: 'object', additionalProperties: true, nullable: true },
      release_attestation_id: nullableUuid,
      release_receipt_disposition: { type: 'string', nullable: true },
      release_receipt_outcome_code: { type: 'string', nullable: true },
      release_audit_event_id: nullableUuid,
      can_attest_release: { type: 'boolean', nullable: true },
      can_release: { type: 'boolean', nullable: true },
      version: expectedVersion,
    },
  },
  ClinicalContinuityTemporaryIdentity: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'incident_id', 'paper_item_id', 'display_identifier', 'identity_status', 'safety_critical', 'version'],
    properties: {
      id: uuid,
      incident_id: uuid,
      paper_item_id: { type: 'string' },
      display_identifier: { type: 'string' },
      identity_status: { type: 'string', enum: ['unresolved', 'proposed', 'matched', 'retained_temporary'] },
      matched_patient_uid: nullableUuid,
      merge_request_id: { type: 'integer', minimum: 1, nullable: true },
      safety_critical: { type: 'boolean' },
      version: expectedVersion,
    },
  },
  ClinicalContinuityDeviceOffset: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'incident_id', 'device_id', 'required_high_water_mark', 'disposition', 'owner_principal', 'version'],
    properties: {
      id: uuid,
      incident_id: uuid,
      device_id: uuid,
      required_high_water_mark: bigintNonNegative,
      observed_high_water_mark: { ...bigintNonNegative, nullable: true },
      disposition: { type: 'string', enum: ['pending', 'reconciled', 'lost_assigned', 'not_applicable'] },
      assigned_to_uid: nullableUuid,
      owner_principal: { type: 'string' },
      version: expectedVersion,
    },
  },
  ClinicalContinuityInterfaceRequirement: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'incident_id', 'interface_family', 'direction', 'source_partition', 'disposition', 'owner_principal', 'version'],
    properties: {
      id: uuid,
      incident_id: uuid,
      offset_id: nullableUuid,
      interface_family: { type: 'string' },
      direction: { type: 'string' },
      source_partition: { type: 'string' },
      required_generation: { type: 'integer', minimum: 0, nullable: true },
      required_high_water_position: { ...bigintNonNegative, nullable: true },
      required_high_water_token: { type: 'string', nullable: true },
      observed_generation: { type: 'integer', minimum: 0, nullable: true },
      observed_high_water_position: { ...bigintNonNegative, nullable: true },
      observed_high_water_token: { type: 'string', nullable: true },
      observed_recovery_state: { type: 'string', nullable: true },
      disposition: { type: 'string', enum: ['pending', 'reconciled', 'not_applicable', 'assigned_gap'] },
      owner_principal: { type: 'string' },
      assigned_to_uid: nullableUuid,
      version: expectedVersion,
    },
  },
  ClinicalContinuityWorkbench: {
    type: 'object',
    additionalProperties: false,
    required: ['incidents', 'packets', 'paper_ranges', 'paper_items', 'reconciliation_items', 'temporary_identities', 'device_offsets', 'interfaces', 'capabilities'],
    properties: {
      incidents: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityIncident' } },
      packets: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityIncidentPacket' } },
      paper_ranges: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityPaperRange' } },
      paper_items: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityPaperItem' } },
      reconciliation_items: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityReconciliationItem' } },
      temporary_identities: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityTemporaryIdentity' } },
      device_offsets: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityDeviceOffset' } },
      interfaces: { type: 'array', items: { $ref: '#/components/schemas/ClinicalContinuityInterfaceRequirement' } },
      capabilities: {
        type: 'object',
        additionalProperties: false,
        required: ['can_bind'],
        properties: { can_bind: { type: 'boolean' } },
      },
    },
  },
  ClinicalContinuityWorkbenchResponse: envelope('ClinicalContinuityWorkbench'),
  ClinicalContinuityDeclareRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_version', 'packet_id', 'reserved_incident_id', 'signed_canonical_hash', 'signature', 'occurred_at'],
    properties: {
      expected_version: { type: 'integer', minimum: 0 },
      packet_id: uuid,
      reserved_incident_id: uuid,
      signed_canonical_hash: sha256,
      signature: { type: 'string', minLength: 1 },
      occurred_at: dateTime,
    },
  },
  ClinicalContinuityRegisterPaperItemRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['expected_version', 'item_kind', 'evidence_hash'],
    properties: {
      expected_version: expectedVersion,
      item_kind: { type: 'string', enum: ['temporary_identity', 'medication_administration', 'specimen_collection', 'transfusion_verification', 'other'] },
      action_id: { type: 'string', enum: ['mar.administration.backfill', 'lab.specimen_collection.backfill', 'blood.transfusion_verification.backfill'], nullable: true },
      original_actor_uid: nullableUuid,
      original_actor_role: { type: 'string', nullable: true, maxLength: 80 },
      occurred_at: nullableDateTime,
      patient_uid: nullableUuid,
      temporary_identity_id: nullableUuid,
      encounter_id: nullableUuid,
      evidence_hash: sha256,
    },
  },
  ClinicalContinuityMarBackfillRequest: {
    type: 'object', additionalProperties: false,
    required: [...commonPaperRequired, 'admission_id', 'medication_administration_id', 'checker_uid', 'checker_role'],
    properties: {
      ...commonPaperProperties,
      admission_id: { type: 'integer', minimum: 1 },
      medication_administration_id: { type: 'integer', minimum: 1 },
      checker_uid: uuid,
      checker_role: { type: 'string', minLength: 1, maxLength: 80 },
      notes: { type: 'string', nullable: true, maxLength: 2000 },
    },
  },
  ClinicalContinuityLabBackfillRequest: {
    type: 'object', additionalProperties: false,
    required: [...commonPaperRequired, 'investigation_id', 'specimen_barcode', 'checker_uid', 'checker_role'],
    properties: {
      ...commonPaperProperties,
      investigation_id: { type: 'integer', minimum: 1 },
      specimen_barcode: { type: 'string', minLength: 1, maxLength: 100 },
      checker_uid: uuid,
      checker_role: { type: 'string', minLength: 1, maxLength: 80 },
      collection_notes: { type: 'string', nullable: true, maxLength: 2000 },
    },
  },
  ClinicalContinuityTransfusionBackfillRequest: {
    type: 'object', additionalProperties: false,
    required: [...commonPaperRequired, 'blood_request_id', 'blood_unit_id', 'first_verifier_uid', 'second_verifier_uid', 'scanned_unit_number', 'unit_match', 'patient_match', 'group_compatible', 'expiry_ok'],
    properties: {
      ...commonPaperProperties,
      encounter_id: uuid,
      blood_request_id: { type: 'integer', minimum: 1 },
      blood_unit_id: { type: 'integer', minimum: 1 },
      first_verifier_uid: uuid,
      second_verifier_uid: uuid,
      scanned_unit_number: { type: 'string', minLength: 1, maxLength: 60 },
      unit_match: { type: 'boolean' }, patient_match: { type: 'boolean' },
      group_compatible: { type: 'boolean' }, expiry_ok: { type: 'boolean' },
    },
  },
  ClinicalContinuityCommandResult: {
    type: 'object',
    additionalProperties: true,
    properties: {
      disposition: { type: 'string', enum: ['declared', 'split_brain_needs_review', 'registered', 'applied', 'needs_review', 'exact_duplicate'] },
      client_event_id: nullableUuid,
      outcome_code: { type: 'string', nullable: true },
      replayed: { type: 'boolean', nullable: true },
      incident: { $ref: '#/components/schemas/ClinicalContinuityIncident' },
      paper_item: { $ref: '#/components/schemas/ClinicalContinuityPaperItem' },
    },
  },
  ClinicalContinuityCommandResponse: envelope('ClinicalContinuityCommandResult'),
  ClinicalContinuityDecisionRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version', 'decision', 'reason_code'],
    properties: {
      expected_version: expectedVersion,
      decision: { type: 'string', enum: ['accept', 'exclude', 'assign', 'handoff', 'reopen', 'supersede'] },
      reason_code: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
  ClinicalContinuityIncidentTransitionRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version', 'next_state'],
    properties: {
      expected_version: expectedVersion,
      next_state: { $ref: '#/components/schemas/ClinicalContinuityIncidentState' },
    },
  },
  ClinicalContinuityRangeDispositionRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version', 'disposition', 'reason_code'],
    properties: {
      expected_version: expectedVersion,
      disposition: { type: 'string', enum: ['in_use', 'accounted', 'lost', 'revoked', 'exhausted'] },
      reason_code: { type: 'string', minLength: 1, maxLength: 120 },
      last_accounted_number: { type: 'integer', minimum: 1, nullable: true },
    },
  },
  ClinicalContinuityIncidentAliasRequest: {
    type: 'object', additionalProperties: false,
    required: ['observed_incident_id', 'canonical_incident_id', 'expected_version', 'reason_code'],
    properties: {
      observed_incident_id: uuid,
      canonical_incident_id: uuid,
      expected_version: expectedVersion,
      reason_code: { type: 'string', minLength: 1, maxLength: 120 },
      supersedes_alias_id: nullableUuid,
    },
  },
  ClinicalContinuityDeviceOffsetRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version', 'required_high_water_mark', 'disposition'],
    properties: {
      expected_version: { type: 'integer', minimum: 0 },
      required_high_water_mark: { type: 'integer', minimum: 0 },
      observed_high_water_mark: { type: 'integer', minimum: 0, nullable: true },
      disposition: { type: 'string', enum: ['pending', 'reconciled', 'lost_assigned', 'not_applicable'] },
    },
  },
  ClinicalContinuityInterfaceRequirementRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version', 'interface_family', 'direction', 'source_partition', 'disposition'],
    properties: {
      expected_version: { type: 'integer', minimum: 0 },
      offset_id: nullableUuid,
      interface_family: { type: 'string', minLength: 1, maxLength: 8 },
      direction: { type: 'string', minLength: 1, maxLength: 16 },
      source_partition: { type: 'string', minLength: 1, maxLength: 160 },
      required_generation: { type: 'integer', minimum: 0, nullable: true },
      required_high_water_position: { type: 'integer', minimum: 0, nullable: true },
      required_high_water_token: { type: 'string', maxLength: 255, nullable: true },
      disposition: { type: 'string', enum: ['pending', 'reconciled', 'not_applicable', 'assigned_gap'] },
    },
  },
  ClinicalContinuityHeldMessageBindRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'incident_interface_id',
      'interface_family',
      'message_id',
      'expected_incident_interface_version',
      'expected_source_state_fingerprint',
    ],
    properties: {
      incident_interface_id: uuid,
      interface_family: { $ref: '#/components/schemas/ClinicalContinuityHeldMessageFamily' },
      message_id: bigintPositive,
      expected_incident_interface_version: expectedVersion,
      expected_source_state_fingerprint: sha256,
    },
  },
  ClinicalContinuityHeldMessageAttestationRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'expected_version',
      'release_reason_code',
      'release_reason_detail',
      'expected_source_state_fingerprint',
    ],
    properties: {
      expected_version: expectedVersion,
      release_reason_code: { $ref: '#/components/schemas/ClinicalContinuityHeldMessageReleaseReason' },
      release_reason_detail: { type: 'string', minLength: 10, maxLength: 500 },
      expected_source_state_fingerprint: sha256,
    },
  },
  ClinicalContinuityHeldMessageReleaseRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'expected_version',
      'release_reason_code',
      'release_reason_detail',
      'expected_source_state_fingerprint',
    ],
    properties: {
      expected_version: expectedVersion,
      release_reason_code: { $ref: '#/components/schemas/ClinicalContinuityHeldMessageReleaseReason' },
      release_reason_detail: { type: 'string', minLength: 10, maxLength: 500 },
      expected_source_state_fingerprint: sha256,
      safety_attestation_id: nullableUuid,
    },
  },
  ClinicalContinuityHeldMessageCommandResult: {
    type: 'object',
    additionalProperties: true,
    properties: {
      disposition: { type: 'string', enum: ['applied', 'exact_duplicate'] },
      item: { $ref: '#/components/schemas/ClinicalContinuityReconciliationItem' },
      receipt_id: nullableUuid,
      effect_evidence_id: nullableUuid,
      audit_event_id: nullableUuid,
      decision_id: nullableUuid,
      command_fingerprint: { ...sha256, nullable: true },
      outcome_code: { type: 'string', nullable: true },
      prior_authority_state: { type: 'object', additionalProperties: true, nullable: true },
      next_authority_state: { type: 'object', additionalProperties: true, nullable: true },
      network_send_performed: { type: 'boolean', enum: [false], nullable: true },
    },
  },
  ClinicalContinuityHeldMessageCommandResponse: envelope('ClinicalContinuityHeldMessageCommandResult'),
  ClinicalContinuityIdentityMatchRequest: {
    type: 'object', additionalProperties: false,
    required: ['packet_id', 'paper_item_row_id', 'temporary_identity_id', 'target_patient_uid'],
    properties: {
      packet_id: uuid,
      paper_item_row_id: uuid,
      temporary_identity_id: uuid,
      target_patient_uid: uuid,
      note: { type: 'string', maxLength: 2000, nullable: true },
    },
  },
  ClinicalContinuityIdentityApprovalRequest: {
    type: 'object', additionalProperties: false,
    properties: { note: { type: 'string', maxLength: 2000, nullable: true } },
  },
  ClinicalContinuityAdminCommandResult: {
    type: 'object', additionalProperties: true,
  },
  ClinicalContinuityAdminCommandResponse: envelope('ClinicalContinuityAdminCommandResult'),
  ClinicalContinuityClosure: {
    type: 'object', additionalProperties: true,
    required: ['eligible', 'incident', 'predicate_snapshot_hash', 'blockers', 'attestations'],
    properties: {
      eligible: { type: 'boolean' },
      incident: { $ref: '#/components/schemas/ClinicalContinuityIncident' },
      predicate_snapshot_hash: sha256,
      blockers: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['code'], properties: { code: { type: 'string' } } } },
      attestations: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },
  ClinicalContinuityClosureResponse: envelope('ClinicalContinuityClosure'),
  ClinicalContinuityAttestationRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version', 'attestation_kind'],
    properties: { expected_version: expectedVersion, attestation_kind: { type: 'string', enum: ['operational', 'clinical'] } },
  },
  ClinicalContinuityCloseRequest: {
    type: 'object', additionalProperties: false,
    required: ['expected_version'], properties: { expected_version: expectedVersion },
  },
  ExternalRecoveryOperabilityActionReceipt: {
    type: 'object', additionalProperties: true,
    required: ['action_id', 'action', 'command_class', 'outcome', 'effect_identity', 'command_fingerprint', 'recorded_at'],
    properties: {
      action_id: uuid,
      action: { type: 'string', enum: ['register_offset', 'authorize_resume'] },
      command_class: { type: 'string', enum: ['register_paused_offset', 'register_marker_absent_offset', 'authorize_partition_resume'] },
      outcome: { type: 'string', enum: ['applied', 'refused_stale', 'refused_drift', 'refused_policy', 'refused_scope', 'infrastructure_failure'] },
      disposition: { type: 'string', enum: ['applied', 'exact_duplicate'] },
      offset_id: nullableUuid,
      effect_identity: sha256,
      command_fingerprint: sha256,
      audit_event_id: nullableUuid,
      recorded_at: dateTime,
    },
  },
  ExternalRecoveryOperabilityOffset: {
    type: 'object', additionalProperties: false,
    required: [
      'tenant_id', 'offset_id', 'facility_scope', 'facility_id',
      'interface_family', 'direction', 'source_partition', 'generation',
      'recovery_state', 'state_fingerprint', 'capabilities',
      'refusal_reasons', 'observations',
    ],
    properties: {
      tenant_id: uuid,
      offset_id: uuid,
      facility_scope: { type: 'string', enum: ['tenant', 'facility'] },
      facility_id: { type: 'integer', minimum: 1, nullable: true },
      interface_family: { type: 'string', pattern: '^I(?:0[1-9]|[12][0-9]|30)$' },
      direction: { type: 'string', enum: ['inbound', 'outbound'] },
      source_partition: { type: 'string', minLength: 1, maxLength: 160 },
      generation: { type: 'integer', minimum: 1 },
      high_water_position: { ...bigintNonNegative, nullable: true },
      high_water_token: { type: 'string', maxLength: 255, nullable: true },
      retained_from_position: { ...bigintNonNegative, nullable: true },
      retained_from_token: { type: 'string', maxLength: 255, nullable: true },
      resume_cutoff_position: { ...bigintNonNegative, nullable: true },
      resume_cutoff_token: { type: 'string', maxLength: 255, nullable: true },
      recovery_state: { type: 'string' },
      reconciliation_reason: { type: 'string', nullable: true },
      policy_version: { type: 'string' },
      retention_policy: { type: 'string' },
      retention_until: dateTime,
      intake_retired_at: nullableDateTime,
      state_fingerprint: sha256,
      command_class: { type: 'string' },
      capabilities: {
        type: 'object', additionalProperties: false,
        required: ['can_authorize_resume'],
        properties: { can_authorize_resume: { type: 'boolean' } },
      },
      refusal_reasons: { type: 'array', items: { type: 'string' } },
      observations: {
        type: 'object', additionalProperties: false,
        required: [
          'pending_rows', 'oldest_pending_age_seconds', 'dead_rows',
          'unacknowledged_critical_reviews', 'oldest_unacknowledged_age_seconds',
        ],
        properties: {
          pending_rows: { type: 'integer', minimum: 0 },
          oldest_pending_age_seconds: { type: 'number', minimum: 0 },
          dead_rows: { type: 'integer', minimum: 0 },
          unacknowledged_critical_reviews: { type: 'integer', minimum: 0 },
          oldest_unacknowledged_age_seconds: { type: 'number', minimum: 0 },
        },
      },
      latest_command_receipt: {
        allOf: [{ $ref: '#/components/schemas/ExternalRecoveryOperabilityActionReceipt' }],
        nullable: true,
      },
    },
  },
  ExternalRecoveryOperabilityWorkbench: {
    type: 'object', additionalProperties: false,
    required: ['offsets', 'count', 'capabilities'],
    properties: {
      offsets: { type: 'array', items: { $ref: '#/components/schemas/ExternalRecoveryOperabilityOffset' } },
      count: { type: 'integer', minimum: 0 },
      capabilities: {
        type: 'object', additionalProperties: false,
        required: ['can_register_exact_partition', 'supports_predicate_bulk_mutation'],
        properties: {
          can_register_exact_partition: { type: 'boolean' },
          supports_predicate_bulk_mutation: { type: 'boolean', enum: [false] },
        },
      },
    },
  },
  ExternalRecoveryOperabilityWorkbenchResponse: envelope('ExternalRecoveryOperabilityWorkbench'),
  ExternalRecoveryOperabilityRegisterRequest: {
    type: 'object', additionalProperties: false,
    required: [
      'interface_family', 'source_partition', 'generation',
      'policy_version', 'policy_signature', 'retention_policy', 'retention_until',
      'owner_evidence_reference', 'owner_evidence_signature',
      'reason_code', 'reason_detail',
    ],
    properties: {
      interface_family: { type: 'string', pattern: '^I(?:0[1-9]|[12][0-9]|30)$' },
      subpath: { type: 'string', maxLength: 80, nullable: true },
      protocol: { type: 'string', maxLength: 40, nullable: true },
      stream_direction: { type: 'string', enum: ['inbound', 'outbound'], nullable: true },
      source_partition: { type: 'string', minLength: 1, maxLength: 160 },
      generation: { type: 'integer', minimum: 1 },
      facility_id: { type: 'integer', minimum: 1, nullable: true },
      initial_position: { ...bigintNonNegative, nullable: true },
      initial_token: { type: 'string', maxLength: 255, nullable: true },
      retained_from_position: { ...bigintNonNegative, nullable: true },
      retained_from_token: { type: 'string', maxLength: 255, nullable: true },
      policy_version: { type: 'string', minLength: 1, maxLength: 80 },
      policy_signature: { type: 'string', minLength: 1, maxLength: 128 },
      retention_policy: { type: 'string', minLength: 1, maxLength: 80 },
      retention_until: dateTime,
      owner_evidence_reference: { type: 'string', minLength: 1, maxLength: 255 },
      owner_evidence_signature: { type: 'string', minLength: 1, maxLength: 512 },
      reason_code: { type: 'string', enum: ['initial_marker_reconciled', 'retained_range_verified', 'marker_absence_recorded'] },
      reason_detail: { type: 'string', minLength: 10, maxLength: 500 },
    },
  },
  ExternalRecoveryOperabilityResumeRequest: {
    type: 'object', additionalProperties: false,
    required: [
      'expected_state_fingerprint', 'resume_cutoff_position', 'resume_cutoff_token',
      'owner_evidence_reference', 'owner_evidence_signature', 'reason_code', 'reason_detail',
    ],
    properties: {
      expected_state_fingerprint: sha256,
      resume_cutoff_position: bigintNonNegative,
      resume_cutoff_token: { type: 'string', minLength: 1, maxLength: 255 },
      owner_evidence_reference: { type: 'string', minLength: 1, maxLength: 255 },
      owner_evidence_signature: { type: 'string', minLength: 1, maxLength: 512 },
      reason_code: { type: 'string', enum: ['resume_cutoff_reconciled', 'source_count_reconciled', 'owner_recovery_evidence_reconciled'] },
      reason_detail: { type: 'string', minLength: 10, maxLength: 500 },
    },
  },
  ExternalRecoveryOperabilityCommandResponse: envelope('ExternalRecoveryOperabilityActionReceipt'),
};

const base = '/api/v1/downtime/reconciliation';
const paperParams = { incidentId: uuid, paperItemId: { type: 'string', minLength: 1, maxLength: 128 } };

// Every operation below sits behind requireClinicalContinuityReconciliationContext, which
// requires clinicalContinuityPaperReconciliationEnabled() -- a chain that bottoms out on the
// hardcoded-false CLINICAL_CONTINUITY_C_D14_APPROVED constant. No deployment configuration can
// flip it, so every operation in this file currently always responds 503
// CONTINUITY_PAPER_RECONCILIATION_UNAVAILABLE and also requires a valid per-request
// x-vh-continuity-facility-id / x-vh-continuity-facility-context header pair once activated.
// (Restated on each description below -- this source comment never reaches the emitted spec.)
const ALWAYS_503 =
  ' Currently always responds 503 CONTINUITY_PAPER_RECONCILIATION_UNAVAILABLE -- the compile-' +
  'time C-D14 activation gate is hardcoded false in this codebase and no deployment ' +
  'configuration can override it.';

const externalRecoveryBase = '/api/v1/admin/continuity/external-recovery';
const externalRecoveryIdempotencyKey = {
  name: 'Idempotency-Key', in: 'header', required: true,
  schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9_\\-:.]+$' },
};

export const operations = {
  [`GET ${externalRecoveryBase}/workbench`]: {
    summary: 'Read external-recovery operability state',
    description: 'Returns current-tenant external-recovery partition state, server-derived command capabilities, safe marker evidence, command receipts, and output observations. Visibility does not grant offset authority and no source payload, ciphertext, secret, or credential is returned.',
    response: 'ExternalRecoveryOperabilityWorkbenchResponse',
  },
  [`POST ${externalRecoveryBase}/offsets`]: {
    summary: 'Register one exact external-recovery partition',
    description: 'Registers one exact implemented HWM partition as paused or marker-missing and atomically appends operator/audit evidence. It performs no family activation, worker start, replay, dispatch, cursor advance, clinical effect, or notification.',
    parameters: [externalRecoveryIdempotencyKey], request: 'ExternalRecoveryOperabilityRegisterRequest',
    response: 'ExternalRecoveryOperabilityCommandResponse', responseStatus: 201,
  },
  [`POST ${externalRecoveryBase}/offsets/{offsetId}/resume-authorizations`]: {
    summary: 'Authorize one exact external-recovery partition resume',
    description: 'Authorizes replay only for the exact paused offset, generation, state fingerprint, and cutoff marker and atomically appends operator/audit evidence. It performs no worker start, item claim, cursor advance, retrospective alert, pathway, SLA, or notification effect.',
    pathParameters: { offsetId: uuid }, parameters: [externalRecoveryIdempotencyKey],
    request: 'ExternalRecoveryOperabilityResumeRequest',
    response: 'ExternalRecoveryOperabilityCommandResponse', responseStatus: 201,
  },
  [`GET ${base}/workbench`]: {
    summary: "Read the reconciliation workbench for the caller's facility",
    description:
      "Returns the facility-scoped C5.2 workbench, including typed interface held-message items. " +
      'Visibility does not grant release authority, payload/ciphertext is not returned, and I18 ' +
      "remains excluded. Read-only snapshot of the clinical-continuity reconciliation workbench for the caller's " +
      'facility, gated to a fixed set of continuity-admin/records/clinical-safety-lead roles. ' +
      'Returns incidents in every lifecycle state -- not just open ones -- optionally filtered to ' +
      'one via `incident_id`; paper items and reconciliation-queue items are capped at 500 rows ' +
      'and, for non-admin/non-safety-lead callers, limited to items they authored or are ' +
      'assigned to, while packets, paper ranges, temporary identities, device offsets, and ' +
      'interface requirements are populated only for admin or safety-lead callers.' + ALWAYS_503,
    response: 'ClinicalContinuityWorkbenchResponse',
  },
  [`POST ${base}/incident-packet-contact-sheets`]: {
    summary: 'Create a versioned incident-packet contact sheet',
    description:
      'Creates append-only phone-tree/contact content under the active signed v4 policy. It ' +
      'does not approve the sheet, mint a packet, reserve a paper range, or activate C5.2.' + ALWAYS_503,
    request: 'ClinicalContinuityIncidentContactSheetRequest',
    response: 'ClinicalContinuityIncidentPacketCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incident-packet-contact-sheets/{contactSheetId}/approve`]: {
    summary: 'Approve an incident-packet contact sheet',
    description:
      'A policy-configured actor distinct from the creator appends approval for one exact contact ' +
      'sheet version and checksum. It creates no packet or incident.' + ALWAYS_503,
    pathParameters: { contactSheetId: uuid },
    response: 'ClinicalContinuityIncidentPacketCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incident-packets/provision`]: {
    summary: 'Provision a signed one-use incident packet',
    description:
      'Server-mints the packet and reserved incident UUID, allocates a disjoint paper range, ' +
      'obtains and locally verifies an operator-injected Ed25519 signature, and stores the ' +
      'controlled artifact and generated custody evidence. Every timing, range, role, key, ' +
      'contact, and copy value comes from the active signed v4 policy. No incident is declared.' + ALWAYS_503,
    request: 'ClinicalContinuityIncidentPacketProvisionRequest',
    response: 'ClinicalContinuityIncidentPacketCommandResponse', responseStatus: 201,
  },
  [`GET ${base}/incident-packets/{packetId}/artifact`]: {
    summary: 'Read a controlled incident-packet artifact',
    description:
      'Returns the exact stored, checksum-bound no-PHI artifact, including its visible exclusive ' +
      'NOT VALID AFTER boundary. Reading it records no custody and grants no incident authority.' + ALWAYS_503,
    pathParameters: { packetId: uuid },
    response: 'ClinicalContinuityIncidentPacketArtifactResponse',
  },
  [`POST ${base}/incident-packets/{packetId}/custody`]: {
    summary: 'Append incident-packet custody evidence',
    description:
      'Appends download, print, handover, receipt, or destruction custody evidence under the distinct signed-policy ' +
      'custodian capability. Received custody is required before use; for a replacement, it is ' +
      'also the event that revokes the old packet.' + ALWAYS_503,
    pathParameters: { packetId: uuid },
    request: 'ClinicalContinuityIncidentPacketCustodyRequest',
    response: 'ClinicalContinuityIncidentPacketCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incident-packets/{packetId}/refresh`]: {
    summary: 'Provision a replacement incident packet',
    description:
      'Mints a wholly new packet, incident UUID, signature, artifact, and paper range. It never ' +
      'extends the original validity window; the old packet remains usable until replacement ' +
      'receipt custody is recorded, then is revoked atomically.' + ALWAYS_503,
    pathParameters: { packetId: uuid },
    request: 'ClinicalContinuityIncidentPacketProvisionRequest',
    response: 'ClinicalContinuityIncidentPacketCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incident-packets/{packetId}/revoke`]: {
    summary: 'Revoke an unused incident packet',
    description:
      'Applies the one permitted terminal revocation transition with a reason under signed-policy ' +
      'issuer authority. It cannot revive or rewrite packet evidence.' + ALWAYS_503,
    pathParameters: { packetId: uuid }, request: 'ClinicalContinuityIncidentPacketRevokeRequest',
    response: 'ClinicalContinuityIncidentPacketCommandResponse',
  },
  [`POST ${base}/incidents/{incidentId}/interface-held-messages`]: {
    summary: 'Bind one held interface message to continuity reconciliation',
    description:
      'Binds one exact held I04, I05, or non-payment outbound I19 message to an existing ' +
      'incident-interface requirement and creates or returns its C5.2 interface item/task. It ' +
      'performs no release, dispatch, ACK, cursor, payment, pathway, SLA, or notification effect.' +
      ALWAYS_503,
    pathParameters: { incidentId: uuid },
    request: 'ClinicalContinuityHeldMessageBindRequest',
    response: 'ClinicalContinuityHeldMessageCommandResponse',
    responseStatus: 201,
  },
  [`POST ${base}/reconciliation-items/{itemId}/held-message-release/attestations`]: {
    summary: 'Attest a safety-critical held-message release',
    description:
      'The configured clinical safety lead co-attests one exact safety-critical held-release ' +
      'fingerprint. It performs no authority flip or dispatch, and the attester must differ from ' +
      'the interface releaser.' + ALWAYS_503,
    pathParameters: { itemId: uuid },
    request: 'ClinicalContinuityHeldMessageAttestationRequest',
    response: 'ClinicalContinuityHeldMessageCommandResponse',
    responseStatus: 201,
  },
  [`POST ${base}/reconciliation-items/{itemId}/held-message-release`]: {
    summary: 'Release send authority for one bound held message',
    description:
      'The current configured interface owner releases one exact bound held message by claiming/' +
      'finalizing the C5.1 receipt and atomically recording exact prior/next authority. Exact ' +
      'duplicates return the prior outcome; drift fails closed; no network send, ACK, cursor, ' +
      'payment, pathway, SLA, or notification effect occurs in the command.' + ALWAYS_503,
    pathParameters: { itemId: uuid },
    request: 'ClinicalContinuityHeldMessageReleaseRequest',
    response: 'ClinicalContinuityHeldMessageCommandResponse',
    responseStatus: 201,
  },
  [`POST ${base}/incidents/declare`]: {
    summary: 'Declare a clinical-continuity incident in real time',
    description:
      "Declares a new clinical-continuity incident online (declarationSource='online'), " +
      "verifying the pre-reserved packet's signed canonical hash and signature as proof of " +
      'authorization; restricted to SUPER_ADMIN/ADMIN/CMO/MEDICAL_SUPERINTENDENT/QUALITY_OFFICER. ' +
      "Mutates: returns 201 with disposition 'declared', or still 201 with " +
      "'split_brain_needs_review' if another canonical incident is already open for the " +
      "facility, or 200 'exact_duplicate' on replay of an already-used packet." + ALWAYS_503,
    request: 'ClinicalContinuityDeclareRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incidents/import`]: {
    summary: 'Import an incident declaration made while offline',
    description:
      "Imports a clinical-continuity incident declaration made offline (declarationSource=" +
      "'offline_import'), reusing declare's packet-hash verification, its SUPER_ADMIN/ADMIN/" +
      'CMO/MEDICAL_SUPERINTENDENT/QUALITY_OFFICER role restriction, and its full disposition set ' +
      '-- declared, split_brain_needs_review (both 201), or exact_duplicate (200).' + ALWAYS_503,
    request: 'ClinicalContinuityDeclareRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`PATCH ${base}/incidents/{incidentId}/state`]: {
    summary: "Transition an incident's lifecycle state",
    description:
      "Mutates one incident's lifecycle state forward one step at a time -- only declared to " +
      "restored, or restored to reconciling; `next_state: 'closed'` is rejected with 400 " +
      'CONTINUITY_INCIDENT_TRANSITION_INVALID, since closing is exclusively handled by the ' +
      'separate closure/close endpoint. Runs under optimistic concurrency (`expected_version`) ' +
      'and is restricted to SUPER_ADMIN/ADMIN/CMO/MEDICAL_SUPERINTENDENT/QUALITY_OFFICER.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, request: 'ClinicalContinuityIncidentTransitionRequest', response: 'ClinicalContinuityAdminCommandResponse',
  },
  [`POST ${base}/incidents/{incidentId}/range-disposition`]: {
    summary: "Record a paper number-range's accounting disposition",
    description:
      'Mutates the accounting disposition of a reserved paper-form number range to one of lost, ' +
      'revoked, accounted, or exhausted -- not in_use, which is the range\'s automatic starting ' +
      'status set at incident declaration -- with a mandatory reason code and, when applicable, ' +
      'the last accounted form number; each of the four is terminal, so a second call 409s ' +
      'CONTINUITY_PAPER_RANGE_TERMINAL. Runs under optimistic concurrency and is restricted to ' +
      'SUPER_ADMIN/ADMIN/CMO/MEDICAL_SUPERINTENDENT/QUALITY_OFFICER.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, request: 'ClinicalContinuityRangeDispositionRequest', response: 'ClinicalContinuityAdminCommandResponse',
  },
  [`POST ${base}/incident-aliases`]: {
    summary: 'Record that one incident id is an alias of another',
    description:
      'Mutates: appends an owner-directed decision (SUPER_ADMIN/ADMIN/CMO/MEDICAL_SUPERINTENDENT' +
      "/QUALITY_OFFICER only) that one observed incident id is an alias of a canonical incident, " +
      "then re-points the observed incident's own canonical_incident_id/alias_disposition to " +
      'match -- resolving a split-brain declaration where the same outage was independently ' +
      "declared under two ids -- under optimistic concurrency keyed to the observed incident's " +
      '`expected_version`. Can chain onto a prior alias decision via `supersedes_alias_id`.' + ALWAYS_503,
    request: 'ClinicalContinuityIncidentAliasRequest', response: 'ClinicalContinuityAdminCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incidents/{incidentId}/paper-items/{paperItemId}`]: {
    summary: 'Register a paper-captured item against an incident',
    description:
      'Mutates: registers a generic paper-captured item against an incident, ahead of the ' +
      'specific back-entry command that applies its clinical fact; role required depends on the ' +
      "item kind/declared action. Returns 201 on a clean registration, 200 with disposition " +
      "'exact_duplicate' on an exact-payload replay, or -- notably still 201, not an error " +
      "status -- disposition 'needs_review' when the same paper_item_id already exists with " +
      'different content, which also opens a safety-critical reconciliation-queue item. When ' +
      'patient-bound, runs the same PHI-tier patient-access authorization the online clinical ' +
      'workflow would require.' + ALWAYS_503,
    pathParameters: paperParams, request: 'ClinicalContinuityRegisterPaperItemRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incidents/{incidentId}/paper-items/{paperItemId}/mar-administration`]: {
    summary: 'Back-enter a paper medication-administration fact',
    description:
      'Mutates: applies a retrospective medication-administration fact captured on paper during ' +
      'an outage onto the canonical clinical record, including updating the underlying ' +
      'medication_administrations row through the canonical MAR transaction core when it is still ' +
      'scheduled or held. The paper command must bind the exact admission and a distinct, currently ' +
      'authorized checker; it cannot claim a barcode scan or electronic override. Patient-' +
      'access-authorized and naturally idempotent on (incident id, paper item id, payload ' +
      'fingerprint); a client `Idempotency-Key` header, if sent, is only recorded in the attempt ' +
      "audit log and does not itself drive replay detection. Returns 409 with disposition " +
      "'needs_review' when it cannot be reconciled automatically, and 200 on replay of an " +
      'already-applied fact.' + ALWAYS_503,
    pathParameters: paperParams, request: 'ClinicalContinuityMarBackfillRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incidents/{incidentId}/paper-items/{paperItemId}/lab-specimen-collection`]: {
    summary: 'Back-enter a paper specimen-collection fact',
    description:
      'Mutates: applies a retrospective specimen-collection fact captured on paper during an ' +
      'outage onto the canonical clinical record, including updating the underlying ' +
      'investigations row itself when collection is still pending. A distinct, currently authorized ' +
      'checker is required by the C4.2 paper contract. Patient-access-authorized ' +
      'and naturally idempotent on (incident id, paper item id, payload fingerprint); an ' +
      '`Idempotency-Key` header, if sent, is only recorded in the attempt audit log and does not ' +
      "itself drive replay detection. Returns 409 with disposition 'needs_review' when it " +
      'cannot be reconciled automatically, and 200 on replay of an already-applied fact.' + ALWAYS_503,
    pathParameters: paperParams, request: 'ClinicalContinuityLabBackfillRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incidents/{incidentId}/paper-items/{paperItemId}/blood-transfusion-verification`]: {
    summary: 'Back-enter a paper blood-transfusion verification fact',
    description:
      'Mutates: records a retrospective blood-transfusion verification fact -- the two-verifier ' +
      'unit/patient/group-compatibility/expiry checks normally performed at the bedside -- as ' +
      'canonical-timeline/audit evidence for an outage, checked for consistency against any ' +
      'already-recorded electronic verification. Unlike the MAR and lab back-entry commands, it ' +
      'never writes a transfusion_verifications row itself. Both verifiers must still be currently ' +
      'authorized, encounter identity is mandatory, and no override field is accepted. Patient-access-authorized and ' +
      'idempotent on (incident id, paper item id, payload fingerprint) rather than on the ' +
      "`Idempotency-Key` header, which is only logged; returns 409 with disposition " +
      "'needs_review' on conflict and 200 on replay." + ALWAYS_503,
    pathParameters: paperParams, request: 'ClinicalContinuityTransfusionBackfillRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/reconciliation-items/{itemId}/decision`]: {
    summary: 'Decide a reconciliation-queue item',
    description:
      'Mutates: records an owner decision -- accept, exclude, assign, handoff, reopen, or ' +
      'supersede -- with a mandatory reason code on one item in the post-incident reconciliation ' +
      'queue (the needs-review, identity, or interface work generated while the outage was ' +
      'live). Runs under optimistic concurrency.' + ALWAYS_503,
    pathParameters: { itemId: uuid }, request: 'ClinicalContinuityDecisionRequest', response: 'ClinicalContinuityCommandResponse',
  },
  [`PUT ${base}/incidents/{incidentId}/devices/{deviceId}/offset`]: {
    summary: "Record a device's reconciliation high-water-mark evidence",
    description:
      'Mutates (idempotent PUT, not create-only): records or updates the required-versus-' +
      "observed high-water-mark evidence for one offline device's local event log against an " +
      'incident, and its reconciliation disposition (pending, reconciled, lost data assigned to ' +
      'a person, or not applicable). Runs under optimistic concurrency.' + ALWAYS_503,
    pathParameters: { incidentId: uuid, deviceId: uuid }, request: 'ClinicalContinuityDeviceOffsetRequest', response: 'ClinicalContinuityAdminCommandResponse',
  },
  [`PUT ${base}/incidents/{incidentId}/interfaces/requirement`]: {
    summary: "Record an interface's reconciliation replay requirement",
    description:
      'Mutates (idempotent PUT, not create-only): records or updates the required external-' +
      'interface replay position -- generation, high-water position, and token -- that must be ' +
      "reached to close out one incident's interface reconciliation, and its disposition " +
      '(pending, reconciled, not applicable, or assigned as a gap). Runs under optimistic ' +
      'concurrency.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, request: 'ClinicalContinuityInterfaceRequirementRequest', response: 'ClinicalContinuityAdminCommandResponse',
  },
  [`POST ${base}/incidents/{incidentId}/identity-matches`]: {
    summary: 'Propose merging a temporary identity into a patient record',
    description:
      'Mutates: proposes merging a paper-captured temporary patient identity from this incident ' +
      'into an existing patient record; restricted to front-desk/records/admin roles ' +
      '(SUPER_ADMIN, ADMIN, MEDICAL_RECORDS, RECEPTIONIST, RECEPTION_INCHARGE, ADMISSION_OFFICER) ' +
      "and only while the incident is 'restored' or 'reconciling'. The first step of a " +
      'three-step propose, approve, execute merge workflow -- it only creates a pending merge ' +
      'request and does not itself merge anything. Returns 201.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, request: 'ClinicalContinuityIdentityMatchRequest', response: 'ClinicalContinuityAdminCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/identity-matches/{mergeId}/approve`]: {
    summary: 'Approve a proposed temporary-identity merge',
    description:
      "Mutates: records a clinically-qualified second actor's sign-off approving a previously " +
      "proposed temporary-identity merge -- the approver must be the facility's configured " +
      'clinical safety lead, or a treating-clinician role who is actually on that specific ' +
      "patient's active care team or open encounter (not just any doctor), and must differ from " +
      'the original requester. Does not execute the merge -- approval and execution are separate ' +
      'steps so a merge can be reviewed before it is applied.' + ALWAYS_503,
    pathParameters: { mergeId: { type: 'integer', minimum: 1 } }, request: 'ClinicalContinuityIdentityApprovalRequest', response: 'ClinicalContinuityAdminCommandResponse',
  },
  [`POST ${base}/identity-matches/{mergeId}/execute`]: {
    summary: 'Execute an approved temporary-identity merge',
    description:
      'Mutates: executes an approved temporary-identity merge by marking the temporary identity ' +
      "as matched to the target patient (identity_status='matched', matched_patient_uid set) " +
      'and the merge request as executed -- it does not rewrite or reassign any historical ' +
      'clinical rows (execution_summary.historical_rows_rewritten is hardcoded to 0), unlike the ' +
      "platform's generic patient-merge execution path. Callable only by the same admin/records/" +
      'front-desk roles as the propose step; requires the match to already be recorded as ' +
      'approved by the separate approve endpoint.' + ALWAYS_503,
    pathParameters: { mergeId: { type: 'integer', minimum: 1 } }, response: 'ClinicalContinuityAdminCommandResponse',
  },
  [`GET ${base}/incidents/{incidentId}/closure`]: {
    summary: "Evaluate an incident's closure eligibility",
    description:
      "Read-only evaluation of one incident's closure eligibility: whether every closure " +
      'predicate currently passes, the specific blockers if not, a hash of the predicate ' +
      'snapshot the caller can attest against, and any attestations already recorded -- ' +
      "restricted to INCIDENT_ADMIN_ROLES, the facility's configured clinical safety lead, or " +
      "the incident's own commander (403 CONTINUITY_CLOSURE_ROLE_DENIED otherwise). Does not " +
      'itself change incident state.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, response: 'ClinicalContinuityClosureResponse',
  },
  [`POST ${base}/incidents/{incidentId}/closure/attestations`]: {
    summary: "Attest to an incident's closure predicate",
    description:
      "Mutates: records one closure attestation against an incident's current closure-predicate " +
      "snapshot, but only from a specific actor -- 'operational' only from the incident's own " +
      "commander, 'clinical' only from the facility's configured clinical safety lead -- and " +
      'the two must be different people (409 CONTINUITY_CLOSURE_ACTOR_SEPARATION_REQUIRED ' +
      'otherwise). Blocked with 409 CONTINUITY_CLOSURE_BLOCKED while the predicate still has ' +
      'open blockers, and runs under optimistic concurrency.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, request: 'ClinicalContinuityAttestationRequest', response: 'ClinicalContinuityCommandResponse', responseStatus: 201,
  },
  [`POST ${base}/incidents/{incidentId}/closure/close`]: {
    summary: 'Close a clinical-continuity incident',
    description:
      'Mutates: closes an incident -- the terminal lifecycle transition, only reachable from ' +
      "lifecycle_state='reconciling' (409 CONTINUITY_CLOSURE_STATE_INVALID otherwise) -- " +
      "callable only by the facility's configured clinical safety lead, and only when they are " +
      "not the incident's own commander (409 CONTINUITY_CLOSURE_ACTOR_SEPARATION_REQUIRED). " +
      "Requires the commander's 'operational' attestation to already exist, and itself records " +
      "the caller's 'clinical' attestation if not already present, under optimistic " +
      'concurrency.' + ALWAYS_503,
    pathParameters: { incidentId: uuid }, request: 'ClinicalContinuityCloseRequest', response: 'ClinicalContinuityCommandResponse',
  },
};
