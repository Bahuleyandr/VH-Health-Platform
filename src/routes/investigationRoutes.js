// src/routes/investigationRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ investigationRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Investigation routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all investigations with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const patient_id = req.query.patient_id;
    const doctor_id = req.query.doctor_id;
    const type = req.query.type; // LAB, RADIOLOGY, PATHOLOGY, CARDIOLOGY, etc.
    const status = req.query.status; // PENDING, COMPLETED, CANCELLED
    const date = req.query.date; // YYYY-MM-DD
    
    let query = `
      SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
             i.ordered_date, i.scheduled_date, i.completed_date, i.results,
             i.normal_range, i.unit, i.notes, i.cost,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
             d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
             dept.specialization
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.doctor_id = d.id
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE 1=1
    `;
    let params = [];
    
    if (patient_id) {
      query += ' AND i.patient_id = $' + (params.length + 1);
      params.push(patient_id);
    }
    
    if (doctor_id) {
      query += ' AND i.doctor_id = $' + (params.length + 1);
      params.push(doctor_id);
    }
    
    if (type) {
      query += ' AND i.type = $' + (params.length + 1);
      params.push(type.toUpperCase());
    }
    
    if (status) {
      query += ' AND i.status = $' + (params.length + 1);
      params.push(status.toUpperCase());
    }
    
    if (date) {
      query += ' AND DATE(i.ordered_date) = $' + (params.length + 1);
      params.push(date);
    }
    
    query += ' ORDER BY i.ordered_date DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM investigations i WHERE 1=1';
    let countParams = [];
    
    if (patient_id) {
      countQuery += ' AND i.patient_id = $' + (countParams.length + 1);
      countParams.push(patient_id);
    }
    if (doctor_id) {
      countQuery += ' AND i.doctor_id = $' + (countParams.length + 1);
      countParams.push(doctor_id);
    }
    if (type) {
      countQuery += ' AND i.type = $' + (countParams.length + 1);
      countParams.push(type.toUpperCase());
    }
    if (status) {
      countQuery += ' AND i.status = $' + (countParams.length + 1);
      countParams.push(status.toUpperCase());
    }
    if (date) {
      countQuery += ' AND DATE(i.ordered_date) = $' + (countParams.length + 1);
      countParams.push(date);
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalInvestigations = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Investigations retrieved successfully',
      investigations: result.rows,
      pagination: {
        page,
        limit,
        total: totalInvestigations,
        totalPages: Math.ceil(totalInvestigations / limit),
        hasNext: page * limit < totalInvestigations,
        hasPrev: page > 1
      },
      filters: {
        patient_id: patient_id || null,
        doctor_id: doctor_id || null,
        type: type || null,
        status: status || null,
        date: date || null
      }
    });
  } catch (error) {
    console.log('Database error for investigations:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve investigations - investigations table may not exist',
      error: error.message,
      suggestion: 'Create investigations table for lab tests and imaging management'
    });
  }
});

// Get investigation by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      SELECT i.*, 
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             dept.specialization, dept.department
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.doctor_id = d.id
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE i.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Investigation not found',
        id
      });
    }
    
    res.json({
      message: 'Investigation retrieved successfully',
      investigation: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve investigation',
      error: error.message
    });
  }
});

// Get investigations for a specific patient
router.get('/patient/:patient_id', async (req, res) => {
  try {
    const { patient_id } = req.params;
    const type = req.query.type;
    const status = req.query.status;
    const limit = parseInt(req.query.limit) || 50;
    
    let query = `
      SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
             i.ordered_date, i.scheduled_date, i.completed_date, i.results,
             i.normal_range, i.unit, i.notes,
             d.name as doctor_name, dept.specialization
      FROM investigations i
      LEFT JOIN users d ON i.doctor_id = d.id
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE i.patient_id = $1
    `;
    let params = [patient_id];
    
    if (type) {
      query += ' AND i.type = $2';
      params.push(type.toUpperCase());
    }
    
    if (status) {
      query += ` AND i.status = $${params.length + 1}`;
      params.push(status.toUpperCase());
    }
    
    query += ' ORDER BY i.ordered_date DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    
    const result = await db.query(query, params);
    
    // Get patient info
    const patientInfo = await db.query(
      'SELECT name, phone, email, birthday, gender FROM users WHERE id = $1',
      [patient_id]
    );
    
    res.json({
      message: `Investigations for patient retrieved successfully`,
      investigations: result.rows,
      count: result.rows.length,
      patient: patientInfo.rows[0] || null,
      filters: {
        type: type || null,
        status: status || null
      }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient investigations',
      error: error.message
    });
  }
});

