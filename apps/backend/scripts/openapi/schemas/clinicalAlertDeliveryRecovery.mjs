import { envelope } from './_helpers.mjs';

const bigintId = {
  oneOf: [
    { type: 'integer', minimum: 1 },
    { type: 'string', pattern: '^[1-9][0-9]*$' },
  ],
};
const nullableBigintId = { ...bigintId, nullable: true };
const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const authenticatedSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];

export const schemas = {
  ClinicalAlertRecoveryReasonRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 10, maxLength: 1000 },
    },
  },
  ClinicalAlertRecoveryCase: {
    type: 'object',
    additionalProperties: false,
    required: [
      'case_id',
      'case_kind',
      'case_status',
      'obligation_id',
      'due_at',
      'open_age_seconds',
      'overdue',
      'sla_rule_code',
      'sla_status',
      'task_id',
      'task_status',
    ],
    properties: {
      case_id: bigintId,
      case_kind: { type: 'string', enum: ['manual_hold', 'recipient_coverage'] },
      case_status: { type: 'string', enum: ['open', 'resolved'] },
      obligation_id: bigintId,
      first_observed_at: { type: 'string', format: 'date-time' },
      last_observed_at: { type: 'string', format: 'date-time' },
      observation_count: { type: 'integer', minimum: 1 },
      due_at: { type: 'string', format: 'date-time' },
      open_age_seconds: bigintId,
      overdue: { type: 'boolean' },
      escalation_attempt_count: { type: 'integer', minimum: 0 },
      last_escalation_attempt_at: nullableDateTime,
      last_escalation_error_code: { type: 'string', nullable: true },
      escalated_at: nullableDateTime,
      resolution_kind: { type: 'string', nullable: true },
      resolution_action_id: nullableBigintId,
      replacement_obligation_id: nullableBigintId,
      resolved_by_uid: nullableUuid,
      resolution_reason: { type: 'string', nullable: true },
      resolved_at: nullableDateTime,
      source_table: { type: 'string' },
      source_id: { type: 'string' },
      source_event_key: { type: 'string' },
      failure_kind: { type: 'string' },
      patient_uid: nullableUuid,
      encounter_id: nullableUuid,
      obligation_status: { type: 'string' },
      obligation_attempt_count: { type: 'integer', minimum: 0 },
      last_attempted_at: nullableDateTime,
      next_attempt_at: nullableDateTime,
      last_error_code: { type: 'string', nullable: true },
      manual_hold_code: { type: 'string', nullable: true },
      manual_hold_reason: { type: 'string', nullable: true },
      held_at: nullableDateTime,
      workflow_sla_instance_id: { type: 'string', format: 'uuid' },
      sla_rule_code: { type: 'string' },
      sla_status: { type: 'string' },
      sla_breached_at: nullableDateTime,
      sla_escalated_at: nullableDateTime,
      sla_completed_at: nullableDateTime,
      task_id: { type: 'integer', minimum: 1 },
      task_status: { type: 'string' },
      assigned_to_uid: nullableUuid,
      assigned_to_role: { type: 'string', nullable: true },
      replacement_obligation_status: { type: 'string', nullable: true },
    },
  },
  ClinicalAlertRecoveryCaseList: {
    type: 'object',
    additionalProperties: false,
    required: ['cases', 'count', 'limit'],
    properties: {
      cases: {
        type: 'array',
        items: { $ref: '#/components/schemas/ClinicalAlertRecoveryCase' },
      },
      count: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  ClinicalAlertRecoveryAction: {
    type: 'object',
    additionalProperties: false,
    required: ['case_id', 'obligation_id', 'outcome', 'action_id', 'replayed'],
    properties: {
      case_id: bigintId,
      obligation_id: bigintId,
      outcome: {
        type: 'string',
        enum: ['awaiting_recipients', 'recovered', 'held', 'superseded'],
      },
      action_id: bigintId,
      replayed: { type: 'boolean' },
      manual_hold_case_created: { type: 'boolean' },
      replacement_obligation_id: bigintId,
      replacement_status: { type: 'string' },
    },
  },
  ClinicalAlertRecoveryCaseResponse: envelope('ClinicalAlertRecoveryCase'),
  ClinicalAlertRecoveryCaseListResponse: envelope('ClinicalAlertRecoveryCaseList'),
  ClinicalAlertRecoveryActionResponse: envelope('ClinicalAlertRecoveryAction'),
};

const idempotencyKey = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Stable command key. Exact retries replay; payload mismatches are rejected.',
  schema: { type: 'string', minLength: 1, maxLength: 200 },
};

export const operations = {
  'GET /api/v1/admin/clinical-alert-delivery/recovery-cases': {
    description: 'Lists governed manual-hold and no-recipient alert recovery cases with their task and SLA state.',
    response: 'ClinicalAlertRecoveryCaseListResponse',
    parameters: [
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['open', 'resolved', 'all'], default: 'open' },
      },
      {
        name: 'case_kind',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['manual_hold', 'recipient_coverage'] },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
    ],
    security: authenticatedSecurity,
  },
  'GET /api/v1/admin/clinical-alert-delivery/recovery-cases/{caseId}': {
    description: 'Returns one exact tenant-scoped alert recovery case for the Staff workbench.',
    response: 'ClinicalAlertRecoveryCaseResponse',
    pathParameters: { caseId: { type: 'string', pattern: '^[1-9][0-9]*$' } },
    security: authenticatedSecurity,
  },
  'POST /api/v1/admin/clinical-alert-delivery/recovery-cases/{caseId}/retry': {
    description: 'Retries the immutable stored alert intent after recipient coverage has been restored.',
    request: 'ClinicalAlertRecoveryReasonRequest',
    response: 'ClinicalAlertRecoveryActionResponse',
    pathParameters: { caseId: { type: 'string', pattern: '^[1-9][0-9]*$' } },
    parameters: [idempotencyKey],
    security: authenticatedSecurity,
  },
  'POST /api/v1/admin/clinical-alert-delivery/recovery-cases/{caseId}/supersede': {
    description: 'Appends a source-derived successor to an immutable manual-hold obligation.',
    request: 'ClinicalAlertRecoveryReasonRequest',
    response: 'ClinicalAlertRecoveryActionResponse',
    pathParameters: { caseId: { type: 'string', pattern: '^[1-9][0-9]*$' } },
    parameters: [idempotencyKey],
    security: authenticatedSecurity,
  },
};
