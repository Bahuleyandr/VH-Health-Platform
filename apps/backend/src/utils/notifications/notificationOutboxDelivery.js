import prisma, { setTenant } from '../../lib/prisma.js';
import { runInTenantContext } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { sendSMS } from '../../services/smsService.js';
import {
  applyProviderReceiptToCursor,
  beginProviderAttempts,
  recordProviderReceipt,
} from '../../services/notification/notificationDeliveryLedgerService.js';
import { getTenantSettings } from '../../services/tenant/tenantSettingsService.js';
import { dispatch } from './notificationDispatcher.js';
import { sendPushNotification } from './sendPushNotification.js';
import {
  classifyFcmProviderResponse,
  isTerminalRejectionCode,
} from './terminalRejectionCodes.js';
import {
  DELIVERY_CHANNELS_PAYLOAD_KEY,
  REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY,
  resolveChannelsForOutboxRow,
} from './tenantNotificationChannels.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function payloadObject(row) {
  if (!row?.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return {};
  const {
    [DELIVERY_CHANNELS_PAYLOAD_KEY]: _deliveryChannels,
    [REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY]: _replayChainStartedAt,
    ...payload
  } = row.payload;
  return payload;
}

function normalizeTenantId(value) {
  const tenantId = String(value || '').trim();
  return UUID_RE.test(tenantId) ? tenantId : null;
}

/**
 * Resolve a recipient_id (stored as text — may be an integer users.id or a
 * uuid uid) to its known FCM tokens in users.device_token and
 * user_devices.fcm_token. staff_devices.device_token is a device-trust
 * credential and must never enter a push-provider path.
 * Returns a de-duplicated, non-empty token array (may be empty).
 */
export async function resolveRecipientTokens(recipientId, explicitTenantId = null) {
  if (recipientId === null || recipientId === undefined || recipientId === '') return [];
  const idText = String(recipientId);
  const tokens = new Set();
  const tenantId = explicitTenantId || await resolveTenantIdForOutboxRow({
    recipient_id: idText,
  });
  if (!tenantId) return [];
  const scopedQuery = (sql, ...params) => setTenant(
    tenantId,
    tx => tx.$queryRawUnsafe(sql, ...params),
    { readOnly: true },
  );
  try {
    // users.device_token — match on int id OR uuid uid (text-cast for safety).
    const userRows = await scopedQuery(
      `SELECT device_token AS t FROM users
        WHERE device_token IS NOT NULL
          AND tenant_id = $1::uuid
          AND (id::text = $2 OR uid::text = $2)`,
      tenantId,
      idText,
    );
    for (const r of userRows) if (r.t) tokens.add(r.t);
    const udRows = await scopedQuery(
      `SELECT fcm_token AS t FROM user_devices
        WHERE tenant_id = $1::uuid
          AND fcm_token IS NOT NULL
          AND user_uid::text = $2`,
      tenantId,
      idText,
    );
    for (const r of udRows) if (r.t) tokens.add(r.t);
  } catch (err) {
    logger.warn('outbox-drain: recipient FCM token lookup failed:', err.message);
    const lookupError = new Error('Recipient FCM token lookup failed', { cause: err });
    lookupError.code = 'recipient_token_lookup_failed';
    throw lookupError;
  }
  return [...tokens];
}

export async function resolveTenantIdForOutboxRow(row) {
  const rowTenantId = normalizeTenantId(row?.tenant_id || row?.tenantId);
  if (rowTenantId) return rowTenantId;
  const payload = payloadObject(row);
  const payloadTenantId = normalizeTenantId(payload.tenant_id || payload.tenantId);
  if (payloadTenantId) return payloadTenantId;

  if (row?.recipient_id !== null && row?.recipient_id !== undefined && row?.recipient_id !== '') {
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id FROM users
          WHERE id::text = $1 OR uid::text = $1
          LIMIT 1`,
        String(row.recipient_id),
      );
      const tenantId = normalizeTenantId(rows?.[0]?.tenant_id);
      if (tenantId) return tenantId;
    } catch (err) {
      logger.warn('outbox-drain: recipient tenant lookup by id failed:', err.message);
    }
  }

  if (row?.recipient_phone) {
    // Last-resort fallback, effectively unreachable for real outbox rows:
    // notification_outbox.tenant_id is NOT NULL with a default (migration
    // 609), so the row-level branch above always resolves first. Kept for
    // synthetic/legacy callers that pass a bare {recipient_phone}. A phone
    // is NOT unique across tenants, so an unordered LIMIT 1 was
    // nondeterministic when the same number exists in two tenants — order by
    // earliest registration, then id, so repeated calls always resolve to
    // the same user (and log when the phone was ambiguous).
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id, COUNT(*) OVER () AS phone_match_count FROM users
          WHERE phone = $1
          ORDER BY registered_at ASC NULLS LAST, id ASC
          LIMIT 1`,
        String(row.recipient_phone),
      );
      const tenantId = normalizeTenantId(rows?.[0]?.tenant_id);
      if (tenantId) {
        if (Number(rows?.[0]?.phone_match_count || 0) > 1) {
          logger.warn(
            'outbox-drain: recipient phone matches multiple users; resolved deterministically to the earliest-registered account\'s tenant',
          );
        }
        return tenantId;
      }
    } catch (err) {
      logger.warn('outbox-drain: recipient tenant lookup by phone failed:', err.message);
    }
  }

  return null;
}

