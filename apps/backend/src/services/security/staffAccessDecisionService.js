import {
  getManageableRolesFromPolicy,
  getRolePolicy,
  getRolePolicyHash,
  getRolePolicyVersion,
  getStaffVisibilityRoles,
} from '../../config/rolePolicyGraph.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { isGovernanceSchemaMissing } from './schemaMissingGuard.js';
import { normalizeRole } from '../../utils/roles.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  getStaffAccessPolicy,
  SAFE_STAFF_ACCESS_DENIAL_MESSAGE,
  STAFF_ACCESS_POLICY_CODES,
} from './staffAccessPolicyRegistry.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

export { SAFE_STAFF_ACCESS_DENIAL_MESSAGE, STAFF_ACCESS_POLICY_CODES };

export function deriveTenantIdFromStaffRequest(req) {
  return requireTenantId(
    req.tenantId
    || req.user?.tenant_id
    || req.user?.tenantId
    || req.tenant?.id,
  );
}

export function deriveStaffActionFromRequest(req, policy = null) {
  if (policy?.action) return policy.action;
  switch (req?.method) {
    case 'GET':
    case 'HEAD':
      return 'VIEW';
    case 'POST':
      return 'CREATE';
    case 'PUT':
    case 'PATCH':
      return 'UPDATE';
    case 'DELETE':
      return 'DELETE';
    default:
      return 'ACCESS';
  }
}

function actorUidOf(req) {
  return req?.acting?.actorUid ?? req?.user?.uid ?? null;
}

function actorRoleOf(req) {
  return normalizeRole(req?.acting?.actorRole ?? req?.user?.role);
}

