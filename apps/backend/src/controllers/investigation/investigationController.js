import { PAGINATION, INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as investigationService from '../../services/investigation/investigationService.js';
import { resolveDoctorFilterId } from '../../services/doctor/doctorRefService.js';
import { logAudit } from '../../utils/logAudit.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { getAuthenticatedActorRoles } from '../../utils/roleHelpers.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

// List investigations with filtering
export const listInvestigations = async (req, res) => {
  try {
    const listQuery = parseListQuery(req.query, {
      defaultPage: PAGINATION.DEFAULT_PAGE,
      defaultLimit: PAGINATION.DEFAULT_LIMIT,
      maxLimit: PAGINATION.MAX_LIMIT,
      defaultSortBy: 'requested_at',
    });
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    
    const filters = {
      patient_id: req.query.patient_id,
      // Staff/clinicians review a patient's chart by UID. Without this the
      // filter was silently dropped and the list returned every patient's
      // investigations — a PHI leak. Resolved to patient_id in the service.
      // Finding: 2026-05-21-inpatient-admission-doctor-58437f67.
      patient_uid: req.query.patient_uid,
      // Roadmap A9: canonicalize to users.id whichever id space the caller used.
      doctor_id: await resolveDoctorFilterId(prisma, req.query.doctor_id, {
        tenantId: req.tenantId || null,
      }),
      type: req.query.type,
      status: req.query.status,
      date: req.query.date,
      search: listQuery.search,
    };

    const result = await investigationService.getInvestigations(
      listQuery.page,
      listQuery.limit,
      filters,
      userRole,
      userId,
      {
        sortBy: listQuery.sortBy,
        sortOrder: listQuery.sortOrder,
      }
    );

    await logAudit(req, 'investigation-list-view', {
      count: result.investigations.length,
      filters
    });

    success(res, {
      ...result,
      requestedBy: userId,
      userRole
    }, 'Investigations retrieved successfully');

  } catch (err) {
    if (err.message === 'USER_NOT_FOUND') {
      logger.error('List Investigations Error:', err);
      return error(res, 'User not found', 404);
    }
    // Operational AppErrors (e.g. a malformed patient_uid → 400) carry a safe
    // client message + status; surface them instead of masking as a 500.
    return relayAppError(res, err, 'Failed to retrieve investigations');
  }
};

// Get single investigation by ID
export const getInvestigationById = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;

    // An id outside int4 range (e.g. a phone-shaped path segment, now that the
    // legacy GET /:phone route is gone) can never match a SERIAL id — return
    // 404 instead of letting the DB raise a 22003 out-of-range 500.
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum < 1 || idNum > 2147483647) {
      return error(res, 'Investigation not found', HTTP_STATUS.NOT_FOUND);
    }

    const investigation = await investigationService.getInvestigationById(
      id,
      userRole,
      userId,
      req.tenantId,
    );

    if (!investigation) {
      return error(res, 'Investigation not found or access denied', 404);
    }

    await logAudit(req, 'investigation-view', { investigation_id: id });

    success(res, {
      investigation,
      requestedBy: userId,
      accessLevel: userRole
    }, 'Investigation retrieved successfully');

  } catch (err) {
    logger.error('Get Investigation Error:', err);
    if (err.message === 'USER_NOT_FOUND') {
      return error(res, 'User not found', 404);
    }
    error(res, 'Failed to retrieve investigation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get investigations by patient
export const getPatientInvestigations = async (req, res) => {
  try {
    const { patient_id } = req.params;
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    const { type, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = await investigationService.getPatientInvestigations(
      patient_id,
      { type, status, limit },
      userRole,
      userId
    );

    if (!result) {
      return error(res, 'Access denied: Cannot view other patient records', 403);
    }

    await logAudit(req, 'patient-investigations-view', {
      patient_id,
      count: result.investigations.length
    });

    success(res, {
      ...result,
      requestedBy: userId,
      accessLevel: userRole
    }, 'Patient investigations retrieved successfully');

  } catch (err) {
    logger.error('Get Patient Investigations Error:', err);
    error(res, 'Failed to retrieve patient investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get investigations by doctor
export const getDoctorInvestigations = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    
    if (!investigationService.canViewDoctorInvestigations(userRole)) {
      return error(res, 'Access denied: Medical staff access required', 403);
    }

    const { doctor_id } = req.params;
    const { date, status = 'PENDING' } = req.query;

    const result = await investigationService.getDoctorInvestigations(
      doctor_id,
      { date, status }
    );

    await logAudit(req, 'doctor-investigations-view', { 
      doctor_id, 
      status, 
      count: result.investigations.length 
    });

    success(res, {
      ...result,
      requestedBy: userId
    }, 'Doctor investigations retrieved successfully');

  } catch (err) {
    logger.error('Get Doctor Investigations Error:', err);
    error(res, 'Failed to retrieve doctor investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get investigations by type
export const getInvestigationsByType = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    
    if (!investigationService.canViewByType(userRole)) {
      return error(res, 'Access denied: Medical staff access required', 403);
    }

    const { type } = req.params;
    const { status, date } = req.query;

    const result = await investigationService.getInvestigationsByType(
      type,
      { status, date }
    );

    await logAudit(req, 'investigations-by-type-view', { 
      type, 
      status, 
      count: result.investigations.length 
    });

    success(res, {
      ...result,
      requestedBy: userId
    }, `${type} investigations retrieved successfully`);

  } catch (err) {
    logger.error('Get Investigations by Type Error:', err);
    error(res, 'Failed to retrieve investigations by type', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get pending investigations
export const getPendingInvestigations = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    
    if (!investigationService.canViewPending(userRole)) {
      return error(res, 'Access denied: Medical staff access required', 403);
    }

    const { type, priority } = req.query;

    const result = await investigationService.getPendingInvestigations({ type, priority });

    await logAudit(req, 'pending-investigations-view', { 
      type, 
      priority, 
      count: result.investigations.length 
    });

    success(res, {
      ...result,
      requestedBy: userId
    }, 'Pending investigations retrieved successfully');

  } catch (err) {
    logger.error('Get Pending Investigations Error:', err);
    error(res, 'Failed to retrieve pending investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Wave-5 batch-3 — stamp sample collection on an investigations row.
// Distinct from `POST /bookings/:id/collected` which works on the
// upstream `investigation_bookings` scheduling table. This endpoint
// targets the investigations row directly so lab walk-ins (no
// booking) and booking-driven flows both leave a stamped collection
// event with a printable barcode. Findings:
//   2026-05-10-lab-walk-in-lab-tech-no-sample-barcode-audit
//   2026-05-10-obstetric-anc-lab-tech-collected-time-missing
export const markInvestigationCollected = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    if (!investigationService.canUpdateStatus(userRole)) {
      return error(res, 'Access denied: lab technician or doctor privileges required', HTTP_STATUS.FORBIDDEN);
    }
    const { id } = req.params;
    const { collected_notes, sample_barcode, scanned_patient_uid } = req.body || {};

    const row = await investigationService.markSampleCollected({
      id,
      collected_by: req.user?.uid,
      collected_notes,
      sample_barcode,
      scanned_patient_uid,
      tenantId: req.tenantId || null,
      actor_role: req.user?.role || null,
    });

    await logAudit(req, 'investigation-sample-collected', {
      investigation_id: row.id,
      sample_barcode: row.sample_barcode,
    });

    success(res, row, 'Sample collected');
  } catch (err) {
    if (err?.isOperational && err?.statusCode) {
      return relayAppError(res, err, 'Failed to mark sample collected');
    }
    logger.error('markInvestigationCollected error:', { err: err?.message, stack: err?.stack });
    error(res, 'Failed to mark sample collected', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Update investigation status
export const updateInvestigationStatus = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    
    if (!investigationService.canUpdateStatus(userRole)) {
      return error(res, 'Access denied: Lab technician or doctor privileges required', 403);
    }

    const { id } = req.params;
    const { status, notes } = req.body;

    const investigation = await investigationService.updateStatus(
      id,
      status,
      notes,
      userId,
      req.tenantId,
      req.user?.role || null,
    );

    if (!investigation) {
      return error(res, 'Investigation not found', 404);
    }

    await logAudit(req, 'investigation-status-updated', { 
      investigation_id: id,
      new_status: status.toUpperCase()
    });

    success(res, {
      investigation,
      updatedBy: userId
    }, 'Investigation status updated successfully');

  } catch (err) {
    logger.error('Update Status Error:', err);
    if (err.message === 'INVALID_STATUS') {
      return error(res, 'Invalid status', 400, { validStatuses: Object.values(INVESTIGATION_STATUS) });
    }
    error(res, 'Failed to update investigation status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Add investigation results
export const addInvestigationResults = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;

    if (!investigationService.canAddResults(userRole)) {
      return error(res, 'Access denied: Lab technician or doctor privileges required', 403);
    }

    const { id } = req.params;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'reviewed_by')) {
      return error(res, 'reviewed_by is server-derived and must not be supplied', 400);
    }
    const { results, interpretation, technician_notes, re_run, re_run_reason } = req.body;

    if (!results) {
      return error(res, 'Results are required', 400);
    }

    const investigation = await investigationService.addResults(
      id,
      { results, interpretation, technician_notes, re_run, re_run_reason },
      userId,
      req.tenantId,
      req.user?.role || null,
      {
        actorRoles: getAuthenticatedActorRoles(req.user),
        actorRawRole: req.user?.rawRole || req.user?.role || null,
      },
    );

    if (!investigation) {
      return error(res, 'Investigation not found', 404);
    }

    await logAudit(req, 'investigation-results-added', {
      investigation_id: id,
      re_run: re_run === true,
    });

    success(res, {
      investigation,
      updatedBy: userId
    }, 'Investigation results added successfully');

  } catch (err) {
    // Surface 409 RESULTS_ALREADY_SUBMITTED + 400 RE_RUN_REASON_REQUIRED
    // from the service so callers can drive the explicit-re-run UX.
    if (err?.isOperational && err?.statusCode && err?.code) {
      return relayAppError(res, err, 'Failed to add investigation results');
    }
    logger.error('Add Results Error:', err);
    error(res, 'Failed to add investigation results', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /investigations/my — the caller's own investigations, with the patient
// derived from the JWT (no phone / patient_id / uid in the URL). Delegates to
// the by-UID handler with the authenticated uid.
export const getMyInvestigations = async (req, res) => {
  req.params = { ...req.params, uid: req.user?.uid };
  return getInvestigationsByUID(req, res);
};

// Legacy: Get investigations by UID
export const getInvestigationsByUID = async (req, res) => {
  try {
    const { uid } = req.params;
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;

    // Validate the UID shape BEFORE the ::uuid cast. The endpoint is
    // exposed to phlebotomists scanning sample barcodes — a misread or
    // malformed scan ("NOT-A-BARCODE", a sample-collection code, a
    // smudged QR string) previously reached the Postgres uuid cast and
    // raised `invalid input syntax for type uuid`, surfacing as a 500.
    // Reject up-front with a clean 400 so the lab tech sees a real
    // validation message instead of an opaque backend error. Finding:
    // 2026-05-10-obstetric-anc-lab-tech-malformed-barcode-500.
    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uid || !UUID_PATTERN.test(String(uid))) {
      return error(
        res,
        'Invalid UID — must be a UUID (sample barcode misread?). Re-scan and retry.',
        HTTP_STATUS.BAD_REQUEST,
        { code: 'INVALID_UID' },
      );
    }

    // Access control
    if (userRole === 'PATIENT' && uid !== req.user.uid) {
      return error(res, 'Access denied: Cannot view other patient records', 403);
    }

    // Resolve UID to phone — explicit ::uuid cast avoids the "operator
    // does not exist: uuid = text" error when Prisma binds the param.
    const userResult = await prisma.$queryRawUnsafe('SELECT phone FROM users WHERE uid = $1::uuid', uid);
    if (userResult.length === 0) {
      return error(res, 'User not found', 404);
    }
    
    const phone = userResult[0].phone;
    
    // Pagination parameters
    const { page, limit, offset } = parseListQuery(req.query, {
      defaultLimit: 20,
      maxLimit: 100,
      defaultSortBy: 'created_at',
    });
    
    // Get paginated results
    const result = await prisma.$queryRawUnsafe(
      `SELECT i.id, i.uid, i.phone,
        p.name AS patient_name,
        d.name AS requested_by_name,
        d.role AS requested_by_role,
        CASE WHEN doc.id IS NOT NULL THEN d.name ELSE NULL END AS doctor_name,
        doc.id AS doctor_id,
        i.test_name,
        i.investigation_type AS test_category,
        i.status, i.priority, i.notes, i.result_summary,
        NULL::text AS lab_name,
        i.collected_at AS sample_collected_at,
        i.sample_barcode,
        i.result_uploaded_at AS report_ready_at,
        i.created_at, i.updated_at
       FROM investigations i
       LEFT JOIN users p ON i.patient_id = p.id
       LEFT JOIN users d ON i.requested_by = d.uid
       LEFT JOIN doctors doc ON d.id = doc.user_id
       WHERE i.phone = $1
       ORDER BY i.created_at DESC
       LIMIT $2 OFFSET $3`, phone, limit, offset);
    
    // Get total count
    const countResult = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) FROM investigations WHERE phone = $1',
      phone
    );
    
    const totalInvestigations = parseInt(countResult[0].count);
    const pagination = buildPagination(totalInvestigations, page, limit);
    
    await logAudit(req, 'investigations-uid-lookup', { 
      uid, 
      count: result.length,
      page,
      limit 
    });
    
    success(res, {
      investigations: result,
      pagination,
      requestedBy
    }, 'Investigations retrieved by UID');
    
  } catch (err) {
    logger.error('Get by UID Error:', err);
    error(res, 'Failed to retrieve investigations by UID', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── Test Catalog ───

export const getTestCatalog = async (req, res) => {
  try {
    // E-6 — `search` query param now actually filters (case-insensitive
    // match against name + code). Previous behaviour silently ignored
    // it and returned the full roster. Finding:
    // 2026-05-08-emergency-walk-in-doctor-catalog-no-ecg-free-text-bypass.
    const { category, search } = req.query;
    const conds = ['is_active=TRUE'];
    const params = [];
    if (category) {
      params.push(category);
      conds.push(`category=$${params.length}`);
    }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      conds.push(`(name ILIKE $${params.length} OR COALESCE(code,'') ILIKE $${params.length})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, name, code, category, description, normal_range, unit,
              default_cost, home_collection_surcharge, turnaround_hours,
              requires_fasting, patient_instructions, is_active, created_at
         FROM investigation_test_catalog ${where}
        ORDER BY category, name`,
      ...params
    );
    success(res, result, 'Test catalog');
  } catch (err) {
    logger.error('Get Test Catalog Error:', err);
    error(res, 'Failed to fetch test catalog', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const upsertTestCatalog = async (req, res) => {
  try {
    const { id, name, code, category, normal_range, unit, default_cost, turnaround_hours, requires_fasting, patient_instructions, description } = req.body;
    if (!name || !category) return error(res, 'name and category required', HTTP_STATUS.BAD_REQUEST);
    let result;
    if (id) {
      result = await prisma.$queryRawUnsafe(
        `UPDATE investigation_test_catalog SET name=$1,code=$2,category=$3,normal_range=$4,unit=$5,default_cost=$6,turnaround_hours=$7,requires_fasting=$8,patient_instructions=$9,description=$10 WHERE id=$11 RETURNING id, name, code, category, normal_range, unit, default_cost, turnaround_hours, requires_fasting, patient_instructions, description`, name, code||null, category, normal_range||null, unit||null, default_cost||null, turnaround_hours||24, requires_fasting||false, patient_instructions||null, description||null, id);
    } else {
      result = await prisma.$queryRawUnsafe(
        `INSERT INTO investigation_test_catalog (name,code,category,normal_range,unit,default_cost,turnaround_hours,requires_fasting,patient_instructions,description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, name, code, category, normal_range, unit, default_cost, turnaround_hours, requires_fasting, patient_instructions, description`,
        name, code||null, category, normal_range||null, unit||null, default_cost||null, turnaround_hours||24, requires_fasting||false, patient_instructions||null, description||null
      );
    }
    success(res, result[0], id ? 'Updated' : 'Added');
  } catch (err) {
    logger.error('Upsert Test Catalog Error:', err);
    error(res, 'Failed to save test catalog entry', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ─── SLA Dashboard ───

export const getInvestigationSLADashboard = async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const from = from_date || new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
    const to = to_date || new Date().toISOString().split('T')[0];

    // Aligned to canonical `investigations` schema: requested_at / completed_at
    // (not ordered_date / completed_date), requested_by UUID → users.uid
    // (not doctor_id int → users.id).
    const [summary, byStatus, byPriority, urgentPending, recentCompleted] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as total,
          COUNT(CASE WHEN status IN ('completed','COMPLETED','result_ready') THEN 1 END) as completed,
          COUNT(CASE WHEN status='PENDING' THEN 1 END) as pending,
          COUNT(CASE WHEN priority IN ('URGENT','STAT') AND status NOT IN ('completed','COMPLETED') THEN 1 END) as urgent_pending,
          AVG(CASE WHEN result_uploaded_at IS NOT NULL THEN EXTRACT(EPOCH FROM (result_uploaded_at-requested_at))/3600 END) as avg_tat_hours
        FROM investigations WHERE DATE(requested_at) BETWEEN $1::date AND $2::date`, from, to
      ),
      prisma.$queryRawUnsafe(
        `SELECT status, COUNT(*) as count FROM investigations WHERE DATE(requested_at) BETWEEN $1::date AND $2::date GROUP BY status`, from, to
      ),
      prisma.$queryRawUnsafe(
        `SELECT priority, COUNT(*) as count FROM investigations WHERE DATE(requested_at) BETWEEN $1::date AND $2::date GROUP BY priority`, from, to
      ),
      prisma.$queryRawUnsafe(
        `SELECT i.*, u.name as patient_name, u.phone as patient_phone,
          d.name as requested_by_name, d.role as requested_by_role,
          CASE WHEN doc.id IS NOT NULL THEN d.name ELSE NULL END as doctor_name,
          doc.id as doctor_id,
          ROUND(EXTRACT(EPOCH FROM (NOW()-i.requested_at))/3600) as hours_waiting
        FROM investigations i
        LEFT JOIN users u ON i.patient_id=u.id
        LEFT JOIN users d ON i.requested_by=d.uid
        LEFT JOIN doctors doc ON d.id=doc.user_id
        WHERE i.priority IN ('URGENT','STAT') AND i.status NOT IN ('completed','COMPLETED')
        ORDER BY i.requested_at ASC LIMIT 20`
      ),
      prisma.$queryRawUnsafe(
        `SELECT i.*, u.name as patient_name,
          ROUND(EXTRACT(EPOCH FROM (COALESCE(i.result_uploaded_at,i.completed_at)-i.requested_at))/3600,1) as tat_hours
        FROM investigations i LEFT JOIN users u ON i.patient_id=u.id
        WHERE i.status IN ('completed','COMPLETED') ORDER BY COALESCE(i.completed_at,i.updated_at) DESC LIMIT 20`
      )
    ]);

    success(res, {
      summary: summary[0],
      by_status: byStatus,
      by_priority: byPriority,
      urgent_pending: urgentPending,
      recent_completed: recentCompleted,
      date_range: { from, to }
    });
  } catch (err) {
    logger.error('SLA Dashboard Error:', err);
    error(res, 'Failed to fetch SLA dashboard', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
