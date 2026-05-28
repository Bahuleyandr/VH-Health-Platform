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

function countForNode(node, roleCounts) {
  return (node.role_codes || []).reduce((total, role) => total + (roleCounts[role] || 0), 0);
}

export function buildOrganizationHierarchy({ roleCounts = {}, tenantScoped = false } = {}) {
  const nodes = ORGANIZATION_HIERARCHY_NODES.map((node) => ({
    ...node,
    active_staff_count: countForNode(node, roleCounts),
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
  };
}

export async function getOrganizationHierarchy({ tenantId = null } = {}) {
  let roleCounts = {};

  if (tenantId) {
    const rows = await prisma.users.groupBy({
      by: ['role'],
      where: {
        tenant_id: tenantId,
        is_active: true,
        role: { in: uniqueRoleCodes() },
      },
      _count: { _all: true },
    });
    roleCounts = normalizeRoleCounts(rows);
  }

  return buildOrganizationHierarchy({
    roleCounts,
    tenantScoped: Boolean(tenantId),
  });
}
