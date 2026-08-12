import { envelope } from './_helpers.mjs';

const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_:.-]+$',
  },
};

const errorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/WearableVitalCorrectionErrorResponse' },
    },
  },
});

export const schemas = {
  WearableBloodPressure: {
    type: 'object',
    additionalProperties: false,
    properties: {
      systolic: { type: 'number' },
      diastolic: { type: 'number' },
    },
    anyOf: [{ required: ['systolic'] }, { required: ['diastolic'] }],
  },
  WearableVitalCorrectionRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'recordedAtSource'],
    properties: {
      source: {
        type: 'string',
        enum: ['healthkit', 'health_connect', 'google_fit'],
      },
      sourceRecordId: {
        type: 'string',
        pattern: '^[A-Za-z0-9_.:-]{1,180}$',
        description:
          'Compatibility copy sent by the current client; the path parameter remains authoritative.',
      },
      recordedAtSource: { type: 'string', format: 'date-time' },
      bloodPressure: { $ref: '#/components/schemas/WearableBloodPressure' },
      heartRate: { type: 'integer' },
      temperature: { type: 'number' },
      bloodSugar: { type: 'integer' },
      weight: { type: 'number', minimum: 0, maximum: 600, not: { enum: [0] } },
      spO2: { type: 'integer' },
    },
    anyOf: [
      { required: ['bloodPressure'] },
      { required: ['heartRate'] },
      { required: ['temperature'] },
      { required: ['bloodSugar'] },
      { required: ['weight'] },
      { required: ['spO2'] },
    ],
  },
  WearableVitalCorrectionReceipt: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceRecordId', 'sourceRecordHash', 'corrected', 'duplicate'],
    properties: {
      sourceRecordId: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,180}$' },
      sourceRecordHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      corrected: { type: 'boolean' },
      duplicate: { type: 'boolean' },
    },
  },
  WearableVitalCorrectionResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'recordedAt',
      'source',
      'sourceRecordId',
      'recordedAtSource',
      'syncReceipt',
    ],
    properties: {
      id: { type: 'integer' },
      recordedAt: { type: 'string', format: 'date-time' },
      source: {
        type: 'string',
        enum: ['healthkit', 'health_connect', 'google_fit'],
      },
      sourceRecordId: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,180}$' },
      recordedAtSource: { type: 'string', format: 'date-time' },
      syncReceipt: { $ref: '#/components/schemas/WearableVitalCorrectionReceipt' },
    },
  },
  WearableVitalCorrectionResponse: envelope('WearableVitalCorrectionResult'),
  WearableVitalCorrectionErrorResponse: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: true,
        required: ['success'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          message: { type: 'string' },
          code: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
          requestId: { type: 'string' },
        },
      },
      {
        type: 'object',
        additionalProperties: true,
        required: ['error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
    ],
  },
};

export const operations = {
  'PUT /api/v1/health/patient/vitals/wearable/{sourceRecordId}': {
    summary: 'Correct one patient-owned wearable vital receipt',
    description:
      'Patient-only correction of the exact tenant-, patient-, provider-, and source-record-bound ' +
      'wearable receipt. The original server receipt time remains immutable; a changed payload ' +
      'atomically updates the source observation and appends canonical clinical timeline and audit ' +
      'evidence. An identical replay returns the prior receipt without another correction event.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    pathParameters: {
      sourceRecordId: {
        type: 'string',
        pattern: '^[A-Za-z0-9_.:-]{1,180}$',
      },
    },
    parameters: [idempotencyKeyParameter],
    request: 'WearableVitalCorrectionRequest',
    response: 'WearableVitalCorrectionResponse',
    responseDescription: 'The corrected or already-applied wearable receipt.',
    additionalResponses: {
      400: errorResponse('The path, wearable payload, source timestamp, or Idempotency-Key was invalid.'),
      401: errorResponse('The API key or bearer access token was missing, invalid, expired, or revoked.'),
      403: errorResponse('The authenticated caller was not a patient authorized for this operation.'),
      404: errorResponse('No matching wearable receipt exists for the authenticated patient.'),
      409: errorResponse('The correction or its Idempotency-Key is already in flight or conflicted.'),
      422: errorResponse('The Idempotency-Key was reused with a different request body.'),
      429: errorResponse('The authenticated caller exceeded the health-route rate limit.'),
      500: errorResponse('The correction failed without exposing internal details.'),
      503: errorResponse('Authentication revocation state or the idempotency store could not be verified.'),
    },
  },
};
