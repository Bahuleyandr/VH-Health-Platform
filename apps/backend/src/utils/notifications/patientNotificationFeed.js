// src/utils/notifications/patientNotificationFeed.js
//
// The readable copy behind a privacy-stripped push.
//
// Every NORMAL-priority push this platform sends is transported as a private
// envelope: `sendPushNotification` replaces the FCM notification block with
// the generic "You have a new update. Open the app to view it." and replaces
// the WHOLE data payload with `createPrivatePushEnvelope()` — four keys whose
// only destination is `route: '/notifications'`
// (sendPushNotification.js:36-43 and :116-135). The push therefore carries no
// readable content and no per-feature deep link of its own.
//
// That makes a matching `notifications` feed row MANDATORY, not optional: the
// row IS the message. An emitter that pushes without writing one buzzes the
// patient into an empty inbox — a notification that leads nowhere.
//
// The reference implementation is `notifyPatientResultRecipients`
// (services/lab/labResultsService.js): queue/send the transport, then insert
// one `notifications` row per recipient with the tenant bound EXPLICITLY.
// This module is that insert, factored out so the other patient-facing
// emitters cannot drift from it. Which emitters those are is not restated
// here — src/tests/unit/patientPushFeedRowCensus.test.js enumerates every
// emission site in the tree (direct push, outbox queue(), and raw
// notification_outbox insert) and checks the list against a source scan in
// both directions.
//
// ── Two contracts callers depend on ────────────────────────────────────────
//
// 1. NEVER THROWS. Every call site is a post-commit, fire-and-forget tail on
//    a clinical, scheduling, or result-delivery write whose primary effect is
//    already durable. A feed-row failure is logged and swallowed here so it
//    can never become a new failing path on a write that must not fail.
//
// 2. tenant_id is ALWAYS bound explicitly. `notifications.tenant_id` DEFAULTs
//    to a GUC-reading expression that falls back to the LITERAL default tenant
//    whenever `app.current_tenant_id` is unset, empty, or 'bypass' — which is
//    every cron, every bare transaction, and all of dev/QA/CI. The patient's
//    inbox reader filters `AND n.tenant_id = $n`, so a defaulted row is
//    invisible to its own recipient. Lane I swept every INSERT INTO
//    notifications to carry tenant_id explicitly; this module preserves that.
//
// The `type` string must be one the patient app's inbox actually routes —
// apps/patient/lib/features/notifications/screens/notifications_screen.dart
// `_handleNotificationTap`. A row with an unrouted type is not better than no
// row in any way that matters: it renders, and tapping it only marks it read.
// It must also be a LITERAL at the call site —
// src/tests/unit/patientInboxTypeRouting.test.js parses the routed set out of
// that Dart switch and checks every `type:` literal passed to this function
// against it, which it cannot do for a variable.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../phoneUtils.js';
import { resolveChannelsForOutboxRow } from './tenantNotificationChannels.js';

// notifications.phone is VARCHAR(15) NOT NULL. A normalized Indian number is
// 13 chars; the column cannot hold the full 16-char upper bound isValidPhone
// permits. Truncating keeps the redundant lookup key lossy rather than
// failing the insert with 22001 — uid and user_id are the primary match keys
// in buildOwnNotificationCondition, so a clipped phone still resolves.
const PHONE_COLUMN_MAX = 15;

// Placeholder for a patient with no phone on file. Matches the convention
// already used by InvestigationNotificationJob. Safe as a lookup key because
// the inbox reader only adds its `phone = $n` clause when the caller HAS a
// phone, so a placeholder can never collide two patients' feeds.
const PHONE_PLACEHOLDER = 'unknown';

function phoneColumnValue(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return PHONE_PLACEHOLDER;
  return normalized.slice(0, PHONE_COLUMN_MAX);
}

/**
 * Resolve the identity columns the inbox reader matches on
 * (`uid` OR `user_id` OR `phone`) from whatever the caller happens to hold.
 *
 * Returns null when the recipient cannot be resolved at all — the caller then
 * skips the insert rather than writing an unreachable row.
 */
