/**
 * NL-3 P1 teleconsult provisioning.
 *
 * This layer wraps the migration-117 telemedicine service and binds ordinary
 * visit_type='TELE' appointments to self-hosted LiveKit rooms. Live media
 * tokens are added in the token issuance layer; recording stays disabled.
 */

import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  createTeleconsultation,
  createVideoSession,
  getTeleconsultation,
  listVideoSessions,
  recordRemoteConsent,
} from './telemedicineService.js';

const HOSPITAL_TIME_ZONE = 'Asia/Kolkata';
const LIVEKIT_PROVIDER = 'livekit';
const TELE_VISIT_TYPE = 'TELE';
const DEFAULT_TOKEN_TTL_SECONDS = 600;
const MIN_TOKEN_TTL_SECONDS = 300;
const MAX_TOKEN_TTL_SECONDS = 600;
const TERMINAL_APPOINTMENT_STATUSES = new Set([
  'CANCELLED',
  'NO_SHOW',
  'MISSED',
  'RESCHEDULED',
  'COMPLETED',
  'CHECKED_OUT',
]);

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeUuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function safeText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function actorRole(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeParticipantRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'doctor' || role === 'staff') return 'clinician';
  if (!['patient', 'clinician', 'observer'].includes(role)) {
    throw AppError.badRequest('role must be one of: patient, clinician, observer');
  }
  return role;
}

export function livekitEnabled() {
  return String(process.env.LIVEKIT_ENABLED || 'false').toLowerCase() === 'true';
}

export function getTeleconsultFeatureState() {
  return {
    livekit_enabled: livekitEnabled(),
    provider: LIVEKIT_PROVIDER,
    recording_enabled: false,
    media_boundary: 'hospital_infra_only',
  };
}

function requireLivekitEnabled() {
  if (!livekitEnabled()) {
    throw new AppError('Teleconsult media is disabled', 503, 'LIVEKIT_DISABLED');
  }
}

function livekitConfig() {
  requireLivekitEnabled();
  const serverUrl = safeText(process.env.LIVEKIT_SERVER_URL, 512);
  const apiKey = safeText(process.env.LIVEKIT_API_KEY, 160);
  const apiSecret = safeText(process.env.LIVEKIT_API_SECRET, 512);
  if (!serverUrl || !apiKey || !apiSecret) {
    throw new AppError('LiveKit server credentials are not configured', 503, 'LIVEKIT_CONFIG_MISSING');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(serverUrl);
  } catch {
    throw new AppError('LIVEKIT_SERVER_URL must be a valid URL', 503, 'LIVEKIT_SERVER_URL_INVALID');
  }
  if (!['https:', 'wss:', 'http:', 'ws:'].includes(parsedUrl.protocol)) {
    throw new AppError('LIVEKIT_SERVER_URL must be HTTP(S) or WS(S)', 503, 'LIVEKIT_SERVER_URL_INVALID');
  }
  return { serverUrl, apiKey, apiSecret };
}

function tokenTtlSeconds() {
  const raw = process.env.TELECONSULT_TOKEN_TTL_SECONDS;
  const value = raw === undefined || raw === ''
    ? DEFAULT_TOKEN_TTL_SECONDS
    : Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < MIN_TOKEN_TTL_SECONDS || value > MAX_TOKEN_TTL_SECONDS) {
    throw new AppError(
      `TELECONSULT_TOKEN_TTL_SECONDS must be between ${MIN_TOKEN_TTL_SECONDS} and ${MAX_TOKEN_TTL_SECONDS}`,
      503,
      'TELECONSULT_TOKEN_TTL_INVALID',
    );
  }
  return value;
}

function tenantHash(tenantId) {
  return crypto.createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 10);
}

function generateRoomName({ tenantId, teleconsultationId }) {
  const random = crypto.randomBytes(8).toString('base64url');
  return `tc_${tenantHash(tenantId)}_${teleconsultationId}_${random}`;
}

