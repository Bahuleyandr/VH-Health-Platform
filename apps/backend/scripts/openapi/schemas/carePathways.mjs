import { envelope } from './_helpers.mjs';

const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$',
  },
};

const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const runtimeObject = { type: 'object', additionalProperties: true };
const strictEnvelope = (schemaName) => {
  const base = envelope(schemaName);
  return {
    ...base,
    additionalProperties: false,
    properties: {
      ...base.properties,
      requestId: { type: 'string', minLength: 1, maxLength: 200 },
    },
  };
};
const pathwayModes = ['off', 'shadow', 'active'];
const pendingResultTypes = [
  'investigation',
  'lab_result',
  'radiology_order',
  'anatomical_pathology_case',
  'diagnostic_result_generation',
];
const patientNextStepStatuses = [
  'planned',
  'open',
  'scheduled',
  'pending',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
  'on_hold',
  'overdue',
];
const patientNextStepRouteTokens = [
  'home',
  'health',
  'appointments',
  'book_appointment',
  'investigations',
  'lab_results',
  'diagnostic_results',
  'referrals',
  'discharge_summaries',
  'messages',
];
const staffWorkRouteTokens = [
  'appointments',
  'admissions',
  'prescriptions',
  'clinical_orders',
  'investigations',
  'radiology',
  'anatomical_pathology',
  'diagnostic_results',
  'referrals',
  'follow_up',
  'clinical_notes',
  'discharge_hub',
];
const admissionMounts = ['/api/v1/admissions', '/api/v1/emr'];
const admissionAliases = (methodSuffix, operation) => {
  const separator = methodSuffix.indexOf(' ');
  const method = methodSuffix.slice(0, separator);
  const suffix = methodSuffix.slice(separator + 1);
  return Object.fromEntries(
    admissionMounts.map((mount) => [`${method} ${mount}${suffix}`, operation]),
  );
};
const canonicalPathwayKeys = [
  'diagnostics_order_to_action',
  'referral_request_to_closure',
  'op_contact_to_recovery',
  'inpatient_admission_to_recovery',
  'emergency_arrival_to_aftercare',
  'surgery_decision_to_recovery',
];
const reconciliationQueryParameters = [
  {
    name: 'pathway_key',
    in: 'query',
    required: false,
    schema: { type: 'string', enum: canonicalPathwayKeys },
  },
  {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: 'offset',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
  },
];

