// Dedicated on-call roster (migration 682): who is on call for a
// tenant/department(/specialty)/tier over a concrete time window.
//
// Managers (the same roles that manage the department's roster boards) create
// and end on-call stints; any roster-authenticated staff member can ask "who
// is on call right now" and see their own stints. The DB exclusion constraint
// guarantees at most one ACTIVE holder per department/specialty/tier at any
// instant, which is what makes the now-query a lookup instead of a judgement
// call. The escalation engine consults active stints as a recipient-ordering
// signal (see escalationEngineService.resolveRecipientsForRole).
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  canManageRosterDepartmentWork,
  canViewRosterDepartment,
  getRosterDepartmentPolicy,
} from '../../config/rosterDepartmentConfig.js';

function httpError(message, statusCode, details) {
  return Object.assign(new Error(message), { statusCode, details });
}

function resolveTenant(tenantId) {
  // Fails closed on a missing tenant context unless ALLOW_DEFAULT_TENANT
  // sanctions the single-tenant default (W1 no-default-tenant-fallback rule).
  return requireTenantId(tenantId);
}

function parseTier(value) {
  if (value == null || value === '') return 1;
  const tier = Number.parseInt(String(value), 10);
  if (!Number.isInteger(tier) || tier < 1 || tier > 5) {
    throw httpError('tier must be between 1 (primary) and 5', 400);
  }
  return tier;
}

function parseTimestamp(value, label) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) {
    throw httpError(`${label} must be a valid timestamp`, 400);
  }
  return date;
}

async function resolveActor(user) {
  if (user?.uid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, role FROM users WHERE uid = $1::uuid LIMIT 1`,
      user.uid
    );
    if (rows.length) return rows[0];
  }
  const id = Number.parseInt(String(user?.id ?? ''), 10);
  if (Number.isInteger(id) && id > 0) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, name, role FROM users WHERE id = $1::int LIMIT 1`,
      id
    );
    if (rows.length) return rows[0];
  }
  throw httpError('Unable to resolve the requesting staff member', 401);
}

const ON_CALL_SELECT = `
  SELECT oc.id,
         oc.department,
         oc.specialty,
         oc.tier,
         oc.staff_id,
         oc.staff_uid,
         oc.staff_role,
         oc.start_at,
         oc.end_at,
         oc.is_active,
         oc.notes,
         oc.created_by,
         oc.ended_at,
         oc.end_reason,
         oc.created_at,
         u.name AS staff_name,
         u.phone AS staff_phone,
         cu.name AS created_by_name
    FROM staff_on_call_assignments oc
    LEFT JOIN users u ON u.id = oc.staff_id
    LEFT JOIN users cu ON cu.id = oc.created_by`;

export async function listDepartmentOnCallAssignments({
  department,
  tenantId = null,
  includeEnded = false,
  actorUser,
  limit = 100,
}) {
  const policy = getRosterDepartmentPolicy(department);
  if (!policy) {
    throw httpError('Roster department is not configured', 404);
  }
  if (!canViewRosterDepartment(actorUser, policy.department)) {
    throw httpError('You are not allowed to view this on-call roster', 403);
  }
  return prisma.$queryRawUnsafe(
    `${ON_CALL_SELECT}
      WHERE oc.tenant_id = $1::uuid
        AND oc.department = $2
        AND ($3::boolean OR (oc.is_active AND oc.end_at > NOW()))
      ORDER BY oc.start_at ASC, oc.tier ASC
      LIMIT $4::int`,
    resolveTenant(tenantId),
    policy.department,
    Boolean(includeEnded),
    Math.min(Math.max(Number(limit) || 100, 1), 200)
  );
}

export async function listMyOnCallAssignments({ actorUser, tenantId = null, limit = 50 }) {
  const actor = await resolveActor(actorUser);
  return prisma.$queryRawUnsafe(
    `${ON_CALL_SELECT}
      WHERE oc.tenant_id = $1::uuid
        AND oc.staff_id = $2::int
        AND oc.is_active
        AND oc.end_at > NOW() - INTERVAL '7 days'
      ORDER BY oc.start_at ASC
      LIMIT $3::int`,
    resolveTenant(tenantId),
    actor.id,
    Math.min(Math.max(Number(limit) || 50, 1), 100)
  );
}

