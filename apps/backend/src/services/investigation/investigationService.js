import {
  INVESTIGATION_STATUS,
  MEDICAL_STAFF_ROLES,
  LAB_STAFF_ROLES
} from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';

// Shape of the investigation columns the list views select. Kept as
// Prisma-select objects rather than SELECT-strings so column renames in
// schema.prisma surface as PrismaClientValidationError, which is what
// this batch of migrations is buying.
const INV_LIST_SELECT_BASE = {
  id: true,
  test_name: true,
  test_type: true,
  status: true,
  priority: true,
  requested_at: true,
  completed_at: true,
  notes: true,
  patient_id: true,
  requested_by: true,
  created_at: true,
  updated_at: true,
};
const INV_LIST_SELECT_WITH_RESULTS = { ...INV_LIST_SELECT_BASE, results: true };

/**
 * Enrich a batch of investigation rows with the patient + doctor + doctor-profile
 * info the list views used to JOIN in SQL. One extra findMany per related
 * domain, deduped by id/uid — O(1) extra queries regardless of list size.
 *
 * The old raw SQL referenced `dept.specialization`, but the doctors table
 * actually has `specialty` (schema.prisma line ~302). The raw SQL was thus
 * 500-ing whenever these list endpoints were hit; the alias name is
 * preserved in the response (`specialization`) but now populated from
 * `doctors.specialty` so existing admin UI keys keep working.
 *
 * `fields` controls which related columns to attach — different list views
 * need different subsets (getInvestigationsByType skips specialization/
 * department entirely, getPendingInvestigations needs `gender` + `department`
 * etc.).
 */
async function enrichInvestigations(rows, fields = {}) {
  if (rows.length === 0) return rows;

  const patientIds = [...new Set(rows.map((r) => r.patient_id).filter(Boolean))];
  const doctorUids = [...new Set(rows.map((r) => r.requested_by).filter(Boolean))];

  const patientSelect = {
    id: true,
    name: true,
    phone: true,
    ...(fields.patientEmail ? { email: true } : {}),
    ...(fields.patientBirthGender ? { birthday: true, gender: true } : {}),
    ...(fields.patientGender ? { gender: true } : {}),
  };
  const doctorSelect = {
    uid: true,
    id: true,
    name: true,
    ...(fields.doctorPhone ? { phone: true } : {}),
    ...(fields.doctorEmail ? { email: true } : {}),
  };

  const [patients, doctors] = await Promise.all([
    patientIds.length
      ? prisma.users.findMany({ where: { id: { in: patientIds } }, select: patientSelect })
      : [],
    doctorUids.length
      ? prisma.users.findMany({ where: { uid: { in: doctorUids } }, select: doctorSelect })
      : [],
  ]);

  const doctorUserIds = doctors.map((d) => d.id).filter(Boolean);
  const doctorProfiles =
    (fields.specialization || fields.department) && doctorUserIds.length
      ? await prisma.doctors.findMany({
          where: { user_id: { in: doctorUserIds } },
          select: {
            user_id: true,
            ...(fields.specialization ? { specialty: true } : {}),
            ...(fields.department ? { department: true } : {}),
          },
        })
      : [];

  const patientMap = new Map(patients.map((p) => [p.id, p]));
  const doctorMap = new Map(doctors.map((d) => [d.uid, d]));
  const doctorProfileMap = new Map(doctorProfiles.map((d) => [d.user_id, d]));

  return rows.map((r) => {
    const patient = r.patient_id != null ? patientMap.get(r.patient_id) : null;
    const doctor = r.requested_by ? doctorMap.get(r.requested_by) : null;
    const profile = doctor ? doctorProfileMap.get(doctor.id) : null;
    const enriched = {
      ...r,
      patient_name: patient?.name ?? null,
      patient_phone: patient?.phone ?? null,
      doctor_name: doctor?.name ?? null,
      doctor_id: doctor?.id ?? null,
    };
    if (fields.patientEmail) enriched.patient_email = patient?.email ?? null;
    if (fields.patientBirthGender) {
      enriched.birthday = patient?.birthday ?? null;
      enriched.gender = patient?.gender ?? null;
    }
    if (fields.patientGender) enriched.gender = patient?.gender ?? null;
    if (fields.doctorPhone) enriched.doctor_phone = doctor?.phone ?? null;
    if (fields.doctorEmail) enriched.doctor_email = doctor?.email ?? null;
    if (fields.specialization) enriched.specialization = profile?.specialty ?? null;
    if (fields.department) enriched.department = profile?.department ?? null;
    return enriched;
  });
}

