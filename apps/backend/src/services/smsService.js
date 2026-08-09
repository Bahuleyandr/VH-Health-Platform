// src/services/smsService.js
// SMS provider seam.
//
// No external SMS provider is configured. `sendSMS` logs a dry-run event and
// nothing leaves the box, so it has NO runtime caller by design: the
// notification-outbox drain resolves an `sms` attempt to
// `rejected('sms_gateway_not_configured')` without pretending to send
// (`notificationOutboxDelivery.js`, `notificationDispatcher.js`). This module
// is the slot a real gateway drops into — at that point the drain's sms
// branch calls sendSMS and records a genuine provider receipt.
//
// To send a patient an SMS, queue the intent:
//   import { queuePatientSms } from '../utils/notifications/smsOutbox.js';
// That leaves a durable, replayable notification_outbox row instead of a log
// line that looks like a delivery (audit 2026-08-09 finding F7).
// `src/tests/unit/smsProviderSeam.test.js` fails the build if a request path
// or cron job starts importing this module again.
//
// fix-deferred: SMS gateway integration — wire the provider inside sendSMS.

import logger from '../logging/logger.js';

import { maskPhoneForLog } from '../utils/logMasking.js';
/**
 * Normalize a phone number to intl format (91XXXXXXXXXX)
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '').replace(/^0+/, '').replace(/^91/, '');
  if (digits.length < 10) return null;
  return `91${digits.slice(-10)}`;
}

/**
 * Send a raw SMS.
 *
 * Callers: the notification-outbox drain only. Returns nothing and resolves
 * even when no provider is configured — the outbox layer, not this function,
 * decides what an unconfigured channel means for the delivery ledger.
 *
 * @param {string} phone - Any format Indian mobile number
 * @param {string} message - Plain text message
 */
export async function sendSMS(phone, message) {
  const intlPhone = normalizePhone(phone);
  if (!intlPhone) {
    logger.warn('[SMS] Invalid/missing phone, skipping');
    return;
  }

  logger.info(`[SMS DRY RUN] To: ${maskPhoneForLog(intlPhone)} | ${message}`);
}
