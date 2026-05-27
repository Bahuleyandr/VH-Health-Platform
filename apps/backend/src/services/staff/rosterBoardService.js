import prisma from '../../lib/prisma.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const ROSTER_DEPARTMENTS = {
  housekeeping: {
    department: 'housekeeping',
    label: 'Housekeeping',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF', 'HOUSEKEEPING_INCHARGE'],
    staffRoles: ['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE'],
    targetType: 'housekeeping_zone',
    async getTargets() {
      return prisma.$queryRawUnsafe(`
        SELECT id, name AS label, zone_type, floor, building
          FROM housekeeping_zones
         WHERE is_active = true
         ORDER BY COALESCE(floor, ''), name
      `);
    }
  },
  nursing: {
    department: 'nursing',
    label: 'Nursing',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF', 'CNO', 'NURSING_STAFF'],
    staffRoles: ['NURSING_STAFF'],
    targetType: 'ward'
  },
  reception: {
    department: 'reception',
    label: 'Reception',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF'],
    staffRoles: ['RECEPTIONIST', 'ADMISSION_OFFICER', 'GENERAL_STAFF'],
    targetType: 'desk'
  },
  pharmacy: {
    department: 'pharmacy',
    label: 'Pharmacy',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF', 'PHARMACY_STAFF'],
    staffRoles: ['PHARMACY_STAFF'],
    targetType: 'pharmacy_counter'
  },
  ambulance: {
    department: 'ambulance',
    label: 'Ambulance',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF'],
    staffRoles: ['DELIVERY_STAFF', 'EMERGENCY_RESPONDER', 'GENERAL_STAFF'],
    targetType: 'ambulance_zone'
  }
};

function normalizeDepartment(department) {
  return String(department || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function getDepartmentConfig(department) {
  const key = normalizeDepartment(department);
  return ROSTER_DEPARTMENTS[key] || null;
}

export function canManageRosterDepartment(user, department) {
  const config = getDepartmentConfig(department);
  if (!config) return false;
  const role = String(user?.rawRole || user?.role || '').toUpperCase();
  return config.managerRoles.includes(role);
}

function assertRosterDate(date) {
  const value = String(date || '').trim();
  if (!ISO_DATE.test(value)) {
    throw Object.assign(new Error('roster_date must be YYYY-MM-DD'), { statusCode: 400 });
  }
  return value;
}

function normalizeShiftLabel(value) {
  const label = String(value || '').trim();
  if (!label) throw Object.assign(new Error('shift_label is required'), { statusCode: 400 });
  return label.slice(0, 80);
}

function toTimeText(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'string') return value.slice(0, 8);
  if (value instanceof Date) return value.toISOString().slice(11, 19);
  return String(value).slice(0, 8);
}

function normalizeSnapshot(value) {
  if (value == null) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

async function resolveActor(user) {
  if (!user?.uid) return { id: Number(user?.id) || null, uid: null };
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid FROM users WHERE uid = $1::uuid LIMIT 1`,
    user.uid
  );
  return rows[0] || { id: Number(user?.id) || null, uid: user.uid };
}

async function getShiftByInput({ shiftId, shiftLabel }) {
  if (shiftId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, name, start_time::text AS start_time, end_time::text AS end_time
         FROM staff_shifts
        WHERE id = $1::int AND COALESCE(is_active, true) = true
        LIMIT 1`,
      shiftId
    );
    if (!rows.length) {
      throw Object.assign(new Error('Shift not found'), { statusCode: 404 });
    }
    return rows[0];
  }

  const label = normalizeShiftLabel(shiftLabel);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, name, start_time::text AS start_time, end_time::text AS end_time
       FROM staff_shifts
      WHERE LOWER(name) = LOWER($1)
        AND COALESCE(is_active, true) = true
      ORDER BY is_preset DESC, id ASC
      LIMIT 1`,
    label
  );
  return rows[0] || {
    id: null,
    name: label,
    start_time: '08:00:00',
    end_time: '16:00:00'
  };
}

async function getStaffPool(config) {
  return prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.role,
            s.employee_id, s.department, s.position, s.designation
       FROM users u
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE u.is_active = true
        AND u.role = ANY($1::text[])
      ORDER BY u.role, u.name`,
    config.staffRoles
  );
}

