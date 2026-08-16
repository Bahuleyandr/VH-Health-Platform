// apps/backend/scripts/openapi/schemas/facilityAssets.mjs
// General (non-biomedical) facility asset register (migration 704):
// tenant-scoped asset master CRUD + status-machine transitions + append-only
// event history under /api/v1/facility/assets. Biomedical devices stay in the
// clinical-ai biomed CMMS surface.
import { envelope } from './_helpers.mjs';

const CATEGORIES = [
  'furniture', 'hvac', 'electrical', 'plumbing', 'it_equipment',
  'generator', 'vehicle', 'kitchen', 'laundry', 'safety',
  'infrastructure', 'other',
];
const CONDITIONS = ['good', 'fair', 'poor'];
const STATUSES = ['active', 'under_repair', 'condemned', 'disposed'];
const EVENT_TYPES = [
  'created', 'updated', 'moved', 'custodian_assigned', 'condition_changed',
  'status_changed', 'repair_opened', 'repair_closed', 'maintenance',
  'condemned', 'disposed',
];

export const schemas = {
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
        description: 'Current custodian user UID; when set, the user must belong to the asset tenant.',
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
      total: { type: 'integer' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
  },

  FacilityAssetEventListPayload: {
    type: 'object',
    required: ['events', 'limit', 'offset'],
    properties: {
      events: { type: 'array', items: { $ref: '#/components/schemas/FacilityAssetEvent' } },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
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
        description: 'Must identify a user in the asset tenant.',
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
      expectedVersion: { type: 'integer', minimum: 1 },
      assetTag: { type: 'string', maxLength: 64 },
      name: { type: 'string', maxLength: 200 },
      category: { type: 'string', enum: CATEGORIES },
      description: { type: 'string', maxLength: 4000, nullable: true },
      locationDepartment: { type: 'string', maxLength: 120, nullable: true },
      locationRoom: { type: 'string', maxLength: 120, nullable: true },
      custodianUid: {
        type: 'string', format: 'uuid', nullable: true,
        description: 'Must identify a user in the asset tenant.',
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
    required: ['toStatus'],
    properties: {
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
  FacilityAssetMaintenanceResponse: envelope('FacilityAssetMaintenancePayload'),
};

export const operations = {
  'GET /api/v1/facility/assets': {
    description:
      'Lists the tenant\'s general (non-biomedical) facility asset register with status/category/custodian/search filters and offset pagination. Facility operations staff read access; biomedical devices live in the biomed CMMS, not here.',
    response: 'FacilityAssetListResponse',
  },
  'POST /api/v1/facility/assets': {
    description:
      'Registers a general facility asset (furniture, HVAC, electrical/plumbing plant, IT, generators, vehicles, kitchen/laundry, safety, infrastructure). Asset tag is unique per tenant. Writes the asset row plus a created history event in the same transaction. ADMIN/SUPER_ADMIN/MAINTENANCE/BIOMEDICAL_STAFF.',
    request: 'FacilityAssetCreateRequest',
    response: 'FacilityAssetResponse',
  },
  'GET /api/v1/facility/assets/{id}': {
    description: 'Fetches one facility asset with its most recent history events.',
    response: 'FacilityAssetDetailResponse',
  },
  'PATCH /api/v1/facility/assets/{id}': {
    description:
      'Updates master fields when expectedVersion matches; stale writes return 409 without mutation. Location moves, custodian reassignments and condition changes each append a typed history event in the same transaction. Custodians must be users in the asset tenant. Disposed assets are immutable. Status changes are rejected here — use the status transition endpoint.',
    request: 'FacilityAssetUpdateRequest',
    response: 'FacilityAssetResponse',
  },
  'POST /api/v1/facility/assets/{id}/status': {
    description:
      'Transitions the asset status through the guarded state machine (active ⇄ under_repair → condemned → disposed; direct disposal allowed). Disposal requires a reason and stamps the disposal evidence columns; disposed is terminal. The transition event is written in the same transaction.',
    request: 'FacilityAssetTransitionRequest',
    response: 'FacilityAssetResponse',
  },
  'POST /api/v1/facility/assets/{id}/maintenance': {
    description:
      'Records a maintenance action (cost/vendor/notes) against a non-disposed asset as an append-only history event without changing status.',
    request: 'FacilityAssetMaintenanceRequest',
    response: 'FacilityAssetMaintenanceResponse',
  },
  'GET /api/v1/facility/assets/{id}/events': {
    description: 'Pages through the asset\'s full append-only history (newest first).',
    response: 'FacilityAssetEventListResponse',
  },
};
