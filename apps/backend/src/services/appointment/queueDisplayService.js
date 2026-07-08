import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DISPLAY_MODES = new Set(['token_board', 'counter_board', 'department_board']);
const ACCESSIBILITY_SIZES = new Set(['standard', 'large', 'extra_large']);
const CONTRAST_MODES = new Set(['standard', 'high']);
const MOTION_MODES = new Set(['standard', 'reduced']);
const QUEUE_KINDS = new Set(['op', 'walk_in', 'department', 'doctor', 'emergency', 'lab', 'imaging', 'other']);

export const DEFAULT_QUEUE_DISPLAY_SETTINGS = Object.freeze({
  enabled: false,
  pollIntervalSeconds: 15,
  maxItems: 12,
  etaBucketsEnabled: false,
  defaultLanguageCode: 'en',
  defaultAccessibilitySize: 'standard',
});

function textOrNull(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function requiredText(value, field, maxLength) {
  const text = textOrNull(value, maxLength);
  if (!text) throw AppError.badRequest(`${field} is required`, 'QUEUE_DISPLAY_INVALID_PROFILE');
  return text;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function intOrNull(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${field} must be a positive integer`, 'QUEUE_DISPLAY_INVALID_PROFILE');
  }
  return parsed;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function enumValue(value, allowed, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw AppError.badRequest(`${field} is invalid`, 'QUEUE_DISPLAY_INVALID_PROFILE');
  }
  return normalized;
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || `queue-display-${Date.now()}`;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function toSettings(row) {
  if (!row) return { ...DEFAULT_QUEUE_DISPLAY_SETTINGS };
  return {
    enabled: row.enabled === true,
    pollIntervalSeconds: Number(row.poll_interval_seconds ?? DEFAULT_QUEUE_DISPLAY_SETTINGS.pollIntervalSeconds),
    maxItems: Number(row.max_items ?? DEFAULT_QUEUE_DISPLAY_SETTINGS.maxItems),
    etaBucketsEnabled: row.eta_buckets_enabled === true,
    defaultLanguageCode: row.default_language_code || DEFAULT_QUEUE_DISPLAY_SETTINGS.defaultLanguageCode,
    defaultAccessibilitySize: row.default_accessibility_size || DEFAULT_QUEUE_DISPLAY_SETTINGS.defaultAccessibilitySize,
    enabledAt: toIso(row.enabled_at),
    enabledBy: row.enabled_by ?? null,
    acceptanceSnapshot: row.acceptance_snapshot ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toProfile(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    profileKey: row.profile_key,
    displayName: row.display_name,
    locationLabel: row.location_label ?? null,
    facilityId: row.facility_id == null ? null : Number(row.facility_id),
    departmentId: row.department_id == null ? null : Number(row.department_id),
    doctorId: row.doctor_id == null ? null : Number(row.doctor_id),
    queueKind: row.queue_kind ?? null,
    queueLabelOverride: row.queue_label_override ?? null,
    counterLabel: row.counter_label ?? null,
    displayMode: row.display_mode,
    languageCode: row.language_code,
    accessibilitySize: row.accessibility_size,
    contrastMode: row.contrast_mode,
    motionMode: row.motion_mode,
    audioAnnouncementsEnabled: row.audio_announcements_enabled === true,
    maskedNamePolicy: row.masked_name_policy,
    isActive: row.is_active === true,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeSettingsPatch(patch = {}) {
  const enabled = boolValue(patch.enabled, DEFAULT_QUEUE_DISPLAY_SETTINGS.enabled);
  return {
    enabled,
    pollIntervalSeconds: clampInt(
      patch.pollIntervalSeconds ?? patch.poll_interval_seconds,
      DEFAULT_QUEUE_DISPLAY_SETTINGS.pollIntervalSeconds,
      5,
      120,
    ),
    maxItems: clampInt(patch.maxItems ?? patch.max_items, DEFAULT_QUEUE_DISPLAY_SETTINGS.maxItems, 1, 50),
    etaBucketsEnabled: boolValue(
      patch.etaBucketsEnabled ?? patch.eta_buckets_enabled,
      DEFAULT_QUEUE_DISPLAY_SETTINGS.etaBucketsEnabled,
    ),
    defaultLanguageCode: textOrNull(patch.defaultLanguageCode ?? patch.default_language_code, 16)
      || DEFAULT_QUEUE_DISPLAY_SETTINGS.defaultLanguageCode,
    defaultAccessibilitySize: enumValue(
      patch.defaultAccessibilitySize ?? patch.default_accessibility_size,
      ACCESSIBILITY_SIZES,
      DEFAULT_QUEUE_DISPLAY_SETTINGS.defaultAccessibilitySize,
      'defaultAccessibilitySize',
    ),
    acceptanceSnapshot: patch.acceptanceSnapshot ?? patch.acceptance_snapshot ?? null,
  };
}

function normalizeProfilePayload(payload = {}, existing = null) {
  const displayName = requiredText(
    payload.displayName ?? payload.display_name ?? existing?.displayName,
    'displayName',
    160,
  );
  const maskedNamePolicy = String(
    payload.maskedNamePolicy ?? payload.masked_name_policy ?? existing?.maskedNamePolicy ?? 'token_only',
  ).trim().toLowerCase();
  if (maskedNamePolicy !== 'token_only') {
    throw AppError.badRequest('Queue displays are locked to token-only identity', 'QUEUE_DISPLAY_TOKEN_ONLY');
  }

  return {
    profileKey: textOrNull(payload.profileKey ?? payload.profile_key ?? existing?.profileKey, 80) || slugify(displayName),
    displayName,
    locationLabel: textOrNull(payload.locationLabel ?? payload.location_label ?? existing?.locationLabel, 160),
    facilityId: intOrNull(payload.facilityId ?? payload.facility_id ?? existing?.facilityId, 'facilityId'),
    departmentId: intOrNull(payload.departmentId ?? payload.department_id ?? existing?.departmentId, 'departmentId'),
    doctorId: intOrNull(payload.doctorId ?? payload.doctor_id ?? existing?.doctorId, 'doctorId'),
    queueKind: enumValue(payload.queueKind ?? payload.queue_kind ?? existing?.queueKind, QUEUE_KINDS, null, 'queueKind'),
    queueLabelOverride: textOrNull(
      payload.queueLabelOverride ?? payload.queue_label_override ?? existing?.queueLabelOverride,
      255,
    ),
    counterLabel: textOrNull(payload.counterLabel ?? payload.counter_label ?? existing?.counterLabel, 120),
    displayMode: enumValue(
      payload.displayMode ?? payload.display_mode ?? existing?.displayMode,
      DISPLAY_MODES,
      'token_board',
      'displayMode',
    ),
    languageCode: textOrNull(payload.languageCode ?? payload.language_code ?? existing?.languageCode, 16) || 'en',
    accessibilitySize: enumValue(
      payload.accessibilitySize ?? payload.accessibility_size ?? existing?.accessibilitySize,
      ACCESSIBILITY_SIZES,
      'standard',
      'accessibilitySize',
    ),
    contrastMode: enumValue(
      payload.contrastMode ?? payload.contrast_mode ?? existing?.contrastMode,
      CONTRAST_MODES,
      'standard',
      'contrastMode',
    ),
    motionMode: enumValue(
      payload.motionMode ?? payload.motion_mode ?? existing?.motionMode,
      MOTION_MODES,
      'standard',
      'motionMode',
    ),
    audioAnnouncementsEnabled: boolValue(
      payload.audioAnnouncementsEnabled ?? payload.audio_announcements_enabled,
      existing?.audioAnnouncementsEnabled ?? false,
    ),
    maskedNamePolicy,
    isActive: boolValue(payload.isActive ?? payload.is_active, existing?.isActive ?? true),
  };
}

export async function getQueueDisplaySettings(tenantId) {
  const scopedTenantId = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, enabled, poll_interval_seconds, max_items,
            eta_buckets_enabled, default_language_code, default_accessibility_size,
            enabled_at, enabled_by, acceptance_snapshot, updated_by, created_at, updated_at
       FROM queue_display_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    scopedTenantId,
  );
  return toSettings(rows[0]);
}

export async function updateQueueDisplaySettings(tenantId, patch = {}, { actorUid = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const next = normalizeSettingsPatch(patch);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO queue_display_settings (
       tenant_id, enabled, poll_interval_seconds, max_items, eta_buckets_enabled,
       default_language_code, default_accessibility_size, enabled_at, enabled_by,
       acceptance_snapshot, updated_by, updated_at
     )
     VALUES (
       $1::uuid, $2, $3::int, $4::int, $5, $6, $7,
       CASE WHEN $2 THEN NOW() ELSE NULL END,
       CASE WHEN $2 THEN $8::uuid ELSE NULL END,
       $9::jsonb, $8::uuid, NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = $2,
       poll_interval_seconds = $3::int,
       max_items = $4::int,
       eta_buckets_enabled = $5,
       default_language_code = $6,
       default_accessibility_size = $7,
       enabled_at = CASE WHEN $2 THEN COALESCE(queue_display_settings.enabled_at, NOW()) ELSE NULL END,
       enabled_by = CASE WHEN $2 THEN COALESCE(queue_display_settings.enabled_by, $8::uuid) ELSE NULL END,
       acceptance_snapshot = $9::jsonb,
       updated_by = $8::uuid,
       updated_at = NOW()
     RETURNING tenant_id, enabled, poll_interval_seconds, max_items,
               eta_buckets_enabled, default_language_code, default_accessibility_size,
               enabled_at, enabled_by, acceptance_snapshot, updated_by, created_at, updated_at`,
    scopedTenantId,
    next.enabled,
    next.pollIntervalSeconds,
    next.maxItems,
    next.etaBucketsEnabled,
    next.defaultLanguageCode,
    next.defaultAccessibilitySize,
    actorUid,
    next.acceptanceSnapshot == null ? null : JSON.stringify(next.acceptanceSnapshot),
  );
  return toSettings(rows[0]);
}

export async function listQueueDisplayProfiles(tenantId, { activeOnly = false } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, profile_key, display_name, location_label, facility_id,
            department_id, doctor_id, queue_kind, queue_label_override, counter_label,
            display_mode, language_code, accessibility_size, contrast_mode, motion_mode,
            audio_announcements_enabled, masked_name_policy, is_active,
            created_by, updated_by, created_at, updated_at
       FROM queue_display_profiles
      WHERE tenant_id = $1::uuid
        AND ($2::boolean = FALSE OR is_active = TRUE)
      ORDER BY is_active DESC, display_name ASC, id ASC`,
    scopedTenantId,
    activeOnly === true,
  );
  return rows.map(toProfile);
}

export async function getQueueDisplayProfile(tenantId, profileId) {
  const scopedTenantId = requireTenantId(tenantId);
  const id = clampInt(profileId, 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) throw AppError.badRequest('profileId is required', 'QUEUE_DISPLAY_INVALID_PROFILE');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, profile_key, display_name, location_label, facility_id,
            department_id, doctor_id, queue_kind, queue_label_override, counter_label,
            display_mode, language_code, accessibility_size, contrast_mode, motion_mode,
            audio_announcements_enabled, masked_name_policy, is_active,
            created_by, updated_by, created_at, updated_at
       FROM queue_display_profiles
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    scopedTenantId,
    id,
  );
  const profile = toProfile(rows[0]);
  if (!profile) throw AppError.notFound('Queue display profile not found', 'QUEUE_DISPLAY_PROFILE_NOT_FOUND');
  return profile;
}

export async function createQueueDisplayProfile(tenantId, payload = {}, { actorUid = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const next = normalizeProfilePayload(payload);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO queue_display_profiles (
       tenant_id, profile_key, display_name, location_label, facility_id, department_id,
       doctor_id, queue_kind, queue_label_override, counter_label, display_mode,
       language_code, accessibility_size, contrast_mode, motion_mode,
       audio_announcements_enabled, masked_name_policy, is_active, created_by, updated_by
     )
     VALUES (
       $1::uuid, $2, $3, $4, $5::int, $6::int, $7::int, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, 'token_only', $17, $18::uuid, $18::uuid
     )
     RETURNING id, tenant_id, profile_key, display_name, location_label, facility_id,
               department_id, doctor_id, queue_kind, queue_label_override, counter_label,
               display_mode, language_code, accessibility_size, contrast_mode, motion_mode,
               audio_announcements_enabled, masked_name_policy, is_active,
               created_by, updated_by, created_at, updated_at`,
    scopedTenantId,
    next.profileKey,
    next.displayName,
    next.locationLabel,
    next.facilityId,
    next.departmentId,
    next.doctorId,
    next.queueKind,
    next.queueLabelOverride,
    next.counterLabel,
    next.displayMode,
    next.languageCode,
    next.accessibilitySize,
    next.contrastMode,
    next.motionMode,
    next.audioAnnouncementsEnabled,
    next.isActive,
    actorUid,
  );
  return toProfile(rows[0]);
}