async function getTargets(config) {
  if (typeof config.getTargets === 'function') return config.getTargets();
  return [];
}

async function getActiveShifts(department) {
  return prisma.$queryRawUnsafe(
    `SELECT id, name, start_time::text AS start_time, end_time::text AS end_time,
            department, is_preset
       FROM staff_shifts
      WHERE COALESCE(is_active, true) = true
        AND (department IS NULL OR LOWER(department) = LOWER($1))
      ORDER BY is_preset DESC, start_time ASC, name ASC`,
    department
  );
}

async function getBoardsWithAssignments(department, rosterDate) {
  const boards = await prisma.$queryRawUnsafe(
    `SELECT id, department, roster_date::text AS roster_date, shift_id,
            shift_label, shift_start::text AS shift_start, shift_end::text AS shift_end,
            status, notes, created_by, created_by_uid, published_by,
            published_by_uid, published_at, created_at, updated_at
       FROM staff_shift_roster_boards
      WHERE department = $1
        AND roster_date = $2::date
      ORDER BY shift_start ASC, shift_label ASC`,
    department,
    rosterDate
  );

  if (!boards.length) return [];
  const ids = boards.map(row => row.id);
  const assignments = await prisma.$queryRawUnsafe(
    `SELECT a.*, u.name AS staff_name, s.employee_id
       FROM staff_shift_roster_assignments a
       LEFT JOIN users u ON u.id = a.staff_id
       LEFT JOIN staff s ON s.user_id = u.uid
      WHERE a.roster_id = ANY($1::int[])
      ORDER BY a.assignment_target_label, u.name`,
    ids
  );
  const byRoster = new Map();
  for (const row of assignments) {
    const bucket = byRoster.get(row.roster_id) || [];
    bucket.push(row);
    byRoster.set(row.roster_id, bucket);
  }
  return boards.map(board => ({
    ...board,
    assignments: byRoster.get(board.id) || []
  }));
}

function summarizeCoverage({ boards, targets, config }) {
  return boards.map(board => {
    const assignedTargetIds = new Set(
      (board.assignments || [])
        .filter(row => row.assignment_target_type === config.targetType)
        .map(row => Number(row.assignment_target_id))
        .filter(Boolean)
    );
    const gaps = targets
      .filter(target => !assignedTargetIds.has(Number(target.id)))
      .map(target => ({
        target_type: config.targetType,
        target_id: target.id,
        target_label: target.label,
        floor: target.floor || null,
        building: target.building || null
      }));
    return {
      roster_id: board.id,
      shift_label: board.shift_label,
      assigned_count: board.assignments?.length || 0,
      coverage_gap_count: gaps.length,
      gaps
    };
  });
}

export async function getRosterSnapshot({ department, rosterDate }) {
  const config = getDepartmentConfig(department);
  if (!config) {
    throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
  }
  const date = assertRosterDate(rosterDate);
  const [shifts, staff, targets, boards] = await Promise.all([
    getActiveShifts(config.department),
    getStaffPool(config),
    getTargets(config),
    getBoardsWithAssignments(config.department, date)
  ]);

  return {
    department: config.department,
    department_label: config.label,
    roster_date: date,
    target_type: config.targetType,
    shifts,
    staff,
    targets,
    boards,
    coverage: summarizeCoverage({ boards, targets, config })
  };
}

