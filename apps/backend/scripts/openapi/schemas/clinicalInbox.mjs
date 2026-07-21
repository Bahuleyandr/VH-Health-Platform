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
  }
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
  }
};