// Get investigations by doctor
router.get('/doctor/:doctor_id', async (req, res) => {
  try {
    const { doctor_id } = req.params;
    const date = req.query.date;
    const status = req.query.status || 'PENDING';
    
    let query = `
      SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
             i.ordered_date, i.scheduled_date, i.notes,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      WHERE i.doctor_id = $1 AND i.status = $2
    `;
    let params = [doctor_id, status.toUpperCase()];
    
    if (date) {
      query += ' AND DATE(i.ordered_date) = $3';
      params.push(date);
    }
    
    query += ' ORDER BY i.ordered_date DESC, i.priority DESC';
    
    const result = await db.query(query, params);
    
    res.json({
      message: `Investigations by doctor retrieved successfully`,
      investigations: result.rows,
      count: result.rows.length,
      doctor_id,
      filters: {
        status,
        date: date || null
      }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve doctor investigations',
      error: error.message
    });
  }
});

// Get investigations by type
router.get('/type/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const status = req.query.status;
    const date = req.query.date;
    
    let query = `
      SELECT i.id, i.test_name, i.test_code, i.status, i.priority,
             i.ordered_date, i.scheduled_date, i.completed_date,
             p.name as patient_name, p.phone as patient_phone,
             d.name as doctor_name
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.doctor_id = d.id
      WHERE i.type = $1
    `;
    let params = [type.toUpperCase()];
    
    if (status) {
      query += ' AND i.status = $2';
      params.push(status.toUpperCase());
    }
    
    if (date) {
      query += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
      params.push(date);
    }
    
    query += ' ORDER BY i.ordered_date DESC LIMIT 100';
    
    const result = await db.query(query, params);
    
    res.json({
      message: `${type} investigations retrieved successfully`,
      investigations: result.rows,
      count: result.rows.length,
      type: type.toUpperCase(),
      filters: {
        status: status || null,
        date: date || null
      }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve investigations by type',
      error: error.message
    });
  }
});

// Create new investigation order
router.post('/order', async (req, res) => {
  try {
    const { 
      patient_id, doctor_id, test_name, test_code, type, priority = 'NORMAL',
      scheduled_date, notes, normal_range, unit, cost 
    } = req.body;
    
    if (!patient_id || !doctor_id || !test_name || !type) {
      return res.status(400).json({
        message: 'patient_id, doctor_id, test_name, and type are required'
      });
    }
    
    const validTypes = ['LAB', 'RADIOLOGY', 'PATHOLOGY', 'CARDIOLOGY', 'PULMONARY', 'ENDOSCOPY'];
    const validPriorities = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
    
    if (!validTypes.includes(type.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid investigation type',
        validTypes
      });
    }
    
    if (!validPriorities.includes(priority.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid priority level',
        validPriorities
      });
    }
    
    // Verify patient and doctor exist
    const patientCheck = await db.query('SELECT id, name FROM users WHERE id = $1', [patient_id]);
    const doctorCheck = await db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [doctor_id, 'DOCTOR']);
    
    if (patientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Patient not found' });
    }
    if (doctorCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Doctor not found' });
    }
    
    const result = await db.query(`
      INSERT INTO investigations (
        patient_id, doctor_id, test_name, test_code, type, priority,
        scheduled_date, notes, normal_range, unit, cost, status,
        ordered_date, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', NOW(), NOW())
      RETURNING *
    `, [patient_id, doctor_id, test_name, test_code, type.toUpperCase(), priority.toUpperCase(),
        scheduled_date, notes, normal_range, unit, cost]);
    
    res.status(201).json({
      message: 'Investigation ordered successfully',
      investigation: result.rows[0],
      patient_name: patientCheck.rows[0].name,
      doctor_name: doctorCheck.rows[0].name
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to order investigation',
      error: error.message
    });
  }
});

