// src/routes/healthRoutes.js - PRODUCTION VERSION
import express from 'express';
import db from '../config/database.js';

const router = express.Router();
console.log('✅ healthRoutes loaded');

// Test route
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Health routes working!',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Get all health records with filtering and pagination
router.get('/vitals', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const patient_id = req.query.patient_id;
    const type = req.query.type; // VITALS, MEDICATION, ALLERGY, CONDITION
    const date_from = req.query.date_from;
    const date_to = req.query.date_to;
    
    let query = `
      SELECT h.id, h.patient_id, h.record_type, h.recorded_date, h.recorded_by,
             h.vital_signs, h.measurements, h.symptoms, h.notes,
             p.name as patient_name, p.phone as patient_phone,
             r.name as recorded_by_name
      FROM health_records h
      LEFT JOIN users p ON h.patient_id = p.id
      LEFT JOIN users r ON h.recorded_by = r.id
      WHERE 1=1
    `;
    let params = [];
    
    if (patient_id) {
      query += ' AND h.patient_id =  + (params.length + 1);
      params.push(patient_id);
    }
    
    if (type) {
      query += ' AND h.record_type =  + (params.length + 1);
      params.push(type.toUpperCase());
    }
    
    if (date_from) {
      query += ' AND DATE(h.recorded_date) >=  + (params.length + 1);
      params.push(date_from);
    }
    
    if (date_to) {
      query += ' AND DATE(h.recorded_date) <=  + (params.length + 1);
      params.push(date_to);
    }
    
    query += ' ORDER BY h.recorded_date DESC LIMIT  + (params.length + 1) + ' OFFSET  + (params.length + 2);
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM health_records h WHERE 1=1';
    let countParams = [];
    
    if (patient_id) {
      countQuery += ' AND h.patient_id =  + (countParams.length + 1);
      countParams.push(patient_id);
    }
    if (type) {
      countQuery += ' AND h.record_type =  + (countParams.length + 1);
      countParams.push(type.toUpperCase());
    }
    if (date_from) {
      countQuery += ' AND DATE(h.recorded_date) >=  + (countParams.length + 1);
      countParams.push(date_from);
    }
    if (date_to) {
      countQuery += ' AND DATE(h.recorded_date) <=  + (countParams.length + 1);
      countParams.push(date_to);
    }
    
    const countResult = await db.query(countQuery, countParams);
    const totalRecords = parseInt(countResult.rows[0].count);
    
    res.json({
      message: 'Health records retrieved successfully',
      health_records: result.rows,
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
        type: type || null,
        date_from: date_from || null,
        date_to: date_to || null
      }
    });
  } catch (error) {
    console.log('Database error for health records:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve health records - health_records table may not exist',
      error: error.message,
      suggestion: 'Create health_records table for patient health tracking'
    });
  }
});

// Get health record by ID
router.get('/vitals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      SELECT h.*, 
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender,
             r.name as recorded_by_name, r.role as recorded_by_role
      FROM health_records h
      LEFT JOIN users p ON h.patient_id = p.id
      LEFT JOIN users r ON h.recorded_by = r.id
      WHERE h.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ 
        message: 'Health record not found',
        id
      });
    }
    
    res.json({
      message: 'Health record retrieved successfully',
      health_record: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve health record',
      error: error.message
    });
  }
});

