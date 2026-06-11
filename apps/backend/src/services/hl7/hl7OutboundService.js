// src/services/hl7/hl7OutboundService.js
//
// Roadmap C2 — live outbound HL7v2 feeds. The transformer generates the
// messages; this service owns subscriptions, the durable per-subscription
// queue, the retry/delivery worker and the emission hooks fired after
// admission / discharge / lab sign-off commit.
//
// Transport is the HTTP bridge (Content-Type x-application/hl7-v2+er7);
// MLLP listeners owner-side terminate into the same bridge — mirroring the
// B3 inbound pattern.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { assertSafeFeedUrl } from '../../utils/ssrfGuard.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { admissionToADT, dischargeToADT, resultToORU } from './hl7Transformer.js';

export const MAX_DELIVERY_ATTEMPTS = 7;
const REQUEST_TIMEOUT_MS = 10000;
const SUPPORTED_TYPES = ['ADT^A01', 'ADT^A03', 'ORM^O01', 'ORU^R01'];

/** Exponential backoff (minutes), capped at 60. Pure — unit-tested. */
export function nextAttemptDelayMinutes(attempts) {
  return Math.min(2 ** Math.max(attempts, 0), 60);
}

function extractControlId(hl7) {
  // MSH|^~\&|app|fac||dest|ts||type|CONTROL_ID|...
  const msh = String(hl7 || '').split(/\r\n|\r|\n/)[0] || '';
  return msh.split('|')[9] || null;
}

// ── Subscriptions ──────────────────────────────────────────────────────────

export async function listSubscriptions({ tenantId = null } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT id, name, endpoint_url, message_types, is_active, last_delivery_at, created_at
       FROM hl7_feed_subscriptions
      WHERE ($1::uuid IS NULL OR tenant_id = $1::uuid)
      ORDER BY id`,
    tenantId,
  );
}

export async function createSubscription({
  name, endpointUrl, authHeader = null, messageTypes = ['ADT^A01', 'ADT^A03', 'ORU^R01'],
} = {}, context = {}) {
  const tenantId = context.tenantId || DEFAULT_TENANT_ID;
  const cleanedName = (name || '').trim();
  const cleanedUrl = (endpointUrl || '').trim();
  if (!cleanedName) throw AppError.badRequest('name is required', 'HL7_FEED_NAME_REQUIRED');
  if (!/^https?:\/\//i.test(cleanedUrl)) {
    throw AppError.badRequest('endpoint_url must be an http(s) URL', 'HL7_FEED_BAD_URL');
  }
  // SSRF guard (audit finding H4): scheme alone is not enough — the stored
  // URL is later fetched server-side with the subscription's auth header.
  // Reject loopback/private/link-local/metadata targets and unresolvable
  // hosts at create time; deliverOne re-checks before every fetch.
  await assertSafeFeedUrl(cleanedUrl);
  const types = (Array.isArray(messageTypes) ? messageTypes : [messageTypes]).map((t) => String(t).trim());
  const unknown = types.filter((t) => !SUPPORTED_TYPES.includes(t));
  if (types.length === 0 || unknown.length > 0) {
    throw AppError.badRequest(
      `message_types must be a non-empty subset of ${SUPPORTED_TYPES.join(', ')}`,
      'HL7_FEED_BAD_TYPES',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hl7_feed_subscriptions (tenant_id, name, endpoint_url, auth_header, message_types, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::uuid)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       endpoint_url = EXCLUDED.endpoint_url,
       auth_header = EXCLUDED.auth_header,
       message_types = EXCLUDED.message_types,
       is_active = true,
       updated_at = NOW()
     RETURNING id, tenant_id, name, endpoint_url, message_types, is_active, created_at`,
    tenantId, cleanedName, cleanedUrl, authHeader, types, context.actorUid || null,
  );
  return rows[0];
}

