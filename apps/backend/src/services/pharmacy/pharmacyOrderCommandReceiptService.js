import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function pharmacyCommandRequestSha256(payload) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(payload ?? {}))).digest('hex');
}

export async function loadPharmacyOrderCommandReceiptTx(tx, {
  tenantId,
  orderId,
  action,
  commandKeySha256,
  requestSha256,
}) {
  const tid = requireTenantId(tenantId);
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))::text AS lock_acquired`,
    `pharmacy-order-command:${tid}:${orderId}:${action}:${commandKeySha256}`,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT request_sha256, response_payload, response_message
       FROM pharmacy_order_command_receipts
      WHERE tenant_id=$1::uuid AND pharmacy_order_id=$2::int
        AND action=$3 AND command_key_sha256=$4
      LIMIT 1
      FOR UPDATE`,
    tid,
    Number(orderId),
    action,
    commandKeySha256,
  );
  if (!rows.length) return null;
  if (rows[0].request_sha256 !== requestSha256) {
    throw AppError.conflict(
      'Idempotency key was already used for a different pharmacy order command',
      'PHARMACY_ORDER_COMMAND_IDEMPOTENCY_CONFLICT',
    );
  }
  return {
    payload: rows[0].response_payload,
    message: rows[0].response_message || null,
  };
}

export async function storePharmacyOrderCommandReceiptTx(tx, {
  tenantId,
  orderId,
  action,
  commandKeySha256,
  requestSha256,
  payload,
  message = null,
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO pharmacy_order_command_receipts
      (tenant_id, pharmacy_order_id, action, command_key_sha256,
       request_sha256, response_payload, response_message)
     VALUES ($1::uuid, $2::int, $3, $4, $5, $6::jsonb, $7)`,
    requireTenantId(tenantId),
    Number(orderId),
    action,
    commandKeySha256,
    requestSha256,
    JSON.stringify(payload),
    message,
  );
}
