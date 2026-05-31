import prisma from '../../lib/prisma.js';

export const ACTIVE_ADMISSION_STATUSES = ['admitted', 'transferred'];

export const FULL_INPATIENT_SCOPE_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'MEDICAL_SUPERINTENDENT',
  'CNO',
  'NURSING_INCHARGE',
  'ICU_INCHARGE',
  'IPD_COUNSELLOR',
  'ADMISSION_OFFICER',
  'RECEPTION_INCHARGE',
  'HOUSEKEEPING_INCHARGE',
]);

const OWN_PATIENT_DOCTOR_ROLES = new Set([
  'DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'RESIDENT',
]);

const ROSTER_INPATIENT_SCOPE_BY_ROLE = {
  DUTY_DOCTOR: {
    department: 'medical',
    type: 'duty_doctor',
    fallback: 'own_patients',
  },
  NURSING_STAFF: {
    department: 'nursing',
    type: 'ward_nursing',
    fallback: 'none',
  },
  ICU_NURSE: {
    department: 'nursing',
    type: 'ward_nursing',
    fallback: 'none',
  },
  OT_NURSE: {
    department: 'nursing',
    type: 'ward_nursing',
    fallback: 'none',
  },
  OP_STAFF_NURSE: {
    department: 'op_nursing',
    type: 'op_nursing',
    fallback: 'none',
  },
  HOUSEKEEPING_STAFF: {
    department: 'housekeeping',
    type: 'housekeeping',
    fallback: 'none',
  },
};

export const MINIMIZED_INPATIENT_PAYLOAD_ROLES = new Set([
  'HOUSEKEEPING_STAFF',
  'HOUSEKEEPING_INCHARGE',
]);

