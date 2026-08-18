// src/services/sosEscalationService.js
//
// HIGH-1 (gap-audit fold-in): alert-age escalation for never-acknowledged SOS
// alerts. Before this sweep nothing ever transitioned or re-surfaced an
// ACTIVE sos_alerts row: the zero-responder loud-failure fires only at
// creation time, and the unread-critical-notification cron escalates unread
// notification rows, not the alert itself. An alert whose fan-out was read
// and then forgotten stayed ACTIVE forever with no further signal.
//
// Sweep contract (runs per tenant from the scheduler, every 2 minutes):
//   * Eligible: status = 'ACTIVE', never acknowledged (responded_at IS NULL),
//     not a drill (is_test_alert = FALSE, migration 692 — a test alert keeps
//     its row, timeline pair and SLA clock but must never page the emergency
//     team or ops), last action (last_escalated_at, else raised_at) older
//     than the window (sosConfig ESCALATION_TIMEOUT, 5 minutes).
//   * Idempotence: the claim UPDATE stamps last_escalated_at and re-checks the
//     window predicate, so concurrent/overlapping sweeps escalate once per
//     window per alert, and each alert escalates one step per window — not one
//     step per tick.
//   * Below CRITICAL: raise one severity-ladder step (reuses
//     sosService.escalateAlert — the same admin escalate path) and re-fan-out
//     to the emergency team.
//   * Already CRITICAL: no ladder left — re-fan-out, mark the canonical
//     sos_response_ack SLA instance 'escalated', and page ops loudly
//     (security-audit row + webhook), mirroring the SOS_ESCALATION_FAILED
//     creation-time posture.
//   * Every action emits the canonical sos.escalated timeline/audit pair
//     (best-effort — see emitSosCanonicalEvent).

import { ESCALATION_TIMEOUT } from '../config/sosConfig.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { logSecurityEvent } from '../utils/securityAuditLogger.js';
import { sendSecurityWebhook } from '../utils/securityWebhook.js';
import * as notificationService from './notification/notificationService.js';
import { emitSosCanonicalEvent, escalateAlert, SOS_RESPONSE_SLA_RULE } from './sosService.js';
import { epochMsOrNull } from '../utils/dbInstant.js';

export const DEFAULT_ESCALATION_WINDOW_MINUTES = Math.max(
  1,
  Math.round(ESCALATION_TIMEOUT / 60000),
);

const MAX_ALERTS_PER_SWEEP = 20;

// Age ceiling. The sweep escalates *live* emergencies; it must never chase
// history. Two reasons, both load-bearing:
//
//   1. CUTOVER. last_escalated_at is added by migration 677 and is therefore
//      NULL on every pre-existing row, so COALESCE(last_escalated_at,
//      raised_at) makes the entire historical backlog eligible on the first
//      tick after deploy. That backlog is "every alert ever raised and not
//      patient-cancelled", because the responder endpoints had no client
//      before this wave — the very defect this sweep exists to fix. Without a
//      ceiling the sweep would re-page the emergency team for alerts that are
//      weeks old, forever (re-eligibility is one window, so nothing ever
//      drains it).
//   2. STARVATION. The eligibility query is ORDER BY raised_at ASC LIMIT 20.
//      With more than ~60 stalled rows the oldest monopolise every tick and a
//      genuinely new alert is never reached — the sweep silently fails its own
//      purpose. Bounding the age bounds the candidate set.
//
// An alert older than this is stale by any operational definition: it stays
// ACTIVE and visible on the SOS dashboard for manual resolution, it simply
// stops generating pages. Escalation is a real-time mechanism.
const MAX_ALERT_AGE_HOURS = 24;

