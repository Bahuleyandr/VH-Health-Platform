// src/routes/staffRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ staffRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Staff routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all staff with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const role = req.query.role; // NURSE, ADMIN, PHARMACIST, TECHNICIAN, etc.
    const department = req.query.department;
    const active_only = req.query.active !== 'false'; // Default to active only
    
    let query = `
      SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
             s.employee_id, s.position, s.department, s.shift, s.salary,
             s.hire_date, s.is_active, s.supervisor_id, s.emergency_contact,
             sup.name as supervisor_name
      FROM users u 
      JOIN staff s ON u.id = s.user_id 
      LEFT JOIN users sup ON s.supervisor_id = sup.id
      WHERE u.role IN ('NURSE', 'ADMIN', 'PHARMACIST', 'TECHNICIAN', 'RECEPTIONIST', 'SECURITY', 'MAINTENANCE')
    `;
    let params = [];
    
    if (active_only) {
      query += ' AND s.is_active = true';
    }
    
    if (role) {
      query += ' AND u.role = $' + (params.length + 1);
      params.push(role.toUpperCase());
    }
    
    if (department) {
      query += ' AND s.department = $' + (params.length + 1);
      params.push(department);
    }
    
    query += ' ORDER BY u.name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = `SELECT COUNT(*) FROM users u JOIN staff s ON u.id = s.user_id 
                      WHERE u.role IN ('NURSE', 'ADMIN', 'PHARMACIST', 'TECHNICIAN', 'RECEPTIONIST', 'SECURITY', 'MAINTENANCE')`;
    let countParams = [];
    
    if (active_only) {
      countQuery += ' AND s.is_active = true';
    }
    if (role) {
      countQuery += ' AND u.role = $' + (countParams.length + 1);
      countParams.push(role.toUpperCase());
    }
    if (department) {
      countQuery += ' AND s.department = $' + (countParams.length + 1);
      countParams.push(department);
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalStaff = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Staff retrieved successfully',
      staff: result.rows,
      pagination: {
        page,
        limit,
        total: totalStaff,
        totalPages: Math.ceil(totalStaff / limit),
        hasNext: page * limit < totalStaff,
        hasPrev: page > 1
      },
      filters: {
        role: role || null,
        department: department || null,
        active_only
      }
    });
  } catch (error) {
    console.log('Database error for staff list:', error.message);
    
    // Fallback: Get users with staff roles
    try {
      const fallbackResult = await db.query(`
        SELECT id, uid, phone, name, email, role, registered_at 
        FROM users 
        WHERE role IN ('NURSE', 'ADMIN', 'PHARMACIST', 'TECHNICIAN', 'RECEPTIONIST') 
        ORDER BY name LIMIT $1
      `, [limit]);
      
      res.json({
        message: 'Staff retrieved (basic info only - staff table may not exist)',
        staff: fallbackResult.rows.map(user => ({
          ...user,
          position: user.role,
          department: 'Not specified',
          is_active: true
        })),
        count: fallbackResult.rows.length,
        note: 'Extended staff information unavailable - check staff table schema'
      });
    } catch (fallbackError) {
      res.status(500).json({
        message: 'Failed to retrieve staff',
        error: error.message
      });
    }
  }
});

// Get staff member by ID or UID
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const column = isUUID ? 'u.uid' : 'u.id';
    
    const result = await db.query(`
      SELECT u.*, 
             s.employee_id, s.position, s.department, s.shift, s.salary,
             s.hire_date, s.is_active, s.supervisor_id, s.emergency_contact,
             s.skills, s.certifications, s.notes,
             sup.name as supervisor_name, sup.phone as supervisor_phone
      FROM users u 
      JOIN staff s ON u.id = s.user_id 
      LEFT JOIN users sup ON s.supervisor_id = sup.id
      WHERE ${column} = $1
    `, [identifier]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Staff member not found',
        identifier,
        searchedBy: isUUID ? 'uid' : 'id'
      });
    }
    
    res.json({
      message: 'Staff member retrieved successfully',
      staff: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve staff member',
      error: error.message
    });
  }
});

// Get staff by department
router.get('/department/:department', async (req, res) => {
  try {
    const { department } = req.params;
    const shift = req.query.shift; // Optional shift filter
    
    let query = `
      SELECT u.id, u.name, u.phone, u.email,
             s.employee_id, s.position, s.shift, s.is_active,
             s.emergency_contact
      FROM users u 
      JOIN staff s ON u.id = s.user_id 
      WHERE s.department = $1 AND s.is_active = true
    `;
    let params = [department];
    
    if (shift) {
      query += ' AND s.shift = $2';
      params.push(shift.toUpperCase());
    }
    
    query += ' ORDER BY u.name';
    
    const result = await db.query(query, params);
    
    res.json({
      message: `Staff in ${department} department retrieved successfully`,
      staff: result.rows,
      count: result.rows.length,
      department,
      shift: shift || null
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve department staff',
      error: error.message
    });
  }
});

// Get staff by shift
router.get('/shift/:shift', async (req, res) => {
  try {
    const { shift } = req.params;
    const department = req.query.department; // Optional department filter
    
    let query = `
      SELECT u.id, u.name, u.phone, u.role,
             s.employee_id, s.position, s.department, s.is_active
      FROM users u 
      JOIN staff s ON u.id = s.user_id 
      WHERE s.shift = $1 AND s.is_active = true
    `;
    let params = [shift.toUpperCase()];
    
    if (department) {
      query += ' AND s.department = $2';
      params.push(department);
    }
    
    query += ' ORDER BY s.department, u.name';
    
    const result = await db.query(query, params);
    
    res.json({
      message: `Staff on ${shift} shift retrieved successfully`,
      staff: result.rows,
      count: result.rows.length,
      shift: shift.toUpperCase(),
      department: department || null
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve shift staff',
      error: error.message
    });
  }
});

// Create staff profile (requires existing user)
router.post('/create', async (req, res) => {
  try {
    const { 
      user_id, employee_id, position, department, shift = 'DAY',
      salary, hire_date, supervisor_id, emergency_contact, 
      skills, certifications, notes 
    } = req.body;
    
    if (!user_id || !employee_id || !position || !department) {
      return res.status(400).json({
        message: 'user_id, employee_id, position, and department are required'
      });
    }
    
    // Verify user exists and has appropriate role
    const userCheck = await db.query('SELECT id, role, name FROM users WHERE id = $1', [user_id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const staffRoles = ['NURSE', 'ADMIN', 'PHARMACIST', 'TECHNICIAN', 'RECEPTIONIST', 'SECURITY', 'MAINTENANCE'];
    if (!staffRoles.includes(userCheck.rows[0].role)) {
      return res.status(400).json({ 
        message: 'User must have a staff role',
        validRoles: staffRoles,
        currentRole: userCheck.rows[0].role
      });
    }
    
    // Check if staff profile already exists
    const existingProfile = await db.query('SELECT user_id FROM staff WHERE user_id = $1', [user_id]);
    if (existingProfile.rows.length > 0) {
      return res.status(409).json({ message: 'Staff profile already exists' });
    }
    
    // Check employee_id uniqueness
    const employeeIdCheck = await db.query('SELECT user_id FROM staff WHERE employee_id = $1', [employee_id]);
    if (employeeIdCheck.rows.length > 0) {
      return res.status(409).json({ message: 'Employee ID already exists' });
    }
    
    const result = await db.query(`
      INSERT INTO staff (
        user_id, employee_id, position, department, shift, salary,
        hire_date, supervisor_id, emergency_contact, skills, 
        certifications, notes, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, NOW())
      RETURNING *
    `, [user_id, employee_id, position, department, shift.toUpperCase(), salary,
        hire_date, supervisor_id, emergency_contact, skills, certifications, notes]);
    
    res.status(201).json({
      message: 'Staff profile created successfully',
      staff: result.rows[0],
      user_name: userCheck.rows[0].name
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create staff profile',
      error: error.message
    });
  }
});

// Update staff profile
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      position, department, shift, salary, supervisor_id,
      emergency_contact, skills, certifications, notes, is_active 
    } = req.body;
    
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
        updated_at = NOW()
      WHERE user_id = $11
      RETURNING *
    `, [position, department, shift?.toUpperCase(), salary, supervisor_id,
        emergency_contact, skills, certifications, notes, is_active, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Staff profile not found' });
    }
    
    res.json({
      message: 'Staff profile updated successfully',
      staff: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update staff profile',
      error: error.message
    });
  }
});

