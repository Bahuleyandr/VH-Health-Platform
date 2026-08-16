// src/routes/referral/referralRoutes.js
// Referral Management Routes (JWT required)

import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import {
  CARE_PATHWAY_KEYS,
  PATHWAY_MODES,
  resolvePathwayMode,
} from '../../services/pathways/pathwayMode.js';
import referralService from '../../services/referral/referralService.js';
import {
  acceptClosedLoopReferral,
  closeReferralByOriginator,
  createClosedLoopReferral,
  declineClosedLoopReferral,
  getClosedLoopReferral,
  linkReferralAppointment,
  markReferralSeenClosedLoop,
  recordSignedReferralResponse,
  rerouteClosedLoopReferral,
  setReferralDestinationFacility,
} from '../../services/referral/referralClosedLoopService.js';
import {
  createReferralFacility,
  getReferralFacility,
  listReferralFacilities,
  setReferralFacilityActive,
  updateReferralFacility,
} from '../../services/referral/referralFacilityService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isDoctor, isAdmin, isClinical } from '../../utils/roleHelpers.js';
import {
  optionalString,
  requiredEnum,
  requiredUUID,
  requiredString,
  paramId,
  referralValidator,
} from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

router.use(async (req, _res, next) => {
  req.referralPathwayMode = await resolvePathwayMode(
    req.tenantId || req.user?.tenant_id,
    CARE_PATHWAY_KEYS.REFERRAL,
  );
  next();
});

function closedLoopEnabled(req) {
  return req.referralPathwayMode !== PATHWAY_MODES.OFF;
}

function closedLoopMutationEnabled(req) {
  return closedLoopEnabled(req) && req.referralIsInternal !== false;
}

