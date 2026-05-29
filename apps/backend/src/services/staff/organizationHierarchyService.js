import prisma from '../../lib/prisma.js';
import {
  ORGANIZATION_GUARDRAILS,
  ORGANIZATION_HIERARCHY_EDGES,
  ORGANIZATION_HIERARCHY_LANES,
  ORGANIZATION_HIERARCHY_NODES,
  ORGANIZATION_HIERARCHY_VERSION,
  ORGANIZATION_ROLE_BOUNDARIES,
} from '../../config/organizationHierarchyConfig.js';

function uniqueRoleCodes() {
  const codes = new Set();
  for (const node of ORGANIZATION_HIERARCHY_NODES) {
    for (const role of node.role_codes || []) codes.add(role);
    for (const role of node.recommended_role_codes || []) codes.add(role);
  }
  for (const boundary of ORGANIZATION_ROLE_BOUNDARIES) {
    for (const role of boundary.role_codes || []) codes.add(role);
  }
  return [...codes];
}

function normalizeRoleCounts(rows = []) {
  const counts = {};
  for (const row of rows) {
    const role = String(row.role || '').trim().toUpperCase();
    if (!role) continue;
    counts[role] = Number(row._count?._all ?? row.count ?? 0);
  }
  return counts;
}

function normalizeStaffMembers(rows = []) {
  const byRole = {};
  for (const row of rows) {
    const role = String(row.role || '').trim().toUpperCase();
    if (!role) continue;
    byRole[role] ??= [];
    byRole[role].push({
      uid: row.uid,
      name: row.name,
      role,
      employee_id: row.employee_id,
      department: row.department,
      position: row.position || row.designation,
      is_active: row.staff_is_active ?? row.user_is_active ?? true,
      current_status: row.current_status || 'registered',
    });
  }
  return byRole;
}

function countForNode(node, roleCounts) {
  return (node.role_codes || []).reduce((total, role) => total + (roleCounts[role] || 0), 0);
}

function membersForNode(node, staffByRole) {
  return (node.role_codes || []).flatMap((role) => staffByRole[role] || []);
}

export function buildOrganizationHierarchy({ roleCounts = {}, staffByRole = {}, tenantScoped = false } = {}) {
  const nodes = ORGANIZATION_HIERARCHY_NODES.map((node) => ({
    ...node,
    active_staff_count: countForNode(node, roleCounts),
    staff_members: membersForNode(node, staffByRole),
  }));

  return {
    version: ORGANIZATION_HIERARCHY_VERSION,
    generated_at: new Date().toISOString(),
    tenant_scoped: tenantScoped,
    counts_status: tenantScoped ? 'live' : 'tenant-unavailable',
    design_note:
      'This chart separates platform access, work supervision, and leave approval so no role silently oversteps another.',
    lanes: ORGANIZATION_HIERARCHY_LANES,
    nodes,
    edges: ORGANIZATION_HIERARCHY_EDGES,
    role_boundaries: ORGANIZATION_ROLE_BOUNDARIES,
    guardrails: ORGANIZATION_GUARDRAILS,
    recommendations: [
      {
        title: 'Use Operations Incharge / Facilities Manager as the daily work line',
        detail:
          'Housekeeping and maintenance should not report directly to CEO / COO for routine work. They should escalate through operations, with CEO / COO reserved for unresolved or policy-level issues.',
      },
      {
        title: 'Make leave a two-step workflow for coverage-sensitive teams',
        detail:
          'HR owns the official leave record, but functional incharges should confirm whether coverage is safe before approval.',
      },
      {
        title: 'Keep HR role narrow and powerful',
        detail:
          'HR should be able to see staff files, attendance, leave, payroll inputs, and rosters, but not clinical notes or appointment queues unless a separate role grants it.',
      },
      {
        title: 'Add dedicated leadership roles when access needs diverge',
        detail:
          'ADMIN can represent CEO / COO for now, but HR_MANAGER, OPERATIONS_INCHARGE, MAINTENANCE_INCHARGE, CEO, and COO should become dedicated roles if you need different permissions.',
      },
    ],
    role_counts: roleCounts,
    staff_by_role: staffByRole,
  };
}

export async function getOrganizationHierarchy({ tenantId = null } = {}) {
  let roleCounts = {};
  let staffByRole = {};

  if (tenantId) {
    const roles = uniqueRoleCodes();
    const rows = await prisma.users.groupBy({
      by: ['role'],
      where: {
        tenant_id: tenantId,
        is_active: true,
        role: { in: roles },
      },
      _count: { _all: true },
    });
    roleCounts = normalizeRoleCounts(rows);

    const staffRows = await prisma.$queryRawUnsafe(
      `SELECT
         u.uid,
         u.name,
         u.role,
         u.is_active AS user_is_active,
         s.employee_id,
         s.department,
         s.position,
         s.designation,
         s.is_active AS staff_is_active,
         CASE
           WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 'checked_in'
           WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NOT NULL THEN 'checked_out'
           ELSE 'registered'
         END AS current_status
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
       WHERE u.tenant_id = $1::uuid
         AND u.role = ANY($2::text[])
       ORDER BY u.role ASC, s.department ASC NULLS LAST, u.name ASC`,
      tenantId,
      roles,
    );
    staffByRole = normalizeStaffMembers(staffRows);
  }

  return buildOrganizationHierarchy({
    roleCounts,
    staffByRole,
    tenantScoped: Boolean(tenantId),
  });
}
