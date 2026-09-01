import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const COMMAND_SCOPE_MODES = Object.freeze({
  mar_administer: 'online_no_scan',
  mar_administer_scan: 'online_barcode_scan',
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND_KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

function normalizeFingerprintValue(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeFingerprintValue(value[key])]),
    );
  }
  return value;
}

function normalizeWireValue(value) {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.map(normalizeWireValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, normalizeWireValue(child)]),
    );
  }
  return value;
}

export function fingerprintMarAdministrationRequest(value) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeFingerprintValue(value)))
    .digest('hex');
}

function validateIdentity({
  tenantId,
  medicationAdministrationId,
  actorUid,
  commandScope,
  commandKey,
  requestBodySha256,
  administrationMode,
}) {
  const tid = requireTenantId(tenantId);
  const administrationId = Number(medicationAdministrationId);
  if (
    !Number.isSafeInteger(administrationId)
    || administrationId < 1
    || !UUID_PATTERN.test(String(actorUid || ''))
    || COMMAND_SCOPE_MODES[commandScope] !== administrationMode
  ) {
    throw AppError.badRequest(
      'MAR administration command identity is invalid',
      'MAR_ADMINISTRATION_COMMAND_INVALID',
    );
  }
  if (
    typeof commandKey !== 'string'
    || commandKey.length < 1
    || commandKey.length > 200
    || commandKey !== commandKey.trim()
    || !COMMAND_KEY_PATTERN.test(commandKey)
    || !SHA256_PATTERN.test(String(requestBodySha256 || ''))
  ) {
    throw AppError.badRequest(
      'MAR administration command key or fingerprint is invalid',
      'MAR_ADMINISTRATION_COMMAND_INVALID',
    );
  }
  return { tid, administrationId };
}

function assertReceiptMatches(receipt, identity) {
  if (
    Number(receipt.medication_administration_id) !== identity.administrationId
    || receipt.actor_uid !== identity.actorUid
    || receipt.command_scope !== identity.commandScope
    || receipt.command_key !== identity.commandKey
    || receipt.administration_mode !== identity.administrationMode
    || receipt.request_body_sha256 !== identity.requestBodySha256
  ) {
    throw AppError.unprocessable(
      'Idempotency-Key is already bound to a different MAR administration request',
      'MAR_ADMINISTRATION_COMMAND_MISMATCH',
      {
        medication_administration_id: identity.administrationId,
        command_scope: identity.commandScope,
      },
    );
  }
  if (!receipt.response_data || typeof receipt.response_data !== 'object') {
    throw AppError.conflict(
      'MAR administration command receipt is incomplete',
      'MAR_ADMINISTRATION_COMMAND_RECEIPT_INCOMPLETE',
    );
  }
  return normalizeWireValue(receipt.response_data);
}

function normalizeIdentity(values) {
  const { tid, administrationId } = validateIdentity(values);
  return {
    ...values,
    tenantId: tid,
    administrationId,
    actorUid: String(values.actorUid),
  };
}

