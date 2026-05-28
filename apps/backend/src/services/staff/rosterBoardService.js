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
    managerRoles: [
      'ADMIN',
      'SUPER_ADMIN',
      'HR_STAFF',
      'NURSING_INCHARGE',
      'DUTY_DOCTOR',
      'MEDICAL_SUPERINTENDENT',
      'CNO'
    ],
    staffRoles: ['NURSING_STAFF', 'NURSING_INCHARGE', 'ICU_NURSE', 'OT_NURSE'],
    targetType: 'ward',
    getTargets: getWardTargets
  },
  op_nursing: {
    department: 'op_nursing',
    label: 'OP Staff Nursing',
    managerRoles: [
      'ADMIN',
      'SUPER_ADMIN',
      'HR_STAFF',
      'OP_INCHARGE',
      'NURSING_INCHARGE',
      'MEDICAL_SUPERINTENDENT',
      'CNO'
    ],
    staffRoles: ['OP_STAFF_NURSE', 'NURSING_STAFF', 'OP_INCHARGE'],
    targetType: 'op_area',
    getTargets() {
      return getDepartmentTargets({
        matchTerms: ['op', 'opd', 'outpatient', 'out patient'],
        fallback: [
          { id: 1, label: 'OPD Registration', floor: 'Ground', building: 'Main' },
          { id: 2, label: 'OPD Triage', floor: 'Ground', building: 'Main' },
          { id: 3, label: 'Procedure Room', floor: 'Ground', building: 'Main' }
        ]
      });
    }
  },
  reception: {
    department: 'reception',
    label: 'Reception',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF', 'RECEPTION_INCHARGE'],
    staffRoles: ['RECEPTIONIST', 'RECEPTION_INCHARGE', 'ADMISSION_OFFICER'],
    targetType: 'reception_desk',
    getTargets() {
      return getDepartmentTargets({
        matchTerms: ['reception', 'front desk', 'admission'],
        fallback: [
          { id: 1, label: 'Front Desk', floor: 'Ground', building: 'Main' },
          { id: 2, label: 'Admission Desk', floor: 'Ground', building: 'Main' },
          { id: 3, label: 'Billing Helpdesk', floor: 'Ground', building: 'Main' }
        ]
      });
    }
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
    label: 'Ambulance / Drivers',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF'],
    staffRoles: [
      'DRIVER',
      'AMBULANCE_DRIVER',
      'DELIVERY_STAFF',
      'EMERGENCY_RESPONDER',
      'AMBULANCE_COORDINATOR'
    ],
    targetType: 'ambulance_unit',
    getTargets() {
      return getAmbulanceTargets();
    }
  },
  drivers: {
    department: 'ambulance',
    label: 'Ambulance / Drivers',
    managerRoles: ['ADMIN', 'SUPER_ADMIN', 'HR_STAFF'],
    staffRoles: [
      'DRIVER',
      'AMBULANCE_DRIVER',
      'DELIVERY_STAFF',
      'EMERGENCY_RESPONDER',
      'AMBULANCE_COORDINATOR'
    ],
    targetType: 'ambulance_unit',
    getTargets() {
      return getAmbulanceTargets();
    }
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

async function getWardTargets() {
  return prisma.$queryRawUnsafe(`
    SELECT id,
           name AS label,
           floor::text AS floor,
           NULL::text AS building,
           total_beds
      FROM wards
     ORDER BY COALESCE(floor, 999), name
  `);
}

async function getDepartmentTargets({ matchTerms = [], fallback = [] } = {}) {
  const pattern = matchTerms.length
    ? matchTerms.map(term => `%${String(term).toLowerCase()}%`)
    : ['%'];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, name AS label, floor, building, code
       FROM departments
      WHERE COALESCE(is_active, true) = true
        AND EXISTS (
          SELECT 1
            FROM unnest($1::text[]) AS term(pattern)
           WHERE LOWER(name) LIKE term.pattern
              OR LOWER(COALESCE(code, '')) LIKE term.pattern
        )
      ORDER BY COALESCE(floor, ''), name`,
    pattern
  );
  if (rows.length) return rows;
  return fallback.map(row => ({ ...row, synthetic: true }));
}

async function getAmbulanceTargets() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT row_number() OVER (ORDER BY ambulance_unit_id)::int AS id,
           ambulance_unit_id AS label,
           'Ambulance bay'::text AS floor,
           'Transport'::text AS building
      FROM (
        SELECT DISTINCT ambulance_unit_id
          FROM ambulance_requests
         WHERE ambulance_unit_id IS NOT NULL
           AND TRIM(ambulance_unit_id) <> ''
         LIMIT 20
      ) units
     ORDER BY ambulance_unit_id
  `);
  if (rows.length) return rows;
  return [
    { id: 1, label: 'Ambulance Bay', floor: 'Ground', building: 'Transport', synthetic: true },
    { id: 2, label: 'Transfer Duty', floor: 'Ground', building: 'Transport', synthetic: true },
    { id: 3, label: 'On-call Driver', floor: 'Ground', building: 'Transport', synthetic: true }
  ];
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

async function getRosterRequestsForSnapshot(config, rosterDate) {
  return prisma.$queryRawUnsafe(
    `SELECT r.*,
            u.name AS staff_name,
            u.role AS staff_role,
            reviewer.name AS reviewed_by_name
       FROM staff_shift_roster_requests r
       LEFT JOIN users u ON u.id = r.staff_id
       LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
      WHERE r.department = $1
        AND r.requested_start_date <= $2::date
        AND r.requested_end_date >= $2::date
        AND r.status IN ('pending', 'approved')
      ORDER BY
        CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
        r.created_at DESC`,
    config.department,
    rosterDate
  );
}

async function getLeaveCoverageSignals(config, rosterDate) {
  return prisma.$queryRawUnsafe(
    `SELECT la.id AS leave_application_id,
            la.staff_id,
            u.uid AS staff_uid,
            u.name AS staff_name,
            u.role AS staff_role,
            la.leave_type,
            la.status AS leave_status,
            la.start_date::text AS start_date,
            la.end_date::text AS end_date,
            la.reason,
            rr.id AS replacement_request_id,
            rr.replacement_staff_id,
            ru.name AS replacement_staff_name,
            rr.status AS replacement_status,
            rr.hr_approved_at
       FROM leave_applications la
       JOIN users u ON u.id = la.staff_id
       LEFT JOIN replacement_requests rr
              ON rr.leave_request_id = la.id
             AND rr.status IN ('pending', 'accepted', 'hr_approved')
       LEFT JOIN users ru ON ru.id = rr.replacement_staff_id
      WHERE la.start_date <= $1::date
        AND la.end_date >= $1::date
        AND la.status IN ('pending', 'approved')
        AND u.role = ANY($2::text[])
      ORDER BY
        CASE la.status WHEN 'approved' THEN 0 ELSE 1 END,
        la.start_date ASC,
        u.name ASC`,
    rosterDate,
    config.staffRoles
  );
}

export async function getRosterSnapshot({ department, rosterDate }) {
  const config = getDepartmentConfig(department);
  if (!config) {
    throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
  }
  const date = assertRosterDate(rosterDate);
  const [shifts, staff, targets, boards, requests, leaveCoverage] = await Promise.all([
    getActiveShifts(config.department),
    getStaffPool(config),
    getTargets(config),
    getBoardsWithAssignments(config.department, date),
    getRosterRequestsForSnapshot(config, date),
    getLeaveCoverageSignals(config, date)
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
    requests,
    leave_coverage: leaveCoverage,
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

async function auditRosterRequest(tx, { requestId, actor, action, reason, before, after }) {
  await tx.$executeRawUnsafe(
    `INSERT INTO staff_shift_roster_request_audit
       (request_id, actor_id, actor_uid, action, reason, before_snapshot, after_snapshot)
     VALUES ($1::int,$2::int,$3::uuid,$4,$5,$6::jsonb,$7::jsonb)`,
    requestId,
    actor.id || null,
    actor.uid || null,
    action,
    reason || null,
    JSON.stringify(normalizeSnapshot(before)),
    JSON.stringify(normalizeSnapshot(after))
  );
}

function normalizeRequestStatus(status) {
  const value = String(status || 'pending').trim().toLowerCase();
  if (['pending', 'approved', 'rejected', 'cancelled', 'applied'].includes(value)) {
    return value;
  }
  throw Object.assign(new Error('Invalid roster request status'), { statusCode: 400 });
}

function normalizeRequestType(type) {
  const value = String(type || 'duty_preference').trim().toLowerCase();
  if (['duty_preference', 'avoid_duty', 'coverage_request'].includes(value)) {
    return value;
  }
  throw Object.assign(new Error('request_type must be duty_preference, avoid_duty, or coverage_request'), {
    statusCode: 400
  });
}

function normalizePeriodType(type) {
  const value = String(type || 'day').trim().toLowerCase();
  if (['day', 'week', 'month', 'custom'].includes(value)) return value;
  throw Object.assign(new Error('period_type must be day, week, month, or custom'), {
    statusCode: 400
  });
}

function normalizePriority(priority) {
  const value = String(priority || 'normal').trim().toLowerCase();
  if (['low', 'normal', 'high', 'urgent'].includes(value)) return value;
  throw Object.assign(new Error('priority must be low, normal, high, or urgent'), {
    statusCode: 400
  });
}

function assertDateWindow(startDate, endDate) {
  const start = assertRosterDate(startDate);
  const end = assertRosterDate(endDate || startDate);
  if (end < start) {
    throw Object.assign(new Error('requested_end_date cannot be before requested_start_date'), {
      statusCode: 400
    });
  }
  return { start, end };
}

async function resolveRosterRequester(config, actorUser, requestedStaffId = null) {
  const actor = await resolveActor(actorUser);
  const actorRole = String(actorUser?.rawRole || actorUser?.role || '').toUpperCase();
  const canManage = config.managerRoles.includes(actorRole);
  const staffId = Number.parseInt(String(requestedStaffId || actor.id || ''), 10);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    throw Object.assign(new Error('Unable to resolve staff member for roster request'), {
      statusCode: 401
    });
  }
  if (!canManage && staffId !== actor.id) {
    throw Object.assign(new Error('Staff can only submit their own duty request'), {
      statusCode: 403
    });
  }

  const roles = [...new Set([...config.staffRoles, ...config.managerRoles])];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, name, role
       FROM users
      WHERE id = $1::int
        AND is_active = true
        AND role = ANY($2::text[])
      LIMIT 1`,
    staffId,
    roles
  );
  if (!rows.length) {
    throw Object.assign(new Error('Staff member is not eligible for this roster department'), {
      statusCode: 404
    });
  }
  return { actor, staff: rows[0] };
}

async function buildRosterRequestTarget(config, request = {}) {
  const targetIdRaw = request.assignment_target_id ?? request.target_id;
  if (targetIdRaw == null || targetIdRaw === '') return {};
  return resolveTarget(config, {
    assignment_target_type: request.assignment_target_type || request.target_type || config.targetType,
    assignment_target_id: targetIdRaw,
    assignment_target_label: request.assignment_target_label || request.target_label,
    floor: request.floor,
    building: request.building
  });
}

export async function createRosterPreferenceRequest({
  department,
  staffId,
  requestedStartDate,
  requestedEndDate,
  periodType,
  requestType,
  shiftId,
  shiftLabel,
  assignmentTargetType,
  assignmentTargetId,
  assignmentTargetLabel,
  floor,
  building,
  priority,
  reason,
  actorUser,
  metadata
}) {
  const config = getDepartmentConfig(department);
  if (!config) {
    throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
  }
  const { start, end } = assertDateWindow(requestedStartDate, requestedEndDate);
  const type = normalizeRequestType(requestType);
  const period = normalizePeriodType(periodType);
  const requestPriority = normalizePriority(priority);
  const { actor, staff } = await resolveRosterRequester(config, actorUser, staffId);
  const target = await buildRosterRequestTarget(config, {
    assignment_target_type: assignmentTargetType,
    assignment_target_id: assignmentTargetId,
    assignment_target_label: assignmentTargetLabel,
    floor,
    building
  });

  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO staff_shift_roster_requests
         (request_type, staff_id, staff_uid, department, requested_start_date,
          requested_end_date, period_type, shift_id, shift_label,
          assignment_target_type, assignment_target_id, assignment_target_label,
          floor, building, priority, reason, metadata, updated_at)
       VALUES ($1,$2::int,$3::uuid,$4,$5::date,$6::date,$7,$8::int,$9,$10,$11::int,
               $12,$13,$14,$15,$16,$17::jsonb,NOW())
       RETURNING *`,
      type,
      staff.id,
      staff.uid || null,
      config.department,
      start,
      end,
      period,
      shiftId || null,
      shiftLabel ? normalizeShiftLabel(shiftLabel) : null,
      target.target_type || null,
      target.id || null,
      target.label || null,
      target.floor || null,
      target.building || null,
      requestPriority,
      reason || null,
      JSON.stringify(normalizeSnapshot(metadata))
    );
    const created = rows[0];
    await auditRosterRequest(tx, {
      requestId: created.id,
      actor,
      action: 'created',
      reason,
      before: {},
      after: created
    });
    return created;
  });
}

