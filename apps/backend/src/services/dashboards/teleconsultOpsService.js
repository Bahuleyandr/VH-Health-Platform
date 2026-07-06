// src/services/dashboards/teleconsultOpsService.js
//
// Non-PHI operational telemetry for NL-3 teleconsult operations. This service
// exposes counters and distributions only; it never returns patient, doctor,
// URL, token, complaint, or form fields from the telemedicine tables.

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getTeleconsultFeatureState } from '../telemedicine/teleconsultProvisioningService.js';

export const TELECONSULT_OPS_TELEMETRY_FIELDS = Object.freeze([
  'generated_at',
  'window_hours',
  'livekit_enabled',
  'recording_enabled',
  'media_boundary',
  'queue_model',
  'teleconsult_count',
  'active_count',
  'waiting_count',
  'scheduled_count',
  'terminal_count',
  'video_session_count',
  'join_failure_count',
  'turn_session_count',
  'turn_usage_rate_pct',
  'consent_recorded_count',
  'consent_recorded_rate_pct',
  'final_modality_distribution',
  'status_counts',
  'video_session_counts',
  'provider_counts',
]);

const ALLOWED_FIELDS = new Set(TELECONSULT_OPS_TELEMETRY_FIELDS);
const FORBIDDEN_KEY_PATTERNS = [
  /patient/i,
  /doctor/i,
  /phone/i,
  /name/i,
  /uid/i,
  /url/i,
  /token/i,
  /complaint/i,
  /form/i,
  /recording_url/i,
];

const STATUS_KEYS = [
  'scheduled',
  'waiting',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'failed',
];
const VIDEO_STATUS_KEYS = ['created', 'active', 'ended', 'cancelled', 'failed'];
const MODALITY_KEYS = ['video', 'audio', 'chat', 'hybrid', 'unknown'];

function clampWindowHours(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(1, Math.min(168, parsed));
}

function asNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asPct(value) {
  return Math.round(asNumber(value) * 10) / 10;
}

function normalizeDistribution(value, expectedKeys = []) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const key of expectedKeys) out[key] = 0;
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = String(rawKey || 'unknown').toLowerCase();
    out[key] = asNumber(rawValue);
  }
  return out;
}

function assertKeySafe(key, path) {
  for (const pattern of FORBIDDEN_KEY_PATTERNS) {
    if (pattern.test(key)) {
      throw new Error(`Teleconsult ops telemetry contains forbidden field ${path.join('.')}`);
    }
  }
}

function assertNestedKeysSafe(value, path = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNestedKeysSafe(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertKeySafe(key, [...path, key]);
    assertNestedKeysSafe(child, [...path, key]);
  }
}

export function assertTeleconsultOpsTelemetryAllowlist(payload) {
  const keys = Object.keys(payload || {});
  const extra = keys.filter((key) => !ALLOWED_FIELDS.has(key));
  if (extra.length) {
    throw new Error(`Teleconsult ops telemetry has unexpected field(s): ${extra.join(', ')}`);
  }
  assertNestedKeysSafe(payload);
  return payload;
}

