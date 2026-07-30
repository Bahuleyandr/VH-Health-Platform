import { envelope } from './_helpers.mjs';

export const schemas = {
  ClientReadinessPolicy: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'schemaVersion'],
    properties: {
      state: {
        type: 'string',
        enum: ['compatible'],
      },
      schemaVersion: { type: 'integer', minimum: 1 },
    },
  },
  ClientReadiness: {
    type: 'object',
    additionalProperties: false,
    required: [
      'readinessContractVersion',
      'ready',
      'endpointId',
      'routeKind',
      'tenantId',
      'database',
      'policy',
      'serverTime',
    ],
    properties: {
      readinessContractVersion: { type: 'integer', enum: [1] },
      ready: { type: 'boolean', enum: [true] },
      endpointId: { type: 'string', enum: ['vhhealth-api'] },
      routeKind: { type: 'string', enum: ['public', 'internal'] },
      tenantId: { type: 'string', format: 'uuid' },
      database: { type: 'string', enum: ['ready'] },
      policy: { $ref: '#/components/schemas/ClientReadinessPolicy' },
      serverTime: { type: 'string', format: 'date-time' },
    },
  },
  ClientReadinessResponse: envelope('ClientReadiness'),
};

export const operations = {
  'GET /api/v1/health/client-readiness': {
    summary: 'Confirm authenticated client drain readiness',
    description:
      'Low-information authenticated proof of endpoint route, tenant, database, policy compatibility, and server time.',
    response: 'ClientReadinessResponse',
  },
};