const DEFAULT_TIMEZONE = process.env.APP_TIMEZONE || process.env.TZ || 'Asia/Kolkata';

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function compact(value) {
  return String(value || '').trim();
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function impossibleAdmissionWhere() {
  return { id: -1 };
}

function ownDoctorWhere(uid) {
  if (!uid) return impossibleAdmissionWhere();
  return {
    OR: [
      { admitting_doctor: uid },
      { attending_doctor: uid },
    ],
  };
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function parseFloor(value) {
  const text = compact(value).toLowerCase();
  if (!text) return null;
  if (/\ball\b/.test(text) || /\bwhole\b/.test(text) || /\bevery\b/.test(text)) return 'all';
  if (text === 'g' || text === 'ground' || text === 'ground floor') return 0;

  const wordFloors = new Map([
    ['first', 1],
    ['second', 2],
    ['third', 3],
    ['fourth', 4],
    ['fifth', 5],
    ['sixth', 6],
    ['seventh', 7],
    ['eighth', 8],
    ['ninth', 9],
    ['tenth', 10],
  ]);
  for (const [word, floor] of wordFloors.entries()) {
    if (text.includes(word)) return floor;
  }

  const numeric = text.match(/\d+/);
  if (!numeric) return null;
  return Number.parseInt(numeric[0], 10);
}

function collectCoverageInputs(assignments) {
  const wardIds = [];
  const labels = [];
  const floors = [];
  let allFloors = false;

  for (const assignment of assignments) {
    const targetType = compact(assignment.assignment_target_type).toLowerCase();
    const targetId = parsePositiveInt(assignment.assignment_target_id);
    const targetLabel = compact(assignment.assignment_target_label);
    const floor = parseFloor(assignment.floor);

    if (targetType === 'ward' || targetType === 'inpatient_ward') {
      if (targetId) wardIds.push(targetId);
      if (targetLabel) labels.push(targetLabel);
    } else if ([
      'clinical_unit',
      'medical_unit',
      'ipd_unit',
      'housekeeping_zone',
    ].includes(targetType)) {
      if (targetLabel) labels.push(targetLabel);
    }

    if (floor === 'all') {
      allFloors = true;
    } else if (Number.isInteger(floor)) {
      floors.push(floor);
    }
  }

  return {
    allFloors,
    wardIds: unique(wardIds),
    labelKeys: unique(labels.map((label) => label.toLowerCase())),
    floors: unique(floors),
  };
}

async function findCurrentRosterAssignments({ actor, department, now, timezone }) {
  const uid = actor?.uid ? String(actor.uid) : null;
  const staffId = parsePositiveInt(actor?.id);
  const departmentKey = compact(department).toLowerCase();
  if ((!uid && !staffId) || !departmentKey) return [];

  return prisma.$queryRawUnsafe(
    `WITH ctx AS (
       SELECT $3::timestamptz AS ts,
              ($3::timestamptz AT TIME ZONE $4)::date AS local_date,
              ($3::timestamptz AT TIME ZONE $4)::time AS local_time
     )
     SELECT a.id AS assignment_id,
            a.roster_id,
            b.department,
            b.roster_date::text AS roster_date,
            b.shift_label,
            b.shift_start::text AS shift_start,
            b.shift_end::text AS shift_end,
            a.staff_id,
            a.staff_uid,
            a.staff_role,
            a.assignment_target_type,
            a.assignment_target_id,
            a.assignment_target_label,
            a.floor,
            a.building,
            a.is_lead
       FROM ctx
       JOIN staff_shift_roster_boards b
         ON b.department = $5
        AND b.status = 'published'
        AND b.roster_date IN (ctx.local_date, ctx.local_date - 1)
       JOIN staff_shift_roster_assignments a
         ON a.roster_id = b.id
        AND a.status = 'published'
      WHERE (
          ($1::uuid IS NOT NULL AND a.staff_uid = $1::uuid)
          OR ($2::int IS NOT NULL AND a.staff_id = $2::int)
        )
        AND (
          (
            b.shift_end > b.shift_start
            AND b.roster_date = ctx.local_date
            AND ctx.local_time >= b.shift_start
            AND ctx.local_time < b.shift_end
          )
          OR (
            b.shift_end <= b.shift_start
            AND (
              (b.roster_date = ctx.local_date AND ctx.local_time >= b.shift_start)
              OR (b.roster_date = ctx.local_date - 1 AND ctx.local_time < b.shift_end)
            )
          )
        )
      ORDER BY b.roster_date DESC, b.shift_start DESC, a.is_lead DESC, a.id ASC`,
    uid,
    staffId,
    normalizeDate(now).toISOString(),
    timezone || DEFAULT_TIMEZONE,
    departmentKey,
  );
}

async function resolveRosterCoverage(assignments, tenantId) {
  const coverage = collectCoverageInputs(assignments);
  if (coverage.allFloors) {
    return {
      allFloors: true,
      wardIds: [],
      wardNames: [],
      bedIds: [],
      floors: [],
    };
  }

  if (!coverage.wardIds.length && !coverage.labelKeys.length && !coverage.floors.length) {
    return {
      allFloors: false,
      wardIds: [],
      wardNames: [],
      bedIds: [],
      floors: [],
    };
  }

  const [wardRows, bedRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT w.id, w.name, w.floor
         FROM wards w
        WHERE (
            COALESCE(array_length($1::int[], 1), 0) > 0
            AND w.id = ANY($1::int[])
          )
          OR (
            COALESCE(array_length($2::text[], 1), 0) > 0
            AND LOWER(w.name) = ANY($2::text[])
          )
          OR (
            COALESCE(array_length($3::int[], 1), 0) > 0
            AND w.floor = ANY($3::int[])
          )
        ORDER BY w.name`,
      coverage.wardIds,
      coverage.labelKeys,
      coverage.floors,
    ),
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT b.id,
              COALESCE(b.ward_name, w.name) AS ward_name,
              COALESCE(b.floor, w.floor) AS floor,
              b.ward_id
         FROM beds b
         LEFT JOIN wards w ON w.id = b.ward_id
        WHERE ($4::uuid IS NULL OR b.tenant_id = $4::uuid)
          AND (
            (
              COALESCE(array_length($1::int[], 1), 0) > 0
              AND b.ward_id = ANY($1::int[])
            )
            OR (
              COALESCE(array_length($2::text[], 1), 0) > 0
              AND LOWER(COALESCE(b.ward_name, w.name, '')) = ANY($2::text[])
            )
            OR (
              COALESCE(array_length($3::int[], 1), 0) > 0
              AND COALESCE(b.floor, w.floor) = ANY($3::int[])
            )
          )
        ORDER BY COALESCE(b.ward_name, w.name), b.id`,
      coverage.wardIds,
      coverage.labelKeys,
      coverage.floors,
      tenantId || null,
    ),
  ]);

  return {
    allFloors: false,
    wardIds: unique([
      ...coverage.wardIds,
      ...wardRows.map((row) => row.id),
      ...bedRows.map((row) => row.ward_id),
    ]),
    wardNames: unique([
      ...wardRows.map((row) => row.name),
      ...bedRows.map((row) => row.ward_name),
    ]),
    bedIds: unique(bedRows.map((row) => row.id)),
    floors: coverage.floors,
  };
}