export async function listMyRosterPreferenceRequests({ actorUser, limit = 50 }) {
  const actor = await resolveActor(actorUser);
  if (!actor.id) return [];
  return prisma.$queryRawUnsafe(
    `SELECT r.*, u.name AS staff_name
       FROM staff_shift_roster_requests r
       LEFT JOIN users u ON u.id = r.staff_id
      WHERE r.staff_id = $1::int
      ORDER BY r.created_at DESC
      LIMIT $2::int`,
    actor.id,
    Math.min(Math.max(Number(limit) || 50, 1), 100)
  );
}

export async function listDepartmentRosterPreferenceRequests({
  department,
  rosterDate,
  status = null
}) {
  const config = getDepartmentConfig(department);
  if (!config) {
    throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
  }
  const date = assertRosterDate(rosterDate || new Date().toISOString().slice(0, 10));
  const cleanStatus = status ? normalizeRequestStatus(status) : null;
  return prisma.$queryRawUnsafe(
    `SELECT r.*,
            u.name AS staff_name,
            u.role AS staff_role,
            reviewer.name AS reviewed_by_name
       FROM staff_shift_roster_requests r
       LEFT JOIN users u ON u.id = r.staff_id
       LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
      WHERE r.department = $1
        AND r.requested_start_date <= $2::date
        AND r.requested_end_date >= $2::date
        AND ($3::text IS NULL OR r.status = $3)
      ORDER BY
        CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        r.created_at DESC`,
    config.department,
    date,
    cleanStatus
  );
}

