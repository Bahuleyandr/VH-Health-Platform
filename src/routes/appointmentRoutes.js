// src/routes/appointmentRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ appointmentRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Appointment routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all appointments with filtering and pagination
router.get('/list', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const status = req.query.status; // SCHEDULED, COMPLETED, CANCELLED
    const doctor_id = req.query.doctor_id;
    const patient_id = req.query.patient_id;
    const date = req.query.date; // YYYY-MM-DD format
    
    let query = `
      SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
             a.created_at, a.updated_at,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
             d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
             dp.specialization, dp.department
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id  
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE 1=1
    `;
    let params = [];
    
    if (status) {
      query += ' AND a.status = $' + (params.length + 1);
      params.push(status.toUpperCase());
    }
    
    if (doctor_id) {
      query += ' AND a.doctor_id = $' + (params.length + 1);
      params.push(doctor_id);
    }
    
    if (patient_id) {
      query += ' AND a.patient_id = $' + (params.length + 1);
      params.push(patient_id);
    }
    
    if (date) {
      query += ' AND DATE(a.appointment_date) = $' + (params.length + 1);
      params.push(date);
    }
    
    query += ' ORDER BY a.appointment_date, a.appointment_time LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM appointments a WHERE 1=1';
    let countParams = [];
    
    if (status) {
      countQuery += ' AND a.status = $' + (countParams.length + 1);
      countParams.push(status.toUpperCase());
    }
    if (doctor_id) {
      countQuery += ' AND a.doctor_id = $' + (countParams.length + 1);
      countParams.push(doctor_id);
    }
    if (patient_id) {
      countQuery += ' AND a.patient_id = $' + (countParams.length + 1);
      countParams.push(patient_id);
    }
    if (date) {
      countQuery += ' AND DATE(a.appointment_date) = $' + (countParams.length + 1);
      countParams.push(date);
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalAppointments = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Appointments retrieved successfully',
      appointments: result.rows,
      pagination: {
        page,
        limit,
        total: totalAppointments,
        totalPages: Math.ceil(totalAppointments / limit),
        hasNext: page * limit < totalAppointments,
        hasPrev: page > 1
      },
      filters: {
        status: status || null,
        doctor_id: doctor_id || null,
        patient_id: patient_id || null,
        date: date || null
      }
    });
  } catch (error) {
    console.log('Database error for appointments list:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve appointments - appointments table may not exist',
      error: error.message,
      suggestion: 'Create appointments table or check database schema'
    });
  }
});

// Get appointment by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      SELECT a.*, 
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             dp.specialization, dp.department, dp.consultation_fee
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE a.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Appointment not found',
        id
      });
    }
    
    res.json({
      message: 'Appointment retrieved successfully',
      appointment: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve appointment',
      error: error.message
    });
  }
});

// Get appointments for a specific doctor
router.get('/doctor/:doctor_id', async (req, res) => {
  try {
    const { doctor_id } = req.params;
    const date = req.query.date; // Optional date filter
    const status = req.query.status || 'SCHEDULED'; // Default to scheduled
    
    let query = `
      SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      WHERE a.doctor_id = $1 AND a.status = $2
    `;
    let params = [doctor_id, status.toUpperCase()];
    
    if (date) {
      query += ' AND DATE(a.appointment_date) = $3';
      params.push(date);
    }
    
    query += ' ORDER BY a.appointment_date, a.appointment_time';
    
    const result = await db.query(query, params);
    
    res.json({
      message: `Appointments for doctor retrieved successfully`,
      appointments: result.rows,
      count: result.rows.length,
      doctor_id,
      filters: { status, date: date || null }
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve doctor appointments',
      error: error.message
    });
  }
});

// Get appointments for a specific patient
router.get('/patient/:patient_id', async (req, res) => {
  try {
    const { patient_id } = req.params;
    const status = req.query.status; // Optional status filter
    
    let query = `
      SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
             d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
             dp.specialization, dp.department
      FROM appointments a
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE a.patient_id = $1
    `;
    let params = [patient_id];
    
    if (status) {
      query += ' AND a.status = $2';
      params.push(status.toUpperCase());
    }
    
    query += ' ORDER BY a.appointment_date DESC, a.appointment_time DESC';
    
    const result = await db.query(query, params);
    
    res.json({
      message: `Appointments for patient retrieved successfully`,
      appointments: result.rows,
      count: result.rows.length,
      patient_id,
      filter: status ? { status } : null
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient appointments',
      error: error.message
    });
  }
});

// Create new appointment
router.post('/book', async (req, res) => {
  try {
    const { 
      patient_id, doctor_id, appointment_date, appointment_time, 
      reason, notes = null 
    } = req.body;
    
    // Validation
    if (!patient_id || !doctor_id || !appointment_date || !appointment_time || !reason) {
      return res.status(400).json({
        message: 'patient_id, doctor_id, appointment_date, appointment_time, and reason are required'
      });
    }
    
    // Check if patient and doctor exist
    const patientCheck = await db.query('SELECT id, name FROM users WHERE id = $1', [patient_id]);
    const doctorCheck = await db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [doctor_id, 'DOCTOR']);
    
    if (patientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Patient not found' });
    }
    if (doctorCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Doctor not found' });
    }
    
    // Check for conflicting appointments
    const conflictCheck = await db.query(`
      SELECT id FROM appointments 
      WHERE doctor_id = $1 AND appointment_date = $2 AND appointment_time = $3 
      AND status = 'SCHEDULED'
    `, [doctor_id, appointment_date, appointment_time]);
    
    if (conflictCheck.rows.length > 0) {
      return res.status(409).json({
        message: 'Time slot already booked',
        conflicting_appointment_id: conflictCheck.rows[0].id
      });
    }
    
    const result = await db.query(`
      INSERT INTO appointments (
        patient_id, doctor_id, appointment_date, appointment_time, 
        reason, notes, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'SCHEDULED', NOW())
      RETURNING *
    `, [patient_id, doctor_id, appointment_date, appointment_time, reason, notes]);
    
    res.status(201).json({
      message: 'Appointment booked successfully',
      appointment: result.rows[0],
      patient_name: patientCheck.rows[0].name,
      doctor_name: doctorCheck.rows[0].name
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to book appointment',
      error: error.message
    });
  }
});

// Update appointment status
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const validStatuses = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
    if (!validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid status',
        validStatuses
      });
    }
    
    const result = await db.query(`
      UPDATE appointments SET 
        status = $1,
        notes = COALESCE($2, notes),
        updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [status.toUpperCase(), notes, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    
    res.json({
      message: 'Appointment status updated successfully',
      appointment: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update appointment status',
      error: error.message
    });
  }
});

// Get today's appointments
router.get('/today/list', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    const result = await db.query(`
      SELECT a.id, a.appointment_time, a.status, a.reason,
             p.name as patient_name, p.phone as patient_phone,
             d.name as doctor_name, dp.department
      FROM appointments a
      LEFT JOIN users p ON a.patient_id = p.id
      LEFT JOIN users d ON a.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE DATE(a.appointment_date) = $1
      ORDER BY a.appointment_time
    `, [today]);
    
    res.json({
      message: 'Today\'s appointments retrieved successfully',
      appointments: result.rows,
      count: result.rows.length,
      date: today
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve today\'s appointments',
      error: error.message
    });
  }
});

export default router;