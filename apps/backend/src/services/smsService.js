// src/services/smsService.js
// SMS provider seam.
//
// A real gateway now sits behind this seam (migrations 699/700): per-tenant
// MSG91/Twilio provider configs with TRAI DLT identity, fail-closed template
// registrations, and a delivery-status (DLR) callback mount. The DEFAULT is
// still the dry-run logger — resolution is config-gated per tenant and every
// unconfigured/malformed state falls back to an honest
// `rejected('sms_gateway_not_configured')` (never a fake delivery).
//
// Callers: the notification-outbox drain only
// (`notificationOutboxDelivery.js`, `notificationDispatcher.js`) —
// `src/tests/unit/smsProviderSeam.test.js` fails the build if a request path
// or cron job imports this module again, and pins the export list to exactly
// ['sendSMS']. Provider adapters and resolution live in
// `utils/notifications/smsProviders/` on purpose: adding a provider never
// touches this seam.
//
// To send a patient an SMS, queue the intent:
//   import { queuePatientSms } from '../utils/notifications/smsOutbox.js';
// That leaves a durable, replayable notification_outbox row; the drain calls
// this seam and records a genuine provider receipt (609 law: SENT is
// impossible without an acknowledged receipt).

import logger from '../logging/logger.js';
import { getCurrentTenantId } from '../lib/tenantContext.js';
import { sendThroughResolvedProvider } from '../utils/notifications/smsProviders/index.js';

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
 * Send a raw SMS through the tenant's resolved provider.
 *
 * Callers: the notification-outbox drain only. Never throws — the return is
 * ALWAYS the provider-receipt shape the migration-609 ledger records:
 *   { outcome: 'acknowledged'|'rejected'|'uncertain',
 *     providerReference, providerCode, evidence }
 * `acknowledged` means accepted-for-delivery by a real gateway (the DLR
 * callback later refines it); the dry-run default classifies as
 * `rejected('sms_gateway_not_configured')`.
 *
 * @param {string} phone - Any format Indian mobile number
 * @param {string} message - Rendered plain-text message (outbox row body)
 * @param {Object} [context] - Delivery provenance from the drain
 * @param {string} [context.tenantId] - Tenant owning the outbox row (falls
 *   back to the active tenant context)
 * @param {string} [context.templateVersion] - Outbox template key, resolved
 *   against sms_template_registrations (DLT fail-closed gate)
 * @param {number} [context.outboxId] - notification_outbox id (evidence only)
 */
export async function sendSMS(phone, message, context = {}) {
  const intlPhone = normalizePhone(phone);
  if (!intlPhone) {
    logger.warn('[SMS] Invalid/missing phone, skipping');
    return {
      outcome: 'rejected',
      providerReference: null,
      providerCode: 'phone_missing',
      evidence: { invalid_phone: true },
    };
  }

  return sendThroughResolvedProvider({
    phone: intlPhone,
    message: String(message ?? ''),
    tenantId: context.tenantId || getCurrentTenantId() || null,
    templateVersion: context.templateVersion || null,
    outboxId: context.outboxId ?? null,
  });
}
