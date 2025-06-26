// src/services/record/recordService.js
import db from '../../config/database.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { DEFAULT_PAGINATION } from '../../config/recordConfig.js';
import logger from '../../logging/logger.js';

export async function getRecordsByUID(uid) {
  try {
    const result = await db.query(
      'SELECT * FROM health_records WHERE uid = $1 ORDER BY created_at DESC',
      [uid]
    );
    return result.rows;
  } catch (error) {
    logger.error(`[RecordService] Error getting records by UID: ${error.message}`);
    throw error;
  }
}

export async function getHealthRecordsByPhone(phone, filters = {}) {
  try {
    const normalizedPhone = normalizePhone(phone);
    const { type, limit = DEFAULT_PAGINATION.DEFAULT_LIMIT, offset = DEFAULT_PAGINATION.DEFAULT_OFFSET } = filters;
    
    let query = `
      SELECT hr.*, 
             TO_CHAR(hr.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
             u.name as patient_name, u.uid as patient_uid
      FROM health_records hr
      LEFT JOIN users u ON hr.phone = u.phone
      WHERE hr.phone = $1
    `;
    let params = [normalizedPhone];

    if (type && typeof type === 'string') {
      query += ' AND LOWER(hr.file_type) = LOWER($2)';
      params.push(type);
    }

    query += ' ORDER BY hr.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    return result.rows;
  } catch (error) {
    logger.error(`[RecordService] Error getting health records by phone: ${error.message}`);
    throw error;
  }
}

export async function createHealthRecord(data, createdBy, createdByRole) {
  try {
    const { phone, file_key, file_name, file_type, privacy_level = 0, notes } = data;
    
    const result = await db.query(
      `INSERT INTO health_records (
        phone, file_key, file_name, file_type, privacy_level, notes, 
        created_by, created_by_role, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *`,
      [normalizePhone(phone), file_key, file_name, file_type, privacy_level, notes, createdBy, createdByRole]
    );
    
    return result.rows[0];
  } catch (error) {
    logger.error(`[RecordService] Error creating health record: ${error.message}`);
    throw error;
  }
}

