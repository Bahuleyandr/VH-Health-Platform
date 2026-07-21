import { AppError } from '../../utils/AppError.js';

const COMMAND_SCOPES = new Set(['manual_result', 'panel_result']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateIdentity({ tenantId, actorUid, scope, commandKey, requestBodySha256 }) {
  if (
    !UUID_PATTERN.test(String(tenantId || ''))
    || !UUID_PATTERN.test(String(actorUid || ''))
    || !COMMAND_SCOPES.has(scope)
  ) {
    throw AppError.badRequest('Lab result command identity is invalid', 'LAB_RESULT_COMMAND_INVALID');
  }
  if (
    typeof commandKey !== 'string'
    || commandKey.length < 1
    || commandKey.length > 200
    || commandKey !== commandKey.trim()
  ) {
    throw AppError.badRequest('Lab result command key is invalid', 'LAB_RESULT_COMMAND_INVALID');
  }
  if (!SHA256_PATTERN.test(String(requestBodySha256 || ''))) {
    throw AppError.badRequest('Lab result command fingerprint is invalid', 'LAB_RESULT_COMMAND_INVALID');
  }
}

export async function claimLabResultIngestCommand({
  tx,
  tenantId,
  actorUid,
  scope,
  commandKey,
  requestBodySha256,
}) {
  if (!tx) throw new Error('Lab result command claim requires a transaction client');
  validateIdentity({ tenantId, actorUid, scope, commandKey, requestBodySha256 });

  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO lab_result_ingest_commands
       (tenant_id, actor_uid, command_scope, command_key, request_body_sha256)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)
     ON CONFLICT (tenant_id, actor_uid, command_scope, command_key)
     DO NOTHING
     RETURNING id, status, request_body_sha256, result_ids, panel_id, response_data`,
    tenantId,
    String(actorUid),
    scope,
    commandKey,
    requestBodySha256,
  );
  if (inserted[0]) return { replayed: false, command: inserted[0] };

  const existingRows = await tx.$queryRawUnsafe(
    `SELECT id, status, request_body_sha256, result_ids, panel_id, response_data
       FROM lab_result_ingest_commands
      WHERE tenant_id = $1::uuid
        AND actor_uid = $2::uuid
        AND command_scope = $3
        AND command_key = $4
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    String(actorUid),
    scope,
    commandKey,
  );
  const existing = existingRows[0];
  if (!existing) {
    throw AppError.conflict(
      'Lab result command changed concurrently',
      'LAB_RESULT_COMMAND_CONCURRENT_CHANGE',
    );
  }
  if (existing.request_body_sha256 !== requestBodySha256) {
    throw new AppError(
      'Idempotency-Key reused with a different request body',
      422,
      'LAB_RESULT_COMMAND_BODY_MISMATCH',
    );
  }
  if (existing.status !== 'completed' || !existing.response_data) {
    throw AppError.conflict(
      'A request with this Idempotency-Key is currently in flight',
      'LAB_RESULT_COMMAND_IN_FLIGHT',
    );
  }
  return { replayed: true, command: existing };
}

export async function completeLabResultIngestCommand({
  tx,
  tenantId,
  commandId,
  resultIds,
  panelId = null,
  responseData,
}) {
  if (!tx) throw new Error('Lab result command completion requires a transaction client');
  const rows = await tx.$queryRawUnsafe(
    `UPDATE lab_result_ingest_commands
        SET status = 'completed',
            result_ids = $3::int[],
            panel_id = $4::uuid,
            response_data = $5::jsonb,
            completed_at = NOW(),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = 'processing'
      RETURNING id, status, result_ids, panel_id, response_data`,
    tenantId,
    commandId,
    resultIds.map(Number),
    panelId,
    JSON.stringify(responseData),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'Lab result command changed concurrently',
      'LAB_RESULT_COMMAND_CONCURRENT_CHANGE',
    );
  }
  return rows[0];
}

export async function finaliseHttpIdempotencyInTx({
  tx,
  claimId,
  responseData,
  requestId = null,
}) {
  if (!tx) throw new Error('HTTP idempotency finalization requires a transaction client');
  if (!claimId) return null;
  const responseBody = {
    success: true,
    message: 'Success',
    data: responseData,
    ...(requestId ? { requestId } : {}),
  };
  const rows = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete',
            response_status = 200,
            response_body = $2::jsonb,
            updated_at = NOW()
      WHERE id = $1
        AND status = 'in_flight'
      RETURNING id`,
    claimId,
    JSON.stringify(responseBody),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'HTTP idempotency claim changed before clinical commit',
      'LAB_RESULT_HTTP_IDEMPOTENCY_CHANGED',
    );
  }
  return rows[0];
}

export default {
  claimLabResultIngestCommand,
  completeLabResultIngestCommand,
  finaliseHttpIdempotencyInTx,
};
