// src/routes/doctorRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ doctorRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Doctor routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all doctors with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const department = req.query.department; // Filter by department
    const available = req.query.available; // Filter by availability
    
    let query = `
      SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.registered_at,
             d.specialization, d.department, d.experience_years, d.consultation_fee,
             d.available_days, d.available_hours, d.is_available
      FROM users u 
      LEFT JOIN doctors d ON u.id = d.user_id 
      WHERE u.role = 'DOCTOR'
    `;
    let params = [];
    
    if (department) {
      query += ' AND d.department = $' + (params.length + 1);
      params.push(department);
    }
    
    if (available !== undefined) {
      query += ' AND d.is_available = $' + (params.length + 1);
      params.push(available === 'true');
    }
    
    query += ' ORDER BY u.name LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM users u LEFT JOIN doctors d ON u.id = d.user_id WHERE u.role = \'DOCTOR\'';
    let countParams = [];
    
    if (department) {
      countQuery += ' AND d.department = $1';
      countParams.push(department);
    }
    if (available !== undefined) {
      countQuery += ` AND d.is_available = $${countParams.length + 1}`;
      countParams.push(available === 'true');
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalDoctors = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Doctors retrieved successfully',
      doctors: result.rows,
      pagination: {
        page,
        limit,
        total: totalDoctors,
        totalPages: Math.ceil(totalDoctors / limit),
        hasNext: page * limit < totalDoctors,
        hasPrev: page > 1
      },
      filters: {
        department: department || null,
        available: available || null
      }
    });
  } catch (error) {
    console.log('Database error for doctors list:', error.message);
    
    // Fallback to users with DOCTOR role
    try {
      const fallbackResult = await db.query(
        'SELECT id, uid, phone, name, email, role, registered_at FROM users WHERE role = $1 ORDER BY name LIMIT $2',
        ['DOCTOR', limit]
      );
      
      res.json({
        message: 'Doctors retrieved (basic info only - doctors table may not exist)',
        doctors: fallbackResult.rows,
        count: fallbackResult.rows.length,
        note: 'Extended doctor information unavailable - check doctors table schema'
      });
    } catch (fallbackError) {
      res.status(500).json({
        message: 'Failed to retrieve doctors',
        error: error.message
      });
    }
  }
});

// Get doctor by ID or UID
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const column = isUUID ? 'u.uid' : 'u.id';
    
    const result = await db.query(`
      SELECT u.id, u.uid, u.phone, u.name, u.email, u.gender, u.address, 
             u.birthday, u.profile_picture, u.registered_at,
             d.specialization, d.department, d.experience_years, d.consultation_fee,
             d.available_days, d.available_hours, d.is_available, d.bio, d.education
      FROM users u 
      LEFT JOIN doctors d ON u.id = d.user_id 
      WHERE ${column} = $1 AND u.role = 'DOCTOR'
    `, [identifier]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Doctor not found',
        identifier,
        searchedBy: isUUID ? 'uid' : 'id'
      });
    }
    
    res.json({
      message: 'Doctor retrieved successfully',
      doctor: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    
    // Fallback to basic user info
    try {
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.identifier);
      const column = isUUID ? 'uid' : 'id';
      
      const fallbackResult = await db.query(
        `SELECT * FROM users WHERE ${column} = $1 AND role = 'DOCTOR'`,
        [req.params.identifier]
      );
      
      if (fallbackResult.rows.length === 0) {
        return res.status(404).json({ message: 'Doctor not found' });
      }
      
      res.json({
        message: 'Doctor basic info retrieved',
        doctor: fallbackResult.rows[0],
        note: 'Extended doctor information unavailable'
      });
    } catch (fallbackError) {
      res.status(500).json({
        message: 'Failed to retrieve doctor',
        error: error.message
      });
    }
  }
});