async function loadTeleAppointment({ tenantId, appointmentId }) {
  const id = normalizeId(appointmentId, 'appointment_id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id,
            a.tenant_id::text AS tenant_id,
            a.patient_id,
            a.doctor_id,
            a.appointment_date,
            a.appointment_time,
            a.status,
            a.reason,
            a.department,
            a.visit_type,
            p.uid::text AS patient_uid,
            d.uid::text AS doctor_uid,
            CASE
              WHEN a.appointment_time ~ '^[0-9]{1,2}:[0-9]{2}$'
                THEN (a.appointment_date::date + a.appointment_time::time) AT TIME ZONE $3
              ELSE a.appointment_date::date::timestamptz
            END AS scheduled_start
       FROM appointments a
       LEFT JOIN users p ON p.id = a.patient_id AND p.tenant_id = a.tenant_id
       LEFT JOIN users d ON d.id = a.doctor_id AND d.tenant_id = a.tenant_id
      WHERE a.id = $1::int
        AND a.tenant_id = $2::uuid
      LIMIT 1`,
    id,
    tenantId,
    HOSPITAL_TIME_ZONE,
  );
  if (!rows[0]) throw AppError.notFound('Appointment not found');
  const appointment = rows[0];
  if (String(appointment.visit_type || '').toUpperCase() !== TELE_VISIT_TYPE) {
    throw AppError.badRequest('Appointment is not a teleconsult appointment', 'TELECONSULT_VISIT_TYPE_REQUIRED');
  }
  return appointment;
}

async function hasActiveCareTeamMembership({ tenantId, patientUid, staffUid }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1
       FROM care_team_members ctm
       JOIN care_teams ct
         ON ct.id = ctm.care_team_id
        AND ct.tenant_id = ctm.tenant_id
      WHERE ctm.tenant_id = $1::uuid
        AND ctm.patient_uid = $2::uuid
        AND ctm.staff_uid = $3::uuid
        AND ctm.status = 'active'
        AND ct.status = 'active'
        AND ctm.active_from <= NOW()
        AND (ctm.active_until IS NULL OR ctm.active_until >= NOW())
      LIMIT 1`,
    tenantId,
    patientUid,
    staffUid,
  );
  return Boolean(rows[0]);
}

async function assertParticipantAuthorized({
  tenantId,
  consult,
  appointment,
  participantUid,
  role,
}) {
  const uid = normalizeUuid(participantUid, 'participant_uid', { required: true });
  const patientUid = normalizeUuid(consult.patient_uid || appointment.patient_uid, 'patient_uid', { required: true });
  const doctorUid = consult.doctor_uid || appointment.doctor_uid || null;

  if (role === 'patient') {
    if (uid !== patientUid) {
      throw AppError.forbidden('Patient can only join their own teleconsultation', 'TELECONSULT_PATIENT_SCOPE_DENIED');
    }
    return;
  }

  if (doctorUid && uid === String(doctorUid)) return;
  if (await hasActiveCareTeamMembership({ tenantId, patientUid, staffUid: uid })) return;

  throw AppError.forbidden('Clinician is not assigned or authorized for this teleconsultation', 'TELECONSULT_CLINICIAN_SCOPE_DENIED');
}

function assertPatientAppointmentAccess({ appointment, actorUid, role }) {
  if (actorRole(role) !== 'PATIENT') return;
  const uid = normalizeUuid(actorUid, 'actor_uid', { required: true });
  if (String(appointment.patient_uid || '') !== uid) {
    throw AppError.forbidden('Teleconsult appointment not found for this patient', 'TELECONSULT_PATIENT_SCOPE_DENIED');
  }
}

