// src/services/sosService.js
// Migrated from raw pg to Prisma ORM

import { SOS_SEVERITY } from '../config/sosConfig.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { AppError } from '../utils/AppError.js';
import { maskPhoneForLog } from '../utils/logMasking.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';
import { sendSecurityWebhook } from '../utils/securityWebhook.js';
import {
  completeWorkflowSla,
  recordCanonicalClinicalEvent,
  startWorkflowSla,
} from './clinical/canonicalClinicalPlatformService.js';
import * as locationService from './locationService.js';
import * as notificationService from './notification/notificationService.js';
import { DEFAULT_TENANT_ID } from './tenant/tenantService.js';

/** Canonical SLA rule armed at alert creation, completed on the first
 * responder acknowledgement (or resolve/cancel). Seeded by migration 677. */
export const SOS_RESPONSE_SLA_RULE = 'sos_response_ack';
const SOS_DRILL_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireDrillAuthorization(isTestAlert, authorization) {
  if (!isTestAlert) return null;
  const actorUid = String(authorization?.actorUid || '').trim().toLowerCase();
  const actorRole = String(authorization?.actorRole || '').trim().toUpperCase();
  if (!UUID_RE.test(actorUid) || !SOS_DRILL_ROLES.has(actorRole)) {
    throw AppError.forbidden(
      'SOS drill authorization is required',
      'SOS_DRILL_AUTHORIZATION_REQUIRED',
    );
  }
  return { actorUid, actorRole };
}

/**
 * Canonical clinical timeline emit for an SOS lifecycle transition
 * (sos.raised / sos.responded / sos.resolved / sos.cancelled / sos.escalated).
 *
 * SOS state changes are patient-facing clinical-adjacent writes, so they get
 * the timeline+audit pair (CANONICAL_CLINICAL_TIMELINE.md invariant). Two
 * deliberate deviations from the strict same-transaction shape, both following
 * the housekeeping/bridge precedent (canonicalOperationalBridgeService):
 *
 * 1. Best-effort, never blocking: the SOS detail write is a life-safety path —
 *    a canonical-layer failure must not 500 the alert (the patient would
 *    retry/duplicate or believe nothing was recorded). Failures are logged.
 * 2. `sos_alerts.uid` is nullable (guest / unknown-phone alerts). The timeline
 *    writer no-ops without a patient_uid; the audit row still lands — same as
 *    patient-less housekeeping rows.
 */
export async function emitSosCanonicalEvent({
  db = prisma,
  alertId,
  tenantId = null,
  patientUid = null,
  eventType,
  status,
  previousStatus = null,
  actorUid = null,
  actorRole = null,
  summary,
  payload = {},
} = {}) {
  try {
    const stamp = Date.now();
    return await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType,
      eventStatus: status || null,
      sourceTable: 'sos_alerts',
      sourceId: String(alertId),
      resourceType: 'sos_alert',
      resourceId: String(alertId),
      actorUid,
      actorRole,
      summary,
      payload: { sos_alert_id: alertId, previous_status: previousStatus, status: status || null, ...payload },
      beforeState: previousStatus ? { status: previousStatus } : null,
      afterState: status ? { status } : null,
      tags: ['sos', 'emergency'],
      timelineIdempotencyKey: `sos_alerts:${alertId}:${eventType}:${status || 'none'}:${stamp}`,
      auditIdempotencyKey: `sos_alerts:${alertId}:audit:${eventType}:${status || 'none'}:${stamp}`,
    }, { db });
  } catch (err) {
    logger.error(`SOS alert ${alertId}: canonical ${eventType} emit failed`, { error: err.message });
    return null;
  }
}

