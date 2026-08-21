/**
 * Ambulance live GPS position tracking (migration 683). Config-gated per
 * tenant via tenants.settings.ambulanceGpsTracking — the hospital has no GPS
 * devices yet, so the feature ships disabled; enabling it is a tenant
 * settings write, never a deploy.
 *
 * Ingest path (the only wired writer): the staff/driver app POSTs fixes for
 * an actively-transporting ambulance_requests row. A future partner fleet
 * webhook is schema-ready (`source = 'partner_webhook'`) but deliberately
 * unwired — ambulance_partner_fleet_configs carries consent/review evidence,
 * not inbound auth material, so there is no partner callback idiom to extend
 * yet (documented follow-up).
 *
 * "Latest position" is DERIVED (recorded_at DESC, id DESC over the migration
 * 683 composite index), never flagged — an out-of-order older fix is stored
 * for the trail but can never regress the live view.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getAmbulanceGpsTrackingSettings } from '../tenant/tenantSettingsService.js';
import { emitAmbulancePosition } from '../../utils/websocket/realtimeEmitter.js';

const DEFAULT_TRAIL_LIMIT = 50;
const MAX_TRAIL_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// A fix only makes sense while the unit is actually moving through the
// dispatch lifecycle. requested = nobody assigned yet; arrived/completed/
// cancelled/failed = journey over.
export const TRACKABLE_STATUSES = ['dispatched', 'en_route', 'on_scene', 'returning'];

// Device-clock sanity bounds for recorded_at at ingest.
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000; // 2 min ahead of server clock
const MAX_FIX_AGE_MS = 6 * 60 * 60 * 1000; // 6 h behind server clock

// id is BIGSERIAL — serialize as text so the JSON envelope never meets a
// BigInt (JSON.stringify throws on BigInt; the platform has no global cast).
const POSITION_RETURNING = `id::text AS id, tenant_id, ambulance_request_id,
  ambulance_unit_id, latitude, longitude, speed_kmh, heading_deg, accuracy_m,
  recorded_at, received_at, source, reported_by_uid, created_at`;

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function requireNumber(value, label, { min, max }) {
  const parsed = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(parsed)) {
    throw AppError.badRequest(`${label} must be numeric`);
  }
  if (parsed < min || parsed > max) {
    throw AppError.badRequest(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function maybeNumber(value, label, { min, max }) {
  if (value === null || value === undefined || value === '') return null;
  return requireNumber(value, label, { min, max });
}

function normalizeLimit(value, fallback, max) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeRecordedAt(value) {
  const date = value === null || value === undefined || value === ''
    ? new Date()
    : (value instanceof Date ? value : new Date(String(value)));
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest('recorded_at must be a valid timestamp');
  }
  const now = Date.now();
  if (date.getTime() > now + MAX_FUTURE_SKEW_MS) {
    throw AppError.badRequest(
      'recorded_at is in the future beyond the allowed clock skew',
      'AMBULANCE_POSITION_CLOCK_SKEW',
    );
  }
  if (date.getTime() < now - MAX_FIX_AGE_MS) {
    throw AppError.badRequest(
      'recorded_at is too old to be a live position fix',
      'AMBULANCE_POSITION_STALE_FIX',
    );
  }
  return date.toISOString();
}

async function requireTrackingEnabled(tenantId) {
  const settings = await getAmbulanceGpsTrackingSettings(tenantId);
  if (!settings.enabled) {
    // Platform convention for tenant-disabled features (TRANSPORT_DISABLED,
    // KIOSK_SELF_SERVICE_DISABLED, ...): 403 forbidden with a *_DISABLED code.
    throw AppError.forbidden(
      'Ambulance GPS tracking is not enabled for this tenant',
      'AMBULANCE_GPS_TRACKING_DISABLED',
    );
  }
  return settings;
}

async function fetchAmbulanceRequest(tenantId, ambulanceRequestId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, request_number, status, priority, request_kind,
            ambulance_unit_id, driver_name, destination, destination_facility_id,
            pickup_geo_lat, pickup_geo_lng, dispatched_at, on_scene_at, arrived_at
       FROM ambulance_requests
      WHERE id = $1 AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(ambulanceRequestId, 'ambulance_request_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Ambulance request not found');
  return rows[0];
}

async function fetchLatestPosition(tenantId, ambulanceRequestId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${POSITION_RETURNING}
       FROM ambulance_position_events
      WHERE tenant_id = $1::uuid AND ambulance_request_id = $2
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    ambulanceRequestId,
  );
  return rows[0] || null;
}

/**
 * Ingest one GPS fix from the assigned crew/driver (staff app).
 * The route mount supplies role RBAC; this layer enforces the tenant gate,
 * coordinate/clock validation, lifecycle state, and a per-reporter minimum
 * fix interval (sane server-side rate limit for a ~10-20s client cadence).
 */
