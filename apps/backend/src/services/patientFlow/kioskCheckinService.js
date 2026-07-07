import crypto from 'node:crypto';

import { setTenant, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { ensureAppointmentQueueForAppointment } from '../appointment/appointmentQueueService.js';
import { findRegistrationDuplicateCandidates } from '../patient/patientDedupeService.js';
import { AppError } from '../../utils/AppError.js';
import { emitAppointmentEvent, emitQueuePosition } from '../../utils/websocket/realtimeEmitter.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_APPOINTMENT_STATUSES = new Set(['CANCELLED', 'NO_SHOW', 'COMPLETED', 'RESCHEDULED']);
export const DEFAULT_SAFE_PROFILE_FIELDS = Object.freeze([
  'address',
  'email',
  'preferred_language',
  'emergency_contact',
]);

function cleanText(value, max = 255) {
  const text = value == null ? '' : String(value).trim();
  return text ? text.slice(0, max) : '';
}

function maybeUuid(value) {
  const text = cleanText(value, 80);
  return UUID_RE.test(text) ? text.toLowerCase() : null;
}

function intId(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function departmentKey(value) {
  const text = cleanText(value || 'default', 160).toLowerCase();
  const key = text
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return key || 'default';
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const text = cleanText(value, 20).toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(text)) return false;
  return false;
}

function jsonString(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hmac(input) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw AppError.internal('JWT secret is not configured', 'JWT_SECRET_REQUIRED');
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

function signedSessionToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function parseSignedSessionToken(token) {
  const [body, signature] = cleanText(token, 4000).split('.');
  if (!body || !signature || hmac(body) !== signature) {
    throw AppError.unauthorized('Invalid kiosk session token', 'KIOSK_SESSION_INVALID');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw AppError.unauthorized('Invalid kiosk session token', 'KIOSK_SESSION_INVALID');
  }
  if (!maybeUuid(payload?.jti) || !maybeUuid(payload?.tenantId) || !payload?.exp) {
    throw AppError.unauthorized('Invalid kiosk session token', 'KIOSK_SESSION_INVALID');
  }
  if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) {
    throw AppError.unauthorized('Kiosk session has expired', 'KIOSK_SESSION_EXPIRED');
  }
  return {
    jti: maybeUuid(payload.jti),
    tenantId: maybeUuid(payload.tenantId),
    departmentKey: departmentKey(payload.departmentKey),
    channel: cleanText(payload.channel, 30) || 'kiosk_self',
  };
}

export function normalizeAppointmentLookup(body = {}) {
  const directId = intId(body.appointmentId ?? body.appointment_id);
  const directUid = maybeUuid(body.appointmentUid ?? body.appointment_uid);
  const qrPayload = cleanText(body.qrPayload ?? body.qr_payload ?? body.qrCode ?? body.qr_code, 600);

  if (directId || directUid) return { appointmentId: directId, appointmentUid: directUid };
  if (!qrPayload) return { appointmentId: null, appointmentUid: null };

  const asUuid = maybeUuid(qrPayload);
  if (asUuid) return { appointmentId: null, appointmentUid: asUuid };

  const prefixed = qrPayload.match(/(?:appointment_uid|appointmentUid|uid)[:=]([0-9a-f-]{36})/i);
  if (prefixed) return { appointmentId: null, appointmentUid: maybeUuid(prefixed[1]) };

  try {
    const decoded = JSON.parse(Buffer.from(qrPayload, 'base64url').toString('utf8'));
    return {
      appointmentId: intId(decoded.appointmentId ?? decoded.appointment_id),
      appointmentUid: maybeUuid(decoded.appointmentUid ?? decoded.appointment_uid ?? decoded.uid),
    };
  } catch {
    return { appointmentId: null, appointmentUid: null };
  }
}

export function normalizeProfileDelta(rawDelta = {}, safeFields = DEFAULT_SAFE_PROFILE_FIELDS) {
  const allowed = new Set((safeFields || DEFAULT_SAFE_PROFILE_FIELDS).filter((field) => DEFAULT_SAFE_PROFILE_FIELDS.includes(field)));
  const accepted = {};
  const blocked = [];
  const input = rawDelta && typeof rawDelta === 'object' ? rawDelta : {};

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey || '').trim();
    if (!allowed.has(key)) {
      blocked.push(key);
      continue;
    }
    if (key === 'address') {
      const value = cleanText(rawValue, 500);
      if (value) accepted.address = value;
    } else if (key === 'email') {
      const value = cleanText(rawValue, 255).toLowerCase();
      if (value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) accepted.email = value;
    } else if (key === 'preferred_language') {
      const value = cleanText(rawValue, 5).toLowerCase();
      if (/^[a-z]{2,5}$/.test(value)) accepted.preferred_language = value;
    } else if (key === 'emergency_contact' && rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      accepted.emergency_contact = rawValue;
    }
  }

  return {
    accepted,
    blocked: [...new Set(blocked.filter(Boolean))],
    acceptedFields: Object.keys(accepted),
  };
}

