// src/utils/notifications/notificationDispatcher.js

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendEmail } from './sendEmailNotification.js';
import { notificationOutbox } from './notificationOutbox.js';
import { sendPushNotification } from './sendPushNotification.js';
import { placeVoiceCall } from './sendVoiceNotification.js';
import { sendWhatsApp } from './sendWhatsAppNotification.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
        `SELECT id, uid, phone, email, name, device_token, preferred_channel
         FROM users
         WHERE uid = $1::uuid OR phone = $1
         LIMIT 1`,
        identifier
      )
      : await prisma.$queryRawUnsafe(
        `SELECT id, uid, phone, email, name, device_token, preferred_channel
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
          const accepted = response.responses?.filter(item => item.success) || [];
          results.push = response.successCount > 0
            ? {
                outcome: 'acknowledged',
                providerReference: accepted[0]?.messageId || `fcm-accepted:${response.successCount}`,
                providerCode: response.failureCount > 0 ? 'partial_acceptance' : 'accepted',
                evidence: {
                  success_count: response.successCount,
                  failure_count: response.failureCount,
                  responses: response.responses || [],
                },
              }
            : rejected('fcm_no_token_accepted', {
                success_count: response.successCount,
                failure_count: response.failureCount,
                responses: response.responses || [],
              });
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
      const stored = await prisma.$queryRawUnsafe(
        `INSERT INTO notifications (user_id, uid, phone, title, body, type, created_at, updated_at, is_read)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, NOW(), NOW(), false)
         RETURNING id`,
        user.id, user.uid, user.phone, title, body, type
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
      results.inapp = providerReceiptMode
        ? uncertain('inapp_commit_failed', err)
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

  // SMS — plain-text fallback for feature-phone patients. No SMS gateway
  // is wired yet (smsService is dry-run), so the delivery intent is
  // persisted to the notification outbox; a future gateway integration
  // drains PENDING type='sms' rows. fix-deferred: SMS gateway integration.
  if (channels.includes('sms')) {
    if (!user.phone) {
      results.sms = providerReceiptMode ? rejected('phone_missing') : 'no_phone';
    } else if (providerReceiptMode) {
      results.sms = rejected('sms_gateway_not_configured');
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
