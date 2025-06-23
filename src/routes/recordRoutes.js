// src/routes/recordRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ recordRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Medical records routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all medical records with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const patient_id = req.query.patient_id;
    const doctor_id = req.query.doctor_id;
    const record_type = req.query.type; // CONSULTATION, PRESCRIPTION, LAB_RESULT, etc.
    
    let query = `
      SELECT r.id, r.record_type, r.title, r.description, r.diagnosis, 
             r.treatment, r.medications, r.created_at, r.updated_at,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
             d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
             dp.specialization, dp.department
      FROM medical_records r
      LEFT JOIN users p ON r.patient_id = p.id
      LEFT JOIN users d ON r.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE 1=1
    `;
    let params = [];
    
    if (patient_id) {
      query += ' AND r.patient_id = $' + (params.length + 1);
      params.push(patient_id);
    }
    
    if (doctor_id) {
      query += ' AND r.doctor_id = $' + (params.length + 1);
      params.push(doctor_id);
    }
    
    if (record_type) {
      query += ' AND r.record_type = $' + (params.length + 1);
      params.push(record_type.toUpperCase());
    }
    
    query += ' ORDER BY r.created_at DESC LIMIT  + (params.length + 1) + ' OFFSET  + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM medical_records r WHERE 1=1';
    let countParams = [];
    
    if (patient_id) {
      countQuery += ' AND r.patient_id =  + (countParams.length + 1);
      countParams.push(patient_id);
    }
    if (doctor_id) {
      countQuery += ' AND r.doctor_id =  + (countParams.length + 1);
      countParams.push(doctor_id);
    }
    if (record_type) {
      countQuery += ' AND r.record_type =  + (countParams.length + 1);
      countParams.push(record_type.toUpperCase());
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalRecords = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Medical records retrieved successfully',
      records: result.rows,
      pagination: {
        page,
        limit,
        total: totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasNext: page * limit < totalRecords,
        hasPrev: page > 1
      },
      filters: {
        patient_id: patient_id || null,
        doctor_id: doctor_id || null,
        record_type: record_type || null
      }
    });
  } catch (error) {
    console.log('Database error for medical records:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve medical records - medical_records table may not exist',
      error: error.message,
      suggestion: 'Create medical_records table or check database schema'
    });
  }
});

// Get medical record by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      SELECT r.*, 
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender, p.address,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             dp.specialization, dp.department
      FROM medical_records r
      LEFT JOIN users p ON r.patient_id = p.id
      LEFT JOIN users d ON r.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE r.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Medical record not found',
        id
      });
    }
    
    res.json({
      message: 'Medical record retrieved successfully',
      record: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve medical record',
      error: error.message
    });
  }
});

// Get medical records for a specific patient
router.get('/patient/:patient_id', async (req, res) => {
  try {
    const { patient_id } = req.params;
    const record_type = req.query.type;
    const limit = parseInt(req.query.limit) || 20;
    
    let query = `
      SELECT r.id, r.record_type, r.title, r.description, r.diagnosis, 
             r.treatment, r.medications, r.created_at,
             d.name as doctor_name, dp.specialization, dp.department
      FROM medical_records r
      LEFT JOIN users d ON r.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE r.patient_id = $1
    `;
    let params = [patient_id];
    
    if (record_type) {
      query += ' AND r.record_type = $2';
      params.push(record_type.toUpperCase());
    }
    
    query += ' ORDER BY r.created_at DESC LIMIT  + (params.length + 1);
    params.push(limit);
    
    const result = await db.query(query, params);
    
    // Get patient info
    const patientInfo = await db.query(
      'SELECT name, phone, email, birthday, gender FROM users WHERE id = $1',
      [patient_id]
    );
    
    res.json({
      message: `Medical records for patient retrieved successfully`,
      records: result.rows,
      count: result.rows.length,
      patient: patientInfo.rows[0] || null,
      filter: record_type ? { type: record_type } : null
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient medical records',
      error: error.message
    });
  }
});

