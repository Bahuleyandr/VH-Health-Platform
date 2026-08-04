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

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { decryptField, encryptField, isEncrypted } from '../../utils/fieldEncryption.js';
import { assertSafeFeedUrl, safeFetch } from '../../utils/ssrfGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { admissionToADT, dischargeToADT, resultToORU } from './hl7Transformer.js';
import {
  beginTransportAttempt,
  claimPendingFeedMessages,
  reconcileExpiredClaims,
  recordTransportOutcome,
  sha256Bytes,
} from './hl7OutboundDeliveryLedgerService.js';

export const MAX_DELIVERY_ATTEMPTS = 7;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ACK_BODY_BYTES = 64 * 1024;
const SUPPORTED_TYPES = ['ADT^A01', 'ADT^A03', 'ORM^O01', 'ORU^R01'];

function encryptOptionalSecret(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return isEncrypted(text) ? text : encryptField(text);
}

function decryptOptionalSecret(value) {
  return value ? decryptField(value) : null;
}

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
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, tx => tx.$queryRawUnsafe(
    `SELECT id, name, endpoint_url, message_types, is_active, last_delivery_at, created_at
       FROM hl7_feed_subscriptions
      WHERE tenant_id = $1::uuid
      ORDER BY id`,
    tid,
  ));
}

export async function createSubscription({
  name, endpointUrl, authHeader = null, messageTypes = ['ADT^A01', 'ADT^A03', 'ORU^R01'],
} = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
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
  const rows = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `INSERT INTO hl7_feed_subscriptions (tenant_id, name, endpoint_url, auth_header, message_types, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::text[], $6::uuid)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
       endpoint_url = EXCLUDED.endpoint_url,
       auth_header = EXCLUDED.auth_header,
       message_types = EXCLUDED.message_types,
       is_active = true,
       updated_at = NOW()
     RETURNING id, tenant_id, name, endpoint_url, message_types, is_active, created_at`,
    tenantId, cleanedName, cleanedUrl, encryptOptionalSecret(authHeader), types, context.actorUid || null,
  ));
  return rows[0];
}