// Get patient health summary
router.get('/patient/:patient_id/summary', async (req, res) => {
  try {
    const { patient_id } = req.params;
    const days = parseInt(req.query.days) || 30;
    
    // Get patient basic info
    const patientInfo = await db.query(
      'SELECT name, phone, email, birthday, gender FROM users WHERE id = $1',
      [patient_id]
    );
    
    if (patientInfo.rows.length === 0) {
      return res.status(404).json({ message: 'Patient not found' });
    }
    
    // Get latest vitals
    const latestVitals = await db.query(`
      SELECT vital_signs, measurements, recorded_date, recorded_by_name
      FROM (
        SELECT h.vital_signs, h.measurements, h.recorded_date,
               r.name as recorded_by_name,
               ROW_NUMBER() OVER (ORDER BY h.recorded_date DESC) as rn
        FROM health_records h
        LEFT JOIN users r ON h.recorded_by = r.id
        WHERE h.patient_id = $1 AND h.record_type = 'VITALS'
      ) ranked
      WHERE rn = 1
    `, [patient_id]);
    
    // Get vital trends (last 30 days)
    const vitalTrends = await db.query(`
      SELECT DATE(recorded_date) as date, vital_signs, measurements
      FROM health_records 
      WHERE patient_id = $1 AND record_type = 'VITALS'
        AND recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY recorded_date DESC
    `, [patient_id]);
    
    // Get active conditions
    const activeConditions = await db.query(`
      SELECT id, symptoms, notes, recorded_date
      FROM health_records 
      WHERE patient_id = $1 AND record_type = 'CONDITION'
      ORDER BY recorded_date DESC
      LIMIT 10
    `, [patient_id]);
    
    // Get medication history
    const medications = await db.query(`
      SELECT id, notes as medication_details, recorded_date
      FROM health_records 
      WHERE patient_id = $1 AND record_type = 'MEDICATION'
      ORDER BY recorded_date DESC
      LIMIT 10
    `, [patient_id]);
    
    res.json({
      message: 'Patient health summary retrieved successfully',
      patient: patientInfo.rows[0],
      latest_vitals: latestVitals.rows[0] || null,
      vital_trends: vitalTrends.rows,
      active_conditions: activeConditions.rows,
      recent_medications: medications.rows,
      summary_period_days: days
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient health summary',
      error: error.message
    });
  }
});

// Record new health data
router.post('/vitals', async (req, res) => {
  try {
    const { 
      patient_id, record_type = 'VITALS', recorded_by,
      vital_signs = {}, measurements = {}, symptoms, notes 
    } = req.body;
    
    if (!patient_id || !recorded_by) {
      return res.status(400).json({
        message: 'patient_id and recorded_by are required'
      });
    }
    
    const validTypes = ['VITALS', 'MEDICATION', 'ALLERGY', 'CONDITION', 'SYMPTOM'];
    if (!validTypes.includes(record_type.toUpperCase())) {
      return res.status(400).json({
        message: 'Invalid record type',
        validTypes
      });
    }
    
    // Verify patient and recorder exist
    const patientCheck = await db.query('SELECT id, name FROM users WHERE id = $1', [patient_id]);
    const recorderCheck = await db.query('SELECT id, name FROM users WHERE id = $1', [recorded_by]);
    
    if (patientCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Patient not found' });
    }
    if (recorderCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Recorder user not found' });
    }
    
    const result = await db.query(`
      INSERT INTO health_records (
        patient_id, record_type, recorded_by, vital_signs, 
        measurements, symptoms, notes, recorded_date, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *
    `, [patient_id, record_type.toUpperCase(), recorded_by,
        JSON.stringify(vital_signs), JSON.stringify(measurements), symptoms, notes]);
    
    res.status(201).json({
      message: 'Health record created successfully',
      health_record: result.rows[0],
      patient_name: patientCheck.rows[0].name,
      recorded_by_name: recorderCheck.rows[0].name
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to create health record',
      error: error.message
    });
  }
});

// Update health record
router.put('/vitals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { vital_signs, measurements, symptoms, notes } = req.body;
    
    const result = await db.query(`
      UPDATE health_records SET 
        vital_signs = COALESCE($1, vital_signs),
        measurements = COALESCE($2, measurements),
        symptoms = COALESCE($3, symptoms),
        notes = COALESCE($4, notes),
        updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `, [
      vital_signs ? JSON.stringify(vital_signs) : null,
      measurements ? JSON.stringify(measurements) : null,
      symptoms, notes, id
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Health record not found' });
    }
    
    res.json({
      message: 'Health record updated successfully',
      health_record: result.rows[0]
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to update health record',
      error: error.message
    });
  }
});

// Get patient vital trends
router.get('/patient/:patient_id/trends', async (req, res) => {
  try {
    const { patient_id } = req.params;
    const days = parseInt(req.query.days) || 30;
    const vital_type = req.query.vital_type; // blood_pressure, heart_rate, temperature, etc.
    
    let query = `
      SELECT DATE(recorded_date) as date, vital_signs, measurements, recorded_date
      FROM health_records 
      WHERE patient_id = $1 AND record_type = 'VITALS'
        AND recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
    `;
    let params = [patient_id];
    
    query += ' ORDER BY recorded_date ASC';
    
    const result = await db.query(query, params);
    
    // Process data to extract specific vital trends
    const trends = result.rows.map(record => {
      let vitalSigns = {};
      try {
        vitalSigns = typeof record.vital_signs === 'string' 
          ? JSON.parse(record.vital_signs) 
          : record.vital_signs || {};
      } catch (e) {
        vitalSigns = {};
      }
      
      let measurements = {};
      try {
        measurements = typeof record.measurements === 'string'
          ? JSON.parse(record.measurements)
          : record.measurements || {};
      } catch (e) {
        measurements = {};
      }
      
      return {
        date: record.date,
        recorded_date: record.recorded_date,
        vital_signs: vitalSigns,
        measurements: measurements
      };
    });
    
    // Filter by specific vital type if requested
    let filteredData = trends;
    if (vital_type && trends.length > 0) {
      filteredData = trends.map(trend => ({
        date: trend.date,
        recorded_date: trend.recorded_date,
        value: trend.vital_signs[vital_type] || trend.measurements[vital_type] || null
      })).filter(item => item.value !== null);
    }
    
    res.json({
      message: 'Patient vital trends retrieved successfully',
      trends: filteredData,
      count: filteredData.length,
      patient_id,
      period_days: days,
      vital_type: vital_type || 'all'
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve vital trends',
      error: error.message
    });
  }
});

