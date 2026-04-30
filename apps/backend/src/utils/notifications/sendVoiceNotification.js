/**
 * Voice notification provider (Phase E5).
 *
 * Places a TTS-driven outbound call. Default behaviour: if
 * `VOICE_PROVIDER` is unset (dev / test), log the call intent and return
 * `{ status: 'logged' }`. Production sets `VOICE_PROVIDER=twilio` and
 * the matching env vars.
 *
 * Required env vars for Twilio:
 *   VOICE_PROVIDER=twilio
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_VOICE_FROM     (E.164 phone number)
 *   VOICE_DEFAULT_LANGUAGE (optional; e.g. 'en-IN', 'hi-IN', 'ta-IN')
 */

import logger from '../../logging/logger.js';

let _twilioClient = null;

function normalisePhoneE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, '');
  if (!digits.startsWith('+')) {
    if (/^\d{10}$/.test(digits)) return `+91${digits}`;
    return null;
  }
  return digits;
}

function maskPhoneForLog(e164) {
  if (!e164) return '<unknown>';
  return e164.length > 6 ? `${e164.slice(0, 3)}***${e164.slice(-3)}` : '<short>';
}

function buildTwiml(message, language = 'en-IN') {
  // Trim message to avoid pathological TTS payloads.
  const safe = String(message).slice(0, 1000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="${language}">${safe}</Say></Response>`;
}

async function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for VOICE_PROVIDER=twilio');
  }
  // Lazy import — same pattern as sendWhatsAppNotification.
  const mod = await import('twilio').catch(() => null);
  if (!mod) {
    throw new Error('twilio package is not installed; run `npm i twilio` to enable voice via Twilio');
  }
  _twilioClient = mod.default(sid, token);
  return _twilioClient;
}

/**
 * Place an outbound voice call with a TTS message.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient phone (E.164 or 10-digit Indian)
 * @param {string} options.message - The text the TTS engine will read
 * @param {string} [options.language] - Override the default language
 * @returns {Promise<{ status: 'sent'|'logged', sid?: string }>}
 */
export async function placeVoiceCall({ to, message, language = null }) {
  if (!to || !message) {
    throw new Error('placeVoiceCall requires to and message');
  }
  const e164 = normalisePhoneE164(to);
  if (!e164) {
    logger.warn('placeVoiceCall: phone number not resolvable to E.164', { masked: maskPhoneForLog(to) });
    return { status: 'invalid_phone' };
  }
  const lang = language || process.env.VOICE_DEFAULT_LANGUAGE || 'en-IN';
  const twiml = buildTwiml(message, lang);

  const provider = (process.env.VOICE_PROVIDER || 'logger').toLowerCase();
  if (provider === 'logger') {
    logger.info('Voice [logger]: would place call', {
      to: maskPhoneForLog(e164), language: lang, message_preview: String(message).slice(0, 80),
    });
    return { status: 'logged' };
  }

  if (provider === 'twilio') {
    const from = process.env.TWILIO_VOICE_FROM;
    if (!from) {
      throw new Error('TWILIO_VOICE_FROM is required for Twilio voice');
    }
    const client = await getTwilioClient();
    const call = await client.calls.create({ from, to: e164, twiml });
    return { status: 'sent', sid: call.sid };
  }

  throw new Error(`Unknown VOICE_PROVIDER: ${provider}`);
}

export const __testing__ = { normalisePhoneE164, maskPhoneForLog, buildTwiml };

export default { placeVoiceCall };