export async function getRosterBoardDepartment(rosterId) {
  const id = Number.parseInt(String(rosterId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT department FROM staff_shift_roster_boards WHERE id = $1::int LIMIT 1`,
    id
  );
  return rows[0]?.department || null;
}

async function resolveRosterStaff(config, staffId) {
  const id = Number.parseInt(String(staffId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('assignment staff_id must be valid'), { statusCode: 400 });
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.role
       FROM users u
      WHERE u.id = $1::int
        AND u.is_active = true
        AND u.role = ANY($2::text[])
      LIMIT 1`,
    id,
    config.staffRoles
  );
  if (!rows.length) {
    throw Object.assign(new Error('Roster staff member not found or not eligible'), {
      statusCode: 404
    });
  }
  return rows[0];
}

async function resolveTarget(config, assignment) {
  const targetType = assignment.assignment_target_type || assignment.target_type || config.targetType;
  if (targetType !== config.targetType) {
    throw Object.assign(new Error(`Unsupported target type for ${config.label}`), {
      statusCode: 400
    });
  }

  const targetId = Number.parseInt(
    String(assignment.assignment_target_id ?? assignment.target_id ?? ''),
    10
  );
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw Object.assign(new Error('assignment target_id must be valid'), { statusCode: 400 });
  }

  if (config.department === 'housekeeping') {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, name AS label, floor, building
         FROM housekeeping_zones
        WHERE id = $1::int
          AND is_active = true
        LIMIT 1`,
      targetId
    );
    if (!rows.length) {
      throw Object.assign(new Error('Housekeeping zone not found or inactive'), {
        statusCode: 404
      });
    }
    return { ...rows[0], target_type: targetType };
  }

  return {
    id: targetId,
    label: assignment.assignment_target_label || assignment.target_label || null,
    floor: assignment.floor || null,
    building: assignment.building || null,
    target_type: targetType
  };
}

async function auditRoster(tx, { rosterId, actor, action, reason, before, after }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO staff_shift_roster_assignment_audit
       (roster_id, actor_id, actor_uid, action, reason, before_snapshot, after_snapshot)
     VALUES ($1::int,$2::int,$3::uuid,$4,$5,$6::jsonb,$7::jsonb)`,
    rosterId,
    actor.id || null,
    actor.uid || null,
    action,
    reason || null,
    JSON.stringify(normalizeSnapshot(before)),
    JSON.stringify(normalizeSnapshot(after))
  );
}

