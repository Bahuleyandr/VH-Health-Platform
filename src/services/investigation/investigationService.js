import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma.js';
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
  
  const conditions = [];
  let patientDbId = null;
  
  // Role-based filtering for patients
  if (userRole === 'PATIENT') {
    const users = await prisma.$queryRaw`SELECT id FROM users WHERE uid = ${userId}`;
    if (users.length === 0) {
      throw new Error('USER_NOT_FOUND');
    }
    patientDbId = users[0].id;
    conditions.push(Prisma.sql`i.patient_id = ${patientDbId}`);
  }
  
  // Apply filters
  const { patient_id, doctor_id, type, status, date } = filters;
  
  // Only allow patient_id filter for non-PATIENT roles (replicates original behaviour)
  if (patient_id && userRole !== 'PATIENT') {
    conditions.push(Prisma.sql`i.patient_id = ${parseInt(patient_id)}`);
  }
  
  if (doctor_id) {
    conditions.push(Prisma.sql`i.doctor_id = ${parseInt(doctor_id)}`);
  }
  
  if (type) {
    conditions.push(Prisma.sql`i.type = ${type.toUpperCase()}`);
  }
  
  if (status) {
    conditions.push(Prisma.sql`i.status = ${status.toUpperCase()}`);
  }
  
  if (date) {
    conditions.push(Prisma.sql`DATE(i.ordered_date) = ${date}::date`);
  }

  const whereClause = conditions.length > 0
    ? Prisma.join(conditions, ' AND ')
    : Prisma.sql`1=1`;

  // Build query with role-based field selection
  const investigations = userRole === 'PATIENT'
    ? await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
               i.ordered_date, i.scheduled_date, i.completed_date, 
               i.normal_range, i.unit, i.notes, i.cost,
               p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
               d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
               dept.specialization, i.created_at, i.updated_at
        FROM investigations i
        LEFT JOIN users p ON i.patient_id = p.id
        LEFT JOIN users d ON i.doctor_id = d.id
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.ordered_date DESC 
        LIMIT ${limit} OFFSET ${offset}
      `
    : await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
               i.ordered_date, i.scheduled_date, i.completed_date, 
               i.results, i.normal_range, i.unit, i.notes, i.cost,
               p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
               d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
               dept.specialization, i.created_at, i.updated_at
        FROM investigations i
        LEFT JOIN users p ON i.patient_id = p.id
        LEFT JOIN users d ON i.doctor_id = d.id
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.ordered_date DESC 
        LIMIT ${limit} OFFSET ${offset}
      `;
  
  // Get total count
  const [countRow] = await prisma.$queryRaw`
    SELECT COUNT(*)::int as count FROM investigations i WHERE ${whereClause}
  `;
  const totalInvestigations = Number(countRow.count);
  
  return {
    investigations,
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
  let rows;
  
  // Patients can only view their own investigations
  if (userRole === 'PATIENT') {
    const users = await prisma.$queryRaw`SELECT id FROM users WHERE uid = ${userId}`;
    if (users.length === 0) {
      throw new Error('USER_NOT_FOUND');
    }
    const patientDbId = users[0].id;
    rows = await prisma.$queryRaw`
      SELECT i.*, 
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             dept.specialization, dept.department
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.doctor_id = d.id
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE i.id = ${parseInt(id)} AND i.patient_id = ${patientDbId}
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT i.*, 
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             dept.specialization, dept.department
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.doctor_id = d.id
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE i.id = ${parseInt(id)}
    `;
  }
  
  if (rows.length === 0) {
    return null;
  }
  
  // Filter sensitive data for patients
  const investigation = { ...rows[0] };
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
    const users = await prisma.$queryRaw`SELECT id FROM users WHERE uid = ${userId}`;
    if (users.length === 0 || users[0].id !== parseInt(patientId)) {
      return null; // Access denied
    }
  }
  
  const { type, status, limit } = filters;
  
  const conditions = [Prisma.sql`i.patient_id = ${parseInt(patientId)}`];
  
  if (type) {
    conditions.push(Prisma.sql`i.type = ${type.toUpperCase()}`);
  }
  
  if (status) {
    conditions.push(Prisma.sql`i.status = ${status.toUpperCase()}`);
  }
  
  const whereClause = Prisma.join(conditions, ' AND ');

  const investigations = userRole === 'PATIENT'
    ? await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
               i.ordered_date, i.scheduled_date, i.completed_date, 
               i.normal_range, i.unit, i.notes,
               d.name as doctor_name, dept.specialization
        FROM investigations i
        LEFT JOIN users d ON i.doctor_id = d.id
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.ordered_date DESC LIMIT ${parseInt(limit)}
      `
    : await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
               i.ordered_date, i.scheduled_date, i.completed_date, 
               i.results, i.normal_range, i.unit, i.notes,
               d.name as doctor_name, dept.specialization
        FROM investigations i
        LEFT JOIN users d ON i.doctor_id = d.id
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.ordered_date DESC LIMIT ${parseInt(limit)}
      `;
  
  // Get patient info
  const patientInfoFields = userRole === 'ADMIN'
    ? await prisma.$queryRaw`SELECT name, phone, email, birthday, gender FROM users WHERE id = ${parseInt(patientId)}`
    : await prisma.$queryRaw`SELECT name, birthday, gender FROM users WHERE id = ${parseInt(patientId)}`;
  
  return {
    investigations,
    count: investigations.length,
    patient: patientInfoFields[0] || null,
    filters: { type, status }
  };
};

