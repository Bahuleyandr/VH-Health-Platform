// src/utils/notifications/smsProviders/twilioSmsProvider.js
//
// Twilio programmable-SMS adapter (Phase E5 sendWhatsAppNotification idiom:
// lazy SDK import so slim runtimes without the dep still boot; the adapter is
// only reached when a tenant/env explicitly configures twilio). India traffic
// still rides DLT — Twilio-side DLT registration is the tenant's concern, and
// the platform's fail-closed sms_template_registrations gate (checked BEFORE
// this adapter is called) guarantees no unregistered template kind is sent.
//
// Classification contract:
//   * messages.create resolves with a sid → acknowledged (accepted-for-
//     delivery; Twilio's status callback refines it later via the DLR mount).
//   * Twilio 4xx REST error (invalid number, blocked sender, …) → rejected
//     with the Twilio error code.
//   * Anything else (network fault, 5xx, missing SDK) → uncertain.

import { normalizeIndianSmsPhone } from '../../phoneUtils.js';

function normalisePhoneE164(phone) {
  const normalized = normalizeIndianSmsPhone(phone);
  return normalized ? `+${normalized}` : null;
}

export async function sendViaTwilioSms({ accountSid, authToken, from, phone, message }) {
  if (!accountSid || !authToken || !from) {
    return {
      outcome: 'rejected',
      providerReference: null,
      providerCode: 'sms_config_credentials_unreadable',
      evidence: {
        provider: 'twilio',
        missing: [
          !accountSid && 'account_sid',
          !authToken && 'auth_token',
          !from && 'from',
        ].filter(Boolean),
      },
    };
  }

  const e164 = normalisePhoneE164(phone);
  if (!e164) {
    return {
      outcome: 'rejected',
      providerReference: null,
      providerCode: 'phone_missing',
      evidence: { provider: 'twilio', invalid_phone: true },
    };
  }

  const mod = await import('twilio').catch(() => null);
  if (!mod) {
    return {
      outcome: 'uncertain',
      providerReference: null,
      providerCode: 'twilio_sdk_unavailable',
      evidence: { provider: 'twilio', message: 'twilio package is not installed' },
    };
  }

  try {
    const client = mod.default(accountSid, authToken);
    const created = await client.messages.create({ from, to: e164, body: String(message) });
    if (created?.sid) {
      return {
        outcome: 'acknowledged',
        providerReference: String(created.sid),
        providerCode: 'accepted',
        evidence: { provider: 'twilio', status: created.status ?? null },
      };
    }
    return {
      outcome: 'uncertain',
      providerReference: null,
      providerCode: 'twilio_no_acceptance_unresolved',
      evidence: { provider: 'twilio', status: created?.status ?? null },
    };
  } catch (err) {
    const httpStatus = Number(err?.status);
    if (httpStatus >= 400 && httpStatus < 500) {
      const errorCode = /^\d{1,6}$/.test(String(err?.code ?? '')) ? String(err.code) : null;
      return {
        outcome: 'rejected',
        providerReference: null,
        providerCode: errorCode ? `twilio_${errorCode}` : `twilio_http_${httpStatus}`,
        evidence: {
          provider: 'twilio',
          http_status: httpStatus,
          error_code: errorCode,
        },
      };
    }
    return {
      outcome: 'uncertain',
      providerReference: null,
      providerCode: 'twilio_transport_failure',
      evidence: { provider: 'twilio', error_name: String(err?.name || 'Error').slice(0, 40) },
    };
  }
}

export default { sendViaTwilioSms };
