import {
  CLINICAL_INBOX_ROUTE_ROLES,
  CLINICAL_STAFF_ROUTE_ROLES,
  COLD_CHAIN_ROUTE_ROLES,
  PATHWAY_NAMED_CLINICIAN_ROLES,
} from '../../config/routeRolePolicy.js';
import { isTenantTransactionClient } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  canonicalizeRequestRole,
  normalizeRole as normalizeQueueRole,
} from '../../utils/roles.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLINICAL_HUMAN_ROLE_SET = new Set(CLINICAL_STAFF_ROUTE_ROLES);
const PATHWAY_NAMED_CLINICAL_OWNER_ROLE_SET = new Set(PATHWAY_NAMED_CLINICIAN_ROLES);
const TASK_HUMAN_ROLE_SET = new Set([
  ...CLINICAL_INBOX_ROUTE_ROLES,
  ...COLD_CHAIN_ROUTE_ROLES,
]);

function normalizeRawRole(value) {
  const role = String(value || '').trim().toUpperCase();
  return role || null;
}

function currentActorForbidden() {
  return AppError.forbidden(
    'Current actor is not authorized for this work item',
    'CURRENT_HUMAN_ACTOR_FORBIDDEN',
  );
}

function requireTransaction(tx) {
  if (
    !tx
    || typeof tx.$queryRawUnsafe !== 'function'
    || !isTenantTransactionClient(tx)
  ) {
    throw AppError.internal(
      'Current human actor resolution requires a transaction',
      'CURRENT_HUMAN_ACTOR_TX_REQUIRED',
    );
  }
  return tx;
}

/**
 * Resolve the authenticated user against current tenant data while the caller's
 * transaction is open. JWT roles are evidence of the authenticated context,
 * never the source of truth: the user's current database role must still be
 * present in that context before it can authorize a clinical mutation.
 */
export async function resolveCurrentHumanActorTx({
  tx,
  tenantId,
  actorUid,
  authenticatedRoles = [],
  authenticatedPrimaryRole = null,
  authenticatedRawRole = null,
  rolePredicate = isTaskHumanOwnerRole,
} = {}) {
  const db = requireTransaction(tx);
  const uid = String(actorUid || '').trim().toLowerCase();
  const roles = new Set((Array.isArray(authenticatedRoles) ? authenticatedRoles : [authenticatedRoles])
    .map(canonicalizeRequestRole)
    .filter(Boolean));
  const primaryRole = canonicalizeRequestRole(authenticatedPrimaryRole);
  const rawTokenRole = normalizeRawRole(authenticatedRawRole);
  if (
    !UUID_PATTERN.test(uid)
    || roles.size === 0
    || !primaryRole
    || !rawTokenRole
    || !roles.has(primaryRole)
    || typeof rolePredicate !== 'function'
  ) {
    throw currentActorForbidden();
  }

  const rows = await db.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND LOWER(COALESCE(status, '')) = 'active'
        AND is_deleted IS FALSE
        AND deleted_at IS NULL
        AND role <> 'PATIENT'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    uid,
  );
  const user = rows[0] || null;
  const currentRawRole = normalizeRawRole(user?.role);
  const currentRole = canonicalizeRequestRole(currentRawRole);
  const queueRole = normalizeQueueRole(currentRawRole);
  if (
    !user?.uid
    || !currentRole
    || !queueRole
    || currentRawRole !== rawTokenRole
    || currentRole !== primaryRole
    || !rolePredicate(currentRole)
  ) {
    throw currentActorForbidden();
  }
  return Object.freeze({
    uid: String(user.uid).toLowerCase(),
    role: currentRole,
    queueRole,
    rawRole: currentRawRole,
  });
}

export async function resolveActivePathwayNamedClinicalOwnerTx({ tx, tenantId, uid } = {}) {
  const db = requireTransaction(tx);
  const ownerUid = await findActiveNamedOwnerTx({
    tx: db,
    tenantId,
    uid,
    rolePredicate: isPathwayNamedClinicalOwnerRole,
  });
  if (!ownerUid) {
    throw AppError.conflict(
      'Named pathway owner is unavailable or not clinically eligible',
      'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    );
  }
  return ownerUid;
}

export function isClinicalHumanOwnerRole(value) {
  const role = normalizeQueueRole(value);
  return Boolean(role && CLINICAL_HUMAN_ROLE_SET.has(role));
}

export function isTaskHumanOwnerRole(value) {
  const role = normalizeQueueRole(value);
  return Boolean(role && TASK_HUMAN_ROLE_SET.has(role));
}

export function isPathwayHumanOwnerRole(value) {
  return isPathwayNamedClinicalOwnerRole(value);
}

export function isPathwayNamedClinicalOwnerRole(value) {
  const role = normalizeQueueRole(value);
  return Boolean(role && PATHWAY_NAMED_CLINICAL_OWNER_ROLE_SET.has(role));
}

async function findActiveNamedOwnerTx({ tx, tenantId, uid, rolePredicate }) {
  const normalizedUid = String(uid || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalizedUid)) return null;

  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND LOWER(COALESCE(status, '')) = 'active'
        AND is_deleted IS FALSE
        AND deleted_at IS NULL
        AND role <> 'PATIENT'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    normalizedUid,
  );
  const user = rows[0] || null;
  if (!user || !rolePredicate(user.role)) return null;
  return String(user.uid || normalizedUid).toLowerCase();
}

