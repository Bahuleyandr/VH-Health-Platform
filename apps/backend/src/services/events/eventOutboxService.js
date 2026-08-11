import { randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  recordEventDeadLettered,
  recordEventOutboxLeaseReaped,
  recordOutboxOperatorRedrive,
} from '../../observability/reliabilityMetrics.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_LEASE_SECONDS = 120;
const MAX_LEASE_SECONDS = 900;
const MAX_ATTEMPTS = 7;
const MAX_DB_INTEGER = 2_147_483_647;
const BACKOFF_SECONDS = [30, 120, 600, 1_800, 3_600, 14_400, 28_800];
const EVENT_STATUSES = Object.freeze(['pending', 'processing', 'delivered', 'failed']);
const EVENT_ID_PATTERN = /^[1-9][0-9]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

function boundedInteger(value, fallback, min, max, label) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw AppError.badRequest(`${label} is invalid`, 'EVENT_OUTBOX_QUERY_INVALID');
  }
  return candidate;
}

function normalizeEventId(value, label = 'event id') {
  const normalized = String(value ?? '').trim();
  if (!EVENT_ID_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a positive BIGINT decimal string`);
  }
  try {
    if (BigInt(normalized) > PG_BIGINT_MAX) throw new RangeError('BIGINT overflow');
  } catch {
    throw AppError.badRequest(`${label} must be a positive BIGINT decimal string`);
  }
  return normalized;
}

function normalizeUuid(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw AppError.badRequest(`${label} must be a UUID`);
  return normalized;
}

function safeText(value, max, label, { required = false } = {}) {
  const normalized = value == null ? '' : String(value).trim();
  if (required && !normalized) throw AppError.badRequest(`${label} is required`);
  if (normalized.length > max) throw AppError.badRequest(`${label} is too long`);
  return normalized || null;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload;
}

function normalizeOccurredAt(value, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) {
      throw AppError.badRequest(
        'occurredAt is required for replay-origin events',
        'EVENT_OUTBOX_OCCURRENCE_REQUIRED',
      );
    }
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest(
      'occurredAt must be a valid timestamp',
      'EVENT_OUTBOX_OCCURRENCE_INVALID',
    );
  }
  return parsed.toISOString();
}

function normalizeRecoveryContract(recovery, occurredAt) {
  if (recovery === null || recovery === undefined) {
    return Object.freeze({
      inboxId: null,
      fingerprint: null,
      effectDisposition: null,
    });
  }
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    throw AppError.badRequest('recovery must be an object', 'EVENT_OUTBOX_RECOVERY_INVALID');
  }
  const fingerprint = String(recovery.fingerprint || '').trim().toLowerCase();
  const effectDisposition = String(recovery.effectDisposition || '').trim();
  if (!UUID_PATTERN.test(String(recovery.inboxId || '')) || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw AppError.badRequest(
      'recovery inbox identity and fingerprint are invalid',
      'EVENT_OUTBOX_RECOVERY_INVALID',
    );
  }
  if (!['normal', 'late_pending_only', 'signed_exception'].includes(effectDisposition)) {
    throw AppError.badRequest(
      'recovery effect disposition is invalid',
      'EVENT_OUTBOX_RECOVERY_INVALID',
    );
  }
  normalizeOccurredAt(occurredAt, { required: true });
  return Object.freeze({
    inboxId: String(recovery.inboxId).toLowerCase(),
    fingerprint,
    effectDisposition,
  });
}

function normalizeRetrospectiveEffectDisposition({
  eventType,
  aggregateType,
  aggregateId,
  patientUid,
  tenantId,
  occurredAt,
  recovery,
  retrospectiveEffectDisposition,
}) {
  if (retrospectiveEffectDisposition === null || retrospectiveEffectDisposition === undefined) {
    return null;
  }
  const validPaperFact = (
    retrospectiveEffectDisposition === 'late_pending_only'
    && eventType === 'clinical_continuity.paper_fact.recorded'
    && aggregateType === 'clinical_continuity_retrospective_fact'
    && UUID_PATTERN.test(String(aggregateId || ''))
    && UUID_PATTERN.test(String(patientUid || ''))
    && UUID_PATTERN.test(String(tenantId || ''))
    && (recovery === null || recovery === undefined)
  );
  if (!validPaperFact) {
    throw AppError.badRequest(
      'retrospective effect disposition is invalid for this event',
      'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID',
    );
  }
  normalizeOccurredAt(occurredAt, { required: true });
  return 'late_pending_only';
}

function backoffSecondsForAttempt(attemptNumber) {
  const index = Math.max(0, Math.min(attemptNumber - 1, BACKOFF_SECONDS.length - 1));
  return BACKOFF_SECONDS[index];
}

function normalizeClaim(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw AppError.badRequest('event claim is required');
  }
  const attempts = boundedInteger(claim.attempts, null, 1, MAX_DB_INTEGER, 'claim attempts');
  return Object.freeze({
    id: normalizeEventId(claim.id),
    tenantId: requireTenantId(claim.tenant_id || claim.tenantId),
    leaseOwner: normalizeUuid(claim.lease_owner || claim.leaseOwner, 'claim lease owner'),
    attempts,
  });
}

export async function publishEvent({
  eventType,
  aggregateType,
  aggregateId = null,
  patientUid = null,
  payload = {},
  tx = null,
  tenantId = null,
  occurredAt = null,
  recovery = null,
  retrospectiveEffectDisposition = null,
}) {
  if (!eventType || !aggregateType) {
    logger.warn('Skipped event_outbox insert: missing eventType or aggregateType', {
      eventType,
      aggregateType,
    });
    return null;
  }
  const normalizedOccurredAt = normalizeOccurredAt(occurredAt);
  const recoveryContract = normalizeRecoveryContract(recovery, occurredAt);
  const retrospectiveDisposition = normalizeRetrospectiveEffectDisposition({
    eventType,
    aggregateType,
    aggregateId,
    patientUid,
    tenantId,
    occurredAt,
    recovery,
    retrospectiveEffectDisposition,
  });
  const client = tx ?? prisma;
  const insert = () => (tenantId
    ? client.$queryRawUnsafe(
      `WITH clock AS (SELECT NOW() AS inserted_at)
       INSERT INTO event_outbox
         (event_type, aggregate_type, aggregate_id, patient_uid, payload, tenant_id,
          status, available_at, created_at, occurred_at, occurred_at_source,
          recovery_inbox_id, recovery_fingerprint, recovery_effect_disposition)
       SELECT $1, $2, $3, $4::uuid, $5::jsonb, $6::uuid, 'pending',
              clock.inserted_at, clock.inserted_at,
              COALESCE($7::timestamptz, clock.inserted_at), 'explicit',
              $8::uuid, $9::char(64), $10::text
         FROM clock
       RETURNING id::text, event_type, aggregate_type, aggregate_id, patient_uid,
                 status, tenant_id, created_at, occurred_at, occurred_at_source,
                 recovery_inbox_id::text, recovery_fingerprint,
                 recovery_effect_disposition`,
      eventType,
      aggregateType,
      aggregateId ? String(aggregateId) : null,
      patientUid || null,
      JSON.stringify(normalizePayload(payload)),
      String(tenantId),
      normalizedOccurredAt,
      recoveryContract.inboxId,
      recoveryContract.fingerprint,
      retrospectiveDisposition || recoveryContract.effectDisposition,
    )
    : client.$queryRawUnsafe(
      `WITH clock AS (SELECT NOW() AS inserted_at)
       INSERT INTO event_outbox
         (event_type, aggregate_type, aggregate_id, patient_uid, payload,
          status, available_at, created_at, occurred_at, occurred_at_source,
          recovery_inbox_id, recovery_fingerprint, recovery_effect_disposition)
       SELECT $1, $2, $3, $4::uuid, $5::jsonb, 'pending',
              clock.inserted_at, clock.inserted_at,
              COALESCE($6::timestamptz, clock.inserted_at), 'explicit',
              $7::uuid, $8::char(64), $9::text
         FROM clock
       RETURNING id::text, event_type, aggregate_type, aggregate_id, patient_uid,
                 status, tenant_id, created_at, occurred_at, occurred_at_source,
                 recovery_inbox_id::text, recovery_fingerprint,
                 recovery_effect_disposition`,
      eventType,
      aggregateType,
      aggregateId ? String(aggregateId) : null,
      patientUid || null,
      JSON.stringify(normalizePayload(payload)),
      normalizedOccurredAt,
      recoveryContract.inboxId,
      recoveryContract.fingerprint,
      retrospectiveDisposition || recoveryContract.effectDisposition,
    ));
  if (tx) return (await insert())[0];
  try {
    return (await insert())[0];
  } catch (error) {
    logger.warn('Failed to publish event_outbox event', {
      eventType,
      aggregateType,
      error: error.message,
    });
    return null;
  }
}

export async function listEvents({
  tenantId,
  status = 'pending',
  limit = DEFAULT_LIMIT,
  offset = 0,
} = {}) {
  const tid = requireTenantId(tenantId);
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!EVENT_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(`status must be one of: ${EVENT_STATUSES.join(', ')}`);
  }
  const safeLimit = boundedInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const safeOffset = boundedInteger(offset, 0, 0, 10_000, 'offset');
  return setTenantTx(tid, (tx) => tx.$queryRawUnsafe(
    `SELECT id::text, event_type, aggregate_type, aggregate_id, patient_uid, payload,
            status, attempts, available_at, last_error, created_at, occurred_at,
            occurred_at_source, recovery_inbox_id::text, recovery_fingerprint,
            recovery_effect_disposition, delivered_at, lease_owner,
            lease_expires_at, redrive_count
       FROM event_outbox
      WHERE tenant_id = $1::uuid
        AND status = $2::text
      ORDER BY available_at ASC, id ASC
      LIMIT $3::integer OFFSET $4::integer`,
    tid,
    normalizedStatus,
    safeLimit,
    safeOffset,
  ));
}

export async function claimPendingEvents({
  limit = DEFAULT_LIMIT,
  leaseOwner = randomUUID(),
  leaseSeconds = DEFAULT_LEASE_SECONDS,
} = {}) {
  const safeLimit = boundedInteger(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const owner = normalizeUuid(leaseOwner, 'lease owner');
  const seconds = boundedInteger(
    leaseSeconds,
    DEFAULT_LEASE_SECONDS,
    1,
    MAX_LEASE_SECONDS,
    'lease seconds',
  );
  return setTenantTx(null, (tx) => tx.$queryRawUnsafe(
      `WITH due AS (
         SELECT tenant_id, id
           FROM event_outbox
          WHERE status = 'pending'
            AND available_at <= NOW()
          ORDER BY available_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1::integer
       )
       UPDATE event_outbox AS event
          SET status = 'processing',
              attempts = event.attempts + 1,
              lease_owner = $2::uuid,
              lease_expires_at = NOW() + ($3::integer * INTERVAL '1 second')
         FROM due
        WHERE event.tenant_id = due.tenant_id
          AND event.id = due.id
          AND event.status = 'pending'
        RETURNING event.id::text, event.event_type, event.aggregate_type,
                  event.aggregate_id, event.patient_uid, event.payload,
                  event.occurred_at, event.occurred_at_source,
                  event.recovery_inbox_id::text, event.recovery_fingerprint,
                  event.recovery_effect_disposition,
                  event.status, event.attempts, event.available_at,
                  event.tenant_id, event.lease_owner, event.lease_expires_at`,
      safeLimit,
      owner,
      seconds,
    ), { superAdmin: true });
}

export async function completeClaimedEventFanout({ claim } = {}) {
  const fence = normalizeClaim(claim);
  return setTenantTx(fence.tenantId, async (tx) => {
    const sourceRows = await tx.$queryRawUnsafe(
      `SELECT id::text, event_type, payload, recovery_effect_disposition
         FROM event_outbox
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'processing'
          AND lease_owner = $3::uuid
          AND attempts = $4::integer
        LIMIT 1
        FOR UPDATE`,
      fence.tenantId,
      fence.id,
      fence.leaseOwner,
      fence.attempts,
    );
    const source = sourceRows[0];
    if (!source) return Object.freeze({ lost_fence: true, delivered: false, enqueued: 0 });

    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO webhook_deliveries
         (subscription_id, tenant_id, event_outbox_id, event_type, payload,
          status, attempt_number, next_retry_at, request_id, source_kind,
          source_identity, source_position, payload_sha256,
          downstream_effect_classification, acknowledgement_contract,
          acknowledgement_config, acknowledgement_state,
          send_authority, effect_disposition)
       SELECT subscription.id, subscription.tenant_id, $2::bigint,
              $3::text, $4::jsonb, 'pending', 0,
              CASE WHEN $5::text = 'late_pending_only' THEN NULL ELSE NOW() END,
              gen_random_uuid()::text,
              'event_outbox', 'event_outbox:' || $2::bigint::text,
              $2::bigint, encode(digest($4::jsonb::text, 'sha256'), 'hex'),
              subscription.downstream_effect_classification,
              subscription.acknowledgement_contract,
              subscription.acknowledgement_config,
              CASE WHEN subscription.acknowledgement_contract = 'unclassified'
                   THEN 'unclassified' ELSE 'pending' END,
              CASE WHEN $5::text = 'late_pending_only'
                   THEN 'held_owner_reconciliation' ELSE 'live_authorized' END,
              CASE WHEN $5::text = 'late_pending_only'
                   THEN 'late_pending_only' ELSE 'live' END
         FROM webhook_subscriptions AS subscription
         JOIN integrations AS integration
           ON integration.tenant_id = subscription.tenant_id
          AND integration.id = subscription.integration_id
          AND integration.status = 'active'
        WHERE subscription.tenant_id = $1::uuid
          AND subscription.event_type = $3::text
          AND subscription.is_active = TRUE
          AND subscription.event_filter = '{}'::jsonb
       ON CONFLICT (tenant_id, event_outbox_id, subscription_id)
         WHERE event_outbox_id IS NOT NULL AND subscription_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      fence.tenantId,
      fence.id,
      source.event_type,
      JSON.stringify(normalizePayload(source.payload)),
      source.recovery_effect_disposition,
    );
    const coverage = await tx.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS eligible_count,
              COUNT(delivery.id)::integer AS covered_count
         FROM webhook_subscriptions AS subscription
         JOIN integrations AS integration
           ON integration.tenant_id = subscription.tenant_id
          AND integration.id = subscription.integration_id
          AND integration.status = 'active'
         LEFT JOIN webhook_deliveries AS delivery
           ON delivery.tenant_id = subscription.tenant_id
          AND delivery.subscription_id = subscription.id
          AND delivery.event_outbox_id = $2::bigint
        WHERE subscription.tenant_id = $1::uuid
          AND subscription.event_type = $3::text
          AND subscription.is_active = TRUE
          AND subscription.event_filter = '{}'::jsonb`,
      fence.tenantId,
      fence.id,
      source.event_type,
    );
    if (coverage[0].eligible_count !== coverage[0].covered_count) {
      throw new Error('Webhook fan-out coverage is incomplete');
    }
    const completed = await tx.$queryRawUnsafe(
      `UPDATE event_outbox
          SET status = 'delivered',
              delivered_at = NOW(),
              last_error = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'processing'
          AND lease_owner = $3::uuid
          AND attempts = $4::integer
      RETURNING id::text, status, delivered_at`,
      fence.tenantId,
      fence.id,
      fence.leaseOwner,
      fence.attempts,
    );
    if (completed.length !== 1) {
      throw new Error('Event outbox completion fence was lost inside the locked transaction');
    }
    return Object.freeze({
      lost_fence: false,
      delivered: true,
      enqueued: inserted.length,
      eligible: coverage[0].eligible_count,
      event: completed[0],
    });
  }, { isolationLevel: 'Serializable' });
}

