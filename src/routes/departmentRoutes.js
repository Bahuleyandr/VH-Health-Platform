// src/routes/departmentRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ departmentRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Department routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all departments with doctor count
router.get('/list', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT d.id, d.name, d.description, d.head_doctor_id, d.contact_number,
             d.location, d.is_active, d.created_at,
             u.name as head_doctor_name,
             COUNT(doc.user_id) as doctor_count
      FROM departments d
      LEFT JOIN users u ON d.head_doctor_id = u.id
      LEFT JOIN doctors doc ON doc.department = d.name AND doc.is_available = true
      WHERE d.is_active = true
      GROUP BY d.id, d.name, d.description, d.head_doctor_id, d.contact_number, 
               d.location, d.is_active, d.created_at, u.name
      ORDER BY d.name
    `);
    
    res.json({
      message: 'Departments retrieved successfully',
      departments: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.log('Database error for departments:', error.message);
    
    // Fallback: Get unique departments from doctors table
    try {
      const fallbackResult = await db.query(`
        SELECT department as name, COUNT(*) as doctor_count
        FROM doctors 
        WHERE is_available = true AND department IS NOT NULL
        GROUP BY department
        ORDER BY department
      `);
      
      res.json({
        message: 'Departments retrieved (from doctors table - departments table may not exist)',
        departments: fallbackResult.rows.map(dept => ({
          name: dept.name,
          doctor_count: parseInt(dept.doctor_count),
          description: `${dept.name} Department`,
          is_active: true
        })),
        count: fallbackResult.rows.length,
        note: 'Limited data - create departments table for full functionality'
      });
    } catch (fallbackError) {
      res.status(500).json({
        message: 'Failed to retrieve departments',
        error: error.message,
        suggestion: 'Create departments table and populate with department data'
      });
    }
  }
});

// Get department by ID or name
router.get('/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    const isNumeric = /^\d+$/.test(identifier);
    const column = isNumeric ? 'id' : 'name';
    
    const result = await db.query(`
      SELECT d.*, u.name as head_doctor_name, u.phone as head_doctor_phone
      FROM departments d
      LEFT JOIN users u ON d.head_doctor_id = u.id
      WHERE d.${column} = $1 AND d.is_active = true
    `, [identifier]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Department not found',
        identifier,
        searchedBy: column
      });
    }
    
    // Get doctors in this department
    const doctorsResult = await db.query(`
      SELECT u.id, u.name, u.phone, u.email,
             doc.specialization, doc.experience_years, doc.consultation_fee,
             doc.available_days, doc.available_hours, doc.is_available
      FROM users u
      JOIN doctors doc ON u.id = doc.user_id
      WHERE u.role = 'DOCTOR' AND doc.department = $1 AND doc.is_available = true
      ORDER BY u.name
    `, [result.rows[0].name]);
    
    res.json({
      message: 'Department retrieved successfully',
      department: {
        ...result.rows[0],
        doctors: doctorsResult.rows,
        doctor_count: doctorsResult.rows.length
      }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve department',
      error: error.message
    });
  }
});

// Get departments with available doctors
router.get('/available/now', async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
    
    const result = await db.query(`
      SELECT d.name, d.description, d.location,
             COUNT(doc.user_id) as available_doctors,
             STRING_AGG(u.name, ', ') as doctor_names
      FROM departments d
      LEFT JOIN doctors doc ON doc.department = d.name 
        AND doc.is_available = true 
        AND doc.available_days LIKE '%' || $1 || '%'
      LEFT JOIN users u ON doc.user_id = u.id
      WHERE d.is_active = true
      GROUP BY d.name, d.description, d.location
      HAVING COUNT(doc.user_id) > 0
      ORDER BY available_doctors DESC, d.name
    `, [today]);
    
    res.json({
      message: 'Departments with available doctors retrieved successfully',
      departments: result.rows,
      count: result.rows.length,
      current_day: today
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve available departments',
      error: error.message
    });
  }
});

// Create new department
router.post('/create', async (req, res) => {
  try {
    const { 
      name, description, head_doctor_id, contact_number, 
      location, is_active = true 
    } = req.body;
    
    if (!name || !description) {
      return res.status(400).json({
        message: 'Name and description are required'
      });
    }
    
    // Check if department already exists
    const existingDept = await db.query('SELECT id FROM departments WHERE name = $1', [name]);
    if (existingDept.rows.length > 0) {
      return res.status(409).json({
        message: 'Department with this name already exists'
      });
    }
    
    // Verify head doctor exists if provided
    if (head_doctor_id) {
      const doctorCheck = await db.query('SELECT id FROM users WHERE id = $1 AND role = $2', [head_doctor_id, 'DOCTOR']);
      if (doctorCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Head doctor not found' });
      }
    }
    
    const result = await db.query(`
      INSERT INTO departments (name, description, head_doctor_id, contact_number, location, is_active, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `, [name, description, head_doctor_id, contact_number, location, is_active]);
    
    res.status(201).json({
      message: 'Department created successfully',
      department: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create department',
      error: error.message
    });
  }
});

// Update department
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, description, head_doctor_id, contact_number, 
      location, is_active 
    } = req.body;
    
    // Verify head doctor exists if provided
    if (head_doctor_id) {
      const doctorCheck = await db.query('SELECT id FROM users WHERE id = $1 AND role = $2', [head_doctor_id, 'DOCTOR']);
      if (doctorCheck.rows.length === 0) {
        return res.status(404).json({ message: 'Head doctor not found' });
      }
    }
    
    const result = await db.query(`
      UPDATE departments SET 
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        head_doctor_id = COALESCE($3, head_doctor_id),
        contact_number = COALESCE($4, contact_number),
        location = COALESCE($5, location),
        is_active = COALESCE($6, is_active),
        updated_at = NOW()
      WHERE id = $7
      RETURNING *
    `, [name, description, head_doctor_id, contact_number, location, is_active, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Department not found' });
    }
    
    res.json({
      message: 'Department updated successfully',
      department: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update department',
      error: error.message
    });
  }
});

// Get department statistics
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get department info
    const deptResult = await db.query('SELECT name FROM departments WHERE id = $1', [id]);
    if (deptResult.rows.length === 0) {
      return res.status(404).json({ message: 'Department not found' });
    }
    
    const departmentName = deptResult.rows[0].name;
    
    // Get various statistics
    const [doctorStats, appointmentStats, recordStats] = await Promise.all([
      // Doctor statistics
      db.query(`
        SELECT 
          COUNT(*) as total_doctors,
          COUNT(CASE WHEN is_available = true THEN 1 END) as available_doctors,
          AVG(experience_years) as avg_experience,
          AVG(consultation_fee) as avg_consultation_fee
        FROM doctors 
        WHERE department = $1
      `, [departmentName]),
      
      // Appointment statistics (last 30 days)
      db.query(`
        SELECT 
          COUNT(*) as total_appointments,
          COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed_appointments,
          COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled_appointments
        FROM appointments a
        JOIN users d ON a.doctor_id = d.id
        JOIN doctors doc ON d.id = doc.user_id
        WHERE doc.department = $1 AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
      `, [departmentName]),
      
      // Medical records statistics (last 30 days)
      db.query(`
        SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT patient_id) as unique_patients
        FROM medical_records r
        JOIN users d ON r.doctor_id = d.id
        JOIN doctors doc ON d.id = doc.user_id
        WHERE doc.department = $1 AND r.created_at >= CURRENT_DATE - INTERVAL '30 days'
      `, [departmentName])
    ]);
    
    res.json({
      message: 'Department statistics retrieved successfully',
      department: departmentName,
      statistics: {
        doctors: doctorStats.rows[0],
        appointments_last_30_days: appointmentStats.rows[0],
        medical_records_last_30_days: recordStats.rows[0]
      },
      period: 'Last 30 days'
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve department statistics',
      error: error.message
    });
  }
});

export default router;