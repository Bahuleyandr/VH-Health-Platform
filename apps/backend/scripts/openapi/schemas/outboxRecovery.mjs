import { envelope } from './_helpers.mjs';

const nullableDateTime = { type: 'string', format: 'date-time', nullable: true };
const nullableUuid = { type: 'string', format: 'uuid', nullable: true };
const bigintId = { type: 'string', pattern: '^[1-9][0-9]*$' };
const reasonRequest = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
};

export const schemas = {
  OutboxReasonRequest: reasonRequest,
  EventOutboxRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'event_type', 'aggregate_type', 'status', 'attempts', 'redrive_count'],
    properties: {
      id: bigintId,
      event_type: { type: 'string', minLength: 1, maxLength: 120 },
      aggregate_type: { type: 'string', minLength: 1, maxLength: 80 },
      aggregate_id: { type: 'string', nullable: true, maxLength: 120 },
      patient_uid: nullableUuid,
      payload: { type: 'object', additionalProperties: true },
      status: { type: 'string', enum: ['pending', 'processing', 'delivered', 'failed'] },
      attempts: { type: 'integer', minimum: 0 },
      available_at: { type: 'string', format: 'date-time' },
      last_error: { type: 'string', nullable: true },
      delivered_at: nullableDateTime,
      lease_owner: nullableUuid,
      lease_expires_at: nullableDateTime,
      redrive_count: { type: 'integer', minimum: 0 },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  EventOutboxList: {
    type: 'object',
    additionalProperties: false,
    required: ['events', 'count'],
    properties: {
      events: { type: 'array', items: { $ref: '#/components/schemas/EventOutboxRow' } },
      count: { type: 'integer', minimum: 0 },
    },
  },
  EventOutboxListResponse: envelope('EventOutboxList'),
  EventOutboxRowResponse: envelope('EventOutboxRow'),

  WebhookDeliveryRow: {
    type: 'object',
    additionalProperties: true,
    required: ['id', 'event_type', 'status', 'attempt_number', 'redrive_count'],
    properties: {
      id: { type: 'integer', minimum: 1 },
      subscription_id: { type: 'integer', minimum: 1, nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      event_outbox_id: { ...bigintId, nullable: true },
      event_type: { type: 'string', minLength: 1, maxLength: 120 },
      payload: { type: 'object', additionalProperties: true },
      status: { type: 'string', enum: ['pending', 'in_flight', 'succeeded', 'failed', 'dead'] },
      attempt_number: { type: 'integer', minimum: 0 },
      http_status: { type: 'integer', nullable: true, minimum: 100, maximum: 599 },
      response_excerpt: { type: 'string', nullable: true, maxLength: 2000 },
      error_message: { type: 'string', nullable: true },
      request_id: { type: 'string', nullable: true, maxLength: 64 },
      started_at: nullableDateTime,
      completed_at: nullableDateTime,
      next_retry_at: nullableDateTime,
      lease_owner: nullableUuid,
      lease_expires_at: nullableDateTime,
      redrive_count: { type: 'integer', minimum: 0 },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  WebhookDeliveryList: {
    type: 'object',
    additionalProperties: false,
    required: ['deliveries', 'count'],
    properties: {
      deliveries: { type: 'array', items: { $ref: '#/components/schemas/WebhookDeliveryRow' } },
      count: { type: 'integer', minimum: 0 },
    },
  },
  WebhookDeliveryListResponse: envelope('WebhookDeliveryList'),
  WebhookDeliveryRowResponse: envelope('WebhookDeliveryRow'),
  WebhookEnqueueRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['event_type'],
    properties: {
      event_type: { type: 'string', minLength: 1, maxLength: 120 },
      payload: { type: 'object', additionalProperties: true },
      request_id: { type: 'string', minLength: 1, maxLength: 64 },
    },
  },
  WebhookEnqueueResult: {
    type: 'object',
    additionalProperties: false,
    required: ['matched', 'enqueued'],
    properties: {
      matched: { type: 'integer', minimum: 0 },
      enqueued: { type: 'array', items: { $ref: '#/components/schemas/WebhookDeliveryRow' } },
    },
  },
  WebhookEnqueueResponse: envelope('WebhookEnqueueResult'),
  WebhookDispatchRequest: {
    type: 'object',
    additionalProperties: false,
    properties: {
      batch_size: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
  WebhookDispatchResult: {
    type: 'object',
    additionalProperties: false,
    required: ['dispatched', 'succeeded', 'failed', 'dead', 'parked', 'lost_fence', 'orphaned'],
    properties: {
      dispatched: { type: 'integer', minimum: 0 },
      succeeded: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
      dead: { type: 'integer', minimum: 0 },
      parked: { type: 'integer', minimum: 0 },
      lost_fence: { type: 'integer', minimum: 0 },
      orphaned: { type: 'integer', minimum: 0 },
    },
  },
  WebhookDispatchResponse: envelope('WebhookDispatchResult'),
};

export const operations = {
  'GET /api/v1/admin/events': {
    response: 'EventOutboxListResponse',
    parameters: [
      {
        name: 'status',
        in: 'query',
        required: false,
        schema: { type: 'string', enum: ['pending', 'processing', 'delivered', 'failed'], default: 'pending' },
      },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 10000, default: 0 } },
    ],
  },
  'POST /api/v1/admin/events/{id}/redrive': {
    pathParameters: { id: bigintId },
    request: 'OutboxReasonRequest',
    response: 'EventOutboxRowResponse',
  },
  'GET /api/v1/admin/webhook-deliveries': {
    response: 'WebhookDeliveryListResponse',
  },
  'POST /api/v1/admin/webhook-deliveries/enqueue': {
    request: 'WebhookEnqueueRequest',
    response: 'WebhookEnqueueResponse',
    responseStatus: 201,
  },
  'POST /api/v1/admin/webhook-deliveries/dispatch-now': {
    request: 'WebhookDispatchRequest',
    requestRequired: false,
    response: 'WebhookDispatchResponse',
    responseStatus: 201,
  },
  'GET /api/v1/admin/webhook-deliveries/{id}': {
    pathParameters: { id: { type: 'integer', minimum: 1 } },
    response: 'WebhookDeliveryRowResponse',
  },
  'PATCH /api/v1/admin/webhook-deliveries/{id}/mark-dead': {
    pathParameters: { id: { type: 'integer', minimum: 1 } },
    request: 'OutboxReasonRequest',
    response: 'WebhookDeliveryRowResponse',
  },
  'POST /api/v1/admin/webhook-deliveries/{id}/redrive': {
    pathParameters: { id: { type: 'integer', minimum: 1 } },
    request: 'OutboxReasonRequest',
    response: 'WebhookDeliveryRowResponse',
    responseStatus: 201,
  },
};