export async function recordAmbulancePosition({
  tenantId = null,
  ambulanceRequestId,
  latitude,
  longitude,
  speedKmh = null,
  headingDeg = null,
  accuracyM = null,
  recordedAt = null,
  reportedByUid = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const settings = await requireTrackingEnabled(tid);

  const lat = requireNumber(latitude, 'latitude', { min: -90, max: 90 });
  const lng = requireNumber(longitude, 'longitude', { min: -180, max: 180 });
  const speed = maybeNumber(speedKmh, 'speed_kmh', { min: 0, max: 400 });
  const heading = maybeNumber(headingDeg, 'heading_deg', { min: 0, max: 359.99 });
  const accuracy = maybeNumber(accuracyM, 'accuracy_m', { min: 0, max: 100000 });
  const cleanRecordedAt = normalizeRecordedAt(recordedAt);
  const reporter = maybeUuid(reportedByUid, 'reported_by_uid');
  if (!reporter) throw AppError.unauthorized('Authenticated reporter is required');

  const request = await fetchAmbulanceRequest(tid, ambulanceRequestId);
  if (!TRACKABLE_STATUSES.includes(request.status)) {
    throw AppError.conflict(
      `Ambulance request is not actively transporting (status: ${request.status})`,
      'AMBULANCE_TRACKING_REQUEST_NOT_ACTIVE',
    );
  }

  // Per-reporter minimum interval, measured on server ingest time so a
  // client cannot dodge it with back-dated recorded_at values.
  const minInterval = settings.minSecondsBetweenFixes;
  const recent = await prisma.$queryRawUnsafe(
    `SELECT id::text AS id
       FROM ambulance_position_events
      WHERE tenant_id = $1::uuid
        AND ambulance_request_id = $2
        AND reported_by_uid = $3::uuid
        AND received_at > NOW() - make_interval(secs => $4::int)
      LIMIT 1`,
    tid,
    request.id,
    reporter,
    minInterval,
  );
  if (recent[0]) {
    throw AppError.tooMany(
      `Position fixes are limited to one per ${minInterval}s per reporter`,
      'AMBULANCE_POSITION_RATE_LIMITED',
    );
  }

  const previousLatest = await fetchLatestPosition(tid, request.id);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ambulance_position_events
       (tenant_id, ambulance_request_id, ambulance_unit_id,
        latitude, longitude, speed_kmh, heading_deg, accuracy_m,
        recorded_at, source, reported_by_uid)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, 'driver_app', $10::uuid)
     RETURNING ${POSITION_RETURNING}`,
    tid,
    request.id,
    request.ambulance_unit_id || null,
    lat,
    lng,
    speed,
    heading,
    accuracy,
    cleanRecordedAt,
    reporter,
  );
  const position = rows[0];

  // An out-of-order (older-than-latest) fix is stored for the trail but is
  // NOT the new live position and must not be broadcast as one.
  const isLatest = !previousLatest
    || new Date(position.recorded_at).getTime() > new Date(previousLatest.recorded_at).getTime()
    || (new Date(position.recorded_at).getTime() === new Date(previousLatest.recorded_at).getTime()
      && BigInt(position.id) > BigInt(previousLatest.id));

  if (isLatest) {
    emitAmbulancePosition({
      tenantId: tid,
      ambulanceRequestId: request.id,
      requestNumber: request.request_number,
      status: request.status,
      position,
    });
  } else {
    logger.info('Out-of-order ambulance position stored (latest unchanged)', {
      ambulanceRequestId: request.id,
      positionId: position.id,
    });
  }

  return { position, is_latest: isLatest };
}

/**
 * ED live view for one ambulance request: latest fix + recent trail + the
 * pre-hospital ETA passthrough (latest prehospital_handovers ETA instants for
 * this request, when one exists).
 *
 * Disabled tenants get an EXPLICIT marker (`{ enabled: false, tracking: null }`)
 * rather than an error so the UI can render the "not enabled" state.
 */
export async function getAmbulanceTracking({
  tenantId = null,
  ambulanceRequestId,
  trailLimit = DEFAULT_TRAIL_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const settings = await getAmbulanceGpsTrackingSettings(tid);
  const request = await fetchAmbulanceRequest(tid, ambulanceRequestId);
  if (!settings.enabled) {
    return { enabled: false, tracking: null };
  }

  const limit = normalizeLimit(trailLimit, DEFAULT_TRAIL_LIMIT, MAX_TRAIL_LIMIT);
  const [trail, etaRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT ${POSITION_RETURNING}
         FROM ambulance_position_events
        WHERE tenant_id = $1::uuid AND ambulance_request_id = $2
        ORDER BY recorded_at DESC, id DESC
        LIMIT $3`,
      tid,
      request.id,
      limit,
    ),
    prisma.$queryRawUnsafe(
      `SELECT eta_first_at, eta_latest_at, eta_change_reason
         FROM prehospital_handovers
        WHERE tenant_id = $1::uuid AND ambulance_request_id = $2
        ORDER BY updated_at DESC
        LIMIT 1`,
      tid,
      request.id,
    ),
  ]);

  return {
    enabled: true,
    tracking: {
      ambulance_request_id: request.id,
      request_number: request.request_number,
      status: request.status,
      is_trackable: TRACKABLE_STATUSES.includes(request.status),
      ambulance_unit_id: request.ambulance_unit_id,
      destination: request.destination,
      pickup_geo_lat: request.pickup_geo_lat,
      pickup_geo_lng: request.pickup_geo_lng,
      dispatched_at: request.dispatched_at,
      latest: trail[0] || null,
      trail,
      eta: etaRows[0] || null,
    },
  };
}

