import { envelope } from './_helpers.mjs';

const errorResponse = (description) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/NotificationAuthorityErrorResponse' },
    },
  },
});

export const schemas = {
  NotificationAuthorityValidationRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'version',
      'tenantId',
      'recipientUid',
      'deviceId',
      'registrationEpoch',
      'sessionEpoch',
      'authorizationEpoch',
    ],
    properties: {
      version: { type: 'integer', enum: [1] },
      tenantId: { type: 'string', format: 'uuid' },
      recipientUid: { type: 'string', format: 'uuid' },
      deviceId: { type: 'string', minLength: 1 },
      registrationEpoch: { type: 'string', pattern: '^[0-9]+$' },
      sessionEpoch: { type: 'string', minLength: 1 },
      authorizationEpoch: { type: 'string', pattern: '^[0-9]+$' },
    },
  },
  NotificationAuthorityValidationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['authorized'],
    properties: {
      authorized: { type: 'boolean' },
    },
  },
  NotificationAuthorityValidationResponse: envelope('NotificationAuthorityValidationResult'),
  CodeBlueNotificationContentRequest: {
    type: 'object',
    additionalProperties: false,
    required: [
      'version',
      'tenantId',
      'recipientUid',
      'deviceId',
      'registrationEpoch',
      'sessionEpoch',
      'authorizationEpoch',
      'codeBlueReference',
    ],
    properties: {
      version: { type: 'integer', enum: [1] },
      tenantId: { type: 'string', format: 'uuid' },
      recipientUid: { type: 'string', format: 'uuid' },
      deviceId: { type: 'string', minLength: 1 },
      registrationEpoch: { type: 'string', pattern: '^[0-9]+$' },
      sessionEpoch: { type: 'string', minLength: 1 },
      authorizationEpoch: { type: 'string', pattern: '^[0-9]+$' },
      codeBlueReference: {
        type: 'string',
        minLength: 32,
        maxLength: 2048,
        pattern: '^v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$',
      },
    },
  },
  CodeBlueNotificationContent: {
    type: 'object',
    additionalProperties: false,
    required: ['eventId', 'patientId', 'ward', 'bedNumber', 'reason', 'startedAt'],
    properties: {
      eventId: { type: 'string', pattern: '^[0-9]+$' },
      patientId: { type: 'string', format: 'uuid' },
      ward: { type: 'string', nullable: true },
      bedNumber: { type: 'string', nullable: true },
      reason: { type: 'string', nullable: true },
      startedAt: { type: 'string', format: 'date-time' },
    },
  },
  CodeBlueNotificationContentResult: {
    type: 'object',
    additionalProperties: false,
    required: ['authorized', 'content'],
    properties: {
      authorized: { type: 'boolean' },
      content: {
        allOf: [{ $ref: '#/components/schemas/CodeBlueNotificationContent' }],
        nullable: true,
      },
    },
  },
  CodeBlueNotificationContentResponse: envelope('CodeBlueNotificationContentResult'),
  NotificationAuthorityErrorResponse: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: true,
        required: ['success', 'message'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          message: { type: 'string' },
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
  'POST /api/v1/devices/notification-authority/validate': {
    summary: 'Validate the current notification delivery authority',
    description:
      'Fail-closed authorization check used before a Staff client presents a Code Blue push. ' +
      'The authenticated tenant, recipient, access session, device registration epoch, session ' +
      'family, and authorization epoch must still match the server-owned notification binding.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    request: 'NotificationAuthorityValidationRequest',
    response: 'NotificationAuthorityValidationResponse',
    responseDescription: 'The current server-owned authority decision.',
    additionalResponses: {
      400: errorResponse('The authenticated identity or request was malformed.'),
      401: errorResponse('The API key or bearer access token was missing, invalid, expired, or revoked.'),
      403: errorResponse('The requested tenant or recipient did not match the authenticated caller.'),
      429: errorResponse('The authenticated caller exceeded the device-route rate limit.'),
      503: errorResponse('Authentication revocation state or notification authority could not be verified.'),
    },
  },
  'POST /api/v1/devices/notification-authority/code-blue': {
    summary: 'Hydrate an authorized Code Blue notification',
    description:
      'Decrypts the short-lived, audience-bound Code Blue reference only when the authenticated tenant, recipient, ' +
      'access session, device registration epoch, session family, and authorization epoch still ' +
      'match on the primary database. Detailed patient, ward, bed, and reason data is never carried ' +
      'in the FCM envelope.',
    security: [{ ApiKeyAuth: [], BearerAuth: [] }],
    request: 'CodeBlueNotificationContentRequest',
    response: 'CodeBlueNotificationContentResponse',
    responseDescription: 'Detailed Code Blue content or a fail-closed authority denial.',
    additionalResponses: {
      401: errorResponse('The API key or bearer access token was missing, invalid, expired, or revoked.'),
      403: errorResponse('The requested tenant or recipient did not match the authenticated caller.'),
      429: errorResponse('The authenticated caller exceeded the device-route rate limit.'),
      503: errorResponse('Notification authority or Code Blue content could not be verified.'),
    },
  },
  'POST /api/v1/devices/unregister': {
    summary: 'Retire the caller notification-device binding',
    description:
      'Clears the exact FCM token, increments its notification authority epoch, and clears a matching ' +
      'legacy users.device_token without deleting the user_devices row required by linked projections.',
  },
  'DELETE /api/v1/devices/unregister': {
    summary: 'Retire the caller notification-device binding',
    description:
      'Clears the exact FCM token, increments its notification authority epoch, and clears a matching ' +
      'legacy users.device_token without deleting the user_devices row required by linked projections.',
  },
};