async function resolveOwnPatientCoverage({ actor, tenantId }) {
  if (!actor?.uid) {
    return {
      allFloors: false,
      wardIds: [],
      wardNames: [],
      bedIds: [],
      floors: [],
    };
  }

  const rows = await prisma.admissions.findMany({
    where: {
      ...(tenantId ? { tenant_id: tenantId } : {}),
      status: { in: ACTIVE_ADMISSION_STATUSES },
      OR: [
        { admitting_doctor: actor.uid },
        { attending_doctor: actor.uid },
      ],
    },
    select: {
      bed_id: true,
    },
  });

  const bedIds = unique(rows.map((row) => row.bed_id));
  if (!bedIds.length) {
    return {
      allFloors: false,
      wardIds: [],
      wardNames: [],
      bedIds: [],
      floors: [],
    };
  }

  return {
    allFloors: false,
    wardIds: [],
    wardNames: [],
    bedIds,
    floors: [],
  };
}

function coverageWhere(coverage) {
  if (coverage.allFloors) return {};

  const or = [];
  if (coverage.wardNames.length) {
    or.push({ ward: { in: coverage.wardNames } });
  }
  if (coverage.bedIds.length) {
    or.push({ bed_id: { in: coverage.bedIds } });
  }

  return or.length ? { OR: or } : impossibleAdmissionWhere();
}

function withTenant(where, tenantId) {
  if (!tenantId) return where;
  return Object.keys(where).length ? { tenant_id: tenantId, ...where } : { tenant_id: tenantId };
}

export function applyInpatientAdmissionScope(baseWhere, scopeWhere) {
  const base = baseWhere && Object.keys(baseWhere).length ? baseWhere : {};
  const scope = scopeWhere && Object.keys(scopeWhere).length ? scopeWhere : {};
  if (!Object.keys(scope).length) return base;
  if (!Object.keys(base).length) return scope;
  return { AND: [base, scope] };
}

