// apps/backend/scripts/openapi/schemas/facilityAssets.mjs
// General (non-biomedical) facility asset register (migration 704):
// tenant-scoped asset master CRUD + status-machine transitions + append-only
// event history under /api/v1/facility/assets. Biomedical devices stay in the
// clinical-ai biomed CMMS surface.
import { envelope } from './_helpers.mjs';

const AUTHENTICATED_SECURITY = [{ ApiKeyAuth: [], BearerAuth: [] }];
const errorResponse = description => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/FacilityAssetErrorResponse' },
    },
  },
});
const authenticatedErrorResponses = {
  400: errorResponse('The facility asset request was invalid.'),
  401: errorResponse('The API key or bearer token was missing or invalid.'),
  403: errorResponse('The caller was not permitted to access the facility asset register.'),
  404: errorResponse('The tenant-scoped facility asset was not found.'),
  409: errorResponse('The request conflicted with the asset version, tag, custodian, or lifecycle state.'),
  429: errorResponse('The caller exceeded the API rate limit.'),
  500: errorResponse('The facility asset operation could not be completed.'),
  503: errorResponse('The facility asset register is not enabled in this deployment (FACILITY_ASSETS_ENABLED kill switch).'),
};
const facilityMutationErrorResponses = {
  ...authenticatedErrorResponses,
  422: errorResponse('The facility asset request failed a domain validation.'),
};

const CATEGORIES = [
  'furniture', 'hvac', 'electrical', 'plumbing', 'it_equipment',
  'generator', 'vehicle', 'kitchen', 'laundry', 'safety',
  'infrastructure', 'other',
];
const CONDITIONS = ['good', 'fair', 'poor'];
const STATUSES = ['active', 'under_repair', 'condemned', 'disposed'];
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const EVENT_TYPES = [
  'created', 'updated', 'moved', 'custodian_assigned', 'condition_changed',
  'status_changed', 'repair_opened', 'repair_closed', 'maintenance',
  'condemned', 'disposed',
];
const queryParameter = (name, schema) => ({
  name,
  in: 'query',
  required: false,
  schema,
});

