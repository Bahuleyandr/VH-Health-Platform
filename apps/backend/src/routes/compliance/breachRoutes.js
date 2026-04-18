// src/routes/compliance/breachRoutes.js
// HIPAA Data Breach Management Routes (admin only)

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import breachService from '../../services/compliance/breachService.js';
import { success, error } from '../../utils/responseHelper.js';
import { requiredString, requiredEnum, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * POST /compliance/breach/report
 * Report a new data breach.
 * Body: { severity, description, affected_records?, affected_patient_uids?, reported_by? }
 */
router.post('/breach/report', requiredString('description', 2000), requiredEnum('severity', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']), validate, async (req, res, next) => {
  try {
    const { severity, description, affected_records, affected_patient_uids } = req.body;

    if (!severity || !description) {
      return error(res, 'severity and description are required', 400);
    }

    const reportedBy = req.user?.uid || req.user?.id || null;

    const breach = await breachService.reportBreach({
      severity,
      description,
      affectedRecords: affected_records,
      affectedPatientUids: affected_patient_uids,
      reportedBy,
    });

    logger.info('Breach reported via API', { breach_id: breach.breach_id, admin_uid: reportedBy });

    return success(res, breach, 'Data breach reported successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to report breach:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /compliance/breach/:id/contain
 * Mark a breach as contained.
 * Body: { containment_actions }
 */
router.put('/breach/:id/contain', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { containment_actions } = req.body;

    if (!containment_actions) {
      return error(res, 'containment_actions is required', 400);
    }

    const adminId = req.user?.uid || req.user?.id || null;
    const breach = await breachService.containBreach(id, containment_actions, adminId);

    return success(res, breach, 'Breach marked as contained');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to contain breach:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /compliance/breach/:id/resolve
 * Mark a breach as resolved.
 * Body: { resolution_notes }
 */
router.put('/breach/:id/resolve', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { resolution_notes } = req.body;

    if (!resolution_notes) {
      return error(res, 'resolution_notes is required', 400);
    }

    const adminId = req.user?.uid || req.user?.id || null;
    const breach = await breachService.resolveBreach(id, resolution_notes, adminId);

    return success(res, breach, 'Breach marked as resolved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to resolve breach:', { error: err.message });
    next(err);
  }
});

/**
 * GET /compliance/breaches
 * List all breaches with optional filters.
 * Query: status?, severity?, page?, limit?
 */
router.get('/breaches', async (req, res, next) => {
  try {
    const { status, severity, page, limit } = req.query;
    const result = await breachService.getBreaches({ status, severity, page, limit });

    return success(res, result.breaches, 'Breaches retrieved', 200, result.pagination);
  } catch (err) {
    logger.error('Failed to list breaches:', { error: err.message });
    next(err);
  }
});

/**
 * GET /compliance/breach/:id
 * Get breach details with timeline.
 */
router.get('/breach/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await breachService.getBreachTimeline(id);

    return success(res, result, 'Breach details retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get breach:', { error: err.message });
    next(err);
  }
});

export default router;
