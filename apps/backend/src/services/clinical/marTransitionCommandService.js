import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const COMMAND_SCOPE_ACTIONS = Object.freeze({
  mar_miss: 'missed',
  mar_hold: 'held',
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMAND_KEY_PATTERN = /^[A-Za-z0-9_\-:.]+$/;

function normalizeFingerprintValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
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

export function fingerprintMarTransitionRequest(value) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeFingerprintValue(value)))
    .digest('hex');
}

function normalizeIdentity(values) {
  const tenantId = requireTenantId(values.tenantId);
  const medicationAdministrationId = Number(values.medicationAdministrationId);
  const actorUid = String(values.actorUid || '');
  const expectedAction = COMMAND_SCOPE_ACTIONS[values.commandScope];
  if (
    !Number.isSafeInteger(medicationAdministrationId)
    || medicationAdministrationId < 1
    || !UUID_PATTERN.test(actorUid)
    || !expectedAction
    || expectedAction !== values.transitionAction
  ) {
    throw AppError.badRequest(
      'MAR transition command identity is invalid',
      'MAR_TRANSITION_COMMAND_INVALID',
    );
  }
  if (
    typeof values.commandKey !== 'string'
    || values.commandKey.length < 1
    || values.commandKey.length > 200
    || values.commandKey !== values.commandKey.trim()
    || !COMMAND_KEY_PATTERN.test(values.commandKey)
    || !SHA256_PATTERN.test(String(values.requestBodySha256 || ''))
  ) {
    throw AppError.badRequest(
      'MAR transition command key or fingerprint is invalid',
      'MAR_TRANSITION_COMMAND_INVALID',
    );
  }
  return {
    ...values,
    tenantId,
    medicationAdministrationId,
    actorUid,
  };
}

function assertReceiptMatches(receipt, identity) {
  if (
    Number(receipt.medication_administration_id) !== identity.medicationAdministrationId
    || receipt.actor_uid !== identity.actorUid
    || receipt.command_scope !== identity.commandScope
    || receipt.transition_action !== identity.transitionAction
    || receipt.command_key !== identity.commandKey
    || receipt.request_body_sha256 !== identity.requestBodySha256
  ) {
    throw AppError.unprocessable(
      'Idempotency-Key is already bound to a different MAR transition request',
      'MAR_TRANSITION_COMMAND_MISMATCH',
      {
        medication_administration_id: identity.medicationAdministrationId,
        command_scope: identity.commandScope,
      },
    );
  }
  if (!receipt.response_data || typeof receipt.response_data !== 'object') {
    throw AppError.conflict(
      'MAR transition command receipt is incomplete',
      'MAR_TRANSITION_COMMAND_RECEIPT_INCOMPLETE',
    );
  }
  return normalizeWireValue(receipt.response_data);
}

const RECEIPT_COLUMNS = `id, tenant_id::text, medication_administration_id,
  actor_uid::text, command_scope, transition_action, command_key,
  request_body_sha256::text AS request_body_sha256, response_data, completed_at`;

export async function findMarTransitionCommandReplayTx(tx, values) {
  if (!values?.commandKey) return null;
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR transition command replay requires the caller transaction',
      'MAR_TRANSITION_COMMAND_TRANSACTION_REQUIRED',
    );
  }
  const identity = normalizeIdentity(values);
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${RECEIPT_COLUMNS}
       FROM mar_transition_command_receipts
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
  return rows[0] ? assertReceiptMatches(rows[0], identity) : null;
}

export async function recordMarTransitionCommandReceiptTx(tx, values) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(
      'MAR transition command receipt requires the caller transaction',
      'MAR_TRANSITION_COMMAND_TRANSACTION_REQUIRED',
    );
  }
  const identity = normalizeIdentity(values);
  const responseData = normalizeWireValue(values.responseData);
  if (
    !responseData
    || typeof responseData !== 'object'
    || Number(responseData.id) !== identity.medicationAdministrationId
    || String(responseData.status || '').toLowerCase() !== identity.transitionAction
  ) {
    throw AppError.internal(
      'MAR transition response cannot be committed as a command receipt',
      'MAR_TRANSITION_COMMAND_RESPONSE_INVALID',
    );
  }

  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO mar_transition_command_receipts
       (tenant_id, medication_administration_id, actor_uid, command_scope,
        transition_action, command_key, request_body_sha256, response_data)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::text, $5::text,
             $6::text, $7::char(64), $8::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING ${RECEIPT_COLUMNS}`,
    identity.tenantId,
    identity.medicationAdministrationId,
    identity.actorUid,
    identity.commandScope,
    identity.transitionAction,
    identity.commandKey,
    identity.requestBodySha256,
    JSON.stringify(responseData),
  );
  if (inserted[0]) return assertReceiptMatches(inserted[0], identity);

  const existing = await tx.$queryRawUnsafe(
    `SELECT ${RECEIPT_COLUMNS}
       FROM mar_transition_command_receipts
      WHERE tenant_id = $1::uuid
        AND (
          (actor_uid = $2::uuid AND command_scope = $3::text AND command_key = $4::text)
          OR (medication_administration_id = $5::integer AND transition_action = $6::text)
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
    identity.medicationAdministrationId,
    identity.transitionAction,
  );
  if (!existing[0]) {
    throw AppError.conflict(
      'MAR transition command receipt changed concurrently',
      'MAR_TRANSITION_COMMAND_CONCURRENT_CHANGE',
    );
  }
  return assertReceiptMatches(existing[0], identity);
}

export default {
  fingerprintMarTransitionRequest,
  findMarTransitionCommandReplayTx,
  recordMarTransitionCommandReceiptTx,
};