export const createAlert = async (alertData) => {
  const {
    phone, latitude, longitude, severity = SOS_SEVERITY.HIGH,
    message, emergencyType = 'medical', isTestAlert: requestedTestAlert = false,
    ip_address, userAgent, createdBy, drillAuthorization,
  } = alertData;
  const isTestAlert = requestedTestAlert === true;
  const authorizedDrill = requireDrillAuthorization(isTestAlert, drillAuthorization);

  const user = await getUserMedicalInfo(phone);

  const alert = await insertAlert({
    phone, user, latitude, longitude, severity, message,
    emergencyType, ip_address, userAgent, isTestAlert, createdBy,
    drillAuthorization: authorizedDrill,
  });

  // Canonical timeline/audit pair + SLA clock (best-effort, post-detail-write —
  // see emitSosCanonicalEvent for why this life-safety path is not strict).
  // The sos_response_ack clock is what the sos-alert-age-escalation sweep and
  // the admin ack-latency tiles measure; respond/resolve/cancel complete it.
  await emitSosCanonicalEvent({
    alertId: alert.id,
    tenantId: alert.tenant_id,
    patientUid: user.uid || null,
    eventType: 'sos.raised',
    status: 'ACTIVE',
    actorUid: authorizedDrill?.actorUid ?? user.uid ?? null,
    actorRole: authorizedDrill?.actorRole ?? 'PATIENT',
    summary: `SOS alert #${alert.id} raised (${severity})`,
    payload: { severity, alert_type: emergencyType, is_test: isTestAlert === true },
  });
  try {
    await startWorkflowSla({
      tenantId: alert.tenant_id,
      ruleCode: SOS_RESPONSE_SLA_RULE,
      patientUid: user.uid || null,
      sourceTable: 'sos_alerts',
      sourceId: String(alert.id),
      priority: 'critical',
      metadata: { severity, is_test: isTestAlert === true },
    });
  } catch (slaErr) {
    logger.error(`SOS alert ${alert.id}: SLA clock start failed`, { error: slaErr.message });
  }

  let nearbyServices = {};
  if (latitude && longitude) {
    nearbyServices = await locationService.findNearbyEmergencyServices(latitude, longitude);
  }

  // Fan out to the emergency team. The sos_alerts row above is already
  // committed, so a fan-out failure must not 500 the SOS (the patient would
  // retry and duplicate the alert, or believe nothing was recorded) — but the
  // response below must never claim teams were notified when they were not
  // (audit BE-M3). notifyEmergencyTeam owns the zero-responder loud-failure
  // path (durable security-audit row + ops webhook + admin fallback fan-out);
  // escalation of unread responder notifications is owned by the existing
  // unread-critical-notification-escalation cron.
  let notifiedCount = 0;
  if (!isTestAlert) {
    try {
      const notifyResult = await notificationService.notifyEmergencyTeam({
        id: alert.id, uid: user.uid || null, phone, severity, message,
        latitude, longitude, user_name: user.name,
      }, nearbyServices.hospitals || []);
      notifiedCount = notifyResult?.notified_count ?? 0;
    } catch (notifyErr) {
      logger.error(`SOS alert ${alert.id}: emergency-team fan-out failed — teams NOT notified`, {
        error: notifyErr.message,
      });
      logSecurityEvent('SOS_ESCALATION_FAILED', {
        userId: user.uid || null,
        ip: ip_address,
        path: '/sos',
        statusCode: 200,
        reason: `SOS alert ${alert.id}: responder fan-out threw: ${notifyErr.message}`,
      });
      sendSecurityWebhook('SOS_ESCALATION_FAILED', {
        reason: `SOS alert ${alert.id} (severity ${severity}) fan-out failed: ${notifyErr.message}`,
        ip: ip_address,
        path: '/sos',
      });
    }
  }

  return formatAlertResponse(alert, nearbyServices, severity, isTestAlert, notifiedCount);
};

const insertAlert = async (data) => {
  // is_test_alert (migration 692) persists the drill marker so the
  // sos-alert-age-escalation sweep can skip test alerts; anything other than
  // an explicit true is stored FALSE (fail-real direction).
  const rows = await prisma.$queryRaw`
    INSERT INTO sos_alerts (
      phone, uid, latitude, longitude, severity, message,
      alert_type, ip_address, is_test_alert,
      test_alert_authorized_by, test_alert_authorized_role,
      status, raised_at, created_at, updated_at
    ) VALUES (
      ${data.phone}, ${data.user.uid ?? null}::uuid,
      ${data.latitude ?? null}, ${data.longitude ?? null},
      ${data.severity}, ${data.message ?? null},
      ${data.emergencyType},
      ${data.ip_address ?? null},
      ${data.isTestAlert === true},
      ${data.drillAuthorization?.actorUid ?? null}::uuid,
      ${data.drillAuthorization?.actorRole ?? null},
      'ACTIVE', NOW(), NOW(), NOW()
    )
    RETURNING id, created_at, tenant_id
  `;
  return rows[0];
};

async function getUserMedicalInfo(phone) {
  const user = await prisma.users.findFirst({
    where: { phone },
    select: { uid: true, name: true },
  });
  if (!user) return { name: 'Unknown User', phone, uid: null };
  return user;
}