// Get staff attendance summary
router.get('/:id/attendance', async (req, res) => {
  try {
    const { id } = req.params;
    const days = parseInt(req.query.days) || 30;
    
    // This would integrate with attendance tracking system
    const result = await db.query(`
      SELECT DATE(check_in_time) as date,
             check_in_time, check_out_time,
             EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600 as hours_worked,
             status
      FROM staff_attendance 
      WHERE staff_id = $1 AND check_in_time >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY check_in_time DESC
    `, [id]);
    
    res.json({
      message: 'Staff attendance retrieved successfully',
      attendance: result.rows,
      count: result.rows.length,
      period_days: days,
      staff_id: id
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.json({
      message: 'Attendance tracking not available - staff_attendance table may not exist',
      staff_id: id,
      note: 'Create staff_attendance table for attendance tracking',
      mock_data: {
        present_days: Math.floor(days * 0.9),
        absent_days: Math.floor(days * 0.1),
        average_hours: 8.2
      }
    });
  }
});

// Get staff statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const [totalStats, departmentStats, shiftStats] = await Promise.all([
      // Total staff statistics
      db.query(`
        SELECT 
          COUNT(*) as total_staff,
          COUNT(CASE WHEN is_active = true THEN 1 END) as active_staff,
          COUNT(CASE WHEN is_active = false THEN 1 END) as inactive_staff,
          AVG(salary) as average_salary
        FROM staff
      `),
      
      // Department breakdown
      db.query(`
        SELECT department, COUNT(*) as count
        FROM staff 
        WHERE is_active = true
        GROUP BY department
        ORDER BY count DESC
      `),
      
      // Shift distribution
      db.query(`
        SELECT shift, COUNT(*) as count
        FROM staff 
        WHERE is_active = true
        GROUP BY shift
        ORDER BY shift
      `)
    ]);
    
    res.json({
      message: 'Staff statistics retrieved successfully',
      statistics: {
        totals: totalStats.rows[0],
        departments: departmentStats.rows,
        shifts: shiftStats.rows
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve staff statistics',
      error: error.message
    });
  }
});

export default router;