// src/routes/bloodbank/bloodBankRoutes.js
// Blood Bank Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import { requiredUUID, requiredString, requiredNumber, requiredEnum, optionalString, optionalNumber, optionalEnum, paramId } from '../../validators/sharedValidators.js';
import bloodBankService from '../../services/bloodbank/bloodBankService.js';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * POST /blood-bank/request
 * Create a new blood request
 */
router.post('/request', requiredUUID('patient_uid'), requiredEnum('blood_group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']), requiredNumber('units', { min: 1, max: 10 }), validate, async (req, res, next) => {
  try {
    const requestData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      blood_group: req.body.blood_group,
      component: req.body.component,
      units: req.body.units,
      urgency: req.body.urgency,
      clinical_indication: req.body.clinical_indication,
      ordered_by: req.user?.uid || null
    };

    const result = await bloodBankService.createRequest(requestData);
    return success(res, result, 'Blood request created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to create blood request:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /blood-bank/:id/cross-match
 * Record cross-match result
 */
router.put('/:id/cross-match', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const matchData = {
      cross_match_status: req.body.cross_match_status,
      cross_matched_by: req.user?.uid || null
    };

    const result = await bloodBankService.crossMatch(parseInt(id, 10), matchData);
    return success(res, result, 'Cross-match result recorded successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to record cross-match:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /blood-bank/:id/issue
 * Issue blood to patient
 */
router.put('/:id/issue', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const issueData = {
      issued_by: req.user?.uid || null
    };

    const result = await bloodBankService.issueBlood(parseInt(id, 10), issueData);
    return success(res, result, 'Blood issued successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to issue blood:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /blood-bank/:id/transfused
 * Record transfusion completion
 */
router.put('/:id/transfused', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const transfusionData = {
      transfusion_reaction: req.body.transfusion_reaction
    };

    const result = await bloodBankService.recordTransfusion(parseInt(id, 10), transfusionData);
    return success(res, result, 'Transfusion recorded successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to record transfusion:', { error: err.message });
    next(err);
  }
});

/**
 * GET /blood-bank/inventory
 * Get blood inventory summary
 */
router.get('/inventory', async (req, res, next) => {
  try {
    const inventory = await bloodBankService.getInventory();
    return success(res, inventory, 'Blood inventory retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get blood inventory:', { error: err.message });
    next(err);
  }
});

/**
 * GET /blood-bank/pending
 * Get pending blood requests
 */
router.get('/pending', async (req, res, next) => {
  try {
    const filters = {
      blood_group: req.query.blood_group,
      urgency: req.query.urgency,
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await bloodBankService.getPendingRequests(filters);
    return success(res, result.requests, 'Pending blood requests retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get pending blood requests:', { error: err.message });
    next(err);
  }
});

export default router;