// Get doctor investigations
export const getDoctorInvestigations = async (doctorId, filters) => {
  const { date, status } = filters;
  
  const conditions = [
    Prisma.sql`i.doctor_id = ${parseInt(doctorId)}`,
    Prisma.sql`i.status = ${status.toUpperCase()}`
  ];
  
  if (date) {
    conditions.push(Prisma.sql`DATE(i.ordered_date) = ${date}::date`);
  }
  
  const whereClause = Prisma.join(conditions, ' AND ');
  
  const investigations = await prisma.$queryRaw`
    SELECT i.id, i.test_name, i.test_code, i.type, i.status, i.priority,
           i.ordered_date, i.scheduled_date, i.notes,
           p.name as patient_name, p.phone as patient_phone, p.id as patient_id
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    WHERE ${whereClause}
    ORDER BY i.ordered_date DESC, i.priority DESC
  `;
  
  return {
    investigations,
    count: investigations.length,
    doctor_id: doctorId,
    filters: { status, date }
  };
};

// Get investigations by type
export const getInvestigationsByType = async (type, filters) => {
  const { status, date } = filters;
  
  const conditions = [Prisma.sql`i.type = ${type.toUpperCase()}`];
  
  if (status) {
    conditions.push(Prisma.sql`i.status = ${status.toUpperCase()}`);
  }
  
  if (date) {
    conditions.push(Prisma.sql`DATE(i.ordered_date) = ${date}::date`);
  }
  
  const whereClause = Prisma.join(conditions, ' AND ');
  
  const investigations = await prisma.$queryRaw`
    SELECT i.id, i.test_name, i.test_code, i.status, i.priority,
           i.ordered_date, i.scheduled_date, i.completed_date,
           p.name as patient_name, p.phone as patient_phone,
           d.name as doctor_name
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    LEFT JOIN users d ON i.doctor_id = d.id
    WHERE ${whereClause}
    ORDER BY i.ordered_date DESC LIMIT 100
  `;
  
  return {
    investigations,
    count: investigations.length,
    type: type.toUpperCase(),
    filters: { status, date }
  };
};

// Get pending investigations
export const getPendingInvestigations = async (filters) => {
  const { type, priority } = filters;
  
  const conditions = [Prisma.sql`i.status = 'PENDING'`];
  
  if (type) {
    conditions.push(Prisma.sql`i.type = ${type.toUpperCase()}`);
  }
  
  if (priority) {
    conditions.push(Prisma.sql`i.priority = ${priority.toUpperCase()}`);
  }
  
  const whereClause = Prisma.join(conditions, ' AND ');
  
  const investigations = await prisma.$queryRaw`
    SELECT i.id, i.test_name, i.test_code, i.type, i.priority,
           i.ordered_date, i.scheduled_date, i.notes,
           p.name as patient_name, p.phone as patient_phone, p.gender,
           d.name as doctor_name, dept.department
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    LEFT JOIN users d ON i.doctor_id = d.id
    LEFT JOIN doctors dept ON d.id = dept.user_id
    WHERE ${whereClause}
    ORDER BY i.priority DESC, i.ordered_date ASC
  `;
  
  return {
    investigations,
    count: investigations.length,
    filters: { type, priority }
  };
};

// Update investigation status
export const updateStatus = async (id, status, notes, userId) => {
  const validStatuses = Object.values(INVESTIGATION_STATUS);
  if (!validStatuses.includes(status.toUpperCase())) {
    throw new Error('INVALID_STATUS');
  }
  
  let rows;
  
  // Set completed_date if status is COMPLETED
  if (status.toUpperCase() === 'COMPLETED') {
    rows = await prisma.$queryRaw`
      UPDATE investigations SET 
        status = ${status.toUpperCase()},
        notes = COALESCE(${notes ?? null}, notes),
        completed_date = NOW(),
        updated_at = NOW(),
        updated_by = ${userId}
      WHERE id = ${parseInt(id)}
      RETURNING id, patient_id, doctor_id, test_name, test_code, type, status, priority, notes, completed_date, updated_at, updated_by
    `;
  } else {
    rows = await prisma.$queryRaw`
      UPDATE investigations SET 
        status = ${status.toUpperCase()},
        notes = COALESCE(${notes ?? null}, notes),
        updated_at = NOW(),
        updated_by = ${userId}
      WHERE id = ${parseInt(id)}
      RETURNING id, patient_id, doctor_id, test_name, test_code, type, status, priority, notes, completed_date, updated_at, updated_by
    `;
  }
  
  return rows.length > 0 ? rows[0] : null;
};

// Add investigation results
export const addResults = async (id, resultData, userId) => {
  const { results, interpretation, technician_notes, reviewed_by } = resultData;
  
  const rows = await prisma.$queryRaw`
    UPDATE investigations SET 
      results = ${results},
      interpretation = COALESCE(${interpretation ?? null}, interpretation),
      technician_notes = COALESCE(${technician_notes ?? null}, technician_notes),
      reviewed_by = COALESCE(${reviewed_by ?? null}, reviewed_by),
      status = 'COMPLETED',
      completed_date = NOW(),
      updated_at = NOW(),
      updated_by = ${userId}
    WHERE id = ${parseInt(id)}
    RETURNING id, patient_id, doctor_id, test_name, test_code, type, status, results, interpretation, technician_notes, reviewed_by, completed_date, updated_at, updated_by
  `;
  
  return rows.length > 0 ? rows[0] : null;
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