async function resolveRecipient({ tenantId, userId, uid, phone }) {
  const haveUid = typeof uid === 'string' && uid.trim() !== '';
  const haveUserId = userId !== null && userId !== undefined && String(userId).trim() !== '';
  if (haveUid && haveUserId && phone) {
    return { id: Number(userId), uid: String(uid).trim(), phone };
  }
  if (!haveUid && !haveUserId) return null;

  const identifier = haveUserId ? String(userId) : String(uid).trim();
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid::text AS uid, phone
       FROM users
      WHERE tenant_id = $1::uuid
        AND (id::text = $2 OR uid::text = $2)
      LIMIT 1`,
    tenantId,
    identifier,
  );
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, uid: row.uid, phone: phone || row.phone };
}

/**
 * Write the in-app feed row that a privacy-stripped patient push points at.
 *
 * @param {Object} options
 * @param {string} options.tenantId       Tenant the recipient belongs to. Bound
 *   explicitly onto the row — see the header note. Required.
 * @param {number|string} [options.userId]  users.id (or uid) of the recipient.
 * @param {string} [options.uid]            users.uid, when already known.
 * @param {string} [options.phone]          Recipient phone, when already known.
 * @param {string} options.title            Inbox headline.
 * @param {string} options.body             Inbox body — the message the patient
 *   never received over FCM because the push was privacy-stripped.
 * @param {string} options.type             Feed type. MUST be routed by the
 *   patient app's inbox tap handler (see header).
 * @param {Object} [options.data]           JSON payload for the row.
 * @param {string} [options.priority]       notifications.priority. Default NORMAL.
 * @param {string} [options.context]        Label used in the failure log line.
 * @returns {Promise<boolean>} true when a row was written; false otherwise.
 *   Never rejects.
 */
export async function recordPatientFeedNotification({
  tenantId,
  userId = null,
  uid = null,
  phone = null,
  title,
  body,
  type,
  data = {},
  priority = 'NORMAL',
  context = 'patient-notification',
} = {}) {
  try {
    const tid = String(tenantId || '').trim();
    if (!tid) {
      logger.warn(`[patient inbox] ${context}: no tenant — in-app row NOT written`);
      return false;
    }
    const recipient = await resolveRecipient({ tenantId: tid, userId, uid, phone });
    if (!recipient) {
      logger.warn(`[patient inbox] ${context}: recipient not resolvable — in-app row NOT written`);
      return false;
    }

    await prisma.$executeRawUnsafe(
      // tenant_id bound explicitly ($8) — never left to the column DEFAULT.
      `INSERT INTO notifications
         (tenant_id, uid, user_id, phone, title, body, type, priority,
          data, is_read, created_at, updated_at)
       VALUES ($8::uuid, $1::uuid, $2::int, $3, $4, $5, $6,
               $7, $9::jsonb, false, NOW(), NOW())`,
      recipient.uid,
      recipient.id,
      phoneColumnValue(recipient.phone),
      String(title || '').slice(0, 255),
      String(body || ''),
      String(type || 'general'),
      String(priority || 'NORMAL').toUpperCase(),
      tid,
      JSON.stringify(data && typeof data === 'object' ? data : {}),
    );
    return true;
  } catch (err) {
    // Contract 1: this tail can never fail the write that triggered it.
    logger.warn(`[patient inbox] ${context}: in-app row insert failed — ${err.message}`);
    return false;
  }
}

/**
 * Would the outbox drain already write the in-app `notifications` row for this
 * intent? It does exactly when the resolved channel set contains `inapp` — the
 * drain then routes through `dispatch()`, whose inapp branch commits the row
 * (and, since the transport-type translation in tenantNotificationChannels.js,
 * commits it under the type the patient inbox routes rather than the outbox
 * row's transport type). Asking first is what keeps a queue-time
 * `recordPatientFeedNotification` from producing a SECOND inbox row for a
 * tenant that has already configured `inapp`.
 *
 * `tenants.settings.notificationChannels` has no dedicated writer in the
 * product — no admin UI field, no seed, no migration sets it. The only way it
 * gets a value is the generic tenant-settings patch
 * (`PATCH /api/v1/admin/tenants/:tenantId` → `updateTenant`), which replaces
 * the whole generic settings object with whatever JSON the operator sends. So
 * the configured branch is reachable but unset by default: the default
 * resolution is the legacy channel set, which writes nothing.
 *
 * NEVER THROWS, and defaults to `false` on any error: a duplicated row is a
 * cosmetic defect, a missing one is the dead-end buzz these helpers exist to
 * remove.
 *
 * @param {Object} row Outbox-row shape — `{ tenant_id, type, recipient_id,
 *   recipient_phone, payload }`. Only the fields
 *   `resolveChannelsForOutboxRow` reads matter.
 * @returns {Promise<boolean>}
 */
export async function outboxDrainWillWriteFeedRow(row = {}) {
  try {
    // Imported lazily. Five modules (four appointment/booking controllers and
    // the reminder job) import this file statically, and tenantSettingsService
    // pulls tenantService in behind it. Keeping that off the load-time graph
    // is what stops a unit test that stubs tenantService for a controller from
    // failing on an export it never needed — which is exactly what a static
    // import here did to appointmentRescheduleNotification.test.js.
    const { getTenantSettings } = await import('../../services/tenant/tenantSettingsService.js');
    const settings = await getTenantSettings(row.tenant_id);
    return resolveChannelsForOutboxRow(row, settings).channels.includes('inapp');
  } catch {
    return false;
  }
}

export default { recordPatientFeedNotification, outboxDrainWillWriteFeedRow };
