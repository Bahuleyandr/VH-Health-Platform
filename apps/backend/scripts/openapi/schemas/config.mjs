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
      },
      outage_communication: {
        type: 'object',
        additionalProperties: false,
        required: ['revision', 'messages', 'facility_contact_number'],
        description: 'Non-PHI C-D12 operational copy only. This is not a policy-delivery channel.',
        properties: {
          revision: {
            type: 'integer',
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER
          },
          messages: {
            type: 'object',
            additionalProperties: false,
            required: ['en', 'hi', 'ta', 'te', 'ml'],
            properties: Object.fromEntries(
              ['en', 'hi', 'ta', 'te', 'ml'].map(locale => [
                locale,
                {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000
                }
              ])
            )
          },
          facility_contact_number: {
            type: 'string',
            pattern: '^\\+?[0-9][0-9 ()-]{2,63}$'
          }
        }
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