export async function deactivateSubscription(id, { tenantId = null } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await setTenantTx(tid, tx => tx.$queryRawUnsafe(
    `UPDATE hl7_feed_subscriptions SET is_active = false, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2::uuid
      RETURNING id, name, is_active`,
    id, tid,
  ));
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
  const tid = requireTenantId(tenantId);
  const payload = String(hl7Payload);
  const controlId = extractControlId(payload);
  if (!controlId) throw AppError.badRequest('MSH-10 message control ID is required', 'HL7_FEED_CONTROL_ID_REQUIRED');
  const sourceEventKey = sourceTable && sourceId !== null && sourceId !== undefined
    ? `${String(sourceTable).trim()}:${String(sourceId).trim()}`
    : `message-control:${controlId}`;
  const payloadSha256 = sha256Bytes(payload);
  return setTenantTx(tid, async (tx) => {
    const subscriptions = await tx.$queryRawUnsafe(
      `SELECT id
         FROM hl7_feed_subscriptions
        WHERE tenant_id = $1::uuid AND is_active
          AND $2::text = ANY(message_types)
        ORDER BY id`,
      tid, messageType,
    );
    let created = 0;
    for (const subscription of subscriptions) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO hl7_outbound_messages
           (tenant_id, subscription_id, message_type, message_control_id,
            hl7_payload, source_table, source_id, patient_uid,
            source_event_key, payload_sha256, ledger_version,
            status, transport_state, acknowledgement_state, send_authority)
         VALUES ($1::uuid, $2::integer, $3::text, $4::text, $5::text,
                 $6::text, $7::text, $8::uuid, $9::text, $10::char(64),
                 1, 'queued', 'not_attempted', 'pending', 'authorized')
         ON CONFLICT (tenant_id, subscription_id, source_event_key, message_type)
         DO NOTHING
         RETURNING id`,
        tid, subscription.id, messageType, controlId, payload,
        sourceTable, sourceId, patientUid, sourceEventKey, payloadSha256,
      );
      if (rows.length === 1) {
        created += 1;
        continue;
      }
      const existing = await tx.$queryRawUnsafe(
        `SELECT payload_sha256, message_control_id
           FROM hl7_outbound_messages
          WHERE tenant_id = $1::uuid AND subscription_id = $2::integer
            AND source_event_key = $3::text AND message_type = $4::text`,
        tid, subscription.id, sourceEventKey, messageType,
      );
      if (existing.length !== 1
        || existing[0].payload_sha256 !== payloadSha256
        || existing[0].message_control_id !== controlId) {
        throw AppError.conflict(
          'Outbound HL7 source identity was reused with different bytes or MSH-10',
          'HL7_OUTBOUND_SOURCE_IDENTITY_CONFLICT',
        );
      }
    }
    return created;
  }, { isolationLevel: 'Serializable' });
}

// ── Emission hooks (Phase 1.5 — never throw into the clinical write) ──────

async function loadPatient(patientUid, tenantId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id, name, phone, gender, birthday, address
       FROM users
      WHERE uid = $1::uuid
        AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
      LIMIT 1`,
    patientUid, tenantId,
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
export async function emitSignedResultsOru({ resultIds = [], patientUid = null, tenantId = null } = {}) {
  try {
    if (!Array.isArray(resultIds) || resultIds.length === 0) return 0;
    const ids = [...new Set(
      resultIds.map((id) => Number.parseInt(id, 10)).filter(Number.isInteger),
    )];
    if (ids.length === 0) return 0;
    const results = await prisma.$queryRawUnsafe(
      `SELECT result.id, result.tenant_id, result.patient_uid, result.investigation_id,
              result.test_code, result.test_name, result.value_text, result.value_numeric,
              result.unit, result.reference_range, result.abnormal_flag,
              investigation.test_code AS ordered_test_code,
              investigation.test_name AS ordered_test_name
         FROM lab_results AS result
         LEFT JOIN investigations AS investigation
           ON investigation.tenant_id = result.tenant_id
          AND investigation.id = result.investigation_id
        WHERE result.id = ANY($1::int[])
          AND ($2::uuid IS NULL OR result.tenant_id = $2::uuid)`,
      ids, tenantId,
    );
    if (results.length !== ids.length) return 0;

    const resultTenantIds = new Set(results.map((row) => String(row.tenant_id).toLowerCase()));
    const resultPatientUids = new Set(results.map((row) => String(row.patient_uid).toLowerCase()));
    if (resultTenantIds.size !== 1 || resultPatientUids.size !== 1) return 0;

    const resultTenantId = String(results[0].tenant_id);
    const resultPatientUid = String(results[0].patient_uid);
    if (tenantId && String(tenantId).toLowerCase() !== resultTenantId.toLowerCase()) return 0;
    if (patientUid && String(patientUid).toLowerCase() !== resultPatientUid.toLowerCase()) return 0;

    const resultInvestigationIds = new Set(
      results.map(row => (row.investigation_id == null ? null : Number(row.investigation_id))),
    );
    const orderedTestCodes = new Set(results.map(row => String(row.ordered_test_code || '').trim()));
    const localInvestigationId = resultInvestigationIds.size === 1
      && !resultInvestigationIds.has(null)
      && orderedTestCodes.size === 1
      && !orderedTestCodes.has('')
      && results.every(row => String(row.test_code || '').trim() === [...orderedTestCodes][0])
      ? [...resultInvestigationIds][0]
      : null;

    const patient = await loadPatient(resultPatientUid, resultTenantId);
    if (!patient) return 0;
    const investigation = {
      id: localInvestigationId,
      test_code: localInvestigationId == null ? null : [...orderedTestCodes][0],
      test_name: localInvestigationId == null
        ? results[0].test_name
        : (results[0].ordered_test_name || results[0].test_name),
      results: results.map((r) => ({
        test_code: r.test_code,
        name: r.test_name,
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
      patientUid: resultPatientUid,
      tenantId: resultTenantId,
    });
    if (queued > 0) logger.info('ORU^R01 queued for outbound feeds', { result_count: results.length, queued });
    return queued;
  } catch (err) {
    logger.warn('ORU^R01 feed emission failed (signoff unaffected)', { error: err?.message });
    return 0;
  }
}

// ── Delivery worker ────────────────────────────────────────────────────────

async function readBoundedResponseBody(response) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_ACK_BODY_BYTES) {
    try { await response.body?.cancel?.(); } catch { /* best effort */ }
    return Object.freeze({ body: '', tooLarge: true, bytes: contentLength });
  }
  if (!response.body?.getReader) {
    const body = await response.text();
    const bytes = Buffer.byteLength(body, 'utf8');
    return Object.freeze({
      body: bytes <= MAX_ACK_BODY_BYTES ? body : '',
      tooLarge: bytes > MAX_ACK_BODY_BYTES,
      bytes,
    });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ACK_BODY_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      return Object.freeze({ body: '', tooLarge: true, bytes: total });
    }
    chunks.push(Buffer.from(value));
  }
  return Object.freeze({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false, bytes: total });
}

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
    return Object.freeze({
      outcome: 'transport_failure',
      errorCode: `SSRF_BLOCKED: ${guardErr?.message || 'unsafe endpoint_url'}`,
      evidence: { ssrf_blocked: true },
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'x-application/hl7-v2+er7' };
    const authHeader = decryptOptionalSecret(subscription.auth_header);
    if (authHeader) headers.Authorization = authHeader;
    // safeFetch (M17): re-validates AND pins the socket to the validated IPs so
    // a DNS-rebind host cannot pass assertSafeFeedUrl above on a public IP then
    // re-resolve to an internal one at connect time.
    const response = await safeFetch(subscription.endpoint_url, {
      method: 'POST',
      headers,
      body: message.hl7_payload,
      signal: controller.signal,
    });
    const responseBody = await readBoundedResponseBody(response);
    return Object.freeze({
      outcome: 'http_response',
      httpStatus: response.status,
      responseBody: responseBody.body,
      evidence: {
        http_ok: response.ok,
        response_body_bytes: responseBody.bytes,
        response_body_too_large: responseBody.tooLarge,
      },
    });
  } catch (err) {
    return Object.freeze({
      outcome: 'transport_failure',
      errorCode: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network error'),
      evidence: { aborted: err?.name === 'AbortError' },
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverPendingFeedMessages({ limit = 25, tenantId = null } = {}) {
  const tid = requireTenantId(tenantId);
  const expired = await reconcileExpiredClaims({ tenantId: tid, limit });
  const due = await claimPendingFeedMessages({ tenantId: tid, limit });
  const stats = {
    picked: due.length,
    acknowledged: 0,
    rejected: 0,
    uncertain: 0,
    deferred: 0,
    expired,
  };
  for (const message of due) {
    const attempt = await beginTransportAttempt({
      tenantId: tid,
      messageId: message.id,
      subscriptionId: message.subscription_id,
      claimToken: message.claim_token,
      claimGeneration: message.claim_generation,
      payloadSha256: message.payload_sha256,
    });
    if (attempt.state !== 'ready') {
      stats.deferred += 1;
      continue;
    }
    const transport = await deliverOne(message, message);
    const recorded = await recordTransportOutcome({
      tenantId: tid,
      messageId: message.id,
      claimToken: message.claim_token,
      claimGeneration: message.claim_generation,
      attemptId: attempt.attempt_id,
      transport,
    });
    if (recorded.message.acknowledgement_state === 'aa') stats.acknowledged += 1;
    else if (['ae', 'ar'].includes(recorded.message.acknowledgement_state)) stats.rejected += 1;
    else stats.uncertain += 1;
  }
  if (stats.picked > 0) logger.info('HL7 outbound delivery pass', stats);
  return stats;
}

export async function listFeedMessages({ status = null, limit = 50, tenantId = null } = {}) {
  const tid = requireTenantId(tenantId);
  const params = [];
  let where = '1=1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  params.push(tid); where += ` AND m.tenant_id = $${params.length}::uuid`;
  params.push(Math.min(Number.parseInt(limit, 10) || 50, 200));
  return setTenantTx(tid, tx => tx.$queryRawUnsafe(
    `SELECT m.id, m.subscription_id, s.name AS subscription_name, m.message_type,
            m.message_control_id, m.status, m.attempts, m.last_error, m.next_attempt_at,
            m.sent_at, m.source_table, m.source_id, m.source_event_key,
            m.payload_sha256, m.transport_state, m.acknowledgement_state,
            m.send_authority, m.recovery_inbox_id::text, m.created_at
       FROM hl7_outbound_messages m
       JOIN hl7_feed_subscriptions s
         ON s.tenant_id = m.tenant_id AND s.id = m.subscription_id
      WHERE ${where}
      ORDER BY m.created_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  ));
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
};

export const __testing__ = Object.freeze({ deliverOne, readBoundedResponseBody });