export async function deactivateSubscription(id, { tenantId = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hl7_feed_subscriptions SET is_active = false, updated_at = NOW()
      WHERE id = $1 AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      RETURNING id, name, is_active`,
    id, tenantId,
  );
  if (!rows.length) throw AppError.notFound('Subscription not found');
  return rows[0];
}

// ── Queueing ───────────────────────────────────────────────────────────────

/**
 * Fan a message out to every active subscription listening for its type.
 * Returns the number of queue rows created.
 */
export async function queueFeedMessage({
  messageType, hl7Payload, sourceTable = null, sourceId = null, patientUid = null, tenantId = null,
} = {}) {
  if (!SUPPORTED_TYPES.includes(messageType)) {
    throw AppError.badRequest(`Unsupported message_type ${messageType}`, 'HL7_FEED_BAD_TYPE');
  }
  if (!hl7Payload || !String(hl7Payload).startsWith('MSH|')) {
    throw AppError.badRequest('hl7_payload must start with an MSH segment', 'HL7_FEED_BAD_PAYLOAD');
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO hl7_outbound_messages
       (tenant_id, subscription_id, message_type, message_control_id, hl7_payload, source_table, source_id, patient_uid)
     SELECT s.tenant_id, s.id, $1::text, $2, $3, $4, $5, $6::uuid
       FROM hl7_feed_subscriptions s
      WHERE s.is_active AND $1::text = ANY(s.message_types)
        AND ($7::uuid IS NULL OR s.tenant_id = $7::uuid)
     RETURNING id`,
    messageType, extractControlId(hl7Payload), String(hl7Payload),
    sourceTable, sourceId, patientUid, tenantId,
  );
  return rows.length;
}

// ── Emission hooks (Phase 1.5 — never throw into the clinical write) ──────

async function loadPatient(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id, name, phone, gender, birthday, address FROM users WHERE uid = $1::uuid LIMIT 1`,
    patientUid,
  );
  return rows[0] || null;
}

export async function emitAdmissionAdt(admission) {
  try {
    if (!admission?.patient_uid) return 0;
    const patient = await loadPatient(admission.patient_uid);
    if (!patient) return 0;
    const queued = await queueFeedMessage({
      messageType: 'ADT^A01',
      hl7Payload: admissionToADT(admission, patient),
      sourceTable: 'admissions',
      sourceId: String(admission.id),
      patientUid: admission.patient_uid,
      tenantId: patient.tenant_id,
    });
    if (queued > 0) logger.info('ADT^A01 queued for outbound feeds', { admission_id: admission.id, queued });
    return queued;
  } catch (err) {
    logger.warn('ADT^A01 feed emission failed (admission unaffected)', { error: err?.message });
    return 0;
  }
}

export async function emitDischargeAdt(admission) {
  try {
    if (!admission?.patient_uid) return 0;
    const patient = await loadPatient(admission.patient_uid);
    if (!patient) return 0;
    const queued = await queueFeedMessage({
      messageType: 'ADT^A03',
      hl7Payload: dischargeToADT(admission, patient),
      sourceTable: 'admissions',
      sourceId: String(admission.id),
      patientUid: admission.patient_uid,
      tenantId: patient.tenant_id,
    });
    if (queued > 0) logger.info('ADT^A03 queued for outbound feeds', { admission_id: admission.id, queued });
    return queued;
  } catch (err) {
    logger.warn('ADT^A03 feed emission failed (discharge unaffected)', { error: err?.message });
    return 0;
  }
}

/** ORU at pathologist sign-off — the clinically-correct release trigger. */
export async function emitSignedResultsOru({ resultIds = [], patientUid = null } = {}) {
  try {
    if (!Array.isArray(resultIds) || resultIds.length === 0) return 0;
    const results = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, test_code, test_name, value_text, value_numeric, unit,
              reference_range, abnormal_flag
         FROM lab_results WHERE id = ANY($1::int[])`,
      resultIds.map((id) => Number.parseInt(id, 10)).filter(Number.isInteger),
    );
    if (!results.length) return 0;
    const uid = patientUid || results[0].patient_uid;
    const patient = await loadPatient(uid);
    if (!patient) return 0;
    const investigation = {
      id: results[0].id,
      test_name: results[0].test_name,
      results: results.map((r) => ({
        name: r.test_code || r.test_name,
        value: r.value_text ?? (r.value_numeric != null ? String(r.value_numeric) : ''),
        unit: r.unit || '',
        reference_range: r.reference_range || '',
        abnormal_flag: r.abnormal_flag || '',
        status: 'F',
      })),
    };
    const queued = await queueFeedMessage({
      messageType: 'ORU^R01',
      hl7Payload: resultToORU(investigation, patient),
      sourceTable: 'lab_results',
      sourceId: String(results[0].id),
      patientUid: uid,
      tenantId: patient.tenant_id,
    });
    if (queued > 0) logger.info('ORU^R01 queued for outbound feeds', { result_count: results.length, queued });
    return queued;
  } catch (err) {
    logger.warn('ORU^R01 feed emission failed (signoff unaffected)', { error: err?.message });
    return 0;
  }
}

