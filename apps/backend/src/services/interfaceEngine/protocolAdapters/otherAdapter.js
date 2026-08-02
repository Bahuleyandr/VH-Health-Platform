import { createHash } from 'node:crypto';

import { AppError } from '../../../utils/AppError.js';

export const OTHER_ADAPTER_VERSION = 'vhhealth.i05.other-envelope/v1';
export const OTHER_BACKEND_ADAPTER_KEY = 'backend.interop.other-envelope';
export const OTHER_EXTERNAL_ADAPTER_KEY = 'external.other-envelope.http';

const ENVELOPE_SCHEMA = 'vhhealth.i05.other/v1';
const ACK_SCHEMA = 'vhhealth.i05.other-ack/v1';
const ENVELOPE_KEYS = new Set([
  'schema', 'message_id', 'media_type', 'content_encoding', 'payload', 'payload_sha256',
]);
const ACK_KEYS = new Set([
  'schema', 'status', 'message_id', 'envelope_sha256', 'payload_sha256', 'receipt_id',
]);

function sha256(value) {
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function refuse(message, code = 'INTEROP_OTHER_ADAPTER_REFUSED') {
  throw AppError.conflict(message, code);
}

function parseObject(value, label, code) {
  let parsed;
  try {
    parsed = JSON.parse(String(value ?? ''));
  } catch {
    refuse(`${label} is invalid JSON`, code);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    refuse(`${label} must be a JSON object`, code);
  }
  return parsed;
}

function decodeCanonicalBase64(value) {
  const encoded = String(value || '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    refuse('OTHER envelope payload is not canonical base64', 'INTEROP_OTHER_INVALID');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    refuse('OTHER envelope payload is not canonical base64', 'INTEROP_OTHER_INVALID');
  }
  return decoded;
}

export function parseOtherEnvelope(value) {
  const envelope = parseObject(value, 'OTHER envelope', 'INTEROP_OTHER_INVALID');
  if (Object.keys(envelope).some(key => !ENVELOPE_KEYS.has(key)) || Object.keys(envelope).length !== ENVELOPE_KEYS.size) {
    refuse('OTHER envelope fields do not match the registered schema', 'INTEROP_OTHER_INVALID');
  }
  if (envelope.schema !== ENVELOPE_SCHEMA) {
    refuse('OTHER envelope schema is not registered', 'INTEROP_OTHER_INVALID');
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(envelope.message_id || ''))) {
    refuse('OTHER envelope message_id is invalid', 'INTEROP_OTHER_INVALID');
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(String(envelope.media_type || ''))) {
    refuse('OTHER envelope media_type is invalid', 'INTEROP_OTHER_INVALID');
  }
  if (envelope.content_encoding !== 'base64') {
    refuse('OTHER envelope content_encoding must be base64', 'INTEROP_OTHER_INVALID');
  }
  const decodedPayload = decodeCanonicalBase64(envelope.payload);
  if (!/^[0-9a-f]{64}$/.test(String(envelope.payload_sha256 || ''))
      || sha256(decodedPayload) !== envelope.payload_sha256) {
    refuse('OTHER envelope payload hash does not match decoded bytes', 'INTEROP_OTHER_INVALID');
  }
  return Object.freeze({ envelope: Object.freeze(envelope), decodedPayload });
}

export function assertOtherMessageParity(message, rawPayload) {
  if (message.protocol !== 'other') refuse('OTHER adapter received a different protocol');
  if (sha256(rawPayload) !== message.payload_hash) {
    refuse('OTHER envelope bytes do not match the durable message hash', 'INTEROP_PAYLOAD_PARITY_FAILED');
  }
  return parseOtherEnvelope(rawPayload);
}

function envelopeEvidence(parsed) {
  return {
    envelope_schema: parsed.envelope.schema,
    envelope_message_id: parsed.envelope.message_id,
    media_type: parsed.envelope.media_type,
    content_encoding: parsed.envelope.content_encoding,
    inner_payload_sha256: parsed.envelope.payload_sha256,
    inner_payload_bytes: parsed.decodedPayload.length,
  };
}

