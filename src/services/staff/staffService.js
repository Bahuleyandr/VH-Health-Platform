import db from '../../config/database.js';
import { STAFF_ROLES, SHIFT_TYPES } from '../../config/staffConfig.js';
import { getStaffHierarchy } from '../../utils/staff/staffHelpers.js';
import logger from '../../logging/logger.js';

export const getStaffList = async (filters, userRole) => {
  const allowedRoles = getStaffHierarchy(userRole);
  const { page, limit, role, department, shift, active, search, supervisor_id, skill } = filters;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE u.role = ANY($1)';
  const params = [allowedRoles, parseInt(limit), parseInt(offset)];
  let paramIndex = 4;

  // Build WHERE clause based on filters
  if (active !== undefined) {
    whereClause += ` AND (s.is_active = $${paramIndex} OR s.is_active IS NULL)`;
    params.push(active);
    paramIndex++;
  }

  if (role) {
    whereClause += ` AND u.role = $${paramIndex}`;
    params.push(role);
    paramIndex++;
  }

  if (department) {
    whereClause += ` AND s.department = $${paramIndex}`;
    params.push(department);
    paramIndex++;
  }

  if (shift) {
    whereClause += ` AND s.shift = $${paramIndex}`;
    params.push(shift);
    paramIndex++;
  }

  if (supervisor_id) {
    whereClause += ` AND s.supervisor_id = $${paramIndex}`;
    params.push(supervisor_id);
    paramIndex++;
  }

  if (search) {
    whereClause += ` AND (LOWER(u.name) LIKE $${paramIndex} OR LOWER(s.employee_id) LIKE $${paramIndex} OR LOWER(s.position) LIKE $${paramIndex})`;
    params.push(`%${search.toLowerCase()}%`);
    paramIndex++;
  }

  if (skill) {
    whereClause += ` AND s.skills::text ILIKE $${paramIndex}`;
    params.push(`%${skill}%`);
    paramIndex++;
  }

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
    LEFT JOIN staff s ON u.id = s.user_id 
    LEFT JOIN users sup ON s.supervisor_id = sup.id
    ${whereClause}
    ORDER BY 
      CASE WHEN s.is_active = true THEN 0 ELSE 1 END,
      u.name ASC
    LIMIT $2 OFFSET $3
  `;

  const result = await db.query(query, params);

  // Get total count
  const countQuery = `
    SELECT COUNT(*)
    FROM users u 
    LEFT JOIN staff s ON u.id = s.user_id 
    LEFT JOIN users sup ON s.supervisor_id = sup.id
    ${whereClause}
  `;
  const countResult = await db.query(countQuery, params.slice(3));
  const totalStaff = parseInt(countResult.rows[0].count);

  // Get statistics
  const departmentStats = await db.query(`
    SELECT s.department, COUNT(*) as count
    FROM users u 
    LEFT JOIN staff s ON u.id = s.user_id 
    WHERE u.role = ANY($1) AND (s.is_active = true OR s.is_active IS NULL)
    GROUP BY s.department
    ORDER BY count DESC
  `, [allowedRoles]);

  const roleStats = await db.query(`
    SELECT u.role, COUNT(*) as count
    FROM users u 
    LEFT JOIN staff s ON u.id = s.user_id 
    WHERE u.role = ANY($1) AND (s.is_active = true OR s.is_active IS NULL)
    GROUP BY u.role
    ORDER BY count DESC
  `, [allowedRoles]);

  // Format staff data
  const enhancedStaff = result.rows.map(staff => ({
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
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalStaff,
      totalPages: Math.ceil(totalStaff / limit),
      hasNext: page * limit < totalStaff,
      hasPrev: page > 1
    },
    filters: { role, department, shift, active, search, supervisor_id, skill },
    statistics: {
      departments: departmentStats.rows,
      roles: roleStats.rows,
      totalActive: enhancedStaff.filter(s => s.is_active !== false).length,
      currentlyCheckedIn: enhancedStaff.filter(s => s.current_status === 'checked_in').length
    },
    accessLevel: userRole,
    viewableRoles: allowedRoles
  };
};

export const getStaffProfile = async (identifier, userRole, userId, includePrivate) => {
  const allowedRoles = getStaffHierarchy(userRole);
  
  // Determine if identifier is UUID or numeric ID
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  const column = isUUID ? 'u.uid' : 'u.id';

  const result = await db.query(`
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
    LEFT JOIN staff s ON u.id = s.user_id 
    LEFT JOIN users sup ON s.supervisor_id = sup.id
    WHERE ${column} = $1 AND u.role = ANY($2)
  `, [identifier, allowedRoles]);

  if (result.rows.length === 0) {
    throw new Error('NOT_FOUND');
  }

  const staff = result.rows[0];

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
    const attendanceResult = await db.query(`
      SELECT 
        DATE(check_in_time) as date,
        check_in_time, check_out_time,
        EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600 as hours_worked,
        status, location
      FROM staff_attendance 
      WHERE staff_id = $1 
        AND check_in_time >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY check_in_time DESC
      LIMIT 7
    `, [staff.id]);
    
    recentAttendance = attendanceResult.rows.map(record => ({
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
      const performanceResult = await db.query(`
        SELECT 
          AVG(rating) as average_rating,
          COUNT(*) as total_reviews,
          MAX(review_date) as last_review_date
        FROM staff_performance_reviews 
        WHERE staff_id = $1
          AND review_date >= CURRENT_DATE - INTERVAL '1 year'
      `, [staff.id]);
      
      if (performanceResult.rows[0].total_reviews > 0) {
        performanceMetrics = {
          ...performanceResult.rows[0],
          average_rating: performanceResult.rows[0].average_rating ? 
            Math.round(performanceResult.rows[0].average_rating * 10) / 10 : null,
          last_review_date: performanceResult.rows[0].last_review_date ? 
            new Date(performanceResult.rows[0].last_review_date).toLocaleDateString('en-IN') : null
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

export const createStaffProfile = async (data, createdBy, creatorName, ipAddress) => {
  const { 
    user_id, employee_id, position, department, shift = 'FULL_DAY',
    salary, hire_date, supervisor_id, emergency_contact, 
    skills, certifications, notes 
  } = data;

  // Verify user exists and has appropriate role
  const userCheck = await db.query(
    'SELECT id, role, name, phone FROM users WHERE id = $1',
    [user_id]
  );

  if (userCheck.rows.length === 0) {
    throw new Error('USER_NOT_FOUND');
  }

  const user = userCheck.rows[0];
  const validStaffRoles = Object.values(STAFF_ROLES);
  
  if (!validStaffRoles.includes(user.role)) {
    throw new Error('INVALID_ROLE');
  }

  // Check if staff profile already exists
  const existingProfile = await db.query(
    'SELECT user_id FROM staff WHERE user_id = $1',
    [user_id]
  );

  if (existingProfile.rows.length > 0) {
    throw new Error('PROFILE_EXISTS');
  }

  // Check employee_id uniqueness
  const employeeIdCheck = await db.query(
    'SELECT user_id FROM staff WHERE employee_id = $1',
    [employee_id]
  );

  if (employeeIdCheck.rows.length > 0) {
    throw new Error('EMPLOYEE_ID_EXISTS');
  }

  // Validate supervisor if provided
  if (supervisor_id) {
    const supervisorCheck = await db.query(
      'SELECT id FROM users WHERE id = $1 AND role IN ($2, $3, $4)',
      [supervisor_id, 'ADMIN', 'DOCTOR', 'HR_STAFF']
    );

    if (supervisorCheck.rows.length === 0) {
      throw new Error('INVALID_SUPERVISOR');
    }
  }

  // Create staff profile
  const result = await db.query(`
    INSERT INTO staff (
      user_id, employee_id, position, department, shift, salary,
      hire_date, supervisor_id, emergency_contact, skills, 
      certifications, notes, is_active, created_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, NOW(), $13)
    RETURNING *
  `, [
    user_id, employee_id, position, department, shift.toUpperCase(), salary,
    hire_date, supervisor_id, emergency_contact, 
    skills ? JSON.stringify(skills) : null,
    certifications ? JSON.stringify(certifications) : null, 
    notes, createdBy
  ]);

  // Log staff creation activity
  await db.query(
    `INSERT INTO admin_activity_logs (
      admin_uid, action, description, affected_user_id,
      details, ip_address, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      createdBy,
      'STAFF_PROFILE_CREATED',
      `Staff profile created for ${user.name} (${employee_id})`,
      user_id,
      JSON.stringify({ employee_id, position, department }),
      ipAddress
    ]
  );

  logger.info(`👤 Staff profile created: ${employee_id} for user ${user.name} by ${creatorName}`);

  return {
    staff: {
      ...result.rows[0],
      hire_date: result.rows[0].hire_date ? new Date(result.rows[0].hire_date).toLocaleDateString('en-IN') : null,
      shift_details: SHIFT_TYPES[result.rows[0].shift] || null
    },
    userInfo: {
      name: user.name,
      phone: user.phone,
      role: user.role
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

  // Verify staff profile exists
  const staffCheck = await db.query(
    'SELECT s.*, u.name FROM staff s JOIN users u ON s.user_id = u.id WHERE s.user_id = $1',
    [id]
  );

  if (staffCheck.rows.length === 0) {
    throw new Error('NOT_FOUND');
  }

  const currentStaff = staffCheck.rows[0];

  // Validate supervisor if provided
  if (supervisor_id) {
    const supervisorCheck = await db.query(
      'SELECT id FROM users WHERE id = $1 AND role IN ($2, $3, $4)',
      [supervisor_id, 'ADMIN', 'DOCTOR', 'HR_STAFF']
    );

    if (supervisorCheck.rows.length === 0) {
      throw new Error('INVALID_SUPERVISOR');
    }
  }

  // Update staff profile
  const result = await db.query(`
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
      updated_by = $12
    WHERE user_id = $13
    RETURNING *
  `, [
    position, department, shift?.toUpperCase(), salary, supervisor_id,
    emergency_contact, 
    skills ? JSON.stringify(skills) : null,
    certifications ? JSON.stringify(certifications) : null,
    notes, is_active, performance_rating, updatedBy, id
  ]);

  // Track changes for audit log
  const changes = {};
  if (position && position !== currentStaff.position) changes.position = { from: currentStaff.position, to: position };
  if (department && department !== currentStaff.department) changes.department = { from: currentStaff.department, to: department };
  if (salary && salary !== currentStaff.salary) changes.salary = { from: currentStaff.salary, to: salary };
  if (is_active !== undefined && is_active !== currentStaff.is_active) changes.is_active = { from: currentStaff.is_active, to: is_active };

  // Log staff update activity
  await db.query(
    `INSERT INTO admin_activity_logs (
      admin_uid, action, description, affected_user_id,
      details, ip_address, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      updatedBy,
      'STAFF_PROFILE_UPDATED',
      `Staff profile updated for ${currentStaff.name}`,
      id,
      JSON.stringify(changes),
      ipAddress
    ]
  );

  logger.info(`📝 Staff profile updated: ${currentStaff.name} (${id}) by ${updaterName}`);

  return {
    staff: {
      ...result.rows[0],
      updated_at: result.rows[0].updated_at.toLocaleString('en-IN'),
      shift_details: SHIFT_TYPES[result.rows[0].shift] || null
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
    JOIN staff s ON u.id = s.user_id 
    ${whereClause}
    ORDER BY s.position, u.name
  `;

  const result = await db.query(query, params);

  // Calculate department statistics
  const stats = {
    total: result.rows.length,
    active: result.rows.filter(s => s.is_active).length,
    inactive: result.rows.filter(s => !s.is_active).length,
    checked_in: result.rows.filter(s => s.current_status === 'checked_in').length,
    by_shift: {}
  };

  // Group by shift
  Object.keys(SHIFT_TYPES).forEach(shiftType => {
    stats.by_shift[shiftType] = result.rows.filter(s => s.shift === shiftType).length;
  });

  // Format response data
  const formattedStaff = result.rows.map(staff => ({
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
        WHEN att.staff_id IS NULL AND '$1' = 'MORNING' AND EXTRACT(HOUR FROM NOW()) > 8 THEN 'absent'
        WHEN att.staff_id IS NULL AND '$1' = 'AFTERNOON' AND EXTRACT(HOUR FROM NOW()) > 16 THEN 'absent'
        WHEN att.staff_id IS NULL AND '$1' = 'NIGHT' AND EXTRACT(HOUR FROM NOW()) > 0 THEN 'absent'
        ELSE 'scheduled'
      END as attendance_status
    FROM users u 
    JOIN staff s ON u.id = s.user_id 
    LEFT JOIN staff_attendance att ON s.user_id = att.staff_id 
      AND DATE(att.check_in_time) = $${paramIndex}
    ${whereClause}
    ORDER BY s.department, u.name
  `;

  params.push(date);
  const result = await db.query(query, params);

  // Calculate shift statistics
  const shiftDetails = SHIFT_TYPES[shift];
  const stats = {
    total_scheduled: result.rows.length,
    present: result.rows.filter(s => s.attendance_status === 'present').length,
    absent: result.rows.filter(s => s.attendance_status === 'absent').length,
    checked_in: result.rows.filter(s => s.current_status === 'checked_in').length,
    by_department: {}
  };

  // Group by department
  const departments = [...new Set(result.rows.map(s => s.department))];
  departments.forEach(dept => {
    stats.by_department[dept] = {
      total: result.rows.filter(s => s.department === dept).length,
      present: result.rows.filter(s => s.department === dept && s.attendance_status === 'present').length
    };
  });

  // Format response data
  const formattedStaff = result.rows.map(staff => ({
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
  const totalStats = await db.query(`
    SELECT 
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.is_active = false THEN 1 END) as inactive_staff,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as average_salary,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as currently_checked_in
    FROM users u
    LEFT JOIN staff s ON u.id = s.user_id
    WHERE u.role = ANY($1)
  `, [allowedRoles]);

  // Department breakdown
  const departmentStats = await db.query(`
    SELECT 
      s.department, 
      COUNT(*) as total_count,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_count,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as checked_in_count
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.is_active = true AND u.role = ANY($1)
    GROUP BY s.department
    ORDER BY total_count DESC
  `, [allowedRoles]);

  // Role distribution
  const roleStats = await db.query(`
    SELECT 
      u.role, 
      COUNT(*) as count,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_count
    FROM users u
    LEFT JOIN staff s ON u.id = s.user_id
    WHERE u.role = ANY($1)
    GROUP BY u.role
    ORDER BY count DESC
  `, [allowedRoles]);

  // Shift distribution
  const shiftStats = await db.query(`
    SELECT 
      s.shift, 
      COUNT(*) as count,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as checked_in_count
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.is_active = true AND u.role = ANY($1)
    GROUP BY s.shift
    ORDER BY s.shift
  `, [allowedRoles]);

  // Attendance statistics (if available)
  let attendanceStats = null;
  try {
    const attendanceResult = await db.query(`
      SELECT 
        COUNT(DISTINCT staff_id) as staff_with_attendance,
        COUNT(*) as total_attendance_records,
        AVG(EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600) as avg_daily_hours
      FROM staff_attendance 
      WHERE check_in_time >= CURRENT_DATE - INTERVAL '30 days'
        AND check_out_time IS NOT NULL
    `);
    
    attendanceStats = {
      ...attendanceResult.rows[0],
      avg_daily_hours: attendanceResult.rows[0].avg_daily_hours ? 
        Math.round(attendanceResult.rows[0].avg_daily_hours * 100) / 100 : null
    };
  } catch (attendanceError) {
    logger.warn('Attendance statistics unavailable:', attendanceError.message);
  }

  // Calculate operational efficiency
  const totalActive = parseInt(totalStats.rows[0].active_staff);
  const currentlyCheckedIn = parseInt(totalStats.rows[0].currently_checked_in);
  const operationalEfficiency = totalActive > 0 ? Math.round((currentlyCheckedIn / totalActive) * 100) : 0;

  return {
    overview: {
      ...totalStats.rows[0],
      average_salary: totalStats.rows[0].average_salary ? 
        Math.round(totalStats.rows[0].average_salary) : null,
      operational_efficiency: operationalEfficiency,
      staffing_status: operationalEfficiency >= 70 ? 'well_staffed' : 
                      operationalEfficiency >= 50 ? 'adequately_staffed' : 'understaffed'
    },
    departments: departmentStats.rows,
    roles: roleStats.rows,
    shifts: shiftStats.rows.map(shift => ({
      ...shift,
      shift_details: SHIFT_TYPES[shift.shift] || null,
      attendance_rate: shift.count > 0 ? Math.round((shift.checked_in_count / shift.count) * 100) : 0
    })),
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