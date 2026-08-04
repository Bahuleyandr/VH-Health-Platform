import { createHash } from 'node:crypto';
import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { parseHL7 } from './hl7Parser.js';

const ACK_CODES = new Set(['AA', 'AE', 'AR']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requirePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw AppError.badRequest(`${label} is invalid`, 'HL7_OUTBOUND_DELIVERY_INPUT_INVALID');
  }
  return number;
}

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'HL7_OUTBOUND_DELIVERY_INPUT_INVALID');
  }
  return text;
}

function requireOwnerReason(value) {
  const reason = String(value || '').trim();
  if (!reason || reason.length > 500) {
    throw AppError.badRequest('owner_reason is required', 'HL7_OUTBOUND_OWNER_REASON_REQUIRED');
  }
  return reason;
}

function normalizeEvidence(value) {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('evidence must be an object', 'HL7_OUTBOUND_DELIVERY_INPUT_INVALID');
  }
  return value;
}

export function sha256Bytes(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

export function parseHl7MsaAcknowledgement(rawAcknowledgement, expectedControlId) {
  const raw = String(rawAcknowledgement ?? '');
  const payloadSha256 = sha256Bytes(raw);
  if (!raw.trim()) {
    return Object.freeze({
      state: 'missing',
      msaCode: null,
      acknowledgedControlId: null,
      correlationMatches: false,
      payloadSha256,
      textMessage: null,
    });
  }

  try {
    const parsed = parseHL7(raw);
    const msaSegments = parsed.segments.filter(segment => segment.type === 'MSA');
    if (msaSegments.length !== 1) {
      return Object.freeze({
        state: 'invalid',
        msaCode: null,
        acknowledgedControlId: null,
        correlationMatches: false,
        payloadSha256,
        textMessage: null,
      });
    }
    const fields = msaSegments[0].fields;
    const msaCode = String(fields[1] || '').trim().toUpperCase();
    const acknowledgedControlId = String(fields[2] || '').trim();
    const textMessage = String(fields[3] || '').trim() || null;
    if (!ACK_CODES.has(msaCode) || !acknowledgedControlId) {
      return Object.freeze({
        state: 'invalid',
        msaCode: ACK_CODES.has(msaCode) ? msaCode : null,
        acknowledgedControlId: acknowledgedControlId || null,
        correlationMatches: false,
        payloadSha256,
        textMessage,
      });
    }
    const correlationMatches = acknowledgedControlId === String(expectedControlId || '');
    return Object.freeze({
      state: correlationMatches ? msaCode.toLowerCase() : 'control_id_mismatch',
      msaCode,
      acknowledgedControlId,
      correlationMatches,
      payloadSha256,
      textMessage,
    });
  } catch {
    return Object.freeze({
      state: 'invalid',
      msaCode: null,
      acknowledgedControlId: null,
      correlationMatches: false,
      payloadSha256,
      textMessage: null,
    });
  }
}

async function ensureCursorTx(tx, tenantId, subscriptionId) {
  await tx.$executeRawUnsafe(
    `INSERT INTO hl7_outbound_delivery_cursors (tenant_id, subscription_id)
     VALUES ($1::uuid, $2::integer)
     ON CONFLICT (tenant_id, subscription_id) DO NOTHING`,
    tenantId, subscriptionId,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT tenant_id::text, subscription_id, last_contiguous_message_id,
            state, blocked_message_id, inflight_message_id, updated_at
       FROM hl7_outbound_delivery_cursors
      WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
      FOR UPDATE`,
    tenantId, subscriptionId,
  );
  return rows[0];
}

export async function claimPendingFeedMessages({ tenantId, limit = 25 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `WITH candidates AS (
         SELECT message.id
           FROM hl7_outbound_messages AS message
          WHERE message.tenant_id = $1::uuid
            AND message.ledger_version = 1
            AND message.status IN ('queued', 'failed')
             AND message.send_authority = 'authorized'
             AND message.next_attempt_at <= NOW()
             AND (
               (message.recovery_inbox_id IS NULL AND message.owner_release_client_event_id IS NULL)
               OR (
                 message.recovery_inbox_id IS NOT NULL
                 AND message.owner_release_client_event_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM clinical_continuity_replay_receipts AS receipt
                     JOIN clinical_continuity_replay_effect_evidence AS effect
                       ON effect.tenant_id = receipt.tenant_id
                      AND effect.client_event_id = receipt.client_event_id
                    WHERE receipt.tenant_id = message.tenant_id
                      AND receipt.client_event_id = message.owner_release_client_event_id
                      AND receipt.source_kind = 'held_message_release'
                      AND receipt.disposition = 'applied'
                      AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                      AND effect.interface_family = 'I04'
                      AND effect.hl7_outbound_message_id = message.id
                      AND effect.network_send_performed = false
                 )
               )
             )
            AND EXISTS (
              SELECT 1
                FROM hl7_feed_subscriptions AS active_subscription
               WHERE active_subscription.tenant_id = message.tenant_id
                 AND active_subscription.id = message.subscription_id
                 AND active_subscription.is_active
            )
            AND NOT EXISTS (
              SELECT 1
                FROM hl7_outbound_delivery_cursors AS cursor
               WHERE cursor.tenant_id = message.tenant_id
                 AND cursor.subscription_id = message.subscription_id
                 AND cursor.state <> 'ready'
            )
            -- Contiguity is a property of the LEDGER generation only.
            -- Migration 610 backfilled every pre-existing row to
            -- ledger_version = 0 / acknowledgement_state = 'legacy_unknown',
            -- and those rows can never reach 'aa' (the old worker kept no
            -- response body, and a legacy row may not even have an MSH-10 to
            -- correlate against). Scanning them here makes contiguity
            -- unsatisfiable forever on any feed with pre-610 history — ids are
            -- IDENTITY-allocated, so every new message sorts after the whole
            -- legacy backlog. Index: idx_hl7_outbound_messages_contiguity_gap.
            AND NOT EXISTS (
              SELECT 1
                FROM hl7_outbound_messages AS earlier
               WHERE earlier.tenant_id = message.tenant_id
                 AND earlier.subscription_id = message.subscription_id
                 AND earlier.id < message.id
                 AND earlier.ledger_version = 1
                 AND earlier.acknowledgement_state <> 'aa'
            )
            AND message.id = (
              SELECT MIN(first_due.id)
                FROM hl7_outbound_messages AS first_due
               WHERE first_due.tenant_id = message.tenant_id
                 AND first_due.subscription_id = message.subscription_id
                 AND first_due.ledger_version = 1
                 AND first_due.status IN ('queued', 'failed')
                  AND first_due.send_authority = 'authorized'
                  AND first_due.next_attempt_at <= NOW()
                  AND (
                    (first_due.recovery_inbox_id IS NULL AND first_due.owner_release_client_event_id IS NULL)
                    OR (
                      first_due.recovery_inbox_id IS NOT NULL
                      AND first_due.owner_release_client_event_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1
                          FROM clinical_continuity_replay_receipts AS receipt
                          JOIN clinical_continuity_replay_effect_evidence AS effect
                            ON effect.tenant_id = receipt.tenant_id
                           AND effect.client_event_id = receipt.client_event_id
                         WHERE receipt.tenant_id = first_due.tenant_id
                           AND receipt.client_event_id = first_due.owner_release_client_event_id
                           AND receipt.source_kind = 'held_message_release'
                           AND receipt.disposition = 'applied'
                           AND receipt.outcome_code = 'held_message_send_authority_rearmed'
                           AND effect.interface_family = 'I04'
                           AND effect.hl7_outbound_message_id = first_due.id
                           AND effect.network_send_performed = false
                      )
                    )
                  )
            )
          ORDER BY message.id
          LIMIT $2::integer
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE hl7_outbound_messages AS message
            SET status = 'claimed', claim_token = gen_random_uuid(),
                claim_generation = claim_generation + 1,
                claimed_at = NOW(), lease_expires_at = NOW() + INTERVAL '2 minutes'
           FROM candidates
          WHERE message.tenant_id = $1::uuid AND message.id = candidates.id
          RETURNING message.*
       )
       SELECT claimed.id, claimed.tenant_id::text, claimed.subscription_id,
              claimed.message_type, claimed.message_control_id,
              claimed.hl7_payload, claimed.payload_sha256, claimed.attempts,
              claimed.claim_token::text, claimed.claim_generation,
              subscription.endpoint_url, subscription.auth_header
         FROM claimed
         JOIN hl7_feed_subscriptions AS subscription
           ON subscription.tenant_id = claimed.tenant_id
          AND subscription.id = claimed.subscription_id
          AND subscription.is_active
        ORDER BY claimed.id`,
      tid, safeLimit,
    );
    return rows.map(row => Object.freeze(row));
  }, { isolationLevel: 'Serializable' });
}

export async function beginTransportAttempt({
  tenantId,
  messageId,
  subscriptionId,
  claimToken,
  claimGeneration,
  payloadSha256,
} = {}) {
  const tid = requireTenantId(tenantId);
  const mid = requirePositiveInteger(messageId, 'message_id');
  const sid = requirePositiveInteger(subscriptionId, 'subscription_id');
  const generation = requirePositiveInteger(claimGeneration, 'claim_generation');
  const token = requireUuid(claimToken, 'claim_token');
  return setTenantTx(tid, async (tx) => {
    const cursor = await ensureCursorTx(tx, tid, sid);
    if (cursor.state !== 'ready') {
      return Object.freeze({ state: 'blocked', reason: cursor.state });
    }
    const attempts = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_outbound_transport_attempts
         (tenant_id, message_id, subscription_id, claim_token,
          claim_generation, attempt_number, payload_sha256)
       SELECT $1::uuid, $2::integer, $3::integer, $4::uuid, $5::integer,
              COALESCE(MAX(attempt_number), 0) + 1, $6::char(64)
         FROM hl7_outbound_transport_attempts
        WHERE tenant_id = $1::uuid AND message_id = $2::integer
       ON CONFLICT (tenant_id, message_id, claim_token) DO NOTHING
       RETURNING attempt_id::text, message_id, subscription_id,
                 claim_generation, attempt_number, payload_sha256, started_at`,
      tid, mid, sid, token, generation, payloadSha256,
    );
    let attempt = attempts[0];
    if (!attempt) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT attempt_id::text, message_id, subscription_id,
                claim_generation, attempt_number, payload_sha256, started_at
           FROM hl7_outbound_transport_attempts
          WHERE tenant_id = $1::uuid AND message_id = $2::integer
            AND claim_token = $3::uuid`,
        tid, mid, token,
      );
      attempt = existing[0];
    }
    if (!attempt) {
      throw AppError.conflict('HL7 send claim fence was lost', 'HL7_OUTBOUND_CLAIM_FENCE_LOST');
    }
    await tx.$executeRawUnsafe(
      `UPDATE hl7_outbound_delivery_cursors
          SET state = 'delivering', blocked_message_id = $3::integer,
              inflight_message_id = $3::integer, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer`,
      tid, sid, mid,
    );
    return Object.freeze({ ...attempt, state: 'ready' });
  }, { isolationLevel: 'Serializable' });
}

async function insertAcknowledgementTx(tx, {
  tenantId,
  attemptId = null,
  transportResultId = null,
  message,
  parsed,
  receiptSource,
  evidence = {},
  recoveryInboxId = null,
  ownerActorUid = null,
  ownerReason = null,
}) {
  if (!parsed.msaCode || !parsed.acknowledgedControlId) return null;
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO hl7_outbound_acknowledgements
       (tenant_id, attempt_id, transport_result_id, message_id,
        subscription_id, msa_code, acknowledged_control_id,
        correlation_matches, acknowledgement_payload_sha256,
        receipt_source, evidence, recovery_inbox_id,
        recovery_interface_family, owner_actor_uid, owner_reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
             $6::text, $7::text, $8::boolean, $9::char(64), $10::text,
             $11::jsonb, $12::uuid,
             CASE WHEN $12::uuid IS NULL THEN NULL ELSE 'I04' END,
             $13::uuid, $14::text)
     ON CONFLICT DO NOTHING
     RETURNING acknowledgement_id::text, message_id, subscription_id,
               msa_code, acknowledged_control_id, correlation_matches,
               acknowledgement_payload_sha256, receipt_source, observed_at`,
    tenantId, attemptId, transportResultId, message.id, message.subscription_id,
    parsed.msaCode, parsed.acknowledgedControlId, parsed.correlationMatches,
    parsed.payloadSha256, receiptSource, JSON.stringify(normalizeEvidence(evidence)),
    recoveryInboxId, ownerActorUid, ownerReason,
  );
  if (rows[0]) return rows[0];
  const existing = await tx.$queryRawUnsafe(
    `SELECT acknowledgement_id::text, message_id, subscription_id,
            msa_code, acknowledged_control_id, correlation_matches,
            acknowledgement_payload_sha256, receipt_source, observed_at
       FROM hl7_outbound_acknowledgements
      WHERE tenant_id = $1::uuid AND message_id = $2::integer
        AND receipt_source = $3::text
        AND COALESCE(attempt_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(recovery_inbox_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    tenantId, message.id, receiptSource, attemptId, recoveryInboxId,
  );
  return existing[0] || null;
}

async function applyAcknowledgementToCursorTx(tx, { tenantId, message, parsed }) {
  const cursor = await ensureCursorTx(tx, tenantId, message.subscription_id);
  if (parsed.state === 'aa') {
    // Same generation rule as claimPendingFeedMessages: only ledger_version = 1
    // predecessors can hold the cursor back. A pre-610 row is held for owner
    // reconciliation and can never be acknowledged, so treating it as an
    // unresolved predecessor would pin the cursor at 'paused_uncertain'
    // permanently on every feed that has history.
    const earlier = await tx.$queryRawUnsafe(
      `SELECT id
         FROM hl7_outbound_messages
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
          AND id < $3::integer AND ledger_version = 1
          AND acknowledgement_state <> 'aa'
        ORDER BY id LIMIT 1`,
      tenantId, message.subscription_id, message.id,
    );
    if (earlier.length > 0) {
      const paused = await tx.$queryRawUnsafe(
        `UPDATE hl7_outbound_delivery_cursors
            SET state = 'paused_uncertain', blocked_message_id = $3::integer,
                inflight_message_id = NULL, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
          RETURNING tenant_id::text, subscription_id,
                    last_contiguous_message_id, state, blocked_message_id`,
        tenantId, message.subscription_id, earlier[0].id,
      );
      return Object.freeze({ ...paused[0], advanced: false, reason: 'earlier_ack_unresolved' });
    }
    const advanced = await tx.$queryRawUnsafe(
      `UPDATE hl7_outbound_delivery_cursors
          SET last_contiguous_message_id = $3::integer, state = 'ready',
              blocked_message_id = NULL, inflight_message_id = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
          AND (
            last_contiguous_message_id IS NULL
            OR last_contiguous_message_id < $3::integer
          )
        RETURNING tenant_id::text, subscription_id,
                  last_contiguous_message_id, state, blocked_message_id`,
      tenantId, message.subscription_id, message.id,
    );
    return Object.freeze({ ...(advanced[0] || cursor), advanced: advanced.length === 1 });
  }

  const state = parsed.state === 'ae' || parsed.state === 'ar'
    ? 'paused_rejected'
    : 'paused_uncertain';
  const paused = await tx.$queryRawUnsafe(
    `UPDATE hl7_outbound_delivery_cursors
        SET state = $3::text, blocked_message_id = $4::integer,
            inflight_message_id = NULL, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
      RETURNING tenant_id::text, subscription_id,
                last_contiguous_message_id, state, blocked_message_id`,
    tenantId, message.subscription_id, state, message.id,
  );
  return Object.freeze({ ...paused[0], advanced: false });
}

export async function recordTransportOutcome({
  tenantId,
  messageId,
  claimToken,
  claimGeneration,
  attemptId,
  transport,
} = {}) {
  const tid = requireTenantId(tenantId);
  const mid = requirePositiveInteger(messageId, 'message_id');
  const generation = requirePositiveInteger(claimGeneration, 'claim_generation');
  const token = requireUuid(claimToken, 'claim_token');
  const aid = requireUuid(attemptId, 'attempt_id');
  const outcome = String(transport?.outcome || 'transport_failure');
  if (!['http_response', 'transport_failure'].includes(outcome)) {
    throw AppError.badRequest('transport outcome is invalid', 'HL7_OUTBOUND_DELIVERY_INPUT_INVALID');
  }
  return setTenantTx(tid, async (tx) => {
    const messages = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id::text, subscription_id, message_control_id,
              status, claim_token::text, claim_generation, send_authority
         FROM hl7_outbound_messages
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND status = 'claimed' AND claim_token = $3::uuid
          AND claim_generation = $4::integer
        FOR UPDATE`,
      tid, mid, token, generation,
    );
    if (messages.length !== 1) {
      throw AppError.conflict('HL7 send claim fence was lost', 'HL7_OUTBOUND_CLAIM_FENCE_LOST');
    }
    const message = messages[0];
    const responseBody = String(transport?.responseBody ?? '');
    const responseBodySha256 = responseBody ? sha256Bytes(responseBody) : null;
    const resultRows = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_outbound_transport_results
         (tenant_id, attempt_id, message_id, subscription_id, outcome,
          http_status, response_body_sha256, error_code, evidence)
       VALUES ($1::uuid, $2::uuid, $3::integer, $4::integer, $5::text,
               $6::integer, $7::char(64), $8::text, $9::jsonb)
       ON CONFLICT (tenant_id, attempt_id) DO NOTHING
       RETURNING transport_result_id::text, attempt_id::text, outcome,
                 http_status, response_body_sha256, error_code, observed_at`,
      tid, aid, mid, message.subscription_id, outcome,
      outcome === 'http_response' ? Number(transport.httpStatus) : null,
      responseBodySha256, transport?.errorCode || null,
      JSON.stringify(normalizeEvidence(transport?.evidence)),
    );
    let result = resultRows[0];
    if (!result) {
      const existing = await tx.$queryRawUnsafe(
        `SELECT transport_result_id::text, attempt_id::text, outcome,
                http_status, response_body_sha256, error_code, observed_at
           FROM hl7_outbound_transport_results
          WHERE tenant_id = $1::uuid AND attempt_id = $2::uuid`,
        tid, aid,
      );
      result = existing[0];
    }
    const parsed = outcome === 'http_response'
      ? parseHl7MsaAcknowledgement(responseBody, message.message_control_id)
      : Object.freeze({
          state: 'missing', msaCode: null, acknowledgedControlId: null,
          correlationMatches: false, payloadSha256: sha256Bytes(''), textMessage: null,
        });
    const acknowledgement = await insertAcknowledgementTx(tx, {
      tenantId: tid,
      attemptId: aid,
      transportResultId: result.transport_result_id,
      message,
      parsed,
      receiptSource: 'provider_response',
      evidence: {
        http_status: outcome === 'http_response' ? Number(transport.httpStatus) : null,
        msa_text_present: Boolean(parsed.textMessage),
      },
    });
    const cursor = await applyAcknowledgementToCursorTx(tx, { tenantId: tid, message, parsed });
    const positive = parsed.state === 'aa';
    const failureReason = positive
      ? null
      : outcome === 'transport_failure'
        ? (transport?.errorCode || 'transport_failure')
        : parsed.state === 'ae' || parsed.state === 'ar'
          ? `hl7_msa_${parsed.state}`
          : `hl7_ack_${parsed.state}`;
    const updated = await tx.$queryRawUnsafe(
      `UPDATE hl7_outbound_messages
          SET status = $5::text, attempts = attempts + 1,
              transport_state = $6::text,
              acknowledgement_state = $7::text,
              send_authority = $8::text,
              last_error = $9::text, sent_at = CASE WHEN $10::boolean THEN NOW() ELSE sent_at END,
              next_attempt_at = NOW(), claim_token = NULL, claimed_at = NULL,
              lease_expires_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND status = 'claimed' AND claim_token = $3::uuid
          AND claim_generation = $4::integer
        RETURNING id, status, transport_state, acknowledgement_state,
                  send_authority, attempts, sent_at`,
      tid, mid, token, generation,
      positive ? 'sent' : 'reconciliation_required',
      outcome === 'http_response' ? 'http_response' : 'transport_failure',
      parsed.state,
      positive ? 'authorized' : 'held_owner_reconciliation',
      failureReason,
      positive,
    );
    if (updated.length !== 1) {
      throw AppError.conflict('HL7 send claim fence was lost', 'HL7_OUTBOUND_CLAIM_FENCE_LOST');
    }
    if (positive) {
      await tx.$executeRawUnsafe(
        `UPDATE hl7_feed_subscriptions
            SET last_delivery_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        tid, message.subscription_id,
      );
    }
    return Object.freeze({ message: updated[0], transport: result, acknowledgement, cursor });
  }, { isolationLevel: 'Serializable' });
}

