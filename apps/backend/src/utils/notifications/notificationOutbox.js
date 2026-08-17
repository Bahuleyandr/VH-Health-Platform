import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import {
  OPERATOR_REPLAY_SUPERSEDED_REASON,
  TERMINAL_REJECTION_CODES,
} from './terminalRejectionCodes.js';
import {
  DELIVERY_CHANNELS_PAYLOAD_KEY,
  normalizeChannelList,
  REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY,
} from './tenantNotificationChannels.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANNELS = new Set(['push', 'email', 'inapp', 'whatsapp', 'voice', 'sms', 'print']);

const toRecipientIdTextOrNull = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null;
  if (typeof value === 'bigint') return value.toString();
  return null;
};

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Notification intent contains a non-finite number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Notification intent contains an invalid date');
    return value.toISOString();
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  throw new TypeError('Notification intent contains an unsupported value');
}

export function canonicalRenderedIntentBytes(intent) {
  return Buffer.from(JSON.stringify(canonicalize(intent)), 'utf8');
}

export function renderedIntentHash(intent) {
  return createHash('sha256').update(canonicalRenderedIntentBytes(intent)).digest('hex');
}

function normalizeTenantId(value) {
  const tenantId = String(value || '').trim().toLowerCase();
  return UUID_RE.test(tenantId) ? tenantId : null;
}

