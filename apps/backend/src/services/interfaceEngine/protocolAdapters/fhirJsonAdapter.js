import { createHash } from 'node:crypto';

import { AppError } from '../../../utils/AppError.js';

export const FHIR_JSON_ADAPTER_VERSION = 'vhhealth.i05.fhir-json/v1';
export const FHIR_JSON_BACKEND_ADAPTER_KEY = 'backend.interop.fhir-json';
export const FHIR_JSON_EXTERNAL_ADAPTER_KEY = 'external.fhir-json.http';

const ACK_PARAMETER_NAMES = new Set(['status', 'payload-sha256', 'receipt-id']);

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function refuse(message, code = 'INTEROP_FHIR_JSON_ADAPTER_REFUSED') {
  throw AppError.conflict(message, code);
}

function assertResourceShape(resource, label = 'FHIR resource') {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    refuse(`${label} must be a JSON object`, 'INTEROP_FHIR_JSON_INVALID');
  }
  if (!/^[A-Z][A-Za-z0-9]{0,63}$/.test(String(resource.resourceType || ''))) {
    refuse(`${label} has an invalid resourceType`, 'INTEROP_FHIR_JSON_INVALID');
  }
  if (resource.id !== undefined && !/^[A-Za-z0-9\-.]{1,64}$/.test(String(resource.id))) {
    refuse(`${label} has an invalid id`, 'INTEROP_FHIR_JSON_INVALID');
  }
}

export function parseFhirJsonPayload(value) {
  const input = String(value ?? '');
  if (!input.trim()) refuse('FHIR JSON payload is empty', 'INTEROP_FHIR_JSON_INVALID');
  let resource;
  try {
    resource = JSON.parse(input);
  } catch {
    refuse('FHIR JSON payload is invalid', 'INTEROP_FHIR_JSON_INVALID');
  }
  assertResourceShape(resource);
  if (resource.resourceType === 'Bundle') {
    if (!resource.type || !Array.isArray(resource.entry)) {
      refuse('FHIR Bundle requires type and entry', 'INTEROP_FHIR_JSON_INVALID');
    }
    resource.entry.forEach((entry, index) => assertResourceShape(entry?.resource, `FHIR Bundle entry ${index}`));
  }
  return resource;
}

export function assertFhirJsonMessageParity(message, rawPayload) {
  if (message.protocol !== 'fhir_json') refuse('FHIR JSON adapter received a different protocol');
  if (sha256(rawPayload) !== message.payload_hash) {
    refuse('FHIR JSON payload bytes do not match the durable message hash', 'INTEROP_PAYLOAD_PARITY_FAILED');
  }
  return parseFhirJsonPayload(rawPayload);
}

function resourceEvidence(resource) {
  return {
    resource_type: resource.resourceType,
    resource_id: resource.id || null,
    bundle_type: resource.resourceType === 'Bundle' ? resource.type : null,
    entry_count: resource.resourceType === 'Bundle' ? resource.entry.length : null,
  };
}

function parseParametersAcknowledgement(responseBody, expectedHash) {
  const acknowledgement = parseFhirJsonPayload(responseBody);
  if (acknowledgement.resourceType !== 'Parameters' || !Array.isArray(acknowledgement.parameter)) {
    refuse('FHIR acknowledgement must be a Parameters resource', 'INTEROP_FHIR_ACK_NOT_ACCEPTED');
  }
  const values = new Map();
  for (const parameter of acknowledgement.parameter) {
    const name = String(parameter?.name || '');
    if (!ACK_PARAMETER_NAMES.has(name) || values.has(name)) {
      refuse('FHIR acknowledgement has unknown or duplicate parameters', 'INTEROP_FHIR_ACK_NOT_ACCEPTED');
    }
    if (name === 'status') values.set(name, parameter.valueCode);
    else values.set(name, parameter.valueString);
  }
  if (values.get('status') !== 'accepted' || values.get('payload-sha256') !== expectedHash) {
    refuse('FHIR acknowledgement did not accept the exact payload', 'INTEROP_FHIR_ACK_NOT_ACCEPTED');
  }
  return Object.freeze({
    status: values.get('status'),
    payloadSha256: values.get('payload-sha256'),
    receiptId: String(values.get('receipt-id') || '') || null,
  });
}