export const schemas = {
  FacilityAssetErrorResponse: {
    type: 'object',
    additionalProperties: true,
    required: ['success'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      message: { type: 'string' },
      error: { type: 'string' },
      code: { type: 'string' },
    },
  },
  FacilityAsset: {
    type: 'object',
    required: ['id', 'assetTag', 'name', 'category', 'condition', 'status', 'version'],
    properties: {
      id: { type: 'integer' },
      assetTag: { type: 'string', maxLength: 64 },
      name: { type: 'string', maxLength: 200 },
      category: { type: 'string', enum: CATEGORIES },
      description: { type: 'string', maxLength: 4000, nullable: true },
      locationDepartment: { type: 'string', maxLength: 120, nullable: true },
      locationRoom: { type: 'string', maxLength: 120, nullable: true },
      custodianUid: {
        type: 'string', format: 'uuid', nullable: true,
        description: 'Current custodian user UID; new assignments must identify active non-patient staff in the asset tenant.',
      },
      vendor: { type: 'string', maxLength: 160, nullable: true },
      purchaseDate: { type: 'string', format: 'date', nullable: true },
      purchaseCost: { type: 'number', minimum: 0, nullable: true },
      warrantyUntil: { type: 'string', format: 'date', nullable: true },
      condition: { type: 'string', enum: CONDITIONS },
      status: {
        type: 'string',
        enum: STATUSES,
        description: 'State machine: active ⇄ under_repair → condemned → disposed (direct disposal allowed; disposed is terminal and evidence-pinned).',
      },
      version: {
        type: 'integer',
        minimum: 1,
        description: 'Optimistic-concurrency token advanced by master edits and status transitions.',
      },
      disposalReason: { type: 'string', maxLength: 500, nullable: true },
      disposedAt: { type: 'string', format: 'date-time', nullable: true },
      disposedBy: { type: 'string', format: 'uuid', nullable: true },
      createdBy: { type: 'string', format: 'uuid', nullable: true },
      updatedBy: { type: 'string', format: 'uuid', nullable: true },
      createdAt: { type: 'string', format: 'date-time', nullable: true },
      updatedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  FacilityAssetEvent: {
    type: 'object',
    required: ['id', 'assetTag', 'assetName', 'eventType'],
    properties: {
      id: { type: 'integer' },
      assetId: {
        type: 'integer',
        nullable: true,
        description: 'Null after the asset row was hard-deleted; the tag/name snapshots keep the history readable.',
      },
      assetTag: { type: 'string', maxLength: 64 },
      assetName: { type: 'string', maxLength: 200 },
      eventType: { type: 'string', enum: EVENT_TYPES },
      fromStatus: { type: 'string', enum: STATUSES, nullable: true },
      toStatus: { type: 'string', enum: STATUSES, nullable: true },
      details: { type: 'object', additionalProperties: true },
      notes: { type: 'string', maxLength: 1000, nullable: true },
      actorUid: { type: 'string', format: 'uuid', nullable: true },
      actorRole: { type: 'string', maxLength: 60, nullable: true },
      occurredAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },

  FacilityAssetDetail: {
    allOf: [
      { $ref: '#/components/schemas/FacilityAsset' },
      {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            items: { $ref: '#/components/schemas/FacilityAssetEvent' },
            description: 'Most recent history events (newest first).',
          },
        },
      },
    ],
  },

  FacilityAssetListPayload: {
    type: 'object',
    required: ['assets', 'total', 'limit', 'offset'],
    properties: {
      assets: { type: 'array', items: { $ref: '#/components/schemas/FacilityAsset' } },
      total: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
      offset: { type: 'integer', minimum: 0, maximum: POSTGRES_INTEGER_MAX },
    },
  },

  FacilityAssetEventListPayload: {
    type: 'object',
    required: ['events', 'total', 'limit', 'offset'],
    properties: {
      events: { type: 'array', items: { $ref: '#/components/schemas/FacilityAssetEvent' } },
      total: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: { type: 'integer', minimum: 0, maximum: POSTGRES_INTEGER_MAX },
    },
  },

  FacilityAssetCustodian: {
    type: 'object',
    required: ['uid', 'name', 'role'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      role: { type: 'string' },
    },
  },

  FacilityAssetCustodianListPayload: {
    type: 'object',
    required: ['custodians', 'limit'],
    properties: {
      custodians: {
        type: 'array',
        items: { $ref: '#/components/schemas/FacilityAssetCustodian' },
      },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  },

  FacilityAssetCreateRequest: {
    type: 'object',
    required: ['assetTag', 'name', 'category'],
    properties: {
      assetTag: { type: 'string', maxLength: 64 },
      name: { type: 'string', maxLength: 200 },
      category: { type: 'string', enum: CATEGORIES },
      description: { type: 'string', maxLength: 4000, nullable: true },
      locationDepartment: { type: 'string', maxLength: 120, nullable: true },
      locationRoom: { type: 'string', maxLength: 120, nullable: true },
      custodianUid: {
        type: 'string', format: 'uuid', nullable: true,
        description: 'Must identify active non-patient staff in the asset tenant.',
      },
      vendor: { type: 'string', maxLength: 160, nullable: true },
      purchaseDate: { type: 'string', format: 'date', nullable: true },
      purchaseCost: { type: 'number', minimum: 0, nullable: true },
      warrantyUntil: { type: 'string', format: 'date', nullable: true },
      condition: { type: 'string', enum: CONDITIONS },
      notes: { type: 'string', maxLength: 1000, nullable: true },
    },
  },

  FacilityAssetUpdateRequest: {
    type: 'object',
    required: ['expectedVersion'],
    description: 'Master-field update; omitted fields keep their current values. expectedVersion must match the latest asset version or the server returns 409. Status is deliberately excluded — use the status transition endpoint.',
    properties: {
      expectedVersion: { type: 'integer', minimum: 1, maximum: POSTGRES_INTEGER_MAX },
      assetTag: { type: 'string', maxLength: 64 },
      name: { type: 'string', maxLength: 200 },
      category: { type: 'string', enum: CATEGORIES },
      description: { type: 'string', maxLength: 4000, nullable: true },
      locationDepartment: { type: 'string', maxLength: 120, nullable: true },
      locationRoom: { type: 'string', maxLength: 120, nullable: true },
      custodianUid: {
        type: 'string', format: 'uuid', nullable: true,
        description: 'Must identify active non-patient staff in the asset tenant. Null clears the assignment.',
      },
      vendor: { type: 'string', maxLength: 160, nullable: true },
      purchaseDate: { type: 'string', format: 'date', nullable: true },
      purchaseCost: { type: 'number', minimum: 0, nullable: true },
      warrantyUntil: { type: 'string', format: 'date', nullable: true },
      condition: { type: 'string', enum: CONDITIONS },
      notes: { type: 'string', maxLength: 1000, nullable: true },
    },
  },

  FacilityAssetTransitionRequest: {
    type: 'object',
    required: ['expectedVersion', 'toStatus'],
    description: 'expectedVersion must match the latest asset version. Stale lifecycle transitions return 409 without changing the asset or appending an event.',
    properties: {
      expectedVersion: { type: 'integer', minimum: 1, maximum: POSTGRES_INTEGER_MAX },
      toStatus: { type: 'string', enum: STATUSES },
      reason: {
        type: 'string',
        maxLength: 500,
        nullable: true,
        description: 'Required when toStatus is disposed — becomes the durable disposal evidence.',
      },
      notes: { type: 'string', maxLength: 1000, nullable: true },
    },
  },

  FacilityAssetMaintenanceRequest: {
    type: 'object',
    required: ['notes'],
    properties: {
      notes: { type: 'string', maxLength: 1000 },
      cost: { type: 'number', minimum: 0, nullable: true },
      vendor: { type: 'string', maxLength: 160, nullable: true },
    },
  },

  FacilityAssetMaintenancePayload: {
    type: 'object',
    required: ['asset'],
    properties: {
      asset: { $ref: '#/components/schemas/FacilityAsset' },
      event: { $ref: '#/components/schemas/FacilityAssetEvent' },
    },
  },

  FacilityAssetListResponse: envelope('FacilityAssetListPayload'),
  FacilityAssetResponse: envelope('FacilityAsset'),
  FacilityAssetDetailResponse: envelope('FacilityAssetDetail'),
  FacilityAssetEventListResponse: envelope('FacilityAssetEventListPayload'),
  FacilityAssetCustodianListResponse: envelope('FacilityAssetCustodianListPayload'),
  FacilityAssetMaintenanceResponse: envelope('FacilityAssetMaintenancePayload'),
};

export const operations = {
  'GET /api/v1/facility/assets': {
    description:
      'Lists the tenant\'s general (non-biomedical) facility asset register with status/category/custodian/search filters and offset pagination. Facility operations staff read access; biomedical devices live in the biomed CMMS, not here.',
    parameters: [
      queryParameter('status', { type: 'string', enum: STATUSES }),
      queryParameter('category', { type: 'string', enum: CATEGORIES }),
      queryParameter('custodian_uid', { type: 'string', format: 'uuid' }),
      queryParameter('q', { type: 'string', maxLength: 200 }),
      queryParameter('limit', { type: 'integer', minimum: 1, maximum: 500 }),
      queryParameter('offset', {
        type: 'integer', minimum: 0, maximum: POSTGRES_INTEGER_MAX,
      }),
    ],
    response: 'FacilityAssetListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/facility/assets/custodians': {
    description:
      'Lists active non-patient staff in the request tenant for facility asset assignment. Results are bounded to 500 and may be narrowed by name.',
    parameters: [
      queryParameter('q', { type: 'string', maxLength: 200 }),
      queryParameter('limit', { type: 'integer', minimum: 1, maximum: 500 }),
    ],
    response: 'FacilityAssetCustodianListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'POST /api/v1/facility/assets': {
    description:
      'Registers a general facility asset (furniture, HVAC, electrical/plumbing plant, IT, generators, vehicles, kitchen/laundry, safety, infrastructure). Asset tag is unique per tenant. Writes the asset row plus a created history event in the same transaction. ADMIN/SUPER_ADMIN/MAINTENANCE/BIOMEDICAL_STAFF.',
    request: 'FacilityAssetCreateRequest',
    response: 'FacilityAssetResponse',
    responseStatus: 201,
    security: AUTHENTICATED_SECURITY,
    additionalResponses: facilityMutationErrorResponses,
  },
  'GET /api/v1/facility/assets/{id}': {
    description: 'Fetches one facility asset with its most recent history events.',
    response: 'FacilityAssetDetailResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'PATCH /api/v1/facility/assets/{id}': {
    description:
      'Updates master fields when expectedVersion matches; stale writes return 409 without mutation. Explicit null clears nullable fields. Location moves, custodian reassignments and condition changes each append a typed history event in the same transaction. New custodians must be active non-patient staff in the asset tenant. Disposed assets are immutable. Status changes are rejected here — use the status transition endpoint.',
    request: 'FacilityAssetUpdateRequest',
    response: 'FacilityAssetResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: facilityMutationErrorResponses,
  },
  'POST /api/v1/facility/assets/{id}/status': {
    description:
      'Transitions the asset status through the guarded state machine (active ⇄ under_repair → condemned → disposed; direct disposal allowed). Disposal requires a reason and stamps the disposal evidence columns; disposed is terminal. The transition event is written in the same transaction.',
    request: 'FacilityAssetTransitionRequest',
    response: 'FacilityAssetResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: facilityMutationErrorResponses,
  },
  'POST /api/v1/facility/assets/{id}/maintenance': {
    description:
      'Records a maintenance action (cost/vendor/notes) against a non-disposed asset as an append-only history event without changing status.',
    request: 'FacilityAssetMaintenanceRequest',
    response: 'FacilityAssetMaintenanceResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
  'GET /api/v1/facility/assets/{id}/events': {
    description: 'Pages through the asset\'s full append-only history (newest first).',
    parameters: [
      queryParameter('limit', { type: 'integer', minimum: 1, maximum: 200 }),
      queryParameter('offset', {
        type: 'integer', minimum: 0, maximum: POSTGRES_INTEGER_MAX,
      }),
    ],
    response: 'FacilityAssetEventListResponse',
    security: AUTHENTICATED_SECURITY,
    additionalResponses: authenticatedErrorResponses,
  },
};