export async function resolveInpatientAdmissionScope({
  actor = {},
  filters = {},
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const role = normalizeRole(actor.role);
  const tenantId = actor.tenantId || filters.tenantId || null;
  const forceMine = filters.mine === true || filters.mine === 'true' || filters.mine === '1';

  if (forceMine && actor.uid) {
    return {
      where: withTenant(ownDoctorWhere(actor.uid), tenantId),
      scope: { type: 'own_patients', source: 'mine_filter', tenant_id: tenantId },
    };
  }

  const rosterScope = ROSTER_INPATIENT_SCOPE_BY_ROLE[role];
  if (rosterScope) {
    const assignments = await findCurrentRosterAssignments({
      actor,
      department: rosterScope.department,
      now,
      timezone,
    });
    if (!assignments.length) {
      if (rosterScope.fallback === 'own_patients') {
        return {
          where: withTenant(ownDoctorWhere(actor.uid), tenantId),
          scope: {
            type: rosterScope.type,
            source: 'own_patient_fallback_no_current_roster',
            tenant_id: tenantId,
            assignment_count: 0,
          },
        };
      }
      return {
        where: withTenant(impossibleAdmissionWhere(), tenantId),
        scope: {
          type: rosterScope.type,
          source: 'no_current_roster_assignment',
          tenant_id: tenantId,
          assignment_count: 0,
        },
      };
    }

    const coverage = await resolveRosterCoverage(assignments, tenantId);
    return {
      where: withTenant(coverageWhere(coverage), tenantId),
      scope: {
        type: rosterScope.type,
        source: `current_published_${rosterScope.department}_roster`,
        tenant_id: tenantId,
        assignment_count: assignments.length,
        all_floors: coverage.allFloors,
        floors: coverage.floors,
        wards: coverage.wardNames,
      },
    };
  }

  if (OWN_PATIENT_DOCTOR_ROLES.has(role) && actor.uid && !FULL_INPATIENT_SCOPE_ROLES.has(role)) {
    return {
      where: withTenant(ownDoctorWhere(actor.uid), tenantId),
      scope: { type: 'own_patients', source: 'doctor_assignment', tenant_id: tenantId },
    };
  }

  return {
    where: tenantId ? { tenant_id: tenantId } : {},
    scope: {
      type: FULL_INPATIENT_SCOPE_ROLES.has(role) ? 'full' : 'role_default',
      source: FULL_INPATIENT_SCOPE_ROLES.has(role) ? 'governance_role' : 'default_role_scope',
      tenant_id: tenantId,
    },
  };
}

export async function resolveInpatientLocationScope({
  actor = {},
  filters = {},
  now = new Date(),
  timezone = DEFAULT_TIMEZONE,
} = {}) {
  const role = normalizeRole(actor.role);
  const tenantId = actor.tenantId || filters.tenantId || null;
  const rosterScope = ROSTER_INPATIENT_SCOPE_BY_ROLE[role];

  if (rosterScope) {
    const assignments = await findCurrentRosterAssignments({
      actor,
      department: rosterScope.department,
      now,
      timezone,
    });

    if (!assignments.length) {
      if (rosterScope.fallback === 'own_patients') {
        const coverage = await resolveOwnPatientCoverage({ actor, tenantId });
        return {
          allLocations: false,
          ...coverage,
          scope: {
            type: rosterScope.type,
            source: 'own_patient_fallback_no_current_roster',
            tenant_id: tenantId,
            assignment_count: 0,
          },
        };
      }

      return {
        allLocations: false,
        allFloors: false,
        wardIds: [],
        wardNames: [],
        bedIds: [],
        floors: [],
        scope: {
          type: rosterScope.type,
          source: 'no_current_roster_assignment',
          tenant_id: tenantId,
          assignment_count: 0,
        },
      };
    }

    const coverage = await resolveRosterCoverage(assignments, tenantId);
    return {
      allLocations: coverage.allFloors,
      ...coverage,
      scope: {
        type: rosterScope.type,
        source: `current_published_${rosterScope.department}_roster`,
        tenant_id: tenantId,
        assignment_count: assignments.length,
        all_floors: coverage.allFloors,
        floors: coverage.floors,
        wards: coverage.wardNames,
      },
    };
  }

  if (OWN_PATIENT_DOCTOR_ROLES.has(role) && actor.uid && !FULL_INPATIENT_SCOPE_ROLES.has(role)) {
    const coverage = await resolveOwnPatientCoverage({ actor, tenantId });
    return {
      allLocations: false,
      ...coverage,
      scope: { type: 'own_patients', source: 'doctor_assignment', tenant_id: tenantId },
    };
  }

  return {
    allLocations: true,
    allFloors: true,
    wardIds: [],
    wardNames: [],
    bedIds: [],
    floors: [],
    scope: {
      type: FULL_INPATIENT_SCOPE_ROLES.has(role) ? 'full' : 'role_default',
      source: FULL_INPATIENT_SCOPE_ROLES.has(role) ? 'governance_role' : 'default_role_scope',
      tenant_id: tenantId,
    },
  };
}

export const __testing__ = {
  collectCoverageInputs,
  parseFloor,
};