export async function ensureTeleconsultationForAppointment({
  tenantId = null,
  appointmentId,
  actorUid = null,
  role = null,
} = {}) {
  requireLivekitEnabled();
  const tid = requireTenantId(tenantId);
  const appointment = await loadTeleAppointment({ tenantId: tid, appointmentId });
  assertPatientAppointmentAccess({ appointment, actorUid, role });

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, appointment_id, patient_uid, doctor_uid,
            consult_type, status, scheduled_start, scheduled_end, actual_start, actual_end,
            chief_complaint, pre_consult_form,
            remote_consent_id, remote_consent_signed_at,
            ai_note_generation_id, ai_pre_visit_summary_id,
            recording_url, recording_consent, cancellation_reason,
            metadata, created_by, created_at, updated_at
       FROM teleconsultations
      WHERE tenant_id = $1::uuid
        AND appointment_id = $2::int
      ORDER BY created_at ASC
      LIMIT 1`,
    tid,
    appointment.id,
  );
  if (existing[0]) return existing[0];

  return createTeleconsultation({
    tenantId: tid,
    appointmentId: appointment.id,
    patientUid: appointment.patient_uid,
    doctorUid: appointment.doctor_uid,
    consultType: 'video',
    scheduledStart: appointment.scheduled_start,
    chiefComplaint: appointment.reason,
    recordingConsent: false,
    metadata: {
      source: 'nl3_p1_teleconsult_provisioning',
      appointment_id: appointment.id,
      visit_type: TELE_VISIT_TYPE,
      queue_model: 'doctor_department_badge',
    },
    createdBy: actorUid,
  });
}

export async function ensureVideoSession({
  tenantId = null,
  teleconsultationId,
} = {}) {
  requireLivekitEnabled();
  const tid = requireTenantId(tenantId);
  const consult = await getTeleconsultation({ tenantId: tid, id: teleconsultationId });
  const existing = await listVideoSessions({
    tenantId: tid,
    teleconsultationId: consult.id,
    limit: 50,
  });
  const livekitSession = existing.video_sessions.find((session) =>
    session.provider === LIVEKIT_PROVIDER && !['cancelled', 'failed'].includes(session.status),
  );
  if (livekitSession) return livekitSession;

  return createVideoSession({
    tenantId: tid,
    teleconsultationId: consult.id,
    provider: LIVEKIT_PROVIDER,
    externalSessionId: generateRoomName({ tenantId: tid, teleconsultationId: consult.id }),
    recordingStatus: 'disabled',
    metadata: {
      source: 'nl3_p1_teleconsult_provisioning',
      recording: 'off_for_mvp',
      turn: 'livekit_embedded_first',
      media_boundary: 'hospital_infra_only',
    },
  });
}

export async function recordTeleconsultConsent({
  tenantId = null,
  teleconsultationId,
  participantUid,
  actorUid = null,
  actorRole: role = null,
  consentPayload = null,
  ipAddress = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const consult = await getTeleconsultation({ tenantId: tid, id: teleconsultationId });
  const patientUid = normalizeUuid(consult.patient_uid, 'teleconsultation patient_uid', { required: true });
  const signerUid = normalizeUuid(participantUid, 'participant_uid', { required: true });
  if (signerUid !== patientUid) {
    throw AppError.forbidden('Only the teleconsult patient can record remote consent', 'TELECONSULT_CONSENT_PATIENT_REQUIRED');
  }
  if (consult.remote_consent_id && consult.remote_consent_signed_at) {
    return consult;
  }

  const payload = normalizeJsonObject(consentPayload, 'consent_payload');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_consents
       (tenant_id, patient_uid, consent_type, granted, status, granted_at, granted_by,
        ip_address, notes, purpose, data_categories, source, consent_method,
        created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'telehealth', true, 'active', NOW(), $3,
             $4, $5, $6, $7::jsonb, 'teleconsult', $8,
             NOW(), NOW())
     RETURNING id, patient_uid, consent_type, granted_at`,
    tid,
    patientUid,
    safeText(role || actorRole(role) || 'patient', 100),
    safeText(ipAddress, 45),
    safeText(payload.notes || payload.statement || 'Teleconsult video/audio consent recorded'),
    safeText(payload.purpose || 'Remote video/audio consultation'),
    JSON.stringify(payload.data_categories || [
      'teleconsult_video_audio',
      'teleconsult_lobby_state',
      'teleconsult_connection_metadata',
    ]),
    safeText(payload.consent_method || 'signature', 20),
  );
  const consent = rows[0];
  return recordRemoteConsent({
    tenantId: tid,
    id: consult.id,
    consentId: `patient_consent:${consent.id}`,
    signedAt: consent.granted_at,
  });
}

