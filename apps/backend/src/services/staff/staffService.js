import { STAFF_ROLES, SHIFT_TYPES } from '../../config/staffConfig.js';
import { SECURITY_CONFIG } from '../../config/securityConfig.js';
import bcrypt from 'bcrypt';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import { getCurrentTenantId } from '../../lib/tenantContext.js';
import logger from '../../logging/logger.js';
import { buildPagination } from '../../utils/listQuery.js';
import { getStaffHierarchy } from '../../utils/staff/staffHelpers.js';
import { DEFAULT_ONBOARDING_TASKS } from './hr/constants.js';
import { withAuthIdentityLifecycleLocks } from '../../utils/tokenBlacklist.js';

const ONBOARDABLE_STAFF_ROLES = Object.values(STAFF_ROLES).filter(
  (role) => !['SUPER_ADMIN', 'ADMIN'].includes(role),
);

const SCIM_MANAGED_SOURCES = new Set(['scim', 'hybrid']);
const SCIM_OWNED_STAFF_FIELDS = ['department', 'position', 'is_active'];

function scimOverrideReason(data = {}) {
  return String(data.scimOverrideReason || data.identityOverrideReason || data.override_reason || '').trim();
}

function isScimManagedSource(source) {
  return SCIM_MANAGED_SOURCES.has(String(source || 'local').toLowerCase());
}

function auditIpAddress(value) {
  return String(value || '').split(',')[0].trim() || null;
}

export const getStaffList = async (filters, userRole) => {
  const allowedRoles = getStaffHierarchy(userRole);
  const { page, limit, role, department, shift, active, search, supervisor_id, skill } = filters;
  const offset = (page - 1) * limit;

  // Build a SINGLE WHERE clause used by both the paged SELECT and the
  // COUNT query. Placeholder numbering starts at $1 (allowedRoles) and
  // walks forward through any optional filters; the SELECT additionally
  // appends limit/offset placeholders at the END so the WHERE clause
  // stays portable. Earlier the WHERE referenced $1 then jumped to $4
  // (skipping limit/offset) and the COUNT query passed `params.slice(3)`,
  // which silently rebound $1 to whatever the first dynamic filter was —
  // 42809 "ANY/ALL requires array on right side" when it was a string,
  // or P1016 "Expected: N, actual: 1" when no filters were set. The
  // single-numbering scheme below avoids both bugs.
  let whereClause = 'WHERE u.role = ANY($1)';
  const whereParams = [allowedRoles];
  let paramIndex = 2;

  if (active !== undefined) {
    whereClause += ` AND (s.is_active = $${paramIndex} OR s.is_active IS NULL)`;
    whereParams.push(active);
    paramIndex++;
  }

  if (role) {
    whereClause += ` AND u.role = $${paramIndex}`;
    whereParams.push(role);
    paramIndex++;
  }

  if (department) {
    whereClause += ` AND s.department = $${paramIndex}`;
    whereParams.push(department);
    paramIndex++;
  }

  if (shift) {
    whereClause += ` AND s.shift = $${paramIndex}`;
    whereParams.push(shift);
    paramIndex++;
  }

  if (supervisor_id) {
    whereClause += ` AND s.supervisor_id = $${paramIndex}`;
    whereParams.push(supervisor_id);
    paramIndex++;
  }

  if (search) {
    whereClause += ` AND (LOWER(u.name) LIKE $${paramIndex} OR LOWER(s.employee_id) LIKE $${paramIndex} OR LOWER(s.position) LIKE $${paramIndex})`;
    whereParams.push(`%${search.toLowerCase()}%`);
    paramIndex++;
  }

  if (skill) {
    whereClause += ` AND s.skills::text ILIKE $${paramIndex}`;
    whereParams.push(`%${skill}%`);
    paramIndex++;
  }

  // Append limit + offset placeholders for the paged SELECT only —
  // the COUNT query doesn't need them.
  const limitParamIndex = paramIndex;
  const offsetParamIndex = paramIndex + 1;
  const selectParams = [...whereParams, parseInt(limit), parseInt(offset)];

  const query = `
    SELECT
      u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at, u.role,
      s.employee_id, s.position, s.department, s.shift, s.salary,
      s.hire_date, s.is_active, s.supervisor_id, s.emergency_contact,
      s.skills, s.certifications, s.performance_rating, s.notes,
      sup.name as supervisor_name,
      CASE
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 'checked_in'
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NOT NULL THEN 'checked_out'
        ELSE 'not_checked_in'
      END as current_status,
      s.last_check_in, s.last_check_out
    FROM users u
    LEFT JOIN staff s ON u.uid = s.user_id
    LEFT JOIN users sup ON s.supervisor_id = sup.id
    ${whereClause}
    ORDER BY
      CASE WHEN s.is_active = true THEN 0 ELSE 1 END,
      u.name ASC
    LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
  `;

  // `prisma.$queryRawUnsafe(sql, ...params)` takes spread args — passing
  // the array as a single argument binds the WHOLE array to $1 and the
  // remaining placeholders go unbound (P1016). See Phase 0.5 conventions.
  const result = await prisma.$queryRawUnsafe(query, ...selectParams);

  // Count query reuses the same WHERE clause but skips limit/offset.
  // Bind only the where-side params so $1..$N stay aligned.
  const countQuery = `
    SELECT COUNT(*)
    FROM users u
    LEFT JOIN staff s ON u.uid = s.user_id
    LEFT JOIN users sup ON s.supervisor_id = sup.id
    ${whereClause}
  `;
  const countResult = await prisma.$queryRawUnsafe(countQuery, ...whereParams);
  const totalStaff = parseInt(countResult[0].count);

  // Get statistics
  const departmentStats = await prisma.$queryRawUnsafe(`
    SELECT s.department, COUNT(*) as count
    FROM users u 
    LEFT JOIN staff s ON u.uid = s.user_id 
    WHERE u.role = ANY($1) AND (s.is_active = true OR s.is_active IS NULL)
    GROUP BY s.department
    ORDER BY count DESC
  `, allowedRoles);

  const roleStats = await prisma.$queryRawUnsafe(`
    SELECT u.role, COUNT(*) as count
    FROM users u 
    LEFT JOIN staff s ON u.uid = s.user_id 
    WHERE u.role = ANY($1) AND (s.is_active = true OR s.is_active IS NULL)
    GROUP BY u.role
    ORDER BY count DESC
  `, allowedRoles);

  // Format staff data
  const enhancedStaff = result.map(staff => ({
    ...staff,
    hire_date: staff.hire_date ? new Date(staff.hire_date).toLocaleDateString('en-IN') : null,
    registered_at: staff.registered_at ? new Date(staff.registered_at).toLocaleDateString('en-IN') : null,
    last_check_in: staff.last_check_in ? new Date(staff.last_check_in).toLocaleString('en-IN') : null,
    last_check_out: staff.last_check_out ? new Date(staff.last_check_out).toLocaleString('en-IN') : null,
    shift_details: SHIFT_TYPES[staff.shift] || null,
    can_edit: allowedRoles.includes('ADMIN') || allowedRoles.includes('HR_STAFF'),
    can_view_salary: allowedRoles.includes('ADMIN') || allowedRoles.includes('HR_STAFF')
  }));

  return {
    staff: enhancedStaff,
    pagination: buildPagination(totalStaff, page, limit),
    filters: { role, department, shift, active, search, supervisor_id, skill },
    statistics: {
      departments: departmentStats,
      roles: roleStats,
      totalActive: enhancedStaff.filter(s => s.is_active !== false).length,
      currentlyCheckedIn: enhancedStaff.filter(s => s.current_status === 'checked_in').length
    },
    accessLevel: userRole,
    viewableRoles: allowedRoles
  };
};