// Get doctors by department
router.get('/department/:department', async (req, res) => {
  try {
    const { department } = req.params;
    
    const result = await db.query(`
      SELECT u.id, u.uid, u.name, u.phone, u.email,
             d.specialization, d.experience_years, d.consultation_fee, d.is_available
      FROM users u 
      JOIN doctors d ON u.id = d.user_id 
      WHERE u.role = 'DOCTOR' AND d.department = $1 AND d.is_available = true
      ORDER BY u.name
    `, [department.toUpperCase()]);
    
    res.json({
      message: `Doctors in ${department} department retrieved successfully`,
      doctors: result.rows,
      count: result.rows.length,
      department: department.toUpperCase()
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve doctors by department',
      error: error.message
    });
  }
});

// Get available doctors for booking
router.get('/available/now', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    const currentHour = new Date().getHours();
    
    const result = await db.query(`
      SELECT u.id, u.uid, u.name, u.phone,
             d.specialization, d.department, d.consultation_fee,
             d.available_days, d.available_hours
      FROM users u 
      JOIN doctors d ON u.id = d.user_id 
      WHERE u.role = 'DOCTOR' 
        AND d.is_available = true
        AND d.available_days LIKE '%' || $1 || '%'
      ORDER BY d.department, u.name
    `, [today]);
    
    // Filter by current time (basic implementation)
    const availableNow = result.rows.filter(doctor => {
      if (!doctor.available_hours) return true;
      
      try {
        const hours = doctor.available_hours.split('-');
        const startHour = parseInt(hours[0]);
        const endHour = parseInt(hours[1]);
        return currentHour >= startHour && currentHour <= endHour;
      } catch {
        return true; // If can't parse, assume available
      }
    });
    
    res.json({
      message: 'Available doctors retrieved successfully',
      doctors: availableNow,
      count: availableNow.length,
      currentTime: {
        day: today,
        hour: currentHour
      }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve available doctors',
      error: error.message
    });
  }
});

// Create doctor profile (requires existing user with DOCTOR role)
router.post('/profile', async (req, res) => {
  try {
    const { 
      user_id, specialization, department, experience_years, 
      consultation_fee, available_days, available_hours, bio, education 
    } = req.body;
    
    if (!user_id || !specialization || !department) {
      return res.status(400).json({
        message: 'user_id, specialization, and department are required'
      });
    }
    
    // Verify user exists and is a doctor
    const userCheck = await db.query('SELECT id, role FROM users WHERE id = $1', [user_id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (userCheck.rows[0].role !== 'DOCTOR') {
      return res.status(400).json({ message: 'User must have DOCTOR role' });
    }
    
    // Check if doctor profile already exists
    const existingProfile = await db.query('SELECT user_id FROM doctors WHERE user_id = $1', [user_id]);
    if (existingProfile.rows.length > 0) {
      return res.status(409).json({ message: 'Doctor profile already exists' });
    }
    
    const result = await db.query(`
      INSERT INTO doctors (
        user_id, specialization, department, experience_years, 
        consultation_fee, available_days, available_hours, bio, education,
        is_available, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW())
      RETURNING *
    `, [user_id, specialization, department.toUpperCase(), experience_years, 
        consultation_fee, available_days, available_hours, bio, education]);
    
    res.status(201).json({
      message: 'Doctor profile created successfully',
      profile: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create doctor profile',
      error: error.message
    });
  }
});

// Update doctor availability
router.put('/:id/availability', async (req, res) => {
  try {
    const { id } = req.params;
    const { is_available, available_days, available_hours } = req.body;
    
    const result = await db.query(`
      UPDATE doctors SET 
        is_available = COALESCE($1, is_available),
        available_days = COALESCE($2, available_days),
        available_hours = COALESCE($3, available_hours),
        updated_at = NOW()
      WHERE user_id = $4
      RETURNING user_id, is_available, available_days, available_hours
    `, [is_available, available_days, available_hours, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Doctor profile not found' });
    }
    
    res.json({
      message: 'Doctor availability updated successfully',
      availability: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update doctor availability',
      error: error.message
    });
  }
});

export default router;