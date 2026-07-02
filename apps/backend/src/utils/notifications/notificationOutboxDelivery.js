import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getTenantSettings } from '../../services/tenant/tenantSettingsService.js';
import { sendSMS } from '../../services/smsService.js';
import { dispatch } from './notificationDispatcher.js';
import { sendPushNotification } from './sendPushNotification.js';
import {
  legacyChannelsForOutboxRow,
  resolveChannelsForOutboxRow,
} from './tenantNotificationChannels.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function payloadObject(row) {
  return row?.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload
    : {};
}

function normalizeTenantId(value) {
  const tenantId = String(value || '').trim();
  return UUID_RE.test(tenantId) ? tenantId : null;
}

/**
 * Resolve a recipient_id (stored as text — may be an integer users.id or a
 * uuid uid) to its known FCM/device tokens across the three device homes:
 * users.device_token, user_devices.fcm_token, staff_devices.device_token.
 * Returns a de-duplicated, non-empty token array (may be empty).
 */
export async function resolveRecipientTokens(recipientId) {
  if (recipientId === null || recipientId === undefined || recipientId === '') return [];
  const idText = String(recipientId);
  const tokens = new Set();
  try {
    // users.device_token — match on int id OR uuid uid (text-cast for safety).
    const userRows = await prisma.$queryRawUnsafe(
      `SELECT device_token AS t FROM users
        WHERE device_token IS NOT NULL
          AND (id::text = $1 OR uid::text = $1)`,
      idText,
    );
    for (const r of userRows) if (r.t) tokens.add(r.t);
  } catch (err) {
    logger.warn('outbox-drain: users token lookup failed:', err.message);
  }
  try {
    const udRows = await prisma.$queryRawUnsafe(
      `SELECT fcm_token AS t FROM user_devices
        WHERE fcm_token IS NOT NULL AND user_uid::text = $1`,
      idText,
    );
    for (const r of udRows) if (r.t) tokens.add(r.t);
  } catch (err) {
    logger.warn('outbox-drain: user_devices token lookup failed:', err.message);
  }
  // staff_devices keys on an integer staff_id — only probe when numeric.
  if (/^\d+$/.test(idText)) {
    try {
      const sdRows = await prisma.$queryRawUnsafe(
        `SELECT device_token AS t FROM staff_devices
          WHERE device_token IS NOT NULL AND is_active = true AND staff_id = $1::int`,
        idText,
      );
      for (const r of sdRows) if (r.t) tokens.add(r.t);
    } catch (err) {
      logger.warn('outbox-drain: staff_devices token lookup failed:', err.message);
    }
  }
  return [...tokens];
}

export async function resolveTenantIdForOutboxRow(row) {
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
    try {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT tenant_id FROM users
          WHERE phone = $1
          LIMIT 1`,
        String(row.recipient_phone),
      );
      const tenantId = normalizeTenantId(rows?.[0]?.tenant_id);
      if (tenantId) return tenantId;
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

export async function deliverLegacyOutboxRow(row) {
  const channels = legacyChannelsForOutboxRow(row);
  if (channels.includes('sms')) {
    if (!row.recipient_phone) throw new Error('SMS outbox row has no recipient_phone');
    await sendSMS(row.recipient_phone, row.body || row.title || '');
    return { channels };
  }

  const tokens = await resolveRecipientTokens(row.recipient_id);
  const data = payloadObject(row);
  if (!tokens.length && !row.recipient_id) {
    throw new Error('push outbox row has no resolvable device token or recipient_id');
  }

  // sendPushNotification handles an empty token list gracefully (WS-only
  // delivery via userId) and never throws on zero tokens, so a row with a
  // recipient_id but no live token still resolves as "sent" (WS attempt)
  // rather than looping forever.
  await sendPushNotification({
    tokens,
    title: row.title || '',
    body: row.body || '',
    data,
    userId: row.recipient_id || null,
  });
  return { channels };
}

export async function deliverNotificationOutboxRow(row) {
  const decision = await resolveChannelDecision(row);

  if (decision.source === 'tenant') {
    const userId = row.recipient_id !== null && row.recipient_id !== undefined && row.recipient_id !== ''
      ? String(row.recipient_id)
      : String(row.recipient_phone || '').trim();
    if (!userId) throw new Error('dispatcher outbox row has no recipient_id or recipient_phone');

    const dryRun = forceDryRunProviders(decision.channels);
    if (dryRun.dryRunChannels.length > 0) {
      logger.info('notification-outbox-drain: dry-run channel fan-out', {
        outbox_id: row.id,
        tenant_id: decision.tenantId,
        type: row.type,
        dry_run_channels: dryRun.dryRunChannels,
      });
    }

    try {
      await dispatch({
        userId,
        title: row.title || '',
        body: row.body || '',
        channels: decision.channels,
        data: payloadObject(row),
        type: row.type || 'general',
      });
    } finally {
      dryRun.restore();
    }

    return {
      mode: 'dispatcher',
      channels: decision.channels,
      preferenceKey: decision.preferenceKey,
      tenantId: decision.tenantId,
    };
  }

  await deliverLegacyOutboxRow(row);
  return {
    mode: 'legacy',
    channels: decision.channels,
    preferenceKey: decision.preferenceKey,
    tenantId: decision.tenantId,
  };
}

export const __testing__ = {
  payloadObject,
  normalizeTenantId,
  forceDryRunProviders,
};
