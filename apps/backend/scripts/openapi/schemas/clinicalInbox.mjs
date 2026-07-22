export const schemas = {
  ClinicalInboxTaskAcknowledgeRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      break_glass_id: {
        type: 'integer',
        minimum: 1,
        maximum: 2147483647,
        description: 'Optional active patient-access break-glass record bound to the caller and task patient.'
      }
    }
  },
  DiagnosticDownstreamEvidence: {
    type: 'object',
    additionalProperties: false,
    required: ['resource_type', 'resource_id'],
    properties: {
      resource_type: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,79}$' },
      resource_id: { type: 'string', minLength: 1, maxLength: 160 },
    },
  },
  DiagnosticResultActionRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'task_id',
      'disposition',
      'clinical_note',
      'generation_snapshot_sha256',
      'attested',
    ],
    properties: {
      task_id: { type: 'integer', minimum: 1, maximum: 2147483647 },
      disposition: {
        type: 'string',
        enum: ['treated', 'repeated', 'referred', 'no_action'],
      },
      clinical_note: { type: 'string', minLength: 1, maxLength: 8000 },
      reason: { type: 'string', minLength: 1, maxLength: 4000 },
      generation_snapshot_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      downstream_evidence: { $ref: '#/components/schemas/DiagnosticDownstreamEvidence' },
      attested: {
        type: 'boolean',
        enum: [true],
        description: 'Explicit clinician confirmation of the electronic attestation statement.',
      },
    },
  },
  DiagnosticResultReopenRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 4000 },
    },
  },
};

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

export const operations = {
  'POST /api/v1/clinical-inbox/tasks/{id}/acknowledge': {
    summary: 'Acknowledge a clinical inbox task',
    description: 'Stops the linked escalation clock only when the caller has task assignment, assigned-role, task-administrator, or durable patient break-glass authority.',
    request: 'ClinicalInboxTaskAcknowledgeRequest',
    requestRequired: false
  },
  'POST /api/v1/clinical-inbox/tasks/{id}/claim': {
    summary: 'Claim a role-owned clinical inbox task',
    description: 'Atomically assigns an actionable role-queue task to the authenticated clinician only while their current database role still exactly matches the queue. Claiming does not acknowledge or complete the task or its linked SLA.',
    pathParameters: {
      id: { type: 'integer', minimum: 1, maximum: 2147483647 },
    },
    parameters: [idempotencyKeyParameter]
  },
  'POST /api/v1/clinical-inbox/diagnostic-results/{generationId}/actions': {
    summary: 'Record a doctor-signed diagnostic result action',
    description: 'Completes only the current doctor-owned domain-evidence task and atomically records the disposition, signature, pathway transition, and minimal-PHI event.',
    pathParameters: {
      generationId: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'DiagnosticResultActionRequest',
  },
  'POST /api/v1/clinical-inbox/diagnostic-results/{generationId}/reopen': {
    summary: 'Reopen an auto-closed normal diagnostic result',
    description: 'Allows the exact current pathway owner to preserve the prior closure and create a new doctor-review obligation with an audited reason.',
    pathParameters: {
      generationId: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'DiagnosticResultReopenRequest',
  },
};
