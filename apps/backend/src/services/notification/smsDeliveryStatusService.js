// src/services/notification/smsDeliveryStatusService.js
//
// Delivery-status (DLR) callback processing for the public /webhooks/sms
// mount (migrations 699/700).
//
// The contract, in order of the traps it avoids:
//   * Tenant resolution is FAIL-CLOSED: SHA-256(URL token) must match a
//     sms_provider_configs.callback_token_hash; otherwise 401 and nothing is
//     written — never a default tenant (pre-RLS mount law). Twilio deliveries
//     additionally verify X-Twilio-Signature against the exact public URL.
//   * Only TERMINAL provider statuses are persisted (delivered → acknowledged;
//     failed/undelivered/rejected/expired → rejected). Intermediate statuses
//     (queued/sent/submitted) are 200-acked WITHOUT a write — persisting them
//     would burn the one-receipt-per-(attempt, source) unique
//     (ux_notification_provider_receipt_source_once) on a non-terminal state.
//   * The receipt insert runs inside setTenantTx: the 609 tables carry a
//     RESTRICTIVE fail-closed RLS policy, so a bypass/unset-GUC write FAILS.
//     tenant_id is written explicitly (via recordProviderReceiptTx).
//   * Correlation is by provider_reference (MSG91 request id / Twilio
//     MessageSid) against the send-time 'provider_response' receipt, through
//     migration 700's idx_notification_provider_receipt_reference. An
//     unknown reference (late DLR after retention, foreign message) is
//     logged + 200-acked — no write.
//   * NEVER touches notification_outbox status or delivery cursors: SENT is
//     terminal under the 609 transition guard; a failed DLR after SENT is
//     append-only evidence for reconciliation reporting.
//   * A duplicate terminal DLR collapses on the unique index
//     (recordProviderReceiptTx's ON CONFLICT DO NOTHING) — replay-safe 200.

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { decryptField } from '../../utils/fieldEncryption.js';
import { recordProviderReceiptTx } from './notificationDeliveryLedgerService.js';
import { resolveSmsConfigByCallbackToken } from './smsProviderConfigService.js';
import { resolveEnvTwilioCallbackToken } from '../../utils/notifications/smsProviders/twilioCallbackAuth.js';

// MSG91 DLR status vocabulary. Textual statuses pass through lowercased;
// the numeric map covers the documented report codes we are confident about
// — anything unrecognized is treated as intermediate (acked, not persisted),
// which is always safe for an append-once terminal ledger.
const MSG91_NUMERIC_STATUS = Object.freeze({
  0: 'sent',
  1: 'delivered',
  2: 'failed',
  9: 'ndnc',
  16: 'rejected',
  17: 'blocked',
  20: 'blocked',
  25: 'rejected',
});

const TERMINAL_ACK_STATUSES = new Set(['delivered']);
const TERMINAL_REJECT_STATUSES = new Set([
  'failed', 'undelivered', 'rejected', 'expired', 'blocked', 'ndnc',
]);
const INTERMEDIATE_STATUSES = new Set([
  'queued', 'accepted', 'sending', 'sent', 'submitted', 'scheduled',
]);
const MAX_MSG91_DLR_REPORTS = 50;

function boundedProviderToken(value) {
  const candidate = String(value ?? '').trim();
  return /^[A-Za-z0-9_.-]{1,40}$/.test(candidate) && !/\d{6,}/.test(candidate)
    ? candidate
    : null;
}

function classifyDlrStatus(rawStatus) {
  const raw = String(rawStatus ?? '').trim().toLowerCase();
  if (!raw) return { kind: 'unknown', status: null };
  const status = Object.prototype.hasOwnProperty.call(MSG91_NUMERIC_STATUS, raw)
    ? MSG91_NUMERIC_STATUS[raw]
    : raw;
  if (TERMINAL_ACK_STATUSES.has(status)) return { kind: 'acknowledged', status };
  if (TERMINAL_REJECT_STATUSES.has(status)) return { kind: 'rejected', status };
  if (INTERMEDIATE_STATUSES.has(status)) return { kind: 'intermediate', status };
  return { kind: 'unknown', status };
}

function providerCodeFor(kind, status, errorCode) {
  if (kind === 'acknowledged') return 'dlr_delivered';
  const code = boundedProviderToken(errorCode);
  return (code ? `dlr_${status}_${code}` : `dlr_${status}`).slice(0, 120);
}

