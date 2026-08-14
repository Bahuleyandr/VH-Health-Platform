import { createHash } from 'node:crypto';

import { AppError } from '../../../utils/AppError.js';

export const CSV_ADAPTER_VERSION = 'vhhealth.i05.csv/v1';
export const CSV_BACKEND_ADAPTER_KEY = 'backend.interop.csv';
export const CSV_EXTERNAL_ADAPTER_KEY = 'external.csv.http';

const ACK_KEYS = new Set(['status', 'payload_sha256', 'receipt_id']);

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function refuse(message, code = 'INTEROP_CSV_ADAPTER_REFUSED') {
  throw AppError.conflict(message, code);
}

export function parseCsvPayload(value) {
  const input = String(value ?? '');
  if (!input) refuse('CSV payload is empty', 'INTEROP_CSV_INVALID');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        field += char;
      }
      continue;
    }
    if (quoteClosed && ![',', '\r', '\n'].includes(char)) {
      refuse('CSV has characters after a closing quote', 'INTEROP_CSV_INVALID');
    }
    if (char === '"') {
      if (field) refuse('CSV quote must begin a field', 'INTEROP_CSV_INVALID');
      quoted = true;
      quoteClosed = false;
    } else if (char === ',') {
      row.push(field);
      field = '';
      quoteClosed = false;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      quoteClosed = false;
    } else {
      field += char;
    }
  }
  if (quoted) refuse('CSV contains an unterminated quoted field', 'INTEROP_CSV_INVALID');
  if (field || row.length || !rows.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0].map((name, index) => (index === 0 ? name.replace(/^\uFEFF/, '') : name).trim());
  if (!header.length || header.some(name => !name)) {
    refuse('CSV header contains an empty column', 'INTEROP_CSV_INVALID');
  }
  if (new Set(header).size !== header.length) {
    refuse('CSV header columns must be unique', 'INTEROP_CSV_INVALID');
  }
  const records = rows.slice(1);
  if (records.some(record => record.length !== header.length)) {
    refuse('CSV rows do not match the header width', 'INTEROP_CSV_INVALID');
  }
  return Object.freeze({ header: Object.freeze(header), records: Object.freeze(records), rowCount: records.length });
}

export function assertCsvMessageParity(message, rawPayload) {
  if (message.protocol !== 'csv') refuse('CSV adapter received a different protocol');
  if (sha256(rawPayload) !== message.payload_hash) {
    refuse('CSV payload bytes do not match the durable message hash', 'INTEROP_PAYLOAD_PARITY_FAILED');
  }
  return parseCsvPayload(rawPayload);
}

export async function deliverCsvBackendTx({
  tx,
  tenantId,
  message,
  adapterKey,
  rawPayload,
  transformedPayload,
} = {}) {
  if (adapterKey !== CSV_BACKEND_ADAPTER_KEY) {
    refuse(`Unregistered CSV backend adapter: ${String(adapterKey || '')}`, 'INTEROP_BACKEND_ADAPTER_UNREGISTERED');
  }
  const parsed = assertCsvMessageParity(message, rawPayload);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'csv',
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
    CSV_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify(transformedPayload || {}),
    JSON.stringify({
      header: parsed.header,
      row_count: parsed.rowCount,
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
  if (!existing[0]) refuse('CSV backend receipt could not be recorded');
  return existing[0];
}

export function evaluateCsvExternalResponse({ message, rawPayload, responseStatus, responseBody } = {}) {
  const parsed = assertCsvMessageParity(message, rawPayload);
  if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus > 299) {
    refuse('CSV downstream transport was not successful', 'INTEROP_CSV_ACK_NOT_ACCEPTED');
  }
  let acknowledgement;
  try {
    acknowledgement = JSON.parse(String(responseBody ?? ''));
  } catch {
    refuse('CSV downstream acknowledgement is not valid JSON', 'INTEROP_CSV_ACK_NOT_ACCEPTED');
  }
  if (!acknowledgement || typeof acknowledgement !== 'object' || Array.isArray(acknowledgement)) {
    refuse('CSV downstream acknowledgement is not an object', 'INTEROP_CSV_ACK_NOT_ACCEPTED');
  }
  if (Object.keys(acknowledgement).some(key => !ACK_KEYS.has(key))) {
    refuse('CSV downstream acknowledgement contains unknown fields', 'INTEROP_CSV_ACK_NOT_ACCEPTED');
  }
  if (acknowledgement.status !== 'accepted' || acknowledgement.payload_sha256 !== message.payload_hash) {
    refuse('CSV downstream acknowledgement did not accept the exact payload', 'INTEROP_CSV_ACK_NOT_ACCEPTED');
  }
  return Object.freeze({
    accepted: true,
    acknowledgement: Object.freeze({
      status: acknowledgement.status,
      payloadSha256: acknowledgement.payload_sha256,
      receiptId: String(acknowledgement.receipt_id || '') || null,
    }),
    parsed,
    responseSha256: sha256(responseBody),
  });
}

export async function recordCsvExternalAcceptanceTx({
  tx,
  tenantId,
  message,
  rawPayload,
  responseStatus,
  responseBody,
} = {}) {
  const evaluated = evaluateCsvExternalResponse({ message, rawPayload, responseStatus, responseBody });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'csv',
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
    CSV_EXTERNAL_ADAPTER_KEY,
    CSV_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify({
      http_status: responseStatus,
      acknowledgement_status: evaluated.acknowledgement.status,
      acknowledgement_payload_sha256: evaluated.acknowledgement.payloadSha256,
      downstream_receipt_id: evaluated.acknowledgement.receiptId,
      acknowledgement_sha256: evaluated.responseSha256,
      request_byte_parity_verified: true,
      row_count: evaluated.parsed.rowCount,
    }),
  );
  return Object.freeze({ receipt: rows[0] || null, acknowledgement: evaluated.acknowledgement });
}

export default Object.freeze({
  protocol: 'csv',
  adapterVersion: CSV_ADAPTER_VERSION,
  backendAdapterKeys: Object.freeze([CSV_BACKEND_ADAPTER_KEY]),
  // This backend adapter records `receipt_status = 'accepted'` — a real
  // canonical delivery — so it may back an active inbound version. Keep in
  // sync with interop_canonical_backend_adapters() in migration 670.
  canonicalBackendAdapterKeys: Object.freeze([CSV_BACKEND_ADAPTER_KEY]),
  externalAdapterKey: CSV_EXTERNAL_ADAPTER_KEY,
  assertMessageParity: assertCsvMessageParity,
  deliverBackendTx: deliverCsvBackendTx,
  evaluateExternalResponse: evaluateCsvExternalResponse,
  recordExternalAcceptanceTx: recordCsvExternalAcceptanceTx,
});
