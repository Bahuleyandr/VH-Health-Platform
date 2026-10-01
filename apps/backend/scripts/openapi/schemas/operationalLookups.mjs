import { envelope } from './_helpers.mjs';

const AUTHENTICATED_SECURITY = [{ ApiKeyAuth: [], BearerAuth: [] }];
const CURSOR_PATTERN = '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$';
const DATE_PATTERN = '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$';
const TIME_PATTERN = '^(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?|24:00:00)$';

const paginationParameters = [
  {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Maximum items per page. Keep the same limit when following a continuation cursor.',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
  },
  {
    name: 'cursor',
    in: 'query',
    required: false,
    description:
      'Opaque continuation returned by the previous page, bound to the effective tenant, endpoint, filter, page limit and ordering. Modification or reuse with a different context is rejected. It does not grant resource or write access.',
    schema: { type: 'string', minLength: 1, maxLength: 2048, pattern: CURSOR_PATTERN },
  },
];

const lookupPage = itemSchema => ({
  type: 'object',
  additionalProperties: false,
  required: ['items', 'next_cursor'],
  properties: {
    items: {
      type: 'array',
      maxItems: 200,
      items: { $ref: `#/components/schemas/${itemSchema}` },
    },
    next_cursor: {
      type: 'string',
      nullable: true,
      maxLength: 2048,
      pattern: CURSOR_PATTERN,
      description: 'Follow with unchanged filters and limit; null means there is no following page.',
    },
  },
});

const lookupEnvelope = payloadSchema => {
  const response = envelope(payloadSchema);
  return {
    ...response,
    additionalProperties: false,
    properties: {
      ...response.properties,
      success: { type: 'boolean', enum: [true] },
    },
  };
};

const errorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/OperationalLookupErrorResponse' },
    },
  },
});

const lookupErrors = {
  400: errorResponse('INVALID_LOOKUP_QUERY: malformed or unsupported query parameters, or an invalid continuation context.'),
  401: errorResponse('The API key or bearer token was missing, invalid, expired or revoked.'),
  403: errorResponse('The role or token scope was denied, or TENANT_CONTEXT_REQUIRED: no valid effective tenant was resolved.'),
  503: errorResponse('LOOKUP_UNAVAILABLE: a temporary database dependency failure; no lookup page is returned. Authentication dependencies may also fail closed.'),
  500: errorResponse('The lookup could not be completed; no source data or empty-success fallback is returned.'),
};

export const schemas = {
  LinenWardLookupItem: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'name'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      name: { type: 'string' },
    },
  },
  CssdTheatreLookupItem: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'scheduled_date', 'scheduled_time'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      scheduled_date: { type: 'string', format: 'date', pattern: DATE_PATTERN },
      scheduled_time: {
        type: 'string',
        nullable: true,
        pattern: TIME_PATTERN,
        description: 'Stored schedule time, including fractional seconds when present; not a UTC timestamp.',
      },
    },
  },
  LinenWardLookupPage: lookupPage('LinenWardLookupItem'),
  CssdTheatreLookupPage: lookupPage('CssdTheatreLookupItem'),
  LinenWardLookupResponse: lookupEnvelope('LinenWardLookupPage'),
  CssdTheatreLookupResponse: lookupEnvelope('CssdTheatreLookupPage'),
  OperationalLookupErrorResponse: {
    type: 'object',
    anyOf: [{ required: ['success'] }, { required: ['error'] }],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      error: { type: 'string' },
      code: { type: 'string' },
      requestId: { type: 'string', nullable: true },
    },
  },
};

export const operations = {
  'GET /api/v1/linen-laundry/wards': {
    summary: 'List minimal ward options for Linen operations',
    description:
      'Returns only ward id and name within the authenticated effective tenant, across its facilities, including first-use wards and wards without facility mapping. Allowed roles are ADMIN, ADMISSION_OFFICER, CONSULTANT, DOCTOR, DUTY_DOCTOR, HOUSEKEEPING_INCHARGE, HOUSEKEEPING_STAFF, ICU_INCHARGE, ICU_NURSE, ICU_STAFF, IPD_COUNSELLOR, IP_INCHARGE, IP_STAFF_NURSE, JUNIOR_DOCTOR, NURSING_INCHARGE, NURSING_STAFF, PHARMACY_INCHARGE, RESIDENT, SENIOR_DOCTOR, STORES_PURCHASE_INCHARGE and SUPER_ADMIN. Scoped ADMIN does not need departmentManagement for this directory. Ward-name substring search is case-insensitive and results are ordered by name, then id. Only q, limit and cursor query parameters are accepted; tenant overrides, facility filters and response expansion are rejected. Every page requires current authorization, including an effective tenant for SUPER_ADMIN. Responses use Cache-Control: private, no-store. An empty authorized result is items:[] with next_cursor:null. This directory grants neither broad ward access nor write authority; existing write checks remain separate.',
    response: 'LinenWardLookupResponse',
    parameters: [
      {
        name: 'q',
        in: 'query',
        required: false,
        description: 'Optional ward-name substring, trimmed before matching within the effective tenant.',
        schema: { type: 'string', maxLength: 80 },
      },
      ...paginationParameters,
    ],
    security: AUTHENTICATED_SECURITY,
    additionalResponses: lookupErrors,
  },
  'GET /api/v1/cssd/theatre-options': {
    summary: 'List minimal theatre case options for CSSD',
    description:
      'Returns only case id, scheduled_date and scheduled_time within the authenticated effective tenant, for exactly the requested stored schedule date and states scheduled, pre_op or in_progress. No additional age cutoff or facility mapping is required. Allowed roles are ADMIN, ANAESTHETIST, ANESTHETIST, CONSULTANT, DOCTOR, DUTY_DOCTOR, INFECTION_CONTROL_OFFICER, JUNIOR_DOCTOR, NURSING_STAFF, OT_INCHARGE, OT_NURSE, OT_STAFF, QUALITY_OFFICER, RESIDENT and SUPER_ADMIN. COMPLIANCE_OFFICER, DATA_PROTECTION_OFFICER, HR_STAFF, PHARMACY_INCHARGE and STORES_PURCHASE_INCHARGE remain denied this lookup without changing their existing write permissions. Items are ordered by scheduled time with nulls last, then id, and can be labelled by case number and time with the requested date visible. These are restricted operational metadata, not anonymous or public data. No patient identifiers, procedure text, room text, clinical records or occupancy are returned. Only date, limit and cursor query parameters are accepted; no tenant override, facility filter, text search, date range or expansion is supported. Every page requires current authorization and an effective tenant, including SUPER_ADMIN. Responses use Cache-Control: private, no-store. This directory grants neither theatre-record access nor issuance authority; writes retain their separate authorization and validation.',
    response: 'CssdTheatreLookupResponse',
    parameters: [
      {
        name: 'date',
        in: 'query',
        required: true,
        description: 'One real calendar date in YYYY-MM-DD form, using the stored schedule date convention without a timezone conversion or new age cutoff.',
        schema: { type: 'string', format: 'date', pattern: DATE_PATTERN },
      },
      ...paginationParameters,
    ],
    security: AUTHENTICATED_SECURITY,
    additionalResponses: lookupErrors,
  },
};