export async function reconcileExpiredClaims({ tenantId, limit = 50 } = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return setTenantTx(tid, async (tx) => {
    const expired = await tx.$queryRawUnsafe(
      `SELECT id, subscription_id, claim_token::text, claim_generation
         FROM hl7_outbound_messages
        WHERE tenant_id = $1::uuid AND status = 'claimed'
          AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at, id
        LIMIT $2::integer FOR UPDATE SKIP LOCKED`,
      tid, safeLimit,
    );
    let reset = 0;
    let held = 0;
    for (const message of expired) {
      const attempts = await tx.$queryRawUnsafe(
        `SELECT attempt_id::text
           FROM hl7_outbound_transport_attempts
          WHERE tenant_id = $1::uuid AND message_id = $2::integer
            AND claim_token = $3::uuid`,
        tid, message.id, message.claim_token,
      );
      if (attempts.length === 0) {
        await tx.$executeRawUnsafe(
          `UPDATE hl7_outbound_messages
              SET status = 'queued', claim_token = NULL, claimed_at = NULL,
                  lease_expires_at = NULL,
                  last_error = 'claim_expired_before_transport_attempt'
            WHERE tenant_id = $1::uuid AND id = $2::integer
              AND status = 'claimed' AND claim_token = $3::uuid`,
          tid, message.id, message.claim_token,
        );
        reset += 1;
        continue;
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO hl7_outbound_transport_results
           (tenant_id, attempt_id, message_id, subscription_id, outcome,
            error_code, evidence)
         VALUES ($1::uuid, $2::uuid, $3::integer, $4::integer,
                 'lease_expiry_unknown', 'worker_lease_expired_after_attempt_started',
                 jsonb_build_object('claim_generation', $5::integer))
         ON CONFLICT (tenant_id, attempt_id) DO NOTHING`,
        tid, attempts[0].attempt_id, message.id, message.subscription_id,
        message.claim_generation,
      );
      await ensureCursorTx(tx, tid, message.subscription_id);
      await tx.$executeRawUnsafe(
        `UPDATE hl7_outbound_delivery_cursors
            SET state = 'paused_uncertain', blocked_message_id = $3::integer,
                inflight_message_id = NULL, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND subscription_id = $2::integer`,
        tid, message.subscription_id, message.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE hl7_outbound_messages
            SET status = 'reconciliation_required',
                transport_state = 'lease_expiry_unknown',
                acknowledgement_state = 'missing',
                send_authority = 'held_owner_reconciliation',
                attempts = attempts + 1,
                last_error = 'transport_outcome_unknown_after_lease_expiry',
                claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL
          WHERE tenant_id = $1::uuid AND id = $2::integer
            AND status = 'claimed' AND claim_token = $3::uuid`,
        tid, message.id, message.claim_token,
      );
      held += 1;
    }
    return Object.freeze({ expired: expired.length, reset, held });
  }, { isolationLevel: 'Serializable' });
}