export const schemas = {
  CarePathwayStartRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['workflow_definition_id', 'patient_uid', 'pathway_key'],
    properties: {
      workflow_definition_id: { type: 'integer', minimum: 1 },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: nullableUuid,
      pathway_key: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        pattern: '^[a-z][a-z0-9_]{0,119}$',
      },
      context: { type: 'object', nullable: true, additionalProperties: true },
      metadata: { type: 'object', nullable: true, additionalProperties: true },
    },
  },

  CarePathwaySignal: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        pattern: '^[a-z][a-z0-9_]{0,119}$',
      },
      payload: { type: 'object', nullable: true, additionalProperties: true },
    },
  },

  CarePathwayCommandRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['signal'],
    properties: {
      signal: { $ref: '#/components/schemas/CarePathwaySignal' },
    },
  },

  CarePathwayInstance: {
    type: 'object',
    additionalProperties: true,
    required: [
      'id',
      'tenant_id',
      'workflow_run_id',
      'patient_uid',
      'pathway_key',
      'pathway_version',
      'workflow_definition_id',
      'definition_governance_id',
      'definition_checksum',
      'source_episode_type',
      'source_episode_id',
      'accountable_role',
      'clinical_status',
      'patient_visibility_status',
      'metadata',
      'created_at',
      'updated_at',
      'run',
      'steps',
      'tasks',
      'approvals',
      'handoffs',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      tenant_id: { type: 'string', format: 'uuid' },
      workflow_run_id: { type: 'integer', minimum: 1 },
      patient_uid: { type: 'string', format: 'uuid' },
      encounter_id: nullableUuid,
      pathway_key: { type: 'string' },
      pathway_version: { type: 'integer', minimum: 1 },
      workflow_definition_id: { type: 'integer', minimum: 1 },
      definition_governance_id: { type: 'string', format: 'uuid' },
      definition_checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      source_episode_type: { type: 'string' },
      source_episode_id: { type: 'string' },
      parent_instance_id: nullableUuid,
      owning_clinician_uid: nullableUuid,
      owning_team_id: { type: 'integer', nullable: true, minimum: 1 },
      accountable_role: { type: 'string' },
      clinical_status: {
        type: 'string',
        enum: [
          'planned',
          'active',
          'on_hold',
          'completed',
          'cancelled',
          'transferred',
          'entered_in_error',
        ],
      },
      completion_outcome: { type: 'string', nullable: true },
      closure_reason: { type: 'string', nullable: true },
      patient_visibility_status: {
        type: 'string',
        enum: ['hidden', 'staff_only', 'patient_visible', 'withheld'],
      },
      idempotency_key: { type: 'string' },
      activated_at: nullableDateTime,
      closed_at: nullableDateTime,
      created_by: nullableUuid,
      updated_by: nullableUuid,
      metadata: runtimeObject,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      run: runtimeObject,
      steps: { type: 'array', items: runtimeObject },
      tasks: { type: 'array', items: runtimeObject },
      approvals: { type: 'array', items: runtimeObject },
      handoffs: { type: 'array', items: runtimeObject },
    },
  },
  CarePathwayInstanceResponse: envelope('CarePathwayInstance'),

  CarePathwayCommandResult: {
    type: 'object',
    additionalProperties: false,
    required: ['instance', 'events', 'replayed', 'mode'],
    properties: {
      instance: { $ref: '#/components/schemas/CarePathwayInstance' },
      events: { type: 'array', items: runtimeObject },
      replayed: { type: 'boolean' },
      mode: { type: 'string', enum: ['shadow', 'active'] },
    },
  },
  CarePathwayCommandResponse: envelope('CarePathwayCommandResult'),

  CarePathwayOwnerTransferRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['covering_clinician_uid', 'reason'],
    properties: {
      covering_clinician_uid: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 1 },
    },
  },

  CarePathwayOwnerTransferView: {
    type: 'object',
    additionalProperties: false,
    required: [
      'handoff_id',
      'pathway_instance_id',
      'patient_uid',
      'pathway_key',
      'pathway_clinical_status',
      'status',
      'sender_uid',
      'intended_recipient_uid',
      'request_reason',
      'requested_at',
      'accepted_at',
      'declined_at',
      'cancelled_at',
    ],
    properties: {
      handoff_id: { type: 'string', format: 'uuid' },
      pathway_instance_id: { type: 'string', format: 'uuid' },
      patient_uid: { type: 'string', format: 'uuid' },
      pathway_key: { type: 'string', minLength: 1, maxLength: 120 },
      pathway_clinical_status: {
        type: 'string',
        enum: [
          'planned',
          'active',
          'on_hold',
          'completed',
          'cancelled',
          'transferred',
          'entered_in_error',
        ],
      },
      status: {
        type: 'string',
        enum: ['requested', 'accepted', 'declined', 'cancelled'],
      },
      sender_uid: { type: 'string', format: 'uuid' },
      intended_recipient_uid: { type: 'string', format: 'uuid' },
      request_reason: { type: 'string', minLength: 1 },
      requested_at: { type: 'string', format: 'date-time' },
      accepted_at: nullableDateTime,
      declined_at: nullableDateTime,
      cancelled_at: nullableDateTime,
    },
  },
  CarePathwayOwnerTransferViewResponse: envelope('CarePathwayOwnerTransferView'),

  CarePathwayTransferDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 1 },
    },
  },

  CarePathwayOwnershipMutationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['instance', 'events', 'replayed'],
    properties: {
      instance: { $ref: '#/components/schemas/CarePathwayInstance' },
      handoff: { ...runtimeObject, nullable: true },
      task: { ...runtimeObject, nullable: true },
      events: { type: 'array', items: runtimeObject },
      replayed: { type: 'boolean' },
    },
  },
  CarePathwayOwnershipMutationResponse: envelope('CarePathwayOwnershipMutationResult'),

  OpVisitPatientNextStepRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['label'],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 180 },
      explanation: { type: 'string', nullable: true, maxLength: 1200 },
      due_date: { type: 'string', format: 'date', nullable: true },
      status: {
        type: 'string',
        enum: patientNextStepStatuses,
        nullable: true,
      },
      patient_action: { type: 'string', nullable: true, maxLength: 500 },
      route_token: {
        type: 'string',
        enum: patientNextStepRouteTokens,
        nullable: true,
      },
    },
  },

  OpVisitPatientSafeNextStep: {
    type: 'object',
    additionalProperties: false,
    required: [
      'label',
      'explanation',
      'due_date',
      'status',
      'patient_action',
      'route_token',
      'responsible_clinician_display_name',
      'responsible_clinician_role',
      'safe_contact',
    ],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 180 },
      explanation: { type: 'string', nullable: true, maxLength: 1200 },
      due_date: { type: 'string', format: 'date', nullable: true },
      status: { type: 'string', enum: patientNextStepStatuses },
      patient_action: { type: 'string', nullable: true, maxLength: 500 },
      route_token: {
        type: 'string',
        enum: patientNextStepRouteTokens,
        nullable: true,
      },
      responsible_clinician_display_name: {
        type: 'string',
        nullable: true,
      },
      responsible_clinician_role: { type: 'string', nullable: true },
      safe_contact: { type: 'string', nullable: true, maxLength: 320 },
    },
  },

  OpVisitClosureEvidence: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'revision',
      'clinician_uid',
      'follow_up_required',
      'follow_up_plan_id',
      'patient_next_steps',
      'closure_basis',
      'accepted_handoff_id',
      'source_status_history_id',
      'occurred_at',
      'recorded_at',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      revision: { type: 'integer', minimum: 1 },
      clinician_uid: { type: 'string', format: 'uuid' },
      follow_up_required: { type: 'boolean' },
      follow_up_plan_id: { type: 'integer', minimum: 1, nullable: true },
      patient_next_steps: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: { $ref: '#/components/schemas/OpVisitPatientSafeNextStep' },
      },
      closure_basis: {
        type: 'string',
        enum: ['all_required_work_completed', 'named_ownership_accepted', 'accepted_transfer'],
      },
      accepted_handoff_id: nullableUuid,
      source_status_history_id: {
        type: 'string',
        pattern: '^[1-9][0-9]*$',
      },
      occurred_at: { type: 'string', format: 'date-time' },
      recorded_at: { type: 'string', format: 'date-time' },
    },
  },

  AppointmentPathwayWorkBlocker: {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'message'],
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 160 },
      message: { type: 'string', minLength: 1, maxLength: 1000 },
      resource_type: { type: 'string', nullable: true, maxLength: 160 },
      resource_id: { type: 'string', nullable: true, maxLength: 200 },
    },
  },

  AppointmentPathwayWorkGate: {
    type: 'object',
    additionalProperties: false,
    required: ['allowed', 'blockers'],
    properties: {
      allowed: { type: 'boolean' },
      blockers: {
        type: 'array',
        items: {
          $ref: '#/components/schemas/AppointmentPathwayWorkBlocker',
        },
      },
    },
  },

  AppointmentPathwayConfiguration: {
    type: 'object',
    additionalProperties: false,
    required: [
      'mode',
      'projection_pending',
      'completeness_checked',
      'completeness_proven',
      'exact_source_count',
      'child_event_count',
      'valid_child_event_count',
      'missing_source_event_count',
      'pending_child_projection_count',
      'invalid_child_event_count',
      'child_state_mismatch_count',
      'unsupported_historical_source_types',
      'pathway_instance_id',
      'pathway_clinical_status',
    ],
    properties: {
      mode: { type: 'string', enum: pathwayModes },
      projection_pending: { type: 'boolean' },
      completeness_checked: { type: 'boolean' },
      completeness_proven: { type: 'boolean' },
      exact_source_count: { type: 'integer', minimum: 0 },
      child_event_count: { type: 'integer', minimum: 0 },
      valid_child_event_count: { type: 'integer', minimum: 0 },
      missing_source_event_count: { type: 'integer', minimum: 0 },
      pending_child_projection_count: { type: 'integer', minimum: 0 },
      invalid_child_event_count: { type: 'integer', minimum: 0 },
      child_state_mismatch_count: { type: 'integer', minimum: 0 },
      unsupported_historical_source_types: {
        type: 'array',
        maxItems: 0,
        uniqueItems: true,
        items: { type: 'string' },
      },
      pathway_instance_id: nullableUuid,
      pathway_clinical_status: {
        type: 'string',
        enum: [
          'planned',
          'active',
          'on_hold',
          'completed',
          'cancelled',
          'transferred',
          'entered_in_error',
        ],
        nullable: true,
      },
    },
  },

  AppointmentPathwayWorkItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'resource_type',
      'id',
      'relationship_kind',
      'evidence_state',
      'blocking',
      'owner_uid',
      'owner_name',
      'owner_role',
      'task_id',
      'handoff_id',
      'route',
    ],
    properties: {
      resource_type: { type: 'string', minLength: 1, maxLength: 160 },
      id: { type: 'string', minLength: 1, maxLength: 200 },
      relationship_kind: { type: 'string', minLength: 1, maxLength: 80 },
      evidence_state: { type: 'string', minLength: 1, maxLength: 80 },
      blocking: { type: 'boolean' },
      owner_uid: nullableUuid,
      owner_name: { type: 'string', nullable: true },
      owner_role: { type: 'string', nullable: true },
      task_id: { type: 'integer', minimum: 1, nullable: true },
      handoff_id: nullableUuid,
      route: {
        type: 'string',
        enum: staffWorkRouteTokens,
        nullable: true,
      },
      configuration_issue: {
        type: 'string',
        enum: [
          'missing_source_event',
          'child_projection_pending',
          'invalid_source_event',
          'source_state_mismatch',
        ],
        nullable: true,
      },
      source_evidence_state: {
        type: 'string',
        nullable: true,
        maxLength: 80,
      },
    },
  },

  OpFollowUpPendingResultOwner: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'display_name', 'role'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      display_name: { type: 'string', minLength: 1, maxLength: 240 },
      role: { type: 'string', minLength: 1, maxLength: 80 },
    },
  },

  OpFollowUpPendingResultTask: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      status: { type: 'string', minLength: 1, maxLength: 80 },
    },
  },

  OpFollowUpPendingResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'admission_id',
      'handoff_id',
      'source_type',
      'patient_safe_label',
      'result_status',
      'handoff_state',
      'requires_action',
      'can_cross_sign',
      'named_owner',
      'generation_id',
      'generation_snapshot_sha256',
      'diagnostic_classification',
      'diagnostic_action_id',
      'diagnostic_action_kind',
      'diagnostic_disposition',
      'diagnostic_action_occurred_at',
      'resolution_action_id',
      'resolved_at',
      'resolved_by_uid',
      'tracking_task',
      'action_task',
      'task',
      'route',
    ],
    properties: {
      admission_id: { type: 'integer', minimum: 1 },
      handoff_id: { type: 'string', format: 'uuid' },
      source_type: {
        type: 'string',
        enum: [
          'investigation',
          'lab_result',
          'radiology_order',
          'anatomical_pathology_case',
          'diagnostic_result_generation',
        ],
      },
      patient_safe_label: { type: 'string', minLength: 1, maxLength: 240 },
      result_status: { type: 'string', minLength: 1, maxLength: 60 },
      handoff_state: {
        type: 'string',
        enum: ['pending', 'result_available', 'resolved'],
      },
      requires_action: { type: 'boolean' },
      can_cross_sign: { type: 'boolean' },
      named_owner: {
        $ref: '#/components/schemas/OpFollowUpPendingResultOwner',
      },
      generation_id: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
      generation_snapshot_sha256: {
        type: 'string',
        pattern: '^[0-9a-f]{64}$',
        nullable: true,
      },
      diagnostic_classification: {
        type: 'string',
        enum: ['critical', 'abnormal', 'normal', 'indeterminate'],
        nullable: true,
      },
      diagnostic_action_id: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
      diagnostic_action_kind: {
        type: 'string',
        enum: ['doctor_disposition'],
        nullable: true,
      },
      diagnostic_disposition: {
        type: 'string',
        enum: ['treated', 'repeated', 'referred', 'no_action'],
        nullable: true,
      },
      diagnostic_action_occurred_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
      },
      resolution_action_id: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
      resolved_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
      },
      resolved_by_uid: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
      tracking_task: {
        $ref: '#/components/schemas/OpFollowUpPendingResultTask',
      },
      action_task: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/OpFollowUpPendingResultTask' }],
      },
      task: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/OpFollowUpPendingResultTask' }],
      },
      route: {
        type: 'string',
        enum: staffWorkRouteTokens,
        nullable: true,
      },
    },
  },

  AppointmentPathwayWork: {
    type: 'object',
    additionalProperties: false,
    required: [
      'mode',
      'projection_pending',
      'configuration',
      'visit_completion',
      'pathway_closure',
      'items',
      'prior_admission_pending_results',
      'closure_evidence',
    ],
    properties: {
      mode: { type: 'string', enum: pathwayModes },
      projection_pending: { type: 'boolean' },
      configuration: {
        $ref: '#/components/schemas/AppointmentPathwayConfiguration',
      },
      visit_completion: {
        $ref: '#/components/schemas/AppointmentPathwayWorkGate',
      },
      pathway_closure: {
        $ref: '#/components/schemas/AppointmentPathwayWorkGate',
      },
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/AppointmentPathwayWorkItem' },
      },
      prior_admission_pending_results: {
        type: 'array',
        items: { $ref: '#/components/schemas/OpFollowUpPendingResult' },
      },
      closure_evidence: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/OpVisitClosureEvidence' }],
      },
    },
  },
  AppointmentPathwayWorkResponse: strictEnvelope('AppointmentPathwayWork'),

  OpVisitClosureEvidenceRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['follow_up_required', 'patient_safe_next_steps', 'closure_basis'],
    properties: {
      follow_up_required: { type: 'boolean' },
      follow_up_plan_id: { type: 'integer', minimum: 1, nullable: true },
      patient_safe_next_steps: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: { $ref: '#/components/schemas/OpVisitPatientNextStepRequest' },
      },
      closure_basis: {
        type: 'string',
        enum: ['all_required_work_completed', 'named_ownership_accepted', 'accepted_transfer'],
      },
      accepted_handoff_id: nullableUuid,
      occurred_at: { type: 'string', format: 'date-time', nullable: true },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 220,
      },
    },
    allOf: [
      {
        oneOf: [
          {
            required: ['follow_up_plan_id'],
            properties: {
              follow_up_required: { enum: [true] },
              follow_up_plan_id: {
                type: 'integer',
                minimum: 1,
              },
            },
          },
          {
            properties: {
              follow_up_required: { enum: [false] },
              follow_up_plan_id: {
                not: { type: 'integer' },
              },
            },
          },
        ],
      },
      {
        oneOf: [
          {
            required: ['accepted_handoff_id'],
            properties: {
              closure_basis: { enum: ['accepted_transfer'] },
              accepted_handoff_id: { type: 'string', format: 'uuid' },
            },
          },
          {
            properties: {
              closure_basis: {
                enum: ['all_required_work_completed', 'named_ownership_accepted'],
              },
              accepted_handoff_id: {
                not: { type: 'string' },
              },
            },
          },
        ],
      },
    ],
  },

  OpVisitClosureEvidenceMutationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'replayed', 'closure_evidence'],
    properties: {
      mode: { type: 'string', enum: ['shadow', 'active'] },
      replayed: { type: 'boolean' },
      closure_evidence: {
        $ref: '#/components/schemas/OpVisitClosureEvidence',
      },
    },
  },
  OpVisitClosureEvidenceMutationResponse: strictEnvelope('OpVisitClosureEvidenceMutationResult'),

  OpInpatientTransferRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['intended_recipient_uid', 'reason'],
    properties: {
      intended_recipient_uid: { type: 'string', format: 'uuid' },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        pattern: '^[^\\u0000-\\u001F\\u007F-\\u009F]+$',
      },
    },
  },

  OpInpatientTransferAcceptRequest: {
    type: 'object',
    additionalProperties: false,
    maxProperties: 0,
  },

  OpInpatientTransferHandoff: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'requested_at', 'accepted_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['requested', 'accepted'] },
      requested_at: { type: 'string', format: 'date-time' },
      accepted_at: nullableDateTime,
    },
  },

  OpInpatientTransferTask: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'task_kind', 'priority', 'status'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      task_kind: {
        type: 'string',
        enum: ['op_to_inpatient_transfer_review'],
      },
      priority: { type: 'string', enum: ['normal'] },
      status: { type: 'string', enum: ['open', 'completed'] },
    },
  },

  OpInpatientTransferTransition: {
    type: 'object',
    additionalProperties: false,
    required: ['transition_key', 'occurred_at'],
    properties: {
      transition_key: {
        type: 'string',
        enum: [
          'op_to_inpatient_transfer_requested',
          'op_to_inpatient_transfer_accepted',
        ],
      },
      occurred_at: nullableDateTime,
    },
  },

  OpInpatientTransferAdmissionSource: {
    type: 'object',
    additionalProperties: false,
    required: [
      'appointment_id',
      'source_pathway_instance_id',
      'source_handoff_id',
      'accepted_recipient_uid',
    ],
    properties: {
      appointment_id: { type: 'integer', minimum: 1 },
      source_pathway_instance_id: { type: 'string', format: 'uuid' },
      source_handoff_id: { type: 'string', format: 'uuid' },
      accepted_recipient_uid: nullableUuid,
    },
  },

  OpInpatientTransferResult: {
    type: 'object',
    additionalProperties: false,
    required: ['handoff', 'task', 'transition', 'admission_source', 'replayed'],
    properties: {
      handoff: { $ref: '#/components/schemas/OpInpatientTransferHandoff' },
      task: { $ref: '#/components/schemas/OpInpatientTransferTask' },
      transition: {
        $ref: '#/components/schemas/OpInpatientTransferTransition',
      },
      admission_source: {
        $ref: '#/components/schemas/OpInpatientTransferAdmissionSource',
      },
      replayed: { type: 'boolean' },
    },
  },
  OpInpatientTransferResponse: strictEnvelope('OpInpatientTransferResult'),

  EdDestinationHandoffRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['destination', 'intended_recipient_role', 'reason'],
    properties: {
      destination: {
        type: 'string',
        enum: ['ward', 'icu', 'hdu', 'surgery', 'external_transfer'],
      },
      intended_recipient_role: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{1,79}$',
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        pattern: '^[^\\u0000-\\u001F\\u007F-\\u009F]+$',
      },
    },
  },

  EdDestinationHandoffDecisionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: {
      decision: { type: 'string', enum: ['accept', 'decline'] },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        pattern: '^[^\\u0000-\\u001F\\u007F-\\u009F]+$',
      },
    },
    allOf: [
      {
        if: {
          properties: { decision: { const: 'decline' } },
          required: ['decision'],
        },
        then: { required: ['reason'] },
      },
    ],
  },

  EdDestinationHandoff: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'status',
      'destination',
      'intended_recipient_role',
      'requested_at',
      'accepted_at',
      'declined_at',
      'accepted_by_uid',
      'decline_reason',
      'reroute_reason',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['requested', 'accepted', 'declined'] },
      destination: {
        type: 'string',
        enum: ['ward', 'icu', 'hdu', 'surgery', 'external_transfer'],
      },
      intended_recipient_role: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{1,79}$',
      },
      requested_at: { type: 'string', format: 'date-time' },
      accepted_at: nullableDateTime,
      declined_at: nullableDateTime,
      accepted_by_uid: nullableUuid,
      decline_reason: { type: 'string', nullable: true },
      reroute_reason: { type: 'string', nullable: true },
    },
  },

  EdDestinationHandoffTask: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'task_kind',
      'priority',
      'status',
      'assigned_to_role',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      task_kind: {
        type: 'string',
        enum: ['ed_destination_handoff_review'],
      },
      priority: { type: 'string', enum: ['high'] },
      status: {
        type: 'string',
        enum: ['open', 'in_progress', 'blocked', 'overdue', 'completed', 'cancelled'],
      },
      assigned_to_role: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{1,79}$',
      },
    },
  },

  EdDestinationHandoffTransition: {
    type: 'object',
    additionalProperties: false,
    required: ['transition_key', 'occurred_at'],
    properties: {
      transition_key: {
        type: 'string',
        enum: [
          'ed_destination_handoff_requested',
          'ed_destination_handoff_accepted',
          'ed_destination_handoff_declined',
          'ed_destination_handoff_rerouted',
        ],
      },
      occurred_at: nullableDateTime,
    },
  },

  EdDestinationSource: {
    type: 'object',
    additionalProperties: false,
    required: [
      'emergency_visit_id',
      'source_pathway_instance_id',
      'source_handoff_id',
    ],
    properties: {
      emergency_visit_id: { type: 'integer', minimum: 1 },
      source_pathway_instance_id: { type: 'string', format: 'uuid' },
      source_handoff_id: { type: 'string', format: 'uuid' },
    },
  },

  EdDestinationHandoffResult: {
    type: 'object',
    additionalProperties: false,
    required: ['handoff', 'task', 'transition', 'destination_source', 'replayed'],
    properties: {
      handoff: { $ref: '#/components/schemas/EdDestinationHandoff' },
      task: { $ref: '#/components/schemas/EdDestinationHandoffTask' },
      transition: {
        $ref: '#/components/schemas/EdDestinationHandoffTransition',
      },
      destination_source: {
        $ref: '#/components/schemas/EdDestinationSource',
      },
      replayed: { type: 'boolean' },
    },
  },
  EdDestinationHandoffResponse: strictEnvelope('EdDestinationHandoffResult'),

  EdDestinationHandoffListItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'emergency_visit_id',
      'status',
      'request_reason',
      'decline_reason',
      'reroute_reason',
      'requested_at',
      'accepted_at',
      'declined_at',
      'sender_uid',
      'intended_recipient_role',
      'accepted_by_uid',
      'destination',
      'supersedes_handoff_id',
      'rerouted_to_handoff_id',
      'task_id',
      'task_status',
      'visit_number',
      'patient_uid',
      'visit_status',
      'disposition',
      'attending_doctor_uid',
      'arrival_at',
      'can_decide',
      'can_reroute',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      emergency_visit_id: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['requested', 'accepted', 'declined'] },
      request_reason: { type: 'string', minLength: 1 },
      decline_reason: { type: 'string', nullable: true },
      reroute_reason: { type: 'string', nullable: true },
      requested_at: { type: 'string', format: 'date-time' },
      accepted_at: nullableDateTime,
      declined_at: nullableDateTime,
      sender_uid: { type: 'string', format: 'uuid' },
      intended_recipient_role: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{1,79}$',
      },
      accepted_by_uid: nullableUuid,
      destination: {
        type: 'string',
        enum: ['ward', 'icu', 'hdu', 'surgery', 'external_transfer'],
      },
      supersedes_handoff_id: nullableUuid,
      rerouted_to_handoff_id: nullableUuid,
      task_id: { type: 'integer', minimum: 1 },
      task_status: {
        type: 'string',
        enum: ['open', 'in_progress', 'blocked', 'overdue', 'completed', 'cancelled'],
      },
      visit_number: { type: 'string', minLength: 1 },
      patient_uid: { type: 'string', format: 'uuid' },
      visit_status: { type: 'string', minLength: 1 },
      disposition: { type: 'string', nullable: true },
      attending_doctor_uid: nullableUuid,
      arrival_at: { type: 'string', format: 'date-time' },
      can_decide: { type: 'boolean' },
      can_reroute: { type: 'boolean' },
    },
  },

  EdDestinationHandoffList: {
    type: 'object',
    additionalProperties: false,
    required: ['handoffs', 'count', 'actor_role'],
    properties: {
      handoffs: {
        type: 'array',
        maxItems: 200,
        items: {
          $ref: '#/components/schemas/EdDestinationHandoffListItem',
        },
      },
      count: { type: 'integer', minimum: 0, maximum: 200 },
      actor_role: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{1,79}$',
      },
    },
  },
  EdDestinationHandoffListResponse: strictEnvelope('EdDestinationHandoffList'),

  InpatientPrimaryPhysicianAssignment: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'assignment_version',
      'physician_uid',
      'assignment_source',
      'accepted_handoff_id',
      'supersedes_assignment_id',
      'assigned_by_uid',
      'assigned_at',
      'physician_name',
      'physician_role',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      assignment_version: { type: 'integer', minimum: 1 },
      physician_uid: { type: 'string', format: 'uuid' },
      assignment_source: {
        type: 'string',
        enum: ['attending_physician', 'admitting_physician', 'accepted_covering_handoff'],
      },
      accepted_handoff_id: nullableUuid,
      supersedes_assignment_id: nullableUuid,
      assigned_by_uid: { type: 'string', format: 'uuid' },
      assigned_at: { type: 'string', format: 'date-time' },
      physician_name: { type: 'string', nullable: true },
      physician_role: { type: 'string', minLength: 1 },
    },
  },

  InpatientPendingResultOwner: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'display_name', 'role'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      display_name: { type: 'string', nullable: true },
      role: { type: 'string', minLength: 1 },
    },
  },

  InpatientPendingResultPrimaryPhysician: {
    type: 'object',
    additionalProperties: false,
    required: ['assignment_id', 'uid', 'display_name', 'role'],
    properties: {
      assignment_id: { type: 'string', format: 'uuid' },
      uid: { type: 'string', format: 'uuid' },
      display_name: { type: 'string', nullable: true },
      role: { type: 'string', minLength: 1 },
    },
  },

  InpatientPendingResultHandoffView: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'state',
      'task_id',
      'named_physician_uid',
      'named_physician_name',
      'summary_id',
      'summary_included_at',
      'resolution_generation_id',
      'resolution_action_id',
      'resolved_at',
      'resolved_by_uid',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      state: {
        type: 'string',
        enum: ['pending', 'result_available', 'resolved'],
      },
      task_id: { type: 'integer', minimum: 1 },
      named_physician_uid: { type: 'string', format: 'uuid' },
      named_physician_name: { type: 'string', nullable: true },
      summary_id: { type: 'integer', minimum: 1, nullable: true },
      summary_included_at: nullableDateTime,
      resolution_generation_id: nullableUuid,
      resolution_action_id: nullableUuid,
      resolved_at: nullableDateTime,
      resolved_by_uid: nullableUuid,
    },
  },

  InpatientPendingResultItem: {
    type: 'object',
    additionalProperties: false,
    required: [
      'resource_reference_id',
      'source_type',
      'source_id',
      'patient_safe_label',
      'current_status',
      'exact_lineage',
      'evidence_state',
      'primary_physician',
      'named_owner',
      'handoff',
      'handoff_complete_warning',
      'handoff_complete',
      'summary_included',
      'blocking',
      'blocker_codes',
    ],
    properties: {
      resource_reference_id: {
        type: 'string',
        format: 'uuid',
        nullable: true,
      },
      source_type: { type: 'string', enum: pendingResultTypes },
      source_id: { type: 'string', minLength: 1, maxLength: 160 },
      patient_safe_label: { type: 'string', minLength: 1, maxLength: 240 },
      current_status: { type: 'string', minLength: 1, maxLength: 80 },
      exact_lineage: { type: 'boolean' },
      evidence_state: {
        type: 'string',
        enum: ['open', 'completed', 'ownership_accepted'],
        nullable: true,
      },
      primary_physician: {
        nullable: true,
        allOf: [
          {
            $ref: '#/components/schemas/InpatientPendingResultPrimaryPhysician',
          },
        ],
      },
      named_owner: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientPendingResultOwner' }],
      },
      handoff: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientPendingResultHandoffView' }],
      },
      handoff_complete_warning: { type: 'boolean' },
      handoff_complete: { type: 'boolean' },
      summary_included: { type: 'boolean' },
      blocking: { type: 'boolean' },
      blocker_codes: {
        type: 'array',
        items: {
          type: 'string',
          enum: [
            'PENDING_RESULT_SOURCE_UNRESOLVED',
            'PENDING_RESULT_REFERENCE_MISSING',
            'DIAGNOSTIC_SAFETY_ACTION_REQUIRED',
            'PRIMARY_PHYSICIAN_ASSIGNMENT_MISSING',
            'PENDING_RESULT_HANDOFF_MISSING',
            'PENDING_RESULT_ASSIGNMENT_STALE',
            'PENDING_RESULT_NAMED_OWNER_INVALID',
            'PENDING_RESULT_SUMMARY_INCLUSION_MISSING',
          ],
        },
      },
    },
  },

  InpatientPendingResultsProjection: {
    type: 'object',
    additionalProperties: false,
    required: [
      'projection_ready',
      'pathway_instance_id',
      'references_found',
      'references_expected',
      'missing_reference_count',
      'unresolved_reference_count',
      'reconciliation_debt',
      'items',
    ],
    properties: {
      projection_ready: { type: 'boolean' },
      pathway_instance_id: nullableUuid,
      references_found: { type: 'integer', minimum: 0 },
      references_expected: { type: 'integer', minimum: 0 },
      missing_reference_count: { type: 'integer', minimum: 0 },
      unresolved_reference_count: { type: 'integer', minimum: 0 },
      reconciliation_debt: {
        type: 'array',
        items: {
          $ref: '#/components/schemas/InpatientPendingResultReconciliationDebt',
        },
      },
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/InpatientPendingResultItem' },
      },
    },
  },

  InpatientPendingResultReconciliationDebt: {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'source_type', 'source_id'],
    properties: {
      code: {
        type: 'string',
        enum: ['PENDING_RESULT_REFERENCE_MISSING', 'PENDING_RESULT_SOURCE_UNRESOLVED'],
      },
      source_type: { type: 'string', enum: pendingResultTypes },
      source_id: { type: 'string', minLength: 1, maxLength: 160 },
    },
  },

  InpatientSignedSummaryEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'signed_by', 'signed_at'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['signed', 'delivered'] },
      signed_by: { type: 'string', format: 'uuid' },
      signed_at: { type: 'string', format: 'date-time' },
    },
  },

  InpatientMedicationReconciliationEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'status', 'completed_by', 'completed_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['completed'] },
      completed_by: { type: 'string', format: 'uuid' },
      completed_at: { type: 'string', format: 'date-time' },
    },
  },

  InpatientAdmissionFollowUpEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'appointment_id', 'status', 'appointment_status', 'booked_status'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      appointment_id: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['open', 'scheduled'] },
      appointment_status: { type: 'string', nullable: true },
      booked_status: { type: 'string', minLength: 1 },
    },
  },

  InpatientAuditedFollowUpExceptionEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['timeline_event_id', 'audit_event_id', 'reason'],
    properties: {
      timeline_event_id: { type: 'string', format: 'uuid' },
      audit_event_id: { type: 'string', format: 'uuid' },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  },

  InpatientDischargeClosureSectionEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['discharge_summary_id', 'section_id', 'section_key'],
    properties: {
      discharge_summary_id: { type: 'integer', minimum: 1 },
      section_id: { type: 'integer', minimum: 1 },
      section_key: {
        type: 'string',
        enum: [
          'patient_guardian_instructions',
          'escalation_contact',
          'required_equipment_home_care',
          'discharge_destination',
          'transport_plan',
        ],
      },
    },
  },

  InpatientDischargeEvidence: {
    type: 'object',
    additionalProperties: false,
    required: [
      'structured_signed_summary',
      'patient_guardian_instructions',
      'escalation_contact',
      'required_equipment_home_care',
      'discharge_destination',
      'transport_plan',
      'formal_discharge_medication_reconciliation',
      'admission_scoped_follow_up',
      'audited_follow_up_exception',
      'pending_results',
    ],
    properties: {
      structured_signed_summary: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientSignedSummaryEvidence' }],
      },
      patient_guardian_instructions: {
        nullable: true,
        allOf: [
          { $ref: '#/components/schemas/InpatientDischargeClosureSectionEvidence' },
          {
            type: 'object',
            properties: {
              section_key: { type: 'string', enum: ['patient_guardian_instructions'] },
            },
          },
        ],
      },
      escalation_contact: {
        nullable: true,
        allOf: [
          { $ref: '#/components/schemas/InpatientDischargeClosureSectionEvidence' },
          {
            type: 'object',
            properties: {
              section_key: { type: 'string', enum: ['escalation_contact'] },
            },
          },
        ],
      },
      required_equipment_home_care: {
        nullable: true,
        allOf: [
          { $ref: '#/components/schemas/InpatientDischargeClosureSectionEvidence' },
          {
            type: 'object',
            properties: {
              section_key: { type: 'string', enum: ['required_equipment_home_care'] },
            },
          },
        ],
      },
      discharge_destination: {
        nullable: true,
        allOf: [
          { $ref: '#/components/schemas/InpatientDischargeClosureSectionEvidence' },
          {
            type: 'object',
            properties: {
              section_key: { type: 'string', enum: ['discharge_destination'] },
            },
          },
        ],
      },
      transport_plan: {
        nullable: true,
        allOf: [
          { $ref: '#/components/schemas/InpatientDischargeClosureSectionEvidence' },
          {
            type: 'object',
            properties: {
              section_key: { type: 'string', enum: ['transport_plan'] },
            },
          },
        ],
      },
      formal_discharge_medication_reconciliation: {
        nullable: true,
        allOf: [
          {
            $ref: '#/components/schemas/InpatientMedicationReconciliationEvidence',
          },
        ],
      },
      admission_scoped_follow_up: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientAdmissionFollowUpEvidence' }],
      },
      audited_follow_up_exception: {
        nullable: true,
        allOf: [
          {
            $ref: '#/components/schemas/InpatientAuditedFollowUpExceptionEvidence',
          },
        ],
      },
      pending_results: {
        $ref: '#/components/schemas/InpatientPendingResultsProjection',
      },
    },
  },

  InpatientDischargeBlocker: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'message'],
    properties: {
      type: {
        type: 'string',
        enum: [
          'STRUCTURED_SUMMARY_NOT_SIGNED',
          'PATIENT_GUARDIAN_INSTRUCTIONS_REQUIRED',
          'ESCALATION_CONTACT_REQUIRED',
          'EQUIPMENT_HOME_CARE_PLAN_REQUIRED',
          'DISCHARGE_DESTINATION_REQUIRED',
          'TRANSPORT_PLAN_REQUIRED',
          'INPATIENT_OWNER_ASSIGNMENT_DIVERGED',
          'FORMAL_DISCHARGE_MEDICATION_RECONCILIATION_REQUIRED',
          'ADMISSION_FOLLOW_UP_OR_EXCEPTION_REQUIRED',
          'PENDING_RESULT_PROJECTION_NOT_READY',
          'PENDING_RESULT_HANDOFF_INCOMPLETE',
        ],
      },
      message: { type: 'string', minLength: 1, maxLength: 1000 },
      items: {
        type: 'array',
        items: { $ref: '#/components/schemas/InpatientPendingResultItem' },
      },
    },
  },

  InpatientPendingResultWork: {
    type: 'object',
    additionalProperties: false,
    required: ['mode', 'pending_results', 'evidence', 'active_blockers'],
    properties: {
      mode: { type: 'string', enum: pathwayModes },
      primary_physician_assignment: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientPrimaryPhysicianAssignment' }],
      },
      pending_results: {
        $ref: '#/components/schemas/InpatientPendingResultsProjection',
      },
      evidence: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientDischargeEvidence' }],
      },
      active_blockers: {
        type: 'array',
        items: { $ref: '#/components/schemas/InpatientDischargeBlocker' },
      },
    },
  },
  InpatientPendingResultWorkResponse: strictEnvelope('InpatientPendingResultWork'),

  InpatientPendingResultHandoffRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['source_type', 'source_id', 'resource_reference_id'],
    properties: {
      source_type: { type: 'string', enum: pendingResultTypes },
      source_id: { type: 'string', minLength: 1, maxLength: 160 },
      resource_reference_id: { type: 'string', format: 'uuid' },
      patient_safe_label: {
        type: 'string',
        minLength: 1,
        maxLength: 240,
      },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
    },
  },

  InpatientPendingResultHandoff: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'admission_id',
      'resource_reference_id',
      'source_type',
      'source_id',
      'patient_safe_label',
      'result_status',
      'primary_physician_assignment_id',
      'named_physician_uid',
      'task_id',
      'handoff_state',
      'discharge_summary_id',
      'summary_included_at',
      'resolution_generation_id',
      'resolution_action_id',
      'resolved_at',
      'resolved_by_uid',
      'created_at',
      'updated_at',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      admission_id: { type: 'integer', minimum: 1 },
      resource_reference_id: { type: 'string', format: 'uuid' },
      source_type: { type: 'string', enum: pendingResultTypes },
      source_id: { type: 'string', minLength: 1, maxLength: 160 },
      patient_safe_label: { type: 'string', minLength: 1, maxLength: 240 },
      result_status: { type: 'string', minLength: 1, maxLength: 60 },
      primary_physician_assignment_id: {
        type: 'string',
        format: 'uuid',
      },
      named_physician_uid: { type: 'string', format: 'uuid' },
      task_id: { type: 'integer', minimum: 1 },
      handoff_state: {
        type: 'string',
        enum: ['pending', 'result_available', 'resolved'],
      },
      discharge_summary_id: {
        type: 'integer',
        minimum: 1,
        nullable: true,
      },
      summary_included_at: nullableDateTime,
      resolution_generation_id: nullableUuid,
      resolution_action_id: nullableUuid,
      resolved_at: nullableDateTime,
      resolved_by_uid: nullableUuid,
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  InpatientPendingResultHandoffMutationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['handoff'],
    properties: {
      handoff: {
        $ref: '#/components/schemas/InpatientPendingResultHandoff',
      },
    },
  },
  InpatientPendingResultHandoffMutationResponse: strictEnvelope(
    'InpatientPendingResultHandoffMutationResult',
  ),

  InpatientPendingResultSummaryInclusionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['discharge_summary_id'],
    properties: {
      discharge_summary_id: { type: 'integer', minimum: 1 },
    },
  },

  InpatientPendingResultActionTask: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'task_kind',
      'title',
      'description',
      'status',
      'assigned_to_uid',
      'related_resource_type',
      'related_resource_id',
      'parent_task_id',
      'created_at',
      'updated_at',
    ],
    properties: {
      id: { type: 'integer', minimum: 1 },
      task_kind: { type: 'string', enum: ['review'] },
      title: { type: 'string', minLength: 1, maxLength: 500 },
      description: { type: 'string', nullable: true, maxLength: 8000 },
      status: {
        type: 'string',
        enum: ['open', 'in_progress', 'blocked', 'overdue', 'completed', 'cancelled'],
      },
      assigned_to_uid: nullableUuid,
      related_resource_type: {
        type: 'string',
        enum: ['discharge_pending_result_action'],
      },
      related_resource_id: { type: 'string', minLength: 1, maxLength: 120 },
      parent_task_id: { type: 'integer', minimum: 1, nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },

  InpatientPendingResultOwnerAction: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'handoff_id',
      'generation_id',
      'predecessor_generation_id',
      'predecessor_owner_action_id',
      'predecessor_resolution_action_id',
      'rearm_source_action_id',
      'task_id',
      'owner_uid',
      'recorded_at',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      handoff_id: { type: 'string', format: 'uuid' },
      generation_id: { type: 'string', format: 'uuid' },
      predecessor_generation_id: nullableUuid,
      predecessor_owner_action_id: nullableUuid,
      predecessor_resolution_action_id: nullableUuid,
      rearm_source_action_id: nullableUuid,
      task_id: { type: 'integer', minimum: 1 },
      owner_uid: { type: 'string', format: 'uuid' },
      recorded_at: { type: 'string', format: 'date-time' },
    },
  },

  InpatientPendingResultAvailableResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'handoff',
      'action_task',
      'owner_action',
      'ordering_owner_obligation_preserved',
    ],
    properties: {
      handoff: {
        $ref: '#/components/schemas/InpatientPendingResultHandoff',
      },
      action_task: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/InpatientPendingResultActionTask' }],
      },
      owner_action: {
        $ref: '#/components/schemas/InpatientPendingResultOwnerAction',
      },
      ordering_owner_obligation_preserved: { type: 'boolean', enum: [true] },
    },
  },
  InpatientPendingResultAvailableResponse: strictEnvelope('InpatientPendingResultAvailableResult'),

  InpatientPendingResultAvailableRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['generation_id'],
    properties: {
      generation_id: { type: 'string', format: 'uuid' },
    },
  },

  InpatientPendingResultCrossSignRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'generation_id',
      'diagnostic_action_id',
      'generation_snapshot_sha256',
      'attested',
    ],
    properties: {
      generation_id: { type: 'string', format: 'uuid' },
      diagnostic_action_id: { type: 'string', format: 'uuid' },
      generation_snapshot_sha256: {
        type: 'string',
        pattern: '^[a-f0-9]{64}$',
      },
      attested: { type: 'boolean', enum: [true] },
    },
  },

  InpatientPendingResultCrossSignReceipt: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'admission_id',
      'handoff_id',
      'generation_id',
      'diagnostic_action_id',
      'pathway_instance_id',
      'owner_action_id',
      'action_task_id',
      'tracking_task_id',
      'signature_id',
      'resolution_action_id',
      'handoff_state',
      'current_handoff_state',
      'generation_snapshot_sha256',
      'request_sha256',
      'canonical_timeline_event_id',
      'canonical_audit_event_id',
      'replayed',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      admission_id: { type: 'integer', minimum: 1 },
      handoff_id: { type: 'string', format: 'uuid' },
      generation_id: { type: 'string', format: 'uuid' },
      diagnostic_action_id: { type: 'string', format: 'uuid' },
      pathway_instance_id: { type: 'string', format: 'uuid' },
      owner_action_id: { type: 'string', format: 'uuid' },
      action_task_id: { type: 'integer', minimum: 1 },
      tracking_task_id: { type: 'integer', minimum: 1 },
      signature_id: { type: 'string', format: 'uuid' },
      resolution_action_id: { type: 'string', format: 'uuid' },
      handoff_state: { type: 'string', enum: ['resolved'] },
      current_handoff_state: {
        type: 'string',
        enum: ['result_available', 'resolved'],
      },
      generation_snapshot_sha256: {
        type: 'string',
        pattern: '^[a-f0-9]{64}$',
      },
      request_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      canonical_timeline_event_id: { type: 'string', format: 'uuid' },
      canonical_audit_event_id: { type: 'string', format: 'uuid' },
      replayed: { type: 'boolean' },
    },
  },

  InpatientPendingResultCrossSignResult: {
    type: 'object',
    additionalProperties: false,
    required: ['resolution'],
    properties: {
      resolution: {
        $ref: '#/components/schemas/InpatientPendingResultCrossSignReceipt',
      },
    },
  },
  InpatientPendingResultCrossSignResponse: strictEnvelope(
    'InpatientPendingResultCrossSignResult',
  ),

  InpatientFollowUpExceptionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'idempotency_key'],
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
    },
  },

  InpatientFollowUpException: {
    type: 'object',
    additionalProperties: false,
    required: ['admission_id', 'reason', 'canonical_timeline_event_id', 'canonical_audit_event_id'],
    properties: {
      admission_id: { type: 'integer', minimum: 1 },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
      canonical_timeline_event_id: { type: 'string', format: 'uuid' },
      canonical_audit_event_id: { type: 'string', format: 'uuid' },
    },
  },

  InpatientFollowUpExceptionMutationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['exception'],
    properties: {
      exception: {
        $ref: '#/components/schemas/InpatientFollowUpException',
      },
    },
  },
  InpatientFollowUpExceptionMutationResponse: strictEnvelope(
    'InpatientFollowUpExceptionMutationResult',
  ),

  PostDischargeContactRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['event_kind', 'contact_source', 'contact_channel', 'idempotency_key'],
    properties: {
      event_kind: { type: 'string', enum: ['attempt', 'outcome'] },
      contact_source: {
        type: 'string',
        enum: ['manual', 'registered_policy'],
      },
      contact_channel: {
        type: 'string',
        enum: ['phone', 'sms', 'email', 'patient_portal', 'in_person', 'video', 'other'],
      },
      outcome_code: { type: 'string', nullable: true, maxLength: 80 },
      patient_safe_summary: {
        type: 'string',
        nullable: true,
        maxLength: 500,
      },
      policy_rule_code: { type: 'string', nullable: true, maxLength: 120 },
      occurred_at: { type: 'string', format: 'date-time', nullable: true },
      idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
      },
    },
    allOf: [
      {
        oneOf: [
          {
            properties: {
              event_kind: { enum: ['attempt'] },
              outcome_code: {
                not: { type: 'string' },
              },
            },
          },
          {
            required: ['outcome_code'],
            properties: {
              event_kind: { enum: ['outcome'] },
              outcome_code: {
                type: 'string',
                minLength: 1,
                maxLength: 80,
              },
            },
          },
        ],
      },
      {
        oneOf: [
          {
            properties: {
              contact_source: { enum: ['manual'] },
              policy_rule_code: {
                not: { type: 'string' },
              },
            },
          },
          {
            required: ['policy_rule_code'],
            properties: {
              contact_source: { enum: ['registered_policy'] },
              policy_rule_code: {
                type: 'string',
                minLength: 1,
                maxLength: 120,
              },
            },
          },
        ],
      },
    ],
  },

  PostDischargeContact: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'admission_id',
      'event_kind',
      'contact_source',
      'contact_channel',
      'outcome_code',
      'patient_safe_summary',
      'policy_rule_code',
      'occurred_at',
      'recorded_at',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      admission_id: { type: 'integer', minimum: 1 },
      event_kind: { type: 'string', enum: ['attempt', 'outcome'] },
      contact_source: {
        type: 'string',
        enum: ['manual', 'registered_policy'],
      },
      contact_channel: {
        type: 'string',
        enum: ['phone', 'sms', 'email', 'patient_portal', 'in_person', 'video', 'other'],
      },
      outcome_code: { type: 'string', nullable: true, maxLength: 80 },
      patient_safe_summary: {
        type: 'string',
        nullable: true,
        maxLength: 500,
      },
      policy_rule_code: { type: 'string', nullable: true, maxLength: 120 },
      occurred_at: { type: 'string', format: 'date-time' },
      recorded_at: { type: 'string', format: 'date-time' },
    },
  },

  PostDischargeContactList: {
    type: 'object',
    additionalProperties: false,
    required: ['contacts', 'count'],
    properties: {
      contacts: {
        type: 'array',
        items: { $ref: '#/components/schemas/PostDischargeContact' },
      },
      count: { type: 'integer', minimum: 0 },
    },
  },
  PostDischargeContactListResponse: strictEnvelope('PostDischargeContactList'),

  PostDischargeContactMutationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['contact'],
    properties: {
      contact: { $ref: '#/components/schemas/PostDischargeContact' },
    },
  },
  PostDischargeContactMutationResponse: strictEnvelope('PostDischargeContactMutationResult'),

  CarePathwayReconciliationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'finding_count', 'repair_count', 'error_count'],
    properties: {
      code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,119}$' },
      finding_count: { type: 'integer', minimum: 0 },
      repair_count: { type: 'integer', minimum: 0 },
      error_count: { type: 'integer', minimum: 0 },
    },
  },

  CarePathwayReconciliationEvidence: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id', 'sweep_id', 'pathway_key', 'pathway_mode',
      'registry_version', 'registry_checksum', 'governance_checksum',
      'governance_count', 'covered_governance_count',
      'expected_check_count', 'executed_check_count',
      'finding_count', 'repair_count', 'error_count',
      'registry_complete', 'passed', 'check_results',
      'started_at', 'completed_at', 'created_at',
    ],
    properties: {
      id: { type: 'string', pattern: '^[0-9]+$' },
      sweep_id: { type: 'string', format: 'uuid' },
      pathway_key: { type: 'string', enum: canonicalPathwayKeys },
      pathway_mode: { type: 'string', enum: ['off', 'shadow', 'active'] },
      registry_version: { type: 'integer', minimum: 1 },
      registry_checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      governance_checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      governance_count: { type: 'integer', minimum: 0 },
      covered_governance_count: { type: 'integer', minimum: 0 },
      expected_check_count: { type: 'integer', minimum: 0 },
      executed_check_count: { type: 'integer', minimum: 0 },
      finding_count: { type: 'integer', minimum: 0 },
      repair_count: { type: 'integer', minimum: 0 },
      error_count: { type: 'integer', minimum: 0 },
      registry_complete: { type: 'boolean' },
      passed: { type: 'boolean' },
      check_results: {
        type: 'array',
        maxItems: 200,
        items: { $ref: '#/components/schemas/CarePathwayReconciliationResult' },
      },
      started_at: { type: 'string', format: 'date-time' },
      completed_at: { type: 'string', format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  CarePathwayReconciliationEvidenceList: {
    type: 'object',
    additionalProperties: false,
    required: ['evidence', 'count', 'limit', 'offset'],
    properties: {
      evidence: {
        type: 'array',
        items: { $ref: '#/components/schemas/CarePathwayReconciliationEvidence' },
      },
      count: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0, maximum: 10000 },
    },
  },
  CarePathwayReconciliationEvidenceListResponse: envelope(
    'CarePathwayReconciliationEvidenceList',
  ),
};

