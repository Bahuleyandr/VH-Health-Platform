import crypto from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  recordOutboxOperatorRedrive,
  recordWebhookDeliveryLeaseReaped,
} from '../../observability/reliabilityMetrics.js';
import { AppError } from '../../utils/AppError.js';
import { decryptField } from '../../utils/fieldEncryption.js';
import { assertSafeOutboundUrl, safeFetch } from '../../utils/ssrfGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { writeIntegrationLog } from './integrationService.js';
import {
  recordSubscriptionFailure,
  recordSubscriptionSuccess,
  signWebhookPayload,
} from './webhookSubscriptionService.js';

export const DELIVERY_STATUSES = Object.freeze([
  'pending',
  'in_flight',
  'succeeded',
  'failed',
  'dead',
]);

const RETRY_LIMIT = 7;
const MAX_DB_INTEGER = 2_147_483_647;
const BACKOFF_SECONDS = [30, 120, 600, 1_800, 3_600, 14_400, 28_800];
const DEFAULT_BATCH = 25;
const MAX_BATCH = 200;
const DEFAULT_LEASE_SECONDS = 120;
const MAX_LEASE_SECONDS = 900;
const REQUEST_TIMEOUT_MS = 8_000;
const RESPONSE_EXCERPT_MAX = 2_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isMissingSchemaError(error) {
  return /does not exist|relation .* does not exist/i.test(String(error?.message || ''));
}

function normalizeId(value, label = 'id') {
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return candidate;
}

function boundedInteger(value, fallback, min, max, label) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw AppError.badRequest(`${label} is invalid`);
  }
  return candidate;
}

function safeText(value, max, label = 'value', { required = false } = {}) {
  const text = value == null ? '' : String(value).trim();
  if (required && !text) throw AppError.badRequest(`${label} is required`);
  if (text.length > max) throw AppError.badRequest(`${label} is too long`);
  return text || null;
}

function normalizeUuid(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw AppError.badRequest(`${label} must be a UUID`);
  return normalized;
}

function normalizePayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function backoffSecondsForAttempt(attemptNumber) {
  const index = Math.max(0, Math.min(attemptNumber - 1, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[index];
}

function computeNextRetryAt(attemptNumber) {
  return new Date(Date.now() + backoffSecondsForAttempt(attemptNumber) * 1000);
}

function isRetryable(httpStatus) {
  if (httpStatus == null) return true;
  if (httpStatus >= 500 && httpStatus < 600) return true;
  return [408, 425, 429].includes(httpStatus);
}

function actorContext({ actorUid, actorRole, requestId }) {
  return Object.freeze({
    uid: normalizeUuid(actorUid, 'actor uid'),
    role: safeText(actorRole, 50, 'actor role', { required: true }),
    requestId: safeText(requestId, 180, 'request id'),
  });
}

function normalizeClaim(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw AppError.badRequest('webhook delivery claim is required');
  }
  const priorStatus = String(row.prior_status || 'pending');
  if (!['pending', 'failed'].includes(priorStatus)) {
    throw AppError.badRequest('webhook delivery prior status is invalid');
  }
  return Object.freeze({
    id: normalizeId(row.id, 'delivery id'),
    tenantId: requireTenantId(row.tenant_id),
    subscriptionId: row.subscription_id == null
      ? null
      : normalizeId(row.subscription_id, 'subscription id'),
    leaseOwner: normalizeUuid(row.lease_owner, 'lease owner'),
    attemptNumber: boundedInteger(row.attempt_number, null, 1, MAX_DB_INTEGER, 'attempt number'),
    priorStatus,
  });
}

export async function enqueueDelivery({
  tenantId,
  eventType,
  payload = {},
  eventOutboxId = null,
  requestId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cleanType = safeText(eventType, 120, 'event_type', { required: true });
  if (eventOutboxId !== null && eventOutboxId !== undefined) {
    throw AppError.badRequest(
      'Ad-hoc webhook enqueue cannot attach an event_outbox_id',
      'WEBHOOK_SOURCE_BRIDGE_INTERNAL_ONLY',
    );
  }
  const request = safeText(requestId, 64, 'request_id') || crypto.randomUUID();
  return setTenantTx(tid, async (tx) => {
    const subscriptions = await tx.$queryRawUnsafe(
      `SELECT subscription.id
         FROM webhook_subscriptions AS subscription
         JOIN integrations AS integration
           ON integration.tenant_id = subscription.tenant_id
          AND integration.id = subscription.integration_id
          AND integration.status = 'active'
        WHERE subscription.tenant_id = $1::uuid
          AND subscription.event_type = $2::text
          AND subscription.is_active = TRUE
          AND subscription.event_filter = '{}'::jsonb
        ORDER BY subscription.id`,
      tid,
      cleanType,
    );
    if (!subscriptions.length) return Object.freeze({ matched: 0, enqueued: Object.freeze([]) });
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO webhook_deliveries
         (subscription_id, tenant_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at, request_id)
       SELECT subscription.id, subscription.tenant_id, NULL, $2::text,
              $3::jsonb, 'pending', 0, NOW(), $4::text
         FROM webhook_subscriptions AS subscription
         JOIN integrations AS integration
           ON integration.tenant_id = subscription.tenant_id
          AND integration.id = subscription.integration_id
          AND integration.status = 'active'
        WHERE subscription.tenant_id = $1::uuid
          AND subscription.event_type = $2::text
          AND subscription.is_active = TRUE
          AND subscription.event_filter = '{}'::jsonb
      RETURNING id, subscription_id, tenant_id, event_outbox_id::text,
                event_type, status, attempt_number, next_retry_at,
                redrive_count, created_at`,
      tid,
      cleanType,
      JSON.stringify(normalizePayload(payload)),
      request,
    );
    if (rows.length !== subscriptions.length) {
      throw new Error('Ad-hoc webhook enqueue coverage is incomplete');
    }
    return Object.freeze({ matched: subscriptions.length, enqueued: Object.freeze(rows) });
  }, { isolationLevel: 'Serializable' });
}

async function claimDueDeliveries({ tenantId, batchSize, leaseOwner, leaseSeconds }) {
  const run = (tx) => tx.$queryRawUnsafe(
    `WITH due AS MATERIALIZED (
       SELECT delivery.tenant_id, delivery.id, delivery.status AS prior_status
         FROM webhook_deliveries AS delivery
         JOIN webhook_subscriptions AS subscription
           ON subscription.tenant_id = delivery.tenant_id
          AND subscription.id = delivery.subscription_id
          AND subscription.is_active = TRUE
          AND subscription.event_filter = '{}'::jsonb
         JOIN integrations AS integration
           ON integration.tenant_id = subscription.tenant_id
          AND integration.id = subscription.integration_id
          AND integration.status = 'active'
        WHERE ($1::uuid IS NULL OR delivery.tenant_id = $1::uuid)
          AND delivery.status IN ('pending', 'failed')
          AND delivery.next_retry_at <= NOW()
        ORDER BY delivery.next_retry_at, delivery.id
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT $2::integer
     )
     UPDATE webhook_deliveries AS delivery
        SET status = 'in_flight',
            attempt_number = delivery.attempt_number + 1,
            lease_owner = $3::uuid,
            lease_expires_at = NOW() + ($4::integer * INTERVAL '1 second'),
            started_at = NOW(),
            updated_at = NOW()
       FROM due
      WHERE delivery.tenant_id = due.tenant_id
        AND delivery.id = due.id
        AND delivery.status = due.prior_status
    RETURNING delivery.id, delivery.subscription_id, delivery.tenant_id,
              delivery.event_outbox_id::text, delivery.event_type, delivery.payload,
              delivery.attempt_number, delivery.request_id, delivery.lease_owner,
              delivery.lease_expires_at, due.prior_status`,
    tenantId,
    batchSize,
    leaseOwner,
    leaseSeconds,
  );
  return tenantId
    ? setTenantTx(tenantId, run)
    : setTenantTx(null, run, { superAdmin: true });
}

async function deadLetterOrphans({ tenantId, limit = MAX_BATCH }) {
  const run = (tx) => tx.$queryRawUnsafe(
    `WITH orphaned AS MATERIALIZED (
       SELECT delivery.tenant_id, delivery.id
         FROM webhook_deliveries AS delivery
         LEFT JOIN webhook_subscriptions AS subscription
           ON subscription.tenant_id = delivery.tenant_id
          AND subscription.id = delivery.subscription_id
        WHERE ($1::uuid IS NULL OR delivery.tenant_id = $1::uuid)
          AND delivery.status IN ('pending', 'failed')
          AND subscription.id IS NULL
        ORDER BY delivery.id
        FOR UPDATE OF delivery SKIP LOCKED
        LIMIT $2::integer
     )
     UPDATE webhook_deliveries AS delivery
        SET status = 'dead',
            error_message = 'subscription_missing',
            next_retry_at = NULL,
            completed_at = COALESCE(completed_at, NOW()),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
       FROM orphaned
      WHERE delivery.tenant_id = orphaned.tenant_id
        AND delivery.id = orphaned.id
        AND delivery.status IN ('pending', 'failed')
    RETURNING delivery.id`,
    tenantId,
    limit,
  );
  return tenantId
    ? setTenantTx(tenantId, run)
    : setTenantTx(null, run, { superAdmin: true });
}

async function loadSubscriptionForClaim(claim) {
  return setTenantTx(claim.tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT subscription.id, subscription.integration_id,
              subscription.endpoint_url, subscription.signing_credential_id,
              subscription.signing_algorithm, subscription.is_active,
              subscription.event_filter,
              integration.status AS integration_status,
              credential.id AS credential_id, credential.ciphertext
         FROM webhook_subscriptions AS subscription
         JOIN integrations AS integration
           ON integration.tenant_id = subscription.tenant_id
          AND integration.id = subscription.integration_id
         LEFT JOIN integration_credentials AS credential
           ON credential.id = subscription.signing_credential_id
          AND credential.tenant_id = subscription.tenant_id
          AND credential.integration_id = subscription.integration_id
        WHERE subscription.tenant_id = $1::uuid
          AND subscription.id = $2::integer
        LIMIT 1`,
      claim.tenantId,
      claim.subscriptionId,
    );
    return rows[0] || null;
  });
}

async function parkClaim(claim) {
  const rows = await setTenantTx(claim.tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE webhook_deliveries
        SET status = $6::text,
            lease_owner = NULL,
            lease_expires_at = NULL,
            started_at = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
        AND status = 'in_flight'
        AND lease_owner = $3::uuid
        AND attempt_number = $4::integer
        AND subscription_id = $5::integer
    RETURNING id`,
    claim.tenantId,
    claim.id,
    claim.leaseOwner,
    claim.attemptNumber,
    claim.subscriptionId,
    claim.priorStatus,
  ));
  return rows.length === 1;
}

async function finishClaim(claim, {
  status,
  httpStatus = null,
  responseExcerpt = null,
  errorMessage = null,
  signature = null,
  nextRetryAt = null,
  completedAt = null,
  subscriptionOutcome = null,
}) {
  return setTenantTx(claim.tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE webhook_deliveries
          SET status = $6::text,
              http_status = $7::integer,
              response_excerpt = $8::text,
              error_message = $9::text,
              signature = $10::text,
              next_retry_at = $11::timestamptz,
              completed_at = $12::timestamptz,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
          AND status = 'in_flight'
          AND lease_owner = $3::uuid
          AND attempt_number = $4::integer
          AND subscription_id = $5::integer
      RETURNING id, subscription_id, tenant_id, status, attempt_number`,
      claim.tenantId,
      claim.id,
      claim.leaseOwner,
      claim.attemptNumber,
      claim.subscriptionId,
      status,
      httpStatus,
      responseExcerpt,
      errorMessage,
      signature,
      nextRetryAt,
      completedAt,
    );
    if (rows.length !== 1) return Object.freeze({ updated: false, lost_fence: true });
    if (subscriptionOutcome === 'success') {
      await recordSubscriptionSuccess({
        tx,
        tenantId: claim.tenantId,
        id: claim.subscriptionId,
      });
    } else if (subscriptionOutcome === 'failure') {
      await recordSubscriptionFailure({
        tx,
        tenantId: claim.tenantId,
        id: claim.subscriptionId,
      });
    }
    return Object.freeze({ updated: true, lost_fence: false, delivery: rows[0] });
  }, { isolationLevel: 'Serializable' });
}

