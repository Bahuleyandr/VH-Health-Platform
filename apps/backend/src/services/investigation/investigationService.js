import {
  INVESTIGATION_STATUS,
  MEDICAL_STAFF_ROLES,
  LAB_STAFF_ROLES
} from '../../config/investigationConfig.js';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination } from '../../utils/listQuery.js';

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
  // Migration 203 — patient-actionable collection instructions.
  // Surfaced verbatim in the patient app so the patient knows where
  // and by when to give the sample, and whether to fast.
  collection_location: true,
  collection_deadline_at: true,
  fasting_required: true,
  fasting_instructions: true,
  scheduled_date: true,
  time_slot: true,
};
// Staff list view exposes `results` plus the human-readable summary +
// pathologist interpretation, so a doctor scanning a panel of 5 lab
// results sees "Amylase: 892 U/L [H]" inline instead of having to
// fan out one GET /investigations/:id per row. Finding:
// 2026-05-09-dynamic-acute-abdomen-lab-tech-list-missing-result-summary.
const INV_LIST_SELECT_WITH_RESULTS = {
  ...INV_LIST_SELECT_BASE,
  results: true,
  result_summary: true,
  interpretation: true,
};

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
export const getInvestigations = async (page, limit, filters, userRole, userId, sort = {}) => {
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
  const { patient_id, patient_uid, doctor_id, type, status, date, search } = filters;

  // Only allow patient_id filter for non-PATIENT roles (replicates original behaviour)
  if (patient_id && userRole !== 'PATIENT') {
    where.patient_id = parseInt(patient_id);
  }

  // `patient_uid` filter: staff/clinicians review a patient chart by the
  // patient's UID (users.uid). The investigations table keys patients by
  // the integer `patient_id` (FK → users.id), so resolve the UID once and
  // scope by patient_id. Previously this param was ignored entirely, so
  // the list returned EVERY patient's investigations — a PHI leak (finding
  // 2026-05-21-inpatient-admission-doctor-58437f67). PATIENT role is
  // already locked to its own patient_id above and must not be widened.
  if (patient_uid && userRole !== 'PATIENT') {
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_PATTERN.test(String(patient_uid))) {
      throw AppError.badRequest('patient_uid must be a UUID');
    }
    const patientRow = await prisma.users.findUnique({
      where: { uid: String(patient_uid) },
      select: { id: true },
    });
    if (patientRow?.id) {
      // Fail closed: if both patient_id and patient_uid are supplied they
      // must agree, otherwise the query is ambiguous — never widen to all.
      if (where.patient_id != null && where.patient_id !== patientRow.id) {
        where.id = -1;
      } else {
        where.patient_id = patientRow.id;
      }
    } else {
      // No matching user → impossible id sentinel (zero rows), never all.
      where.id = -1;
    }
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
  if (search) {
    where.OR = [
      { test_name: { contains: search, mode: 'insensitive' } },
      { test_type: { contains: search, mode: 'insensitive' } },
      { notes: { contains: search, mode: 'insensitive' } },
    ];
  }

  const relationFields = { specialization: true, doctorPhone: true };
  const sortFields = {
    id: { id: sort.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc' },
    test_name: { test_name: sort.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc' },
    priority: { priority: sort.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc' },
    status: { status: sort.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc' },
    requested_at: { requested_at: sort.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc' },
    created_at: { created_at: sort.sortOrder?.toLowerCase() === 'asc' ? 'asc' : 'desc' },
  };
  const orderBy = sortFields[sort.sortBy] ?? { requested_at: 'desc' };
  const [rows, totalInvestigations] = await Promise.all([
    prisma.investigations.findMany({
      where,
      select: {
        ...(userRole === 'PATIENT' ? INV_LIST_SELECT_BASE : INV_LIST_SELECT_WITH_RESULTS),
        ...buildRelationsSelect(relationFields),
      },
      orderBy,
      take: limit,
      skip: offset,
    }),
    prisma.investigations.count({ where }),
  ]);

  const investigations = rows.map((r) => flattenRelations(r, relationFields));

  return {
    investigations,
    pagination: buildPagination(totalInvestigations, page, limit),
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
  if (userRole === 'PATIENT' && !status) {
    where.status = { not: INVESTIGATION_STATUS.CANCELLED };
  }

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
  const normalizedStatus = status.toUpperCase();
  if (!validStatuses.includes(normalizedStatus)) {
    throw new Error('INVALID_STATUS');
  }

  const data = { status: normalizedStatus };
  if (notes != null) data.notes = notes;
  if (normalizedStatus === 'COLLECTED') {
    const existing = await prisma.investigations.findUnique({
      where: { id: parseInt(id) },
      select: { sample_barcode: true },
    });
    data.collected_at = new Date();
    data.collected_by = userId || null;
    data.collected_notes = notes ?? null;
    data.sample_barcode = existing?.sample_barcode || mintInvestigationBarcode(parseInt(id));
  }
  if (normalizedStatus === 'COMPLETED') {
    data.completed_at = new Date();
    data.verified_at = new Date();
    data.verified_by = userId || null;
  }
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
    collected_at: true,
    collected_by: true,
    collected_notes: true,
    sample_barcode: true,
    completed_at: true,
    verified_at: true,
    verified_by: true,
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

// Walk a free-form lab `results` JSON and elevate per-analyte `flag` to
// 'CRITICAL' (panic) when the numeric value crosses a 3× ULN or LLN/3
// threshold derived from a string normal_range / reference_range field.
// The tech-supplied `flag` ('H'/'L') is preserved when value is merely
// abnormal but inside the panic threshold. Finding:
// 2026-05-09-dynamic-acute-abdomen-doctor-critical-lab-flag-not-critical.
function elevatePanicFlags(results) {
  if (!results || typeof results !== 'object') return results;

  const PANIC_MULTIPLIER = 3;

  const parseRange = (raw) => {
    if (raw == null) return null;
    const s = String(raw).trim();
    // "28-100" or "28 - 100" or "28–100"
    let m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[-–—to]+\s*(-?\d+(?:\.\d+)?)\s*$/i);
    if (m) return { low: Number(m[1]), high: Number(m[2]) };
    // "< 160" / "≤ 160"
    m = s.match(/^\s*[<≤]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { low: null, high: Number(m[1]) };
    // "> 5" / "≥ 5"
    m = s.match(/^\s*[>≥]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { low: Number(m[1]), high: null };
    return null;
  };

  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const valueRaw = obj.value ?? obj.result;
    if (valueRaw !== undefined) {
      const v = Number(valueRaw);
      const range = parseRange(obj.normal_range ?? obj.reference_range);
      if (Number.isFinite(v) && range) {
        let elevated = null;
        if (range.high != null && v >= range.high * PANIC_MULTIPLIER) elevated = 'HH';
        else if (range.low != null && range.low > 0 && v <= range.low / PANIC_MULTIPLIER) elevated = 'LL';
        if (elevated) {
          obj.flag = elevated;
          if (obj.abnormal_flag !== undefined) obj.abnormal_flag = elevated;
          obj.is_critical = true;
        }
      }
    }
    for (const child of Object.values(obj)) {
      if (child && typeof child === 'object') visit(child);
    }
  };

  visit(results);
  return results;
}

// Add investigation results.
//
// E-5 — versioning. Migration 185 added previous_results (JSONB) and
// result_version (INTEGER). On a re-submit, the existing results are
// pushed into previous_results before being overwritten, and
// result_version is bumped. A re-submit also REQUIRES an explicit
// `re_run: true` flag plus a non-trivial `re_run_reason` (≥5 chars);
// without those the service throws a 409 instead of silently
// overwriting a verified result. Auditors can walk previous_results +
// the per-version re_run_reason to reconstruct the full timeline.
// Finding:
// 2026-05-08-lab-walk-in-lab-tech-results-overwrite-no-history.
export const addResults = async (id, resultData, userId) => {
  const { results, interpretation, reviewed_by, re_run, re_run_reason } = resultData;

  const investId = parseInt(id, 10);
  if (!Number.isInteger(investId)) return null;

  // Snapshot prior state into previous_results before overwriting.
  // Use a transaction so a partial fail leaves the row intact.
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.investigations.findUnique({
        where: { id: investId },
        select: {
          id: true, results: true, interpretation: true,
          status: true, completed_at: true,
          previous_results: true, result_version: true,
        },
      });
      if (!existing) return null;

      const now = new Date();
      const isReSubmit = existing.results !== null && existing.results !== undefined;

      if (isReSubmit) {
        if (re_run !== true) {
          throw AppError.conflict(
            'Investigation already has results. Pass `re_run: true` with a `re_run_reason` (>=5 chars) to supersede.',
            'RESULTS_ALREADY_SUBMITTED',
            { current_version: existing.result_version ?? 1 },
          );
        }
        if (typeof re_run_reason !== 'string' || re_run_reason.trim().length < 5) {
          throw AppError.badRequest(
            '`re_run_reason` is required (>=5 chars) when re-submitting a result.',
            'RE_RUN_REASON_REQUIRED',
          );
        }
      }

      let priorHistory = Array.isArray(existing.previous_results) ? existing.previous_results : [];
      if (isReSubmit) {
        priorHistory = [
          ...priorHistory,
          {
            results: existing.results,
            interpretation: existing.interpretation ?? null,
            status: existing.status ?? null,
            completed_at: existing.completed_at ?? null,
            superseded_at: now.toISOString(),
            superseded_by: userId ?? null,
            re_run_reason: re_run_reason.trim(),
            version: existing.result_version ?? 1,
          },
        ];
      }

      // E-11 — derive a patient-facing result_summary string from the
      // structured results JSON. Best-effort: handles per-analyte
      // {value, unit, normal_range, flag} shapes plus generic top-level
      // {value, unit} payloads. Renders "Test: value unit (normal range)
      // [FLAG]" lines so the patient app has something readable when the
      // doctor hasn't typed an interpretation yet. Finding:
      // 2026-05-08-lab-walk-in-patient-results-summary-empty.
      let resultSummary = null;
      try {
        if (results && typeof results === 'object') {
          const lines = [];
          const visit = (obj, label = '') => {
            if (!obj || typeof obj !== 'object') return;
            if (obj.value !== undefined || obj.result !== undefined) {
              const v = obj.value ?? obj.result;
              const unit = obj.unit ? ` ${obj.unit}` : '';
              const range = obj.normal_range || obj.reference_range
                ? ` (normal: ${obj.normal_range || obj.reference_range})`
                : '';
              const flag = obj.abnormal_flag || obj.flag;
              const flagStr = flag && flag !== 'N' ? ` [${flag}]` : '';
              // Prefer an explicit analyte name on the row over the object
              // key — when results is an array of analyte objects
              // ([{name:'Hemoglobin',value:'16.8',...}, ...]) the key is
              // just the array index "0" / "1" / ..., which renders as
              // "0: 16.8 g/dL" and is unsafe for verbal handoff. Finding:
              // 2026-05-13-inpatient-admission-lab-tech-1af0d92d.
              const analyteName = obj.name || obj.test_name || obj.analyte || obj.parameter;
              lines.push(`${analyteName || label || 'Result'}: ${v}${unit}${range}${flagStr}`);
              return;
            }
            for (const [k, child] of Object.entries(obj)) {
              if (child && typeof child === 'object') {
                // When walking into a child object, prefer a name-like
                // field on the child over the parent's index/key.
                const childLabel = (child && typeof child === 'object'
                  && (child.name || child.test_name || child.analyte || child.parameter))
                  || k;
                visit(child, childLabel);
              }
            }
          };
          visit(results);
          if (lines.length) resultSummary = lines.slice(0, 20).join('\n');
        }
      } catch {
        // Summary is best-effort; never block result write on it.
      }

      const elevatedResults = elevatePanicFlags(results);

      const data = {
        results: elevatedResults,
        status: 'COMPLETED',
        completed_at: now,
        result_uploaded_at: now,
        verified_at: now,
        verified_by: reviewed_by || userId || null,
        result_summary: resultSummary,
        previous_results: priorHistory.length ? priorHistory : null,
        // Coerce to Number — Prisma sometimes returns BigInt for Int
        // columns under driver-adapter mode and `BigInt + Number` throws
        // `TypeError: Cannot mix BigInt and other types`, which the
        // controller surfaces as a generic 500.
        result_version: Number(existing.result_version ?? 1) + (isReSubmit ? 1 : 0),
        // updated_at is NOT NULL with no `@updatedAt` decorator in the
        // Prisma model, so leaving it out keeps the previous timestamp
        // but masks the result-completion event from downstream sync
        // pipelines that watch updated_at. Stamp it explicitly. Finding:
        // 2026-05-10-emergency-walk-in-lab-tech-investigation-result-write-500.
        updated_at: now,
      };
      if (interpretation != null) data.interpretation = interpretation;

      const updated = await tx.investigations.update({
        where: { id: investId },
        data,
        select: {
          id: true, patient_id: true, requested_by: true,
          test_name: true, test_type: true, status: true,
          results: true, interpretation: true, result_summary: true,
          completed_at: true, verified_at: true, verified_by: true, updated_at: true,
          previous_results: true, result_version: true,
        },
      });

      // E-11 — patient + ordering doctor notification on COMPLETED.
      // Queues outbox rows so SMS / push / inapp can dispatch async.
      // Best-effort; queue failures don't roll back the result write.
      // Finding: 2026-05-08-lab-walk-in-patient-no-result-notification.
      try {
        const { default: outbox } = await import('../../utils/notifications/notificationOutbox.js');
        const ctx = await tx.$queryRawUnsafe(
          `SELECT i.patient_id, u.name AS patient_name, u.phone AS patient_phone
             FROM investigations i
             LEFT JOIN users u ON u.id = i.patient_id
            WHERE i.id = $1::int`,
          investId,
        );
        const c = ctx[0];
        if (c?.patient_phone) {
          await outbox.queue({
            type: 'lab_result_ready',
            recipientId: c.patient_id,
            recipientPhone: c.patient_phone,
            title: 'Lab result is ready',
            body: `Hi ${c.patient_name || ''}, your ${updated.test_name} result is ready. Open the app to view.`,
            data: { investigation_id: updated.id, test_name: updated.test_name },
          }).catch(() => {});
        }
      } catch {
        // Notification dispatch is best-effort.
      }
      return updated;
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

/**
 * Wave-5 batch-3 — stamp sample collection on an investigations row.
 *
 * The `investigations` table has had `collected_at` + `collected_by`
 * since migration 088 (SELECT drift sweep), but no service ever wrote
 * to them — `markCollected` updates `investigation_bookings` only, and
 * one of the legacy SELECTs aliases `requested_at AS sample_collected_at`
 * to paper over the gap. Lab walk-ins (no booking row) had no
 * collection event at all. Migration 214 adds:
 *   * sample_barcode VARCHAR(40) — printable barcode minted at collection
 *   * collected_notes TEXT — phlebotomist notes (e.g. "haemolysed")
 *   * verified_at / verified_by — supervisor counter-signature
 *
 * Barcode format: `INV-<id-base36>-<6-char-random-base36>` (≤ 40 chars
 * for the entire id space). Auto-minted if caller doesn't supply one.
 * The DB enforces uniqueness on non-null barcodes.
 *
 * Findings:
 *   2026-05-10-lab-walk-in-lab-tech-no-sample-barcode-audit
 *   2026-05-10-obstetric-anc-lab-tech-collected-time-missing
 */
function mintInvestigationBarcode(investigationId) {
  const idPart = Number(investigationId).toString(36).toUpperCase();
  // 6-char base36 ≈ 36^6 = 2.18B values — collision-resistant for the
  // hospital-shift window even before the per-id namespace.
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).toUpperCase().padStart(6, '0');
  return `INV-${idPart}-${rand}`;
}

export const markSampleCollected = async ({
  id, collected_by, collected_notes, sample_barcode,
}) => {
  const investigationId = parseInt(id, 10);
  if (!Number.isFinite(investigationId) || investigationId <= 0) {
    throw AppError.badRequest('id must be a positive integer');
  }
  if (!collected_by) {
    throw AppError.badRequest('collected_by (staff uid) is required');
  }

  // Phase 0 — pre-flight existence + state check. P2025 from the
  // update would translate to a generic 500; surface the missing-row
  // case explicitly.
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, status, sample_barcode
       FROM investigations
      WHERE id = $1::int
      LIMIT 1`,
    investigationId,
  );
  if (!existing.length) throw AppError.notFound('Investigation not found');

  // Reuse the existing barcode if the caller is re-marking (idempotent
  // for "redraw" workflows). Otherwise mint a new one if not supplied.
  let resolvedBarcode = sample_barcode ? String(sample_barcode).trim().slice(0, 40) : null;
  if (!resolvedBarcode) {
    resolvedBarcode = existing[0].sample_barcode || mintInvestigationBarcode(investigationId);
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE investigations
        SET status = 'COLLECTED',
            collected_at = NOW(),
            collected_by = $1::uuid,
            collected_notes = $2,
            sample_barcode = $3,
            updated_at = NOW()
      WHERE id = $4::int
      RETURNING id, uid, status, collected_at, collected_by,
                collected_notes, sample_barcode`,
    String(collected_by),
    collected_notes || null,
    resolvedBarcode,
    investigationId,
  );
  return rows[0];
};

export const canAddResults = (userRole) => {
  return LAB_STAFF_ROLES.includes(userRole);
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN'].includes(userRole);
};