// Get allergies for patient
router.get('/patient/:patient_id/allergies', async (req, res) => {
  try {
    const { patient_id } = req.params;
    
    const result = await db.query(`
      SELECT h.id, h.symptoms, h.notes, h.recorded_date,
             r.name as recorded_by_name
      FROM health_records h
      LEFT JOIN users r ON h.recorded_by = r.id
      WHERE h.patient_id = $1 AND h.record_type = 'ALLERGY'
      ORDER BY h.recorded_date DESC
    `, [patient_id]);
    
    // Get patient info
    const patientInfo = await db.query(
      'SELECT name, phone FROM users WHERE id = $1',
      [patient_id]
    );
    
    res.json({
      message: 'Patient allergies retrieved successfully',
      allergies: result.rows,
      count: result.rows.length,
      patient: patientInfo.rows[0] || null
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient allergies',
      error: error.message
    });
  }
});

// Get patient conditions
router.get('/patient/:patient_id/conditions', async (req, res) => {
  try {
    const { patient_id } = req.params;
    const active_only = req.query.active_only === 'true';
    
    let query = `
      SELECT h.id, h.symptoms, h.notes, h.recorded_date,
             r.name as recorded_by_name, r.role as recorded_by_role
      FROM health_records h
      LEFT JOIN users r ON h.recorded_by = r.id
      WHERE h.patient_id = $1 AND h.record_type = 'CONDITION'
    `;
    let params = [patient_id];
    
    if (active_only) {
      query += ' AND h.recorded_date >= CURRENT_DATE - INTERVAL \'180 days\'';
    }
    
    query += ' ORDER BY h.recorded_date DESC';
    
    const result = await db.query(query, params);
    
    res.json({
      message: 'Patient conditions retrieved successfully',
      conditions: result.rows,
      count: result.rows.length,
      patient_id,
      active_only
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve patient conditions',
      error: error.message
    });
  }
});

// Get health statistics
router.get('/stats/overview', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    
    const [recordStats, typeStats, dailyActivity] = await Promise.all([
      // Total health record statistics
      db.query(`
        SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT patient_id) as unique_patients,
          COUNT(CASE WHEN recorded_date >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_records
        FROM health_records
      `),
      
      // Record type breakdown
      db.query(`
        SELECT record_type, COUNT(*) as count
        FROM health_records 
        WHERE recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY record_type
        ORDER BY count DESC
      `),
      
      // Daily activity
      db.query(`
        SELECT DATE(recorded_date) as date, COUNT(*) as records_count
        FROM health_records 
        WHERE recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY DATE(recorded_date)
        ORDER BY date DESC
      `)
    ]);
    
    res.json({
      message: 'Health statistics retrieved successfully',
      statistics: {
        totals: recordStats.rows[0],
        by_type: typeStats.rows,
        daily_activity: dailyActivity.rows
      },
      period_days: days,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.log('Database error:', error.message);
    res.status(500).json({
      message: 'Failed to retrieve health statistics',
      error: error.message
    });
  }
});

// System health check (API health, not patient health)
router.get('/system/status', (req, res) => {
  try {
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();
    
    res.json({
      message: 'System health check',
      status: 'healthy',
      uptime_seconds: Math.floor(uptime),
      uptime_formatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
      memory: {
        used_mb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        total_mb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external_mb: Math.round(memoryUsage.external / 1024 / 1024)
      },
      timestamp: new Date().toISOString(),
      node_version: process.version,
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    res.status(500).json({
      message: 'System health check failed',
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;