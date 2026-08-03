import { createHash } from 'node:crypto';

import { AppError } from '../../../utils/AppError.js';

export const JSON_ADAPTER_VERSION = 'vhhealth.i05.json/v1';
export const JSON_BACKEND_ADAPTER_KEY = 'backend.interop.json';
export const JSON_EXTERNAL_ADAPTER_KEY = 'external.json.http';

const ACK_KEYS = new Set(['status', 'payload_sha256', 'receipt_id']);

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function refuse(message, code = 'INTEROP_JSON_ADAPTER_REFUSED') {
  throw AppError.conflict(message, code);
}

export function parseJsonPayload(value) {
  const input = String(value ?? '');
  if (!input.trim()) refuse('JSON payload is empty', 'INTEROP_JSON_INVALID');
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    refuse('JSON payload is invalid', 'INTEROP_JSON_INVALID');
  }
  if (parsed === null || typeof parsed !== 'object') {
    refuse('JSON payload root must be an object or array', 'INTEROP_JSON_INVALID');
  }
  return parsed;
}

export function assertJsonMessageParity(message, rawPayload) {
  if (message.protocol !== 'json') refuse('JSON adapter received a different protocol');
  if (sha256(rawPayload) !== message.payload_hash) {
    refuse('JSON payload bytes do not match the durable message hash', 'INTEROP_PAYLOAD_PARITY_FAILED');
  }
  return parseJsonPayload(rawPayload);
}

function documentEvidence(parsed) {
  return Array.isArray(parsed)
    ? { root_type: 'array', item_count: parsed.length }
    : { root_type: 'object', key_count: Object.keys(parsed).length };
}

export async function deliverJsonBackendTx({
  tx,
  tenantId,
  message,
  adapterKey,
  rawPayload,
  transformedPayload,
} = {}) {
  if (adapterKey !== JSON_BACKEND_ADAPTER_KEY) {
    refuse(`Unregistered JSON backend adapter: ${String(adapterKey || '')}`, 'INTEROP_BACKEND_ADAPTER_UNREGISTERED');
  }
  const parsed = assertJsonMessageParity(message, rawPayload);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'json',
             'inbound', $5::text, $6::text, $7::char(64), $8::integer,
             $9::jsonb, 'accepted', $10::jsonb)
     ON CONFLICT (tenant_id, message_id, adapter_key, receipt_status)
     DO NOTHING
     RETURNING id::text, receipt_status, adapter_key, adapter_version,
               payload_sha256::text, payload_bytes, created_at`,
    tenantId,
    message.id,
    message.channel_id,
    message.channel_version_id,
    adapterKey,
    JSON_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify(transformedPayload || {}),
    JSON.stringify({
      ...documentEvidence(parsed),
      byte_parity_verified: true,
      network_call_performed: false,
    }),
  );
  if (rows[0]) return rows[0];
  const existing = await tx.$queryRawUnsafe(
    `SELECT id::text, receipt_status, adapter_key, adapter_version,
            payload_sha256::text, payload_bytes, created_at
       FROM interop_backend_delivery_receipts
      WHERE tenant_id = $1::uuid AND message_id = $2::integer
        AND adapter_key = $3::text AND receipt_status = 'accepted'`,
    tenantId,
    message.id,
    adapterKey,
  );
  if (!existing[0]) refuse('JSON backend receipt could not be recorded');
  return existing[0];
}

export function evaluateJsonExternalResponse({ message, rawPayload, responseStatus, responseBody } = {}) {
  const parsed = assertJsonMessageParity(message, rawPayload);
  if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus > 299) {
    refuse('JSON downstream transport was not successful', 'INTEROP_JSON_ACK_NOT_ACCEPTED');
  }
  let acknowledgement;
  try {
    acknowledgement = JSON.parse(String(responseBody ?? ''));
  } catch {
    refuse('JSON downstream acknowledgement is invalid', 'INTEROP_JSON_ACK_NOT_ACCEPTED');
  }
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
    refuse('JSON downstream acknowledgement is not an object', 'INTEROP_JSON_ACK_NOT_ACCEPTED');
  }
  if (Object.keys(acknowledgement).some(key => !ACK_KEYS.has(key))) {
    refuse('JSON downstream acknowledgement contains unknown fields', 'INTEROP_JSON_ACK_NOT_ACCEPTED');
  }
  if (acknowledgement.status !== 'accepted' || acknowledgement.payload_sha256 !== message.payload_hash) {
    refuse('JSON downstream acknowledgement did not accept the exact payload', 'INTEROP_JSON_ACK_NOT_ACCEPTED');
  }
  return Object.freeze({
    accepted: true,
    acknowledgement: Object.freeze({
      status: acknowledgement.status,
      payloadSha256: acknowledgement.payload_sha256,
      receiptId: String(acknowledgement.receipt_id || '') || null,
    }),
    document: Object.freeze(documentEvidence(parsed)),
    responseSha256: sha256(responseBody),
  });
}

export async function recordJsonExternalAcceptanceTx({
  tx,
  tenantId,
  message,
  rawPayload,
  responseStatus,
  responseBody,
} = {}) {
  const evaluated = evaluateJsonExternalResponse({ message, rawPayload, responseStatus, responseBody });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'json',
             'outbound', $5::text, $6::text, $7::char(64), $8::integer,
             '{}'::jsonb, 'accepted', $9::jsonb)
     ON CONFLICT (tenant_id, message_id, adapter_key, receipt_status)
     DO NOTHING
     RETURNING id::text, receipt_status, adapter_key, adapter_version,
               payload_sha256::text, payload_bytes, created_at`,
    tenantId,
    message.id,
    message.channel_id,
    message.channel_version_id,
    JSON_EXTERNAL_ADAPTER_KEY,
    JSON_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify({
      http_status: responseStatus,
      acknowledgement_status: evaluated.acknowledgement.status,
      acknowledgement_payload_sha256: evaluated.acknowledgement.payloadSha256,
      downstream_receipt_id: evaluated.acknowledgement.receiptId,
      acknowledgement_sha256: evaluated.responseSha256,
      request_byte_parity_verified: true,
      ...evaluated.document,
    }),
  );
  return Object.freeze({ receipt: rows[0] || null, acknowledgement: evaluated.acknowledgement });
}

export default Object.freeze({
  protocol: 'json',
  adapterVersion: JSON_ADAPTER_VERSION,
  backendAdapterKeys: Object.freeze([JSON_BACKEND_ADAPTER_KEY]),
  externalAdapterKey: JSON_EXTERNAL_ADAPTER_KEY,
  assertMessageParity: assertJsonMessageParity,
  deliverBackendTx: deliverJsonBackendTx,
  evaluateExternalResponse: evaluateJsonExternalResponse,
  recordExternalAcceptanceTx: recordJsonExternalAcceptanceTx,
});