function boundedEvidence(provider, payload, extra = {}) {
  let raw;
  try {
    raw = JSON.stringify(payload ?? null).slice(0, 2000);
  } catch {
    raw = null;
  }
  return { provider, receipt_kind: 'dlr', raw, ...extra };
}

/**
 * Correlate a terminal DLR to its delivery attempt and append the
 * provider_status_callback receipt. Runs entirely inside setTenantTx (609
 * restrictive RLS). Returns a small handled-descriptor for the route ack.
 */
async function recordDlrReceipt({ tenantId, provider, providerReference, outcome, providerCode, evidence }) {
  return setTenantTx(tenantId, async (tx) => {
    const attempts = await tx.$queryRawUnsafe(
      `SELECT attempt_id::text, notification_outbox_id
         FROM notification_provider_receipts
        WHERE tenant_id = $1::uuid AND channel = 'sms'
          AND provider_reference = $2::text
          AND receipt_source = 'provider_response'
          AND evidence->>'provider' = $3::text
        ORDER BY observed_at DESC
        LIMIT 1`,
      tenantId, providerReference, provider,
    );
    if (!attempts.length) {
      logger.info('sms-dlr: unknown provider reference — acked without write', {
        tenant_id: tenantId,
      });
      return { handled: 'unknown_reference' };
    }
    const receipt = await recordProviderReceiptTx(tx, {
      tenantId,
      attemptId: attempts[0].attempt_id,
      outboxId: attempts[0].notification_outbox_id,
      channel: 'sms',
      outcome,
      receiptSource: 'provider_status_callback',
      providerReference,
      providerCode,
      evidence,
    });
    return { handled: 'recorded', receipt_id: receipt?.receipt_id ?? null };
  });
}

async function processEntry({ tenantId, provider, providerReference, statusRaw, errorCode, payload }) {
  const reference = String(providerReference || '').trim();
  if (!reference) return { handled: 'ignored_no_reference' };
  const { kind, status } = classifyDlrStatus(statusRaw);
  if (kind === 'intermediate') return { handled: 'ignored_intermediate', status };
  if (kind === 'unknown') {
    logger.info('sms-dlr: unrecognized delivery status — acked without write', {
      provider,
    });
    return { handled: 'ignored_unknown_status' };
  }
  return recordDlrReceipt({
    tenantId,
    provider,
    providerReference: reference,
    outcome: kind,
    providerCode: providerCodeFor(kind, status, errorCode),
    evidence: boundedEvidence(provider, payload, { dlr_status: status }),
  });
}

function decodeMsg91DlrReports(payload) {
  let decoded = payload;
  if (decoded && !Array.isArray(decoded) && typeof decoded === 'object'
      && Object.prototype.hasOwnProperty.call(decoded, 'data')) {
    if (typeof decoded.data !== 'string') {
      throw AppError.badRequest(
        'MSG91 DLR data must be a JSON-encoded report array',
        'SMS_DLR_DATA_INVALID',
      );
    }
    try {
      decoded = JSON.parse(decoded.data);
    } catch {
      throw AppError.badRequest(
        'MSG91 DLR data must be valid JSON',
        'SMS_DLR_DATA_INVALID',
      );
    }
  }

  const entries = Array.isArray(decoded) ? decoded : [decoded ?? {}];
  const reports = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw AppError.badRequest('MSG91 DLR entries must be objects', 'SMS_DLR_DATA_INVALID');
    }
    if (Array.isArray(entry.report) && entry.report.length > 0) {
      for (const report of entry.report) reports.push({ entry, report });
    } else {
      reports.push({ entry, report: null });
    }
  }
  if (reports.length > MAX_MSG91_DLR_REPORTS) {
    throw new AppError(
      `MSG91 DLR batches may contain at most ${MAX_MSG91_DLR_REPORTS} reports`,
      413,
      'SMS_DLR_BATCH_TOO_LARGE',
    );
  }
  return reports;
}

/**
 * MSG91 DLR intake. MSG91 does not sign callbacks — the URL token IS the
 * authentication. Accepts both the flat shape ({ requestId, status, ... })
 * and the batched report shape ([{ requestId, report: [{ status, desc }] }]).
 */
