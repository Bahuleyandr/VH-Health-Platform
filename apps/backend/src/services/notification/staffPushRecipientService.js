// src/services/notification/staffPushRecipientService.js
//
// Tenant-scoped resolution of staff FCM device tokens for role-targeted push
// alerts (investigation bookings, urgent investigation orders).
//
// WHY THIS EXISTS
// ---------------
// Several fire-and-forget "alert the lab" blocks resolved recipients with a bare
//   SELECT device_token FROM users WHERE role IN (...) AND device_token IS NOT NULL
// carrying NO tenant predicate, then pushed a body containing the patient's name.
// On a multi-tenant deployment that delivers one tenant's patient name to another
// tenant's staff devices.
//
// The tenant predicate here is EXPLICIT and is the load-bearing control. It is
// deliberately not left to RLS:
//   - migration 075's tenant_isolation policy on `users` is PERMISSIVE when the
//     app.current_tenant_id GUC is unset, and plain `prisma` only sets that GUC
//     when AUTH_ENFORCE_TENANT_RLS=true (or NODE_ENV=production). Dev, QA and CI
//     run with it off, so RLS alone protects nothing there — and nothing testable.
//   - Postgres bypasses RLS entirely for SUPERUSER / BYPASSRLS roles even under
//     FORCE, which is how CI and several local clusters connect.
// An explicit predicate holds in every environment and can be pinned by a test.
//
// The cap is a runaway guard, not a routine trim. It is hard-clamped to the FCM
// multicast ceiling because sendPushNotification THROWS above 500 tokens — so a
// cap raised past that would flip "notify 500" into "notify nobody".

import logger from '../../logging/logger.js';
import {
  recordStaffPushRecipientsTrimmed,
  recordStaffPushZeroRecipients,
} from '../../observability/staffPushFanoutMetrics.js';

// Firebase rejects a multicast with more than 500 tokens, and
// sendPushNotification turns that into a throw. Never resolve more than this.
export const FCM_MULTICAST_LIMIT = 500;

const DEFAULT_FANOUT_CAP = FCM_MULTICAST_LIMIT;

/**
 * Effective cap: env override, clamped into [1, FCM_MULTICAST_LIMIT].
 * Clamping happens in code as well as in validateEnv so an out-of-range value
 * degrades to a safe cap instead of a thrown multicast.
 */
export function resolveFanoutCap(env = process.env) {
  const raw = Number(env.STAFF_PUSH_FANOUT_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_FANOUT_CAP;
  return Math.min(Math.floor(raw), FCM_MULTICAST_LIMIT);
}

/**
 * Resolve active staff device tokens for the given roles WITHIN one tenant.
 *
 * @param {object} client        prisma singleton or a tenant-scoped tx client
 * @param {object} opts
 * @param {string} opts.tenantId REQUIRED tenant uuid — throws if falsy, because
 *                               silently falling back to a default tenant is how
 *                               a cross-tenant delivery gets reintroduced.
 * @param {string[]} opts.roles  role names to target
 * @param {string} opts.alert    short label used for logs + metric labels
 * @returns {Promise<{tokens: string[], totalMatched: number, dropped: number}>}
 */
export async function resolveStaffPushRecipients(client, { tenantId, roles, alert }) {
  if (!tenantId) {
    throw new Error('resolveStaffPushRecipients requires tenantId');
  }
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('resolveStaffPushRecipients requires a non-empty roles array');
  }

  const cap = resolveFanoutCap();

  // COUNT(*) OVER () is evaluated BEFORE LIMIT, so total_matched is the exact
  // number of eligible recipients and (total_matched - rows.length) is the exact
  // number dropped — no LIMIT n+1 probing needed.
  //
  // Ordering is an availability PROXY, documented as such: `users` carries no
  // duty/shift/on-call column, and the one real roster table needs a ward scope
  // this path does not have. last_sign_in_at is genuinely written on staff login,
  // so never-signed-in (dormant) accounts are shed first. `id ASC` only breaks
  // ties, so ordering is fully deterministic.
  const rows = await client.$queryRawUnsafe(
    `SELECT device_token, name, COUNT(*) OVER () AS total_matched
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = ANY($2::text[])
        AND device_token IS NOT NULL
        AND is_active = TRUE
      ORDER BY last_sign_in_at DESC NULLS LAST, id ASC
      LIMIT $3::int`,
    tenantId,
    roles,
    cap,
  );

  const totalMatched = rows.length ? Number(rows[0].total_matched) : 0;
  const tokens = rows.map((r) => r.device_token).filter(Boolean);
  const dropped = Math.max(0, totalMatched - rows.length);

  if (dropped > 0) {
    logger.warn('Staff push fan-out truncated by cap — some staff were not alerted', {
      alert,
      tenantId,
      roles,
      cap,
      totalMatched,
      notified: rows.length,
      dropped,
    });
    recordStaffPushRecipientsTrimmed(alert, dropped);
  }

  // Zero recipients is NOT benign. Because users.tenant_id has a column DEFAULT
  // and several staff-onboarding paths omit it, staff can sit on the default
  // tenant while bookings are created under another — so a correctly scoped query
  // matches nobody and the alert silently never fires. Surface it loudly.
  if (tokens.length === 0) {
    logger.warn('Staff push fan-out resolved ZERO recipients — alert will not be delivered', {
      alert,
      tenantId,
      roles,
      hint: 'check users.tenant_id for these roles; staff onboarding may have left them on the default tenant',
    });
    recordStaffPushZeroRecipients(alert);
  }

  return { tokens, totalMatched, dropped };
}

export default { resolveStaffPushRecipients, resolveFanoutCap, FCM_MULTICAST_LIMIT };
