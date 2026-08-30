const COMMAND_KEY_PATTERN = /^[A-Za-z0-9_:.-]{1,200}$/;
const SCOPE_PATTERN = /^[a-z0-9_]{1,48}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class SalaryRevisionCommandError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = 'SalaryRevisionCommandError';
    this.statusCode = statusCode;
  }
}

function wireValue(value) {
  return JSON.parse(JSON.stringify(value, (_, candidate) => (
    typeof candidate === 'bigint' ? candidate.toString() : candidate
  )));
}

export function salaryRevisionCommandFromRequest(req, commandScope, targetIdentity) {
  const claim = req.idempotencyClaim;
  const command = {
    actorUid: req.user?.uid,
    commandScope,
    commandKey: claim?.requestKey,
    requestBodySha256: claim?.requestBodyHash,
    httpIdempotencyClaimId: claim?.id,
    targetIdentity: String(targetIdentity || ''),
    requestId: req.id || null,
  };
  if (
    !command.actorUid
    || !SCOPE_PATTERN.test(String(command.commandScope || ''))
    || !COMMAND_KEY_PATTERN.test(String(command.commandKey || ''))
    || !SHA256_PATTERN.test(String(command.requestBodySha256 || ''))
    || !Number.isInteger(Number(command.httpIdempotencyClaimId))
    || Number(command.httpIdempotencyClaimId) <= 0
    || !command.targetIdentity.trim()
    || command.targetIdentity.length > 240
  ) {
    throw new SalaryRevisionCommandError(
      'Salary revision command requires a valid durable idempotency identity',
      400,
    );
  }
  return command;
}

function assertReceiptMatches(receipt, command) {
  if (
    receipt.actor_uid !== command.actorUid
    || receipt.command_scope !== command.commandScope
    || receipt.command_key !== command.commandKey
    || receipt.request_body_sha256 !== command.requestBodySha256
    || receipt.target_identity !== command.targetIdentity
    || !receipt.actor_role
    || receipt.actor_role === 'PATIENT'
    || receipt.authority_source !== 'users_active_row'
    || !receipt.authority_checked_at
  ) {
    throw new SalaryRevisionCommandError(
      'Idempotency-Key is already bound to a different salary revision command',
      422,
    );
  }
  if (!receipt.response_data || typeof receipt.response_data !== 'object') {
    throw new SalaryRevisionCommandError('Salary revision command receipt is incomplete');
  }
  return {
    responseData: receipt.response_data,
    message: receipt.response_message,
  };
}

export async function findSalaryRevisionCommandReplayTx(tx, tenantId, command) {
  await tx.$queryRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS lock_acquired`,
    `${tenantId}:${command.actorUid}:${command.commandScope}:${command.commandKey}`,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT actor_uid::text, command_scope, command_key,
            request_body_sha256::text, target_identity,
            actor_role, authority_checked_at, authority_source,
            response_data, response_message
       FROM salary_revision_command_receipts
      WHERE tenant_id = $1::uuid
        AND actor_uid = $2::uuid
        AND command_scope = $3
        AND command_key = $4
      LIMIT 1`,
    tenantId,
    command.actorUid,
    command.commandScope,
    command.commandKey,
  );
  return rows[0] ? assertReceiptMatches(rows[0], command) : null;
}

export async function finaliseSalaryRevisionCommandTx(
  tx,
  { tenantId, command, responseData, message },
) {
  const normalizedResponse = wireValue(responseData);
  const authorities = await tx.$queryRawUnsafe(
    `SELECT UPPER(role) AS actor_role, clock_timestamp() AS authority_checked_at
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = true
        AND COALESCE(is_deleted, false) = false
        AND deleted_at IS NULL
        AND merged_into_uid IS NULL
        AND LOWER(COALESCE(status, 'active')) = 'active'
        AND UPPER(role) <> 'PATIENT'
      FOR SHARE`,
    tenantId,
    command.actorUid,
  );
  if (authorities.length !== 1) {
    throw new SalaryRevisionCommandError(
      'Salary revision command actor is no longer actively authorized',
      403,
    );
  }
  const authority = authorities[0];
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO salary_revision_command_receipts (
       tenant_id, actor_uid, actor_role, authority_checked_at, authority_source,
       command_scope, command_key,
       request_body_sha256, target_identity, response_data, response_message
     )
     VALUES ($1::uuid, $2::uuid, $9, $10::timestamptz, 'users_active_row',
             $3, $4, $5::char(64), $6, $7::jsonb, $8)
     ON CONFLICT DO NOTHING
     RETURNING actor_uid::text, command_scope, command_key,
               request_body_sha256::text, target_identity,
               actor_role, authority_checked_at, authority_source,
               response_data, response_message`,
    tenantId,
    command.actorUid,
    command.commandScope,
    command.commandKey,
    command.requestBodySha256,
    command.targetIdentity,
    JSON.stringify(normalizedResponse),
    message,
    authority.actor_role,
    authority.authority_checked_at,
  );
  let committed;
  if (inserted[0]) {
    committed = assertReceiptMatches(inserted[0], command);
  } else {
    committed = await findSalaryRevisionCommandReplayTx(tx, tenantId, command);
  }
  if (!committed) {
    throw new SalaryRevisionCommandError('Salary revision command receipt changed concurrently');
  }
  const responseBody = {
    success: true,
    message: committed.message,
    data: committed.responseData,
    ...(command.requestId ? { requestId: command.requestId } : {}),
  };
  const finalised = await tx.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'complete', response_status = 200,
            response_body = $6::jsonb, updated_at = clock_timestamp()
      WHERE id = $1::int
        AND tenant_id = $2::uuid
        AND user_uid = $3::uuid
        AND request_key = $4
        AND request_body_hash = $5::char(64)
        AND status = 'in_flight'
      RETURNING id`,
    Number(command.httpIdempotencyClaimId),
    tenantId,
    command.actorUid,
    command.commandKey,
    command.requestBodySha256,
    JSON.stringify(responseBody),
  );
  if (finalised.length !== 1) {
    throw new SalaryRevisionCommandError(
      'HTTP idempotency claim changed before salary revision commit',
    );
  }
  return committed;
}