function checkinSummary({ delta, duplicateCount, sameDayDuplicateCount }) {
  return {
    accepted_fields: delta.acceptedFields,
    blocked_fields: delta.blocked,
    duplicate_candidate_count: duplicateCount,
    same_day_duplicate_count: sameDayDuplicateCount,
  };
}

function publicSetting(row) {
  const exact = row?.department_key != null;
  return {
    tenant_id: row?.tenant_id ?? null,
    department_key: row?.department_key ?? 'default',
    department_name: row?.department_name ?? null,
    self_service_enabled: row?.self_service_enabled === true,
    supervised_mode_enabled: row?.supervised_mode_enabled === true,
    qr_otp_required: row?.qr_otp_required !== false,
    safe_profile_fields: Array.isArray(row?.safe_profile_fields)
      ? row.safe_profile_fields
      : [...DEFAULT_SAFE_PROFILE_FIELDS],
    enabled_at: row?.enabled_at ?? null,
    exact,
    enabled: row?.self_service_enabled === true || row?.supervised_mode_enabled === true,
  };
}

async function queryKioskSetting(db, tenantId, key) {
  return db.$queryRawUnsafe(
    `SELECT tenant_id, department_key, department_name, self_service_enabled,
            supervised_mode_enabled, qr_otp_required, safe_profile_fields,
            enabled_at, metadata
       FROM patient_flow_kiosk_settings
      WHERE tenant_id = $1::uuid
        AND department_key IN ($2, 'default')
      ORDER BY CASE WHEN department_key = $2 THEN 0 ELSE 1 END
      LIMIT 1`,
    tenantId,
    key,
  );
}

export async function getKioskSetting(tenantId, rawDepartmentKey, db = null) {
  const key = departmentKey(rawDepartmentKey);
  const rows = db
    ? await queryKioskSetting(db, tenantId, key)
    : await setTenant(tenantId, (tx) => queryKioskSetting(tx, tenantId, key));
  return publicSetting(rows[0]);
}

export async function listKioskSettings({ tenantId }) {
  const rows = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
    `SELECT tenant_id, department_key, department_name, self_service_enabled,
            supervised_mode_enabled, qr_otp_required, safe_profile_fields,
            enabled_at, enabled_by, updated_by, metadata, created_at, updated_at
       FROM patient_flow_kiosk_settings
      WHERE tenant_id = $1::uuid
      ORDER BY department_key ASC`,
    tenantId,
  ));
  return rows.map(publicSetting);
}