function normalizeChannel(notification) {
  const requested = String(notification.channel || notification.type || 'push').trim().toLowerCase();
  const channel = requested === 'in_app' ? 'inapp' : requested;
  if (CHANNELS.has(channel)) return channel;
  if (notification.recipientPhone && !notification.recipientId) return 'sms';
  return 'push';
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sourceEventKey(notification, hash) {
  const data = notification.data || {};
  const explicit = notification.sourceEventKey
    || data.source_event_key
    || data.event_id
    || data.message_id
    || data.task_id
    || data.generation_id
    || data.campaign_recipient_id;
  if (explicit !== null && explicit !== undefined && String(explicit).trim()) {
    return String(explicit).trim().slice(0, 255);
  }
  return `direct:${hash.slice(0, 64)}`;
}

function recipientKey(recipientId, recipientPhone, sourceKey) {
  if (recipientId) return `id:${recipientId}`.slice(0, 320);
  if (recipientPhone) return `phone-sha256:${sha256(recipientPhone)}`;
  return `broadcast:${sourceKey}`.slice(0, 320);
}

function templateVersion(notification) {
  const data = notification.data || {};
  const value = notification.templateVersion || data.template_version || `${notification.type || 'push'}.v1`;
  return String(value).trim().slice(0, 80) || 'push.v1';
}

async function resolveTenantId(notification, db) {
  const data = notification.data || {};
  const explicit = normalizeTenantId(notification.tenantId || notification.tenant_id);
  const contextual = normalizeTenantId(getCurrentTenantId());
  const payload = normalizeTenantId(data.tenantId || data.tenant_id);
  const selected = explicit || contextual || payload;
  if (selected) return selected;

  const recipientId = toRecipientIdTextOrNull(notification.recipientId);
  const phone = String(notification.recipientPhone || '').trim();
  if (!recipientId && !phone) return null;
  try {
    const rows = await db.$queryRawUnsafe(
      `SELECT tenant_id::text
         FROM users
        WHERE ($1::text IS NOT NULL AND (id::text = $1::text OR uid::text = $1::text))
           OR ($2::text <> '' AND phone = $2::text)
        ORDER BY CASE WHEN id::text = $1::text OR uid::text = $1::text THEN 0 ELSE 1 END
        LIMIT 2`,
      recipientId, phone,
    );
    const tenants = [...new Set(rows.map(row => normalizeTenantId(row.tenant_id)).filter(Boolean))];
    return tenants.length === 1 ? tenants[0] : null;
  } catch (err) {
    logger.warn('Notification outbox tenant resolution failed:', err.message);
    return null;
  }
}

function buildIntent(notification) {
  const recipientId = toRecipientIdTextOrNull(notification.recipientId);
  const recipientPhone = String(notification.recipientPhone || '').trim() || null;
  const channel = normalizeChannel(notification);
  const version = templateVersion(notification);
  const rawData = canonicalize(notification.data || {});
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? Object.fromEntries(
      Object.entries(rawData).filter(([key]) => ![
        DELIVERY_CHANNELS_PAYLOAD_KEY,
        REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY,
      ].includes(key)),
    )
    : rawData;
  const deliveryChannels = normalizeChannelList(notification.deliveryChannels);
  const replayChainStartedAtMs = Number(rawData?.[REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY]);
  const internalData = {};
  if (deliveryChannels.length > 0) {
    internalData[DELIVERY_CHANNELS_PAYLOAD_KEY] = deliveryChannels;
  }
  if (Number.isSafeInteger(replayChainStartedAtMs) && replayChainStartedAtMs > 0) {
    internalData[REPLAY_CHAIN_STARTED_AT_PAYLOAD_KEY] = replayChainStartedAtMs;
  }
  const storedData = Object.keys(internalData).length > 0
    && data && typeof data === 'object' && !Array.isArray(data)
    ? { ...data, ...internalData }
    : data;
  const hashInput = {
    type: String(notification.type || channel),
    channel,
    recipient_id: recipientId,
    recipient_phone: recipientPhone,
    template_version: version,
    title: String(notification.title || ''),
    body: String(notification.body || ''),
    payload: data,
  };
  const hash = renderedIntentHash(hashInput);
  const sourceKey = sourceEventKey(notification, hash);
  return Object.freeze({
    type: hashInput.type,
    recipientId,
    recipientPhone,
    title: hashInput.title,
    body: hashInput.body,
    data: storedData,
    channel,
    sourceKey,
    recipientKey: recipientKey(recipientId, recipientPhone, sourceKey),
    templateVersion: version,
    renderedIntentHash: hash,
    renderedIntentBytes: canonicalRenderedIntentBytes(hashInput),
  });
}

// replay_generation is chain bookkeeping (mig-690), deliberately OUTSIDE the
// rendered-intent hash: a requeued replacement carries the same intent bytes
// as its original plus generation + 1. Set at INSERT only, clamped to the
// CHECK backstop; callers other than the replay paths never pass it.
function normalizeReplayGeneration(value) {
  const generation = Number(value ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) return 0;
  return Math.min(generation, 8);
}

async function queueTx(db, tenantId, intent, { replayGeneration = 0 } = {}) {
  const rows = await db.$queryRawUnsafe(
    `WITH inserted AS (
       INSERT INTO notification_outbox
         (tenant_id, type, recipient_id, recipient_phone, title, body, payload,
          status, created_at, channel, source_event_key, recipient_key,
          template_version, rendered_intent_hash, ledger_version, replay_generation)
       VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text,
               $7::jsonb, 'PENDING', NOW(), $8::text, $9::text, $10::text,
               $11::text, $12::char(64), 1, $13::smallint)
       ON CONFLICT ON CONSTRAINT ux_notification_outbox_delivery_intent DO NOTHING
       RETURNING id, status, tenant_id::text, channel, source_event_key,
                 recipient_key, template_version, rendered_intent_hash,
                 replay_generation, false AS duplicate
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT id, status, tenant_id::text, channel, source_event_key,
            recipient_key, template_version, rendered_intent_hash,
            replay_generation, true AS duplicate
       FROM notification_outbox
      WHERE tenant_id = $1::uuid AND source_event_key = $9::text
        AND recipient_key = $10::text AND channel = $8::text
        AND template_version = $11::text AND rendered_intent_hash = $12::char(64)
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    tenantId, intent.type, intent.recipientId, intent.recipientPhone,
    intent.title, intent.body, JSON.stringify(intent.data), intent.channel,
    intent.sourceKey, intent.recipientKey, intent.templateVersion, intent.renderedIntentHash,
    normalizeReplayGeneration(replayGeneration),
  );
  return rows[0] || null;
}

class NotificationOutbox {
  async queue(notification, { tx = null, strict = false, replayGeneration = 0 } = {}) {
    try {
      const intent = buildIntent(notification || {});
      const tenantId = await resolveTenantId(notification || {}, tx || prisma);
      if (!tenantId) throw new Error('Notification outbox requires one explicit tenant');
      if (tx) {
        const contexts = await tx.$queryRawUnsafe(
          `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant_id`,
        );
        if (contexts[0]?.tenant_id !== tenantId) {
          throw new Error('Notification outbox transaction tenant does not match intent tenant');
        }
        return await queueTx(tx, tenantId, intent, { replayGeneration });
      }
      return await setTenantTx(tenantId, db => queueTx(db, tenantId, intent, { replayGeneration }), {
        isolationLevel: 'Serializable',
      });
    } catch (err) {
      if (strict) throw err;
      logger.warn('Notification outbox queue failed:', err.message);
      return null;
    }
  }

  async claimPendingBatch({ tenantId, limit = 50, leaseSeconds = 120 } = {}) {
    const tid = normalizeTenantId(tenantId || getCurrentTenantId());
    if (!tid) throw new Error('Notification outbox claim requires tenantId');
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 250);
    const safeLeaseSeconds = Math.min(Math.max(Number(leaseSeconds) || 120, 30), 900);
    return setTenantTx(tid, tx => tx.$queryRawUnsafe(
      `WITH candidates AS (
         SELECT outbox.id
           FROM notification_outbox AS outbox
          WHERE outbox.tenant_id = $1::uuid
            AND outbox.status IN ('PENDING', 'FAILED')
            AND outbox.retry_count < 3
            AND (outbox.last_attempt_at IS NULL
              OR outbox.last_attempt_at < NOW() - INTERVAL '5 minutes')
            AND NOT EXISTS (
              SELECT 1 FROM notification_delivery_cursors AS cursor
               WHERE cursor.tenant_id = outbox.tenant_id
                 AND cursor.channel = outbox.channel
                 AND cursor.state IN ('delivering', 'paused_rejected', 'paused_uncertain')
            )
            AND NOT EXISTS (
              SELECT 1 FROM notification_outbox AS earlier
               WHERE earlier.tenant_id = outbox.tenant_id
                 AND earlier.channel = outbox.channel
                 AND earlier.ledger_version = 1 AND earlier.id < outbox.id
                 AND earlier.status NOT IN ('SENT', 'SUPPRESSED')
                 AND NOT (earlier.status = 'RECONCILIATION_REQUIRED'
                   AND earlier.failure_reason = $5::text)
                 AND NOT EXISTS (
                   SELECT 1 FROM notification_provider_receipts AS resolved
                    WHERE resolved.tenant_id = earlier.tenant_id
                      AND resolved.notification_outbox_id = earlier.id
                      AND resolved.channel = earlier.channel
                      AND (resolved.outcome = 'acknowledged'
                        OR (resolved.outcome = 'rejected'
                          AND resolved.provider_code = ANY($4::text[])))
                 )
            )
          ORDER BY outbox.id
          LIMIT $2::integer
          FOR UPDATE OF outbox SKIP LOCKED
       )
       UPDATE notification_outbox AS outbox
          SET status = 'CLAIMED', claim_token = gen_random_uuid(),
              claim_generation = outbox.claim_generation + 1,
              claimed_at = NOW(),
              lease_expires_at = NOW() + make_interval(secs => $3::integer),
              failure_reason = NULL
         FROM candidates
        WHERE outbox.tenant_id = $1::uuid AND outbox.id = candidates.id
        RETURNING outbox.id, outbox.tenant_id::text, outbox.type,
                  outbox.recipient_id, outbox.recipient_phone, outbox.title,
                  outbox.body, outbox.payload, outbox.retry_count, outbox.channel,
                  outbox.source_event_key, outbox.recipient_key,
                  outbox.template_version, outbox.rendered_intent_hash,
                  outbox.claim_token::text, outbox.claim_generation,
                  outbox.claimed_at, outbox.lease_expires_at`,
      tid, safeLimit, safeLeaseSeconds,
      TERMINAL_REJECTION_CODES, OPERATOR_REPLAY_SUPERSEDED_REASON,
    ), { isolationLevel: 'Serializable' });
  }

  async markSent(outboxId, { tenantId, claimToken, claimGeneration } = {}) {
    return this.#finalizeClaim(outboxId, {
      tenantId, claimToken, claimGeneration, status: 'SENT', reason: null,
    });
  }

  async markFailed(outboxId, reason, { tenantId, claimToken, claimGeneration } = {}) {
    return this.#finalizeClaim(outboxId, {
      tenantId,
      claimToken,
      claimGeneration,
      status: 'FAILED',
      reason: String(reason || 'provider_rejected').slice(0, 500),
    });
  }

  async markTerminalFailed(outboxId, reason, {
    tenantId, claimToken, claimGeneration,
  } = {}) {
    return this.#finalizeClaim(outboxId, {
      tenantId,
      claimToken,
      claimGeneration,
      status: 'FAILED',
      reason: String(reason || 'provider_terminal_rejection').slice(0, 500),
      terminalFailure: true,
    });
  }

  async markReconciliationRequired(outboxId, reason, { tenantId, claimToken, claimGeneration } = {}) {
    return this.#finalizeClaim(outboxId, {
      tenantId,
      claimToken,
      claimGeneration,
      status: 'RECONCILIATION_REQUIRED',
      reason: String(reason || 'provider_state_uncertain').slice(0, 500),
    });
  }

  async releaseClaim(outboxId, reason, { tenantId, claimToken, claimGeneration } = {}) {
    return this.#finalizeClaim(outboxId, {
      tenantId,
      claimToken,
      claimGeneration,
      status: 'PENDING',
      reason: String(reason || 'delivery_deferred').slice(0, 500),
      incrementRetry: false,
    });
  }

  async suppressLate(outboxId, { tenantId } = {}) {
    const tid = normalizeTenantId(tenantId || getCurrentTenantId());
    if (!tid) throw new Error('Notification suppression requires tenantId');
    return setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE notification_outbox
            SET status = 'SUPPRESSED', failure_reason = 'late_recovery_suppressed',
                last_attempt_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status IN ('PENDING', 'FAILED')
          RETURNING id, status`,
        tid, Number(outboxId),
      );
      return rows[0] || null;
    });
  }

  async #finalizeClaim(outboxId, {
    tenantId,
    claimToken,
    claimGeneration,
    status,
    reason,
    incrementRetry = status === 'FAILED',
    terminalFailure = false,
  }) {
    const tid = normalizeTenantId(tenantId || getCurrentTenantId());
    if (!tid || !claimToken || !Number.isSafeInteger(Number(claimGeneration))) {
      throw new Error('Notification finalization requires the exact tenant claim fence');
    }
    return setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE notification_outbox
            SET status = $5::text, claim_token = NULL, claimed_at = NULL,
                lease_expires_at = NULL, last_attempt_at = NOW(),
                sent_at = CASE WHEN $5::text = 'SENT' THEN NOW() ELSE sent_at END,
                retry_count = CASE
                  WHEN $8::boolean THEN GREATEST(retry_count, 3)
                  ELSE retry_count + CASE WHEN $7::boolean THEN 1 ELSE 0 END
                END,
                failure_reason = $6::text
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status = 'CLAIMED' AND claim_token = $3::uuid
            AND claim_generation = $4::integer
          RETURNING id, status, retry_count, sent_at`,
        tid, Number(outboxId), claimToken, Number(claimGeneration),
        status, reason, incrementRetry, terminalFailure,
      );
      if (rows.length !== 1) throw new Error('Notification claim fence was lost');
      return rows[0];
    });
  }
}

export const __testing__ = Object.freeze({
  canonicalize,
  normalizeTenantId,
  normalizeChannel,
  normalizeReplayGeneration,
  sourceEventKey,
  recipientKey,
  templateVersion,
  buildIntent,
});

export const notificationOutbox = new NotificationOutbox();
export default notificationOutbox;