async function bindReferralMutationPath(req, _res, next) {
  if (!closedLoopEnabled(req)) {
    req.referralIsInternal = false;
    return next();
  }
  try {
    req.referralIsInternal = await referralService.isInternalReferral(
      req.params.id,
      req.tenantId || req.user?.tenant_id,
    );
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireClosedLoopMode(req, res) {
  if (closedLoopMutationEnabled(req)) return true;
  error(res, 'The internal referral closed-loop workflow is not enabled for this referral', 409, {
    topLevel: { code: 'REFERRAL_PATHWAY_NOT_ENABLED' },
  });
  return false;
}

const signedResponseValidators = [
  body('assessment').if((_value, { req }) => closedLoopMutationEnabled(req))
    .isString().withMessage('assessment must be a string')
    .trim().notEmpty().withMessage('assessment is required')
    .isLength({ max: 12000 }).withMessage('assessment must be at most 12000 characters'),
  body('recommendations').if((_value, { req }) => closedLoopMutationEnabled(req))
    .isString().withMessage('recommendations must be a string')
    .trim().notEmpty().withMessage('recommendations are required')
    .isLength({ max: 12000 }).withMessage('recommendations must be at most 12000 characters'),
  optionalString('follow_up_plan', 12000),
  optionalString('patient_summary', 8000),
  optionalString('patient_instructions', 8000),
  optionalString('signature_statement', 2000),
  body('release_to_patient').optional().isBoolean().withMessage('release_to_patient must be a boolean'),
  body('continuing_ownership').optional().isBoolean().withMessage('continuing_ownership must be a boolean'),
];

const originatorClosureValidators = [
  requiredEnum('disposition', [
    'plan_updated',
    'no_further_action',
    'patient_declined',
    'lost_to_follow_up',
  ]),
  requiredString('plan_update', 12000),
  body('recovery_attempts').optional().isArray({ max: 100 })
    .withMessage('recovery_attempts must be an array'),
];

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

function actorContext(req) {
  const role = req.user?.role || null;
  const rawRole = req.user?.rawRole || role;
  const supplied = Array.isArray(req.user?.roles)
    ? req.user.roles
    : (req.user?.roles ? [req.user.roles] : []);
  return {
    tenantId: req.tenantId || req.user?.tenant_id,
    actorUid: req.user?.uid || null,
    actorName: req.user?.name || null,
    actorRole: role,
    actorRawRole: rawRole,
    actorRoles: [...new Set([role, rawRole, ...supplied].filter(Boolean))],
    overrideReason: req.body?.override_reason || null,
    idempotencyKey: req.get('Idempotency-Key') || null,
  };
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
router.post('/', rejectMobileClinicalWrite, ...referralValidator, validate, async (req, res, next) => {
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
      destination_facility_id: req.body.destination_facility_id,
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

    const useClosedLoop = closedLoopEnabled(req)
      && String(req.body.referral_type || 'internal').trim().toLowerCase() === 'internal';
    const referral = useClosedLoop
      ? await createClosedLoopReferral({
        ...referralData,
        idempotency_key: req.get('Idempotency-Key') || null,
        replacement_of_referral_id: req.body.replacement_of_referral_id,
        repeat_reason: req.body.repeat_reason,
        expires_at: req.body.expires_at,
      }, actorContext(req))
      : await referralService.createReferral(referralData);

    return success(res, referral, 'Referral created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Referral error');
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
      return relayAppError(res, err, 'Referral error');
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
      return relayAppError(res, err, 'Referral error');
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
      return relayAppError(res, err, 'Referral error');
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
      return relayAppError(res, err, 'Referral error');
    }
    logger.error('Failed to get referral audit:', { error: err.message });
    next(err);
  }
});

/**
 * Destination facility master (migration 680) — structured destinations for
 * external referrals. Registered before GET /:id so '/facilities' is not
 * captured by the param route. Reads are open to clinical staff (pickers);
 * mutations are admin-gated with an active-flag soft delete.
 */
router.get('/facilities', async (req, res, next) => {
  try {
    if (!canViewReferrals(req.user?.role)) {
      return error(res, 'Only clinical staff can view referral facilities', 403);
    }
    const facilities = await listReferralFacilities(req.tenantId || req.user?.tenant_id, {
      q: req.query.q,
      facilityType: req.query.facility_type,
      includeInactive: isReferralAdmin(req.user?.role) && req.query.include_inactive === 'true',
      limit: req.query.limit,
    });
    return success(res, { facilities, count: facilities.length }, 'Referral facilities retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral facility error');
    logger.error('Failed to list referral facilities:', { error: err.message });
    next(err);
  }
});

router.post('/facilities', async (req, res, next) => {
  try {
    if (!isReferralAdmin(req.user?.role)) {
      return error(res, 'Only admin roles can manage referral facilities', 403);
    }
    const facility = await createReferralFacility(
      req.tenantId || req.user?.tenant_id,
      req.body || {},
      { actorUid: req.user?.uid || null },
    );
    return success(res, facility, 'Referral facility created', 201);
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral facility error');
    logger.error('Failed to create referral facility:', { error: err.message });
    next(err);
  }
});

router.get('/facilities/:facilityId', paramId('facilityId'), validate, async (req, res, next) => {
  try {
    if (!canViewReferrals(req.user?.role)) {
      return error(res, 'Only clinical staff can view referral facilities', 403);
    }
    const facility = await getReferralFacility(
      req.tenantId || req.user?.tenant_id,
      req.params.facilityId,
    );
    return success(res, facility, 'Referral facility retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral facility error');
    logger.error('Failed to get referral facility:', { error: err.message });
    next(err);
  }
});

router.put('/facilities/:facilityId', paramId('facilityId'), validate, async (req, res, next) => {
  try {
    if (!isReferralAdmin(req.user?.role)) {
      return error(res, 'Only admin roles can manage referral facilities', 403);
    }
    const facility = await updateReferralFacility(
      req.tenantId || req.user?.tenant_id,
      req.params.facilityId,
      req.body || {},
      { actorUid: req.user?.uid || null },
    );
    return success(res, facility, 'Referral facility updated');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral facility error');
    logger.error('Failed to update referral facility:', { error: err.message });
    next(err);
  }
});

router.put(
  '/facilities/:facilityId/active',
  paramId('facilityId'),
  body('active').isBoolean().withMessage('active must be a boolean').toBoolean(),
  validate,
  async (req, res, next) => {
    try {
      if (!isReferralAdmin(req.user?.role)) {
        return error(res, 'Only admin roles can manage referral facilities', 403);
      }
      const facility = await setReferralFacilityActive(
        req.tenantId || req.user?.tenant_id,
        req.params.facilityId,
        req.body.active,
        { actorUid: req.user?.uid || null },
      );
      return success(res, facility, facility.active
        ? 'Referral facility reactivated'
        : 'Referral facility deactivated');
    } catch (err) {
      if (err.isOperational) return relayAppError(res, err, 'Referral facility error');
      logger.error('Failed to set referral facility active flag:', { error: err.message });
      next(err);
    }
  },
);

router.get('/:id', paramId(), validate, async (req, res, next) => {
  try {
    if (!canViewReferrals(req.user?.role)) {
      return error(res, 'Only clinical staff can view referrals', 403);
    }
    const referral = await getClosedLoopReferral(req.params.id, actorContext(req));
    return success(res, referral, 'Referral retrieved');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral error');
    logger.error('Failed to get referral:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/seen
 * Marks the first time the referred consultant opened the referral.
 */
router.put('/:id/seen', rejectMobileClinicalWrite, paramId(), validate, bindReferralMutationPath, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can mark referrals as seen', 403);
    }

    const referral = closedLoopMutationEnabled(req)
      ? await markReferralSeenClosedLoop(req.params.id, actorContext(req))
      : await referralService.markReferralSeen(
        req.params.id,
        req.user?.uid,
        { actorRole: req.user?.role },
      );

    return success(res, referral, 'Referral marked as seen');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Referral error');
    }
    logger.error('Failed to mark referral as seen:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/accept
 * Accept a referral — DOCTOR
 */
router.put('/:id/accept', rejectMobileClinicalWrite, paramId(), validate, bindReferralMutationPath, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can accept referrals', 403);
    }

    const referral = closedLoopMutationEnabled(req)
      ? await acceptClosedLoopReferral(req.params.id, actorContext(req))
      : await referralService.acceptReferral(
        req.params.id,
        req.user?.uid,
        { actorRole: req.user?.role },
      );

    return success(res, referral, 'Referral accepted successfully');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Referral error');
    }
    logger.error('Failed to accept referral:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/complete
 * Complete a referral — DOCTOR
 */
router.put(
  '/:id/complete',
  rejectMobileClinicalWrite,
  paramId(),
  validate,
  bindReferralMutationPath,
  ...signedResponseValidators,
  validate,
  async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can complete referrals', 403);
    }

    const referral = closedLoopMutationEnabled(req)
      ? await recordSignedReferralResponse(
        req.params.id,
        {
          assessment: req.body.assessment,
          recommendations: req.body.recommendations,
          follow_up_plan: req.body.follow_up_plan,
          patient_summary: req.body.patient_summary,
          patient_instructions: req.body.patient_instructions,
          release_to_patient: req.body.release_to_patient,
          continuing_ownership: req.body.continuing_ownership,
          signature_statement: req.body.signature_statement,
        },
        actorContext(req),
      )
      : await referralService.completeReferral(
        req.params.id,
        req.body.response_notes ?? req.body.recommendations ?? null,
        { actorUid: req.user?.uid, actorRole: req.user?.role },
      );

    return success(res, referral, 'Referral completed successfully');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Referral error');
    }
    logger.error('Failed to complete referral:', { error: err.message });
    next(err);
  }
  },
);

/**
 * PUT /referrals/:id/decline
 * Decline a referral — DOCTOR
 */
router.put('/:id/decline', rejectMobileClinicalWrite, paramId(), requiredString('reason', 500), validate, bindReferralMutationPath, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can decline referrals', 403);
    }

    const referral = closedLoopMutationEnabled(req)
      ? await declineClosedLoopReferral(
        req.params.id,
        { reason: req.body.response_notes || req.body.reason },
        actorContext(req),
      )
      : await referralService.declineReferral(
        req.params.id,
        req.body.response_notes || req.body.reason,
        { actorUid: req.user?.uid, actorRole: req.user?.role },
      );

    return success(res, referral, 'Referral declined');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Referral error');
    }
    logger.error('Failed to decline referral:', { error: err.message });
    next(err);
  }
});