export async function recordOwnerAcknowledgementTx(tx, {
  tenantId,
  messageId,
  rawAcknowledgement,
  recoveryInboxId,
  actorUid,
  ownerReason,
  evidence = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const mid = requirePositiveInteger(messageId, 'message_id');
  const inboxId = requireUuid(recoveryInboxId, 'recovery_inbox_id');
  const actor = requireUuid(actorUid, 'actor_uid');
  const reason = requireOwnerReason(ownerReason);
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, subscription_id, message_control_id, status,
            acknowledgement_state, send_authority
       FROM hl7_outbound_messages
      WHERE tenant_id = $1::uuid AND id = $2::integer
      FOR UPDATE`,
    tid, mid,
  );
  if (rows.length !== 1) throw AppError.notFound('HL7 outbound message not found');
  const message = rows[0];
  const parsed = parseHl7MsaAcknowledgement(rawAcknowledgement, message.message_control_id);
  if (!parsed.msaCode || !parsed.acknowledgedControlId) {
    throw AppError.conflict(
      'Owner reconciliation requires a parsed MSA acknowledgement',
      'HL7_OUTBOUND_PARSED_ACK_REQUIRED',
    );
  }
  const acknowledgement = await insertAcknowledgementTx(tx, {
    tenantId: tid,
    message,
    parsed,
    receiptSource: 'owner_reconciliation',
    evidence,
    recoveryInboxId: inboxId,
    ownerActorUid: actor,
    ownerReason: reason,
  });
  const cursor = await applyAcknowledgementToCursorTx(tx, { tenantId: tid, message, parsed });
  const positive = parsed.state === 'aa';
  const updated = await tx.$queryRawUnsafe(
    `UPDATE hl7_outbound_messages
        SET acknowledgement_state = $3::text,
            status = $4::text,
            send_authority = 'held_owner_reconciliation',
            last_error = $5::text,
            sent_at = CASE WHEN $6::boolean THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
            recovery_inbox_id = $7::uuid,
            recovery_interface_family = 'I04'
      WHERE tenant_id = $1::uuid AND id = $2::integer
      RETURNING id, subscription_id, status, transport_state,
                acknowledgement_state, send_authority,
                recovery_inbox_id::text, sent_at`,
    tid, mid, parsed.state,
    positive ? 'sent' : 'reconciliation_required',
    positive ? null : `owner_reconciled_msa_${parsed.state}`,
    positive, inboxId,
  );
  return Object.freeze({
    message: updated[0],
    acknowledgement,
    parsed,
    cursor,
    recoveryCursorAction: positive ? 'advance' : 'pause',
  });
}

export const __testing__ = Object.freeze({
  requirePositiveInteger,
  normalizeEvidence,
});

export default Object.freeze({
  claimPendingFeedMessages,
  beginTransportAttempt,
  recordTransportOutcome,
  reconcileExpiredClaims,
  recordOwnerAcknowledgementTx,
  parseHl7MsaAcknowledgement,
  sha256Bytes,
});
