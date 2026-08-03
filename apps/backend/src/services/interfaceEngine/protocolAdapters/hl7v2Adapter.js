import { createHash } from 'node:crypto';

import { parseHL7 } from '../../hl7/hl7Parser.js';
import { parseHl7MsaAcknowledgement } from '../../hl7/hl7OutboundDeliveryLedgerService.js';
import { AppError } from '../../../utils/AppError.js';

export const HL7V2_ADAPTER_VERSION = 'vhhealth.i05.hl7v2/v1';
export const HL7V2_BACKEND_ADAPTER_KEY = 'backend.interop.preview';
export const HL7V2_EXTERNAL_ADAPTER_KEY = 'external.hl7v2.http';

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function refuse(message, code = 'INTEROP_HL7V2_ADAPTER_REFUSED') {
  throw AppError.conflict(message, code);
}

export function assertHl7v2MessageParity(message, rawPayload) {
  if (message.protocol !== 'hl7v2') refuse('HL7v2 adapter received a different protocol');
  const actualHash = sha256(rawPayload);
  if (actualHash !== message.payload_hash) {
    refuse('HL7v2 payload bytes do not match the durable message hash', 'INTEROP_PAYLOAD_PARITY_FAILED');
  }
  const parsed = parseHL7(String(rawPayload || ''));
  const controlId = String(parsed?.msh?.messageControlId || '');
  if (String(message.external_control_id || '') !== controlId) {
    refuse('HL7v2 MSH-10 does not match the durable message identity', 'INTEROP_HL7V2_CONTROL_ID_MISMATCH');
  }
  return parsed;
}

export async function deliverHl7v2BackendTx({
  tx,
  tenantId,
  message,
  adapterKey,
  rawPayload,
  transformedPayload,
} = {}) {
  if (adapterKey !== HL7V2_BACKEND_ADAPTER_KEY) {
    refuse(`Unregistered HL7v2 backend adapter: ${String(adapterKey || '')}`, 'INTEROP_BACKEND_ADAPTER_UNREGISTERED');
  }
  const parsed = assertHl7v2MessageParity(message, rawPayload);
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'hl7v2',
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
    HL7V2_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload || ''), 'utf8'),
    JSON.stringify(transformedPayload || {}),
    JSON.stringify({
      message_type: parsed?.msh?.messageType || null,
      message_control_id: parsed?.msh?.messageControlId || null,
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
  if (!existing[0]) refuse('HL7v2 backend receipt could not be recorded');
  return existing[0];
}

export function evaluateHl7v2ExternalResponse({ message, rawPayload, responseBody } = {}) {
  assertHl7v2MessageParity(message, rawPayload);
  const parsed = parseHl7MsaAcknowledgement(responseBody, message.external_control_id);
  return Object.freeze({
    accepted: parsed.state === 'aa',
    parsed,
    response_sha256: sha256(responseBody),
  });
}

export async function recordHl7v2ExternalAcceptanceTx({
  tx,
  tenantId,
  message,
  rawPayload,
  responseStatus,
  responseBody,
} = {}) {
  const evaluated = evaluateHl7v2ExternalResponse({ message, rawPayload, responseBody });
  if (!evaluated.accepted) {
    refuse(
      `HL7v2 downstream acknowledgement was ${evaluated.parsed.state}`,
      'INTEROP_HL7V2_ACK_NOT_ACCEPTED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, 'hl7v2',
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
    HL7V2_EXTERNAL_ADAPTER_KEY,
    HL7V2_ADAPTER_VERSION,
    message.payload_hash,
    Buffer.byteLength(String(rawPayload || ''), 'utf8'),
    JSON.stringify({
      http_status: responseStatus,
      msa_code: evaluated.parsed.msaCode,
      acknowledged_control_id: evaluated.parsed.acknowledgedControlId,
      acknowledgement_sha256: evaluated.parsed.payloadSha256,
      correlation_matches: evaluated.parsed.correlationMatches,
      request_byte_parity_verified: true,
    }),
  );
  return Object.freeze({ receipt: rows[0] || null, acknowledgement: evaluated.parsed });
}

export default Object.freeze({
  protocol: 'hl7v2',
  adapterVersion: HL7V2_ADAPTER_VERSION,
  backendAdapterKeys: Object.freeze([HL7V2_BACKEND_ADAPTER_KEY]),
  externalAdapterKey: HL7V2_EXTERNAL_ADAPTER_KEY,
  assertMessageParity: assertHl7v2MessageParity,
  deliverBackendTx: deliverHl7v2BackendTx,
  evaluateExternalResponse: evaluateHl7v2ExternalResponse,
  recordExternalAcceptanceTx: recordHl7v2ExternalAcceptanceTx,
});
