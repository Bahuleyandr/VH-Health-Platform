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

function canRequestWardReferral(role) {
  const normalized = String(role || '').trim().toUpperCase();
  return canManageReferrals(normalized) || [
    'CNO',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'ICU_NURSE',
    'ICU_INCHARGE',
  ].includes(normalized);
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
 *
 * Accepts either `referred_to_department` (canonical, matches DB column)
 * or `to_department` (legacy alias). Earlier the route-level validator
 * required `to_department` and the service required `referred_to_department`,
 * forcing every caller to send both. Finding:
 * 2026-05-09-dynamic-acute-abdomen-doctor-referral-dual-field-validation-conflict.
 */
router.post('/', requiredUUID('patient_uid'), requiredString('reason', 1000), validate, async (req, res, next) => {
  try {
    if (!canRequestWardReferral(req.user?.role)) {
      return error(res, 'Only doctors and ward nursing roles can request referrals', 403);
    }

    const department = req.body.referred_to_department || req.body.to_department;
    if (!department || typeof department !== 'string' || !department.trim()) {
      return error(res, 'referred_to_department (or to_department) is required', 400);
    }

    const actorRole = req.user?.role;
    const referralData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      referring_doctor: isReferralAdmin(actorRole)
        ? (req.body.referring_doctor || req.user?.uid)
        : req.user?.uid,
      referred_to_doctor: req.body.referred_to_doctor,
      referred_to_department: department,
      referral_type: req.body.referral_type,
      reason: req.body.reason,
      urgency: req.body.urgency,
      clinical_summary: req.body.clinical_summary,
      requester_id: req.user?.uid,
      tenant_id: req.tenantId || req.user?.tenant_id,
      actor_role: actorRole,
      source: req.body.source || 'ward',
      request_context: req.body.request_context || {
        admission_id: req.body.admission_id || null,
        requested_from: 'staff_app',
      },
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
      tenantId: req.tenantId || req.user?.tenant_id,
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
      tenantId: req.tenantId || req.user?.tenant_id,
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
 * GET /referrals/consultants
 * Search eligible specialist consultants by department / specialty / name.
 */
router.get('/consultants', async (req, res, next) => {
  try {
    if (!canViewReferrals(req.user?.role)) {
      return error(res, 'Only clinical staff can search referral consultants', 403);
    }

    const consultants = await referralService.searchConsultants({
      tenantId: req.tenantId || req.user?.tenant_id,
      q: req.query.q,
      department: req.query.department || req.query.specialty,
      limit: req.query.limit,
    });

    return success(res, consultants, 'Consultants retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to search referral consultants:', { error: err.message });
    next(err);
  }
});

/**
 * GET /referrals/audit
 * Admin/SuperAdmin audit of referral request-to-first-seen turnaround.
 */
router.get('/audit', async (req, res, next) => {
  try {
    if (!isReferralAdmin(req.user?.role)) {
      return error(res, 'Only admin roles can view referral audit', 403);
    }

    const result = await referralService.getReferralAudit({
      tenantId: req.tenantId || req.user?.tenant_id,
      status: req.query.status,
      urgency: req.query.urgency,
      department: req.query.department,
      doctor_uid: req.query.doctor_uid,
      patient_uid: req.query.patient_uid,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
      page: req.query.page,
      limit: req.query.limit,
    });

    return success(res, result.referrals, 'Referral audit retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get referral audit:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/seen
 * Marks the first time the referred consultant opened the referral.
 */
router.put('/:id/seen', paramId(), validate, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can mark referrals as seen', 403);
    }

    const referral = await referralService.markReferralSeen(req.params.id, req.user?.uid, {
      actorRole: req.user?.role,
      tenantId: req.tenantId || req.user?.tenant_id,
    });

    return success(res, referral, 'Referral marked as seen');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to mark referral as seen:', { error: err.message });
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

    const referral = await referralService.acceptReferral(req.params.id, req.user?.uid, {
      actorRole: req.user?.role,
      tenantId: req.tenantId || req.user?.tenant_id,
    });

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
      req.body.response_notes,
      {
        actorUid: req.user?.uid,
        actorRole: req.user?.role,
        tenantId: req.tenantId || req.user?.tenant_id,
      }
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
      req.body.response_notes,
      {
        actorUid: req.user?.uid,
        actorRole: req.user?.role,
        tenantId: req.tenantId || req.user?.tenant_id,
      }
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
      tenantId: req.tenantId || req.user?.tenant_id,
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