export function dryRunTwilioChannels(channels) {
  const dryRunChannels = [];
  const normalized = new Set((channels || []).map((channel) => String(channel).toLowerCase()));

  if (normalized.has('whatsapp')) {
    const provider = String(process.env.WHATSAPP_PROVIDER || 'logger').toLowerCase();
    const hasTwilio = !!(
      process.env.TWILIO_ACCOUNT_SID
      && process.env.TWILIO_AUTH_TOKEN
      && process.env.TWILIO_WHATSAPP_FROM
    );
    if (provider !== 'twilio' || !hasTwilio) dryRunChannels.push('whatsapp');
  }

  if (normalized.has('voice')) {
    const provider = String(process.env.VOICE_PROVIDER || 'logger').toLowerCase();
    const hasTwilio = !!(
      process.env.TWILIO_ACCOUNT_SID
      && process.env.TWILIO_AUTH_TOKEN
      && process.env.TWILIO_VOICE_FROM
    );
    if (provider !== 'twilio' || !hasTwilio) dryRunChannels.push('voice');
  }

  return dryRunChannels;
}

function forceDryRunProviders(channels) {
  const dryRunChannels = dryRunTwilioChannels(channels);
  const previous = {};

  if (dryRunChannels.includes('whatsapp')) {
    previous.WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER;
    process.env.WHATSAPP_PROVIDER = 'logger';
  }
  if (dryRunChannels.includes('voice')) {
    previous.VOICE_PROVIDER = process.env.VOICE_PROVIDER;
    process.env.VOICE_PROVIDER = 'logger';
  }

  return {
    dryRunChannels,
    restore() {
      if (Object.prototype.hasOwnProperty.call(previous, 'WHATSAPP_PROVIDER')) {
        if (previous.WHATSAPP_PROVIDER === undefined) delete process.env.WHATSAPP_PROVIDER;
        else process.env.WHATSAPP_PROVIDER = previous.WHATSAPP_PROVIDER;
      }
      if (Object.prototype.hasOwnProperty.call(previous, 'VOICE_PROVIDER')) {
        if (previous.VOICE_PROVIDER === undefined) delete process.env.VOICE_PROVIDER;
        else process.env.VOICE_PROVIDER = previous.VOICE_PROVIDER;
      }
    },
  };
}

async function resolveChannelDecision(row) {
  const tenantId = await resolveTenantIdForOutboxRow(row);
  const settings = tenantId ? await getTenantSettings(tenantId) : {};
  const resolved = resolveChannelsForOutboxRow(row, settings);
  return { ...resolved, tenantId };
}

// NOTE: `deliverLegacyOutboxRow` used to live here — an unreferenced export
// that called sendSMS and returned as if the text had gone out. Removed with
// audit 2026-08-09 finding F7: every drain path now goes through
// `deliverNotificationOutboxRow` below, which records a provider receipt and
// cannot report a dry run as a delivery.

function rejected(providerCode, evidence = {}) {
  return { outcome: 'rejected', providerReference: null, providerCode, evidence };
}

function uncertain(providerCode, err) {
  return {
    outcome: 'uncertain',
    providerReference: null,
    providerCode,
    evidence: { message: String(err?.message || err || providerCode).slice(0, 500) },
  };
}

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

async function deliverLegacyWithProviderReceipt(row, channels, tenantId) {
  const results = {};
  for (const channel of channels) {
    if (channel === 'sms') {
      if (!row.recipient_phone) {
        results.sms = rejected('phone_missing');
        continue;
      }
      // Provider seam call (audit F7 successor): sendSMS resolves the
      // tenant's configured gateway and returns the receipt shape; the
      // dry-run default classifies as rejected('sms_gateway_not_configured')
      // so an unconfigured channel still never reaches SENT.
      try {
        results.sms = normalizeSmsProviderResult(await sendSMS(
          row.recipient_phone,
          `${row.title ? `${row.title}: ` : ''}${row.body || ''}`,
          {
            tenantId,
            templateVersion: row.template_version || null,
            outboxId: row.id,
          },
        ));
      } catch (err) {
        results.sms = uncertain(err.code || 'sms_transport_failure', err);
      }
      continue;
    }
    if (channel !== 'push') {
      results[channel] = rejected(`${channel}_provider_not_configured`);
      continue;
    }
    try {
      const tokens = await resolveRecipientTokens(row.recipient_id, tenantId);
      if (tokens.length === 0) {
        results.push = rejected('fcm_token_missing');
        continue;
      }
      const response = await sendPushNotification({
        tokens,
        title: row.title || '',
        body: row.body || '',
        data: payloadObject(row),
        userId: row.recipient_id || null,
      });
      results.push = classifyFcmProviderResponse(response);
    } catch (err) {
      results.push = uncertain(
        err.code === 'recipient_token_lookup_failed'
          ? 'recipient_token_lookup_failed'
          : err.code || 'fcm_transport_failure',
        err,
      );
    }
  }
  return results;
}

