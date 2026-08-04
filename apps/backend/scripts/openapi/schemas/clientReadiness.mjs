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
  ClientReadinessFacility: {
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
      'facilityId',
      'contextId',
      'contextRevision',
      'serverTime',
    ],
    properties: {
      readinessContractVersion: { type: 'integer', enum: [2] },
      ready: { type: 'boolean', enum: [true] },
      endpointId: { type: 'string', enum: ['vhhealth-api'] },
      routeKind: { type: 'string', enum: ['public', 'internal'] },
      tenantId: { type: 'string', format: 'uuid' },
      database: { type: 'string', enum: ['ready'] },
      policy: { $ref: '#/components/schemas/ClientReadinessPolicy' },
      facilityId: { type: 'string' },
      contextId: { type: 'string', format: 'uuid' },
      // A Postgres bigint sequence (clinical_continuity_context_revision_seq) stringified to
      // avoid precision loss -- never coerced back to a number before it reaches the response.
      contextRevision: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' },
      serverTime: { type: 'string', format: 'date-time' },
    },
  },
  ClientReadinessFacilityResponse: envelope('ClientReadinessFacility'),
};

export const operations = {
  'GET /api/v1/health/client-readiness': {
    summary: 'Confirm authenticated client drain readiness',
    description:
      'Low-information authenticated proof of endpoint route, tenant, database, policy compatibility, and server time.',
    response: 'ClientReadinessResponse',
  },
  'POST /api/v1/health/client-readiness/v2': {
    summary: 'Confirm client readiness for a specific facility context',
    description:
      'Facility-scoped readiness probe, staff-only (no patient access, unlike the plain GET ' +
      'probe): callers submit a previously-issued clinical-continuity facility-context envelope ' +
      'in the request body, which the server cryptographically re-validates against the ' +
      'caller\'s own tenant plus the named facility (the facility is an added scoping dimension, ' +
      'not an alternate tenant scope) and returns a distinct contract-version-2 payload. Read-' +
      'only, runs in a read-only transaction, and is never cached. Gated behind the same ' +
      'hardcoded-false CLINICAL_CONTINUITY_C_D14_APPROVED compile-time constant as facility-' +
      'context issuance, which no deployment configuration can override, so this endpoint ' +
      'currently always responds 503.',
    response: 'ClientReadinessFacilityResponse',
  },
};
