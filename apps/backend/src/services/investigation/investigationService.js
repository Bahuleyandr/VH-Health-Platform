import {
  INVESTIGATION_STATUS,
  MEDICAL_STAFF_ROLES,
  LAB_STAFF_ROLES
} from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';

// Relation names Prisma generates for the two FKs pointing at `users`
// (migration 082 declared both). Verbose because Prisma has to disambiguate
// two relations to the same table — kept as constants so the six list
// queries read consistently. `users.doctors` is a to-many list (one user
// *could* have multiple doctor records); in practice there's at most one,
// which we pull via `[0]` in `flattenRelations`.
const REL_PATIENT = 'users_investigations_patient_idTousers';
const REL_DOCTOR = 'users_investigations_requested_byTousers';

// Shape of the investigation columns the list views select. Kept as
// Prisma-select objects rather than SELECT-strings so column renames in
// schema.prisma surface as PrismaClientValidationError at query construction.
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
 * Build a Prisma `include`-like select object for the related columns a
 * given list view needs. Consumers pass `fields` flags and get back a
 * select object suitable for spread-merging into the main findMany select.
 *
 * Declared relations (from migration 082) mean column-rename drift on
 * users/doctors now also surfaces at query-construction time, not just on
 * investigations — the gap findMany+stitch (batch 30) couldn't close.
 *
 * The old raw SQL referenced `dept.specialization`, but the doctors table
 * actually has `specialty`. The response alias stays `specialization` so
 * existing admin UI keys keep working, but now backed by `doctors.specialty`.
 */
function buildRelationsSelect(fields = {}) {
  const patientUserSelect = {
    id: true,
    name: true,
    phone: true,
    ...(fields.patientEmail ? { email: true } : {}),
    ...(fields.patientBirthGender ? { birthday: true, gender: true } : {}),
    ...(fields.patientGender ? { gender: true } : {}),
  };
  const doctorProfileNeeded = fields.specialization || fields.department;
  const doctorUserSelect = {
    id: true,
    uid: true,
    name: true,
    ...(fields.doctorPhone ? { phone: true } : {}),
    ...(fields.doctorEmail ? { email: true } : {}),
    ...(doctorProfileNeeded
      ? {
          doctors: {
            select: {
              ...(fields.specialization ? { specialty: true } : {}),
              ...(fields.department ? { department: true } : {}),
            },
            take: 1,
          },
        }
      : {}),
  };
  return {
    [REL_PATIENT]: { select: patientUserSelect },
    [REL_DOCTOR]: { select: doctorUserSelect },
  };
}

/**
 * Flatten a Prisma-include row back into the flat-alias shape the admin UI
 * expects (patient_name, doctor_name, specialization, etc.). The include
 * structure is nested; callers always worked with the flat keys.
 */