export async function deliverNotificationOutboxRow(row) {
  let decision;
  try {
    decision = await resolveChannelDecision(row);
    if (!decision.tenantId) throw new Error('notification outbox row has no tenant provenance');
  } catch (err) {
    err.notificationDeliveryPhase = 'pre_provider';
    throw err;
  }

  // A transaction/connection failure here can leave commit state unknown.
  // Do not label it safe-to-release: lease expiry reconciles any attempt that
  // may have committed before the client observed the failure.
  const attempts = await beginProviderAttempts({
    tenantId: decision.tenantId,
    outboxId: row.id,
    claimToken: row.claim_token,
    claimGeneration: row.claim_generation,
    renderedIntentHash: row.rendered_intent_hash,
    channels: decision.channels,
  });
  const pendingAttempts = attempts.filter(attempt => attempt.state === 'ready');
  const providerResults = {};

  for (const attempt of attempts) {
    if (attempt.state === 'acknowledged') {
      providerResults[attempt.channel] = {
        outcome: 'acknowledged',
        providerReference: attempt.receiptId,
        providerCode: 'previously_accepted',
        evidence: {},
      };
    }
  }

  if (pendingAttempts.length > 0 && decision.source === 'tenant') {
    const userId = row.recipient_id !== null && row.recipient_id !== undefined && row.recipient_id !== ''
      ? String(row.recipient_id)
      : String(row.recipient_phone || '').trim();
    // A recipient-less (legacy broadcast) row is NOT an exception: dispatch()
    // records a terminal `recipient_identifier_missing` rejection per channel,
    // so the row dead-letters and the channel keeps delivering (fix R3/R2 —
    // throwing here left the row leased until lease-expiry marked it
    // RECONCILIATION_REQUIRED and paused the whole channel).

    const pendingChannels = pendingAttempts.map(attempt => attempt.channel);
    const dryRun = forceDryRunProviders(pendingChannels);
    if (dryRun.dryRunChannels.length > 0) {
      logger.info('notification-outbox-drain: provider unavailable for durable delivery', {
        outbox_id: row.id,
        tenant_id: decision.tenantId,
        type: row.type,
        unavailable_channels: dryRun.dryRunChannels,
      });
    }
    try {
      Object.assign(providerResults, await runInTenantContext(decision.tenantId, () => dispatch({
        userId,
        title: row.title || '',
        body: row.body || '',
        channels: pendingChannels,
        data: payloadObject(row),
        type: row.type || 'general',
        providerReceiptMode: true,
        smsContext: {
          tenantId: decision.tenantId,
          templateVersion: row.template_version || null,
          outboxId: row.id,
        },
      })));
    } finally {
      dryRun.restore();
    }
  } else if (pendingAttempts.length > 0) {
    Object.assign(providerResults, await deliverLegacyWithProviderReceipt(
      row,
      pendingAttempts.map(attempt => attempt.channel),
      decision.tenantId,
    ));
  }

  const receipts = [];
  for (const attempt of pendingAttempts) {
    const result = providerResults[attempt.channel]
      || uncertain('provider_result_missing', new Error('Provider returned no delivery result'));
    const receipt = await recordProviderReceipt({
      tenantId: decision.tenantId,
      attemptId: attempt.attempt_id,
      outboxId: row.id,
      channel: attempt.channel,
      outcome: result.outcome,
      receiptSource: result.outcome === 'uncertain' ? 'transport_failure' : 'provider_response',
      providerReference: result.providerReference || null,
      providerCode: result.providerCode || null,
      evidence: result.evidence || {},
    });
    receipts.push(receipt);
  }

  for (const receipt of receipts) {
    await applyProviderReceiptToCursor({
      tenantId: decision.tenantId,
      receiptId: receipt.receipt_id,
    });
  }

  const blocked = attempts.filter(attempt => attempt.state === 'blocked');
  const outcomes = [
    ...Object.values(providerResults).map(result => result.outcome),
    ...blocked.map(() => 'deferred'),
  ];
  const outcome = outcomes.includes('uncertain')
    ? 'uncertain'
    : outcomes.includes('rejected')
      ? 'rejected'
      : outcomes.includes('deferred')
        ? 'deferred'
        : 'acknowledged';
  const rejectedResults = Object.values(providerResults)
    .filter(result => result.outcome === 'rejected');
  const terminal = outcome === 'rejected'
    && blocked.length === 0
    && rejectedResults.length > 0
    && rejectedResults.every(result => isTerminalRejectionCode(result.providerCode));

  return {
    mode: decision.source === 'tenant' ? 'dispatcher' : 'legacy',
    channels: decision.channels,
    preferenceKey: decision.preferenceKey,
    tenantId: decision.tenantId,
    outcome,
    terminal,
    attempts,
    receipts,
  };
}

export const __testing__ = {
  payloadObject,
  normalizeTenantId,
  forceDryRunProviders,
};