export async function saveRosterBoard({
  department,
  rosterDate,
  shiftId,
  shiftLabel,
  notes,
  assignments,
  actorUser,
  reason
}) {
  const config = getDepartmentConfig(department);
  if (!config) {
    throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
  }
  const date = assertRosterDate(rosterDate);
  const shift = await getShiftByInput({ shiftId, shiftLabel });
  const label = normalizeShiftLabel(shiftLabel || shift.name);
  const actor = await resolveActor(actorUser);
  const assignmentInput = Array.isArray(assignments) ? assignments : [];

  const normalizedAssignments = [];
  const seenStaff = new Set();
  for (const assignment of assignmentInput) {
    const staff = await resolveRosterStaff(config, assignment.staff_id);
    if (seenStaff.has(staff.id)) {
      throw Object.assign(new Error('Each staff member can be assigned once per shift board'), {
        statusCode: 409
      });
    }
    seenStaff.add(staff.id);
    const target = await resolveTarget(config, assignment);
    normalizedAssignments.push({
      staff,
      target,
      is_lead: Boolean(assignment.is_lead),
      notes: assignment.notes || null
    });
  }

  return prisma.$transaction(async tx => {
    const beforeRows = await tx.$queryRawUnsafe(
      `SELECT b.*,
              COALESCE(
                jsonb_agg(to_jsonb(a) ORDER BY a.id) FILTER (WHERE a.id IS NOT NULL),
                '[]'::jsonb
              ) AS assignments
         FROM staff_shift_roster_boards b
         LEFT JOIN staff_shift_roster_assignments a ON a.roster_id = b.id
        WHERE b.department = $1
          AND b.roster_date = $2::date
          AND b.shift_label = $3
        GROUP BY b.id`,
      config.department,
      date,
      label
    );

    const boardRows = await tx.$queryRawUnsafe(
      `INSERT INTO staff_shift_roster_boards
         (department, roster_date, shift_id, shift_label, shift_start, shift_end,
          status, notes, created_by, created_by_uid, updated_at)
       VALUES ($1,$2::date,$3::int,$4,$5::time,$6::time,'draft',$7,$8::int,$9::uuid,NOW())
       ON CONFLICT (department, roster_date, shift_label)
       DO UPDATE SET
         shift_id = EXCLUDED.shift_id,
         shift_start = EXCLUDED.shift_start,
         shift_end = EXCLUDED.shift_end,
         status = 'draft',
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING id, department, roster_date::text AS roster_date, shift_id,
                 shift_label, shift_start::text AS shift_start, shift_end::text AS shift_end,
                 status, notes, created_by, created_by_uid, published_at, created_at, updated_at`,
      config.department,
      date,
      shift.id,
      label,
      toTimeText(shift.start_time, '08:00:00'),
      toTimeText(shift.end_time, '16:00:00'),
      notes || null,
      actor.id || null,
      actor.uid || null
    );
    const board = boardRows[0];

    await tx.$executeRawUnsafe(
      `DELETE FROM staff_shift_roster_assignments WHERE roster_id = $1::int`,
      board.id
    );

    const insertedAssignments = [];
    for (const item of normalizedAssignments) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO staff_shift_roster_assignments
           (roster_id, staff_id, staff_uid, staff_role, assignment_target_type,
            assignment_target_id, assignment_target_label, floor, building,
            is_lead, status, notes)
         VALUES ($1::int,$2::int,$3::uuid,$4,$5,$6::int,$7,$8,$9,$10::boolean,'planned',$11)
         RETURNING *`,
        board.id,
        item.staff.id,
        item.staff.uid,
        item.staff.role,
        item.target.target_type,
        item.target.id,
        item.target.label,
        item.target.floor || null,
        item.target.building || null,
        item.is_lead,
        item.notes
      );
      insertedAssignments.push(rows[0]);
    }

    const after = { ...board, assignments: insertedAssignments };
    await auditRoster(tx, {
      rosterId: board.id,
      actor,
      action: beforeRows.length ? 'updated' : 'created',
      reason,
      before: beforeRows[0] || {},
      after
    });

    return after;
  });
}

export async function publishRosterBoard({ rosterId, actorUser, reason }) {
  const id = Number.parseInt(String(rosterId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('roster id must be valid'), { statusCode: 400 });
  }
  const actor = await resolveActor(actorUser);

  return prisma.$transaction(async tx => {
    const boards = await tx.$queryRawUnsafe(
      `SELECT id, department, roster_date::text AS roster_date, shift_label,
              shift_start::text AS shift_start, shift_end::text AS shift_end,
              status, notes
         FROM staff_shift_roster_boards
        WHERE id = $1::int
        LIMIT 1`,
      id
    );
    const board = boards[0];
    if (!board) {
      throw Object.assign(new Error('Roster board not found'), { statusCode: 404 });
    }

    const assignments = await tx.$queryRawUnsafe(
      `SELECT * FROM staff_shift_roster_assignments
        WHERE roster_id = $1::int
          AND status <> 'cancelled'
        ORDER BY id`,
      id
    );
    if (!assignments.length) {
      throw Object.assign(new Error('Cannot publish roster without assignments'), {
        statusCode: 409
      });
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE staff_shift_roster_boards
          SET status = 'published',
              published_by = $2::int,
              published_by_uid = $3::uuid,
              published_at = NOW(),
              updated_at = NOW()
        WHERE id = $1::int
        RETURNING id, department, roster_date::text AS roster_date, shift_id,
                  shift_label, shift_start::text AS shift_start, shift_end::text AS shift_end,
                  status, notes, published_by, published_by_uid, published_at`,
      id,
      actor.id || null,
      actor.uid || null
    );

    await tx.$executeRawUnsafe(
      `UPDATE staff_shift_roster_assignments
          SET status = 'published', updated_at = NOW()
        WHERE roster_id = $1::int
          AND status = 'planned'`,
      id
    );

    let projectionCount = 0;
    if (board.department === 'housekeeping') {
      await tx.$executeRawUnsafe(
        `UPDATE housekeeping_floor_assignments
            SET status = 'superseded', updated_at = NOW()
          WHERE roster_board_id = $1::int
            AND assignment_kind = 'roster'
            AND status = 'active'`,
        id
      );

      const projectionRows = await tx.$queryRawUnsafe(
        `INSERT INTO housekeeping_floor_assignments
           (staff_id, staff_uid, zone_id, zone_name, floor, building, shift_label,
            assigned_by, assigned_by_uid, reason, is_temporary,
            effective_from, effective_to, status, roster_board_id,
            roster_assignment_id, assignment_kind)
         SELECT a.staff_id,
                a.staff_uid,
                a.assignment_target_id,
                a.assignment_target_label,
                a.floor,
                a.building,
                b.shift_label,
                $2::int,
                $3::uuid,
                COALESCE($4, 'Published shift roster'),
                false,
                (b.roster_date + b.shift_start)::timestamptz,
                CASE
                  WHEN b.shift_end <= b.shift_start
                    THEN (b.roster_date + b.shift_end + INTERVAL '1 day')::timestamptz
                  ELSE (b.roster_date + b.shift_end)::timestamptz
                END,
                'active',
                b.id,
                a.id,
                'roster'
           FROM staff_shift_roster_assignments a
           JOIN staff_shift_roster_boards b ON b.id = a.roster_id
          WHERE b.id = $1::int
            AND a.status = 'published'
            AND a.assignment_target_type = 'housekeeping_zone'
         RETURNING id`,
        id,
        actor.id || null,
        actor.uid || null,
        reason || null
      );
      projectionCount = projectionRows.length;
    }

    const after = { ...updatedRows[0], assignments, projection_count: projectionCount };
    await auditRoster(tx, {
      rosterId: id,
      actor,
      action: 'published',
      reason,
      before: board,
      after
    });

    return after;
  });
}