function buildSnapshotSql({ tenantScoped }) {
  const hoursParam = tenantScoped ? '$2' : '$1';
  const teleTenantWhere = tenantScoped ? 'tc.tenant_id = $1::uuid' : 'TRUE';
  const sessionTenantWhere = tenantScoped
    ? 'vs.tenant_id = $1::uuid AND tc.tenant_id = $1::uuid'
    : 'TRUE';

  return `
    WITH filtered_tele AS (
      SELECT
        tc.id,
        LOWER(COALESCE(tc.status, '')) AS status,
        LOWER(COALESCE(tc.consult_type, 'unknown')) AS consult_type,
        tc.remote_consent_id,
        tc.remote_consent_signed_at
      FROM teleconsultations tc
      WHERE ${teleTenantWhere}
        AND COALESCE(tc.scheduled_start, tc.updated_at, tc.created_at)
          >= NOW() - (${hoursParam}::int * INTERVAL '1 hour')
    ),
    filtered_sessions AS (
      SELECT
        LOWER(COALESCE(vs.status, '')) AS status,
        LOWER(COALESCE(vs.provider, 'unknown')) AS provider,
        COALESCE(vs.metadata, '{}'::jsonb) AS metadata
      FROM video_sessions vs
      JOIN teleconsultations tc
        ON tc.id = vs.teleconsultation_id
       AND tc.tenant_id = vs.tenant_id
      WHERE ${sessionTenantWhere}
        AND COALESCE(vs.updated_at, vs.started_at, vs.created_at)
          >= NOW() - (${hoursParam}::int * INTERVAL '1 hour')
    )
    SELECT
      (SELECT COUNT(*)::int FROM filtered_tele) AS teleconsult_count,
      (SELECT COUNT(*)::int FROM filtered_tele WHERE status = 'in_progress') AS active_count,
      (SELECT COUNT(*)::int FROM filtered_tele WHERE status = 'waiting') AS waiting_count,
      (SELECT COUNT(*)::int FROM filtered_tele WHERE status = 'scheduled') AS scheduled_count,
      (SELECT COUNT(*)::int FROM filtered_tele WHERE status IN ('completed', 'cancelled', 'no_show', 'failed')) AS terminal_count,
      (SELECT COUNT(*)::int FROM filtered_sessions) AS video_session_count,
      (
        (SELECT COUNT(*)::int FROM filtered_tele WHERE status = 'failed')
        + (SELECT COUNT(*)::int FROM filtered_sessions WHERE status = 'failed')
      ) AS join_failure_count,
      (
        SELECT COUNT(*)::int
        FROM filtered_sessions
        WHERE provider = 'livekit'
           OR LOWER(COALESCE(metadata->>'turn', '')) IN ('livekit_embedded_first', 'livekit_embedded', 'coturn', 'turn')
           OR LOWER(COALESCE(metadata->>'ice_transport', '')) = 'relay'
           OR LOWER(COALESCE(metadata->>'ice_transport_policy', '')) = 'relay'
           OR LOWER(COALESCE(metadata->>'turn_used', '')) IN ('true', '1', 'yes')
      ) AS turn_session_count,
      (
        SELECT ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE provider = 'livekit'
               OR LOWER(COALESCE(metadata->>'turn', '')) IN ('livekit_embedded_first', 'livekit_embedded', 'coturn', 'turn')
               OR LOWER(COALESCE(metadata->>'ice_transport', '')) = 'relay'
               OR LOWER(COALESCE(metadata->>'ice_transport_policy', '')) = 'relay'
               OR LOWER(COALESCE(metadata->>'turn_used', '')) IN ('true', '1', 'yes')
          ) / NULLIF(COUNT(*), 0),
          1
        )
        FROM filtered_sessions
      ) AS turn_usage_rate_pct,
      (
        SELECT COUNT(*)::int
        FROM filtered_tele
        WHERE remote_consent_id IS NOT NULL
          AND remote_consent_signed_at IS NOT NULL
      ) AS consent_recorded_count,
      (
        SELECT ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE remote_consent_id IS NOT NULL
              AND remote_consent_signed_at IS NOT NULL
          ) / NULLIF(COUNT(*), 0),
          1
        )
        FROM filtered_tele
      ) AS consent_recorded_rate_pct,
      COALESCE((
        SELECT jsonb_object_agg(status, count)
        FROM (
          SELECT status, COUNT(*)::int AS count
          FROM filtered_tele
          GROUP BY status
        ) grouped
      ), '{}'::jsonb) AS status_counts,
      COALESCE((
        SELECT jsonb_object_agg(status, count)
        FROM (
          SELECT status, COUNT(*)::int AS count
          FROM filtered_sessions
          GROUP BY status
        ) grouped
      ), '{}'::jsonb) AS video_session_counts,
      COALESCE((
        SELECT jsonb_object_agg(provider, count)
        FROM (
          SELECT provider, COUNT(*)::int AS count
          FROM filtered_sessions
          GROUP BY provider
        ) grouped
      ), '{}'::jsonb) AS provider_counts,
      COALESCE((
        SELECT jsonb_object_agg(consult_type, count)
        FROM (
          SELECT consult_type, COUNT(*)::int AS count
          FROM filtered_tele
          WHERE status IN ('completed', 'cancelled', 'no_show', 'failed')
          GROUP BY consult_type
        ) grouped
      ), '{}'::jsonb) AS final_modality_distribution
  `;
}

function buildPayload(row, { windowHours }) {
  const featureState = getTeleconsultFeatureState();
  const payload = {
    generated_at: new Date().toISOString(),
    window_hours: windowHours,
    livekit_enabled: Boolean(featureState.livekit_enabled),
    recording_enabled: false,
    media_boundary: featureState.media_boundary || 'hospital_infra_only',
    queue_model: 'doctor_department_badge',
    teleconsult_count: asNumber(row?.teleconsult_count),
    active_count: asNumber(row?.active_count),
    waiting_count: asNumber(row?.waiting_count),
    scheduled_count: asNumber(row?.scheduled_count),
    terminal_count: asNumber(row?.terminal_count),
    video_session_count: asNumber(row?.video_session_count),
    join_failure_count: asNumber(row?.join_failure_count),
    turn_session_count: asNumber(row?.turn_session_count),
    turn_usage_rate_pct: asPct(row?.turn_usage_rate_pct),
    consent_recorded_count: asNumber(row?.consent_recorded_count),
    consent_recorded_rate_pct: asPct(row?.consent_recorded_rate_pct),
    final_modality_distribution: normalizeDistribution(row?.final_modality_distribution, MODALITY_KEYS),
    status_counts: normalizeDistribution(row?.status_counts, STATUS_KEYS),
    video_session_counts: normalizeDistribution(row?.video_session_counts, VIDEO_STATUS_KEYS),
    provider_counts: normalizeDistribution(row?.provider_counts),
  };
  return assertTeleconsultOpsTelemetryAllowlist(payload);
}

export async function getTeleconsultOpsSnapshot({ tenantId, windowHours = 24 } = {}) {
  const tid = requireTenantId(tenantId);
  const hours = clampWindowHours(windowHours);
  const rows = await prisma.$queryRawUnsafe(
    buildSnapshotSql({ tenantScoped: true }),
    tid,
    hours,
  );
  return buildPayload(rows?.[0] || {}, { windowHours: hours });
}

export async function getTeleconsultOpsAggregateSnapshot({ windowHours = 24 } = {}) {
  const hours = clampWindowHours(windowHours);
  const rows = await prisma.$queryRawUnsafe(
    buildSnapshotSql({ tenantScoped: false }),
    hours,
  );
  return buildPayload(rows?.[0] || {}, { windowHours: hours });
}

export default {
  TELECONSULT_OPS_TELEMETRY_FIELDS,
  assertTeleconsultOpsTelemetryAllowlist,
  getTeleconsultOpsSnapshot,
  getTeleconsultOpsAggregateSnapshot,
};