router.post('/:id/reroute', rejectMobileClinicalWrite, paramId(), requiredUUID('referred_to_doctor'), requiredString('reason', 2000), validate, bindReferralMutationPath, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) return error(res, 'Only doctors can reroute referrals', 403);
    if (!requireClosedLoopMode(req, res)) return undefined;
    const referral = await rerouteClosedLoopReferral(req.params.id, {
      referred_to_doctor: req.body.referred_to_doctor,
      referred_to_department: req.body.referred_to_department || req.body.to_department,
      reason: req.body.reason,
    }, actorContext(req));
    return success(res, referral, 'Referral rerouted');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral error');
    logger.error('Failed to reroute referral:', { error: err.message });
    next(err);
  }
});

router.post('/:id/originator-ack', rejectMobileClinicalWrite, paramId(), ...originatorClosureValidators, validate, bindReferralMutationPath, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) return error(res, 'Only doctors can close referrals', 403);
    if (!requireClosedLoopMode(req, res)) return undefined;
    const referral = await closeReferralByOriginator(req.params.id, {
      disposition: req.body.disposition,
      plan_update: req.body.plan_update,
      recovery_attempts: req.body.recovery_attempts,
    }, actorContext(req));
    return success(res, referral, 'Referral closed');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral error');
    logger.error('Failed to close referral:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /referrals/:id/destination-facility
 * Set or change the structured destination facility of an EXTERNAL referral.
 * Originator (or admin / covering doctor with override_reason); records a
 * referral.destination_facility_changed transition + canonical evidence.
 */
router.put('/:id/destination-facility', rejectMobileClinicalWrite, paramId(), body('destination_facility_id').isInt({ min: 1 }).withMessage('destination_facility_id must be a positive integer').toInt(), validate, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) {
      return error(res, 'Only doctors can update referral destinations', 403);
    }
    const referral = await setReferralDestinationFacility(req.params.id, {
      destination_facility_id: req.body.destination_facility_id,
      reason: req.body.reason,
    }, actorContext(req));
    return success(res, referral, 'Referral destination facility updated');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral error');
    logger.error('Failed to update referral destination facility:', { error: err.message });
    next(err);
  }
});