function formatAlertResponse(alert, nearbyServices, severity, isTestAlert, notifiedCount = 0) {
  const teamsNotified = !isTestAlert && notifiedCount > 0;
  return {
    alert_id: alert.id,
    status: 'active',
    severity,
    timestamp: alert.created_at,
    is_test: isTestAlert,
    teams_notified: teamsNotified,
    responders_notified_count: isTestAlert ? 0 : notifiedCount,
    message: isTestAlert
      ? 'Test alert created successfully. No notifications were sent.'
      : teamsNotified
        ? 'SOS alert created successfully. Emergency teams have been notified.'
        : 'SOS alert recorded, but automatic notification of emergency teams could not be confirmed. Please call emergency services directly.',
    nearby_hospitals: nearbyServices.hospitals || [],
    nearby_police: nearbyServices.police_stations || [],
  };
}

export const getEmergencyContacts = async (phone) => {
  const user = await prisma.users.findFirst({
    where: { phone },
    select: {
      emergency_contact: true,
      name: true,
      phone: true,
      allergies: true,
    },
  });
  if (!user) return { emergencyContact: null };
  return {
    emergencyContact: user.emergency_contact,
    patientName: user.name,
    phone: user.phone,
    allergies: user.allergies,
  };
};

export const updateEmergencyContacts = async (phone, contactData) => {
  const contactValue = contactData.emergency_contact || contactData.emergencyContact || null;

  const result = await prisma.users.updateMany({
    where: { phone },
    data: { emergency_contact: contactValue, updated_at: new Date() },
  });

  if (result.count === 0) throw new Error('User not found');

  logger.info(`Emergency contacts updated for user: ${maskPhoneForLog(phone)}`);
  return {
    success: true,
    message: 'Emergency contacts updated successfully',
    data: { phone, emergency_contact: contactValue },
  };
};

export const cancelAlert = async (alertId, uid) => {
  const rows = await prisma.$queryRaw`
    UPDATE sos_alerts
    SET status = 'CANCELLED', resolved_at = NOW(), updated_at = NOW()
    WHERE id = ${parseInt(alertId, 10)}
      AND (uid = ${uid}::uuid OR phone IN (SELECT phone FROM users WHERE uid = ${uid}::uuid))
      AND status = 'ACTIVE'
    RETURNING id, status, tenant_id, uid
  `;
  if (rows.length === 0) throw new Error('Alert not found or already resolved');
  const alert = rows[0];
  await emitSosCanonicalEvent({
    alertId: alert.id,
    tenantId: alert.tenant_id,
    patientUid: alert.uid || null,
    eventType: 'sos.cancelled',
    status: 'CANCELLED',
    previousStatus: 'ACTIVE',
    actorUid: uid,
    actorRole: 'PATIENT',
    summary: `SOS alert #${alert.id} cancelled by the patient`,
  });
  try {
    await completeWorkflowSla({
      tenantId: alert.tenant_id,
      ruleCode: SOS_RESPONSE_SLA_RULE,
      sourceTable: 'sos_alerts',
      sourceId: String(alert.id),
      metadata: { completed_status: 'CANCELLED', completed_by: uid },
    });
  } catch (slaErr) {
    logger.error(`SOS alert ${alert.id}: SLA completion on cancel failed`, { error: slaErr.message });
  }
  return { id: alert.id, status: alert.status };
};

/* ----------------------- responder loop transitions ----------------------- */
// Moved out of sosController (HIGH-1): the transitions now persist the
// validated responder text (migration 677 columns), complete the
// sos_response_ack SLA clock, and emit the canonical timeline/audit pair.

/**
 * ACTIVE -> RESPONDING. Persists the responder's required message.
 * @returns the updated row, or null when the alert is not ACTIVE / wrong tenant.
 */