export async function upsertKioskSetting({
  tenantId,
  department,
  selfServiceEnabled = false,
  supervisedModeEnabled = false,
  qrOtpRequired = true,
  safeProfileFields = DEFAULT_SAFE_PROFILE_FIELDS,
  actorUid = null,
  metadata = {},
}) {
  const key = departmentKey(department);
  const safeFields = (safeProfileFields || DEFAULT_SAFE_PROFILE_FIELDS)
    .filter((field) => DEFAULT_SAFE_PROFILE_FIELDS.includes(field));
  const selfEnabled = normalizeBoolean(selfServiceEnabled);
  const supervisedEnabled = normalizeBoolean(supervisedModeEnabled);
  const rows = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO patient_flow_kiosk_settings (
       tenant_id, department_key, department_name, self_service_enabled,
       supervised_mode_enabled, qr_otp_required, safe_profile_fields,
       enabled_at, enabled_by, updated_by, metadata, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2, $3, $4::boolean, $5::boolean, $6::boolean, $7::text[],
       CASE WHEN $4::boolean OR $5::boolean THEN NOW() ELSE NULL END,
       CASE WHEN $4::boolean OR $5::boolean THEN $8::uuid ELSE NULL END,
       $8::uuid, $9::jsonb, NOW(), NOW()
     )
     ON CONFLICT (tenant_id, department_key) DO UPDATE SET
       department_name = EXCLUDED.department_name,
       self_service_enabled = EXCLUDED.self_service_enabled,
       supervised_mode_enabled = EXCLUDED.supervised_mode_enabled,
       qr_otp_required = EXCLUDED.qr_otp_required,
       safe_profile_fields = EXCLUDED.safe_profile_fields,
       enabled_at = CASE
         WHEN EXCLUDED.self_service_enabled OR EXCLUDED.supervised_mode_enabled
         THEN COALESCE(patient_flow_kiosk_settings.enabled_at, NOW())
         ELSE NULL
       END,
       enabled_by = CASE
         WHEN EXCLUDED.self_service_enabled OR EXCLUDED.supervised_mode_enabled
         THEN COALESCE(patient_flow_kiosk_settings.enabled_by, EXCLUDED.enabled_by)
         ELSE NULL
       END,
       updated_by = EXCLUDED.updated_by,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING tenant_id, department_key, department_name, self_service_enabled,
               supervised_mode_enabled, qr_otp_required, safe_profile_fields,
               enabled_at, metadata`,
    tenantId,
    key,
    cleanText(department, 160) || key,
    selfEnabled,
    supervisedEnabled,
    normalizeBoolean(qrOtpRequired),
    safeFields.length ? safeFields : [...DEFAULT_SAFE_PROFILE_FIELDS],
    maybeUuid(actorUid),
    jsonString(metadata, {}),
  ));
  return publicSetting(rows[0]);
}

export async function createKioskSession({
  tenantId,
  department,
  channel = 'kiosk_self',
  deviceLabel = null,
  ttlMinutes = 30,
  actorUid = null,
  metadata = {},
}) {
  const key = departmentKey(department);
  const normalizedChannel = cleanText(channel, 30) === 'kiosk_supervised' ? 'kiosk_supervised' : 'kiosk_self';
  const setting = await getKioskSetting(tenantId, key);
  if (normalizedChannel === 'kiosk_self' && !setting.self_service_enabled) {
    throw AppError.forbidden('Kiosk self-service is not enabled for this department', 'KIOSK_SELF_SERVICE_DISABLED');
  }
  if (normalizedChannel === 'kiosk_supervised' && !setting.supervised_mode_enabled) {
    throw AppError.forbidden('Supervised kiosk mode is not enabled for this department', 'KIOSK_SUPERVISED_DISABLED');
  }

  const jti = crypto.randomUUID();
  const safeTtl = Math.min(Math.max(intId(ttlMinutes) ?? 30, 5), 120);
  const expiresAt = new Date(Date.now() + safeTtl * 60_000);
  const payload = {
    jti,
    tenantId,
    departmentKey: key,
    channel: normalizedChannel,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const token = signedSessionToken(payload);
  const rows = await setTenant(tenantId, (tx) => tx.$queryRawUnsafe(
    `INSERT INTO patient_flow_kiosk_sessions (
       tenant_id, session_jti, token_hash, department_key, channel,
       device_label, status, expires_at, created_by, metadata, created_at, updated_at
     )
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'active', $7::timestamptz, $8::uuid, $9::jsonb, NOW(), NOW())
     RETURNING id, tenant_id, session_jti, department_key, channel, device_label,
               status, expires_at, created_at`,
    tenantId,
    jti,
    tokenHash(token),
    key,
    normalizedChannel,
    cleanText(deviceLabel, 160) || null,
    expiresAt.toISOString(),
    maybeUuid(actorUid),
    jsonString(metadata, {}),
  ));

  return {
    session: rows[0],
    token,
  };
}

async function validateKioskSession({ tenantId, token, expectedDepartmentKey, expectedChannel, db }) {
  const payload = parseSignedSessionToken(token);
  if (payload.tenantId !== tenantId) {
    throw AppError.forbidden('Kiosk session belongs to another tenant', 'KIOSK_SESSION_TENANT_MISMATCH');
  }
  if (payload.departmentKey !== expectedDepartmentKey) {
    throw AppError.forbidden('Kiosk session is not scoped to this department', 'KIOSK_SESSION_DEPARTMENT_MISMATCH');
  }
  if (expectedChannel && payload.channel !== expectedChannel) {
    throw AppError.forbidden('Kiosk session channel mismatch', 'KIOSK_SESSION_CHANNEL_MISMATCH');
  }
  const rows = await db.$queryRawUnsafe(
    `UPDATE patient_flow_kiosk_sessions
        SET last_seen_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND session_jti = $2::uuid
        AND token_hash = $3
        AND status = 'active'
        AND expires_at > NOW()
      RETURNING id, department_key, channel, expires_at`,
    tenantId,
    payload.jti,
    tokenHash(token),
  );
  if (!rows[0]) {
    throw AppError.unauthorized('Kiosk session has expired or was revoked', 'KIOSK_SESSION_INACTIVE');
  }
  return rows[0];
}

async function loadAppointmentForCheckin(db, {
  tenantId,
  appointmentId,
  appointmentUid,
  patientUid = null,
}) {
  const where = ['a.tenant_id = $1::uuid'];
  const params = [tenantId];
  let idx = 2;
  if (appointmentId) {
    where.push(`a.id = $${idx}::int`);
    params.push(appointmentId);
    idx += 1;
  }
  if (appointmentUid) {
    where.push(`a.uid = $${idx}::uuid`);
    params.push(appointmentUid);
    idx += 1;
  }
  if (!appointmentId && !appointmentUid) {
    throw AppError.badRequest('Appointment QR or ID is required', 'APPOINTMENT_LOOKUP_REQUIRED');
  }
  if (patientUid) {
    where.push(`u.uid = $${idx}::uuid`);
    params.push(patientUid);
    idx += 1;
  }

  const rows = await db.$queryRawUnsafe(
    `SELECT
        a.id, a.uid, a.tenant_id, a.patient_id, a.doctor_id, a.doctor_name,
        a.patient_name, a.phone, a.appointment_date, a.appointment_time,
        a.status, a.token_number, a.visit_no, a.department, a.visit_type,
        a.queue_id, u.uid AS patient_uid, u.name AS profile_name,
        u.phone AS profile_phone, u.birthday, u.gender, u.address, u.email,
        u.preferred_language, u.abha_address
       FROM appointments a
       LEFT JOIN users u ON u.id = a.patient_id
      WHERE ${where.join(' AND ')}
      LIMIT 1
      FOR UPDATE OF a`,
    ...params,
  );
  if (!rows[0]) {
    throw AppError.notFound('Appointment not found for this patient and tenant', 'APPOINTMENT_NOT_FOUND');
  }
  if (!rows[0].patient_uid) {
    throw AppError.badRequest('Appointment is not linked to a patient identity', 'APPOINTMENT_PATIENT_REQUIRED');
  }
  const status = cleanText(rows[0].status, 50).toUpperCase();
  if (TERMINAL_APPOINTMENT_STATUSES.has(status)) {
    throw AppError.conflict('Appointment cannot be checked in from its current status', 'APPOINTMENT_NOT_CHECKIN_ELIGIBLE', { status });
  }
  return rows[0];
}

async function existingCheckedIn(db, tenantId, appointmentId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, status, checkin_channel, identity_method, token_number, visit_no,
            queue_id, checked_in_at, duplicate_candidate_count,
            profile_delta_summary, created_at
       FROM patient_flow_checkins
      WHERE tenant_id = $1::uuid
        AND appointment_id = $2::int
        AND status = 'checked_in'
      ORDER BY checked_in_at DESC, id DESC
      LIMIT 1`,
    tenantId,
    appointmentId,
  );
  return rows[0] ?? null;
}