export async function reviewRosterPreferenceRequest({
  requestId,
  decision,
  reviewNotes,
  actorUser,
  reason
}) {
  const id = Number.parseInt(String(requestId || ''), 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error('request id must be valid'), { statusCode: 400 });
  }
  const status = normalizeRequestStatus(decision);
  if (!['approved', 'rejected', 'cancelled', 'applied'].includes(status)) {
    throw Object.assign(new Error('decision must be approved, rejected, cancelled, or applied'), {
      statusCode: 400
    });
  }
  const actor = await resolveActor(actorUser);

  return prisma.$transaction(async tx => {
    const beforeRows = await tx.$queryRawUnsafe(
      `SELECT * FROM staff_shift_roster_requests WHERE id = $1::int LIMIT 1`,
      id
    );
    const before = beforeRows[0];
    if (!before) {
      throw Object.assign(new Error('Roster request not found'), { statusCode: 404 });
    }
    const config = getDepartmentConfig(before.department);
    if (!config) {
      throw Object.assign(new Error('Roster department is not configured'), { statusCode: 404 });
    }
    const actorRole = String(actorUser?.rawRole || actorUser?.role || '').toUpperCase();
    if (!config.managerRoles.includes(actorRole)) {
      throw Object.assign(new Error('You are not allowed to review this roster request'), {
        statusCode: 403
      });
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE staff_shift_roster_requests
          SET status = $2,
              reviewed_by = $3::int,
              reviewed_by_uid = $4::uuid,
              reviewed_at = NOW(),
              review_notes = $5,
              updated_at = NOW()
        WHERE id = $1::int
        RETURNING *`,
      id,
      status,
      actor.id || null,
      actor.uid || null,
      reviewNotes || reason || null
    );
    const after = rows[0];
    await auditRosterRequest(tx, {
      requestId: id,
      actor,
      action: status,
      reason: reason || reviewNotes,
      before,
      after
    });
    return after;
  });
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