function cleanUuid(value) {
  const text = value == null ? '' : String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function cleanInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeTargetRow(row) {
  if (!row) return null;
  return {
    user_id: row.user_id == null ? null : Number(row.user_id),
    user_uid: row.user_uid || row.uid || null,
    staff_row_id: row.staff_row_id == null ? null : Number(row.staff_row_id),
    employee_id: row.employee_id || null,
    role: normalizeRole(row.role),
    name: row.name || null,
    department: row.department || null,
    designation: row.designation || row.position || null,
    supervisor_id: row.supervisor_id == null ? null : Number(row.supervisor_id),
    tenant_id: row.tenant_id || null,
  };
}

function rolePolicyFor(roleCode) {
  const normalized = normalizeRole(roleCode);
  return getRolePolicy().roles.find((role) => role.role_code === normalized) || null;
}

function isAdminRole(role) {
  return role === 'SUPER_ADMIN' || role === 'ADMIN';
}

function isSelf(actor, target) {
  if (!actor || !target) return false;
  if (actor.uid && target.user_uid && String(actor.uid) === String(target.user_uid)) return true;
  if (actor.id != null && target.user_id != null && Number(actor.id) === Number(target.user_id)) return true;
  return false;
}

function actorSelfTargetFromRequest(req) {
  const actorUid = cleanText(actorUidOf(req));
  const actorRole = actorRoleOf(req);
  if (!actorUid || !actorRole || actorRole === 'PATIENT') return null;
  return normalizeTargetRow({
    user_id: cleanInt(req?.user?.id),
    user_uid: actorUid,
    role: actorRole,
    name: req?.user?.name || null,
    tenant_id: deriveTenantIdFromStaffRequest(req),
  });
}

function hasAnyLeadershipScope(actorRole, rolePolicy) {
  if (!rolePolicy || actorRole === 'PATIENT') return false;
  const visibility = getStaffVisibilityRoles(actorRole).filter((role) => role !== actorRole);
  const manageable = getManageableRolesFromPolicy(actorRole);
  const recommend = rolePolicy.hr_process?.can_recommend_leave_for_roles || [];
  return visibility.length > 0 || manageable.length > 0 || recommend.length > 0;
}

function canHrProcessTarget(actorRole, targetRole) {
  if (actorRole !== 'HR_STAFF') return false;
  if (!targetRole || ['SUPER_ADMIN', 'ADMIN', 'PATIENT'].includes(targetRole)) return false;
  return getStaffVisibilityRoles(actorRole).includes(targetRole);
}

function canReportingScopeTarget(actorRole, targetRole, rolePolicy) {
  if (!targetRole || targetRole === 'PATIENT' || !rolePolicy) return false;
  const visibilityRoles = getStaffVisibilityRoles(actorRole);
  if (visibilityRoles.includes(targetRole)) return true;
  const recommendedRoles = rolePolicy.hr_process?.can_recommend_leave_for_roles || [];
  return recommendedRoles.includes(targetRole);
}

function canManageTarget(actorRole, targetRole) {
  if (!targetRole || targetRole === 'PATIENT') return false;
  return getManageableRolesFromPolicy(actorRole).includes(targetRole);
}

function collectionDecisionAllowed(actorRole, rolePolicy, policy) {
  if (actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN') return true;
  if (!rolePolicy || actorRole === 'PATIENT') return false;

  switch (policy.collection_access) {
    case 'visibility':
      return getStaffVisibilityRoles(actorRole).length > 0;
    case 'leadership':
      return actorRole === 'HR_STAFF' || hasAnyLeadershipScope(actorRole, rolePolicy);
    case 'payroll':
      return actorRole === 'HR_STAFF';
    case 'people_ops':
    default:
      return actorRole === 'HR_STAFF';
  }
}

function collectionAccessSource(actorRole, rolePolicy, policy) {
  if (actorRole === 'SUPER_ADMIN' || actorRole === 'ADMIN') return 'role';
  if (actorRole === 'HR_STAFF') return 'hr_process';
  if (policy.allow_reporting_scope && hasAnyLeadershipScope(actorRole, rolePolicy)) return 'reporting_scope';
  return 'role';
}

function baseDecision({ req, targetStaff, policy, allowed, accessDecision, accessSource, reason, extras = {} }) {
  const actorRole = actorRoleOf(req);
  return {
    allowed,
    accessDecision,
    accessSource,
    reason,
    policy_code: policy?.code || null,
    policy_version: getRolePolicyVersion(),
    policy_hash: getRolePolicyHash(),
    actor_uid: actorUidOf(req),
    actor_role: actorRole,
    target_staff_uid: targetStaff?.user_uid || null,
    target_user_id: targetStaff?.user_id || null,
    target_staff_id: targetStaff?.staff_row_id || null,
    target_role: targetStaff?.role || null,
    route: req?.originalUrl || req?.url || null,
    action: deriveStaffActionFromRequest(req, policy),
    request_id: req?.id || null,
    safe_denial_code: policy?.safe_denial_code || 'STAFF_ACCESS_DENIED',
    safe_denial_message: policy?.safe_denial_message || SAFE_STAFF_ACCESS_DENIAL_MESSAGE,
    ...extras,
  };
}

function allowDecision(args, accessSource, reason, extras = {}) {
  return baseDecision({
    ...args,
    allowed: true,
    accessDecision: 'allow',
    accessSource,
    reason,
    extras,
  });
}

function denyDecision(args, reason, extras = {}) {
  return baseDecision({
    ...args,
    allowed: false,
    accessDecision: 'deny',
    accessSource: extras.accessSource || 'unknown',
    reason,
    extras,
  });
}

// Audit finding M3: exact-SQLSTATE + non-production-only skip (see
// schemaMissingGuard.js) — never the /does not exist/i message regex.
function isSchemaMissing(err) {
  return isGovernanceSchemaMissing(err);
}

export function shouldSkipStaffAccessCheckError(err) {
  return isSchemaMissing(err);
}

export async function resolveStaffIdentity(req, identifier) {
  const tenantId = deriveTenantIdFromStaffRequest(req);
  const text = cleanText(identifier);
  const uid = cleanUuid(text);
  const intId = cleanInt(text);

  if (!text) return null;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT
        u.id AS user_id,
        u.uid AS user_uid,
        u.role,
        u.name,
        u.phone,
        u.tenant_id,
        s.id AS staff_row_id,
        s.employee_id,
        s.department,
        COALESCE(s.designation, s.position) AS designation,
        s.supervisor_id
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE u.tenant_id = $1::uuid
        AND COALESCE(UPPER(u.role), '') <> 'PATIENT'
        AND (
          ($2::uuid IS NOT NULL AND u.uid = $2::uuid)
          OR ($3::int IS NOT NULL AND u.id = $3::int)
          OR ($3::int IS NOT NULL AND s.id = $3::int)
          OR ($4::text IS NOT NULL AND LOWER(COALESCE(s.employee_id, '')) = LOWER($4::text))
          OR ($4::text IS NOT NULL AND LOWER(COALESCE(u.phone, '')) = LOWER($4::text))
        )
      ORDER BY
        CASE
          WHEN $2::uuid IS NOT NULL AND u.uid = $2::uuid THEN 0
          WHEN $3::int IS NOT NULL AND u.id = $3::int THEN 1
          WHEN $3::int IS NOT NULL AND s.id = $3::int THEN 2
          ELSE 3
        END,
        u.id DESC
      LIMIT 1`,
    tenantId,
    uid,
    intId,
    text,
  );

  return normalizeTargetRow(rows[0]);
}

async function resolveStaffFromResource(req, { resourceType, resourceId }) {
  const tenantId = deriveTenantIdFromStaffRequest(req);
  const id = cleanInt(resourceId);
  const uid = cleanUuid(resourceId);
  let rows = [];

  if (resourceType === 'leave_application' && id) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT u.id AS user_id, u.uid AS user_uid, u.role, u.name, u.tenant_id,
              s.id AS staff_row_id, s.employee_id, s.department,
              COALESCE(s.designation, s.position) AS designation, s.supervisor_id
         FROM leave_applications la
         JOIN users u ON u.id = la.staff_id
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE la.id = $2::int AND u.tenant_id = $1::uuid
        LIMIT 1`,
      tenantId,
      id,
    );
  } else if (resourceType === 'payslip' && id) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT u.id AS user_id, u.uid AS user_uid, u.role, u.name, u.tenant_id,
              s.id AS staff_row_id, s.employee_id, s.department,
              COALESCE(s.designation, s.position) AS designation, s.supervisor_id
         FROM payslips p
         JOIN users u ON u.uid = p.staff_uid
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE p.id = $2::int AND u.tenant_id = $1::uuid
        LIMIT 1`,
      tenantId,
      id,
    );
  } else if (resourceType === 'salary_revision' && id) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT u.id AS user_id, u.uid AS user_uid, u.role, u.name, u.tenant_id,
              s.id AS staff_row_id, s.employee_id, s.department,
              COALESCE(s.designation, s.position) AS designation, s.supervisor_id
         FROM salary_revisions sr
         JOIN users u ON u.uid = sr.staff_uid
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE sr.id = $2::int AND u.tenant_id = $1::uuid
        LIMIT 1`,
      tenantId,
      id,
    );
  } else if (resourceType === 'attendance_dispute' && id) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT u.id AS user_id, u.uid AS user_uid, u.role, u.name, u.tenant_id,
              s.id AS staff_row_id, s.employee_id, s.department,
              COALESCE(s.designation, s.position) AS designation, s.supervisor_id
         FROM attendance_disputes d
         JOIN users u ON u.id = d.staff_id
         LEFT JOIN staff s ON s.user_id = u.uid
        WHERE d.id = $2::int AND u.tenant_id = $1::uuid
        LIMIT 1`,
      tenantId,
      id,
    );
  } else if (resourceType === 'staff_row' && id) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT u.id AS user_id, u.uid AS user_uid, u.role, u.name, u.tenant_id,
              s.id AS staff_row_id, s.employee_id, s.department,
              COALESCE(s.designation, s.position) AS designation, s.supervisor_id
         FROM staff s
         JOIN users u ON u.uid = s.user_id
        WHERE s.id = $2::int AND u.tenant_id = $1::uuid
        LIMIT 1`,
      tenantId,
      id,
    );
  } else if (resourceType === 'staff_uid' && uid) {
    return resolveStaffIdentity(req, uid);
  }

  return normalizeTargetRow(rows[0]);
}