export async function getMedicalRecords(filters = {}, userRole) {
  try {
    const {
      page = 1,
      limit = DEFAULT_PAGINATION.DEFAULT_LIMIT,
      patient_id,
      doctor_id,
      record_type,
      date_from,
      date_to
    } = filters;
    
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT mr.id, mr.record_type, mr.title, mr.description, mr.diagnosis, 
             mr.treatment, mr.medications, mr.privacy_level,
             TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
             TO_CHAR(mr.updated_at, 'DD-MM-YYYY HH24:MI') as updated_at_formatted,
             p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
             d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
             dp.specialization, dp.department
      FROM medical_records mr
      LEFT JOIN users p ON mr.patient_id = p.id
      LEFT JOIN users d ON mr.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;
    
    if (patient_id) {
      query += ` AND mr.patient_id = $${paramIndex++}`;
      params.push(patient_id);
    }
    
    if (doctor_id) {
      query += ` AND mr.doctor_id = $${paramIndex++}`;
      params.push(doctor_id);
    }
    
    if (record_type) {
      query += ` AND mr.record_type = $${paramIndex++}`;
      params.push(record_type.toUpperCase());
    }
    
    if (date_from) {
      query += ` AND DATE(mr.created_at) >= $${paramIndex++}`;
      params.push(date_from);
    }
    
    if (date_to) {
      query += ` AND DATE(mr.created_at) <= $${paramIndex++}`;
      params.push(date_to);
    }
    
    query += ` ORDER BY mr.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);
    
    const [records, countResult] = await Promise.all([
      db.query(query, params),
      db.query(
        `SELECT COUNT(*) FROM medical_records mr WHERE 1=1` +
        (patient_id ? ` AND mr.patient_id = ${patient_id}` : '') +
        (doctor_id ? ` AND mr.doctor_id = ${doctor_id}` : '') +
        (record_type ? ` AND mr.record_type = '${record_type.toUpperCase()}'` : '') +
        (date_from ? ` AND DATE(mr.created_at) >= '${date_from}'` : '') +
        (date_to ? ` AND DATE(mr.created_at) <= '${date_to}'` : '')
      )
    ]);
    
    const totalRecords = parseInt(countResult.rows[0].count);
    
    return {
      records: records.rows,
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
    logger.error(`[RecordService] Error getting medical records: ${error.message}`);
    throw error;
  }
}

export async function getMedicalRecordById(id) {
  try {
    const result = await db.query(`
      SELECT mr.*, 
             TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
             TO_CHAR(mr.updated_at, 'DD-MM-YYYY HH24:MI') as updated_at_formatted,
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender, p.address, p.uid as patient_uid,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             dp.specialization, dp.department
      FROM medical_records mr
      LEFT JOIN users p ON mr.patient_id = p.id
      LEFT JOIN users d ON mr.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE mr.id = $1
    `, [id]);
    
    return result.rows[0];
  } catch (error) {
    logger.error(`[RecordService] Error getting medical record by ID: ${error.message}`);
    throw error;
  }
}

export async function createMedicalRecord(data, doctorId, createdBy) {
  try {
    const { 
      patient_id, record_type, title, description,
      diagnosis, treatment, medications, lab_results, 
      attachments, privacy_level = 1
    } = data;
    
    // Verify patient exists
    const patientCheck = await db.query(
      'SELECT id, name, phone FROM users WHERE id = $1', 
      [patient_id]
    );
    
    if (patientCheck.rows.length === 0) {
      throw new Error('Patient not found');
    }
    
    const result = await db.query(`
      INSERT INTO medical_records (
        patient_id, doctor_id, record_type, title, description,
        diagnosis, treatment, medications, lab_results, attachments, 
        privacy_level, created_by, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      RETURNING *
    `, [
      patient_id, doctorId, record_type.toUpperCase(), title, description,
      diagnosis, treatment, medications, lab_results, attachments, 
      privacy_level, createdBy
    ]);
    
    return {
      record: result.rows[0],
      patient: patientCheck.rows[0]
    };
  } catch (error) {
    logger.error(`[RecordService] Error creating medical record: ${error.message}`);
    throw error;
  }
}

export async function updateMedicalRecord(id, data, updatedBy) {
  try {
    const { 
      title, description, diagnosis, treatment, 
      medications, lab_results, attachments 
    } = data;
    
    const result = await db.query(`
      UPDATE medical_records SET 
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        diagnosis = COALESCE($3, diagnosis),
        treatment = COALESCE($4, treatment),
        medications = COALESCE($5, medications),
        lab_results = COALESCE($6, lab_results),
        attachments = COALESCE($7, attachments),
        updated_at = NOW(),
        updated_by = $9
      WHERE id = $8
      RETURNING *
    `, [title, description, diagnosis, treatment, medications, lab_results, attachments, id, updatedBy]);
    
    return result.rows[0];
  } catch (error) {
    logger.error(`[RecordService] Error updating medical record: ${error.message}`);
    throw error;
  }
}

export async function softDeleteRecord(id, deletedBy, reason) {
  try {
    const result = await db.query(
      'UPDATE medical_records SET is_active = false, deleted_at = NOW(), deleted_by = $2 WHERE id = $1 RETURNING id, title',
      [id, deletedBy]
    );
    
    return result.rows[0];
  } catch (error) {
    logger.error(`[RecordService] Error deleting medical record: ${error.message}`);
    throw error;
  }
}

export async function getPatientSummary(patientId, privacyFilter = '') {
  try {
    const [recordStats, recentRecords, patientInfo] = await Promise.all([
      // Get record counts by type
      db.query(`
        SELECT record_type, COUNT(*) as count,
               MAX(created_at) as last_record
        FROM medical_records 
        WHERE patient_id = $1 ${privacyFilter}
        GROUP BY record_type
      `, [patientId]),
      
      // Get recent records
      db.query(`
        SELECT mr.id, mr.record_type, mr.title, mr.privacy_level,
               TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') as created_at_formatted,
               d.name as doctor_name, dp.specialization
        FROM medical_records mr
        LEFT JOIN users d ON mr.doctor_id = d.id
        LEFT JOIN doctors dp ON d.id = dp.user_id
        WHERE mr.patient_id = $1 ${privacyFilter}
        ORDER BY mr.created_at DESC
        LIMIT 5
      `, [patientId]),
      
      // Get patient basic info
      db.query(
        'SELECT name, phone, email, birthday, gender, address FROM users WHERE id = $1',
        [patientId]
      )
    ]);
    
    return {
      patient: patientInfo.rows[0],
      recordStats: recordStats.rows,
      recentRecords: recentRecords.rows
    };
  } catch (error) {
    logger.error(`[RecordService] Error getting patient summary: ${error.message}`);
    throw error;
  }
}