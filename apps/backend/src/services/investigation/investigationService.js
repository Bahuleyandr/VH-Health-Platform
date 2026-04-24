import { Prisma } from '@prisma/client';
import { 
  INVESTIGATION_STATUS,
  MEDICAL_STAFF_ROLES,
  LAB_STAFF_ROLES 
} from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';

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

  // `doctor_id` filter: the investigations table has no `doctor_id` column —
  // the requester lives in `requested_by` as a UUID pointing at users.uid.
  // Callers still pass an integer user-id in the filter, so resolve it to
  // a UUID once before scoping the query.
  if (doctor_id) {
    const doctorRow = await prisma.$queryRaw`SELECT uid FROM users WHERE id = ${parseInt(doctor_id)}`;
    if (doctorRow.length > 0 && doctorRow[0].uid) {
      conditions.push(Prisma.sql`i.requested_by = ${doctorRow[0].uid}::uuid`);
    } else {
      // No matching user: ensure zero rows
      conditions.push(Prisma.sql`FALSE`);
    }
  }

  if (type) {
    conditions.push(Prisma.sql`i.test_type = ${type.toUpperCase()}`);
  }

  if (status) {
    conditions.push(Prisma.sql`i.status = ${status.toUpperCase()}`);
  }

  if (date) {
    conditions.push(Prisma.sql`DATE(i.requested_at) = ${date}::date`);
  }

  const whereClause = conditions.length > 0
    ? Prisma.join(conditions, ' AND ')
    : Prisma.sql`1=1`;

  // Build query with role-based field selection. Column references match
  // the schema in src/migrations/008_add_investigation_structured_results.sql
  // + 009_future_proof_clinical_ai.sql: requested_at / completed_at /
  // test_type (not the legacy ordered_date / completed_date / type).
  const investigations = userRole === 'PATIENT'
    ? await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
               i.requested_at, i.completed_at, i.notes,
               p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
               d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
               dept.specialization, i.created_at, i.updated_at
        FROM investigations i
        LEFT JOIN users p ON i.patient_id = p.id
        LEFT JOIN users d ON i.requested_by = d.uid
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.requested_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
               i.requested_at, i.completed_at,
               i.results, i.notes,
               p.name as patient_name, p.phone as patient_phone, p.id as patient_id,
               d.name as doctor_name, d.phone as doctor_phone, d.id as doctor_id,
               dept.specialization, i.created_at, i.updated_at
        FROM investigations i
        LEFT JOIN users p ON i.patient_id = p.id
        LEFT JOIN users d ON i.requested_by = d.uid
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.requested_at DESC
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
             d.id as doctor_id,
             dept.specialization, dept.department
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.requested_by = d.uid
      LEFT JOIN doctors dept ON d.id = dept.user_id
      WHERE i.id = ${parseInt(id)} AND i.patient_id = ${patientDbId}
    `;
  } else {
    rows = await prisma.$queryRaw`
      SELECT i.*,
             p.name as patient_name, p.phone as patient_phone, p.email as patient_email,
             p.birthday, p.gender,
             d.name as doctor_name, d.phone as doctor_phone, d.email as doctor_email,
             d.id as doctor_id,
             dept.specialization, dept.department
      FROM investigations i
      LEFT JOIN users p ON i.patient_id = p.id
      LEFT JOIN users d ON i.requested_by = d.uid
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
    conditions.push(Prisma.sql`i.test_type = ${type.toUpperCase()}`);
  }

  if (status) {
    conditions.push(Prisma.sql`i.status = ${status.toUpperCase()}`);
  }

  const whereClause = Prisma.join(conditions, ' AND ');

  const investigations = userRole === 'PATIENT'
    ? await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
               i.requested_at, i.completed_at, i.notes,
               d.name as doctor_name, dept.specialization
        FROM investigations i
        LEFT JOIN users d ON i.requested_by = d.uid
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.requested_at DESC LIMIT ${parseInt(limit)}
      `
    : await prisma.$queryRaw`
        SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
               i.requested_at, i.completed_at,
               i.results, i.notes,
               d.name as doctor_name, dept.specialization
        FROM investigations i
        LEFT JOIN users d ON i.requested_by = d.uid
        LEFT JOIN doctors dept ON d.id = dept.user_id
        WHERE ${whereClause}
        ORDER BY i.requested_at DESC LIMIT ${parseInt(limit)}
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

  // Resolve the doctor's integer id to the uid used in investigations.requested_by.
  const doctorRow = await prisma.$queryRaw`SELECT uid FROM users WHERE id = ${parseInt(doctorId)}`;
  if (doctorRow.length === 0 || !doctorRow[0].uid) {
    return { investigations: [], count: 0, doctor_id: doctorId, filters: { status, date } };
  }
  const doctorUid = doctorRow[0].uid;

  const conditions = [
    Prisma.sql`i.requested_by = ${doctorUid}::uuid`,
    Prisma.sql`i.status = ${status.toUpperCase()}`
  ];

  if (date) {
    conditions.push(Prisma.sql`DATE(i.requested_at) = ${date}::date`);
  }

  const whereClause = Prisma.join(conditions, ' AND ');

  const investigations = await prisma.$queryRaw`
    SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
           i.requested_at, i.notes,
           p.name as patient_name, p.phone as patient_phone, p.id as patient_id
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    WHERE ${whereClause}
    ORDER BY i.requested_at DESC, i.priority DESC
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

  const conditions = [Prisma.sql`i.test_type = ${type.toUpperCase()}`];

  if (status) {
    conditions.push(Prisma.sql`i.status = ${status.toUpperCase()}`);
  }

  if (date) {
    conditions.push(Prisma.sql`DATE(i.requested_at) = ${date}::date`);
  }

  const whereClause = Prisma.join(conditions, ' AND ');

  const investigations = await prisma.$queryRaw`
    SELECT i.id, i.test_name, i.status, i.priority,
           i.requested_at, i.completed_at,
           p.name as patient_name, p.phone as patient_phone,
           d.name as doctor_name
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    LEFT JOIN users d ON i.requested_by = d.uid
    WHERE ${whereClause}
    ORDER BY i.requested_at DESC LIMIT 100
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
    conditions.push(Prisma.sql`i.test_type = ${type.toUpperCase()}`);
  }

  if (priority) {
    conditions.push(Prisma.sql`i.priority = ${priority.toUpperCase()}`);
  }

  const whereClause = Prisma.join(conditions, ' AND ');

  const investigations = await prisma.$queryRaw`
    SELECT i.id, i.test_name, i.test_type, i.priority,
           i.requested_at, i.notes,
           p.name as patient_name, p.phone as patient_phone, p.gender,
           d.name as doctor_name, dept.department
    FROM investigations i
    LEFT JOIN users p ON i.patient_id = p.id
    LEFT JOIN users d ON i.requested_by = d.uid
    LEFT JOIN doctors dept ON d.id = dept.user_id
    WHERE ${whereClause}
    ORDER BY i.priority DESC, i.requested_at ASC
  `;
  
  return {
    investigations,
    count: investigations.length,
    filters: { type, priority }
  };
};