async function resolveStaffTarget(req, options = {}) {
  const {
    target,
    targetIdentifier,
    targetSelector,
    targetParam = null,
    selfIfNoTarget = false,
    resourceType = null,
    resourceId = null,
    resourceIdParam = null,
    resourceIdSelector = null,
  } = options;

  if (target) return normalizeTargetRow(target);

  let identifier = targetIdentifier;
  if (identifier == null && typeof targetSelector === 'function') {
    identifier = targetSelector(req);
  }
  if (identifier == null && targetParam) {
    identifier = req.params?.[targetParam] ?? req.query?.[targetParam] ?? req.body?.[targetParam];
  }
  if (identifier != null) {
    return resolveStaffIdentity(req, identifier);
  }

  let resolvedResourceId = resourceId;
  if (resolvedResourceId == null && typeof resourceIdSelector === 'function') {
    resolvedResourceId = resourceIdSelector(req);
  }
  if (resolvedResourceId == null && resourceIdParam) {
    resolvedResourceId = req.params?.[resourceIdParam] ?? req.query?.[resourceIdParam] ?? req.body?.[resourceIdParam];
  }
  if (resourceType && resolvedResourceId != null) {
    return resolveStaffFromResource(req, { resourceType, resourceId: resolvedResourceId });
  }

  if (selfIfNoTarget && actorUidOf(req)) {
    return actorSelfTargetFromRequest(req);
  }

  return null;
}

