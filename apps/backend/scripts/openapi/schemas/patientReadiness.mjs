import { envelope } from './_helpers.mjs';

export const schemas = {
  PatientReadiness: {
    type: 'object',
    additionalProperties: false,
    required: [
      'readinessContractVersion',
      'readinessPurpose',
      'ready',
      'endpointId',
      'routeKind',
      'tenantId',
      'database',
      'serverTime',
    ],
    properties: {
      readinessContractVersion: { type: 'integer', enum: [1] },
      readinessPurpose: { type: 'string', enum: ['patient_outage'] },
      ready: { type: 'boolean', enum: [true] },
      endpointId: { type: 'string', enum: ['vhhealth-api'] },
      routeKind: { type: 'string', enum: ['public', 'internal'] },
      tenantId: { type: 'string', format: 'uuid' },
      database: { type: 'string', enum: ['ready'] },
      serverTime: { type: 'string', format: 'date-time' },
    },
  },
  PatientReadinessResponse: envelope('PatientReadiness'),
  PatientReadinessFailure: {
    type: 'object',
    additionalProperties: false,
    required: [
      'readinessContractVersion',
      'readinessPurpose',
      'ready',
      'serverTime',
      'state',
    ],
    properties: {
      readinessContractVersion: { type: 'integer', enum: [1] },
      readinessPurpose: { type: 'string', enum: ['patient_outage'] },
      ready: { type: 'boolean', enum: [false] },
      routeKind: { type: 'string', enum: ['public', 'internal'] },
      serverTime: { type: 'string', format: 'date-time' },
      state: {
        type: 'string',
        enum: ['endpoint_unverified', 'database_unavailable'],
      },
    },
  },
  PatientReadinessFailureResponse: {
    type: 'object',
    required: ['success', 'message', 'code', 'details'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      code: { type: 'string', enum: ['PATIENT_NOT_READY'] },
      details: {
        type: 'object',
        additionalProperties: false,
        required: ['readiness'],
        properties: {
          readiness: { $ref: '#/components/schemas/PatientReadinessFailure' },
        },
      },
      requestId: { type: 'string' },
    },
  },
};

export const operations = {
  'GET /api/v1/health/patient-readiness': {
    summary: 'Confirm patient app operational readiness',
    description:
      'Patient-only, low-information proof of the trusted ingress route, resolved active tenant, primary database, and server time. This contract intentionally does not report clinical-continuity policy state.',
    response: 'PatientReadinessResponse',
    additionalResponses: {
      503: {
        description: 'Patient readiness could not be verified',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PatientReadinessFailureResponse' },
          },
        },
      },
    },
  },
};