export const getStaffProfile = async (identifier, userRole, userId, includePrivate) => {
  const allowedRoles = getStaffHierarchy(userRole);

  // The identifier param accepts three shapes:
  //   1. UUID (users.uid)         e.g. "550e8400-e29b-41d4-a716-446655440000"
  //   2. Employee ID              e.g. "EMP-1001"  (staff.employee_id)
  //   3. Numeric users.id         e.g. "42"
  //
  // Previous implementation only handled (1) and (3) — passing an EMP-*
  // string crashed with `operator does not exist: integer = text`
  // because Postgres tried to compare integer `u.id` against text. The
  // staff app's Profile screen calls `/staff/:employeeId` on launch, so
  // every clinical role hit a 500 on the first navigation. Accept the
  // employee_id column too. Order matters: check UUID first (strict),
  // then EMP-* prefix, then fall back to integer cast for numeric input.
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const isEmployeeId = !isUUID && /^EMP[-_]?\w+$/i.test(identifier);
  const isNumeric = !isUUID && !isEmployeeId && /^\d+$/.test(identifier);
  let whereClause;
  if (isUUID) {
    whereClause = 'u.uid = $1::uuid';
  } else if (isEmployeeId) {
    whereClause = 's.employee_id = $1';
  } else if (isNumeric) {
    whereClause = 'u.id = $1::int';
  } else {
    // Unknown shape — return 404 rather than crashing the SQL parser.
    throw new Error('NOT_FOUND');
  }

  const result = await prisma.$queryRawUnsafe(`
    SELECT
      u.*,
      s.employee_id, s.position, s.department, s.shift, s.salary,
      s.hire_date, s.is_active, s.supervisor_id, s.emergency_contact,
      s.skills, s.certifications, s.notes, s.performance_rating,
      s.last_check_in, s.last_check_out, s.total_overtime_hours,
      s.sick_days_used, s.vacation_days_used, s.training_completed,
      sup.name as supervisor_name, sup.phone as supervisor_phone,
      sup.email as supervisor_email,
      CASE
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 'checked_in'
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NOT NULL THEN 'checked_out'
        ELSE 'not_checked_in'
      END as current_status
    FROM users u
    LEFT JOIN staff s ON u.uid = s.user_id
    LEFT JOIN users sup ON s.supervisor_id = sup.id
    WHERE ${whereClause} AND u.role = ANY($2)
  `, identifier, allowedRoles);

  if (result.length === 0) {
    throw new Error('NOT_FOUND');
  }

  const staff = result[0];

  // Privacy filtering
  const canViewPrivate = ['ADMIN', 'HR_STAFF'].includes(userRole) || 
                        userId === staff.uid ||
                        includePrivate && ['DOCTOR'].includes(userRole);

  if (!canViewPrivate) {
    delete staff.salary;
    delete staff.emergency_contact;
    delete staff.notes;
    delete staff.performance_rating;
    delete staff.sick_days_used;
    delete staff.vacation_days_used;
  }

  // Get recent attendance
  let recentAttendance = [];
  try {
    const attendanceResult = await prisma.$queryRawUnsafe(`
      SELECT 
        DATE(check_in_time) as date,
        check_in_time, check_out_time,
        EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600 as hours_worked,
        COALESCE(
          attendance_status,
          type,
          CASE
            WHEN check_in_time IS NOT NULL AND check_out_time IS NULL THEN 'checked_in'
            WHEN check_in_time IS NOT NULL AND check_out_time IS NOT NULL THEN 'checked_out'
            ELSE 'unknown'
          END
        ) as status,
        location
      FROM staff_attendance 
      WHERE staff_id = $1 
        AND check_in_time >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY check_in_time DESC
      LIMIT 7
    `, staff.id);
    
    recentAttendance = attendanceResult.map(record => ({
      ...record,
      date: record.date ? new Date(record.date).toLocaleDateString('en-IN') : null,
      check_in_time: record.check_in_time ? new Date(record.check_in_time).toLocaleString('en-IN') : null,
      check_out_time: record.check_out_time ? new Date(record.check_out_time).toLocaleString('en-IN') : null,
      hours_worked: record.hours_worked ? Math.round(record.hours_worked * 100) / 100 : null
    }));
  } catch (attendanceError) {
    logger.warn('Attendance data unavailable:', attendanceError.message);
  }

  // Get performance metrics if allowed
  let performanceMetrics = null;
  if (canViewPrivate) {
    try {
      const performanceResult = await prisma.$queryRawUnsafe(`
        SELECT 
          AVG(rating) as average_rating,
          COUNT(*) as total_reviews,
          MAX(review_date) as last_review_date
        FROM staff_performance_reviews 
        WHERE staff_id = $1
          AND review_date >= CURRENT_DATE - INTERVAL '1 year'
      `, staff.id);
      
      if (performanceResult[0].total_reviews > 0) {
        performanceMetrics = {
          ...performanceResult[0],
          average_rating: performanceResult[0].average_rating ? 
            Math.round(performanceResult[0].average_rating * 10) / 10 : null,
          last_review_date: performanceResult[0].last_review_date ? 
            new Date(performanceResult[0].last_review_date).toLocaleDateString('en-IN') : null
        };
      }
    } catch (performanceError) {
      logger.warn('Performance data unavailable:', performanceError.message);
    }
  }

  return {
    profile: {
      ...staff,
      hire_date: staff.hire_date ? new Date(staff.hire_date).toLocaleDateString('en-IN') : null,
      registered_at: staff.registered_at ? new Date(staff.registered_at).toLocaleDateString('en-IN') : null,
      last_check_in: staff.last_check_in ? new Date(staff.last_check_in).toLocaleString('en-IN') : null,
      last_check_out: staff.last_check_out ? new Date(staff.last_check_out).toLocaleString('en-IN') : null,
      shift_details: SHIFT_TYPES[staff.shift] || null
    },
    recentAttendance,
    performanceMetrics,
    accessLevel: {
      canViewPrivate,
      canEdit: ['ADMIN', 'HR_STAFF'].includes(userRole),
      canManageAttendance: ['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(userRole),
      isSelf: userId === staff.uid
    },
    searchedBy: isUUID ? 'uid' : 'id'
  };
};

function normalizeStaffPhone(phone) {
  return String(phone || '').replace(/[\s-]/g, '').trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '').trim(),
  );
}

