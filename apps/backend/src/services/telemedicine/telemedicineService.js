/**
 * Telemedicine domain service (Phase B1).
 *
 * Manages the six tables added in migration 117:
 *   - teleconsultations             — top-level remote consult record
 *   - video_sessions                — provider-specific session metadata
 *   - chat_sessions / chat_session_messages — async thread + per-message
 *   - remote_prescriptions          — Rx issued during a teleconsult
 *   - teleconsult_provider_configs  — tenant-level provider credentials
 *
 * The service is provider-agnostic: it stores join URLs / external
 * session IDs but does not call out to Zoom / Daily.co / Jitsi APIs.
 * That integration is done by a thin provider adapter that records
 * external_session_id + join URLs back into video_sessions.
 *
 * Decision-support only: no auto-billing, no auto-ending. Patient +
 * clinician explicitly transition consult status through routes.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { encryptField, isEncrypted } from '../../utils/fieldEncryption.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const CONSULT_TYPES = ['video', 'chat', 'audio', 'hybrid'];
export const CONSULT_STATUSES = [
  'scheduled', 'waiting', 'in_progress', 'completed', 'cancelled', 'no_show', 'failed',
];
export const VIDEO_PROVIDERS = ['zoom', 'daily', 'jitsi', 'twilio', 'agora', 'webrtc_native', 'other'];
export const VIDEO_STATUSES = ['created', 'active', 'ended', 'cancelled', 'failed'];
export const RECORDING_STATUSES = ['disabled', 'pending', 'available', 'failed', 'deleted'];
export const CHAT_STATUSES = ['active', 'closed', 'archived'];
export const CHAT_ROLES = ['patient', 'doctor', 'staff', 'system'];
export const CHAT_BODY_KINDS = ['text', 'system_event', 'alert', 'attachment_card'];
export const REMOTE_RX_STATUSES = ['draft', 'issued', 'fulfilled', 'cancelled', 'recalled'];
export const SIGNATURE_KINDS = [
  'doctor_signed', 'aadhaar_esign', 'dsc', 'platform_attested', 'unsigned',
];
export const PROVIDER_CONFIG_STATUSES = ['active', 'paused', 'failed'];
export const PROVIDER_HEALTH_STATUSES = ['ok', 'degraded', 'down'];

const CONSULT_TRANSITIONS = {
  scheduled: ['waiting', 'in_progress', 'cancelled', 'no_show'],
  waiting: ['in_progress', 'cancelled', 'no_show', 'failed'],
  in_progress: ['completed', 'failed'],
  completed: [],
  cancelled: [],
  no_show: [],
  failed: [],
};

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

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

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON array`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function encryptOptionalSecret(value) {
  const text = safeText(value);
  if (!text) return null;
  return isEncrypted(text) ? text : encryptField(text);
}

// ---------------------------------------------------------------------------
// teleconsultations
// ---------------------------------------------------------------------------

const CONSULT_RETURNING = `id, tenant_id, appointment_id, patient_uid, doctor_uid,
  consult_type, status, scheduled_start, scheduled_end, actual_start, actual_end,
  chief_complaint, pre_consult_form,
  remote_consent_id, remote_consent_signed_at,
  ai_note_generation_id, ai_pre_visit_summary_id,
  recording_url, recording_consent, cancellation_reason,
  metadata, created_by, created_at, updated_at`;

export async function createTeleconsultation({
  tenantId = null,
  appointmentId = null,
  patientUid = null,
  doctorUid = null,
  consultType = 'video',
  scheduledStart = null,
  scheduledEnd = null,
  chiefComplaint = null,
  preConsultForm = null,
  remoteConsentId = null,
  recordingConsent = false,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO teleconsultations
         (tenant_id, appointment_id, patient_uid, doctor_uid,
          consult_type, status, scheduled_start, scheduled_end,
          chief_complaint, pre_consult_form,
          remote_consent_id, recording_consent,
          metadata, created_by)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid,
         $5, 'scheduled', $6::timestamptz, $7::timestamptz,
         $8, $9::jsonb,
         $10, $11,
         $12::jsonb, $13::uuid)
       RETURNING ${CONSULT_RETURNING}`,
      tid,
      appointmentId ? normalizeId(appointmentId, 'appointment_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(doctorUid, 'doctor_uid'),
      normalizeEnum(consultType, CONSULT_TYPES, 'consult_type') || 'video',
      normalizeTimestamp(scheduledStart, 'scheduled_start'),
      normalizeTimestamp(scheduledEnd, 'scheduled_end'),
      safeText(chiefComplaint),
      JSON.stringify(normalizeJsonObject(preConsultForm, 'pre_consult_form')),
      safeText(remoteConsentId, 120),
      normalizeBoolean(recordingConsent, false),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listTeleconsultations({
  tenantId = null,
  status = null,
  patientUid = null,
  doctorUid = null,
  windowStart = null,
  windowEnd = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, CONSULT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (doctorUid) {
    params.push(maybeUuid(doctorUid, 'doctor_uid'));
    filters.push(`doctor_uid = $${params.length}::uuid`);
  }
  if (windowStart) {
    params.push(normalizeTimestamp(windowStart, 'window_start'));
    filters.push(`scheduled_start >= $${params.length}::timestamptz`);
  }
  if (windowEnd) {
    params.push(normalizeTimestamp(windowEnd, 'window_end'));
    filters.push(`scheduled_start <= $${params.length}::timestamptz`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${CONSULT_RETURNING} FROM teleconsultations
       WHERE ${filters.join(' AND ')}
       ORDER BY scheduled_start DESC NULLS LAST, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { teleconsultations: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { teleconsultations: [], count: 0 };
    throw err;
  }
}

export async function getTeleconsultation({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(id, 'teleconsultation id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${CONSULT_RETURNING} FROM teleconsultations
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    consultId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Teleconsultation not found');
  return rows[0];
}

export async function transitionTeleconsultation({
  tenantId = null, id, nextStatus,
  cancellationReason = null,
  recordingUrl = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(id, 'teleconsultation id');
  const cleanNext = normalizeEnum(nextStatus, CONSULT_STATUSES, 'next_status', { required: true });

  const current = await getTeleconsultation({ tenantId: tid, id: consultId });
  const allowed = CONSULT_TRANSITIONS[current.status] || [];
  if (!allowed.includes(cleanNext)) {
    throw AppError.invalidTransition(current.status, cleanNext, allowed);
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanNext];
  if (cleanNext === 'in_progress' && !current.actual_start) {
    params.push(new Date().toISOString());
    updates.push(`actual_start = $${params.length}::timestamptz`);
  }
  if (['completed', 'cancelled', 'no_show', 'failed'].includes(cleanNext)) {
    if (cleanNext === 'completed' || cleanNext === 'failed') {
      params.push(new Date().toISOString());
      updates.push(`actual_end = $${params.length}::timestamptz`);
    }
    if (cancellationReason && (cleanNext === 'cancelled' || cleanNext === 'no_show')) {
      params.push(safeText(cancellationReason));
      updates.push(`cancellation_reason = $${params.length}`);
    }
  }
  if (recordingUrl) {
    params.push(safeText(recordingUrl));
    updates.push(`recording_url = $${params.length}`);
  }
  params.push(consultId);
  params.push(tid);

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE teleconsultations
     SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${CONSULT_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Teleconsultation not found');
  return rows[0];
}

export async function recordRemoteConsent({
  tenantId = null, id, consentId, signedAt = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(id, 'teleconsultation id');
  const cleanConsent = safeText(consentId, 120);
  if (!cleanConsent) throw AppError.badRequest('consent_id is required');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE teleconsultations
     SET remote_consent_id = $1,
         remote_consent_signed_at = COALESCE($2::timestamptz, NOW()),
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid
     RETURNING ${CONSULT_RETURNING}`,
    cleanConsent, normalizeTimestamp(signedAt, 'signed_at'), consultId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Teleconsultation not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// video_sessions
// ---------------------------------------------------------------------------

const VIDEO_RETURNING = `id, tenant_id, teleconsultation_id, provider,
  external_session_id, patient_join_url, doctor_join_url, host_token,
  started_at, ended_at, duration_seconds, participant_count,
  bandwidth_kbps_avg, packet_loss_pct, recording_id, recording_status,
  status, metadata, created_at, updated_at`;

export async function createVideoSession({
  tenantId = null,
  teleconsultationId,
  provider,
  externalSessionId = null,
  patientJoinUrl = null,
  doctorJoinUrl = null,
  hostToken = null,
  recordingStatus = 'disabled',
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(teleconsultationId, 'teleconsultation_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO video_sessions
         (tenant_id, teleconsultation_id, provider,
          external_session_id, patient_join_url, doctor_join_url, host_token,
          recording_status, status, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'created', $9::jsonb)
       RETURNING ${VIDEO_RETURNING}`,
      tid, consultId,
      normalizeEnum(provider, VIDEO_PROVIDERS, 'provider', { required: true }),
      safeText(externalSessionId, SHORT_MAX),
      safeText(patientJoinUrl),
      safeText(doctorJoinUrl),
      safeText(hostToken),
      normalizeEnum(recordingStatus, RECORDING_STATUSES, 'recording_status') || 'disabled',
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function transitionVideoSession({
  tenantId = null, id, status,
  durationSeconds = null,
  participantCount = null,
  bandwidthKbpsAvg = null,
  packetLossPct = null,
  recordingId = null,
  recordingStatus = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const sessId = normalizeId(id, 'video_session id');
  const cleanStatus = normalizeEnum(status, VIDEO_STATUSES, 'status', { required: true });

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'active') {
    params.push(new Date().toISOString());
    updates.push(`started_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'ended' || cleanStatus === 'failed') {
    params.push(new Date().toISOString());
    updates.push(`ended_at = $${params.length}::timestamptz`);
  }
  if (durationSeconds != null) {
    params.push(normalizeInt(durationSeconds, 'duration_seconds', { min: 0, max: 86400 }));
    updates.push(`duration_seconds = $${params.length}`);
  }
  if (participantCount != null) {
    params.push(normalizeInt(participantCount, 'participant_count', { min: 0, max: 100 }));
    updates.push(`participant_count = $${params.length}`);
  }
  if (bandwidthKbpsAvg != null) {
    params.push(normalizeInt(bandwidthKbpsAvg, 'bandwidth_kbps_avg', { min: 0, max: 1_000_000 }));
    updates.push(`bandwidth_kbps_avg = $${params.length}`);
  }
  if (packetLossPct != null) {
    const v = Number(packetLossPct);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw AppError.badRequest('packet_loss_pct must be 0..100');
    }
    params.push(v);
    updates.push(`packet_loss_pct = $${params.length}`);
  }
  if (recordingId != null) {
    params.push(safeText(recordingId, SHORT_MAX));
    updates.push(`recording_id = $${params.length}`);
  }
  if (recordingStatus != null) {
    params.push(normalizeEnum(recordingStatus, RECORDING_STATUSES, 'recording_status'));
    updates.push(`recording_status = $${params.length}`);
  }
  params.push(sessId);
  params.push(tid);

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE video_sessions
     SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${VIDEO_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Video session not found');
  return rows[0];
}

export async function listVideoSessions({
  tenantId = null,
  teleconsultationId = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (teleconsultationId) {
    params.push(normalizeId(teleconsultationId, 'teleconsultation_id'));
    filters.push(`teleconsultation_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, VIDEO_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${VIDEO_RETURNING} FROM video_sessions
       WHERE ${filters.join(' AND ')}
       ORDER BY started_at DESC NULLS LAST, created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { video_sessions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { video_sessions: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// chat_sessions + chat_session_messages
// ---------------------------------------------------------------------------

const CHAT_SESSION_RETURNING = `id, tenant_id, teleconsultation_id,
  patient_uid, doctor_uid, topic, status,
  started_at, closed_at, last_message_at,
  unread_count_patient, unread_count_doctor,
  metadata, created_at, updated_at`;

const CHAT_MESSAGE_RETURNING = `id, tenant_id, chat_session_id, authored_by_uid,
  authored_role, body, body_kind, attachments,
  read_by_recipient_at, redacted, redacted_reason,
  metadata, created_at`;

export async function createChatSession({
  tenantId = null,
  teleconsultationId = null,
  patientUid = null,
  doctorUid = null,
  topic = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO chat_sessions
         (tenant_id, teleconsultation_id, patient_uid, doctor_uid,
          topic, status, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, 'active', $6::jsonb)
       RETURNING ${CHAT_SESSION_RETURNING}`,
      tid,
      teleconsultationId ? normalizeId(teleconsultationId, 'teleconsultation_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(doctorUid, 'doctor_uid'),
      safeText(topic, SHORT_MAX),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function postChatMessage({
  tenantId = null,
  chatSessionId,
  authoredByUid = null,
  authoredRole,
  body,
  bodyKind = 'text',
  attachments = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const sessId = normalizeId(chatSessionId, 'chat_session_id');
  const cleanRole = normalizeEnum(authoredRole, CHAT_ROLES, 'authored_role', { required: true });
  const cleanBody = safeText(body);
  if (!cleanBody) throw AppError.badRequest('body is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO chat_session_messages
         (tenant_id, chat_session_id, authored_by_uid, authored_role,
          body, body_kind, attachments, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8::jsonb)
       RETURNING ${CHAT_MESSAGE_RETURNING}`,
      tid, sessId, maybeUuid(authoredByUid, 'authored_by_uid'),
      cleanRole, cleanBody,
      normalizeEnum(bodyKind, CHAT_BODY_KINDS, 'body_kind') || 'text',
      JSON.stringify(attachments ? normalizeJsonArray(attachments, 'attachments') : []),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );

    // Bump session counters atomically.
    await prisma.$queryRawUnsafe(
      `UPDATE chat_sessions
       SET last_message_at = NOW(),
           unread_count_patient = unread_count_patient + (CASE WHEN $1 = 'doctor' THEN 1 ELSE 0 END),
           unread_count_doctor = unread_count_doctor + (CASE WHEN $1 = 'patient' THEN 1 ELSE 0 END),
           updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      cleanRole, sessId, tid,
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listChatMessages({
  tenantId = null,
  chatSessionId,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const sessId = normalizeId(chatSessionId, 'chat_session_id');
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${CHAT_MESSAGE_RETURNING} FROM chat_session_messages
       WHERE tenant_id = $1::uuid AND chat_session_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      tid, sessId, safeLimit,
    );
    return { messages: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { messages: [], count: 0 };
    throw err;
  }
}

export async function markChatRead({
  tenantId = null,
  chatSessionId,
  reader, // 'patient' | 'doctor'
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const sessId = normalizeId(chatSessionId, 'chat_session_id');
  if (reader !== 'patient' && reader !== 'doctor') {
    throw AppError.badRequest('reader must be "patient" or "doctor"');
  }
  const otherRole = reader === 'patient' ? 'doctor' : 'patient';
  const counterCol = reader === 'patient' ? 'unread_count_patient' : 'unread_count_doctor';

  await prisma.$queryRawUnsafe(
    `UPDATE chat_session_messages
     SET read_by_recipient_at = NOW()
     WHERE tenant_id = $1::uuid
       AND chat_session_id = $2
       AND authored_role = $3
       AND read_by_recipient_at IS NULL`,
    tid, sessId, otherRole,
  );

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE chat_sessions
     SET ${counterCol} = 0,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid
     RETURNING ${CHAT_SESSION_RETURNING}`,
    sessId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Chat session not found');
  return rows[0];
}

export async function listChatSessions({
  tenantId = null,
  patientUid = null,
  doctorUid = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (doctorUid) {
    params.push(maybeUuid(doctorUid, 'doctor_uid'));
    filters.push(`doctor_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, CHAT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${CHAT_SESSION_RETURNING} FROM chat_sessions
       WHERE ${filters.join(' AND ')}
       ORDER BY last_message_at DESC NULLS LAST, started_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { chat_sessions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { chat_sessions: [], count: 0 };
    throw err;
  }
}

export async function closeChatSession({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const sessId = normalizeId(id, 'chat_session id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE chat_sessions
     SET status = 'closed', closed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status = 'active'
     RETURNING ${CHAT_SESSION_RETURNING}`,
    sessId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Chat session not found or already closed');
  return rows[0];
}

// ---------------------------------------------------------------------------
// remote_prescriptions
// ---------------------------------------------------------------------------

const REMOTE_RX_RETURNING = `id, tenant_id, teleconsultation_id, prescription_id,
  patient_uid, doctor_uid, issued_at, status,
  digital_signature_kind, digital_signature_payload,
  pdf_url, cancellation_reason,
  metadata, created_at, updated_at`;

export async function recordRemotePrescription({
  tenantId = null,
  teleconsultationId,
  prescriptionId = null,
  patientUid = null,
  doctorUid = null,
  signatureKind = 'platform_attested',
  signaturePayload = null,
  pdfUrl = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(teleconsultationId, 'teleconsultation_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO remote_prescriptions
         (tenant_id, teleconsultation_id, prescription_id,
          patient_uid, doctor_uid, status,
          digital_signature_kind, digital_signature_payload, pdf_url,
          metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, 'issued',
         $6, $7::jsonb, $8, $9::jsonb)
       RETURNING ${REMOTE_RX_RETURNING}`,
      tid, consultId,
      prescriptionId ? normalizeId(prescriptionId, 'prescription_id') : null,
      maybeUuid(patientUid, 'patient_uid'),
      maybeUuid(doctorUid, 'doctor_uid'),
      normalizeEnum(signatureKind, SIGNATURE_KINDS, 'signature_kind') || 'platform_attested',
      JSON.stringify(normalizeJsonObject(signaturePayload, 'signature_payload')),
      safeText(pdfUrl),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function transitionRemotePrescription({
  tenantId = null, id, nextStatus,
  cancellationReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const rxId = normalizeId(id, 'remote_prescription id');
  const cleanStatus = normalizeEnum(nextStatus, REMOTE_RX_STATUSES, 'next_status', { required: true });
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cancellationReason && (cleanStatus === 'cancelled' || cleanStatus === 'recalled')) {
    params.push(safeText(cancellationReason));
    updates.push(`cancellation_reason = $${params.length}`);
  }
  params.push(rxId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE remote_prescriptions
     SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${REMOTE_RX_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Remote prescription not found');
  return rows[0];
}

export async function listRemotePrescriptions({
  tenantId = null,
  teleconsultationId = null,
  patientUid = null,
  status = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (teleconsultationId) {
    params.push(normalizeId(teleconsultationId, 'teleconsultation_id'));
    filters.push(`teleconsultation_id = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, REMOTE_RX_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${REMOTE_RX_RETURNING} FROM remote_prescriptions
       WHERE ${filters.join(' AND ')}
       ORDER BY issued_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { remote_prescriptions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { remote_prescriptions: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// teleconsult_provider_configs
// ---------------------------------------------------------------------------

const PROVIDER_CONFIG_RETURNING = `id, tenant_id, provider, is_default, display_name,
  endpoint_base, config, status, last_health_check_at, last_health_status,
  metadata, created_by, created_at, updated_at`;

export async function upsertProviderConfig({
  tenantId = null,
  provider,
  isDefault = false,
  displayName = null,
  apiKeyCiphertext = null,
  apiSecretCiphertext = null,
  webhookSecretCiphertext = null,
  endpointBase = null,
  config = null,
  status = 'active',
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanProvider = normalizeEnum(provider, VIDEO_PROVIDERS, 'provider', { required: true });
  const cleanStatus = normalizeEnum(status, PROVIDER_CONFIG_STATUSES, 'status') || 'active';
  const flagDefault = normalizeBoolean(isDefault, false);

  // If setting default, demote other defaults atomically.
  if (flagDefault) {
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE teleconsult_provider_configs
         SET is_default = false, updated_at = NOW()
         WHERE tenant_id = $1::uuid AND is_default = true AND provider <> $2`,
        tid, cleanProvider,
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO teleconsult_provider_configs
         (tenant_id, provider, is_default, display_name,
          api_key_ciphertext, api_secret_ciphertext, webhook_secret_ciphertext,
          endpoint_base, config, status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::uuid)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET
         is_default = EXCLUDED.is_default,
         display_name = EXCLUDED.display_name,
         api_key_ciphertext = EXCLUDED.api_key_ciphertext,
         api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
         webhook_secret_ciphertext = EXCLUDED.webhook_secret_ciphertext,
         endpoint_base = EXCLUDED.endpoint_base,
         config = EXCLUDED.config,
         status = EXCLUDED.status,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
      RETURNING ${PROVIDER_CONFIG_RETURNING}`,
      tid, cleanProvider, flagDefault, safeText(displayName, 160),
      encryptOptionalSecret(apiKeyCiphertext),
      encryptOptionalSecret(apiSecretCiphertext),
      encryptOptionalSecret(webhookSecretCiphertext),
      safeText(endpointBase),
      JSON.stringify(normalizeJsonObject(config, 'config')),
      cleanStatus,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid tenant_id');
    throw err;
  }
}

export async function listProviderConfigs({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${PROVIDER_CONFIG_RETURNING} FROM teleconsult_provider_configs
       WHERE tenant_id = $1::uuid
       ORDER BY is_default DESC, provider`,
      tid,
    );
    return { configs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { configs: [], count: 0 };
    throw err;
  }
}

export async function recordProviderHealthCheck({
  tenantId = null, provider, healthStatus,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanProvider = normalizeEnum(provider, VIDEO_PROVIDERS, 'provider', { required: true });
  const cleanHealth = normalizeEnum(healthStatus, PROVIDER_HEALTH_STATUSES, 'health_status', { required: true });
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE teleconsult_provider_configs
     SET last_health_check_at = NOW(),
         last_health_status = $1,
         updated_at = NOW()
     WHERE tenant_id = $2::uuid AND provider = $3
     RETURNING ${PROVIDER_CONFIG_RETURNING}`,
    cleanHealth, tid, cleanProvider,
  );
  if (!rows[0]) throw AppError.notFound('Provider config not found');
  return rows[0];
}

export const __testing__ = {
  CONSULT_TYPES,
  CONSULT_STATUSES,
  CONSULT_TRANSITIONS,
  VIDEO_PROVIDERS,
  VIDEO_STATUSES,
  CHAT_STATUSES,
  CHAT_ROLES,
  REMOTE_RX_STATUSES,
};

export default {
  createTeleconsultation,
  listTeleconsultations,
  getTeleconsultation,
  transitionTeleconsultation,
  recordRemoteConsent,
  createVideoSession,
  transitionVideoSession,
  listVideoSessions,
  createChatSession,
  postChatMessage,
  listChatMessages,
  markChatRead,
  listChatSessions,
  closeChatSession,
  recordRemotePrescription,
  transitionRemotePrescription,
  listRemotePrescriptions,
  upsertProviderConfig,
  listProviderConfigs,
  recordProviderHealthCheck,
};
