import * as investigationService from '../../services/investigation/investigationService.js';
import { success, error } from '../../utils/responseHelper.js';
import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import { PAGINATION, INVESTIGATION_STATUS } from '../../config/investigationConfig.js';
import logger from '../../logging/logger.js';
import { logAudit } from '../../utils/logAudit.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import db from '../../config/database.js';

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
      return res.status(404).json({ message: 'User not found' });
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
      return res.status(404).json({ 
        message: 'Investigation not found or access denied',
        id,
        requestedBy: userId
      });
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
      return res.status(404).json({ message: 'User not found' });
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
      return res.status(403).json({ 
        message: 'Access denied: Cannot view other patient records',
        requestedBy: userId
      });
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
      return res.status(403).json({ 
        message: 'Access denied: Medical staff access required',
        requestedBy: userId
      });
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
      return res.status(403).json({ 
        message: 'Access denied: Medical staff access required',
        requestedBy: userId
      });
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
      return res.status(403).json({ 
        message: 'Access denied: Medical staff access required',
        requestedBy: userId
      });
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
      return res.status(403).json({ 
        message: 'Access denied: Lab technician or doctor privileges required',
        requestedBy: userId
      });
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
      return res.status(404).json({ 
        message: 'Investigation not found',
        requestedBy: userId
      });
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
      return res.status(400).json({
        message: 'Invalid status',
        validStatuses: Object.values(INVESTIGATION_STATUS),
        requestedBy: req.user?.uid
      });
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
      return res.status(403).json({ 
        message: 'Access denied: Lab technician or doctor privileges required',
        requestedBy: userId
      });
    }

    const { id } = req.params;
    const { results, interpretation, technician_notes, reviewed_by } = req.body;

    if (!results) {
      return res.status(400).json({
        message: 'Results are required',
        requestedBy: userId
      });
    }

    const investigation = await investigationService.addResults(
      id,
      { results, interpretation, technician_notes, reviewed_by },
      userId
    );

    if (!investigation) {
      return res.status(404).json({ 
        message: 'Investigation not found',
        requestedBy: userId
      });
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
    
    // Access control
    if (userRole === 'PATIENT') {
      const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [req.user.uid]);
      if (userResult.rows.length === 0 || userResult.rows[0].phone !== phone) {
        return res.status(403).json({ 
          message: 'Access denied: Cannot view other patient records',
          requestedBy
        });
      }
    }
    
    const result = await db.query('SELECT * FROM investigations WHERE phone = $1', [phone]);
    
    await logAudit(req, 'investigations-phone-lookup', { phone, count: result.rows.length });
    
    success(res, {
      investigations: result.rows,
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
      return res.status(403).json({ 
        message: 'Access denied: Cannot view other patient records',
        requestedBy
      });
    }
    
    // Resolve UID to phone
    const userResult = await db.query('SELECT phone FROM users WHERE uid = $1', [uid]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ 
        message: 'User not found',
        uid,
        requestedBy
      });
    }
    
    const phone = userResult.rows[0].phone;
    const result = await db.query('SELECT * FROM investigations WHERE phone = $1', [phone]);
    
    await logAudit(req, 'investigations-uid-lookup', { uid, count: result.rows.length });
    
    success(res, {
      investigations: result.rows,
      requestedBy
    }, 'Investigations retrieved by UID');
    
  } catch (err) {
    logger.error('Get by UID Error:', err);
    error(res, 'Failed to retrieve investigations by UID', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};