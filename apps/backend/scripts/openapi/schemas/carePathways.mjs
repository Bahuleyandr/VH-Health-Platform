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
};

export const operations = {
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
};