export async function failClaimedEvent({ claim, message } = {}) {
  const fence = normalizeClaim(claim);
  const reason = safeText(message || 'Unknown delivery failure', 2_000, 'failure reason', {
    required: true,
  });
  const deadLetter = fence.attempts >= MAX_ATTEMPTS;
  const backoff = backoffSecondsForAttempt(fence.attempts);
  const rows = await setTenantTx(fence.tenantId, (tx) => tx.$queryRawUnsafe(
    `UPDATE event_outbox
        SET status = CASE WHEN $5::boolean THEN 'failed' ELSE 'pending' END,
            available_at = CASE
              WHEN $5::boolean THEN available_at
              ELSE NOW() + ($6::integer * INTERVAL '1 second')
            END,
            last_error = $7::text,
            delivered_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'processing'
        AND lease_owner = $3::uuid
        AND attempts = $4::integer
    RETURNING id::text, tenant_id, status, attempts, available_at, last_error`,
    fence.tenantId,
    fence.id,
    fence.leaseOwner,
    fence.attempts,
    deadLetter,
    backoff,
    reason,
  ));
  if (rows.length !== 1) return Object.freeze({ lost_fence: true, failed: false });
  if (deadLetter) recordEventDeadLettered();
  return Object.freeze({ lost_fence: false, failed: true, event: rows[0] });
}