async function countSameDayDuplicates(db, appointment) {
  if (!appointment?.patient_id || !appointment?.appointment_date) return 0;
  const rows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM appointments
      WHERE tenant_id = $1::uuid
        AND patient_id = $2::int
        AND appointment_date = $3::date
        AND id <> $4::int
        AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')`,
    appointment.tenant_id,
    appointment.patient_id,
    appointment.appointment_date,
    appointment.id,
  );
  return Number(rows[0]?.count || 0);
}

async function duplicateCandidateCount(appointment) {
  const result = await findRegistrationDuplicateCandidates({
    tenantId: appointment.tenant_id,
    name: appointment.profile_name ?? appointment.patient_name,
    phone: appointment.profile_phone ?? appointment.phone,
    birthday: appointment.birthday,
    abhaAddress: appointment.abha_address,
    limit: 6,
  });
  return (result.candidates || []).filter((candidate) => String(candidate.uid) !== String(appointment.patient_uid)).length;
}

async function applyProfileDelta(db, { tenantId, patientUid, delta }) {
  const updates = [];
  const params = [tenantId, patientUid];
  let idx = 3;
  if (Object.hasOwn(delta.accepted, 'address')) {
    updates.push(`address = $${idx}`);
    params.push(delta.accepted.address);
    idx += 1;
  }
  if (Object.hasOwn(delta.accepted, 'email')) {
    updates.push(`email = $${idx}`);
    params.push(delta.accepted.email);
    idx += 1;
  }
  if (Object.hasOwn(delta.accepted, 'preferred_language')) {
    updates.push(`preferred_language = $${idx}`);
    params.push(delta.accepted.preferred_language);
    idx += 1;
  }
  if (Object.hasOwn(delta.accepted, 'emergency_contact')) {
    updates.push(`emergency_contact = $${idx}::jsonb`);
    params.push(jsonString(delta.accepted.emergency_contact, {}));
    idx += 1;
  }
  if (updates.length === 0) return 0;
  const rows = await db.$queryRawUnsafe(
    `UPDATE users
        SET ${updates.join(', ')},
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
      RETURNING uid`,
    ...params,
  );
  return rows.length;
}

