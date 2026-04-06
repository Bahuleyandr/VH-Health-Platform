import prisma from '../../lib/prisma.js';
import { PAGINATION, INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import logger from '../../logging/logger.js';
import * as investigationService from '../../services/investigation/investigationService.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// List investigations with filtering
export const listInvestigations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || PAGINATION.DEFAULT_PAGE;
    const limit = Math.min(parseInt(req.query.limit) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;
    
    const filters = {
      patient_id: req.query.patient_id,
      doctor_id: req.query.doctor_id,
      type: req.query.type,
      status: req.query.status,
      date: req.query.date
    };

    const result = await investigationService.getInvestigations(
      page,
      limit,
      filters,
      userRole,
      userId
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
    logger.error('List Investigations Error:', err);
    if (err.message === 'USER_NOT_FOUND') {
      return error(res, 'User not found', 404);
    }
    error(res, 'Failed to retrieve investigations', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get single investigation by ID
export const getInvestigationById = async (req, res) => {
  try {
    const { id } = req.params;
    const userRole = req.user?.role?.toUpperCase();
    const userId = req.user?.uid;

    const investigation = await investigationService.getInvestigationById(
      id,
      userRole,
      userId
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
      userId
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
    const { results, interpretation, technician_notes, reviewed_by } = req.body;

    if (!results) {
      return error(res, 'Results are required', 400);
    }

    const investigation = await investigationService.addResults(
      id,
      { results, interpretation, technician_notes, reviewed_by },
      userId
    );

    if (!investigation) {
      return error(res, 'Investigation not found', 404);
    }

    await logAudit(req, 'investigation-results-added', { investigation_id: id });

    success(res, {
      investigation,
      updatedBy: userId
    }, 'Investigation results added successfully');

  } catch (err) {
    logger.error('Add Results Error:', err);
    error(res, 'Failed to add investigation results', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy: Get investigations by phone
export const getInvestigationsByPhone = async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    // Access control FIRST
    if (userRole === 'PATIENT') {
      const userResult = await prisma.$queryRawUnsafe('SELECT phone FROM users WHERE uid = $1', req.user.uid);
      if (userResult.length === 0 || userResult[0].phone !== phone) {
        return error(res, 'Access denied: Cannot view other patient records', 403);
      }
    }
    
    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;

    // Get paginated results
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone, patient_name, doctor_name, test_name, test_category,
        status, priority, notes, result_summary, lab_name, sample_collected_at,
        report_ready_at, created_at, updated_at
       FROM investigations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, phone, limit, offset);

    // Get total count for pagination
    const countResult = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) FROM investigations WHERE phone = $1',
      [phone]
    );
    
    const totalInvestigations = parseInt(countResult[0].count);
    const totalPages = Math.ceil(totalInvestigations / limit);
    
    await logAudit(req, 'investigations-phone-lookup', { 
      phone, 
      count: result.length,
      page,
      limit 
    });
    
    success(res, {
      investigations: result,
      pagination: {
        page,
        limit,
        total: totalInvestigations,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      requestedBy
    }, 'Investigations fetched successfully');
    
  } catch (err) {
    logger.error('Get by Phone Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR);
  }
};

// Legacy: Get investigations by UID
export const getInvestigationsByUID = async (req, res) => {
  try {
    const { uid } = req.params;
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    // Access control
    if (userRole === 'PATIENT' && uid !== req.user.uid) {
      return error(res, 'Access denied: Cannot view other patient records', 403);
    }

    // Resolve UID to phone
    const userResult = await prisma.$queryRawUnsafe('SELECT phone FROM users WHERE uid = $1', uid);
    if (userResult.length === 0) {
      return error(res, 'User not found', 404);
    }
    
    const phone = userResult[0].phone;
    
    // Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    
    // Get paginated results
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone, patient_name, doctor_name, test_name, test_category,
        status, priority, notes, result_summary, lab_name, sample_collected_at,
        report_ready_at, created_at, updated_at
       FROM investigations WHERE phone = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, phone, limit, offset);
    
    // Get total count
    const countResult = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) FROM investigations WHERE phone = $1',
      [phone]
    );
    
    const totalInvestigations = parseInt(countResult[0].count);
    const totalPages = Math.ceil(totalInvestigations / limit);
    
    await logAudit(req, 'investigations-uid-lookup', { 
      uid, 
      count: result.length,
      page,
      limit 
    });
    
    success(res, {
      investigations: result,
      pagination: {
        page,
        limit,
        total: totalInvestigations,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
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
    const { category } = req.query;
    const where = category ? 'WHERE category=$1 AND is_active=TRUE' : 'WHERE is_active=TRUE';
    const result = await prisma.$queryRawUnsafe(
      `SELECT id, name, category, price, description, turnaround_time, sample_type, is_available, created_at FROM investigation_test_catalog ${where} ORDER BY category, name`,
      category ? [category] : []
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
        [name, code||null, category, normal_range||null, unit||null, default_cost||null, turnaround_hours||24, requires_fasting||false, patient_instructions||null, description||null]
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

    const [summary, byStatus, byPriority, urgentPending, recentCompleted] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as total,
          COUNT(CASE WHEN status IN ('completed','COMPLETED','result_ready') THEN 1 END) as completed,
          COUNT(CASE WHEN status='PENDING' THEN 1 END) as pending,
          COUNT(CASE WHEN priority IN ('URGENT','STAT') AND status NOT IN ('completed','COMPLETED') THEN 1 END) as urgent_pending,
          AVG(CASE WHEN result_uploaded_at IS NOT NULL THEN EXTRACT(EPOCH FROM (result_uploaded_at-ordered_date))/3600 END) as avg_tat_hours
        FROM investigations WHERE DATE(ordered_date) BETWEEN $1 AND $2`, [from, to]
      ),
      prisma.$queryRawUnsafe(
        `SELECT status, COUNT(*) as count FROM investigations WHERE DATE(ordered_date) BETWEEN $1 AND $2 GROUP BY status`, [from, to]
      ),
      prisma.$queryRawUnsafe(
        `SELECT priority, COUNT(*) as count FROM investigations WHERE DATE(ordered_date) BETWEEN $1 AND $2 GROUP BY priority`, [from, to]
      ),
      prisma.$queryRawUnsafe(
        `SELECT i.*, u.name as patient_name, u.phone as patient_phone, d.name as doctor_name,
          ROUND(EXTRACT(EPOCH FROM (NOW()-i.ordered_date))/3600) as hours_waiting
        FROM investigations i LEFT JOIN users u ON i.patient_id=u.id LEFT JOIN users d ON i.doctor_id=d.id
        WHERE i.priority IN ('URGENT','STAT') AND i.status NOT IN ('completed','COMPLETED')
        ORDER BY i.ordered_date ASC LIMIT 20`
      ),
      prisma.$queryRawUnsafe(
        `SELECT i.*, u.name as patient_name,
          ROUND(EXTRACT(EPOCH FROM (COALESCE(i.result_uploaded_at,i.completed_date)-i.ordered_date))/3600,1) as tat_hours
        FROM investigations i LEFT JOIN users u ON i.patient_id=u.id
        WHERE i.status IN ('completed','COMPLETED') ORDER BY COALESCE(i.completed_date,i.updated_at) DESC LIMIT 20`
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