export async function reapStaleProcessingEvents({ limit = MAX_LIMIT } = {}) {
  const safeLimit = boundedInteger(limit, MAX_LIMIT, 1, MAX_LIMIT, 'limit');
  const rows = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
    `WITH stale AS MATERIALIZED (
       SELECT tenant_id, id, lease_owner, attempts
         FROM event_outbox
        WHERE status = 'processing'
          AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $1::integer
     )
     UPDATE event_outbox AS event
        SET status = CASE WHEN stale.attempts >= $2::integer THEN 'failed' ELSE 'pending' END,
            available_at = CASE
              WHEN stale.attempts >= $2::integer THEN event.available_at
              ELSE NOW() + (
                CASE stale.attempts
                  WHEN 1 THEN 30 WHEN 2 THEN 120 WHEN 3 THEN 600
                  WHEN 4 THEN 1800 WHEN 5 THEN 3600 WHEN 6 THEN 14400
                  ELSE 28800
                END * INTERVAL '1 second'
              )
            END,
            last_error = 'reaped: stale processing lease expired',
            lease_owner = NULL,
            lease_expires_at = NULL
       FROM stale
      WHERE event.tenant_id = stale.tenant_id
        AND event.id = stale.id
        AND event.status = 'processing'
        AND event.lease_owner = stale.lease_owner
        AND event.attempts = stale.attempts
    RETURNING event.id::text, event.tenant_id, event.status, event.attempts`,
    safeLimit,
    MAX_ATTEMPTS,
  ), { superAdmin: true, isolationLevel: 'Serializable' });
  for (const row of rows) {
    if (row.status === 'failed') recordEventDeadLettered();
  }
  recordEventOutboxLeaseReaped(rows.length);
  return Object.freeze({
    reaped: rows.length,
    dead: rows.filter((row) => row.status === 'failed').length,
    rows: Object.freeze(rows),
  });
}

