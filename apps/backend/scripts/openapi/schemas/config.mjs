import { envelope } from './_helpers.mjs';

export const schemas = {
  PatientAppConfig: {
    type: 'object',
    additionalProperties: false,
    required: ['min_patient_version_code'],
    properties: {
      min_patient_version_code: {
        type: 'integer',
        minimum: 0,
        example: 0,
        description: 'Minimum accepted patient app build number. 0 disables the hard upgrade gate.'
      }
    }
  },

  PatientAppConfigResponse: envelope('PatientAppConfig')
};

export const operations = {
  'GET /api/v1/config': {
    response: 'PatientAppConfigResponse'
  }
};
