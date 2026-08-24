// src/utils/notifications/notificationDispatcher.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import { requireTenantId } from '../../services/tenant/tenantService.js';
import { sendSMS } from '../../services/smsService.js';
import { sendEmail } from './sendEmailNotification.js';
import { notificationOutbox } from './notificationOutbox.js';
import { sendPushNotification } from './sendPushNotification.js';
import { placeVoiceCall } from './sendVoiceNotification.js';
import { sendWhatsApp } from './sendWhatsAppNotification.js';
import { classifyFcmProviderResponse } from './terminalRejectionCodes.js';

const SMS_OUTCOMES = new Set(['acknowledged', 'rejected', 'uncertain']);

/** Defensive pass-through: sendSMS already returns the receipt shape; a
 * malformed/absent result must classify as uncertain, never acknowledged. */
function normalizeSmsProviderResult(result) {
  if (result && typeof result === 'object' && SMS_OUTCOMES.has(result.outcome)) {
    return {
      outcome: result.outcome,
      providerReference: result.providerReference || null,
      providerCode: result.providerCode || null,
      evidence: result.evidence && typeof result.evidence === 'object' ? result.evidence : {},
    };
  }
  return {
    outcome: 'uncertain',
    providerReference: null,
    providerCode: 'sms_provider_result_missing',
    evidence: {},
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tenant to stamp on the in-app `notifications` row.
 *
 * `notifications.tenant_id` DEFAULTs to the GUC-reading expression migration
 * 310 installed, which falls back to the LITERAL default tenant whenever
 * `app.current_tenant_id` is unset, empty, or `'bypass'`. That covers every
 * path this dispatcher actually runs on outside a request with RLS
 * enforcement on: a bare `prisma.$transaction`, a SUPER_ADMIN bypass context,
 * a cron that never entered `runInTenantContext`, and all of dev/QA/CI (where
 * `AUTH_ENFORCE_TENANT_RLS` is off so the prisma wrapper never issues the
 * GUC at all). In each of those the row lands on the default tenant and is
 * invisible to the recipient, whose reader filters
 * `WHERE ... AND tenant_id = $n` (notificationService). CRITICAL vital-sign
 * alerts route through here, so the tenant is bound explicitly — the provable
 * form (PR #684 house rule) rather than relying on session context.
 *
 * Context wins over the recipient row because the caller's tenant is what the
 * RLS WITH CHECK will be evaluated against; a recipient resolved into a
 * DIFFERENT tenant is a cross-tenant misroute, not something to paper over, so
 * it is refused terminally instead of being written into either tenant.
 */
function resolveInAppTenantId(user) {
  const contextTenant = String(getCurrentTenantId() || '').trim();
  const recipientTenant = String(user?.tenant_id || '').trim();
  if (contextTenant && recipientTenant
      && contextTenant.toLowerCase() !== recipientTenant.toLowerCase()) {
    throw Object.assign(
      new Error('Recipient belongs to a different tenant than the dispatch context'),
      { code: 'recipient_tenant_mismatch' },
    );
  }
  // Fails closed on no tenant at all unless ALLOW_DEFAULT_TENANT sanctions the
  // single-tenant default (W1 no-default-tenant-fallback rule).
  return requireTenantId(contextTenant || recipientTenant || null);
}

/**
 * Unified notification dispatcher.
 * Each channel is best-effort — failures don't block other channels.
 *
 * @param {Object} options
 * @param {string} options.userId - User UID or phone for lookup
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body
 * @param {string[]} options.channels - Array of channels: 'push' | 'email' |
 *   'inapp' | 'whatsapp' | 'voice' | 'sms' | 'print'
 * @param {Object} [options.data] - Extra data for push notifications
 * @param {string} [options.type] - Notification type for in-app storage
 * @param {string} [options.voiceLanguage] - TTS language override (e.g. 'hi-IN')
 * @param {Object} [options.smsContext] - Drain-supplied SMS delivery
 *   provenance ({ tenantId, templateVersion, outboxId }) forwarded to the
 *   provider seam so the adapter can resolve tenant config + DLT template
 *   registration. Only set on the providerReceiptMode outbox-drain path.
 */
export async function dispatch({
  userId,
  title,
  body,
  channels = ['push', 'inapp'],
  data = {},
  type = 'general',
  voiceLanguage = null,
  providerReceiptMode = false,
  smsContext = null,
}) {
  const results = {};

  const rejected = (code, evidence = {}) => ({
    outcome: 'rejected', providerReference: null, providerCode: code, evidence,
  });
  const uncertain = (code, err) => ({
    outcome: 'uncertain',
    providerReference: null,
    providerCode: code,
    evidence: { message: String(err?.message || err || code).slice(0, 500) },
  });
  const recordLookupFailure = (factory) => {
    if (providerReceiptMode) {
      for (const channel of channels) results[channel] = factory(channel);
    }
    return results;
  };

  // Lookup user info
  let user = null;
  try {
    const identifier = String(userId || '').trim();
    if (!identifier) {
      return recordLookupFailure(() => rejected('recipient_identifier_missing'));
    }

    const res = UUID_RE.test(identifier)
      ? await prisma.$queryRawUnsafe(
        `SELECT id, uid, phone, email, name, device_token, preferred_channel, tenant_id
         FROM users
         WHERE uid = $1::uuid OR phone = $1
         LIMIT 1`,
        identifier
      )
      : await prisma.$queryRawUnsafe(
        `SELECT id, uid, phone, email, name, device_token, preferred_channel, tenant_id
         FROM users
         WHERE id::text = $1 OR phone = $1
         LIMIT 1`,
        identifier
      );
    user = res[0] || null;
  } catch (err) {
    logger.error(`Notification dispatch: failed to lookup user ${userId} — ${err.message}`);
    return recordLookupFailure(() => uncertain('recipient_lookup_failed', err));
  }

  if (!user) {
    logger.warn(`Notification dispatch: user not found — ${userId}`);
    return recordLookupFailure(() => rejected('recipient_not_found'));
  }

  // Push notification
  if (channels.includes('push')) {
    try {
      if (user.device_token) {
        const response = await sendPushNotification({
          tokens: user.device_token,
          title,
          body,
          data,
        });
        if (providerReceiptMode) {
          results.push = classifyFcmProviderResponse(response);
        } else {
          results.push = 'sent';
        }
      } else {
        results.push = providerReceiptMode ? rejected('fcm_token_missing') : 'no_token';
      }
    } catch (err) {
      logger.error(`Notification dispatch [push] failed for ${userId}: ${err.message}`);
      results.push = providerReceiptMode
        ? uncertain(err.code || 'fcm_transport_failure', err)
        : 'error';
    }
  }

  // Email notification
  if (channels.includes('email')) {
    try {
      if (user.email) {
        const response = await sendEmail({
          to: user.email,
          subject: title,
          text: body,
          html: `<p>${body}</p>`,
          receiptMode: providerReceiptMode,
        });
        if (providerReceiptMode) {
          results.email = response?.outcome === 'rejected'
            ? rejected(response.code || 'smtp_rejected')
            : {
                outcome: 'acknowledged',
                providerReference: response?.messageId,
                providerCode: 'accepted',
                evidence: {
                  accepted: response?.accepted || [],
                  rejected: response?.rejected || [],
                  response: response?.response || null,
                },
              };
        } else {
          results.email = 'sent';
        }
      } else {
        results.email = providerReceiptMode ? rejected('email_address_missing') : 'no_email';
      }
    } catch (err) {
      logger.error(`Notification dispatch [email] failed for ${userId}: ${err.message}`);
      results.email = providerReceiptMode
        ? uncertain(err.code || 'smtp_transport_failure', err)
        : 'error';
    }
  }

  // In-app notification
  if (channels.includes('inapp')) {
    try {
      const inAppTenantId = resolveInAppTenantId(user);
      const stored = await prisma.$queryRawUnsafe(
        // tenant_id is bound explicitly ($7) rather than left to the column
        // DEFAULT — see resolveInAppTenantId above for why the DEFAULT is not
        // enough on the paths this dispatcher runs on.
        `INSERT INTO notifications (tenant_id, user_id, uid, phone, title, body, type, created_at, updated_at, is_read)
         VALUES ($7::uuid, $1, $2::uuid, $3, $4, $5, $6, NOW(), NOW(), false)
         RETURNING id`,
        user.id, user.uid, user.phone, title, body, type, inAppTenantId
      );
      results.inapp = providerReceiptMode
        ? {
            outcome: 'acknowledged',
            providerReference: `notification:${stored[0].id}`,
            providerCode: 'committed',
            evidence: { notification_id: String(stored[0].id) },
          }
        : 'stored';
    } catch (err) {
      logger.error(`Notification dispatch [inapp] failed for ${userId}: ${err.message}`);
      // A tenant mismatch is terminal — a retry re-derives the same two tenants,
      // so it must not be classified `uncertain` and re-queued forever.
      results.inapp = providerReceiptMode
        ? (err?.code === 'recipient_tenant_mismatch'
          ? rejected('recipient_tenant_mismatch')
          : uncertain('inapp_commit_failed', err))
        : 'error';
    }
  }

  // WhatsApp (Phase E5)
  if (channels.includes('whatsapp')) {
    if (!user.phone) {
      results.whatsapp = providerReceiptMode ? rejected('phone_missing') : 'no_phone';
    } else {
      try {
        const out = await sendWhatsApp({ to: user.phone, body: `${title}\n${body}` });
        results.whatsapp = providerReceiptMode
          ? out.status === 'sent' && out.sid
            ? {
                outcome: 'acknowledged', providerReference: out.sid,
                providerCode: 'accepted', evidence: { status: out.status },
              }
            : rejected(`whatsapp_${out.status || 'not_sent'}`)
          : out.status;
      } catch (err) {
        logger.error(`Notification dispatch [whatsapp] failed for ${userId}: ${err.message}`);
        results.whatsapp = providerReceiptMode
          ? uncertain(err.code || 'whatsapp_transport_failure', err)
          : 'error';
      }
    }
  }

  // Voice (Phase E5)
  if (channels.includes('voice')) {
    if (!user.phone) {
      results.voice = providerReceiptMode ? rejected('phone_missing') : 'no_phone';
    } else {
      try {
        const out = await placeVoiceCall({
          to: user.phone, message: `${title}. ${body}`, language: voiceLanguage,
        });
        results.voice = providerReceiptMode
          ? out.status === 'sent' && out.sid
            ? {
                outcome: 'acknowledged', providerReference: out.sid,
                providerCode: 'accepted', evidence: { status: out.status },
              }
            : rejected(`voice_${out.status || 'not_sent'}`)
          : out.status;
      } catch (err) {
        logger.error(`Notification dispatch [voice] failed for ${userId}: ${err.message}`);
        results.voice = providerReceiptMode
          ? uncertain(err.code || 'voice_transport_failure', err)
          : 'error';
      }
    }
  }

  // SMS — plain-text fallback for feature-phone patients. Direct callers
  // queue a durable outbox intent; the outbox drain re-enters this function
  // in providerReceiptMode with smsContext, and only THAT path calls the
  // provider seam (sendSMS resolves the tenant's configured gateway; the
  // dry-run default classifies as rejected('sms_gateway_not_configured')).
  if (channels.includes('sms')) {
    if (!user.phone) {
      results.sms = providerReceiptMode ? rejected('phone_missing') : 'no_phone';
    } else if (providerReceiptMode) {
      try {
        const out = await sendSMS(
          user.phone,
          `${title ? `${title}: ` : ''}${body}`,
          smsContext && typeof smsContext === 'object' ? smsContext : {},
        );
        results.sms = normalizeSmsProviderResult(out);
      } catch (err) {
        logger.error(`Notification dispatch [sms] failed for ${userId}: ${err.message}`);
        results.sms = uncertain(err.code || 'sms_transport_failure', err);
      }
    } else {
      try {
        const queued = await notificationOutbox.queue({
          type: 'sms',
          recipientId: user.id,
          recipientPhone: user.phone,
          title,
          body,
          data: { ...data, type },
        });
        results.sms = queued ? 'queued' : 'error';
      } catch (err) {
        logger.error(`Notification dispatch [sms] failed for ${userId}: ${err.message}`);
        results.sms = 'error';
      }
    }
  }

  // Print — counter-pickup / printed-handout fallback for patients with
  // no usable digital channel at all (no smartphone, no phone on file).
  // Persisted as a print intent in the outbox; front-desk tooling drains
  // type='print' rows to a printer queue. fix-deferred: print-queue
  // gateway integration.
  if (channels.includes('print')) {
    if (providerReceiptMode) {
      results.print = rejected('print_queue_not_configured');
    } else try {
      const queued = await notificationOutbox.queue({
        type: 'print',
        recipientId: user.id,
        recipientPhone: user.phone || null,
        title,
        body,
        data: { ...data, type, patient_uid: user.uid },
      });
      results.print = queued ? 'queued' : 'error';
    } catch (err) {
      logger.error(`Notification dispatch [print] failed for ${userId}: ${err.message}`);
      results.print = 'error';
    }
  }

  return results;
}

/**
 * Map a patient's `users.preferred_channel` to a dispatcher channel
 * list. Patients on a feature phone (or no phone at all) can't receive
 * a silent FCM push — this routes them to SMS or a printed handout so
 * post-discharge / result-ready information actually reaches them.
 *   app   → push + in-app    (smartphone patient — the default)
 *   sms   → SMS + in-app     (feature phone)
 *   print → print + in-app   (no phone / counter pickup)
 *   none  → in-app only      (patient opted out of outbound contact)
 * Finding 2026-05-09-inpatient-admission-patient-no-smartphone-no-alternative-channel
 * + 2026-05-09-lab-walk-in-patient-no-smartphone-no-alternative.
 */
export function resolveDeliveryChannels(preferredChannel) {
  switch (String(preferredChannel || 'app').toLowerCase()) {
    case 'sms': return ['sms', 'inapp'];
    case 'print': return ['print', 'inapp'];
    case 'none': return ['inapp'];
    case 'app':
    default: return ['push', 'inapp'];
  }
}

/**
 * Preference-aware dispatch. Looks up the patient's `preferred_channel`
 * and dispatches over the matching channels (including the SMS / print
 * fallbacks above). Use this for any patient-facing notification that
 * must reach non-smartphone patients — discharge follow-up reminders,
 * lab-result-ready, bill issued. Falls back to 'app' if the lookup
 * fails so a transient DB error never silences a notification entirely.
 */
export async function dispatchToPatient({ userId, title, body, data = {}, type = 'general' }) {
  let preferred = 'app';
  try {
    const identifier = String(userId || '').trim();
    if (identifier) {
      const rows = UUID_RE.test(identifier)
        ? await prisma.$queryRawUnsafe(
          `SELECT preferred_channel FROM users WHERE uid = $1::uuid OR phone = $1 LIMIT 1`,
          identifier,
        )
        : await prisma.$queryRawUnsafe(
          `SELECT preferred_channel FROM users WHERE id::text = $1 OR phone = $1 LIMIT 1`,
          identifier,
        );
      if (rows[0]?.preferred_channel) preferred = rows[0].preferred_channel;
    }
  } catch (err) {
    logger.warn(`dispatchToPatient: preferred_channel lookup failed for ${userId} — ${err.message}; defaulting to app`);
  }
  return dispatch({
    userId, title, body, channels: resolveDeliveryChannels(preferred), data, type,
  });
}