export async function resolvePathwayTaskOwnerTx({
  tx,
  tenantId,
  requestedUid = null,
  fallbackRole = null,
}) {
  if (requestedUid !== null && requestedUid !== undefined) {
    const namedOwner = await findActiveNamedOwnerTx({
      tx,
      tenantId,
      uid: requestedUid,
      rolePredicate: isPathwayNamedClinicalOwnerRole,
    });
    if (!namedOwner) {
      throw AppError.conflict(
        'Named pathway owner is unavailable or not clinically eligible',
        'PATHWAY_NAMED_OWNER_UNAVAILABLE',
      );
    }
    return Object.freeze({
      assignedToUid: namedOwner,
      assignedToRole: null,
      resolution: 'requested_active_clinician',
      fallbackReason: null,
    });
  }

  const assignedToRole = normalizeQueueRole(fallbackRole);
  if (!isClinicalHumanOwnerRole(assignedToRole)) {
    throw AppError.conflict(
      'Pathway role queue is missing or not route-capable',
      'PATHWAY_ROLE_OWNER_INVALID',
    );
  }
  return Object.freeze({
    assignedToUid: null,
    assignedToRole,
    resolution: 'route_role_queue',
    fallbackReason: null,
  });
}

export async function resolveClinicalTaskOwnerTx({
  tx,
  tenantId,
  requestedUid = null,
  fallbackRole,
}) {
  const namedOwner = await findActiveNamedOwnerTx({
    tx,
    tenantId,
    uid: requestedUid,
    rolePredicate: isClinicalHumanOwnerRole,
  });
  if (namedOwner) {
    return Object.freeze({
      assignedToUid: namedOwner,
      assignedToRole: null,
      resolution: 'requested_active_clinician',
      fallbackReason: null,
    });
  }

  const normalizedFallback = normalizeQueueRole(fallbackRole);
  const assignedToRole = isClinicalHumanOwnerRole(normalizedFallback)
    ? normalizedFallback
    : 'DUTY_DOCTOR';
  let fallbackReason = null;
  if (requestedUid) fallbackReason = 'requested_clinician_unavailable';
  if (!isClinicalHumanOwnerRole(normalizedFallback)) {
    fallbackReason = normalizedFallback
      ? 'requested_role_not_route_capable'
      : (fallbackReason || 'no_named_clinician');
  }
  return Object.freeze({
    assignedToUid: null,
    assignedToRole,
    resolution: assignedToRole === normalizedFallback ? 'route_role_fallback' : 'duty_role_fallback',
    fallbackReason,
  });
}

export async function repairCriticalResultTaskOwnerTx({
  tx,
  tenantId,
  task,
  requestedUid = null,
  fallbackRole,
}) {
  if (!task || !['open', 'blocked', 'overdue'].includes(String(task.status || '').toLowerCase())) {
    return task;
  }

  if (task.assigned_to_uid) {
    const currentOwner = await findActiveNamedOwnerTx({
      tx,
      tenantId,
      uid: task.assigned_to_uid,
      rolePredicate: isClinicalHumanOwnerRole,
    });
    if (currentOwner) return task;
  } else if (isClinicalHumanOwnerRole(task.assigned_to_role)) {
    return task;
  }

  const owner = await resolveClinicalTaskOwnerTx({
    tx,
    tenantId,
    requestedUid,
    fallbackRole,
  });
  const metadata = JSON.stringify({
    critical_result_owner_resolution: owner.resolution,
    critical_result_owner_fallback_reason: owner.fallbackReason,
    critical_result_owner_repaired: true,
  });
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET assigned_to_uid = $3::uuid,
            assigned_to_role = $4::text,
            metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status IN ('open', 'blocked', 'overdue')
      RETURNING id, status, completed_at, workflow_sla_instance_id,
                sla_completion_semantics, assigned_to_uid, assigned_to_role, metadata`,
    tenantId,
    task.id,
    owner.assignedToUid,
    owner.assignedToRole,
    metadata,
  );
  return rows[0] || task;
}