// Get investigations with filtering
export const getInvestigations = async (page, limit, filters, userRole, userId) => {
  const offset = (page - 1) * limit;

  const where = {};

  // Role-based filtering for patients
  if (userRole === 'PATIENT') {
    const users = await prisma.users.findUnique({
      where: { uid: userId },
      select: { id: true },
    });
    if (!users) {
      throw new Error('USER_NOT_FOUND');
    }
    where.patient_id = users.id;
  }

  // Apply filters
  const { patient_id, doctor_id, type, status, date } = filters;

  // Only allow patient_id filter for non-PATIENT roles (replicates original behaviour)
  if (patient_id && userRole !== 'PATIENT') {
    where.patient_id = parseInt(patient_id);
  }

  // `doctor_id` filter: the investigations table has no `doctor_id` column —
  // the requester lives in `requested_by` as a UUID pointing at users.uid.
  // Callers still pass an integer user-id in the filter, so resolve it to
  // a UUID once before scoping the query.
  if (doctor_id) {
    const doctorRow = await prisma.users.findUnique({
      where: { id: parseInt(doctor_id) },
      select: { uid: true },
    });
    if (doctorRow?.uid) {
      where.requested_by = doctorRow.uid;
    } else {
      // No matching user: ensure zero rows (impossible id sentinel)
      where.id = -1;
    }
  }

  if (type) where.test_type = type.toUpperCase();
  if (status) where.status = status.toUpperCase();
  if (date) {
    // DATE(i.requested_at) = $date → range over the day
    const start = new Date(date);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    where.requested_at = { gte: start, lt: end };
  }

  const [rows, totalInvestigations] = await Promise.all([
    prisma.investigations.findMany({
      where,
      select:
        userRole === 'PATIENT' ? INV_LIST_SELECT_BASE : INV_LIST_SELECT_WITH_RESULTS,
      orderBy: { requested_at: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.investigations.count({ where }),
  ]);

  const investigations = await enrichInvestigations(rows, {
    specialization: true,
    doctorPhone: true,
  });

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
  const where = { id: parseInt(id) };

  // Patients can only view their own investigations — scope by patient_id
  // rather than filtering after the read.
  if (userRole === 'PATIENT') {
    const users = await prisma.users.findUnique({
      where: { uid: userId },
      select: { id: true },
    });
    if (!users) {
      throw new Error('USER_NOT_FOUND');
    }
    where.patient_id = users.id;
  }

  const row = await prisma.investigations.findFirst({ where });
  if (!row) return null;

  const [enriched] = await enrichInvestigations([row], {
    patientEmail: true,
    patientBirthGender: true,
    doctorPhone: true,
    doctorEmail: true,
    specialization: true,
    department: true,
  });

  // Filter sensitive data for patients — keep the old delete semantics so
  // callers already checking `if (x.doctor_phone)` work unchanged.
  if (userRole === 'PATIENT') {
    delete enriched.doctor_phone;
    delete enriched.doctor_email;
  }

  return enriched;
};

// Get patient investigations
export const getPatientInvestigations = async (patientId, filters, userRole, userId) => {
  // Access control for patients
  if (userRole === 'PATIENT') {
    const users = await prisma.users.findUnique({
      where: { uid: userId },
      select: { id: true },
    });
    if (!users || users.id !== parseInt(patientId)) {
      return null; // Access denied
    }
  }

  const { type, status, limit } = filters;

  const where = { patient_id: parseInt(patientId) };
  if (type) where.test_type = type.toUpperCase();
  if (status) where.status = status.toUpperCase();

  const rows = await prisma.investigations.findMany({
    where,
    select:
      userRole === 'PATIENT' ? INV_LIST_SELECT_BASE : INV_LIST_SELECT_WITH_RESULTS,
    orderBy: { requested_at: 'desc' },
    take: parseInt(limit),
  });

  // This view only needs doctor_name + specialization (no patient_* aliases —
  // the patient-specific info is returned separately as `patient`).
  const enriched = await enrichInvestigations(rows, { specialization: true });
  // Drop the patient_* keys added by the shared enricher; this endpoint's
  // old shape didn't include them.
  const investigations = enriched.map((r) => {
    const { patient_name, patient_phone, ...rest } = r;
    void patient_name; void patient_phone;
    return rest;
  });

  // Get patient info
  const patient = await prisma.users.findUnique({
    where: { id: parseInt(patientId) },
    select:
      userRole === 'ADMIN'
        ? { name: true, phone: true, email: true, birthday: true, gender: true }
        : { name: true, birthday: true, gender: true },
  });

  return {
    investigations,
    count: investigations.length,
    patient: patient || null,
    filters: { type, status }
  };
};

// Helper: date filter that matches the old `DATE(i.requested_at) = $date` —
// inclusive-start / exclusive-end over the calendar day.
function dateRangeFilter(date) {
  const start = new Date(date);
  const end = new Date(date);
  end.setDate(end.getDate() + 1);
  return { gte: start, lt: end };
}

// Get doctor investigations
export const getDoctorInvestigations = async (doctorId, filters) => {
  const { date, status } = filters;

  // Resolve the doctor's integer id to the uid used in investigations.requested_by.
  const doctorRow = await prisma.users.findUnique({
    where: { id: parseInt(doctorId) },
    select: { uid: true },
  });
  if (!doctorRow?.uid) {
    return { investigations: [], count: 0, doctor_id: doctorId, filters: { status, date } };
  }

  const where = {
    requested_by: doctorRow.uid,
    status: status.toUpperCase(),
  };
  if (date) where.requested_at = dateRangeFilter(date);

  const rows = await prisma.investigations.findMany({
    where,
    select: {
      id: true,
      test_name: true,
      test_type: true,
      status: true,
      priority: true,
      requested_at: true,
      notes: true,
      patient_id: true,
      requested_by: true,
    },
    orderBy: [{ requested_at: 'desc' }, { priority: 'desc' }],
  });

  // Only patient_name / patient_phone / patient_id needed here — no doctor
  // or specialization aliases (this view is scoped to one doctor already).
  const enriched = await enrichInvestigations(rows, {});
  const investigations = enriched.map((r) => {
    const { doctor_name, doctor_id, requested_by, ...rest } = r;
    void doctor_name; void doctor_id; void requested_by;
    return rest;
  });

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

  const where = { test_type: type.toUpperCase() };
  if (status) where.status = status.toUpperCase();
  if (date) where.requested_at = dateRangeFilter(date);

  const rows = await prisma.investigations.findMany({
    where,
    select: {
      id: true,
      test_name: true,
      status: true,
      priority: true,
      requested_at: true,
      completed_at: true,
      patient_id: true,
      requested_by: true,
    },
    orderBy: { requested_at: 'desc' },
    take: 100,
  });

  const investigations = await enrichInvestigations(rows, {});

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

  const where = { status: 'PENDING' };
  if (type) where.test_type = type.toUpperCase();
  if (priority) where.priority = priority.toUpperCase();

  const rows = await prisma.investigations.findMany({
    where,
    select: {
      id: true,
      test_name: true,
      test_type: true,
      priority: true,
      requested_at: true,
      notes: true,
      patient_id: true,
      requested_by: true,
    },
    // Priority is a VARCHAR so lexical 'URGENT' < 'HIGH' < 'NORMAL' — the
    // old `ORDER BY priority DESC` inherited that same text ordering. This
    // intentionally preserves the existing behaviour; a future ticket can
    // introduce a priority_rank column if the ordering is wrong.
    orderBy: [{ priority: 'desc' }, { requested_at: 'asc' }],
  });

  const investigations = await enrichInvestigations(rows, {
    patientGender: true,
    department: true,
  });

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
