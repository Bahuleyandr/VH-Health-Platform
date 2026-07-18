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

export const operations = {
  'POST /api/v1/clinical-inbox/tasks/{id}/acknowledge': {
    summary: 'Acknowledge a clinical inbox task',
    description: 'Stops the linked escalation clock only when the caller has task assignment, assigned-role, task-administrator, or durable patient break-glass authority.',
    request: 'ClinicalInboxTaskAcknowledgeRequest',
    requestRequired: false
  }
};