export async function updateQueueDisplayProfile(tenantId, profileId, payload = {}, { actorUid = null } = {}) {
  const current = await getQueueDisplayProfile(tenantId, profileId);
  const scopedTenantId = requireTenantId(tenantId);
  const next = normalizeProfilePayload(payload, current);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE queue_display_profiles
        SET profile_key = $3,
            display_name = $4,
            location_label = $5,
            facility_id = $6::int,
            department_id = $7::int,
            doctor_id = $8::int,
            queue_kind = $9,
            queue_label_override = $10,
            counter_label = $11,
            display_mode = $12,
            language_code = $13,
            accessibility_size = $14,
            contrast_mode = $15,
            motion_mode = $16,
            audio_announcements_enabled = $17,
            masked_name_policy = 'token_only',
            is_active = $18,
            updated_by = $19::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      RETURNING id, tenant_id, profile_key, display_name, location_label, facility_id,
                department_id, doctor_id, queue_kind, queue_label_override, counter_label,
                display_mode, language_code, accessibility_size, contrast_mode, motion_mode,
                audio_announcements_enabled, masked_name_policy, is_active,
                created_by, updated_by, created_at, updated_at`,
    scopedTenantId,
    current.id,
    next.profileKey,
    next.displayName,
    next.locationLabel,
    next.facilityId,
    next.departmentId,
    next.doctorId,
    next.queueKind,
    next.queueLabelOverride,
    next.counterLabel,
    next.displayMode,
    next.languageCode,
    next.accessibilitySize,
    next.contrastMode,
    next.motionMode,
    next.audioAnnouncementsEnabled,
    next.isActive,
    actorUid,
  );
  return toProfile(rows[0]);
}

function boardDateOrToday(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw AppError.badRequest('date must be in YYYY-MM-DD format', 'QUEUE_DISPLAY_INVALID_DATE');
  }
  return text;
}

function boardItem(row) {
  return {
    appointmentId: Number(row.appointment_id),
    queueLabel: row.queue_label || 'OP Queue',
    tokenDisplay: row.token_display || `VISIT-${row.appointment_id}`,
    roomOrCounter: row.room_or_counter ?? null,
    displayStatus: row.display_status,
    appointmentTime: row.appointment_time ?? null,
    appointmentDate: row.appointment_date,
    lastUpdatedAt: toIso(row.last_updated_at),
  };
}

export async function getQueueDisplayBoard(tenantId, profileId, { date = null, limit = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const [settings, profile] = await Promise.all([
    getQueueDisplaySettings(scopedTenantId),
    getQueueDisplayProfile(scopedTenantId, profileId),
  ]);
  if (!settings.enabled) {
    throw AppError.forbidden('Queue displays are disabled for this tenant', 'QUEUE_DISPLAY_DISABLED');
  }
  if (!profile.isActive) {
    throw AppError.forbidden('Queue display profile is inactive', 'QUEUE_DISPLAY_PROFILE_INACTIVE');
  }

  const filters = [
    'a.tenant_id = $1::uuid',
    'a.appointment_date = COALESCE($2::date, CURRENT_DATE)',
    "a.status IN ('CONFIRMED', 'SCHEDULED', 'IN_PROGRESS')",
  ];
  const params = [scopedTenantId, boardDateOrToday(date)];
  if (profile.facilityId != null) {
    params.push(profile.facilityId);
    filters.push(`q.facility_id = $${params.length}::int`);
  }
  if (profile.departmentId != null) {
    params.push(profile.departmentId);
    filters.push(`(q.department_id = $${params.length}::int OR doc.department_id = $${params.length}::int)`);
  }
  if (profile.doctorId != null) {
    params.push(profile.doctorId);
    filters.push(`a.doctor_id = $${params.length}::int`);
  }
  if (profile.queueKind) {
    params.push(profile.queueKind);
    filters.push(`q.queue_kind = $${params.length}`);
  }
  params.push(clampInt(limit, settings.maxItems, 1, 50));
  const limitParam = params.length;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        a.id AS appointment_id,
        COALESCE($${limitParam + 1}, NULLIF(q.queue_label, ''), NULLIF(a.department, ''), 'OP Queue') AS queue_label,
        COALESCE(NULLIF(a.token_number, ''), NULLIF(a.visit_no, ''), 'VISIT-' || a.id::text) AS token_display,
        $${limitParam + 2} AS room_or_counter,
        CASE
          WHEN a.status = 'IN_PROGRESS' THEN 'serving'
          WHEN a.status = 'CONFIRMED' THEN 'waiting'
          ELSE 'scheduled'
        END AS display_status,
        a.appointment_time,
        a.appointment_date::text AS appointment_date,
        COALESCE(a.updated_at, a.created_at) AS last_updated_at
       FROM appointments a
       LEFT JOIN appointment_queues q
         ON q.id = a.queue_id AND q.tenant_id = a.tenant_id
       LEFT JOIN doctors doc
         ON doc.user_id = a.doctor_id
      WHERE ${filters.join(' AND ')}
      ORDER BY
        CASE WHEN a.status = 'IN_PROGRESS' THEN 0 WHEN a.status = 'CONFIRMED' THEN 1 ELSE 2 END,
        a.token_number ASC NULLS LAST,
        a.appointment_time ASC NULLS LAST,
        a.id ASC
      LIMIT $${limitParam}::int`,
    ...params,
    profile.queueLabelOverride,
    profile.counterLabel,
  );

  const generatedAt = new Date().toISOString();
  return {
    profile,
    settings,
    items: rows.map(boardItem),
    generatedAt,
    realtime: {
      channel: 'staff:appointments',
      pollFallbackSeconds: settings.pollIntervalSeconds,
    },
    phiPolicy: {
      identity: 'token_only',
      safeFieldsOnly: true,
    },
  };
}
