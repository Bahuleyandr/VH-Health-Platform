// src/utils/notifications/smsProviders/msg91Provider.js
//
// MSG91 transactional SMS adapter (v2 sendsms JSON API). The outbox stores a
// fully RENDERED message body, so the adapter uses the send-text API with the
// registered DLT content template id attached (`DLT_TE_ID`) rather than the
// flow API's server-side templating — MSG91 relays the text to the operator
// with the DLT template reference, and the operator verifies the content
// against the registered template. The provider-side flow id (when a tenant
// uses flows) travels in sms_template_registrations.provider_template_id and
// is forwarded as the campaign hint; the DLT id remains mandatory.
//
// Classification contract (the receipt shape the 609 ledger records):
//   * HTTP 2xx + { type: 'success', message: '<requestId>' } → acknowledged
//     (accepted-for-delivery; the DLR callback refines it later). The
//     request id is the provider reference the DLR correlates on.
//   * HTTP 2xx + { type: 'error' } or HTTP 4xx → rejected (auth/DLT/route
//     errors — retrying the same request cannot succeed).
//   * HTTP 5xx / network fault / malformed response → uncertain (the send
//     may or may not have been accepted; never claim either way).

import logger from '../../../logging/logger.js';
import { maskPhoneForLog } from '../../logMasking.js';

const MSG91_SEND_URL = 'https://api.msg91.com/api/v2/sendsms';

function evidenceFrom(status, body) {
  return {
    http_status: status ?? null,
    provider: 'msg91',
    response: body && typeof body === 'object'
      ? { type: body.type ?? null, code: body.code ?? null, message: String(body.message ?? '').slice(0, 300) }
      : { raw: String(body ?? '').slice(0, 300) },
  };
}

export async function sendViaMsg91({
  authKey, senderId, dltTemplateId, providerTemplateId, phone, message,
}) {
  if (!authKey || !senderId || !dltTemplateId) {
    return {
      outcome: 'rejected',
      providerReference: null,
      providerCode: 'sms_config_credentials_unreadable',
      evidence: {
        provider: 'msg91',
        missing: [
          !authKey && 'auth_key',
          !senderId && 'sender_id',
          !dltTemplateId && 'dlt_template_id',
        ].filter(Boolean),
      },
    };
  }

  const payload = {
    sender: senderId,
    route: '4', // transactional
    country: '91',
    DLT_TE_ID: String(dltTemplateId),
    ...(providerTemplateId ? { flow_id: String(providerTemplateId) } : {}),
    sms: [{ message: String(message), to: [String(phone)] }],
  };

  let response;
  try {
    response = await fetch(MSG91_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authkey: authKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      outcome: 'uncertain',
      providerReference: null,
      providerCode: 'msg91_transport_failure',
      evidence: { provider: 'msg91', message: String(err?.message || err).slice(0, 300) },
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.ok && body && body.type === 'success' && body.message) {
    return {
      outcome: 'acknowledged',
      providerReference: String(body.message),
      providerCode: 'accepted',
      evidence: evidenceFrom(response.status, body),
    };
  }

  if (response.ok || (response.status >= 400 && response.status < 500)) {
    // Provider answered and said no (or answered 2xx without an id we can
    // hold as acceptance evidence + reported an error type).
    logger.warn('msg91 send rejected', {
      to: maskPhoneForLog(phone),
      http_status: response.status,
      code: body?.code ?? null,
    });
    return {
      outcome: 'rejected',
      providerReference: null,
      providerCode: body?.code ? `msg91_${String(body.code)}` : `msg91_http_${response.status}`,
      evidence: evidenceFrom(response.status, body),
    };
  }

  return {
    outcome: 'uncertain',
    providerReference: null,
    providerCode: 'msg91_no_acceptance_unresolved',
    evidence: evidenceFrom(response.status, body),
  };
}

export default { sendViaMsg91 };