export async function copyPreviousRosterBoard({
  department,
  targetDate,
  shiftLabel,
  actorUser,
  reason
}) {
  const config = getDepartmentConfig(department);
  if (!config) {
    throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
  }
  const date = assertRosterDate(targetDate);
  const label = normalizeShiftLabel(shiftLabel);
  const sourceRows = await prisma.$queryRawUnsafe(
    `SELECT id, notes
       FROM staff_shift_roster_boards
      WHERE department = $1
        AND roster_date < $2::date
        AND shift_label = $3
      ORDER BY roster_date DESC, updated_at DESC
      LIMIT 1`,
    config.department,
    date,
    label
  );
  const source = sourceRows[0];
  if (!source) {
    throw Object.assign(new Error('No previous roster found for this shift'), {
      statusCode: 404
    });
  }

  const assignments = await prisma.$queryRawUnsafe(
    `SELECT staff_id,
            assignment_target_type,
            assignment_target_id,
            assignment_target_label,
            floor,
            building,
            is_lead,
            notes
       FROM staff_shift_roster_assignments
      WHERE roster_id = $1::int
        AND status <> 'cancelled'
      ORDER BY id`,
    source.id
  );

  return saveRosterBoard({
    department: config.department,
    rosterDate: date,
    shiftLabel: label,
    notes: source.notes,
    assignments: assignments.map(row => ({
      staff_id: row.staff_id,
      assignment_target_type: row.assignment_target_type,
      assignment_target_id: row.assignment_target_id,
      assignment_target_label: row.assignment_target_label,
      floor: row.floor,
      building: row.building,
      is_lead: row.is_lead,
      notes: row.notes
    })),
    actorUser,
    reason: reason || `Copied from roster board #${source.id}`
  });
}