export async function dispatchPendingDeliveries({
  tenantId = null,
  batchSize = DEFAULT_BATCH,
  fetchImpl = null,
  leaseOwner = crypto.randomUUID(),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
} = {}) {
  const tid = tenantId == null ? null : requireTenantId(tenantId);
  const cap = boundedInteger(batchSize, DEFAULT_BATCH, 1, MAX_BATCH, 'batch size');
  const owner = normalizeUuid(leaseOwner, 'lease owner');
  const seconds = boundedInteger(
    leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    1,
    MAX_LEASE_SECONDS,
    'lease seconds',
  );
  const fetcher = fetchImpl || ((url, options) => safeFetch(url, options, {
    label: 'endpoint_url',
    allowlistEnv: 'WEBHOOK_DELIVERY_HOST_ALLOWLIST',
    allowPrivateEnv: 'WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS',
  }));

  let orphaned;
  let claimed;
  try {
    orphaned = await deadLetterOrphans({ tenantId: tid, limit: cap });
    claimed = await claimDueDeliveries({
      tenantId: tid,
      batchSize: cap,
      leaseOwner: owner,
      leaseSeconds: seconds,
    });
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { halted: true, reason: 'webhook_deliveries_unavailable' };
    }
    throw error;
  }

  let succeeded = 0;
  let failed = 0;
  let dead = orphaned.length;
  let parked = 0;
  let lostFence = 0;
  for (const row of claimed) {
    const claim = normalizeClaim(row);
    const subscription = await loadSubscriptionForClaim(claim);
    if (!subscription) {
      const result = await finishClaim(claim, {
        status: 'dead',
        errorMessage: 'subscription_missing',
        completedAt: new Date(),
      });
      if (result.updated) dead += 1;
      else lostFence += 1;
      continue;
    }
    if (
      subscription.is_active !== true
      || subscription.integration_status !== 'active'
      || JSON.stringify(subscription.event_filter || {}) !== '{}'
    ) {
      if (await parkClaim(claim)) parked += 1;
      else lostFence += 1;
      continue;
    }

    let signed = {
      signature: '',
      header_value: '',
      algorithm: subscription.signing_algorithm,
      timestamp: null,
    };
    const url = subscription.endpoint_url;
    let httpStatus = null;
    let responseExcerpt = null;
    let errorMessage = null;
    try {
      await assertSafeOutboundUrl(url, {
        label: 'endpoint_url',
        allowlistEnv: 'WEBHOOK_DELIVERY_HOST_ALLOWLIST',
        allowPrivateEnv: 'WEBHOOK_DELIVERY_ALLOW_PRIVATE_TARGETS',
      });
      if (subscription.signing_algorithm !== 'none') {
        if (!subscription.credential_id || !subscription.ciphertext) {
          throw AppError.forbidden(
            'Webhook signing credential is missing or not owned by this tenant integration',
            'WEBHOOK_SIGNING_CREDENTIAL_FORBIDDEN',
          );
        }
        signed = signWebhookPayload({
          payload: row.payload,
          secret: decryptField(subscription.ciphertext),
          algorithm: subscription.signing_algorithm,
        });
      }
    } catch (error) {
      errorMessage = String(error?.message || 'webhook_preflight_failed').slice(0, 1_000);
      logger.warn('webhook delivery preflight failed', {
        delivery_id: row.id,
        error: errorMessage,
      });
    }

    if (!errorMessage) {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-VHHealth-Signature': signed.header_value,
            'X-VHHealth-Event-Type': row.event_type,
            'X-VHHealth-Delivery-Id': String(row.id),
            'X-Request-Id': row.request_id || crypto.randomUUID(),
          },
          body: JSON.stringify(normalizePayload(row.payload)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        httpStatus = response.status;
        try {
          const text = await response.text();
          responseExcerpt = text ? text.slice(0, RESPONSE_EXCERPT_MAX) : null;
        } catch {
          responseExcerpt = null;
        }
      } catch (error) {
        errorMessage = String(error?.message || 'fetch_failed').slice(0, 1_000);
      }
    }

    const ok = httpStatus != null && httpStatus >= 200 && httpStatus < 300;
    if (ok) {
      const result = await finishClaim(claim, {
        status: 'succeeded',
        httpStatus,
        responseExcerpt,
        signature: signed.signature || null,
        completedAt: new Date(),
        subscriptionOutcome: 'success',
      });
      if (!result.updated) {
        lostFence += 1;
        continue;
      }
      succeeded += 1;
      try {
        await writeIntegrationLog({
          tenantId: claim.tenantId,
          integrationId: subscription.integration_id,
          logType: 'webhook_send',
          severity: 'info',
          message: `Delivered ${row.event_type} to ${url} (HTTP ${httpStatus})`,
          payload: { delivery_id: row.id, attempt: claim.attemptNumber },
        });
      } catch (logError) {
        logger.debug('webhook send log write failed', { error: logError.message });
      }
      continue;
    }

    const retryable = isRetryable(httpStatus) && claim.attemptNumber < RETRY_LIMIT;
    const nextStatus = retryable ? 'failed' : 'dead';
    const nextRetryAt = retryable ? computeNextRetryAt(claim.attemptNumber) : null;
    const result = await finishClaim(claim, {
      status: nextStatus,
      httpStatus,
      responseExcerpt,
      errorMessage,
      signature: signed.signature || null,
      nextRetryAt,
      completedAt: nextStatus === 'dead' ? new Date() : null,
      subscriptionOutcome: 'failure',
    });
    if (!result.updated) {
      lostFence += 1;
      continue;
    }
    if (nextStatus === 'dead') dead += 1;
    else failed += 1;
    try {
      await writeIntegrationLog({
        tenantId: claim.tenantId,
        integrationId: subscription.integration_id,
        logType: nextStatus === 'dead' ? 'error' : 'webhook_send',
        severity: nextStatus === 'dead' ? 'error' : 'warn',
        message: `Delivery ${nextStatus}: ${row.event_type} → ${url} (HTTP ${httpStatus ?? 'n/a'})`,
        payload: {
          delivery_id: row.id,
          attempt: claim.attemptNumber,
          next_retry_at: nextRetryAt,
          error: errorMessage,
        },
      });
    } catch (logError) {
      logger.debug('webhook send log write failed', { error: logError.message });
    }
  }
  return {
    dispatched: claimed.length,
    succeeded,
    failed,
    dead,
    parked,
    lost_fence: lostFence,
    orphaned: orphaned.length,
  };
}