export async function processMsg91Dlr({ token, payload }) {
  const config = await resolveSmsConfigByCallbackToken(token, 'msg91');
  if (!config || config.provider !== 'msg91') return { authorized: false };
  const tenantId = String(config.tenant_id);

  // MSG91 posts application/x-www-form-urlencoded with a `data` field whose
  // value is the JSON report array. JSON input remains accepted for backwards
  // compatibility and test/operator replay. Decode and enforce the complete
  // batch bound BEFORE the first receipt write so an oversized authenticated
  // delivery fails atomically instead of being partially ACKed.
  const entries = decodeMsg91DlrReports(payload);
  const results = [];
  for (const { entry, report } of entries) {
    results.push(await processEntry({
      tenantId,
      provider: 'msg91',
      providerReference: entry?.requestId ?? entry?.request_id ?? null,
      statusRaw: entry?.status ?? report?.status ?? null,
      errorCode: entry?.code ?? report?.code ?? report?.desc ?? null,
      // Allowlisted evidence fields only — MSG91's DLR entry carries the
      // destination MSISDN, which must never land in
      // notification_provider_receipts.evidence (same posture as the Twilio
      // path dropping `To`: PHI-bearing fields deliberately not persisted).
      payload: {
        status: entry?.status ?? report?.status ?? null,
        code: boundedProviderToken(entry?.code ?? report?.code),
        desc: boundedProviderToken(report?.desc),
      },
    }));
  }
  return { authorized: true, tenantId, results };
}

/**
 * Twilio status-callback intake (form-encoded MessageSid / MessageStatus /
 * ErrorCode). Twilio signs URL + sorted params with the account auth token —
 * verified via the SDK's validateRequest against the exact credential source
 * encoded by the callback token: a database token uses only that config's
 * decrypted secret, while an env-minted token uses only TWILIO_AUTH_TOKEN.
 * Any missing verification input fails CLOSED (401): an unverifiable delivery
 * status must not become evidence.
 */
export async function processTwilioStatusCallback({ token, params, signature, requestPath }) {
  const envCallback = resolveEnvTwilioCallbackToken(token, {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  });
  if (String(token || '').startsWith('env.') && !envCallback) return { authorized: false };
  const config = envCallback ? null : await resolveSmsConfigByCallbackToken(token, 'twilio');
  if (!envCallback && (!config || config.provider !== 'twilio')) return { authorized: false };
  const tenantId = envCallback?.tenantId || String(config.tenant_id);
  let authToken = null;
  try {
    authToken = envCallback
      ? (process.env.TWILIO_AUTH_TOKEN || null)
      : (config.auth_key_ciphertext ? decryptField(config.auth_key_ciphertext) : null);
  } catch (err) {
    logger.error('sms-dlr: twilio auth token unreadable', { error: err?.message });
    return { authorized: false };
  }
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!authToken || !signature || !publicBaseUrl) {
    logger.warn('sms-dlr: twilio signature verification unavailable — rejecting', {
      has_auth_token: Boolean(authToken),
      has_signature: Boolean(signature),
      has_public_base_url: Boolean(publicBaseUrl),
    });
    return { authorized: false };
  }
  // The twilio package is CommonJS: `validateRequest` lives on the DEFAULT
  // export (module.exports, the Twilio constructor function) — under ESM
  // interop it is NOT a named export (sendWhatsAppNotification/
  // sendVoiceNotification use `mod.default(...)` for the same reason).
  const twilioMod = (await import('twilio').catch(() => null))?.default ?? null;
  if (typeof twilioMod?.validateRequest !== 'function') {
    logger.error('sms-dlr: twilio package unavailable — cannot verify signature, rejecting');
    return { authorized: false };
  }
  const url = `${publicBaseUrl}${requestPath}`;
  if (!twilioMod.validateRequest(authToken, signature, url, params || {})) {
    logger.warn('sms-dlr: invalid twilio signature');
    return { authorized: false };
  }

  const result = await processEntry({
    tenantId,
    provider: 'twilio',
    providerReference: params?.MessageSid ?? params?.SmsSid ?? null,
    statusRaw: params?.MessageStatus ?? params?.SmsStatus ?? null,
    errorCode: params?.ErrorCode ?? null,
    payload: {
      MessageStatus: params?.MessageStatus ?? null,
      ErrorCode: boundedProviderToken(params?.ErrorCode),
      To: undefined, // PHI-bearing fields deliberately not persisted
    },
  });
  return { authorized: true, tenantId, results: [result] };
}

export const __testing__ = Object.freeze({
  classifyDlrStatus,
  decodeMsg91DlrReports,
  providerCodeFor,
});