async function queueSnapshot(db, tenantId, appointment, queue) {
  const rows = await db.$queryRawUnsafe(
    `WITH target AS (
       SELECT id, queue_id, token_number, appointment_date, doctor_id
         FROM appointments
        WHERE tenant_id = $1::uuid AND id = $2::int
     ),
     ordered AS (
       SELECT a.id,
              ROW_NUMBER() OVER (
                ORDER BY
                  NULLIF(regexp_replace(COALESCE(a.token_number, ''), '\\D', '', 'g'), '')::int NULLS LAST,
                  a.appointment_time ASC,
                  a.id ASC
              )::int AS position
         FROM appointments a, target t
        WHERE a.tenant_id = $1::uuid
          AND COALESCE(a.queue_id, 0) = COALESCE(t.queue_id, 0)
          AND a.appointment_date = t.appointment_date
          AND a.status IN ('SCHEDULED', 'CONFIRMED', 'IN_PROGRESS')
     )
     SELECT position FROM ordered WHERE id = $2::int`,
    tenantId,
    appointment.id,
  );
  const position = Number(rows[0]?.position || 1);
  return {
    queue_id: queue?.queue_id ?? queue?.id ?? appointment.queue_id ?? null,
    queue_label: queue?.queue_label ?? null,
    queue_kind: queue?.queue_kind ?? null,
    token_number: appointment.token_number ?? null,
    visit_no: appointment.visit_no ?? null,
    queue_position: position,
    patients_ahead: Math.max(position - 1, 0),
  };
}