/**
 * ED board list: every actively-transporting ambulance request with its
 * latest fix (lateral over the 683 composite index). Same explicit disabled
 * marker as the per-request read.
 */
export async function listActiveAmbulanceTracking({
  tenantId = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const settings = await getAmbulanceGpsTrackingSettings(tid);
  if (!settings.enabled) {
    return { enabled: false, requests: [], count: 0 };
  }
  const safeLimit = normalizeLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ar.id AS ambulance_request_id, ar.request_number, ar.status,
            ar.priority, ar.request_kind, ar.ambulance_unit_id, ar.driver_name,
            ar.destination, ar.dispatched_at,
            pos.id AS latest_position_id, pos.latitude, pos.longitude,
            pos.speed_kmh, pos.heading_deg, pos.accuracy_m,
            pos.recorded_at AS position_recorded_at,
            pos.received_at AS position_received_at,
            ph.eta_latest_at
       FROM ambulance_requests ar
  LEFT JOIN LATERAL (
         SELECT id::text AS id, latitude, longitude, speed_kmh, heading_deg,
                accuracy_m, recorded_at, received_at
           FROM ambulance_position_events
          WHERE tenant_id = ar.tenant_id AND ambulance_request_id = ar.id
          ORDER BY recorded_at DESC, id DESC
          LIMIT 1
       ) pos ON TRUE
  LEFT JOIN LATERAL (
         SELECT eta_latest_at
           FROM prehospital_handovers
          WHERE tenant_id = ar.tenant_id AND ambulance_request_id = ar.id
          ORDER BY updated_at DESC
          LIMIT 1
       ) ph ON TRUE
      WHERE ar.tenant_id = $1::uuid
        AND ar.status IN ('dispatched', 'en_route', 'on_scene', 'returning')
      ORDER BY ar.dispatched_at DESC NULLS LAST, ar.id DESC
      LIMIT $2`,
    tid,
    safeLimit,
  );
  return { enabled: true, requests: rows, count: rows.length };
}

/**
 * Retention sweep (scheduler: 'ambulance-position-retention', per tenant).
 * Position fixes are operational telemetry, not chart content — delete rows
 * older than the tenant's retention window (default 7 days). Batched so a
 * backlog never holds a long transaction.
 */
export async function sweepAmbulancePositionEvents({
  tenantId = null,
  batchSize = 5000,
  maxBatches = 20,
} = {}) {
  const tid = requireTenantId(tenantId);
  const settings = await getAmbulanceGpsTrackingSettings(tid);
  const retentionDays = settings.retentionDays;
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const count = await prisma.$executeRawUnsafe(
      `DELETE FROM ambulance_position_events
        WHERE id IN (
          SELECT id FROM ambulance_position_events
           WHERE tenant_id = $1::uuid
             AND received_at < NOW() - make_interval(days => $2::int)
           LIMIT $3
        )`,
      tid,
      retentionDays,
      Math.max(1, Number.parseInt(batchSize, 10) || 5000),
    );
    deleted += Number(count) || 0;
    if (!count || Number(count) < batchSize) break;
  }
  if (deleted > 0) {
    logger.info('ambulance-position-retention sweep deleted rows', {
      tenantId: tid,
      deleted,
      retentionDays,
    });
  }
  return { deleted, retention_days: retentionDays };
}

export const __testing__ = {
  TRACKABLE_STATUSES,
  MAX_FUTURE_SKEW_MS,
  MAX_FIX_AGE_MS,
  normalizeRecordedAt,
};

export default {
  recordAmbulancePosition,
  getAmbulanceTracking,
  listActiveAmbulanceTracking,
  sweepAmbulancePositionEvents,
};
