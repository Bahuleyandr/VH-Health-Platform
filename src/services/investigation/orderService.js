import db from '../../config/database.js';
import { 
  INVESTIGATION_TYPES, 
  PRIORITY_LEVELS 
} from '../../config/investigationConfig.js';
import logger from '../../logging/logger.js';

export const createInvestigationOrder = async (orderData) => {
  const { 
    patient_id, doctor_id, test_name, test_code, type, priority = 'NORMAL',
    scheduled_date, notes, normal_range, unit, cost, orderedBy
  } = orderData;
  
  if (!patient_id || !doctor_id || !test_name || !type) {
    throw new Error('MISSING_REQUIRED_FIELDS');
  }
  
  // Validate type and priority
  if (!Object.values(INVESTIGATION_TYPES).includes(type.toUpperCase())) {
    throw new Error('INVALID_TYPE');
  }
  
  if (!Object.values(PRIORITY_LEVELS).includes(priority.toUpperCase())) {
    throw new Error('INVALID_PRIORITY');
  }
  
  // Verify patient and doctor exist
  const [patientCheck, doctorCheck] = await Promise.all([
    db.query('SELECT id, name, phone FROM users WHERE id = $1', [patient_id]),
    db.query('SELECT id, name FROM users WHERE id = $1 AND role = $2', [doctor_id, 'DOCTOR'])
  ]);
  
  if (patientCheck.rows.length === 0) {
    throw new Error('PATIENT_NOT_FOUND');
  }
  if (doctorCheck.rows.length === 0) {
    throw new Error('DOCTOR_NOT_FOUND');
  }
  
  const client = await db.getClient();
try {
  await client.query('BEGIN');
  
  const result = await client.query(`
    INSERT INTO investigations (
      patient_id, doctor_id, test_name, test_code, type, priority,
      scheduled_date, notes, normal_range, unit, cost, status,
      ordered_date, created_at, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING', NOW(), NOW(), $12)
    RETURNING *
  `, [patient_id, doctor_id, test_name, test_code, type.toUpperCase(), priority.toUpperCase(),
      scheduled_date, notes, normal_range, unit, cost, orderedBy]);
  
  // Create notification for patient
  await db.query(
    `INSERT INTO notifications (phone, title, body, type, created_at, read, created_by)
     VALUES ($1, $2, $3, $4, NOW(), false, $5)`,
    [ patientCheck.rows[0].phone || 'unknown',
      'New Investigation Ordered',
      `Your doctor has ordered: ${test_name}. Please check your appointments.`,
      'investigation_ordered',
      orderedBy
    ]
  );
 
  await client.query('COMMIT');
  
  return {
    investigation: result.rows[0],
    patient_name: patientCheck.rows[0].name,
    doctor_name: doctorCheck.rows[0].name
  };
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  }

  logger.info(`Investigation ordered: ${test_name} for patient ${patient_id} by ${orderedBy}`);
  
  return {
    investigation: result.rows[0],
    patient_name: patientCheck.rows[0].name,
    doctor_name: doctorCheck.rows[0].name
  };
};

export const createLegacyInvestigation = async ({ phone, test_name, file_key, createdBy }) => {
  const result = await db.query(
    'INSERT INTO investigations (phone, test_name, file_key, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
    [phone, test_name, file_key || null, createdBy]
  );

  // Save notification
  await db.query(
    `INSERT INTO notifications (phone, title, body, type, created_at, read, created_by)
     VALUES ($1, $2, $3, $4, NOW(), false, $5)`,
    [
      phone,
      'Investigation Report Ready',
      `Your investigation report for "${test_name}" is now available.`,
      'investigation_ready',
      createdBy
    ]
  );

  logger.info(`Legacy investigation created: ${test_name} for ${phone}`);

  return result.rows[0];
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN'].includes(userRole);
};