async function markSlaEscalated(db, tenantId, alertId) {
  // Terminal-state guard mirrors completeWorkflowSla: completed/cancelled rows
  // are never re-touched; an active/breached clock records the escalation.
  await db.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = 'escalated',
            breached_at = COALESCE(breached_at, NOW()),
            escalated_at = COALESCE(escalated_at, NOW()),
            metadata = metadata || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND rule_code = $2
        AND source_table = 'sos_alerts'
        AND source_id = $3
        AND status NOT IN ('completed', 'cancelled')`,
    tenantId,
    SOS_RESPONSE_SLA_RULE,
    String(alertId),
    JSON.stringify({ escalated_by: 'sos-alert-age-escalation' }),
  );
}

/**
 * Escalate never-acknowledged ACTIVE SOS alerts older than the window.
 * @returns {Promise<{scanned: number, escalated: number, refannedOut: number, criticalStalled: number}>}
 */
export async function runSosAlertAgeEscalationSweep({
  tenantId,
  db = prisma,
  windowMinutes = DEFAULT_ESCALATION_WINDOW_MINUTES,
  limit = MAX_ALERTS_PER_SWEEP,
  maxAgeHours = MAX_ALERT_AGE_HOURS,
} = {}) {
  const result = { scanned: 0, escalated: 0, refannedOut: 0, criticalStalled: 0 };
  if (!tenantId) return result;

  const overdue = await db.$queryRawUnsafe(
    `SELECT sa.id, sa.uid, sa.phone, sa.severity, sa.message,
            sa.latitude, sa.longitude, sa.raised_at, sa.last_escalated_at,
            (EXTRACT(EPOCH FROM sa.raised_at) * 1000)::bigint AS raised_at_epoch_ms
       FROM sos_alerts sa
      WHERE sa.tenant_id = $1::uuid
        AND sa.status = 'ACTIVE'
        AND sa.responded_at IS NULL
        AND sa.is_test_alert = FALSE
        AND sa.raised_at > NOW() - ($4::int * INTERVAL '1 hour')
        AND COALESCE(sa.last_escalated_at, sa.raised_at) < NOW() - ($2::int * INTERVAL '1 minute')
      ORDER BY sa.raised_at ASC
      LIMIT $3::int`,
    tenantId,
    windowMinutes,
    limit,
    maxAgeHours,
  );
  result.scanned = overdue.length;

  for (const alert of overdue) {
    // Claim: stamp last_escalated_at under the same window predicate so a
    // concurrent sweep (or a respond racing this tick) skips instead of
    // double-escalating.
    const claimed = await db.$queryRawUnsafe(
      `UPDATE sos_alerts
          SET last_escalated_at = NOW(), updated_at = NOW()
        WHERE id = $1::int
          AND tenant_id = $2::uuid
          AND status = 'ACTIVE'
          AND responded_at IS NULL
          AND is_test_alert = FALSE
          AND raised_at > NOW() - ($4::int * INTERVAL '1 hour')
          AND COALESCE(last_escalated_at, raised_at) < NOW() - ($3::int * INTERVAL '1 minute')
        RETURNING id, UPPER(COALESCE(severity, '')) AS severity`,
      alert.id,
      tenantId,
      windowMinutes,
      maxAgeHours,
    );
    if (claimed.length === 0) continue;

    const currentSeverity = claimed[0].severity;
    let newSeverity = currentSeverity;
    const raisedAt = epochMsOrNull(alert.raised_at_epoch_ms);
    const ageMinutes = raisedAt == null ? 0 : Math.round((Date.now() - raisedAt) / 60000);

    if (currentSeverity !== 'CRITICAL') {
      try {
        const ladder = await escalateAlert({
          tenantId,
          alertId: alert.id,
          actorUid: null,
          reason: `sos-alert-age-escalation: unacknowledged for ${ageMinutes} min`,
        });
        newSeverity = ladder.severity;
        result.escalated += 1;
      } catch (err) {
        // SOS_ALERT_AT_MAX_SEVERITY (severity raced upward) or a transient
        // failure — fall through to re-fan-out; the stamp prevents hot-looping.
        logger.warn(`SOS alert ${alert.id}: age-escalation ladder step failed`, { error: err.message });
      }
    } else {
      // Nothing above CRITICAL: the alert is stalled at max severity with no
      // acknowledgement. Record it on the canonical SLA clock and page ops.
      result.criticalStalled += 1;
      try {
        await markSlaEscalated(db, tenantId, alert.id);
      } catch (err) {
        logger.error(`SOS alert ${alert.id}: SLA escalate mark failed`, { error: err.message });
      }
      logSecurityEvent('SOS_ALERT_UNACKNOWLEDGED', {
        userId: alert.uid || null,
        path: '/sos',
        statusCode: 200,
        reason: `SOS alert ${alert.id}: CRITICAL and unacknowledged for ${ageMinutes} min`,
      });
      sendSecurityWebhook('SOS_ALERT_UNACKNOWLEDGED', {
        reason: `SOS alert ${alert.id} is CRITICAL and unacknowledged for ${ageMinutes} min — manual dispatch check required`,
        path: '/sos',
      });
    }

    // Re-fan-out so the (possibly escalated) alert re-surfaces for responders;
    // notifyEmergencyTeam owns the zero-responder loud-failure fallback.
    try {
      await notificationService.notifyEmergencyTeam({
        id: alert.id,
        uid: alert.uid || null,
        phone: alert.phone,
        severity: newSeverity,
        message: alert.message,
        latitude: alert.latitude,
        longitude: alert.longitude,
        user_name: null,
      }, []);
      result.refannedOut += 1;
    } catch (err) {
      logger.error(`SOS alert ${alert.id}: age-escalation re-fan-out failed`, { error: err.message });
    }

    await emitSosCanonicalEvent({
      db,
      alertId: alert.id,
      tenantId,
      patientUid: alert.uid || null,
      eventType: 'sos.escalated',
      status: 'ACTIVE',
      actorRole: 'SYSTEM',
      summary: `SOS alert #${alert.id} auto-escalated after ${ageMinutes} min without acknowledgement`,
      payload: {
        previous_severity: currentSeverity,
        severity: newSeverity,
        unacknowledged_minutes: ageMinutes,
        trigger: 'sos-alert-age-escalation',
      },
    });
  }

  if (result.scanned > 0) {
    logger.warn('sos-alert-age-escalation sweep acted on unacknowledged alerts', { tenantId, ...result });
  }
  return result;
}