function appointmentResponse(appointment) {
  return {
    id: appointment.id,
    uid: appointment.uid,
    patient_id: appointment.patient_id,
    status: appointment.status,
    appointment_date: appointment.appointment_date,
    appointment_time: appointment.appointment_time,
    department: appointment.department,
    doctor_id: appointment.doctor_id,
    doctor_name: appointment.doctor_name,
    visit_type: appointment.visit_type,
  };
}

function checkinResponse({ appointment, checkin, queue, frontDeskRequired = false, idempotent = false }) {
  return {
    checkin: {
      id: checkin?.id ?? null,
      status: checkin?.status ?? (frontDeskRequired ? 'front_desk_required' : 'checked_in'),
      channel: checkin?.checkin_channel ?? null,
      identity_method: checkin?.identity_method ?? null,
      checked_in_at: checkin?.checked_in_at ?? null,
      duplicate_candidate_count: checkin?.duplicate_candidate_count ?? 0,
      profile_delta_summary: checkin?.profile_delta_summary ?? {},
      front_desk_required: frontDeskRequired,
      idempotent,
    },
    appointment: appointmentResponse(appointment),
    queue,
  };
}

async function recordCheckin(db, {
  tenantId,
  appointment,
  queue,
  kioskSessionId = null,
  channel,
  identityMethod,
  status,
  actorUid,
  profileSummary,
  duplicateCount,
  acknowledgements,
  consentRefs,
  metadata,
}) {
  const checkedInAtSql = status === 'checked_in' ? 'NOW()' : 'NULL';
  const rows = await db.$queryRawUnsafe(
    `INSERT INTO patient_flow_checkins (
       tenant_id, appointment_id, patient_uid, queue_id, kiosk_session_id,
       checkin_channel, identity_method, status, token_number, visit_no,
       profile_delta_summary, duplicate_candidate_count, acknowledgement_refs,
       consent_refs, checked_in_at, checked_in_by, created_by, updated_by,
       metadata, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2::int, $3::uuid, $4::int, $5::bigint,
       $6, $7, $8, $9, $10,
       $11::jsonb, $12::int, $13::jsonb,
       $14::jsonb, ${checkedInAtSql}, $15::uuid, $15::uuid, $15::uuid,
       $16::jsonb, NOW(), NOW()
     )
     RETURNING id, status, checkin_channel, identity_method, token_number, visit_no,
               queue_id, checked_in_at, duplicate_candidate_count,
               profile_delta_summary, created_at`,
    tenantId,
    appointment.id,
    appointment.patient_uid,
    queue?.queue_id ?? queue?.id ?? appointment.queue_id ?? null,
    kioskSessionId,
    channel,
    identityMethod,
    status,
    appointment.token_number ?? null,
    appointment.visit_no ?? null,
    jsonString(profileSummary, {}),
    duplicateCount,
    jsonString(acknowledgements, []),
    jsonString(consentRefs, []),
    maybeUuid(actorUid),
    jsonString(metadata, {}),
  );
  return rows[0];
}