// ── Delivery worker ────────────────────────────────────────────────────────

async function deliverOne(message, subscription) {
  // SSRF guard (audit finding H4): re-validate immediately before EVERY
  // delivery — not just at create time — so a stored-but-unsafe URL (legacy
  // row, direct DB edit) or a DNS-rebinding host that now resolves to an
  // internal address is rejected here. Fail closed: a blocked URL is a
  // delivery failure, never a fetch.
  try {
    await assertSafeFeedUrl(subscription.endpoint_url);
  } catch (guardErr) {
    logger.warn('HL7 outbound delivery blocked by SSRF guard', {
      subscription_id: subscription.subscription_id ?? subscription.id,
      error: guardErr?.message,
    });
    return { ok: false, error: `SSRF_BLOCKED: ${guardErr?.message || 'unsafe endpoint_url'}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'x-application/hl7-v2+er7' };
    if (subscription.auth_header) headers.Authorization = subscription.auth_header;
    const response = await fetch(subscription.endpoint_url, {
      method: 'POST',
      headers,
      body: message.hl7_payload,
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network error') };
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverPendingFeedMessages({ limit = 25, tenantId = null } = {}) {
  const due = await prisma.$queryRawUnsafe(
    `SELECT m.id, m.subscription_id, m.hl7_payload, m.attempts, m.message_type,
            s.endpoint_url, s.auth_header
       FROM hl7_outbound_messages m
       JOIN hl7_feed_subscriptions s ON s.id = m.subscription_id AND s.is_active
      WHERE m.status IN ('queued', 'failed') AND m.next_attempt_at <= NOW()
        AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)
      ORDER BY m.id
      LIMIT $1::int`,
    Math.min(Number.parseInt(limit, 10) || 25, 200),
    tenantId,
  );
  const stats = { picked: due.length, sent: 0, failed: 0, dead: 0 };
  for (const message of due) {
    const outcome = await deliverOne(message, message);
    if (outcome.ok) {
      stats.sent += 1;
      await prisma.$executeRawUnsafe(
        `UPDATE hl7_outbound_messages SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = $1`,
        message.id,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE hl7_feed_subscriptions SET last_delivery_at = NOW() WHERE id = $1`,
        message.subscription_id,
      );
    } else {
      const attempts = message.attempts + 1;
      const dead = attempts >= MAX_DELIVERY_ATTEMPTS;
      if (dead) stats.dead += 1; else stats.failed += 1;
      await prisma.$executeRawUnsafe(
        `UPDATE hl7_outbound_messages SET
           status = $2, attempts = $3, last_error = $4,
           next_attempt_at = NOW() + ($5::int * INTERVAL '1 minute')
         WHERE id = $1`,
        message.id, dead ? 'dead' : 'failed', attempts, outcome.error,
        nextAttemptDelayMinutes(attempts),
      );
    }
  }
  if (stats.picked > 0) logger.info('HL7 outbound delivery pass', stats);
  return stats;
}

export async function listFeedMessages({ status = null, limit = 50, tenantId = null } = {}) {
  const params = [];
  let where = '1=1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  if (tenantId) { params.push(tenantId); where += ` AND m.tenant_id = $${params.length}::uuid`; }
  params.push(Math.min(Number.parseInt(limit, 10) || 50, 200));
  return prisma.$queryRawUnsafe(
    `SELECT m.id, m.subscription_id, s.name AS subscription_name, m.message_type,
            m.message_control_id, m.status, m.attempts, m.last_error, m.next_attempt_at,
            m.sent_at, m.source_table, m.source_id, m.created_at
       FROM hl7_outbound_messages m
       JOIN hl7_feed_subscriptions s ON s.id = m.subscription_id
      WHERE ${where}
      ORDER BY m.created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function replayFeedMessage(id, { tenantId = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE hl7_outbound_messages SET
       status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = NOW()
     WHERE id = $1 AND status IN ('failed', 'dead', 'sent')
       AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
     RETURNING id, status`,
    id, tenantId,
  );
  if (!rows.length) throw AppError.notFound('Message not found or not replayable');
  return rows[0];
}

export default {
  MAX_DELIVERY_ATTEMPTS,
  nextAttemptDelayMinutes,
  listSubscriptions,
  createSubscription,
  deactivateSubscription,
  queueFeedMessage,
  emitAdmissionAdt,
  emitDischargeAdt,
  emitSignedResultsOru,
  deliverPendingFeedMessages,
  listFeedMessages,
  replayFeedMessage,
};
