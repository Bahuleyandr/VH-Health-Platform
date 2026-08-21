// apps/backend/scripts/openapi/schemas/ambulanceTracking.mjs
// Ambulance live GPS position tracking (migration 683), served from
// /api/v1/ambulance/*. Config-gated per tenant via
// tenants.settings.ambulanceGpsTracking — ships disabled; ingest 403s with
// AMBULANCE_GPS_TRACKING_DISABLED, reads return { enabled: false }.
import { envelope } from './_helpers.mjs';

export const schemas = {
  AmbulancePositionEvent: {
    type: 'object',
    required: ['id', 'ambulance_request_id', 'latitude', 'longitude', 'recorded_at', 'source'],
    properties: {
      id: { type: 'string', description: 'BIGSERIAL id serialized as text.' },
      tenant_id: { type: 'string', format: 'uuid' },
      ambulance_request_id: { type: 'integer' },
      ambulance_unit_id: { type: 'string', nullable: true },
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      speed_kmh: { type: 'number', nullable: true },
      heading_deg: { type: 'number', nullable: true },
      accuracy_m: { type: 'number', nullable: true },
      recorded_at: {
        type: 'string',
        format: 'date-time',
        description: 'Device clock instant of the fix (bounded-skew-validated at ingest).',
      },
      received_at: { type: 'string', format: 'date-time' },
      source: { type: 'string', enum: ['driver_app', 'partner_webhook'] },
      reported_by_uid: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  AmbulancePositionIngestRequest: {
    type: 'object',
    required: ['latitude', 'longitude'],
    properties: {
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      speed_kmh: { type: 'number', minimum: 0, maximum: 400, nullable: true },
      heading_deg: { type: 'number', minimum: 0, maximum: 359.99, nullable: true },
      accuracy_m: { type: 'number', minimum: 0, nullable: true },
      recorded_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'Device clock instant of the fix; defaults to server time. Rejected beyond 2 minutes of future skew or older than 6 hours.',
      },
    },
  },

  AmbulancePositionIngestResult: {
    type: 'object',
    required: ['position', 'is_latest'],
    properties: {
      position: { $ref: '#/components/schemas/AmbulancePositionEvent' },
      is_latest: {
        type: 'boolean',
        description: 'false when the fix was out-of-order (older than the stored latest) — stored for the trail but the live view did not move.',
      },
    },
  },

  AmbulanceTrackingView: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: {
        type: 'boolean',
        description: 'false when the tenant has not enabled ambulance GPS tracking; tracking is then null.',
      },
      tracking: {
        type: 'object',
        nullable: true,
        properties: {
          ambulance_request_id: { type: 'integer' },
          request_number: { type: 'string' },
          status: { type: 'string' },
          is_trackable: { type: 'boolean' },
          ambulance_unit_id: { type: 'string', nullable: true },
          destination: { type: 'string', nullable: true },
          pickup_geo_lat: { type: 'number', nullable: true },
          pickup_geo_lng: { type: 'number', nullable: true },
          dispatched_at: { type: 'string', format: 'date-time', nullable: true },
          latest: {
            allOf: [{ $ref: '#/components/schemas/AmbulancePositionEvent' }],
            nullable: true,
          },
          trail: {
            type: 'array',
            items: { $ref: '#/components/schemas/AmbulancePositionEvent' },
          },
          eta: {
            type: 'object',
            nullable: true,
            description: 'Pre-hospital handover ETA passthrough for this request, when a handover exists.',
            properties: {
              eta_first_at: { type: 'string', format: 'date-time', nullable: true },
              eta_latest_at: { type: 'string', format: 'date-time', nullable: true },
              eta_change_reason: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
  },

  AmbulanceActiveTrackingList: {
    type: 'object',
    required: ['enabled', 'requests', 'count'],
    properties: {
      enabled: { type: 'boolean' },
      count: { type: 'integer' },
      requests: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ambulance_request_id: { type: 'integer' },
            request_number: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'string' },
            request_kind: { type: 'string' },
            ambulance_unit_id: { type: 'string', nullable: true },
            driver_name: { type: 'string', nullable: true },
            destination: { type: 'string', nullable: true },
            dispatched_at: { type: 'string', format: 'date-time', nullable: true },
            latest_position_id: { type: 'string', nullable: true },
            latitude: { type: 'number', nullable: true },
            longitude: { type: 'number', nullable: true },
            speed_kmh: { type: 'number', nullable: true },
            heading_deg: { type: 'number', nullable: true },
            accuracy_m: { type: 'number', nullable: true },
            position_recorded_at: { type: 'string', format: 'date-time', nullable: true },
            position_received_at: { type: 'string', format: 'date-time', nullable: true },
            eta_latest_at: { type: 'string', format: 'date-time', nullable: true },
          },
        },
      },
    },
  },

  AmbulancePositionIngestResponse: envelope('AmbulancePositionIngestResult'),
  AmbulanceTrackingResponse: envelope('AmbulanceTrackingView'),
  AmbulanceActiveTrackingResponse: envelope('AmbulanceActiveTrackingList'),
};

export const operations = {
  'POST /api/v1/ambulance/requests/{id}/positions': {
    description:
      'Ingests one GPS fix from the assigned ambulance crew/driver (staff app) for an actively-transporting ambulance request (dispatched/en_route/on_scene/returning). Config-gated: 403 AMBULANCE_GPS_TRACKING_DISABLED until the tenant enables ambulanceGpsTracking. The reporter is the authenticated actor; fixes are floor-rate-limited per reporter, clock-skew validated, and out-of-order fixes are stored without moving the live latest position.',
    request: 'AmbulancePositionIngestRequest',
    response: 'AmbulancePositionIngestResponse',
  },
  'GET /api/v1/ambulance/requests/{id}/tracking': {
    description:
      'ED live view for one ambulance request: derived latest position, recent trail (trail_limit, default 50), and the pre-hospital handover ETA passthrough. When the tenant has not enabled GPS tracking the response is an explicit { enabled: false, tracking: null } marker.',
    response: 'AmbulanceTrackingResponse',
  },
  'GET /api/v1/ambulance/tracking/active': {
    description:
      'ED board list: every actively-transporting ambulance request with its latest GPS fix and latest handover ETA. Explicit { enabled: false } marker when the tenant has not enabled GPS tracking.',
    response: 'AmbulanceActiveTrackingResponse',
  },
};