export async function reapStaleInFlightDeliveries({ limit = MAX_BATCH } = {}) {
  const safeLimit = boundedInteger(limit, MAX_BATCH, 1, MAX_BATCH, 'limit');
  const rows = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
    `WITH stale AS MATERIALIZED (
       SELECT tenant_id, id, lease_owner, attempt_number
         FROM webhook_deliveries
        WHERE status = 'in_flight'
          AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1::integer
     )
     UPDATE webhook_deliveries AS delivery
        SET status = CASE
              WHEN stale.attempt_number >= $2::integer THEN 'dead'
              ELSE 'failed'
            END,
            error_message = 'reaped: stale in_flight lease expired',
            next_retry_at = CASE
              WHEN stale.attempt_number >= $2::integer THEN NULL
              ELSE NOW()
            END,
            completed_at = CASE
              WHEN stale.attempt_number >= $2::integer
                THEN COALESCE(delivery.completed_at, NOW())
              ELSE NULL
            END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
       FROM stale
      WHERE delivery.tenant_id = stale.tenant_id
        AND delivery.id = stale.id
        AND delivery.status = 'in_flight'
        AND delivery.lease_owner = stale.lease_owner
        AND delivery.attempt_number = stale.attempt_number
    RETURNING delivery.id, delivery.tenant_id, delivery.status, delivery.attempt_number`,
    safeLimit,
    RETRY_LIMIT,
  ), { superAdmin: true, isolationLevel: 'Serializable' });
  recordWebhookDeliveryLeaseReaped(rows.length);
  return Object.freeze({
    reaped: rows.length,
    dead: rows.filter((row) => row.status === 'dead').length,
    rows: Object.freeze(rows),
  });
}