// "Who is on call right now" — open to every roster-authenticated staff role:
// it is the lookup the escalation engine and ward staff both need.
export async function getWhoIsOnCall({ tenantId = null, department = null, tier = null, at = null }) {
  const policy = department ? getRosterDepartmentPolicy(department) : null;
  if (department && !policy) {
    throw httpError('Roster department is not configured', 404);
  }
  const atDate = at ? parseTimestamp(at, 'at') : new Date();
  const cleanTier = tier == null || tier === '' ? null : parseTier(tier);
  return prisma.$queryRawUnsafe(
    `${ON_CALL_SELECT}
      WHERE oc.tenant_id = $1::uuid
        AND oc.is_active
        AND oc.start_at <= $2::timestamptz
        AND oc.end_at > $2::timestamptz
        AND ($3::text IS NULL OR oc.department = $3)
        AND ($4::int IS NULL OR oc.tier = $4::int)
      ORDER BY oc.department ASC, oc.tier ASC, oc.start_at ASC`,
    resolveTenant(tenantId),
    atDate.toISOString(),
    policy ? policy.department : null,
    cleanTier
  );
}

export async function createOnCallAssignment({
  department,
  specialty = null,
  tier = 1,
  staffId,
  startAt,
  endAt,
  notes = null,
  actorUser,
  tenantId = null,
}) {
  const policy = getRosterDepartmentPolicy(department);
  if (!policy) {
    throw httpError('Roster department is not configured', 404);
  }
  if (!canManageRosterDepartmentWork(actorUser, policy.department)) {
    throw httpError('You are not allowed to manage this on-call roster', 403);
  }
  const cleanTier = parseTier(tier);
  const start = parseTimestamp(startAt, 'start_at');
  const end = parseTimestamp(endAt, 'end_at');
  if (end.getTime() <= start.getTime()) {
    throw httpError('end_at must be after start_at', 400);
  }
  const actor = await resolveActor(actorUser);
  const tenant = resolveTenant(tenantId);

  const staffIdInt = Number.parseInt(String(staffId ?? ''), 10);
  if (!Number.isInteger(staffIdInt) || staffIdInt <= 0) {
    throw httpError('staff_id must be a valid id', 400);
  }
  // Tenant predicate: staff ids are enumerable SERIALs — a manager must not
  // be able to put another tenant's staff member on call in their tenant.
  const staffRows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, name, role
       FROM users
      WHERE id = $1::int
        AND tenant_id = $3::uuid
        AND is_active = true
        AND role = ANY($2::text[])
      LIMIT 1`,
    staffIdInt,
    policy.staffRoles,
    tenant
  );
  if (!staffRows.length) {
    throw httpError('Staff member not found or not eligible for this roster department', 404);
  }
  const staff = staffRows[0];

  try {
    return await prisma.$transaction(async tx => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO staff_on_call_assignments
           (tenant_id, department, specialty, tier, staff_id, staff_uid, staff_role,
            start_at, end_at, notes, created_by, created_by_uid, updated_at)
         VALUES ($1::uuid,$2,$3,$4::int,$5::int,$6::uuid,$7,
                 $8::timestamptz,$9::timestamptz,$10,$11::int,$12::uuid,NOW())
         RETURNING *`,
        tenant,
        policy.department,
        specialty ? String(specialty).trim().slice(0, 120) : null,
        cleanTier,
        staff.id,
        staff.uid || null,
        staff.role || null,
        start.toISOString(),
        end.toISOString(),
        notes || null,
        actor.id,
        actor.uid || null
      );
      const created = rows[0];
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (action, resource, resource_id, uid, metadata, created_at)
         VALUES ('ON_CALL_ASSIGNED', 'staff_on_call_assignments', $1, $2::uuid, $3::jsonb, NOW())`,
        String(created.id),
        actor.uid || null,
        JSON.stringify({
          department: policy.department,
          specialty: created.specialty,
          tier: created.tier,
          staff_id: staff.id,
          start_at: created.start_at,
          end_at: created.end_at,
        })
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO notifications
           (uid, user_id, phone, title, body, type, priority, data, is_read,
            created_at, updated_at, recipient_role)
         SELECT u.uid, u.id, COALESCE(u.phone, ''), $1, $2, 'ON_CALL', 'HIGH', $3::jsonb,
                false, NOW(), NOW(), u.role
           FROM users u
          WHERE u.id = $4::int`,
        'On-call duty assigned',
        `You are on call (tier ${created.tier}) for ${policy.label} from ${start.toISOString()} to ${end.toISOString()}.`,
        JSON.stringify({
          on_call_assignment_id: created.id,
          department: policy.department,
          tier: created.tier,
          start_at: created.start_at,
          end_at: created.end_at,
          source: 'on_call_assigned',
        }),
        staff.id
      );
      return created;
    });
  } catch (err) {
    // 23P01 = exclusion_violation from ex_staff_on_call_no_overlap.
    if (err?.meta?.code === '23P01' || err?.code === 'P2004' || /23P01|ex_staff_on_call_no_overlap/.test(String(err?.message))) {
      throw httpError(
        'This window overlaps an existing active on-call assignment for the same department/specialty/tier',
        409
      );
    }
    throw err;
  }
}

