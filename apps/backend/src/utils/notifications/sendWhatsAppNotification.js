/**
 * WhatsApp notification provider (Phase E5).
 *
 * Wraps a single send call. Default behaviour: if `WHATSAPP_PROVIDER` is
 * unset (dev / test), log the intended message and return `{ status:
 * 'logged' }` — useful for CI + integration tests that don't have
 * outbound network. Production sets `WHATSAPP_PROVIDER=twilio` and the
 * matching env vars; the Twilio SDK is loaded lazily so dev environments
 * don't require it installed.
 *
 * Required env vars for Twilio:
 *   WHATSAPP_PROVIDER=twilio
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM   (e.g. 'whatsapp:+14155238886')
 */

import logger from '../../logging/logger.js';

let _twilioClient = null;

function normalisePhoneE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) {
    // India default: bare 10-digit -> +91
    if (/^\d{10}$/.test(digits)) return `+91${digits}`;
    return null;
  }
  return digits;
}

function maskPhoneForLog(e164) {
  if (!e164) return '<unknown>';
  return e164.length > 6 ? `${e164.slice(0, 3)}***${e164.slice(-3)}` : '<short>';
}

async function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for WHATSAPP_PROVIDER=twilio');
  }
  // Lazy import keeps Twilio off the cold-start path; the .catch
  // covers slim runtimes that prune the dep.
  const mod = await import('twilio').catch(() => null);
  if (!mod) {
    throw new Error('twilio package is not installed; run `npm i twilio` to enable WhatsApp via Twilio');
  }
  _twilioClient = mod.default(sid, token);
  return _twilioClient;
}

/**
 * Send a WhatsApp message.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (E.164 or 10-digit Indian)
 * @param {string} options.body - Message body
 * @param {string[]} [options.mediaUrl] - Optional media attachments
 * @returns {Promise<{ status: 'sent'|'logged', sid?: string }>}
 */
export async function sendWhatsApp({ to, body, mediaUrl = [] }) {
  if (!to || !body) {
    throw new Error('sendWhatsApp requires to and body');
  }
  const e164 = normalisePhoneE164(to);
  if (!e164) {
    logger.warn('sendWhatsApp: phone number not resolvable to E.164', { masked: maskPhoneForLog(to) });
    return { status: 'invalid_phone' };
  }

  const provider = (process.env.WHATSAPP_PROVIDER || 'logger').toLowerCase();
  if (provider === 'logger') {
    logger.info('WhatsApp [logger]: would send message', {
      to: maskPhoneForLog(e164), body: body.slice(0, 80), media_count: mediaUrl.length,
    });
    return { status: 'logged' };
  }

  if (provider === 'twilio') {
    const from = process.env.TWILIO_WHATSAPP_FROM;
    if (!from) {
      throw new Error('TWILIO_WHATSAPP_FROM is required for Twilio WhatsApp');
    }
    const client = await getTwilioClient();
    const message = await client.messages.create({
      from, to: `whatsapp:${e164}`, body, mediaUrl,
    });
    return { status: 'sent', sid: message.sid };
  }

  throw new Error(`Unknown WHATSAPP_PROVIDER: ${provider}`);
}

export const __testing__ = { normalisePhoneE164, maskPhoneForLog };

export default { sendWhatsApp };