export async function getTeleconsultRoomState({
  tenantId = null,
  teleconsultationId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const consult = await getTeleconsultation({ tenantId: tid, id: teleconsultationId });
  const sessions = await listVideoSessions({
    tenantId: tid,
    teleconsultationId: consult.id,
    limit: 10,
  });
  const livekitSession = sessions.video_sessions.find((session) => session.provider === LIVEKIT_PROVIDER) || null;
  return {
    ...getTeleconsultFeatureState(),
    teleconsultation_id: consult.id,
    appointment_id: consult.appointment_id,
    status: consult.status,
    consent_recorded: Boolean(consult.remote_consent_id && consult.remote_consent_signed_at),
    video_session: livekitSession,
  };
}

export function assertTeleconsultCanIssueToken({ consult, appointment } = {}) {
  if (!['scheduled', 'waiting', 'in_progress'].includes(String(consult?.status || ''))) {
    throw AppError.forbidden('Teleconsultation is not joinable', 'TELECONSULT_STATUS_NOT_JOINABLE');
  }
  const appointmentStatus = String(appointment?.status || '').toUpperCase();
  if (TERMINAL_APPOINTMENT_STATUSES.has(appointmentStatus)) {
    throw AppError.forbidden('Appointment is no longer joinable', 'TELECONSULT_APPOINTMENT_TERMINAL');
  }
  if (!consult?.remote_consent_id || !consult?.remote_consent_signed_at) {
    throw AppError.forbidden('Teleconsult consent must be recorded before joining', 'TELECONSULT_CONSENT_REQUIRED');
  }
}

export function buildLivekitVideoGrant({ role, roomName }) {
  const base = {
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
  };
  if (role === 'observer') {
    return {
      ...base,
      canPublish: false,
      canPublishData: false,
    };
  }
  if (role === 'clinician') {
    return {
      ...base,
      canPublish: true,
      canPublishData: true,
      canPublishSources: ['camera', 'microphone', 'screen_share'],
      canUpdateOwnMetadata: true,
      roomAdmin: true,
    };
  }
  return {
    ...base,
    canPublish: true,
    canPublishData: true,
    canPublishSources: ['camera', 'microphone'],
    canUpdateOwnMetadata: true,
  };
}

export function buildParticipantMetadata({ tenantId, teleconsultationId, appointmentId, role }) {
  return {
    tenant_id: String(tenantId),
    teleconsultation_id: Number(teleconsultationId),
    appointment_id: Number(appointmentId),
    role,
  };
}

export function signLivekitToken({
  apiKey,
  apiSecret,
  roomName,
  identity,
  role,
  metadata,
  ttlSeconds,
}) {
  const video = buildLivekitVideoGrant({ role, roomName });
  const payload = {
    video,
    metadata: JSON.stringify(metadata),
  };
  return jwt.sign(payload, apiSecret, {
    algorithm: 'HS256',
    issuer: apiKey,
    subject: identity,
    expiresIn: ttlSeconds,
  });
}

export async function issueJoinToken({
  tenantId = null,
  teleconsultationId,
  participantUid,
  role,
} = {}) {
  const tid = requireTenantId(tenantId);
  const normalizedRole = normalizeParticipantRole(role);
  const uid = normalizeUuid(participantUid, 'participant_uid', { required: true });
  const config = livekitConfig();
  const ttlSeconds = tokenTtlSeconds();

  const consult = await getTeleconsultation({ tenantId: tid, id: teleconsultationId });
  if (!consult.appointment_id) {
    throw AppError.badRequest('Teleconsultation must be appointment-bound', 'TELECONSULT_APPOINTMENT_REQUIRED');
  }
  const appointment = await loadTeleAppointment({
    tenantId: tid,
    appointmentId: consult.appointment_id,
  });
  assertTeleconsultCanIssueToken({ consult, appointment });
  await assertParticipantAuthorized({
    tenantId: tid,
    consult,
    appointment,
    participantUid: uid,
    role: normalizedRole,
  });

  const videoSession = await ensureVideoSession({
    tenantId: tid,
    teleconsultationId: consult.id,
  });
  const roomName = videoSession.external_session_id;
  if (!roomName) throw AppError.internal('LiveKit room name missing', 'LIVEKIT_ROOM_MISSING');

  const identity = `${normalizedRole}:${uid}`;
  const metadata = buildParticipantMetadata({
    tenantId: tid,
    teleconsultationId: consult.id,
    appointmentId: consult.appointment_id,
    role: normalizedRole,
  });
  const participantToken = signLivekitToken({
    ...config,
    roomName,
    identity,
    role: normalizedRole,
    metadata,
    ttlSeconds,
  });
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  return {
    server_url: config.serverUrl,
    room_name: roomName,
    participant_token: participantToken,
    expires_at: expiresAt,
  };
}

export const __testing__ = {
  DEFAULT_TOKEN_TTL_SECONDS,
  HOSPITAL_TIME_ZONE,
  LIVEKIT_PROVIDER,
  MAX_TOKEN_TTL_SECONDS,
  MIN_TOKEN_TTL_SECONDS,
  TELE_VISIT_TYPE,
  TERMINAL_APPOINTMENT_STATUSES,
  buildLivekitVideoGrant,
  buildParticipantMetadata,
  generateRoomName,
  livekitConfig,
  loadTeleAppointment,
  normalizeParticipantRole,
  signLivekitToken,
  tokenTtlSeconds,
};

export default {
  ensureTeleconsultationForAppointment,
  ensureVideoSession,
  recordTeleconsultConsent,
  getTeleconsultRoomState,
  issueJoinToken,
};