export async function redriveFailedEvent({
  tenantId,
  id,
  reason,
  actorUid,
  actorRole,
  requestId = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const eventId = normalizeEventId(id);
  const operatorReason = safeText(reason, 1_000, 'reason', { required: true });
  const uid = normalizeUuid(actorUid, 'actor uid');
  const role = safeText(actorRole, 50, 'actor role', { required: true });
  const request = safeText(requestId, 180, 'request id');
  const result = await setTenantTx(tid, async (tx) => {
    const current = await tx.$queryRawUnsafe(
      `SELECT id::text, status, attempts, last_error, redrive_count
         FROM event_outbox
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
        LIMIT 1
        FOR UPDATE`,
      tid,
      eventId,
    );
    if (!current[0]) throw AppError.notFound('Event outbox row not found or not eligible');
    if (current[0].status !== 'failed') {
      throw AppError.conflict('Event outbox row is not in the failed dead-letter state');
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE event_outbox
          SET status = 'pending',
              attempts = 0,
              available_at = NOW(),
              last_error = NULL,
              delivered_at = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              redrive_count = redrive_count + 1
        WHERE tenant_id = $1::uuid
          AND id = $2::bigint
          AND status = 'failed'
      RETURNING id::text, tenant_id, status, attempts, available_at, redrive_count`,
      tid,
      eventId,
    );
    if (rows.length !== 1) throw AppError.conflict('Event outbox redrive lost its state fence');
    await tx.$queryRawUnsafe(
      `INSERT INTO audit_logs
         (tenant_id, uid, role, action, resource, resource_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text, 'EVENT_OUTBOX_REDRIVEN',
               'event_outbox', $4::text, $5::jsonb, NOW())`,
      tid,
      uid,
      role,
      eventId,
      JSON.stringify({
        reason: operatorReason,
        request_id: request,
        prior_status: current[0].status,
        prior_attempts: Number(current[0].attempts),
        prior_error: current[0].last_error || null,
        prior_redrive_count: Number(current[0].redrive_count),
        resulting_status: 'pending',
        resulting_attempts: 0,
      }),
    );
    return rows[0];
  }, { isolationLevel: 'Serializable' });
  recordOutboxOperatorRedrive('event_outbox');
  return result;
}

export const __testing__ = Object.freeze({
  BACKOFF_SECONDS,
  EVENT_STATUSES,
  MAX_ATTEMPTS,
  backoffSecondsForAttempt,
  normalizeEventId,
});

export default {
  claimPendingEvents,
  completeClaimedEventFanout,
  failClaimedEvent,
  listEvents,
  publishEvent,
  reapStaleProcessingEvents,
  redriveFailedEvent,
};