router.put('/:id/appointment', rejectMobileClinicalWrite, paramId(), body('appointment_id').isInt({ min: 1 }).withMessage('appointment_id must be a positive integer').toInt(), validate, bindReferralMutationPath, async (req, res, next) => {
  try {
    if (!canManageReferrals(req.user?.role)) return error(res, 'Only doctors can link referral appointments', 403);
    if (!requireClosedLoopMode(req, res)) return undefined;
    const referral = await linkReferralAppointment(req.params.id, {
      appointment_id: req.body.appointment_id,
    }, actorContext(req));
    return success(res, referral, 'Referral appointment linked');
  } catch (err) {
    if (err.isOperational) return relayAppError(res, err, 'Referral error');
    logger.error('Failed to link referral appointment:', { error: err.message });
    next(err);
  }
});

/**
 * GET /referrals/patient/:uid
 * Get all referrals for a patient — clinical roles
 */
// CAN-020: the parent mount's patientAccessGuard can't see this child :uid, so
// guard at the child route where the param is bound (governed; shadow→enforce).
router.get('/patient/:uid', patientAccessGuard('REFERRAL', { careTeamModeGoverned: true }), async (req, res, next) => {
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
      return relayAppError(res, err, 'Referral error');
    }
    logger.error('Failed to get patient referrals:', { error: err.message });
    next(err);
  }
});

export default router;