// Update investigation status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const validStatuses = ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid status',
        validStatuses
      });
    }
    
    let updateFields = 'status = $1, notes = COALESCE($2, notes), updated_at = NOW()';
    let params = [status.toUpperCase(), notes, id];
    
    // Set completed_date if status is COMPLETED
    if (status.toUpperCase() === 'COMPLETED') {
      updateFields = 'status = $1, notes = COALESCE($2, notes), completed_date = NOW(), updated_at = NOW()';
    }
    
    const result = await db.query(`
      UPDATE investigations SET ${updateFields}
      WHERE id = $3
      RETURNING *
    `, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Investigation not found' });
    }
    
    res.json({
      message: 'Investigation status updated successfully',
      investigation: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update investigation status',
      error: error.message
    });
  }
});

// Add investigation results
router.put('/:id/results', async (req, res) => {
  try {
    const { id } = req.params;
    const { results, interpretation, technician_notes, reviewed_by } = req.body;
    
    if (!results) {
      return res.status(400).json({
        message: 'Results are required'
      });
    }
    
    const result = await db.query(`
      UPDATE investigations SET 
        results = $1,
        interpretation = COALESCE($2, interpretation),
        technician_notes = COALESCE($3, technician_notes),
        reviewed_by = COALESCE($4, reviewed_by),
        status = 'COMPLETED',
        completed_date = NOW(),
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [results, interpretation, technician_notes, reviewed_by, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Investigation not found' });
    }
    
    res.json({
      message: 'Investigation results added successfully',
      investigation: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to add investigation results',
      error: error.message
    });
  }
});

// Get pending investigations (for lab technicians)
router.get('/status/pending', async (req, res) => {
  try {
    const type = req.query.type; // Filter by investigation type
    const priority = req.query.priority;
    
    let query = `
      SELECT i.id, i.test_name, i.test_code, i.type, i.priority,
             i.ordered_date, i.scheduled_date, i.notes,
             p.name as patient_name, p.phone as patient_phone, p.gender,
             d.name as doctor_name, dept.department
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.doctor_id = d.id
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE i.status = 'PENDING'
    `;
    let params = [];
    
    if (type) {
      query += ' AND i.type = $' + (params.length + 1);
      params.push(type.toUpperCase());
    }
    
    if (priority) {
      query += ' AND i.priority = $' + (params.length + 1);
      params.push(priority.toUpperCase());
    }
    
    query += ' ORDER BY i.priority DESC, i.ordered_date ASC';
    
    const result = await db.query(query, params);
    
    res.json({
      message: 'Pending investigations retrieved successfully',
      investigations: result.rows,
      count: result.rows.length,
      filters: {
        type: type || null,
        priority: priority || null
      }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve pending investigations',
      error: error.message
    });
  }
});

// Get investigation statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    
    const [totalStats, typeStats, statusStats, dailyActivity] = await Promise.all([
      // Total investigation statistics
      db.query(`
        SELECT 
          COUNT(*) as total_investigations,
          COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending,
          COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
          COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled,
          COUNT(CASE WHEN ordered_date >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_orders,
          AVG(cost) as average_cost
        FROM investigations
      `),
      
      // Type breakdown
      db.query(`
        SELECT type, COUNT(*) as count
        FROM investigations 
        WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY type
        ORDER BY count DESC
      `),
      
      // Status distribution
      db.query(`
        SELECT status, COUNT(*) as count
        FROM investigations 
        WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY status
        ORDER BY count DESC
      `),
      
      // Daily activity
      db.query(`
        SELECT DATE(ordered_date) as date, COUNT(*) as investigations_ordered
        FROM investigations 
        WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY DATE(ordered_date)
        ORDER BY date DESC
      `)
    ]);
    
    res.json({
      message: 'Investigation statistics retrieved successfully',
      statistics: {
        totals: totalStats.rows[0],
        by_type: typeStats.rows,
        by_status: statusStats.rows,
        daily_activity: dailyActivity.rows
      },
      period_days: days,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve investigation statistics',
      error: error.message
    });
  }
});

export default router;