async function auditStaffAccessDecision(req, decision, policy, targetStaff, options = {}) {
  if (!policy?.audit_required) return;

  const tenantId = deriveTenantIdFromStaffRequest(req);
  const metadata = {
    policy_version: decision.policy_version,
    policy_hash: decision.policy_hash,
    device_type: req.user?.deviceType ?? req.user?.device_type ?? null,
    target_department: targetStaff?.department || null,
    ...options.auditMetadata,
  };

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff_access_audit_log
        (tenant_id, target_staff_uid, target_user_id, target_staff_id, target_role,
         actor_uid, actor_role, access_decision, access_source, policy_code,
         resource_type, resource_id, route, action, reason, request_id, metadata,
         created_by, updated_by)
       VALUES
        ($1::uuid, $2::uuid, $3::int, $4::int, $5, $6::uuid, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17::jsonb, $6::uuid, $6::uuid)`,
      tenantId,
      targetStaff?.user_uid || null,
      targetStaff?.user_id || null,
      targetStaff?.staff_row_id || null,
      targetStaff?.role || null,
      actorUidOf(req),
      actorRoleOf(req),
      decision.accessDecision,
      decision.accessSource,
      policy.code,
      options.resourceType || policy.resource_type || null,
      options.resourceId == null ? null : String(options.resourceId),
      req.originalUrl || req.url || null,
      deriveStaffActionFromRequest(req, policy),
      decision.reason || null,
      req.id || null,
      JSON.stringify(metadata),
    );
  } catch (err) {
    if (isSchemaMissing(err)) {
      logger.warn('Staff access audit skipped because audit table is not migrated', {
        path: req.originalUrl || req.url,
        policyCode: policy.code,
      });
      return;
    }
    logger.error('Staff access audit write failed:', err);
  }
}

function decideStaffAccess(req, policy, targetStaff, options = {}) {
  const actorRole = actorRoleOf(req);
  const actor = { uid: actorUidOf(req), id: req.user?.id == null ? null : Number(req.user.id) };
  const rolePolicy = rolePolicyFor(actorRole);
  const args = { req, targetStaff, policy };

  if (!policy) {
    return denyDecision({ req, targetStaff, policy: { code: options.policyCode } }, 'Unknown staff access policy');
  }

  if (!actorRole || actorRole === 'PATIENT' || !rolePolicy) {
    return denyDecision(args, 'Actor role is not permitted for staff governance access');
  }

  if (!targetStaff) {
    if (options.requireTarget) {
      return denyDecision(args, 'Staff target could not be resolved');
    }
    if (options.allowNoTarget && collectionDecisionAllowed(actorRole, rolePolicy, policy)) {
      return allowDecision(
        args,
        collectionAccessSource(actorRole, rolePolicy, policy),
        'Collection access allowed by role policy graph',
        { collection_access: true },
      );
    }
    return denyDecision(args, 'Staff target is required for this access policy');
  }

  const targetRole = normalizeRole(targetStaff.role);
  if (!targetRole || targetRole === 'PATIENT') {
    return denyDecision(args, 'Target is not an active staff role');
  }

  if (policy.allow_self && isSelf(actor, targetStaff)) {
    return allowDecision(args, 'self', 'Self-service staff access');
  }

  if (actorRole === 'SUPER_ADMIN') {
    return allowDecision(args, 'role', 'Super admin staff governance access');
  }

  if (actorRole === 'ADMIN' && targetRole !== 'SUPER_ADMIN') {
    return allowDecision(args, 'role', 'Admin staff governance access');
  }

  if (policy.allow_hr_process && canHrProcessTarget(actorRole, targetRole)) {
    return allowDecision(args, 'hr_process', 'HR staff processing scope');
  }

  if (policy.allow_management_scope && canManageTarget(actorRole, targetRole)) {
    return allowDecision(args, 'management_scope', 'Management scope from role policy graph');
  }

  if (policy.allow_reporting_scope && canReportingScopeTarget(actorRole, targetRole, rolePolicy)) {
    return allowDecision(args, 'reporting_scope', 'Reporting scope from role policy graph');
  }

  if (isAdminRole(targetRole) && actorRole !== 'SUPER_ADMIN') {
    return denyDecision(args, 'Only super admin may access admin-tier staff records');
  }

  return denyDecision(args, SAFE_STAFF_ACCESS_DENIAL_MESSAGE);
}

export async function authorizeStaffAccessRequest(req, options = {}) {
  const policyCode = options.policyCode || STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW;
  const policy = getStaffAccessPolicy(policyCode);
  let targetStaff = null;
  let decision = null;

  try {
    targetStaff = await resolveStaffTarget(req, options);
    decision = decideStaffAccess(req, policy, targetStaff, { ...options, policyCode });
    await auditStaffAccessDecision(req, decision, policy, targetStaff, {
      resourceType: options.resourceType,
      resourceId: options.resourceId ?? options.resourceIdSelector?.(req) ?? (options.resourceIdParam ? req.params?.[options.resourceIdParam] : null),
      auditMetadata: options.auditMetadata,
    });
    req.staffAccessDecision = decision;
    req.staffAccessTarget = targetStaff;
    return decision;
  } catch (err) {
    if (isSchemaMissing(err)) throw err;
    logger.error('Staff access decision failed:', err);
    decision = denyDecision(
      { req, targetStaff, policy: policy || { code: policyCode } },
      'Staff access decision service failed',
      { error: err?.message || String(err) },
    );
    req.staffAccessDecision = decision;
    return decision;
  }
}

export function staffAccessErrorPayload(decision) {
  return {
    success: false,
    code: decision?.safe_denial_code || 'STAFF_ACCESS_DENIED',
    message: decision?.safe_denial_message || SAFE_STAFF_ACCESS_DENIAL_MESSAGE,
    policy_code: decision?.policy_code || null,
    access_source: decision?.accessSource || 'unknown',
    reason: decision?.reason || null,
    policy_version: decision?.policy_version || getRolePolicyVersion(),
    policy_hash: decision?.policy_hash || getRolePolicyHash(),
  };
}