export async function listDeliveries({
  tenantId,
  subscriptionId = null,
  status = null,
  eventType = null,
  limit = 50,
} = {}) {
  const tid = requireTenantId(tenantId);
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (subscriptionId) {
    params.push(normalizeId(subscriptionId, 'subscription_id'));
    filters.push(`subscription_id = $${params.length}::integer`);
  }
  if (status) {
    const normalizedStatus = String(status).trim();
    if (!DELIVERY_STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`status must be one of: ${DELIVERY_STATUSES.join(', ')}`);
    }
    params.push(normalizedStatus);
    filters.push(`status = $${params.length}::text`);
  }
  if (eventType) {
    params.push(safeText(eventType, 120, 'event_type', { required: true }));
    filters.push(`event_type = $${params.length}::text`);
  }
  const safeLimit = boundedInteger(limit, 50, 1, 500, 'limit');
  try {
    const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
      `SELECT id, subscription_id, tenant_id, event_outbox_id::text, event_type,
              status, attempt_number, http_status, response_excerpt,
              error_message, signature, request_id, started_at,
              completed_at, next_retry_at, lease_owner, lease_expires_at,
              redrive_count, created_at, updated_at
         FROM webhook_deliveries
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1}::integer`,
      ...params,
      safeLimit,
    ));
    return { deliveries: rows, count: rows.length };
  } catch (error) {
    if (isMissingSchemaError(error)) return { deliveries: [], count: 0 };
    throw error;
  }
}