async function performCheckin({
  tenantId,
  actorUid,
  patientUid = null,
  body = {},
  channel,
  identityMethod,
  requireKioskSession = false,
}) {
  if (!maybeUuid(tenantId)) {
    throw AppError.forbidden('Tenant context is required', 'TENANT_CONTEXT_REQUIRED');
  }
  const lookup = normalizeAppointmentLookup(body);
  if (!lookup.appointmentId && !lookup.appointmentUid) {
    throw AppError.badRequest('Appointment QR or ID is required; raw phone or DOB cannot check in a patient', 'APPOINTMENT_LOOKUP_REQUIRED');
  }

  const result = await setTenantTx(tenantId, async (tx) => {
    const appointment = await loadAppointmentForCheckin(tx, {
      tenantId,
      appointmentId: lookup.appointmentId,
      appointmentUid: lookup.appointmentUid,
      patientUid,
    });
    const key = departmentKey(appointment.department);
    const setting = await getKioskSetting(tenantId, key, tx);
    if (channel === 'kiosk_self' && !setting.self_service_enabled) {
      throw AppError.forbidden('Kiosk self-service is not enabled for this department', 'KIOSK_SELF_SERVICE_DISABLED');
    }
    if (channel === 'kiosk_supervised' && !setting.supervised_mode_enabled) {
      throw AppError.forbidden('Supervised kiosk mode is not enabled for this department', 'KIOSK_SUPERVISED_DISABLED');
    }

    let kioskSession = null;
    if (requireKioskSession) {
      kioskSession = await validateKioskSession({
        tenantId,
        token: body.kioskSessionToken ?? body.kiosk_session_token,
        expectedDepartmentKey: key,
        expectedChannel: 'kiosk_self',
        db: tx,
      });
    }

    const existing = await existingCheckedIn(tx, tenantId, appointment.id);
    const queue = await ensureAppointmentQueueForAppointment(tx, appointment, {
      actorUid,
      source: channel,
    });
    const queueInfo = await queueSnapshot(tx, tenantId, {
      ...appointment,
      queue_id: queue?.queue_id ?? queue?.id ?? appointment.queue_id,
    }, queue);
    if (existing) {
      return checkinResponse({
        appointment,
        checkin: existing,
        queue: queueInfo,
        idempotent: true,
      });
    }

    const delta = normalizeProfileDelta(body.profileDelta ?? body.profile_delta, setting.safe_profile_fields);
    const duplicateCount = await duplicateCandidateCount(appointment);
    const sameDayDuplicateCount = await countSameDayDuplicates(tx, appointment);
    const profileSummary = checkinSummary({ delta, duplicateCount, sameDayDuplicateCount });

    if (delta.blocked.length > 0 || duplicateCount > 0) {
      const checkin = await recordCheckin(tx, {
        tenantId,
        appointment,
        queue,
        kioskSessionId: kioskSession?.id ?? null,
        channel,
        identityMethod,
        status: 'front_desk_required',
        actorUid,
        profileSummary,
        duplicateCount,
        acknowledgements: body.acknowledgements ?? body.acknowledgementRefs ?? [],
        consentRefs: body.consentRefs ?? body.consent_refs ?? [],
        metadata: {
          reason: duplicateCount > 0 ? 'duplicate_candidate' : 'blocked_profile_fields',
          blocked_profile_fields: delta.blocked,
          same_day_duplicate_count: sameDayDuplicateCount,
        },
      });
      return checkinResponse({
        appointment,
        checkin,
        queue: queueInfo,
        frontDeskRequired: true,
      });
    }

    await applyProfileDelta(tx, { tenantId, patientUid: appointment.patient_uid, delta });
    const checkin = await recordCheckin(tx, {
      tenantId,
      appointment,
      queue,
      kioskSessionId: kioskSession?.id ?? null,
      channel,
      identityMethod,
      status: 'checked_in',
      actorUid,
      profileSummary,
      duplicateCount,
      acknowledgements: body.acknowledgements ?? body.acknowledgementRefs ?? [],
      consentRefs: body.consentRefs ?? body.consent_refs ?? [],
      metadata: {
        same_day_duplicate_count: sameDayDuplicateCount,
      },
    });
    return checkinResponse({ appointment, checkin, queue: queueInfo });
  });

  if (result.checkin.status === 'checked_in' && !result.checkin.idempotent) {
    try {
      emitAppointmentEvent('patient-flow-checkin', { tenantId });
      emitQueuePosition({
        patientId: result.appointment?.patient_id,
        appointmentId: result.appointment?.id,
        position: result.queue?.queue_position,
        etaMinutes: null,
      });
    } catch (err) {
      logger.warn('patient-flow check-in realtime emit failed', { error: err.message });
    }
  }

  return result;
}

export async function patientKioskCheckin({ tenantId, patientUid, body, actorUid }) {
  return performCheckin({
    tenantId,
    actorUid,
    patientUid,
    body,
    channel: 'kiosk_self',
    identityMethod: 'qr_plus_otp',
    requireKioskSession: true,
  });
}

export async function supervisedKioskCheckin({ tenantId, body, actorUid }) {
  return performCheckin({
    tenantId,
    actorUid,
    patientUid: null,
    body,
    channel: 'kiosk_supervised',
    identityMethod: 'staff_supervised',
    requireKioskSession: false,
  });
}
