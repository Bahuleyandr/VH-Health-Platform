// src/utils/websocket/realtimeEmitter.js
//
// Domain-level helpers that wrap the raw broadcast()/sendToUser() primitives
// with the channel naming convention from channelAuth.js. Controllers/services
// should import from here, not from wsServer directly.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from '../notifications/sendPushNotification.js';
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
export function emitCodeBlue({ patientId, bedNumber, ward, triggeredBy, reason, eventId = null }) {
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
    broadcast('staff:code-blue', payload);
  } catch (err) {
    logger.warn('emitCodeBlue WS failed:', err.message);
  }
  // Fan out a high-priority FCM data message to active staff devices so the
  // staff app wakes from background and shows a full-screen alert. Best-effort
  // — failures must never block WS delivery.
  _fanOutCodeBlueFcm(payload).catch((err) =>
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

async function _fanOutCodeBlueFcm(payload) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT device_token FROM staff_devices
      WHERE is_active = true AND device_token IS NOT NULL`,
  );
  const tokens = rows.map((r) => r.device_token).filter(Boolean);
  if (tokens.length === 0) return;

  const bodyParts = [];
  if (payload.ward) bodyParts.push(`Ward ${payload.ward}`);
  if (payload.bedNumber) bodyParts.push(`Bed ${payload.bedNumber}`);
  const body = bodyParts.length > 0 ? bodyParts.join(' · ') : 'Respond immediately';

  // Firebase caps multicast at 500 tokens per call — chunk if needed.
  const CHUNK = 500;
  for (let i = 0; i < tokens.length; i += CHUNK) {
    const slice = tokens.slice(i, i + CHUNK);
    await sendPushNotification({
      tokens: slice,
      title: 'CODE BLUE',
      body,
      priority: 'high',
      channelId: 'code_blue',
      data: {
        type: 'code_blue',
        patientId: payload.patientId,
        bedNumber: payload.bedNumber || '',
        ward: payload.ward || '',
        reason: payload.reason || '',
        eventId: payload.eventId == null ? '' : String(payload.eventId),
        at: payload.at,
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
export function emitQueuePosition({ patientId, appointmentId, position, etaMinutes }) {
  if (!patientId) return;
  try {
    sendToUser(String(patientId), 'queue-position', {
      appointmentId: String(appointmentId),
      position,
      etaMinutes: etaMinutes ?? null,
      at: new Date().toISOString(),
    });
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

/** Admin KPI tile tick. */
export function emitAdminKpi(tile, value) {
  try {
    broadcast('admin:kpi', {
      tile,
      value,
      at: new Date().toISOString(),
    });
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

/** Teleconsult operations snapshot push (per-tenant cron). Payload is non-PHI telemetry. */
export function emitTeleconsultOps(snapshot, { tenantId } = {}) {
  try {
    broadcast('admin:teleconsult-ops', snapshot, { tenantId });
  } catch (err) {
    logger.warn('emitTeleconsultOps failed:', err.message);
  }
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

/** Appointment/queue board change (book / confirm / no-show / complete / cancel / reschedule / walk-in / status). */
export function emitAppointmentEvent(kind, { tenantId } = {}) {
  try {
    broadcast('staff:appointments', { kind, at: new Date().toISOString() }, { tenantId });
  } catch (err) {
    logger.warn('emitAppointmentEvent failed:', err.message);
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
