export const schemas = {
  PatientNews2Spo2ScaleUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['spo2_scale'],
    properties: {
      spo2_scale: {
        type: 'integer',
        enum: [1, 2],
        description: 'Patient-level NEWS2 oxygen-saturation scoring scale selected from documented clinical evidence.',
      },
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
  'PATCH /api/v1/patients/{uid}/news2-spo2-scale': {
    summary: 'Update a patient NEWS2 SpO2 scale',
    description: 'Updates the patient-level NEWS2 SpO2 scale under clinical-role and patient-access policy checks. The clinical-state update and canonical timeline/audit evidence commit atomically.',
    pathParameters: {
      uid: { type: 'string', format: 'uuid' },
    },
    parameters: [idempotencyKeyParameter],
    request: 'PatientNews2Spo2ScaleUpdateRequest',
  },
};