function flattenRelations(row, fields = {}) {
  const patient = row[REL_PATIENT] ?? null;
  const doctor = row[REL_DOCTOR] ?? null;
  const profile = doctor && doctor.doctors ? doctor.doctors[0] ?? null : null;

  const flat = { ...row };
  delete flat[REL_PATIENT];
  delete flat[REL_DOCTOR];

  flat.patient_name = patient?.name ?? null;
  flat.patient_phone = patient?.phone ?? null;
  flat.doctor_name = doctor?.name ?? null;
  flat.doctor_id = doctor?.id ?? null;

  if (fields.patientEmail) flat.patient_email = patient?.email ?? null;
  if (fields.patientBirthGender) {
    flat.birthday = patient?.birthday ?? null;
    flat.gender = patient?.gender ?? null;
  }
  if (fields.patientGender) flat.gender = patient?.gender ?? null;
  if (fields.doctorPhone) flat.doctor_phone = doctor?.phone ?? null;
  if (fields.doctorEmail) flat.doctor_email = doctor?.email ?? null;
  if (fields.specialization) flat.specialization = profile?.specialty ?? null;
  if (fields.department) flat.department = profile?.department ?? null;
  return flat;
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

  const relationFields = { specialization: true, doctorPhone: true };
  const [rows, totalInvestigations] = await Promise.all([
    prisma.investigations.findMany({
      where,
      select: {
        ...(userRole === 'PATIENT' ? INV_LIST_SELECT_BASE : INV_LIST_SELECT_WITH_RESULTS),
        ...buildRelationsSelect(relationFields),
      },
      orderBy: { requested_at: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.investigations.count({ where }),
  ]);

  const investigations = rows.map((r) => flattenRelations(r, relationFields));

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

  const relationFields = {
    patientEmail: true,
    patientBirthGender: true,
    doctorPhone: true,
    doctorEmail: true,
    specialization: true,
    department: true,
  };
  // Single-record endpoint — selects all investigation columns (the old
  // raw SQL used `i.*`). An explicit full-column select would duplicate
  // schema.prisma and rot; `include` for relations + omitting the main
  // `select` key gets every base column plus the two joined users.
  const row = await prisma.investigations.findFirst({
    where,
    include: buildRelationsSelect(relationFields),
  });
  if (!row) return null;

  const flat = flattenRelations(row, relationFields);

  // Filter sensitive data for patients — keep the old delete semantics so
  // callers already checking `if (x.doctor_phone)` work unchanged.
  if (userRole === 'PATIENT') {
    delete flat.doctor_phone;
    delete flat.doctor_email;
  }

  return flat;
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

  // This view only needs doctor_name + specialization — the patient
  // info is returned separately as `patient`. Pass only the doctor relation
  // into the include so we don't unnecessarily load the patient user row.
  const rows = await prisma.investigations.findMany({
    where,
    select: {
      ...(userRole === 'PATIENT' ? INV_LIST_SELECT_BASE : INV_LIST_SELECT_WITH_RESULTS),
      [REL_DOCTOR]: {
        select: {
          id: true,
          uid: true,
          name: true,
          doctors: { select: { specialty: true }, take: 1 },
        },
      },
    },
    orderBy: { requested_at: 'desc' },
    take: parseInt(limit),
  });

  const investigations = rows.map((r) => {
    const doctor = r[REL_DOCTOR] ?? null;
    const profile = doctor?.doctors?.[0] ?? null;
    const flat = { ...r };
    delete flat[REL_DOCTOR];
    flat.doctor_name = doctor?.name ?? null;
    flat.doctor_id = doctor?.id ?? null;
    flat.specialization = profile?.specialty ?? null;
    return flat;
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

  // Scoped to a single doctor already — only needs patient info, not doctor/
  // specialization fields.
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
      [REL_PATIENT]: { select: { id: true, name: true, phone: true } },
    },
    orderBy: [{ requested_at: 'desc' }, { priority: 'desc' }],
  });

  const investigations = rows.map((r) => {
    const patient = r[REL_PATIENT] ?? null;
    const flat = { ...r };
    delete flat[REL_PATIENT];
    flat.patient_name = patient?.name ?? null;
    flat.patient_phone = patient?.phone ?? null;
    return flat;
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
      [REL_PATIENT]: { select: { id: true, name: true, phone: true } },
      [REL_DOCTOR]: { select: { id: true, uid: true, name: true } },
    },
    orderBy: { requested_at: 'desc' },
    take: 100,
  });

  const investigations = rows.map((r) => flattenRelations(r, {}));

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

  const relationFields = { patientGender: true, department: true };
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
      ...buildRelationsSelect(relationFields),
    },
    // Priority is a VARCHAR so lexical 'URGENT' < 'HIGH' < 'NORMAL' — the
    // old `ORDER BY priority DESC` inherited that same text ordering. This
    // intentionally preserves the existing behaviour; a future ticket can
    // introduce a priority_rank column if the ordering is wrong.
    orderBy: [{ priority: 'desc' }, { requested_at: 'asc' }],
  });

  const investigations = rows.map((r) => flattenRelations(r, relationFields));

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