export async function endOnCallAssignment({ id, reason = null, actorUser, tenantId = null }) {
  const assignmentId = Number.parseInt(String(id ?? ''), 10);
  if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
    throw httpError('on-call assignment id must be valid', 400);
  }
  const actor = await resolveActor(actorUser);
  const tenant = resolveTenant(tenantId);

  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT * FROM staff_on_call_assignments
        WHERE id = $1::int AND tenant_id = $2::uuid
        FOR UPDATE`,
      assignmentId,
      tenant
    );
    const existing = rows[0];
    if (!existing) {
      throw httpError('On-call assignment not found', 404);
    }
    if (!canManageRosterDepartmentWork(actorUser, existing.department)) {
      throw httpError('You are not allowed to manage this on-call roster', 403);
    }
    if (!existing.is_active) {
      throw httpError('On-call assignment is already ended', 409);
    }
    const updated = await tx.$queryRawUnsafe(
      `UPDATE staff_on_call_assignments
          SET is_active = FALSE,
              ended_by = $2::int,
              ended_by_uid = $3::uuid,
              ended_at = NOW(),
              end_reason = $4,
              updated_at = NOW()
        WHERE id = $1::int
        RETURNING *`,
      assignmentId,
      actor.id,
      actor.uid || null,
      reason || null
    );
    const after = updated[0];
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_logs (action, resource, resource_id, uid, metadata, created_at)
       VALUES ('ON_CALL_ENDED', 'staff_on_call_assignments', $1, $2::uuid, $3::jsonb, NOW())`,
      String(assignmentId),
      actor.uid || null,
      JSON.stringify({
        department: existing.department,
        tier: existing.tier,
        staff_id: existing.staff_id,
        reason: reason || null,
      })
    );
    try {
      await tx.$executeRawUnsafe(
        `INSERT INTO notifications
           (uid, user_id, phone, title, body, type, priority, data, is_read,
            created_at, updated_at, recipient_role)
         SELECT u.uid, u.id, COALESCE(u.phone, ''), $1, $2, 'ON_CALL', 'NORMAL', $3::jsonb,
                false, NOW(), NOW(), u.role
           FROM users u
          WHERE u.id = $4::int`,
        'On-call duty ended',
        `Your on-call stint for ${existing.department} was ended${reason ? `: ${reason}` : ''}.`,
        JSON.stringify({
          on_call_assignment_id: assignmentId,
          department: existing.department,
          source: 'on_call_ended',
        }),
        existing.staff_id
      );
    } catch (err) {
      logger.warn('On-call end notification failed', { id: assignmentId, error: err.message });
    }
    return after;
  });
}
