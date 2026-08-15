// src/utils/websocket/realtimeEmitter.js
//
// Domain-level helpers that wrap the raw broadcast()/sendToUser() primitives
// with the channel naming convention from channelAuth.js. Controllers/services
// should import from here, not from wsServer directly.

import { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { ALL_STAFF_ROLES, ROLES } from '../roleHelpers.js';
import { sendPushNotification } from '../notifications/sendPushNotification.js';
import { createCodeBlueNotificationReference } from '../notifications/codeBlueNotificationReference.js';
import { broadcast, sendToUser } from './wsServer.js';

/** Vital-sign anomaly detected (WARNING or CRITICAL). */
export function emitVitalAnomaly(alert) {
  try {
    broadcast('staff:clinical-alerts', {
      kind: 'vital-anomaly',
      patientId: String(alert.patient_id),
      vitalName: alert.vital_name,
      value: alert.value,
      unit: alert.unit,
      severity: alert.severity,
      message: alert.message,
      at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('emitVitalAnomaly failed:', err.message);
  }
}

/**
 * Code Blue — cardiac arrest / rapid-response push.
 *
 * NOTIFICATION-ONLY and at-most-once (NL-14 P2): when a durable
 * resuscitation_events row exists, `eventId` carries its id so clients can
 * deep-link, but WS delivery is never the source of truth — dashboards
 * hydrate persisted events via GET /api/v1/resuscitation/events/recent.
 */
const CODE_BLUE_FCM_ROLES = [...new Set([...ALL_STAFF_ROLES, ROLES.ADMIN, 'SUPER_ADMIN'])];

export function emitCodeBlue({ tenantId, patientId, bedNumber, ward, triggeredBy, reason, eventId = null }) {
  if (!tenantId) {
    logger.warn('emitCodeBlue skipped: tenantId is required');
    return;
  }
  const payload = {
    kind: 'code-blue',
    patientId: String(patientId),
    bedNumber: bedNumber || null,
    ward: ward || null,
    triggeredBy: triggeredBy ? String(triggeredBy) : null,
    reason: reason || null,
    eventId: eventId == null ? null : Number(eventId),
    at: new Date().toISOString(),
  };
  try {
    broadcast('staff:code-blue', payload, { tenantId });
  } catch (err) {
    logger.warn('emitCodeBlue WS failed:', err.message);
  }
  // Fan out a high-priority FCM data message to active staff devices so the
  // staff app wakes from background and shows a full-screen alert. Best-effort
  // — failures must never block WS delivery.
  _fanOutCodeBlueFcm(payload, tenantId).catch((err) =>
    logger.warn('emitCodeBlue FCM fan-out failed:', err.message),
  );
}

/** Code-STEMI board invalidation; persisted pathway rows remain the source of truth. */
export function emitCodeStemi({ kind = 'activation-updated', tenantId, activation = {} } = {}) {
  if (!tenantId) {
    logger.warn('emitCodeStemi skipped: tenantId is required');
    return;
  }
  const wireValue = (value) => {
    if (value === null || value === undefined) return null;
    return typeof value === 'bigint' ? value.toString() : value;
  };
  try {
    broadcast('staff:code-stemi', {
      kind: 'code-stemi',
      eventKind: kind,
      activationId: wireValue(activation?.id),
      patientUid: wireValue(activation?.patient_uid),
      emergencyVisitId: wireValue(activation?.emergency_visit_id),
      cathCaseId: wireValue(activation?.cath_case_id),
      status: activation?.status ?? null,
      activatedAt: activation?.activated_at ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitCodeStemi failed:', err.message);
  }
}

async function _fanOutCodeBlueFcm(payload, tenantId) {
  if (!tenantId) throw new Error('Code Blue FCM fan-out requires tenantId');
  const rows = await setTenant(
    tenantId,
    tx => tx.$queryRawUnsafe(
      `SELECT DISTINCT ON (token)
              token,
              recipient_uid,
              device_id,
              registration_epoch,
              session_epoch,
              authorization_epoch,
              expires_at
         FROM (
           SELECT ud.fcm_token AS token,
                  u.uid::text AS recipient_uid,
                  ud.device_id,
                  ud.notification_epoch::text AS registration_epoch,
                  uas.session_family_id AS session_epoch,
                  u.token_epoch::text AS authorization_epoch,
                  EXTRACT(EPOCH FROM LEAST(uas.expires_at, NOW() + INTERVAL '60 seconds'))::bigint::text AS expires_at,
                  uas.issued_at,
                  0 AS source_priority
             FROM user_devices ud
             JOIN users u
               ON u.tenant_id = ud.tenant_id
              AND u.uid = ud.user_uid
             JOIN user_active_sessions uas
               ON uas.tenant_id = u.tenant_id
              AND uas.user_uid = u.uid
            WHERE ud.tenant_id = $1::uuid
              AND u.is_active = TRUE
              AND u.role = ANY($2::text[])
              AND ud.fcm_token IS NOT NULL
              AND uas.expires_at > NOW()
              AND uas.session_family_id IS NOT NULL
              AND (u.token_epoch_bumped_at IS NULL OR uas.issued_at >= u.token_epoch_bumped_at)
              AND (uas.stable_device_id IS NULL OR uas.stable_device_id::text = ud.device_id)
           UNION ALL
           SELECT u.device_token AS token,
                  u.uid::text AS recipient_uid,
                  'legacy'::text AS device_id,
                  '0'::text AS registration_epoch,
                  uas.session_family_id AS session_epoch,
                  u.token_epoch::text AS authorization_epoch,
                  EXTRACT(EPOCH FROM LEAST(uas.expires_at, NOW() + INTERVAL '60 seconds'))::bigint::text AS expires_at,
                  uas.issued_at,
                  1 AS source_priority
             FROM users u
             JOIN user_active_sessions uas
               ON uas.tenant_id = u.tenant_id
              AND uas.user_uid = u.uid
            WHERE u.tenant_id = $1::uuid
              AND u.is_active = TRUE
              AND u.role = ANY($2::text[])
              AND u.device_token IS NOT NULL
              AND uas.expires_at > NOW()
              AND uas.session_family_id IS NOT NULL
              AND (u.token_epoch_bumped_at IS NULL OR uas.issued_at >= u.token_epoch_bumped_at)
         ) AS eligible_tokens
        WHERE BTRIM(token) <> ''
        ORDER BY token, source_priority, issued_at DESC`,
      tenantId,
      CODE_BLUE_FCM_ROLES,
    ),
  );
  if (rows.length === 0) return;

  for (const registration of rows) {
    if (!registration.token) continue;
    const codeBlueReference = createCodeBlueNotificationReference({
      tenantId,
      userUid: registration.recipient_uid,
      deviceId: registration.device_id,
      registrationEpoch: registration.registration_epoch,
      sessionEpoch: registration.session_epoch,
      authorizationEpoch: registration.authorization_epoch,
      eventId: payload.eventId,
      expiresAtUnix: Number(registration.expires_at),
    });
    await sendPushNotification({
      tokens: [registration.token],
      title: 'CODE BLUE',
      body: 'Respond immediately',
      priority: 'high',
      channelId: 'code_blue',
      expiresAtUnix: Number(registration.expires_at),
      data: {
        type: 'code_blue',
        code_blue_reference: codeBlueReference,
        notification_authority_version: '1',
        notification_tenant_id: String(tenantId),
        notification_recipient_uid: String(registration.recipient_uid),
        notification_device_id: String(registration.device_id),
        notification_registration_epoch: String(registration.registration_epoch),
        notification_session_epoch: String(registration.session_epoch),
        notification_authorization_epoch: String(registration.authorization_epoch),
        notification_expires_at: String(registration.expires_at),
      },
    });
  }
}

/** Bed occupancy change (create/update/admit/discharge/delete). */
export function emitBedEvent(kind, bed) {
  try {
    const payload = {
      kind,
      bedId: bed?.id ?? null,
      bedNumber: bed?.bed_number ?? null,
      wardId: bed?.ward_id ?? null,
      status: bed?.status ?? null,
      patientId: bed?.patient_id ? String(bed.patient_id) : null,
      at: new Date().toISOString(),
    };
    broadcast('staff:beds', payload);
    broadcast('admin:beds', payload);
  } catch (err) {
    logger.warn('emitBedEvent failed:', err.message);
  }
}

/** New handover note posted. */
export function emitHandover(handover) {
  try {
    broadcast('staff:handovers', {
      kind: 'handover-created',
      handoverId: handover?.id ?? null,
      patientUid: handover?.patient_uid ?? null,
      ward: handover?.ward ?? null,
      bedNumber: handover?.bed_number ?? null,
      outgoingNurse: handover?.outgoing_nurse ?? null,
      incomingNurse: handover?.incoming_nurse ?? null,
      shift: handover?.shift ?? null,
      at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('emitHandover failed:', err.message);
  }
}

/** New direct or broadcast staff message delivered to one recipient. */
export function emitStaffMessage({ recipientUid, message, senderUid, priority, subject, body }) {
  if (!recipientUid) return;
  try {
    sendToUser(String(recipientUid), 'staff:message', {
      kind: 'staff-message-created',
      messageId: message?.id ?? null,
      threadId: message?.thread_id ?? null,
      senderUid: senderUid ? String(senderUid) : message?.sender_uid ?? null,
      subject: subject || message?.subject || null,
      body: body || message?.body || null,
      priority: priority || message?.priority || 'normal',
      at: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('emitStaffMessage failed:', err.message);
  }
}

/** Queue position recomputed for a patient. */
export function emitQueuePosition({ patientUid, tenantId, appointmentId, position, etaMinutes }) {
  if (!patientUid) return;
  try {
    broadcast(`patient:${String(patientUid)}:queue`, {
      appointmentId: String(appointmentId),
      position,
      etaMinutes: etaMinutes ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitQueuePosition failed:', err.message);
  }
}

/**
 * ED tracking-board change (arrival / transition / triage-priority).
 * The ED route handlers pass an explicit { tenantId } (req.tenantId) for
 * robust tenant scoping; broadcast() also falls back to the request-scoped
 * tenant context when tenantId is omitted.
 */
export function emitEdBoardEvent(kind, visit, { tenantId } = {}) {
  try {
    broadcast('staff:ed-board', {
      kind,
      id: visit?.id ?? null,
      visitNumber: visit?.visit_number ?? null,
      status: visit?.status ?? null,
      triagePriority: visit?.triage_priority ?? null,
      disposition: visit?.disposition ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitEdBoardEvent failed:', err.message);
  }
}

/**
 * Admin KPI tile tick (per-tenant cron). The payload shape stays
 * `{ tile, value, at }` — the admin LiveBedOccupancyTile reads exactly that —
 * while `tenantId` scopes delivery so a tenant's counts reach only that
 * tenant's admin sockets (a tenant-null broadcast matches every socket).
 */
export function emitAdminKpi(tile, value, { tenantId } = {}) {
  try {
    broadcast('admin:kpi', {
      tile,
      value,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitAdminKpi failed:', err.message);
  }
}

/** Daily operations snapshot push (per-tenant cron). Payload is the getDailyOpsSnapshot row. */
export function emitDailyOps(snapshot, { tenantId } = {}) {
  try {
    broadcast('admin:daily-ops', snapshot, { tenantId });
  } catch (err) {
    logger.warn('emitDailyOps failed:', err.message);
  }
}

export async function emitDailyOpsConfirmed(snapshot, { tenantId } = {}) {
  const { broadcastConfirmed } = await import('./wsServer.js');
  return broadcastConfirmed('admin:daily-ops', snapshot, { tenantId });
}

/** Teleconsult operations snapshot push (per-tenant cron). Payload is non-PHI telemetry. */
export function emitTeleconsultOps(snapshot, { tenantId } = {}) {
  try {
    broadcast('admin:teleconsult-ops', snapshot, { tenantId });
  } catch (err) {
    logger.warn('emitTeleconsultOps failed:', err.message);
  }
}

export async function emitTeleconsultOpsConfirmed(snapshot, { tenantId } = {}) {
  const { broadcastConfirmed } = await import('./wsServer.js');
  return broadcastConfirmed('admin:teleconsult-ops', snapshot, { tenantId });
}

/** OR board change (case scheduled / status changed / cancelled). */
export function emitOrBoardEvent(kind, { scheduleId, status, tenantId } = {}) {
  try {
    broadcast('staff:or-board', {
      kind,
      scheduleId: scheduleId ?? null,
      status: status ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitOrBoardEvent failed:', err.message);
  }
}

/** ICU command-centre change (admission / code-status / discharge / flowsheet / assessment / bundle). */
export function emitIcuBoardEvent(kind, { admissionId, status, tenantId } = {}) {
  try {
    broadcast('staff:icu-board', {
      kind,
      admissionId: admissionId ?? null,
      status: status ?? null,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitIcuBoardEvent failed:', err.message);
  }
}

/** Lab board change (critical-value alert fired/acked, result pending/signed). */
export function emitLabEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:lab', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitLabEvent failed:', err.message);
  }
}

/** Microbiology board change (order created/transitioned, isolate/sensitivity added). */
export function emitMicroEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:micro', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitMicroEvent failed:', err.message);
  }
}

/** Incident-board change (new incident filed / status·notes updated). */
export function emitIncidentEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:incidents', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitIncidentEvent failed:', err.message);
  }
}

/** Dialysis-board change (session lifecycle, intra-dialysis obs, complications, vascular access, serology). */
export function emitDialysisEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:dialysis-board', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitDialysisEvent failed:', err.message);
  }
}

/** Blood-bank board change (request lifecycle, unit stock, crossmatch, transfusion closed-loop, reactions). */
export function emitBloodBankEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:blood-bank', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitBloodBankEvent failed:', err.message);
  }
}

/** Cold-chain board change (readings, excursions, acknowledgement, corrective action, silent sensor). */
export function emitColdChainEvent(kind, { tenantId, unitId = null, excursionId = null, status = null, severity = null } = {}) {
  try {
    broadcast('staff:cold-chain', {
      kind,
      unitId,
      excursionId,
      status,
      severity,
      at: new Date().toISOString(),
    }, { tenantId });
  } catch (err) {
    logger.warn('emitColdChainEvent failed:', err.message);
  }
}

/** Radiology-board change (order lifecycle, acquisition, report submission, sign-off, addendum). */
export function emitRadiologyEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:radiology', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitRadiologyEvent failed:', err.message);
  }
}

/** Anatomic-pathology board change (accession, grossing, blocks/slides, report, sign-off, addendum). */
export function emitPathologyEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:pathology', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitPathologyEvent failed:', err.message);
  }
}

/** Appointment/queue board change plus an optional personal patient nudge. */
export function emitAppointmentEvent(kind, {
  tenantId,
  patientUid = null,
  appointmentId = null,
  status = null,
} = {}) {
  try {
    broadcast('staff:appointments', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitAppointmentEvent staff broadcast failed:', err.message);
  }
  if (patientUid) {
    try {
      broadcast(`patient:${String(patientUid)}:appointments`, {
        kind,
        appointmentId: appointmentId === null ? null : String(appointmentId),
        status,
        at: new Date().toISOString(),
      }, { tenantId });
    } catch (err) {
      logger.warn('emitAppointmentEvent patient broadcast failed:', err.message);
    }
  }
}

/** Patient transport board change (task lifecycle / assignment / SLA escalation). */
export function emitTransportEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:transport', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitTransportEvent failed:', err.message);
  }
}