export const operations = {
  'GET /api/v1/appointments/{id}/pathway-work': {
    summary: 'Read appointment pathway work and closure readiness',
    description:
      'Returns the staff-safe OP work projection, named ownership, completion gates, and any recorded patient-safe closure evidence.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    response: 'AppointmentPathwayWorkResponse',
  },
  'POST /api/v1/appointments/{id}/closure-evidence': {
    summary: 'Record patient-safe OP visit closure evidence',
    description:
      'Records the clinician disposition and patient-safe next steps. A new record returns 201; an idempotent replay returns the same typed payload with 200.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    request: 'OpVisitClosureEvidenceRequest',
    response: 'OpVisitClosureEvidenceMutationResponse',
    responseStatus: 201,
  },
  'POST /api/v1/appointments/{id}/inpatient-transfer-requests': {
    summary: 'Request an OP-to-inpatient named-recipient transfer',
    description:
      'Creates one exact-lineage handoff and review task. A new request returns 201; an idempotent replay returns the same strict staff-safe payload with 200.',
    parameters: [idempotencyKeyParameter],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    request: 'OpInpatientTransferRequest',
    response: 'OpInpatientTransferResponse',
    responseStatus: 201,
  },
  'POST /api/v1/appointments/{id}/inpatient-transfer-requests/{handoffId}/accept': {
    summary: 'Accept an OP-to-inpatient named-recipient transfer',
    description:
      'Accepts the exact handoff as its intended recipient and returns the strict admission-source tuple. A new acceptance and an idempotent replay both return 200.',
    parameters: [idempotencyKeyParameter],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
      handoffId: { type: 'string', format: 'uuid' },
    },
    request: 'OpInpatientTransferAcceptRequest',
    response: 'OpInpatientTransferResponse',
  },
  'POST /api/v1/ed/visits/{id}/destination-handoffs': {
    summary: 'Request an ED receiving-destination role handoff',
    description:
      'Creates an exact ED-pathway handoff and role-owned review task without inventing an SLA. A new request returns 201; an idempotent replay returns 200.',
    parameters: [idempotencyKeyParameter],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    request: 'EdDestinationHandoffRequest',
    response: 'EdDestinationHandoffResponse',
    responseStatus: 201,
  },
  'GET /api/v1/ed/destination-handoffs': {
    summary: 'List ED destination handoffs visible to the authenticated actor',
    description:
      'Returns handoffs sent by the actor or assigned to the actor current exact database role.',
    response: 'EdDestinationHandoffListResponse',
  },
  'POST /api/v1/ed/visits/{id}/destination-handoffs/{handoffId}/decisions': {
    summary: 'Accept or decline an ED destination handoff',
    description:
      'Allows an active holder of the exact assigned database role to accept or decline the handoff. A decline requires a reason.',
    parameters: [idempotencyKeyParameter],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
      handoffId: { type: 'string', format: 'uuid' },
    },
    request: 'EdDestinationHandoffDecisionRequest',
    response: 'EdDestinationHandoffResponse',
  },
  'POST /api/v1/ed/visits/{id}/destination-handoffs/{handoffId}/reroute': {
    summary: 'Reroute a declined ED destination handoff',
    description:
      'Allows only the unchanged ED pathway owner to replace one declined handoff with a new explicit destination and role request.',
    parameters: [idempotencyKeyParameter],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
      handoffId: { type: 'string', format: 'uuid' },
    },
    request: 'EdDestinationHandoffRequest',
    response: 'EdDestinationHandoffResponse',
    responseStatus: 201,
  },
  ...admissionAliases('GET /{id}/pending-results', {
    summary: 'Read inpatient pending-result and discharge evidence',
    description:
      'Returns exact admission-scoped pending-result lineage, named ownership, signed-summary inclusion, and active discharge blockers without result content.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    response: 'InpatientPendingResultWorkResponse',
  }),
  ...admissionAliases('POST /{id}/pending-result-handoffs', {
    summary: 'Record a named-owner handoff for a pending result',
    description:
      'Creates an exact-lineage handoff to the current primary physician. An idempotent replay also returns 201 with the same strict staff-safe handoff view.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    request: 'InpatientPendingResultHandoffRequest',
    response: 'InpatientPendingResultHandoffMutationResponse',
    responseStatus: 201,
  }),
  ...admissionAliases(
    'PUT /{id}/pending-result-handoffs/{handoffId}/summary-inclusion',
    {
    summary: 'Record pending-result inclusion in a signed summary',
    description:
      'Links the exact pending-result handoff to the signed structured discharge summary and returns the strict staff-safe handoff view.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
      handoffId: { type: 'string', format: 'uuid' },
    },
    request: 'InpatientPendingResultSummaryInclusionRequest',
    response: 'InpatientPendingResultHandoffMutationResponse',
    },
  ),
  ...admissionAliases('POST /{id}/pending-result-handoffs/{handoffId}/result-available', {
    summary: 'Mark an exact pending result as available',
    description:
      'Marks the handed-off result generation available and returns the strict handoff plus a newly created review task. A repeated call returns 200 with action_task null when that open task already exists.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
      handoffId: { type: 'string', format: 'uuid' },
    },
    request: 'InpatientPendingResultAvailableRequest',
    response: 'InpatientPendingResultAvailableResponse',
  }),
  ...admissionAliases('POST /{id}/pending-result-handoffs/{handoffId}/cross-sign', {
    summary: 'Cross-sign an available pending result as its named discharge owner',
    description:
      'Requires the live named discharge physician to attest the exact latest signed generation and its ordering-owner doctor disposition. The signed append-only receipt atomically resolves the handoff and its current parent and child tasks. Exact replay is safe after later rearm.',
    parameters: [idempotencyKeyParameter],
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
      handoffId: { type: 'string', format: 'uuid' },
    },
    request: 'InpatientPendingResultCrossSignRequest',
    response: 'InpatientPendingResultCrossSignResponse',
  }),
  ...admissionAliases('POST /{id}/follow-up-exception', {
    summary: 'Record an audited inpatient follow-up exception',
    description:
      'Records an explicit reason when the admission has no booked follow-up and returns only the canonical staff-safe evidence identifiers.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    request: 'InpatientFollowUpExceptionRequest',
    response: 'InpatientFollowUpExceptionMutationResponse',
    responseStatus: 201,
  }),
  ...admissionAliases('GET /{id}/post-discharge-contacts', {
    summary: 'List post-discharge contact evidence',
    description:
      'Returns the admission-scoped, patient-safe contact timeline without recorder, idempotency, audit, or arbitrary metadata fields.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    response: 'PostDischargeContactListResponse',
  }),
  ...admissionAliases('POST /{id}/post-discharge-contacts', {
    summary: 'Record patient-safe post-discharge contact evidence',
    description:
      'Records an admission-scoped contact attempt or outcome. An idempotent replay also returns 201 with the same patient-safe contact view.',
    pathParameters: {
      id: { type: 'integer', minimum: 1 },
    },
    request: 'PostDischargeContactRequest',
    response: 'PostDischargeContactMutationResponse',
    responseStatus: 201,
  }),
  'POST /api/v1/care-pathways/instances': {
    summary: 'Create a governed care pathway instance',
    description: 'Creates one tenant-scoped pathway instance from an approved workflow definition. Manual ownership is derived from the authenticated actor.',
    parameters: [idempotencyKeyParameter],
    request: 'CarePathwayStartRequest',
    response: 'CarePathwayInstanceResponse',
    responseStatus: 201,
  },
  'GET /api/v1/care-pathways/instances/{id}': {
    summary: 'Retrieve a care pathway instance and its runtime state',
    description: 'Returns the pathway instance with its workflow run, steps, tasks, approvals, and handoffs.',
    pathParameters: {
      id: { type: 'string', format: 'uuid' },
    },
    response: 'CarePathwayInstanceResponse',
  },
  'POST /api/v1/care-pathways/instances/{id}/commands': {
    summary: 'Submit an idempotent command to a care pathway instance',
    description: 'Submits a user-authored signal to the current governed pathway stage. Source lineage fields are reserved for registered system actors and are not accepted here.',
    pathParameters: {
      id: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'CarePathwayCommandRequest',
    response: 'CarePathwayCommandResponse',
  },
  'POST /api/v1/care-pathways/instances/{id}/claim': {
    summary: 'Claim a role-owned care pathway instance',
    description: 'Atomically assigns the live role-owned pathway instance, every actionable pathway task, and every corresponding incomplete SLA to the authenticated clinician only while their current database role exactly matches the queue.',
    pathParameters: {
      id: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    response: 'CarePathwayOwnershipMutationResponse',
  },
  'POST /api/v1/care-pathways/instances/{id}/owner-transfer-requests': {
    summary: 'Request an accepted covering-clinician transfer',
    description: 'Creates an exact-recipient covering-transfer request and review task. The current owner remains responsible until the intended clinician accepts.',
    pathParameters: {
      id: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'CarePathwayOwnerTransferRequest',
    response: 'CarePathwayOwnershipMutationResponse',
  },
  'POST /api/v1/care-pathways/handoffs/{handoffId}/accept': {
    summary: 'Accept a covering-clinician transfer',
    description: 'Lets only the exact intended clinician accept a live covering-transfer request. Acceptance atomically transfers pathway, actionable-task, and incomplete-SLA ownership and records immutable evidence.',
    pathParameters: {
      handoffId: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    response: 'CarePathwayOwnershipMutationResponse',
  },
  'GET /api/v1/care-pathways/handoffs/{handoffId}': {
    summary: 'Read an exact-recipient covering-clinician transfer',
    description: 'Returns the minimal patient and pathway context needed by the exact intended clinician to review a covering-transfer request. Terminal states require coherent immutable transition evidence and remain non-enumerable by handoff UUID.',
    pathParameters: {
      handoffId: { type: 'string', format: 'uuid' },
    },
    response: 'CarePathwayOwnerTransferViewResponse',
  },
  'POST /api/v1/care-pathways/handoffs/{handoffId}/decline': {
    summary: 'Decline a covering-clinician transfer',
    description: 'Lets only the exact intended clinician decline a requested covering transfer with a reason. Declining never changes pathway ownership.',
    pathParameters: {
      handoffId: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'CarePathwayTransferDecisionRequest',
    response: 'CarePathwayOwnershipMutationResponse',
  },
  'POST /api/v1/care-pathways/handoffs/{handoffId}/cancel': {
    summary: 'Cancel a covering-clinician transfer request',
    description: 'Lets only the unchanged current pathway owner cancel their pending covering-transfer request with a reason. Cancelling never changes pathway ownership.',
    pathParameters: {
      handoffId: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'CarePathwayTransferDecisionRequest',
    response: 'CarePathwayOwnershipMutationResponse',
  },
  'GET /api/v1/admin/care-pathways/reconciliation': {
    summary: 'Read the latest care-pathway reconciliation evidence',
    description: 'Returns PHI-free append-only evidence for the request tenant. SUPER_ADMIN cross-tenant access requires the audited x-tenant-id override and reason headers.',
    parameters: reconciliationQueryParameters,
    response: 'CarePathwayReconciliationEvidenceListResponse',
  },
  'GET /api/v1/admin/care-pathways/reconciliation/history': {
    summary: 'Read care-pathway reconciliation evidence history',
    description: 'Returns paginated PHI-free append-only evidence ordered newest first. This endpoint has no mutation, retry, redrive, reset, reassign, dismiss, pass, or mode-change operation.',
    parameters: reconciliationQueryParameters,
    response: 'CarePathwayReconciliationEvidenceListResponse',
  },
};