function parseOtherAcknowledgement(responseBody, message, parsedEnvelope) {
  const acknowledgement = parseObject(responseBody, 'OTHER acknowledgement', 'INTEROP_OTHER_ACK_NOT_ACCEPTED');
  if (Object.keys(acknowledgement).some(key => !ACK_KEYS.has(key))) {
    refuse('OTHER acknowledgement contains unknown fields', 'INTEROP_OTHER_ACK_NOT_ACCEPTED');
  }
  if (acknowledgement.schema !== ACK_SCHEMA
      || acknowledgement.status !== 'accepted'
      || acknowledgement.message_id !== parsedEnvelope.envelope.message_id
      || acknowledgement.envelope_sha256 !== message.payload_hash
      || acknowledgement.payload_sha256 !== parsedEnvelope.envelope.payload_sha256) {
    refuse('OTHER acknowledgement did not accept the exact envelope and payload', 'INTEROP_OTHER_ACK_NOT_ACCEPTED');
  }
  return Object.freeze({
    status: acknowledgement.status,
    messageId: acknowledgement.message_id,
    envelopeSha256: acknowledgement.envelope_sha256,
    payloadSha256: acknowledgement.payload_sha256,
    receiptId: String(acknowledgement.receipt_id || '') || null,
  });
}

export async function deliverOtherBackendTx({
  tx,
  tenantId,
  message,
  adapterKey,
  rawPayload,
  transformedPayload,
} = {}) {
  if (adapterKey !== OTHER_BACKEND_ADAPTER_KEY) {
    refuse(`Unregistered OTHER backend adapter: ${String(adapterKey || '')}`, 'INTEROP_BACKEND_ADAPTER_UNREGISTERED');
  }
  const parsed = assertOtherMessageParity(message, rawPayload);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'other',
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
    OTHER_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify(transformedPayload || {}),
    JSON.stringify({
      ...envelopeEvidence(parsed),
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
  if (!existing[0]) refuse('OTHER backend receipt could not be recorded');
  return existing[0];
}

export function evaluateOtherExternalResponse({ message, rawPayload, responseStatus, responseBody } = {}) {
  const parsed = assertOtherMessageParity(message, rawPayload);
  if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus > 299) {
    refuse('OTHER downstream transport was not successful', 'INTEROP_OTHER_ACK_NOT_ACCEPTED');
  }
  return Object.freeze({
    accepted: true,
    acknowledgement: parseOtherAcknowledgement(responseBody, message, parsed),
    envelope: Object.freeze(envelopeEvidence(parsed)),
    responseSha256: sha256(responseBody),
  });
}

export async function recordOtherExternalAcceptanceTx({
  tx,
  tenantId,
  message,
  rawPayload,
  responseStatus,
  responseBody,
} = {}) {
  const evaluated = evaluateOtherExternalResponse({ message, rawPayload, responseStatus, responseBody });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'other',
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
    OTHER_EXTERNAL_ADAPTER_KEY,
    OTHER_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify({
      http_status: responseStatus,
      acknowledgement_status: evaluated.acknowledgement.status,
      acknowledgement_message_id: evaluated.acknowledgement.messageId,
      acknowledgement_envelope_sha256: evaluated.acknowledgement.envelopeSha256,
      acknowledgement_payload_sha256: evaluated.acknowledgement.payloadSha256,
      downstream_receipt_id: evaluated.acknowledgement.receiptId,
      acknowledgement_sha256: evaluated.responseSha256,
      request_byte_parity_verified: true,
      ...evaluated.envelope,
    }),
  );
  return Object.freeze({ receipt: rows[0] || null, acknowledgement: evaluated.acknowledgement });
}

export default Object.freeze({
  protocol: 'other',
  adapterVersion: OTHER_ADAPTER_VERSION,
  backendAdapterKeys: Object.freeze([OTHER_BACKEND_ADAPTER_KEY]),
  externalAdapterKey: OTHER_EXTERNAL_ADAPTER_KEY,
  assertMessageParity: assertOtherMessageParity,
  deliverBackendTx: deliverOtherBackendTx,
  evaluateExternalResponse: evaluateOtherExternalResponse,
  recordExternalAcceptanceTx: recordOtherExternalAcceptanceTx,
});
