// src/routes/bloodbank/bloodBankRoutes.js
// Blood Bank Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import bloodBankService from '../../services/bloodbank/bloodBankService.js';
import {
  registerUnit,
  listUnits,
  crossmatchUnit,
  recordBedsideVerification,
  startTransfusion,
  completeTransfusion,
  recordReaction,
} from '../../services/bloodbank/transfusionSafetyService.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { requiredUUID, requiredNumber, requiredEnum, paramId } from '../../validators/sharedValidators.js';

// Shared failure mapper for the B5 closed-loop endpoints.
function handleLoopFailure(res, next, err, context) {
  if (err instanceof AppError || err?.isOperational) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Transfusion loop ${context} failed:`, { error: err.message });
  return next(err);
}

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

function bloodBankContext(req) {
  return {
    tenantId: req.tenantId,
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
  };
}

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

    const result = await bloodBankService.createRequest(requestData, bloodBankContext(req));
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

    const result = await bloodBankService.crossMatch(parseInt(id, 10), matchData, bloodBankContext(req));
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

    const result = await bloodBankService.issueBlood(parseInt(id, 10), issueData, bloodBankContext(req));
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
      transfusion_reaction: req.body.transfusion_reaction,
      verification_override_reason: req.body.verification_override_reason
    };

    const result = await bloodBankService.recordTransfusion(parseInt(id, 10), transfusionData, bloodBankContext(req));
    return success(res, result, 'Transfusion recorded successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to record transfusion:', { error: err.message });
    next(err);
  }
});

// ── Roadmap B5 — transfusion closed loop ───────────────────────────────────

/** POST /blood-bank/units — register a physical unit (stock intake). */
router.post('/units', requiredEnum('blood_group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']), validate, async (req, res, next) => {
  try {
    const unit = await registerUnit({
      unitNumber: req.body.unit_number,
      bloodGroup: req.body.blood_group,
      component: req.body.component || 'prbc',
      expiryDate: req.body.expiry_date,
      collectedDate: req.body.collected_date || null,
      volumeMl: req.body.volume_ml ?? null,
      donorRef: req.body.donor_ref || null,
      sourceBloodBank: req.body.source_blood_bank || null,
    }, bloodBankContext(req));
    return success(res, unit, 'Blood unit registered', 201);
  } catch (err) {
    return handleLoopFailure(res, next, err, 'register unit');
  }
});

/** GET /blood-bank/units — unit stock with real traceability. */
router.get('/units', async (req, res, next) => {
  try {
    const units = await listUnits({
      status: req.query.status || null,
      bloodGroup: req.query.blood_group || null,
      component: req.query.component || null,
    }, bloodBankContext(req));
    return success(res, { units, count: units.length }, 'Blood units');
  } catch (err) {
    return handleLoopFailure(res, next, err, 'list units');
  }
});

/** POST /blood-bank/:id/crossmatch-unit — pin + crossmatch a specific unit. */
router.post('/:id/crossmatch-unit', paramId(), requiredNumber('unit_id'), validate, async (req, res, next) => {
  try {
    const result = await crossmatchUnit(parseInt(req.params.id, 10), {
      unitId: parseInt(req.body.unit_id, 10),
      result: req.body.result,
      overrideReason: req.body.override_reason || null,
    }, bloodBankContext(req));
    return success(res, result, 'Unit crossmatch recorded');
  } catch (err) {
    return handleLoopFailure(res, next, err, 'crossmatch unit');
  }
});

/** POST /blood-bank/:id/verify-bedside — two-person scan verification. */
router.post('/:id/verify-bedside', paramId(), validate, async (req, res, next) => {
  try {
    const verification = await recordBedsideVerification(parseInt(req.params.id, 10), {
      verifierRole: req.body.verifier_role,
      scannedUnitNumber: req.body.scanned_unit_number,
      scannedPatientUid: req.body.scanned_patient_uid,
      overrideReason: req.body.override_reason || null,
    }, bloodBankContext(req));
    return success(res, verification, 'Bedside verification recorded');
  } catch (err) {
    return handleLoopFailure(res, next, err, 'verify bedside');
  }
});

/** POST /blood-bank/:id/start-transfusion — requires both verifications. */
router.post('/:id/start-transfusion', paramId(), validate, async (req, res, next) => {
  try {
    const result = await startTransfusion(parseInt(req.params.id, 10), bloodBankContext(req));
    return success(res, result, 'Transfusion started');
  } catch (err) {
    return handleLoopFailure(res, next, err, 'start transfusion');
  }
});

/** POST /blood-bank/:id/complete-transfusion */
router.post('/:id/complete-transfusion', paramId(), validate, async (req, res, next) => {
  try {
    const result = await completeTransfusion(parseInt(req.params.id, 10), {
      notes: req.body.notes || null,
    }, bloodBankContext(req));
    return success(res, result, 'Transfusion completed');
  } catch (err) {
    return handleLoopFailure(res, next, err, 'complete transfusion');
  }
});

/** POST /blood-bank/:id/reaction — structured hemovigilance report. */
router.post('/:id/reaction', paramId(), validate, async (req, res, next) => {
  try {
    const reaction = await recordReaction(parseInt(req.params.id, 10), {
      reactionType: req.body.reaction_type,
      severity: req.body.severity,
      onsetAt: req.body.onset_at || null,
      symptoms: req.body.symptoms || null,
      vitals: req.body.vitals || null,
      intervention: req.body.intervention || null,
      transfusionStopped: req.body.transfusion_stopped !== false,
      outcome: req.body.outcome || null,
    }, bloodBankContext(req));
    return success(res, reaction, 'Transfusion reaction recorded', 201);
  } catch (err) {
    return handleLoopFailure(res, next, err, 'record reaction');
  }
});

/**
 * GET /blood-bank/inventory
 * Get blood inventory summary
 */
router.get('/inventory', async (req, res, next) => {
  try {
    const inventory = await bloodBankService.getInventory(bloodBankContext(req));
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

    const result = await bloodBankService.getPendingRequests(filters, bloodBankContext(req));
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