export async function findMarAdministrationCommandReplayTx(tx, values) {
  if (!values?.commandKey) return null;
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR administration command replay requires the caller transaction',
      'MAR_ADMINISTRATION_COMMAND_TRANSACTION_REQUIRED',
    );
  }
  const identity = normalizeIdentity(values);
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, medication_administration_id,
            actor_uid::text, command_scope, command_key,
            request_body_sha256::text AS request_body_sha256,
            administration_mode, response_data,
            completed_at
       FROM mar_administration_command_receipts
      WHERE tenant_id = $1::uuid
        AND actor_uid = $2::uuid
        AND command_scope = $3::text
        AND command_key = $4::text
      LIMIT 1`,
    identity.tenantId,
    identity.actorUid,
    identity.commandScope,
    identity.commandKey,
  );
  if (!rows[0]) return null;
  return assertReceiptMatches(rows[0], identity);
}

export async function recordMarAdministrationCommandReceiptTx(tx, values) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR administration command receipt requires the caller transaction',
      'MAR_ADMINISTRATION_COMMAND_TRANSACTION_REQUIRED',
    );
  }
  const identity = normalizeIdentity(values);
  const responseData = normalizeWireValue(values.responseData);
  if (
    !responseData
    || typeof responseData !== 'object'
    || Number(responseData.id) !== identity.administrationId
    || String(responseData.status || '').toLowerCase() !== 'administered'
  ) {
    throw AppError.internal(
      'MAR administration response cannot be committed as a command receipt',
      'MAR_ADMINISTRATION_COMMAND_RESPONSE_INVALID',
    );
  }

  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO mar_administration_command_receipts
       (tenant_id, medication_administration_id, actor_uid, command_scope,
        command_key, request_body_sha256, administration_mode, response_data)
     VALUES ($1::uuid, $2::int, $3::uuid, $4::text, $5::text,
             $6::char(64), $7::text, $8::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id, tenant_id::text, medication_administration_id,
               actor_uid::text, command_scope, command_key,
               request_body_sha256::text AS request_body_sha256,
               administration_mode, response_data,
               completed_at`,
    identity.tenantId,
    identity.administrationId,
    identity.actorUid,
    identity.commandScope,
    identity.commandKey,
    identity.requestBodySha256,
    identity.administrationMode,
    JSON.stringify(responseData),
  );
  if (inserted[0]) return assertReceiptMatches(inserted[0], identity);

  const existing = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text, medication_administration_id,
            actor_uid::text, command_scope, command_key,
            request_body_sha256::text AS request_body_sha256,
            administration_mode, response_data,
            completed_at
       FROM mar_administration_command_receipts
      WHERE tenant_id = $1::uuid
        AND (
          (actor_uid = $2::uuid AND command_scope = $3::text AND command_key = $4::text)
          OR medication_administration_id = $5::int
        )
      ORDER BY CASE
        WHEN actor_uid = $2::uuid AND command_scope = $3::text AND command_key = $4::text
          THEN 0
        ELSE 1
      END
      LIMIT 1`,
    identity.tenantId,
    identity.actorUid,
    identity.commandScope,
    identity.commandKey,
    identity.administrationId,
  );
  if (!existing[0]) {
    throw AppError.conflict(
      'MAR administration command receipt changed concurrently',
      'MAR_ADMINISTRATION_COMMAND_CONCURRENT_CHANGE',
    );
  }
  return assertReceiptMatches(existing[0], identity);
}

export async function finaliseMarHttpIdempotencyTx(tx, {
  claimId,
  tenantId,
  actorUid,
  commandKey,
  requestBodySha256,
  responseData,
  requestId = null,
  message = 'Medication administration recorded',
}) {
  if (!claimId) return null;
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR HTTP idempotency finalization requires the caller transaction',
      'MAR_HTTP_IDEMPOTENCY_TRANSACTION_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  if (
    !UUID_PATTERN.test(String(actorUid || ''))
    || !SHA256_PATTERN.test(String(requestBodySha256 || ''))
    || typeof commandKey !== 'string'
    || !COMMAND_KEY_PATTERN.test(commandKey)
  ) {
    throw AppError.badRequest(
      'MAR HTTP idempotency identity is invalid',
      'MAR_HTTP_IDEMPOTENCY_INVALID',
    );
  }
  const responseBody = {
    success: true,
    message,
    data: normalizeWireValue(responseData),
    ...(requestId ? { requestId } : {}),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 200,
            response_body = $6::jsonb,
            updated_at = NOW()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4::text
        AND request_body_hash = $5::char(64)
        AND status = 'in_flight'
      RETURNING id, status, response_status, response_body`,
    claimId,
    tid,
    String(actorUid),
    commandKey,
    requestBodySha256,
    JSON.stringify(responseBody),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'HTTP idempotency claim changed before MAR administration commit',
      'MAR_HTTP_IDEMPOTENCY_CHANGED',
    );
  }
  return rows[0];
}

export default {
  fingerprintMarAdministrationRequest,
  findMarAdministrationCommandReplayTx,
  recordMarAdministrationCommandReceiptTx,
  finaliseMarHttpIdempotencyTx,
};