export async function deliverFhirJsonBackendTx({
  tx,
  tenantId,
  message,
  adapterKey,
  rawPayload,
  transformedPayload,
} = {}) {
  if (adapterKey !== FHIR_JSON_BACKEND_ADAPTER_KEY) {
    refuse(`Unregistered FHIR JSON backend adapter: ${String(adapterKey || '')}`, 'INTEROP_BACKEND_ADAPTER_UNREGISTERED');
  }
  const resource = assertFhirJsonMessageParity(message, rawPayload);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'fhir_json',
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
    FHIR_JSON_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify(transformedPayload || {}),
    JSON.stringify({
      ...resourceEvidence(resource),
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
  if (!existing[0]) refuse('FHIR JSON backend receipt could not be recorded');
  return existing[0];
}

export function evaluateFhirJsonExternalResponse({ message, rawPayload, responseStatus, responseBody } = {}) {
  const requestResource = assertFhirJsonMessageParity(message, rawPayload);
  if (!Number.isInteger(responseStatus) || responseStatus < 200 || responseStatus > 299) {
    refuse('FHIR downstream transport was not successful', 'INTEROP_FHIR_ACK_NOT_ACCEPTED');
  }
  const acknowledgement = parseParametersAcknowledgement(responseBody, message.payload_hash);
  return Object.freeze({
    accepted: true,
    acknowledgement,
    request: Object.freeze(resourceEvidence(requestResource)),
    responseSha256: sha256(responseBody),
  });
}

export async function recordFhirJsonExternalAcceptanceTx({
  tx,
  tenantId,
  message,
  rawPayload,
  responseStatus,
  responseBody,
} = {}) {
  const evaluated = evaluateFhirJsonExternalResponse({ message, rawPayload, responseStatus, responseBody });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'fhir_json',
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
    FHIR_JSON_EXTERNAL_ADAPTER_KEY,
    FHIR_JSON_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload ?? ''), 'utf8'),
    JSON.stringify({
      http_status: responseStatus,
      acknowledgement_resource_type: 'Parameters',
      acknowledgement_status: evaluated.acknowledgement.status,
      acknowledgement_payload_sha256: evaluated.acknowledgement.payloadSha256,
      downstream_receipt_id: evaluated.acknowledgement.receiptId,
      acknowledgement_sha256: evaluated.responseSha256,
      request_byte_parity_verified: true,
      ...evaluated.request,
    }),
  );
  return Object.freeze({ receipt: rows[0] || null, acknowledgement: evaluated.acknowledgement });
}

export default Object.freeze({
  protocol: 'fhir_json',
  adapterVersion: FHIR_JSON_ADAPTER_VERSION,
  backendAdapterKeys: Object.freeze([FHIR_JSON_BACKEND_ADAPTER_KEY]),
  // This backend adapter records `receipt_status = 'accepted'` — a real
  // canonical delivery — so it may back an active inbound version. Keep in
  // sync with interop_canonical_backend_adapters() in migration 670.
  canonicalBackendAdapterKeys: Object.freeze([FHIR_JSON_BACKEND_ADAPTER_KEY]),
  externalAdapterKey: FHIR_JSON_EXTERNAL_ADAPTER_KEY,
  assertMessageParity: assertFhirJsonMessageParity,
  deliverBackendTx: deliverFhirJsonBackendTx,
  evaluateExternalResponse: evaluateFhirJsonExternalResponse,
  recordExternalAcceptanceTx: recordFhirJsonExternalAcceptanceTx,
});