// Update investigation status.
// Type-safe Prisma ORM — column names are checked against schema.prisma at
// runtime. Renaming a column in migration without updating schema.prisma
// would throw a clear PrismaClientKnownRequestError instead of silently
// running a broken SQL statement.
export const updateStatus = async (id, status, notes, userId) => {
  const validStatuses = Object.values(INVESTIGATION_STATUS);
  if (!validStatuses.includes(status.toUpperCase())) {
    throw new Error('INVALID_STATUS');
  }

  // `userId` is accepted for audit parity with callers but the investigations
  // schema has no updated_by column — audit is emitted separately via the
  // phiAccessLogger middleware on the route. Keep the param for signature
  // stability; intentionally unused here.
  void userId;

  const data = { status: status.toUpperCase() };
  if (notes != null) data.notes = notes;
  if (status.toUpperCase() === 'COMPLETED') data.completed_at = new Date();
  // `updated_at` is @updatedAt in schema.prisma — Prisma auto-bumps on every
  // update, no need to set it manually.

  const INVESTIGATION_SELECT = {
    id: true,
    patient_id: true,
    requested_by: true,
    test_name: true,
    test_type: true,
    status: true,
    priority: true,
    notes: true,
    completed_at: true,
    updated_at: true,
  };

  try {
    return await prisma.investigations.update({
      where: { id: parseInt(id) },
      data,
      select: INVESTIGATION_SELECT,
    });
  } catch (err) {
    // Prisma P2025 = record not found. Match the pre-ORM behavior of
    // returning null so callers that check `if (!result)` continue to work.
    if (err?.code === 'P2025') return null;
    throw err;
  }
};

// Add investigation results
export const addResults = async (id, resultData, userId) => {
  // Only the columns that exist on investigations (per migrations 008/009):
  // results, interpretation, status, completed_at, updated_at. technician_notes
  // and reviewed_by are not modelled yet — drop them from the update rather
  // than adding placeholder columns.
  const { results, interpretation } = resultData;
  void userId;

  const data = {
    results,
    status: 'COMPLETED',
    completed_at: new Date(),
  };
  if (interpretation != null) data.interpretation = interpretation;

  try {
    return await prisma.investigations.update({
      where: { id: parseInt(id) },
      data,
      select: {
        id: true,
        patient_id: true,
        requested_by: true,
        test_name: true,
        test_type: true,
        status: true,
        results: true,
        interpretation: true,
        completed_at: true,
        updated_at: true,
      },
    });
  } catch (err) {
    if (err?.code === 'P2025') return null;
    throw err;
  }
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