async function nextEmployeeId() {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT employee_id
    FROM staff
    WHERE employee_id ~ '^EMP-[0-9]+$'
    ORDER BY (substring(employee_id FROM '[0-9]+'))::int DESC
    LIMIT 1
  `);
  const current = rows[0]?.employee_id;
  const currentNumber = Number(String(current || '').replace(/\D/g, '')) || 1000;
  return `EMP-${String(currentNumber + 1).padStart(4, '0')}`;
}

async function seedOnboardingTasks(userIntId, createdBy) {
  const due = new Date();
  due.setDate(due.getDate() + 30);

  await Promise.all(
    DEFAULT_ONBOARDING_TASKS.map((task) =>
      prisma.staff_onboarding_tasks.create({
        data: {
          staff_id: userIntId,
          task_name: task.task_name,
          description: task.description,
          completed: false,
          priority: task.priority,
          assigned_to: createdBy || null,
          due_date: due,
          updated_at: new Date(),
        },
      }),
    ),
  );
}

async function resolveOrCreateStaffUser(data) {
  const validStaffRoles = ONBOARDABLE_STAFF_ROLES;
  const rawUserId = data.user_id || data.user_uid;
  if (rawUserId) {
    const userRows = isUuid(rawUserId)
      ? await prisma.$queryRawUnsafe(
        'SELECT id, uid, role, name, phone, email FROM users WHERE uid = $1::uuid',
        String(rawUserId),
      )
      : await prisma.$queryRawUnsafe(
        'SELECT id, uid, role, name, phone, email FROM users WHERE id = $1::int',
        Number(rawUserId),
      );

    if (userRows.length === 0) throw new Error('USER_NOT_FOUND');
    const user = userRows[0];
    if (!validStaffRoles.includes(user.role)) throw new Error('INVALID_ROLE');
    return { user, createdUser: false };
  }

  const name = String(data.name || data.full_name || '').trim();
  const phone = normalizeStaffPhone(data.phone);
  const role = String(data.role || '').trim().toUpperCase();
  const password = String(data.temporary_password || data.password || '').trim();

  if (!name || !phone || !role || !password) {
    throw new Error('STAFF_ACCOUNT_FIELDS_REQUIRED');
  }
  if (!validStaffRoles.includes(role)) throw new Error('INVALID_ROLE');
  if (password.length < SECURITY_CONFIG.password.minLength) throw new Error('WEAK_PASSWORD');

  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, uid FROM users WHERE phone = $1 LIMIT 1',
    phone,
  );
  if (existing.length > 0) throw new Error('USER_PHONE_EXISTS');

  const passwordHash = await bcrypt.hash(password, 10);
// A bare `prisma.$transaction` hands back the raw itx client, which skips the
// prisma proxy's tenant wrapper — so `app.current_tenant_id` stays unset for
// every statement inside it. `public.users` carries the RESTRICTIVE
// `explicit_tenant_context_753` policy (migration 758) whose WITH CHECK
// requires that GUC, so an unscoped insert is rejected 42501 rather than
// filed anywhere. Scope the transaction when a tenant is in ambient context;
// callers with none (scripts, the pre-auth realm) keep the previous shape.
  const ambientTenantId = getCurrentTenantId();
  const runIdentityCreate = (fn) => (ambientTenantId
    ? setTenantTx(ambientTenantId, fn)
    : prisma.$transaction(fn));

  const created = await runIdentityCreate(async (tx) => {
    const user = await tx.users.create({
      data: {
        phone,
        name,
        email: data.email || null,
        role,
        encrypted_password: passwordHash,
        is_active: true,
        registered_at: new Date(),
        updated_at: new Date(),
      },
      select: { id: true, uid: true, role: true, name: true, phone: true, email: true },
    });
    return withAuthIdentityLifecycleLocks(tx, [user.uid], async () => user);
  });

  return { user: created, createdUser: true };
}

export const createStaffProfile = async (data, createdBy, creatorName, ipAddress) => {
  const {
    position, department, shift = 'FULL_DAY',
    salary, hire_date, supervisor_id, emergency_contact,
    skills, certifications, notes
  } = data;
  const employee_id = String(data.employee_id || '').trim() || await nextEmployeeId();
  const emergencyContactPayload = emergency_contact == null
    ? null
    : JSON.stringify(
      typeof emergency_contact === 'object'
        ? emergency_contact
        : { phone: String(emergency_contact) },
    );

  // Check employee_id uniqueness
  const employeeIdCheck = await prisma.$queryRawUnsafe(
    'SELECT user_id FROM staff WHERE employee_id = $1',
    employee_id
  );

  if (employeeIdCheck.length > 0) {
    throw new Error('EMPLOYEE_ID_EXISTS');
  }

  const { user, createdUser } = await resolveOrCreateStaffUser(data);

  // Check if staff profile already exists
  const existingProfile = await prisma.$queryRawUnsafe(
    'SELECT user_id FROM staff WHERE user_id = $1::uuid',
    user.uid
  );

  if (existingProfile.length > 0) {
    throw new Error('PROFILE_EXISTS');
  }

  // Validate supervisor if provided
  if (supervisor_id) {
    const supervisorCheck = await prisma.$queryRawUnsafe(
      'SELECT id FROM users WHERE id = $1 AND role IN ($2, $3, $4)',
      supervisor_id, 'ADMIN', 'DOCTOR', 'HR_STAFF'
    );

    if (supervisorCheck.length === 0) {
      throw new Error('INVALID_SUPERVISOR');
    }
  }

  // Create staff profile
  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO staff (
      user_id, employee_id, name, position, department, shift, salary,
      hire_date, supervisor_id, emergency_contact, skills, 
      certifications, notes, is_active, created_at, updated_at, created_by
    ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9, $10::jsonb, $11::text[], $12::text[], $13, true, NOW(), NOW(), $14::uuid)
    RETURNING id, user_id, employee_id, name, department, position, shift, is_active, created_at, updated_at
  `, 
    user.uid, employee_id, user.name, position, department, shift.toUpperCase(), salary ?? null,
    hire_date || null, supervisor_id ? Number(supervisor_id) : null,
    emergencyContactPayload,
    Array.isArray(skills) ? skills : [],
    Array.isArray(certifications) ? certifications : [],
    notes, createdBy
  );

  await seedOnboardingTasks(user.id, createdBy);

  // Log staff creation activity
  await prisma.$queryRawUnsafe(
    `INSERT INTO admin_activity_logs (
      admin_uid, action, description, affected_user_id,
      details, ip_address, created_at
    ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6, NOW())`,
    
      createdBy,
      'STAFF_PROFILE_CREATED',
      `Staff profile created for ${user.name} (${employee_id})`,
      user.uid,
      JSON.stringify({ employee_id, position, department, role: user.role, created_user: createdUser }),
      ipAddress
    
  );

  logger.info(`👤 Staff profile created: ${employee_id} for user ${user.name} by ${creatorName}`);

  return {
    staff: {
      ...result[0],
      hire_date: result[0].hire_date ? new Date(result[0].hire_date).toLocaleDateString('en-IN') : null,
      shift_details: SHIFT_TYPES[result[0].shift] || null
    },
    userInfo: {
      id: user.id,
      uid: user.uid,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role
    },
    onboarding: {
      tasks_created: DEFAULT_ONBOARDING_TASKS.length,
      status: 'pending'
    },
    createdBy: creatorName
  };
};