export async function getDelivery({ tenantId, id } = {}) {
  const tid = requireTenantId(tenantId);
  const deliveryId = normalizeId(id, 'delivery id');
  const rows = await setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id, subscription_id, tenant_id, event_outbox_id::text, event_type,
            payload, status, attempt_number, http_status, response_excerpt,
            error_message, signature, request_id, started_at, completed_at,
            next_retry_at, lease_owner, lease_expires_at, redrive_count,
            created_at, updated_at
       FROM webhook_deliveries
      WHERE tenant_id = $1::uuid
        AND id = $2::integer
      LIMIT 1`,
    tid,
    deliveryId,
  ));
  if (!rows[0]) throw AppError.notFound('Webhook delivery not found');
  return rows[0];
}

async function auditedDeliveryMutation({
  tenantId,
  id,
  reason,
  actorUid,
  actorRole,
  requestId,
  operation,
}) {
  const tid = requireTenantId(tenantId);
  const deliveryId = normalizeId(id, 'delivery id');
  const operatorReason = safeText(reason, 1_000, 'reason', { required: true });
  const actor = actorContext({ actorUid, actorRole, requestId });
  const result = await setTenantTx(tid, async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, subscription_id, status, attempt_number, error_message,
              redrive_count
         FROM webhook_deliveries
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
        LIMIT 1
        FOR UPDATE`,
      tid,
      deliveryId,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Webhook delivery not found or not eligible');
    const eligible = operation === 'redrive'
      ? current.status === 'dead'
      : ['pending', 'failed'].includes(current.status);
    if (!eligible) {
      throw AppError.conflict(
        operation === 'redrive'
          ? 'Webhook delivery is not in the dead state'
          : 'Webhook delivery is not pending or retryable-failed',
      );
    }
    const rows = operation === 'redrive'
      ? await tx.$queryRawUnsafe(
        `UPDATE webhook_deliveries
            SET status = 'pending',
                attempt_number = 0,
                http_status = NULL,
                response_excerpt = NULL,
                error_message = NULL,
                signature = NULL,
                started_at = NULL,
                completed_at = NULL,
                next_retry_at = NOW(),
                lease_owner = NULL,
                lease_expires_at = NULL,
                redrive_count = redrive_count + 1,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
            AND status = 'dead'
        RETURNING id, subscription_id, tenant_id, event_outbox_id::text,
                  event_type, status, attempt_number, redrive_count`,
        tid,
        deliveryId,
      )
      : await tx.$queryRawUnsafe(
        `UPDATE webhook_deliveries
            SET status = 'dead',
                error_message = $3::text,
                next_retry_at = NULL,
                completed_at = COALESCE(completed_at, NOW()),
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
            AND status IN ('pending', 'failed')
        RETURNING id, subscription_id, tenant_id, event_outbox_id::text,
                  event_type, status, attempt_number, redrive_count`,
        tid,
        deliveryId,
        operatorReason,
      );
    if (rows.length !== 1) throw AppError.conflict('Webhook delivery mutation lost its state fence');
    const action = operation === 'redrive'
      ? 'WEBHOOK_DELIVERY_REDRIVEN'
      : 'WEBHOOK_DELIVERY_MARKED_DEAD';
    await tx.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
               'webhook_delivery', $5::text, $6::jsonb, NOW())`,
      tid,
      actor.uid,
      actor.role,
      action,
      String(deliveryId),
      JSON.stringify({
        reason: operatorReason,
        request_id: actor.requestId,
        prior_status: current.status,
        prior_attempt_number: Number(current.attempt_number),
        prior_error: current.error_message || null,
        prior_redrive_count: Number(current.redrive_count),
        resulting_status: rows[0].status,
        resulting_attempt_number: Number(rows[0].attempt_number),
      }),
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });
  if (operation === 'redrive') recordOutboxOperatorRedrive('webhook_delivery');
  return result;
}

export async function markDeliveryDead(options = {}) {
  return auditedDeliveryMutation({ ...options, operation: 'mark_dead' });
}

export async function redriveDelivery(options = {}) {
  return auditedDeliveryMutation({ ...options, operation: 'redrive' });
}

export const __testing__ = Object.freeze({
  BACKOFF_SECONDS,
  DELIVERY_STATUSES,
  RETRY_LIMIT,
  backoffSecondsForAttempt,
  computeNextRetryAt,
  isRetryable,
});

export default {
  dispatchPendingDeliveries,
  enqueueDelivery,
  getDelivery,
  listDeliveries,
  markDeliveryDead,
  reapStaleInFlightDeliveries,
  redriveDelivery,
};