export const respondToAlert = async ({ tenantId, alertId, responderUid, responseMessage, responderRole = null }) => {
  // Tenant scoping preserves the original controller shape: the alert's tenant
  // is derived from the raising user row (uid/phone join, defaulted), matching
  // the responder-dashboard SELECT so a listed alert can always be actioned.
  const rows = await prisma.$queryRawUnsafe(`
    UPDATE sos_alerts
    SET status = 'RESPONDING', responded_by = $1::uuid, responded_at = NOW(),
        response_message = $4, updated_at = NOW()
    WHERE id = $2::int AND status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM users u
         WHERE (u.uid = sos_alerts.uid OR u.phone = sos_alerts.phone)
           AND COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $3::uuid
      )
    RETURNING id, status, responded_at, response_message, tenant_id, uid
  `, responderUid, parseInt(alertId, 10), tenantId, responseMessage ?? null);
  if (rows.length === 0) return null;
  const alert = rows[0];
  await emitSosCanonicalEvent({
    alertId: alert.id,
    tenantId: alert.tenant_id,
    patientUid: alert.uid || null,
    eventType: 'sos.responded',
    status: 'RESPONDING',
    previousStatus: 'ACTIVE',
    actorUid: responderUid,
    actorRole: responderRole,
    summary: `SOS alert #${alert.id} acknowledged by responder`,
    payload: { response_message: responseMessage ?? null },
  });
  try {
    await completeWorkflowSla({
      tenantId: alert.tenant_id,
      ruleCode: SOS_RESPONSE_SLA_RULE,
      sourceTable: 'sos_alerts',
      sourceId: String(alert.id),
      metadata: { completed_status: 'RESPONDING', completed_by: responderUid },
    });
  } catch (slaErr) {
    logger.error(`SOS alert ${alert.id}: SLA completion on respond failed`, { error: slaErr.message });
  }
  return { id: alert.id, status: alert.status, responded_at: alert.responded_at, response_message: alert.response_message };
};

/**
 * ACTIVE|RESPONDING -> RESOLVED. Persists the responder's optional notes.
 * @returns the updated row, or null when not resolvable / wrong tenant.
 */
export const resolveAlert = async ({ tenantId, alertId, actorUid = null, resolutionNotes = null, actorRole = null }) => {
  // Same original user-join tenant scoping as respondToAlert above.
  const rows = await prisma.$queryRawUnsafe(`
    UPDATE sos_alerts
    SET status = 'RESOLVED', resolved_at = NOW(),
        resolution_notes = $3, updated_at = NOW()
    WHERE id = $1::int AND status IN ('ACTIVE', 'RESPONDING')
      AND EXISTS (
        SELECT 1 FROM users u
         WHERE (u.uid = sos_alerts.uid OR u.phone = sos_alerts.phone)
           AND COALESCE(u.tenant_id, '${DEFAULT_TENANT_ID}'::uuid) = $2::uuid
      )
    RETURNING id, status, resolved_at, resolution_notes, tenant_id, uid
  `, parseInt(alertId, 10), tenantId, resolutionNotes ?? null);
  if (rows.length === 0) return null;
  const alert = rows[0];
  await emitSosCanonicalEvent({
    alertId: alert.id,
    tenantId: alert.tenant_id,
    patientUid: alert.uid || null,
    eventType: 'sos.resolved',
    status: 'RESOLVED',
    actorUid,
    actorRole,
    summary: `SOS alert #${alert.id} resolved`,
    payload: { resolution_notes: resolutionNotes ?? null },
  });
  try {
    await completeWorkflowSla({
      tenantId: alert.tenant_id,
      ruleCode: SOS_RESPONSE_SLA_RULE,
      sourceTable: 'sos_alerts',
      sourceId: String(alert.id),
      metadata: { completed_status: 'RESOLVED', completed_by: actorUid },
    });
  } catch (slaErr) {
    logger.error(`SOS alert ${alert.id}: SLA completion on resolve failed`, { error: slaErr.message });
  }
  return { id: alert.id, status: alert.status, resolved_at: alert.resolved_at, resolution_notes: alert.resolution_notes };
};

