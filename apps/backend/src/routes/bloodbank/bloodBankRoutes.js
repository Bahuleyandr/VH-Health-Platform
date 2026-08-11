// src/routes/bloodbank/bloodBankRoutes.js
// Blood Bank Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import bloodBankService from '../../services/bloodbank/bloodBankService.js';
import donorIntakeService from '../../services/bloodbank/donorIntakeService.js';
import donorProcessingService from '../../services/bloodbank/donorProcessingService.js';
import {
  registerUnit,
  listUnits,
  crossmatchUnit,
  recordBedsideVerification,
  startTransfusion,
  completeTransfusion,
  recordReaction,
} from '../../services/bloodbank/transfusionSafetyService.js';
import { success, relayAppError } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { requiredNumber, requiredEnum, paramId, bloodRequestValidator } from '../../validators/sharedValidators.js';
import { emitBloodBankEvent } from '../../utils/websocket/realtimeEmitter.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';

// Shared failure mapper for the B5 closed-loop endpoints.
function handleLoopFailure(res, next, err, context) {
  if (err instanceof AppError || err?.isOperational) {
    return relayAppError(res, err, `Transfusion loop ${context} failed`);
  }
  logger.error(`Transfusion loop ${context} failed:`, { error: err.message });
  return next(err);
}

function handleDonorFailure(res, next, err, context) {
  if (err instanceof AppError || err?.isOperational) {
    return relayAppError(res, err, `Donor intake ${context} failed`);
  }
  logger.error(`Donor intake ${context} failed:`, { error: err.message });
  return next(err);
}

function handleProcessingFailure(res, next, err, context) {
  if (err instanceof AppError || err?.isOperational) {
    return relayAppError(res, err, `Donor processing ${context} failed`);
  }
  logger.error(`Donor processing ${context} failed:`, { error: err.message });
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

// -- NL-6 N6-2: donor intake cycle -----------------------------------------

router.get('/donors', async (req, res, next) => {
  try {
    const result = await donorIntakeService.listDonors(req.query, bloodBankContext(req));
    return success(res, result.donors, 'Blood donors retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    return handleDonorFailure(res, next, err, 'list donors');
  }
});

router.post('/donors', async (req, res, next) => {
  try {
    const result = await donorIntakeService.registerDonor(req.body, bloodBankContext(req));
    emitBloodBankEvent('donor-registered', { tenantId: req.tenantId });
    return success(res, result, 'Blood donor registered', 201);
  } catch (err) {
    return handleDonorFailure(res, next, err, 'register donor');
  }
});

router.post('/donors/:id/screenings', paramId(), validate, async (req, res, next) => {
  try {
    const result = await donorIntakeService.screenDonor(parseInt(req.params.id, 10), req.body, bloodBankContext(req));
    emitBloodBankEvent('donor-screened', { tenantId: req.tenantId });
    return success(res, result, 'Blood donor screening recorded', 201);
  } catch (err) {
    return handleDonorFailure(res, next, err, 'screen donor');
  }
});

router.get('/deferrals', async (req, res, next) => {
  try {
    const result = await donorIntakeService.listDeferrals(req.query, bloodBankContext(req));
    return success(res, result, 'Blood donor deferrals retrieved');
  } catch (err) {
    return handleDonorFailure(res, next, err, 'list deferrals');
  }
});

router.post('/donors/:id/deferrals/:deferralId/reactivate', paramId(), paramId('deferralId'), validate, async (req, res, next) => {
  try {
    const result = await donorIntakeService.reactivateDeferral(
      parseInt(req.params.id, 10),
      parseInt(req.params.deferralId, 10),
      req.body,
      bloodBankContext(req),
    );
    emitBloodBankEvent('donor-reactivated', { tenantId: req.tenantId });
    return success(res, result, 'Blood donor deferral reactivated');
  } catch (err) {
    return handleDonorFailure(res, next, err, 'reactivate donor deferral');
  }
});

router.post('/donors/:id/donations', paramId(), validate, async (req, res, next) => {
  try {
    const result = await donorIntakeService.recordDonationCollection(parseInt(req.params.id, 10), req.body, bloodBankContext(req));
    emitBloodBankEvent('donation-collected', { tenantId: req.tenantId });
    return success(res, result, 'Blood donation collection recorded', 201);
  } catch (err) {
    return handleDonorFailure(res, next, err, 'record donation');
  }
});

router.post('/donors/:id/consents', paramId(), validate, async (req, res, next) => {
  try {
    const result = await donorIntakeService.captureDonorConsent(parseInt(req.params.id, 10), req.body, bloodBankContext(req));
    emitBloodBankEvent('donor-consent-captured', { tenantId: req.tenantId });
    return success(res, result, 'Blood donor consent captured', 201);
  } catch (err) {
    return handleDonorFailure(res, next, err, 'capture donor consent');
  }
});

// -- NL-6 N6-3: donor processing, traceability, and registers ---------------

router.get('/donor-camps', async (req, res, next) => {
  try {
    const result = await donorProcessingService.listDonorCamps(req.query, bloodBankContext(req));
    return success(res, result, 'Blood donor camps retrieved');
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'list donor camps');
  }
});

router.post('/donor-camps', async (req, res, next) => {
  try {
    const result = await donorProcessingService.createDonorCamp(req.body, bloodBankContext(req));
    emitBloodBankEvent('donor-camp-recorded', { tenantId: req.tenantId });
    return success(res, result, 'Blood donor camp recorded', 201);
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'create donor camp');
  }
});

