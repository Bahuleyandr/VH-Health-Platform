// src/utils/notifications/clinicalAlertFanout.js
//
// Duty-role fan-out for broadcast clinical alerts (fix R2 residual, audit
// 2026-08-10). The notification outbox has no topic delivery: a row queued
// with recipientId:null gets a `broadcast:` recipient key that no provider
// path can resolve, so STAT-order / MAR-scheduling-failed / pre-eclampsia
// alerts "broadcast to relevant staff" reached nobody. This helper resolves
// the broadcast to CONCRETE recipients at ENQUEUE time — one immutable
// notification_outbox intent per resolved clinician — mirroring the
// escalation engine's recipient fan-out (escalationEngineService.js
// resolveRecipientsForRole + queueRecipientNotifications) and the
// enqueueCriticalResultTask duty-role ownership pattern.
//
// Recipient resolution mirrors escalationEngineService: try the exact
// DUTY_DOCTOR role first; if no active user holds it in the tenant, widen to
// the doctor-tier family so a ward with nobody tagged DUTY_DOCTOR still
// reaches an on-shift physician. Ordering is `last_sign_in_at DESC NULLS
// LAST, id ASC` — an availability PROXY (users carries no shift/duty column),
// same caveat as the escalation engine documents.
import { setTenant } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { DOCTOR_TIERS, ROLES } from '../roleHelpers.js';
import { notificationOutbox } from './notificationOutbox.js';

// Same default bound the escalation engine applies to a single role fan-out
// (DEFAULT_RECIPIENT_FANOUT_CAP in escalationEngineService.js) — inside a
// real hospital's doctor-tier headcount, outside accidental-explosion range.
export const CLINICAL_ALERT_FANOUT_CAP = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the concrete clinical-staff audience for a broadcast alert in one
 * tenant. Exact DUTY_DOCTOR first, doctor-tier family fallback second.
 * Returns [{ id, uid, phone, role }] (may be empty — the caller decides how
 * loudly to fail).
 */
export async function resolveClinicalAlertRecipients(tenantId, {
  tx = null,
  primaryRole = ROLES.DUTY_DOCTOR,
  fallbackRoles = DOCTOR_TIERS,
} = {}) {
  const tid = String(tenantId || '').trim().toLowerCase();
  if (!UUID_RE.test(tid)) return [];
  const primary = String(primaryRole || '').trim();
  const fallback = [...new Set(
    (Array.isArray(fallbackRoles) ? fallbackRoles : [])
      .map((role) => String(role || '').trim())
      .filter(Boolean),
  )];
  if (!primary || fallback.length === 0) return [];
  const query = (rolePredicate, roleValue) => {
    const run = db => db.$queryRawUnsafe(
      `SELECT id, uid, phone, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND is_active = TRUE
          AND COALESCE(is_deleted, FALSE) = FALSE
          AND deleted_at IS NULL
          AND LOWER(COALESCE(status, 'active')) = 'active'
          AND ${rolePredicate}
        ORDER BY last_sign_in_at DESC NULLS LAST, id ASC
        LIMIT $3::integer`,
      tid, roleValue, CLINICAL_ALERT_FANOUT_CAP,
    );
    return tx ? run(tx) : setTenant(tid, run, { readOnly: true });
  };
  const exact = await query('role = $2::text', primary);
  const rows = exact.length > 0 ? exact : await query('role = ANY($2::text[])', fallback);
  const seen = new Set();
  const recipients = [];
  for (const row of rows) {
    const id = Number(row?.id);
    const uid = String(row?.uid || '').trim().toLowerCase();
    if (!Number.isInteger(id) || id <= 0 || !UUID_RE.test(uid) || seen.has(uid)) continue;
    seen.add(uid);
    recipients.push({ id, uid, phone: row.phone || null, role: row.role || null });
  }
  return recipients;
}

/**
 * Queue one durable notification_outbox intent per resolved clinical-staff
 * recipient. Drop-in replacement for the old `recipientId: null` broadcast
 * enqueues — same notification shape, but every row carries a REAL
 * recipientId (+ phone) that the outbox drain can deliver.
 *
 * The shared `data.source_event_key` stays identical across recipients:
 * dedupe (`ux_notification_outbox_delivery_intent`) includes the per-recipient
 * recipient_key, so a retried fan-out re-queues nobody twice.
 *
 * Per-recipient queue failures are logged and skipped. With `strict`, every
 * resolved recipient must queue successfully so partial clinical fan-out
 * cannot be reported as success.
 *
 * @returns {{ resolved: number, queued: number }}
 */
export async function queueClinicalAlertFanout(notification, {
  outbox = notificationOutbox,
  resolveRecipients = resolveClinicalAlertRecipients,
  strict = false,
  tx = null,
} = {}) {
  const { tenantId: rawTenantId, ...intent } = notification || {};
  const tenantId = String(rawTenantId || getCurrentTenantId() || '').trim().toLowerCase();
  let recipients = [];
  try {
    recipients = tx
      ? await resolveRecipients(tenantId, { tx })
      : await resolveRecipients(tenantId);
  } catch (err) {
    logger.error('clinical-alert fan-out: recipient resolution failed', {
      tenant_id: tenantId || null, err: err?.message,
    });
    recipients = [];
  }
  if (recipients.length === 0) {
    const message = 'clinical-alert fan-out resolved zero active clinical recipients';
    logger.error(message, { tenant_id: tenantId || null, type: intent.type || null });
    if (strict) throw new Error(message);
    return { resolved: 0, queued: 0 };
  }

  let queued = 0;
  for (const recipient of recipients) {
    try {
      const row = await outbox.queue({
        ...intent,
        tenantId: tenantId || null,
        recipientId: recipient.uid,
        recipientPhone: recipient.phone || null,
        data: { ...(intent.data || {}), recipient_role: recipient.role || null },
      }, { strict: true, ...(tx ? { tx } : {}) });
      if (row) queued += 1;
    } catch (err) {
      logger.warn('clinical-alert fan-out: outbox queue failed for recipient', {
        tenant_id: tenantId || null, recipient_uid: recipient.uid, err: err?.message,
      });
    }
  }
  if (strict && queued !== recipients.length) {
    throw new Error(
      `clinical-alert fan-out queued ${queued} of ${recipients.length} notifications`,
    );
  }
  return { resolved: recipients.length, queued };
}

export default queueClinicalAlertFanout;
