// src/services/health/healthRecordService.js
import { DEFAULT_PAGINATION } from '../../config/healthConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';


export async function getHealthRecords(filters, userRole, userId) {
  try {
    const {
      page = 1,
      limit = DEFAULT_PAGINATION.DEFAULT_LIMIT,
      patient_id,
      type,
      date_from,
      date_to
    } = filters;
    
    const offset = (page - 1) * limit;
    
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
    const params = [];
    let paramIndex = 1;
    
    // Apply role-based filtering for doctors
    if (userRole === 'DOCTOR') {
      query += ` AND (h.recorded_by = $${paramIndex} OR EXISTS (SELECT 1 FROM appointments WHERE doctor_id = $${paramIndex} AND patient_id = h.patient_id))`;
      params.push(userId);
      paramIndex++;
    }
    
    if (patient_id) {
      query += ` AND h.patient_id = $${paramIndex}`;
      params.push(patient_id);
      paramIndex++;
    }
    
    if (type) {
      query += ` AND h.record_type = $${paramIndex}`;
      params.push(type.toUpperCase());
      paramIndex++;
    }
    
    if (date_from) {
      query += ` AND DATE(h.recorded_date) >= $${paramIndex}`;
      params.push(date_from);
      paramIndex++;
    }
    
    if (date_to) {
      query += ` AND DATE(h.recorded_date) <= $${paramIndex}`;
      params.push(date_to);
      paramIndex++;
    }
    
    query += ` ORDER BY h.recorded_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const [records, countResult] = await Promise.all([
      prisma.$queryRawUnsafe(query, params),
      getHealthRecordsCount(filters, userRole, userId)
    ]);
    
    const totalRecords = countResult;
    
    return {
      records: records,
      pagination: {
        page,
        limit,
        total: totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasNext: page * limit < totalRecords,
        hasPrev: page > 1
      }
    };
  } catch (error) {
    logger.error(`[HealthRecordService] Error getting health records: ${error.message}`);
    throw error;
  }
}

async function getHealthRecordsCount(filters, userRole, userId) {
  const { patient_id, type, date_from, date_to } = filters;
  
  let query = 'SELECT COUNT(*) FROM health_records h WHERE 1=1';
  const params = [];
  let paramIndex = 1;
  
  if (userRole === 'DOCTOR') {
    query += ` AND (h.recorded_by = $${paramIndex} OR EXISTS (SELECT 1 FROM appointments WHERE doctor_id = $${paramIndex} AND patient_id = h.patient_id))`;
    params.push(userId);
    paramIndex++;
  }
  
  if (patient_id) {
    query += ` AND h.patient_id = $${paramIndex}`;
    params.push(patient_id);
    paramIndex++;
  }
  
  if (type) {
    query += ` AND h.record_type = $${paramIndex}`;
    params.push(type.toUpperCase());
    paramIndex++;
  }
  
  if (date_from) {
    query += ` AND DATE(h.recorded_date) >= $${paramIndex}`;
    params.push(date_from);
    paramIndex++;
  }
  
  if (date_to) {
    query += ` AND DATE(h.recorded_date) <= $${paramIndex}`;
    params.push(date_to);
    paramIndex++;
  }
  
  const result = await prisma.$queryRawUnsafe(query, params);
  return parseInt(result[0].count);
}

export async function getHealthRecordById(id, userRole, userId) {
  let query = `
    SELECT h.*, 
           p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
           p.birthday, p.gender,
           r.name as recorded_by_name, r.role as recorded_by_role
    FROM health_records h
    LEFT JOIN users p ON h.patient_id = p.id
    LEFT JOIN users r ON h.recorded_by = r.id
    WHERE h.id = $1
  `;
  const params = [id];
  
  if (userRole === 'DOCTOR') {
    query += ' AND (h.recorded_by = $2 OR EXISTS (SELECT 1 FROM appointments WHERE doctor_id = $2 AND patient_id = h.patient_id))';
    params.push(userId);
  }
  
  const result = await prisma.$queryRawUnsafe(query, params);
  return result[0];
}

export async function createHealthRecord(data, recorderId) {
  const { 
    patient_id, 
    record_type = 'VITALS', 
    vital_signs = {}, 
    measurements = {}, 
    symptoms, 
    notes 
  } = data;
  
  // Verify patient and recorder exist
  const [patientCheck, recorderCheck] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT id, name FROM users WHERE id = $1', [patient_id]),
    prisma.$queryRawUnsafe('SELECT id, name FROM users WHERE id = $1', [recorderId])
  ]);
  
  if (patientCheck.length === 0) {
    throw new Error('Patient not found');
  }
  if (recorderCheck.length === 0) {
    throw new Error('Recorder user not found');
  }
  
  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO health_records (
      patient_id, record_type, recorded_by, vital_signs, 
      measurements, symptoms, notes, recorded_date, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    RETURNING id, uid, patient_name, record_type, description, file_url, doctor_name, notes, created_at, updated_at
  `, [
    patient_id, 
    record_type.toUpperCase(), 
    recorderId,
    JSON.stringify(vital_signs), 
    JSON.stringify(measurements), 
    symptoms, 
    notes
  ]);
  
  return {
    record: result[0],
    patient: patientCheck[0],
    recorder: recorderCheck[0]
  };
}

export async function updateHealthRecord(id, data, userId, userRole) {
  // Check if record exists and user has permission
  const recordCheck = await prisma.$queryRawUnsafe('SELECT recorded_by FROM health_records WHERE id = $1', [id]);
  if (recordCheck.length === 0) {
    throw new Error('Health record not found');
  }
  
  // Only the original recorder or admin can modify
  if (userRole !== 'ADMIN' && recordCheck[0].recorded_by !== userId) {
    throw new Error('Can only update records you created');
  }
  
  const { vital_signs, measurements, symptoms, notes } = data;
  
  const result = await prisma.$queryRawUnsafe(`
    UPDATE health_records SET 
      vital_signs = COALESCE($1, vital_signs),
      measurements = COALESCE($2, measurements),
      symptoms = COALESCE($3, symptoms),
      notes = COALESCE($4, notes),
      updated_at = NOW()
    WHERE id = $5
    RETURNING id, uid, patient_name, record_type, description, file_url, doctor_name, notes, created_at, updated_at
  `, [
    vital_signs ? JSON.stringify(vital_signs) : null,
    measurements ? JSON.stringify(measurements) : null,
    symptoms, 
    notes, 
    id
  ]);
  
  return result[0];
}

export async function checkDoctorPatientAccess(doctorId, patientId) {
  const result = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM appointments WHERE doctor_id = $1 AND patient_id = $2 LIMIT 1',
    [doctorId, patientId]
  );
  return result.length > 0;
}