// Get medical records created by a specific doctor
router.get('/doctor/:doctor_id', async (req, res) => {
  try {
    const { doctor_id } = req.params;
    const date = req.query.date; // Optional date filter
    const limit = parseInt(req.query.limit) || 20;
    
    let query = `
      SELECT r.id, r.record_type, r.title, r.diagnosis, r.created_at,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id
      FROM medical_records r
      LEFT JOIN users p ON r.patient_id = p.id
      WHERE r.doctor_id = $1
    `;
    let params = [doctor_id];
    
    if (date) {
      query += ' AND DATE(r.created_at) = $2';
      params.push(date);
    }
    
    query += ' ORDER BY r.created_at DESC LIMIT  + (params.length + 1);
    params.push(limit);
    
    const result = await db.query(query, params);
    
    res.json({
      message: `Medical records by doctor retrieved successfully`,
      records: result.rows,
      count: result.rows.length,
      doctor_id,
      filter: date ? { date } : null
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve doctor medical records',
      error: error.message
    });
  }
});

// Create new medical record
router.post('/create', async (req, res) => {
  try {
    const { 
      patient_id, doctor_id, record_type, title, description,
      diagnosis, treatment, medications, lab_results, attachments 
    } = req.body;
    
    // Validation
    if (!patient_id || !doctor_id || !record_type || !title) {
      return res.status(400).json({
        message: 'patient_id, doctor_id, record_type, and title are required'
      });
    }
    
    const validTypes = ['CONSULTATION', 'PRESCRIPTION', 'LAB_RESULT', 'IMAGING', 'SURGERY', 'DISCHARGE', 'EMERGENCY'];
    if (!validTypes.includes(record_type.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid record type',
        validTypes
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
      INSERT INTO medical_records (
        patient_id, doctor_id, record_type, title, description,
        diagnosis, treatment, medications, lab_results, attachments, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *
    `, [patient_id, doctor_id, record_type.toUpperCase(), title, description,
        diagnosis, treatment, medications, lab_results, attachments]);
    
    res.status(201).json({
      message: 'Medical record created successfully',
      record: result.rows[0],
      patient_name: patientCheck.rows[0].name,
      doctor_name: doctorCheck.rows[0].name
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create medical record',
      error: error.message
    });
  }
});

// Update medical record
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      title, description, diagnosis, treatment, 
      medications, lab_results, attachments 
    } = req.body;
    
    const result = await db.query(`
      UPDATE medical_records SET 
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        diagnosis = COALESCE($3, diagnosis),
        treatment = COALESCE($4, treatment),
        medications = COALESCE($5, medications),
        lab_results = COALESCE($6, lab_results),
        attachments = COALESCE($7, attachments),
        updated_at = NOW()
      WHERE id = $8
      RETURNING *
    `, [title, description, diagnosis, treatment, medications, lab_results, attachments, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Medical record not found' });
    }
    
    res.json({
      message: 'Medical record updated successfully',
      record: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update medical record',
      error: error.message
    });
  }
});

// Get patient summary (aggregated medical data)
router.get('/patient/:patient_id/summary', async (req, res) => {
  try {
    const { patient_id } = req.params;
    
    // Get record counts by type
    const recordStats = await db.query(`
      SELECT record_type, COUNT(*) as count
      FROM medical_records 
      WHERE patient_id = $1 
      GROUP BY record_type
    `, [patient_id]);
    
    // Get recent records
    const recentRecords = await db.query(`
      SELECT r.id, r.record_type, r.title, r.created_at,
             d.name as doctor_name, dp.specialization
      FROM medical_records r
      LEFT JOIN users d ON r.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE r.patient_id = $1
      ORDER BY r.created_at DESC
      LIMIT 5
    `, [patient_id]);
    
    // Get patient basic info
    const patientInfo = await db.query(
      'SELECT name, phone, email, birthday, gender, address FROM users WHERE id = $1',
      [patient_id]
    );
    
    if (patientInfo.rows.length === 0) {
      return res.status(404).json({ message: 'Patient not found' });
    }
    
    res.json({
      message: 'Patient medical summary retrieved successfully',
      patient: patientInfo.rows[0],
      record_statistics: recordStats.rows,
      recent_records: recentRecords.rows,
      total_records: recordStats.rows.reduce((sum, stat) => sum + parseInt(stat.count), 0)
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient summary',
      error: error.message
    });
  }
});

export default router;