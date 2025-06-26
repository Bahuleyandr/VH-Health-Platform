import db from '../../config/database.js';
import { 
  INVESTIGATION_STATUS, 
  INVESTIGATION_TYPES, 
  PRIORITY_LEVELS,
  MEDICAL_STAFF_ROLES,
  LAB_STAFF_ROLES 
} from '../../config/investigationConfig.js';
import logger from '../../logging/logger.js';

// Get investigations with filtering
export const getInvestigations = async (page, limit, filters, userRole, userId) => {
  const offset = (page - 1) * limit;
  
  // Build base conditions
  let baseConditions = '1=1';
  let params = [];
  
  // Role-based filtering for patients
  if (userRole === 'PATIENT') {
    const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [userId]);
    if (userResult.rows.length === 0) {
      throw new Error('USER_NOT_FOUND');
    }
    baseConditions = 'i.patient_id = $1';
    params.push(userResult.rows[0].id);
  }
  
  // Apply filters
  const { patient_id, doctor_id, type, status, date } = filters;
  
  if (patient_id && (userRole !== 'PATIENT' || patient_id === params[0])) {
    baseConditions += ` AND i.patient_id = $${params.length + 1}`;
    params.push(patient_id);
  }
  
  if (doctor_id) {
    baseConditions += ` AND i.doctor_id = $${params.length + 1}`;
    params.push(doctor_id);
  }
  
  if (type) {
    baseConditions += ` AND i.type = $${params.length + 1}`;
    params.push(type.toUpperCase());
  }
  
  if (status) {
    baseConditions += ` AND i.status = $${params.length + 1}`;
    params.push(status.toUpperCase());
  }
  
  if (date) {
    baseConditions += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
    params.push(date);
  }

  // Build query with role-based field selection
  const query = `
    SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
           i.ordered_date, i.scheduled_date, i.completed_date, 
           ${userRole === 'PATIENT' ? '' : 'i.results,'} i.normal_range, i.unit, i.notes, i.cost,
           p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
           d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
           dept.specialization, i.created_at, i.updated_at
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    LEFT JOIN users d ON i.doctor_id = d.id
    LEFT JOIN doctors dept ON d.id = dept.user_id
    WHERE ${baseConditions}
    ORDER BY i.ordered_date DESC 
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  
  params.push(limit, offset);
  const result = await db.query(query, params);
  
  // Get total count
  const countQuery = `SELECT COUNT(*) FROM investigations i WHERE ${baseConditions}`;
  const countResult = await db.query(countQuery, params.slice(0, -2));
  const totalInvestigations = parseInt(countResult.rows[0].count);
  
  return {
    investigations: result.rows,
    pagination: {
      page,
      limit,
      total: totalInvestigations,
      totalPages: Math.ceil(totalInvestigations / limit),
      hasNext: page * limit < totalInvestigations,
      hasPrev: page > 1
    },
    filters
  };
};

// Get single investigation by ID
export const getInvestigationById = async (id, userRole, userId) => {
  let accessCondition = '1=1';
  let params = [id];
  
  // Patients can only view their own investigations
  if (userRole === 'PATIENT') {
    const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [userId]);
    if (userResult.rows.length === 0) {
      throw new Error('USER_NOT_FOUND');
    }
    accessCondition = 'i.patient_id = $2';
    params.push(userResult.rows[0].id);
  }
  
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
    WHERE i.id = $1 AND ${accessCondition}
  `, params);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  // Filter sensitive data for patients
  const investigation = result.rows[0];
  if (userRole === 'PATIENT') {
    delete investigation.doctor_phone;
    delete investigation.doctor_email;
    delete investigation.cost;
  }
  
  return investigation;
};

// Get patient investigations
export const getPatientInvestigations = async (patientId, filters, userRole, userId) => {
  // Access control for patients
  if (userRole === 'PATIENT') {
    const userResult = await db.query('SELECT id FROM users WHERE uid = $1', [userId]);
    if (userResult.rows.length === 0 || userResult.rows[0].id !== parseInt(patientId)) {
      return null; // Access denied
    }
  }
  
  const { type, status, limit } = filters;
  
  let query = `
    SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
           i.ordered_date, i.scheduled_date, i.completed_date, 
           ${userRole === 'PATIENT' ? '' : 'i.results,'} i.normal_range, i.unit, i.notes,
           d.name as doctor_name, dept.specialization
    FROM investigations i
    LEFT JOIN users d ON i.doctor_id = d.id
    LEFT JOIN doctors dept ON d.id = dept.user_id
    WHERE i.patient_id = $1
  `;
  let params = [patientId];
  
  if (type) {
    query += ` AND i.type = $${params.length + 1}`;
    params.push(type.toUpperCase());
  }
  
  if (status) {
    query += ` AND i.status = $${params.length + 1}`;
    params.push(status.toUpperCase());
  }
  
  query += ` ORDER BY i.ordered_date DESC LIMIT $${params.length + 1}`;
  params.push(limit);
  
  const result = await db.query(query, params);
  
  // Get patient info
  const patientInfo = await db.query(
    `SELECT name, ${userRole === 'ADMIN' ? 'phone, email,' : ''} birthday, gender 
     FROM users WHERE id = $1`,
    [patientId]
  );
  
  return {
    investigations: result.rows,
    count: result.rows.length,
    patient: patientInfo.rows[0] || null,
    filters: { type, status }
  };
};

