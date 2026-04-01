// src/routes/quality/qualityRoutes.js
// Quality & Infection Control Routes (JWT required)

import { Router } from 'express';
import { validationResult } from 'express-validator';
import { requiredUUID, requiredString, requiredNumber, requiredEnum, optionalString, optionalNumber, optionalEnum, paramId } from '../../validators/sharedValidators.js';
import qualityService from '../../services/quality/qualityService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isStaff, isAdmin, isClinical } from '../../utils/roleHelpers.js';
import logger from '../../logging/logger.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

const QUALITY_ROLES = ['QUALITY_OFFICER', 'ADMIN', 'SUPER_ADMIN'];
const LEADERSHIP_ROLES = ['CMO', 'CNO', 'DEPARTMENT_HEAD'];
const IC_ROLES = ['INFECTION_CONTROL_OFFICER'];

function hasQualityAccess(role) {
  return QUALITY_ROLES.includes(role) || LEADERSHIP_ROLES.includes(role);
}

function hasICAccess(role) {
  return IC_ROLES.includes(role) || role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'CMO';
}

// ─── Quality Incidents ─────────────────────────────────────────────────────

/**
 * POST /quality/incidents
 * Report a new quality incident — any staff can report
 */
router.post('/incidents', requiredString('description', 2000), requiredEnum('severity', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), validate, async (req, res, next) => {
  try {
    if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Only staff can report incidents', 403);
    }

    const incidentData = {
      reported_by: req.user?.uid,
      patient_uid: req.body.patient_uid,
      incident_type: req.body.incident_type,
      severity: req.body.severity,
      description: req.body.description,
      location: req.body.location,
      date_occurred: req.body.date_occurred,
    };

    const incident = await qualityService.reportIncident(incidentData);

    return success(res, incident, 'Incident reported successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to report quality incident:', { error: err.message });
    next(err);
  }
});

/**
 * GET /quality/incidents
 * List incidents — QUALITY_OFFICER, ADMIN, LEADERSHIP
 */
router.get('/incidents', async (req, res, next) => {
  try {
    if (!hasQualityAccess(req.user?.role)) {
      return error(res, 'Insufficient permissions to view incidents', 403);
    }

    const filters = {
      status: req.query.status,
      incident_type: req.query.incident_type,
      severity: req.query.severity,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await qualityService.getIncidents(filters);

    return success(res, result.incidents, 'Incidents retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get quality incidents:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /quality/incidents/:id
 * Update an incident — QUALITY_OFFICER, ADMIN
 */
router.put('/incidents/:id', paramId(), validate, async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!QUALITY_ROLES.includes(role)) {
      return error(res, 'Only quality officers or admins can update incidents', 403);
    }

    const updateData = {
      root_cause: req.body.root_cause,
      corrective_action: req.body.corrective_action,
      preventive_action: req.body.preventive_action,
      status: req.body.status,
      investigated_by: req.body.investigated_by || req.user?.uid,
    };

    const incident = await qualityService.updateIncident(req.params.id, updateData);

    return success(res, incident, 'Incident updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to update quality incident:', { error: err.message });
    next(err);
  }
});

/**
 * GET /quality/dashboard
 * Quality dashboard metrics — QUALITY_OFFICER, ADMIN, LEADERSHIP
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    if (!hasQualityAccess(req.user?.role)) {
      return error(res, 'Insufficient permissions to view quality dashboard', 403);
    }

    const dashboard = await qualityService.getQualityDashboard();

    return success(res, dashboard, 'Quality dashboard retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get quality dashboard:', { error: err.message });
    next(err);
  }
});

// ─── Infection Control ─────────────────────────────────────────────────────

/**
 * POST /quality/infection-control/cases
 * Report an infection case — clinical + IC roles
 */
router.post('/infection-control/cases', requiredString('description', 2000), validate, async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!isClinical(role) && !IC_ROLES.includes(role) && !isAdmin(role)) {
      return error(res, 'Only clinical staff or infection control officers can report cases', 403);
    }

    const caseData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      organism: req.body.organism,
      infection_site: req.body.infection_site,
      detection_date: req.body.detection_date,
      culture_date: req.body.culture_date,
      antibiotic_sensitivity: req.body.antibiotic_sensitivity,
      isolation_required: req.body.isolation_required,
      isolation_type: req.body.isolation_type,
      treatment_notes: req.body.treatment_notes,
      reported_by: req.user?.uid,
    };

    const infectionCase = await qualityService.reportInfectionCase(caseData);

    return success(res, infectionCase, 'Infection case reported successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to report infection case:', { error: err.message });
    next(err);
  }
});

/**
 * GET /quality/infection-control/surveillance
 * Infection surveillance data — IC_OFFICER, ADMIN, CMO
 */
router.get('/infection-control/surveillance', async (req, res, next) => {
  try {
    if (!hasICAccess(req.user?.role)) {
      return error(res, 'Insufficient permissions to view infection surveillance', 403);
    }

    const filters = {
      status: req.query.status,
      organism: req.query.organism,
      infection_site: req.query.infection_site,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await qualityService.getInfectionSurveillance(filters);

    return success(res, result.cases, 'Infection surveillance data retrieved', 200, {
      summary: result.summary,
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get infection surveillance:', { error: err.message });
    next(err);
  }
});

/**
 * GET /quality/infection-control/outbreaks
 * Outbreak alerts — IC_OFFICER, ADMIN
 */
router.get('/infection-control/outbreaks', async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!IC_ROLES.includes(role) && role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      return error(res, 'Insufficient permissions to view outbreak alerts', 403);
    }

    const outbreaks = await qualityService.getOutbreakAlerts();

    return success(res, outbreaks, 'Outbreak alerts retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get outbreak alerts:', { error: err.message });
    next(err);
  }
});

export default router;
