// src/routes/referral/referralRoutes.js
// Referral Management Routes (JWT required)

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import referralService from '../../services/referral/referralService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isDoctor, isAdmin, isClinical } from '../../utils/roleHelpers.js';
import { requiredUUID, requiredString, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

function canManageReferrals(role) {
  return role === 'SUPER_ADMIN' || isDoctor(role) || isAdmin(role);
}

function canViewReferrals(role) {
  return role === 'SUPER_ADMIN' || isAdmin(role) || isClinical(role);
}

function isReferralAdmin(role) {
  return role === 'SUPER_ADMIN' || isAdmin(role);
}

/**
 * POST /referrals
 * Create a new referral — DOCTOR only
 */
router.post('/', requiredUUID('patient_uid'), requiredString('to_department', 100), requiredString('reason', 1000), validate, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can create referrals', 403);
    }

    const referralData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      referring_doctor: req.user?.uid,
      referred_to_doctor: req.body.referred_to_doctor,
      referred_to_department: req.body.referred_to_department,
      referral_type: req.body.referral_type,
      reason: req.body.reason,
      urgency: req.body.urgency,
      clinical_summary: req.body.clinical_summary,
    };

    const referral = await referralService.createReferral(referralData);

    return success(res, referral, 'Referral created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to create referral:', { error: err.message });
    next(err);
  }
});

/**
 * GET /referrals/incoming
 * Get incoming referrals — DOCTOR (filtered by referred_to_doctor = current user)
 */
router.get('/incoming', async (req, res, next) => {
  try {
    if (!canViewReferrals(req.user?.role)) {
      return error(res, 'Only doctors can view incoming referrals', 403);
    }

    const filters = {
      status: req.query.status,
      urgency: req.query.urgency,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await referralService.getIncomingReferrals(
      isReferralAdmin(req.user?.role) ? null : req.user?.uid,
      filters
    );

    return success(res, result.referrals, 'Incoming referrals retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get incoming referrals:', { error: err.message });
    next(err);
  }
});

/**
 * GET /referrals/outgoing
 * Get outgoing referrals — DOCTOR (filtered by referring_doctor = current user)
 */
router.get('/outgoing', async (req, res, next) => {
  try {
    if (!canViewReferrals(req.user?.role)) {
      return error(res, 'Only doctors can view outgoing referrals', 403);
    }

    const filters = {
      status: req.query.status,
      urgency: req.query.urgency,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await referralService.getOutgoingReferrals(
      isReferralAdmin(req.user?.role) ? null : req.user?.uid,
      filters
    );

    return success(res, result.referrals, 'Outgoing referrals retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get outgoing referrals:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/accept
 * Accept a referral — DOCTOR
 */
router.put('/:id/accept', paramId(), validate, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can accept referrals', 403);
    }

    const referral = await referralService.acceptReferral(req.params.id, req.user?.uid);

    return success(res, referral, 'Referral accepted successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to accept referral:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/complete
 * Complete a referral — DOCTOR
 */
router.put('/:id/complete', paramId(), validate, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can complete referrals', 403);
    }

    const referral = await referralService.completeReferral(
      req.params.id,
      req.body.response_notes
    );

    return success(res, referral, 'Referral completed successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to complete referral:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/decline
 * Decline a referral — DOCTOR
 */
router.put('/:id/decline', paramId(), requiredString('reason', 500), validate, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can decline referrals', 403);
    }

    const referral = await referralService.declineReferral(
      req.params.id,
      req.body.response_notes
    );

    return success(res, referral, 'Referral declined');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to decline referral:', { error: err.message });
    next(err);
  }
});

/**
 * GET /referrals/patient/:uid
 * Get all referrals for a patient — clinical roles
 */
router.get('/patient/:uid', async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!canViewReferrals(role)) {
      return error(res, 'Only clinical staff can view patient referrals', 403);
    }

    const filters = {
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await referralService.getPatientReferrals(req.params.uid, filters);

    return success(res, result.referrals, 'Patient referrals retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get patient referrals:', { error: err.message });
    next(err);
  }
});

export default router;