// Get doctor investigations
export const getDoctorInvestigations = async (doctorId, filters) => {
  const { date, status } = filters;
  
  let query = `
    SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
           i.ordered_date, i.scheduled_date, i.notes,
           p.name as patient_name, p.phone as patient_phone, p.id as patient_id
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    WHERE i.doctor_id = $1 AND i.status = $2
  `;
  let params = [doctorId, status.toUpperCase()];
  
  if (date) {
    query += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
    params.push(date);
  }
  
  query += ' ORDER BY i.ordered_date DESC, i.priority DESC';
  
  const result = await db.query(query, params);
  
  return {
    investigations: result.rows,
    count: result.rows.length,
    doctor_id: doctorId,
    filters: { status, date }
  };
};

// Get investigations by type
export const getInvestigationsByType = async (type, filters) => {
  const { status, date } = filters;
  
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
    query += ` AND i.status = $${params.length + 1}`;
    params.push(status.toUpperCase());
  }
  
  if (date) {
    query += ` AND DATE(i.ordered_date) = $${params.length + 1}`;
    params.push(date);
  }
  
  query += ' ORDER BY i.ordered_date DESC LIMIT 100';
  
  const result = await db.query(query, params);
  
  return {
    investigations: result.rows,
    count: result.rows.length,
    type: type.toUpperCase(),
    filters: { status, date }
  };
};

// Get pending investigations
export const getPendingInvestigations = async (filters) => {
  const { type, priority } = filters;
  
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
    query += ` AND i.type = $${params.length + 1}`;
    params.push(type.toUpperCase());
  }
  
  if (priority) {
    query += ` AND i.priority = $${params.length + 1}`;
    params.push(priority.toUpperCase());
  }
  
  query += ' ORDER BY i.priority DESC, i.ordered_date ASC';
  
  const result = await db.query(query, params);
  
  return {
    investigations: result.rows,
    count: result.rows.length,
    filters: { type, priority }
  };
};

// Update investigation status
export const updateStatus = async (id, status, notes, userId) => {
  const validStatuses = Object.values(INVESTIGATION_STATUS);
  if (!validStatuses.includes(status.toUpperCase())) {
    throw new Error('INVALID_STATUS');
  }
  
  let updateFields = 'status = $1, notes = COALESCE($2, notes), updated_at = NOW(), updated_by = $4';
  let params = [status.toUpperCase(), notes, id, userId];
  
  // Set completed_date if status is COMPLETED
  if (status.toUpperCase() === 'COMPLETED') {
    updateFields = 'status = $1, notes = COALESCE($2, notes), completed_date = NOW(), updated_at = NOW(), updated_by = $4';
  }
  
  const result = await db.query(`
    UPDATE investigations SET ${updateFields}
    WHERE id = $3
    RETURNING *
  `, params);
  
  return result.rows.length > 0 ? result.rows[0] : null;
};

// Add investigation results
export const addResults = async (id, resultData, userId) => {
  const { results, interpretation, technician_notes, reviewed_by } = resultData;
  
  const result = await db.query(`
    UPDATE investigations SET 
      results = $1,
      interpretation = COALESCE($2, interpretation),
      technician_notes = COALESCE($3, technician_notes),
      reviewed_by = COALESCE($4, reviewed_by),
      status = 'COMPLETED',
      completed_date = NOW(),
      updated_at = NOW(),
      updated_by = $6
    WHERE id = $5
    RETURNING *
  `, [results, interpretation, technician_notes, reviewed_by, id, userId]);
  
  return result.rows.length > 0 ? result.rows[0] : null;
};

// Permission check functions
export const canViewDoctorInvestigations = (userRole) => {
  return MEDICAL_STAFF_ROLES.includes(userRole);
};

export const canViewByType = (userRole) => {
  return MEDICAL_STAFF_ROLES.includes(userRole);
};

export const canViewPending = (userRole) => {
  return MEDICAL_STAFF_ROLES.includes(userRole);
};

export const canUpdateStatus = (userRole) => {
  return LAB_STAFF_ROLES.includes(userRole);
};

export const canAddResults = (userRole) => {
  return LAB_STAFF_ROLES.includes(userRole);
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN'].includes(userRole);
};