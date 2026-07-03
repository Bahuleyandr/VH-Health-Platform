import { envelope } from './_helpers.mjs';

export const schemas = {
  PatientAccountDeletionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['firebaseIdToken'],
    properties: {
      firebaseIdToken: {
        type: 'string',
        minLength: 10,
        maxLength: 4096,
        description: 'Fresh Firebase ID token from an OTP re-authentication challenge.'
      },
      reason: {
        type: 'string',
        maxLength: 160,
        description: 'Optional operator-facing deletion reason; defaults to patient_self_service.'
      }
    }
  },

  PatientAccountDeletionResult: {
    type: 'object',
    additionalProperties: false,
    required: ['uid', 'deleted', 'clinicalRecordsRetained'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      deleted: { type: 'boolean', example: true },
      clinicalRecordsRetained: { type: 'boolean', example: true }
    }
  },

  PatientAccountDeletionResponse: envelope('PatientAccountDeletionResult')
};

export const operations = {
  'DELETE /api/v1/users/me/account': {
    request: 'PatientAccountDeletionRequest',
    response: 'PatientAccountDeletionResponse'
  }
};