export const getMyAlerts = async (uid, { limit = 20, offset = 0 } = {}) => {
  const rows = await prisma.$queryRaw`
    SELECT id, phone, latitude, longitude, alert_type AS "alertType",
           severity, status, message, raised_at AS "raisedAt",
           resolved_at AS "resolvedAt"
    FROM sos_alerts
    WHERE uid = ${uid}::uuid
    ORDER BY raised_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows;
};

export const getNearbyServices = async (latitude, longitude) => {
  // locationService hits an external geocoding API; fall back to empty
  // arrays on failure so SOS UX never blocks on a degraded third party.
  try {
    return await locationService.findNearbyEmergencyServices(latitude, longitude);
  } catch (err) {
    logger.error('Error fetching nearby services:', err);
    return { hospitals: [], police_stations: [], ambulances: [] };
  }
};

export const getMedicalInfo = async (uid) => {
  const rows = await prisma.$queryRaw`
    SELECT name, phone, allergies, emergency_contact AS "emergencyContact",
           gender, birthday AS "dateOfBirth", blood_group AS "bloodGroup"
    FROM users WHERE uid = ${uid}::uuid LIMIT 1
  `;
  if (rows.length === 0) return null;
  return rows[0];
};

/* ------------------------- admin emergency actions ------------------------- */
// Shared by both admin surfaces: /api/v1/sos/admin/* (sosController) and the
// admin console at /api/v1/admin/sos/* (routes/admin/dashboardController). The
// console used to carry its own log-only stubs that returned success while
// writing nothing (audit F1); there is now one implementation.

/**
 * Notify every reachable staff member in one tenant of an emergency broadcast.
 * @returns {Promise<{notified: number}>} count of notification rows written.
 */
export const broadcastEmergencyAlert = async ({ tenantId, title, message, severity = 'HIGH' }) => {
  if (!title || !message) {
    throw AppError.badRequest('Title and message are required', 'SOS_BROADCAST_INCOMPLETE');
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO notifications (tenant_id, uid, phone, title, body, type, data, created_at, updated_at)
     SELECT tenant_id, uid, phone, $1, $2, 'SOS_BROADCAST', $3::jsonb, NOW(), NOW()
       FROM users
      WHERE role <> 'PATIENT'
        AND is_active = true
        AND NULLIF(BTRIM(phone), '') IS NOT NULL
        AND tenant_id = $4::uuid
     RETURNING id`,
    // notifications.phone is NOT NULL, so a single phone-less staff row aborts the
    // whole INSERT…SELECT and nobody is notified — skip them instead. Users with
    // no role at all are also skipped: an unclassified identity is not staff.
    title, message, JSON.stringify({ severity }), tenantId,
  );

  if (rows.length === 0) {
    // A fan-out that reaches nobody looks identical to a successful one at the
    // API boundary, so it has to be loud here.
    logger.warn('SOS broadcast reached zero staff', { tenantId, severity });
  }
  return { notified: rows.length };
};

/**
 * Raise an alert one step up the severity ladder, within one tenant.
 * @returns {Promise<{id: number, severity: string, previousSeverity: string}>}
 */
export const escalateAlert = async ({ tenantId, alertId, actorUid = null, reason = null }) => {
  const id = Number.parseInt(alertId, 10);
  if (!Number.isInteger(id) || id < 1) {
    throw AppError.badRequest('Valid alert ID required', 'SOS_ALERT_ID_INVALID');
  }

  // Lock, decide, and update in one statement. A separate SELECT followed by
  // UPDATE lets concurrent admins read the same severity and both report the
  // same escalation as successful. The row lock makes concurrent requests
  // advance the ladder in order.
  const rows = await prisma.$queryRawUnsafe(
    `WITH current AS MATERIALIZED (
       SELECT id, UPPER(COALESCE(severity, '')) AS previous_severity
         FROM sos_alerts
        WHERE id = $1::int
          AND tenant_id = $2::uuid
        FOR UPDATE
     ), updated AS (
       UPDATE sos_alerts AS sa
          SET severity = CASE current.previous_severity
            WHEN 'LOW' THEN 'MEDIUM'
            WHEN 'MEDIUM' THEN 'HIGH'
            WHEN 'HIGH' THEN 'CRITICAL'
          END,
              updated_at = NOW()
         FROM current
        WHERE sa.id = current.id
          AND sa.tenant_id = $2::uuid
          AND current.previous_severity IN ('LOW', 'MEDIUM', 'HIGH')
       RETURNING sa.id, sa.severity
     )
     SELECT current.id,
            current.previous_severity,
            updated.severity
       FROM current
       LEFT JOIN updated ON updated.id = current.id`,
    id, tenantId,
  );
  if (rows.length === 0) throw AppError.notFound('Alert not found', 'SOS_ALERT_NOT_FOUND');

  const previousSeverity = String(rows[0].previous_severity || '').toUpperCase();
  const severity = rows[0].severity == null ? null : String(rows[0].severity).toUpperCase();
  if (!severity) {
    throw AppError.badRequest(
      `Alert cannot be escalated from severity ${previousSeverity || 'UNKNOWN'}`,
      'SOS_ALERT_AT_MAX_SEVERITY',
    );
  }

  // sos_alerts has no escalation-reason column; the log sink is the only audit
  // trail this action has, so record who escalated what and why.
  logger.warn('SOS alert escalated', { alertId: id, tenantId, previousSeverity, severity, actorUid, reason });
  return { id: rows[0].id, severity, previousSeverity };
};