router.post('/donations/:id/tti-tests', paramId(), validate, async (req, res, next) => {
  try {
    const result = await donorProcessingService.recordTtiTest(parseInt(req.params.id, 10), req.body, bloodBankContext(req));
    emitBloodBankEvent('tti-test-recorded', { tenantId: req.tenantId });
    return success(res, result, 'Donation TTI test recorded', 201);
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'record TTI test');
  }
});

router.post('/donations/:id/components', paramId(), validate, async (req, res, next) => {
  try {
    const result = await donorProcessingService.prepareComponents(parseInt(req.params.id, 10), req.body, bloodBankContext(req));
    emitBloodBankEvent('components-prepared', { tenantId: req.tenantId });
    return success(res, result, 'Blood components prepared', 201);
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'prepare components');
  }
});

router.get('/units/traceability', async (req, res, next) => {
  try {
    const result = await donorProcessingService.getTraceability({
      unitId: req.query.unit_id || null,
      unitNumber: req.query.unit_number || null,
    }, bloodBankContext(req));
    return success(res, result, 'Blood unit traceability retrieved');
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'trace unit');
  }
});

router.post('/units/:unitId/discard-confirmation', paramId('unitId'), validate, async (req, res, next) => {
  try {
    const result = await donorProcessingService.confirmDiscard(parseInt(req.params.unitId, 10), req.body, bloodBankContext(req));
    emitBloodBankEvent('unit-discard-confirmed', { tenantId: req.tenantId });
    return success(res, result, 'Blood unit discard confirmed');
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'confirm discard');
  }
});

router.get('/registers/:registerType', async (req, res, next) => {
  try {
    const result = await donorProcessingService.exportRegister(req.params.registerType, req.query, bloodBankContext(req));
    if (result.buffer) {
      res.setHeader('Content-Type', result.content_type);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      return res.status(200).send(result.buffer);
    }
    return success(res, result, 'Blood-bank register exported');
  } catch (err) {
    return handleProcessingFailure(res, next, err, 'export register');
  }
});

/**
 * POST /blood-bank/request
 * Create a new blood request
 */
router.post('/request', ...bloodRequestValidator, validate, requireIdempotencyKey({ required: true, scope: 'blood_bank_request' }), async (req, res, next) => {
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
    emitBloodBankEvent('request-created', { tenantId: req.tenantId });
    return success(res, result, 'Blood request created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to create blood request');
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
    emitBloodBankEvent('request-cross-matched', { tenantId: req.tenantId });
    return success(res, result, 'Cross-match result recorded successfully');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to record cross-match');
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
    emitBloodBankEvent('request-issued', { tenantId: req.tenantId });
    return success(res, result, 'Blood issued successfully');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to issue blood');
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
    emitBloodBankEvent('request-transfused', { tenantId: req.tenantId });
    return success(res, result, 'Transfusion recorded successfully');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to record transfusion');
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
      donorId: req.body.donor_id ?? null,
      donationEventId: req.body.donation_event_id ?? null,
      sourceBloodBank: req.body.source_blood_bank || null,
    }, bloodBankContext(req));
    emitBloodBankEvent('unit-registered', { tenantId: req.tenantId });
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
    emitBloodBankEvent('unit-cross-matched', { tenantId: req.tenantId });
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
    emitBloodBankEvent('verification-recorded', { tenantId: req.tenantId });
    return success(res, verification, 'Bedside verification recorded');
  } catch (err) {
    return handleLoopFailure(res, next, err, 'verify bedside');
  }
});

/** POST /blood-bank/:id/start-transfusion — requires both verifications. */
router.post('/:id/start-transfusion', paramId(), validate, async (req, res, next) => {
  try {
    const result = await startTransfusion(parseInt(req.params.id, 10), bloodBankContext(req));
    emitBloodBankEvent('transfusion-started', { tenantId: req.tenantId });
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
    emitBloodBankEvent('transfusion-completed', { tenantId: req.tenantId });
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
    emitBloodBankEvent('reaction-recorded', { tenantId: req.tenantId });
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
      return relayAppError(res, err, 'Failed to get blood inventory');
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
      return relayAppError(res, err, 'Failed to get pending blood requests');
    }
    logger.error('Failed to get pending blood requests:', { error: err.message });
    next(err);
  }
});

export default router;