export const updateStaffProfile = async (id, data, updatedBy, updaterName, ipAddress) => {
  const { 
    position, department, shift, salary, supervisor_id,
    emergency_contact, skills, certifications, notes, 
    is_active, performance_rating
  } = data;
  const identifier = String(id || '').trim();

  // Verify staff profile exists
  const staffCheck = await prisma.$queryRawUnsafe(`
    SELECT s.*, u.id AS user_int_id, u.uid AS user_uid, u.name,
           u.identity_source AS user_identity_source,
           u.scim_provider_id AS user_scim_provider_id,
           tip.provider_key AS scim_provider_key
    FROM staff s
    JOIN users u ON s.user_id = u.uid
    LEFT JOIN tenant_identity_providers tip
      ON tip.id = COALESCE(s.scim_provider_id, u.scim_provider_id)
    WHERE
      s.user_id::text = $1
      OR s.id::text = $1
      OR u.id::text = $1
      OR UPPER(s.employee_id) = UPPER($1)
  `, identifier);

  if (staffCheck.length === 0) {
    throw new Error('NOT_FOUND');
  }

  const currentStaff = staffCheck[0];
  const scimOwnedFieldsTouched = SCIM_OWNED_STAFF_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(data || {}, field));
  const scimManaged = isScimManagedSource(currentStaff.identity_source)
    || isScimManagedSource(currentStaff.user_identity_source);
  const overrideReason = scimOverrideReason(data);
  if (scimManaged && scimOwnedFieldsTouched.length > 0 && overrideReason.length < 8) {
    const err = new Error('SCIM_OWNED_FIELD_OVERRIDE_REQUIRED');
    err.statusCode = 409;
    err.details = { fields: scimOwnedFieldsTouched };
    throw err;
  }

  // Validate supervisor if provided
  if (supervisor_id) {
    const supervisorCheck = await prisma.$queryRawUnsafe(
      'SELECT id FROM users WHERE id = $1 AND role IN ($2, $3, $4)',
      supervisor_id, 'ADMIN', 'DOCTOR', 'HR_STAFF'
    );

    if (supervisorCheck.length === 0) {
      throw new Error('INVALID_SUPERVISOR');
    }
  }

  // Update staff profile
  const result = await prisma.$queryRawUnsafe(`
    UPDATE staff SET 
      position = COALESCE($1, position),
      department = COALESCE($2, department),
      shift = COALESCE($3, shift),
      salary = COALESCE($4, salary),
      supervisor_id = COALESCE($5, supervisor_id),
      emergency_contact = COALESCE($6, emergency_contact),
      skills = COALESCE($7, skills),
      certifications = COALESCE($8, certifications),
      notes = COALESCE($9, notes),
      is_active = COALESCE($10, is_active),
      performance_rating = COALESCE($11, performance_rating),
      updated_at = NOW(),
      updated_by = $12::uuid
    WHERE user_id::text = $13
    RETURNING id, user_id, employee_id, department, position, shift, is_active, created_at, updated_at
  `, 
    position, department, shift?.toUpperCase(), salary, supervisor_id,
    emergency_contact, 
    skills ? JSON.stringify(skills) : null,
    certifications ? JSON.stringify(certifications) : null,
    notes, is_active, performance_rating, updatedBy, currentStaff.user_id
  );

  // Track changes for audit log
  const changes = {};
  if (position && position !== currentStaff.position) {changes.position = { from: currentStaff.position, to: position };}
  if (department && department !== currentStaff.department) {changes.department = { from: currentStaff.department, to: department };}
  if (salary && salary !== currentStaff.salary) {changes.salary = { from: currentStaff.salary, to: salary };}
  if (is_active !== undefined && is_active !== currentStaff.is_active) {changes.is_active = { from: currentStaff.is_active, to: is_active };}

  if (scimManaged && scimOwnedFieldsTouched.length > 0) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO identity_audit_events (
          tenant_id, realm, protocol, provider_id, provider_key, event_type, outcome,
          actor_uid, local_uid, ip_address, details
        )
        VALUES (
          $1::uuid, 'staff', 'scim', $2::bigint, $3, 'SCIM_LOCAL_OVERRIDE', 'accepted',
          $4::uuid, $5::uuid, $6::inet, $7::jsonb
        )`,
      currentStaff.tenant_id,
      currentStaff.scim_provider_id || currentStaff.user_scim_provider_id || null,
      currentStaff.scim_provider_key || null,
      updatedBy || null,
      currentStaff.user_id,
      auditIpAddress(ipAddress),
      JSON.stringify({
        fields: scimOwnedFieldsTouched,
        reason: overrideReason,
        source: {
          staff: currentStaff.identity_source || 'local',
          user: currentStaff.user_identity_source || 'local',
        },
      })
    );
  }

  // Log staff update activity
  await prisma.$queryRawUnsafe(
    `INSERT INTO admin_activity_logs (
      admin_uid, action, description, affected_user_id,
      details, ip_address, created_at
    ) VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6, NOW())`,
    
      updatedBy,
      'STAFF_PROFILE_UPDATED',
      `Staff profile updated for ${currentStaff.name}`,
      currentStaff.user_id,
      JSON.stringify(changes),
      ipAddress
    
  );

  logger.info(`📝 Staff profile updated: ${currentStaff.name} (${id}) by ${updaterName}`);

  return {
    staff: {
      ...result[0],
      updated_at: result[0].updated_at.toLocaleString('en-IN'),
      shift_details: SHIFT_TYPES[result[0].shift] || null
    },
    changes,
    updatedBy: updaterName
  };
};

export const getStaffByDepartment = async (department, shift, includeInactive, userRole) => {
  const allowedRoles = getStaffHierarchy(userRole);

  let whereClause = 'WHERE s.department = $1 AND u.role = ANY($2)';
  const params = [department, allowedRoles];
  let paramIndex = 3;

  if (!includeInactive) {
    whereClause += ' AND s.is_active = true';
  }

  if (shift) {
    whereClause += ` AND s.shift = $${paramIndex}`;
    params.push(shift);
    paramIndex++;
  }

  const query = `
    SELECT 
      u.id, u.name, u.phone, u.email, u.role,
      s.employee_id, s.position, s.shift, s.is_active,
      s.emergency_contact, s.skills, s.last_check_in, s.last_check_out,
      CASE 
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 'checked_in'
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NOT NULL THEN 'checked_out'
        ELSE 'not_checked_in'
      END as current_status
    FROM users u 
    JOIN staff s ON u.uid = s.user_id 
    ${whereClause}
    ORDER BY s.position, u.name
  `;

  const result = await prisma.$queryRawUnsafe(query, ...params);

  // Calculate department statistics
  const stats = {
    total: result.length,
    active: result.filter(s => s.is_active).length,
    inactive: result.filter(s => !s.is_active).length,
    checked_in: result.filter(s => s.current_status === 'checked_in').length,
    by_shift: {}
  };

  // Group by shift
  Object.keys(SHIFT_TYPES).forEach(shiftType => {
    stats.by_shift[shiftType] = result.filter(s => s.shift === shiftType).length;
  });

  // Format response data
  const formattedStaff = result.map(staff => ({
    ...staff,
    last_check_in: staff.last_check_in ? new Date(staff.last_check_in).toLocaleString('en-IN') : null,
    last_check_out: staff.last_check_out ? new Date(staff.last_check_out).toLocaleString('en-IN') : null,
    shift_details: SHIFT_TYPES[staff.shift] || null,
    can_contact: ['ADMIN', 'HR_STAFF', 'DOCTOR'].includes(userRole)
  }));

  return {
    department,
    staff: formattedStaff,
    statistics: stats,
    filters: { shift, include_inactive: includeInactive },
    shift_types: SHIFT_TYPES,
    departmentInfo: {
      name: department,
      total_positions: stats.total,
      operational_status: stats.checked_in > 0 ? 'active' : 'no_active_staff'
    }
  };
};

export const getStaffByShift = async (shift, department, date, userRole) => {
  const allowedRoles = getStaffHierarchy(userRole);

  let whereClause = 'WHERE s.shift = $1 AND s.is_active = true AND u.role = ANY($2)';
  const params = [shift, allowedRoles];
  let paramIndex = 3;

  if (department) {
    whereClause += ` AND s.department = $${paramIndex}`;
    params.push(department);
    paramIndex++;
  }

  const query = `
    SELECT 
      u.id, u.name, u.phone, u.role,
      s.employee_id, s.position, s.department, s.is_active,
      s.last_check_in, s.last_check_out,
      CASE 
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 'checked_in'
        WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NOT NULL THEN 'checked_out'
        ELSE 'not_checked_in'
      END as current_status,
      CASE 
        WHEN att.check_in_time IS NOT NULL THEN 'present'
        WHEN att.staff_id IS NULL AND UPPER($1::text) = 'MORNING' AND EXTRACT(HOUR FROM NOW()) > 8 THEN 'absent'
        WHEN att.staff_id IS NULL AND UPPER($1::text) = 'AFTERNOON' AND EXTRACT(HOUR FROM NOW()) > 16 THEN 'absent'
        WHEN att.staff_id IS NULL AND UPPER($1::text) = 'NIGHT' AND EXTRACT(HOUR FROM NOW()) > 0 THEN 'absent'
        ELSE 'scheduled'
      END as attendance_status
    FROM users u 
    JOIN staff s ON u.uid = s.user_id 
    LEFT JOIN staff_attendance att ON u.id = att.staff_id
      AND DATE(att.check_in_time) = $${paramIndex}::date
    ${whereClause}
    ORDER BY s.department, u.name
  `;

  params.push(date);
  const result = await prisma.$queryRawUnsafe(query, ...params);

  // Calculate shift statistics
  const shiftDetails = SHIFT_TYPES[shift];
  const stats = {
    total_scheduled: result.length,
    present: result.filter(s => s.attendance_status === 'present').length,
    absent: result.filter(s => s.attendance_status === 'absent').length,
    checked_in: result.filter(s => s.current_status === 'checked_in').length,
    by_department: {}
  };

  // Group by department
  const departments = [...new Set(result.map(s => s.department))];
  departments.forEach(dept => {
    stats.by_department[dept] = {
      total: result.filter(s => s.department === dept).length,
      present: result.filter(s => s.department === dept && s.attendance_status === 'present').length
    };
  });

  // Format response data
  const formattedStaff = result.map(staff => ({
    ...staff,
    last_check_in: staff.last_check_in ? new Date(staff.last_check_in).toLocaleString('en-IN') : null,
    last_check_out: staff.last_check_out ? new Date(staff.last_check_out).toLocaleString('en-IN') : null
  }));

  return {
    shift: shift.toUpperCase(),
    date: new Date(date).toLocaleDateString('en-IN'),
    staff: formattedStaff,
    statistics: stats,
    shiftDetails,
    filters: { department },
    operationalStatus: {
      staffing_level: stats.present / stats.total_scheduled,
      is_adequately_staffed: stats.present >= (stats.total_scheduled * 0.8),
      missing_staff: Math.max(0, Math.ceil(stats.total_scheduled * 0.8) - stats.present)
    }
  };
};

export const getStaffStatistics = async (userRole, timeframe) => {
  const allowedRoles = getStaffHierarchy(userRole);

  // Basic staff statistics
  const totalStats = await prisma.$queryRawUnsafe(`
    SELECT 
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.is_active = false THEN 1 END) as inactive_staff,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as average_salary,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as currently_checked_in
    FROM users u
    LEFT JOIN staff s ON u.uid = s.user_id
    WHERE u.role = ANY($1)
  `, allowedRoles);

  // Department breakdown
  const departmentStats = await prisma.$queryRawUnsafe(`
    SELECT 
      s.department, 
      COUNT(*) as total_count,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_count,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as checked_in_count
    FROM users u
    JOIN staff s ON u.uid = s.user_id
    WHERE s.is_active = true AND u.role = ANY($1)
    GROUP BY s.department
    ORDER BY total_count DESC
  `, allowedRoles);

  // Role distribution
  const roleStats = await prisma.$queryRawUnsafe(`
    SELECT 
      u.role, 
      COUNT(*) as count,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_count
    FROM users u
    LEFT JOIN staff s ON u.uid = s.user_id
    WHERE u.role = ANY($1)
    GROUP BY u.role
    ORDER BY count DESC
  `, allowedRoles);

  // Shift distribution
  const shiftStats = await prisma.$queryRawUnsafe(`
    SELECT 
      s.shift, 
      COUNT(*) as count,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as checked_in_count
    FROM users u
    JOIN staff s ON u.uid = s.user_id
    WHERE s.is_active = true AND u.role = ANY($1)
    GROUP BY s.shift
    ORDER BY s.shift
  `, allowedRoles);

  // Attendance statistics (if available)
  let attendanceStats = null;
  try {
    const attendanceResult = await prisma.$queryRawUnsafe(`
      SELECT 
        COUNT(DISTINCT staff_id) as staff_with_attendance,
        COUNT(*) as total_attendance_records,
        AVG(EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600) as avg_daily_hours
      FROM staff_attendance 
      WHERE check_in_time >= CURRENT_DATE - INTERVAL '30 days'
        AND check_out_time IS NOT NULL
    `);
    
    attendanceStats = {
      ...attendanceResult[0],
      avg_daily_hours: attendanceResult[0].avg_daily_hours ? 
        Math.round(attendanceResult[0].avg_daily_hours * 100) / 100 : null
    };
  } catch (attendanceError) {
    logger.warn('Attendance statistics unavailable:', attendanceError.message);
  }

  // Calculate operational efficiency
  const totalActive = parseInt(totalStats[0].active_staff);
  const currentlyCheckedIn = parseInt(totalStats[0].currently_checked_in);
  const operationalEfficiency = totalActive > 0 ? Math.round((currentlyCheckedIn / totalActive) * 100) : 0;

  return {
    overview: {
      ...totalStats[0],
      average_salary: totalStats[0].average_salary ? 
        Math.round(totalStats[0].average_salary) : null,
      operational_efficiency: operationalEfficiency,
      staffing_status: operationalEfficiency >= 70 ? 'well_staffed' : 
                      operationalEfficiency >= 50 ? 'adequately_staffed' : 'understaffed'
    },
    departments: departmentStats,
    roles: roleStats,
    shifts: shiftStats.map((shift) => {
      const count = Number(shift.count || 0);
      const checkedInCount = Number(shift.checked_in_count || 0);

      return {
        ...shift,
        count,
        checked_in_count: checkedInCount,
        shift_details: SHIFT_TYPES[shift.shift] || null,
        attendance_rate: count > 0 ? Math.round((checkedInCount / count) * 100) : 0,
      };
    }),
    attendance: attendanceStats,
    metadata: {
      timeframe,
      generatedAt: new Date().toISOString(),
      accessLevel: userRole,
      viewableRoles: allowedRoles,
      dataAvailability: {
        staffProfiles: true,
        attendance: attendanceStats !== null,
        salaryData: ['ADMIN', 'HR_STAFF'].includes(userRole)
      }
    }
  };
};
