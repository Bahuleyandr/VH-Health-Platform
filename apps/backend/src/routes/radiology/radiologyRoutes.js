// src/routes/radiology/radiologyRoutes.js
// Radiology Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import radiologyService from '../../services/radiology/radiologyService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { paramId, radiologyContrastPlanValidator, radiologyOrderValidator } from '../../validators/sharedValidators.js';
import { emitRadiologyEvent } from '../../utils/websocket/realtimeEmitter.js';
import { canSignRadiologyReport } from '../../utils/roleHelpers.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

// Report authorship, sign-off, and addenda are radiologist-only. The
// mount-level RADIOLOGY_ROUTE_ROLES gate admits ordering clinicians and
// nurses for order/worklist flows, so the report-write surface needs its
// own narrower gate.
const requireRadiologySigner = (req, res, next) => {
  const candidates = [
    req.user?.rawRole,
    req.user?.role,
    ...(Array.isArray(req.user?.roles) ? req.user.roles : []),
  ];
  const allowed = candidates.some(
    (role) => canSignRadiologyReport(String(role || '').trim().toUpperCase()),
  );
  if (allowed) return next();
  return error(res, 'Radiology report submission and sign-off require a radiologist role', 403, {
    code: 'RADIOLOGY_SIGNER_REQUIRED',
  });
};

import { patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessPolicyRegistry.js';

import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = Router();

// Per-route patient guard. The mount-level patientAccessGuard could never
// decide this route: mount middleware runs before Express binds the path
// param, so it saw req.params = {} and returned no_patient_context without
// evaluating a policy. routePatientAccessGuards.js carries the full
// rationale, the selector contract and the shadow-mode posture.
const guardRadiologyPatientView = routePatientGuard('RADIOLOGY', {
  tag: 'radiology:patient-uid-param',
  patientSelector: (req) => ({ uid: req.params?.uid }),
});


// GET /:id returns a named patient's radiology order detail under an ORDER
// id. The mount guard cannot see :id, so no patient-access policy has ever
// run on it. The handler calls radiologyService.getOrderDetail(id) against
// radiology_orders, which is exactly what the existing 'radiology_order'
// resolver keys on — same referent, so no new SQL is needed here.
const guardRadiologyOrderById = patientAccessGuardForResource('RADIOLOGY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
  resourceType: 'radiology_order',
  idParam: 'id',
  careTeamModeGoverned: true,
});

function actorRole(req) {
  return req.user?.rawRole || req.user?.role || null;
}

function handleOperationalError(res, err) {
  return relayAppError(res, err, 'Radiology error');
}

/**
 * POST /radiology/orders
 * Create a new radiology order
 */
router.post('/orders', ...radiologyOrderValidator, validate, async (req, res, next) => {
  try {
    const orderData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      admission_id: req.body.admission_id ?? req.body.admissionId,
      modality: req.body.modality,
      body_part: req.body.body_part,
      clinical_indication: req.body.clinical_indication,
      priority: req.body.priority,
      ordered_by: req.user?.uid || null,
      notes: req.body.notes,
      // Contrast intent + acknowledged allergy-override reason. Attribution
      // always comes from req.user.uid; caller-selected actor ids are ignored.
      contrast_planned: req.body.contrast_planned ?? req.body.contrastPlanned,
      contrast_agent: req.body.contrast_agent ?? req.body.contrastAgent,
      override: req.body.override,
      contrast_override_reason: req.body.contrast_override_reason,
    };

    const order = await radiologyService.createOrder(orderData, {
      tenantId: resolveTenantOrThrow(req),
      actorRole: actorRole(req),
    });
    emitRadiologyEvent('order-created', { tenantId: req.tenantId });
    return success(res, order, 'Radiology order created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return handleOperationalError(res, err);
    }
    logger.error('Failed to create radiology order:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/worklist
 * Get radiology worklist with optional filters
 */
router.get('/worklist', async (req, res, next) => {
  try {
    const filters = {
      status: req.query.status,
      modality: req.query.modality,
      priority: req.query.priority,
      tenantId: resolveTenantOrThrow(req),
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await radiologyService.getWorklist(filters);
    return success(res, result.orders, 'Radiology worklist retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return handleOperationalError(res, err);
    }
    logger.error('Failed to get radiology worklist:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/templates
 * List active structured report templates.
 */
router.get('/templates', async (req, res, next) => {
  try {
    const templates = await radiologyService.listReportTemplates({
      tenantId: resolveTenantOrThrow(req),
      modality: req.query.modality,
      body_part: req.query.body_part || req.query.bodyPart,
    });
    return success(res, templates, 'Radiology report templates retrieved');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to list radiology report templates:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/peer-reviews
 * Read-only peer-review board over signed reports.
 */
router.get('/peer-reviews', async (req, res, next) => {
  try {
    const result = await radiologyService.listPeerReviewBoard({
      tenantId: resolveTenantOrThrow(req),
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    });
    return success(res, result.reviews, 'Radiology peer-review board retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to list radiology peer-review board:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/peer-reviews/sample
 * Deterministic sample of signed reports needing peer review.
 */
router.get('/peer-reviews/sample', async (req, res, next) => {
  try {
    const result = await radiologyService.pickPeerReviewSample({
      tenantId: resolveTenantOrThrow(req),
      seed: req.query.seed,
      limit: req.query.limit,
    });
    return success(res, result, 'Radiology peer-review sample generated');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to pick radiology peer-review sample:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/tat-metrics
 * Turnaround-time metrics and threshold breach feed.
 */
router.get('/tat-metrics', async (req, res, next) => {
  try {
    const result = await radiologyService.getTatMetrics({
      tenantId: resolveTenantOrThrow(req),
      priority: req.query.priority,
      modality: req.query.modality,
      breached: req.query.breached,
      page: req.query.page,
      limit: req.query.limit,
    });
    return success(res, result.metrics, 'Radiology TAT metrics retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to load radiology TAT metrics:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /radiology/:id/report
 * Submit a radiology report
 */
router.put('/:id/report', requireRadiologySigner, paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const reportData = {
      report: req.body.report,
      findings: req.body.findings,
      impression: req.body.impression,
      images: req.body.images,
      template_id: req.body.template_id ?? req.body.templateId,
      structured_report: req.body.structured_report ?? req.body.structuredReport,
      sections: req.body.sections,
      coded_fields: req.body.coded_fields ?? req.body.codedFields,
      reported_by: req.user?.uid || null
    };

    const result = await radiologyService.submitReport(parseInt(id, 10), reportData, {
      tenantId: resolveTenantOrThrow(req),
      actorRole: actorRole(req),
    });
    emitRadiologyEvent('report-submitted', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report submitted successfully');
  } catch (err) {
    if (err.isOperational) {
      return handleOperationalError(res, err);
    }
    logger.error('Failed to submit radiology report:', { error: err.message });
    next(err);
  }
});

/**
 * E-8 — POST /radiology/:id/acquire
 * Mark order acquired (tech captures images).
 * Body: {
 *   tech_license_number? | license_number? | registration_number?,
 *   pacs_study_instance_uid? | study_instance_uid?,
 *   pacs_url? | storage_key? | image_url? | attachment_id?
 * }.
 *
 * Inner-RBAC: the mount in app.js allows ADMIN/SUPER_ADMIN/DOCTOR/
 * NURSING_STAFF/RADIOLOGY_STAFF for the whole module (so doctors can
 * read the worklist + reports). But ACQUISITION is medico-legal — the
 * record of who physically captured the image and under whose license
 * must be a radiology technologist. Otherwise an ADMIN token could
 * mark a STAT CT acquired under a non-tech identity with no license
 * number recorded (the literal finding). Restrict the inner action.
 * Finding: 2026-05-22-dynamic-acute-abdomen-radiology-tech-b90c70d2.
 */
const ACQUIRE_ALLOWED_ROLES = new Set(['RADIOLOGY_STAFF']);
router.post('/:id/acquire', paramId(), validate, async (req, res, next) => {
  try {
    if (!ACQUIRE_ALLOWED_ROLES.has(req.user?.role)) {
      return error(
        res,
        'Only a radiology technologist may mark a study acquired (medico-legal traceability)',
        403,
      );
    }
    const result = await radiologyService.markAcquired(parseInt(req.params.id, 10), {
      tech_uid: req.user?.uid,
      tech_name: req.user?.name,
      tech_license_number:
        req.body.tech_license_number
        || req.body.license_number
        || req.body.registration_number,
      acquisition_evidence: {
        ...(req.body.acquisition_evidence && typeof req.body.acquisition_evidence === 'object'
          ? req.body.acquisition_evidence
          : {}),
        pacs_study_instance_uid: req.body.pacs_study_instance_uid || req.body.study_instance_uid,
        pacs_url: req.body.pacs_url,
        storage_key: req.body.storage_key || req.body.image_storage_key || req.body.file_key,
        image_url: req.body.image_url || req.body.file_url || req.body.attachment_url,
        attachment_id: req.body.attachment_id,
        source_system: req.body.source_system,
        series_count: req.body.series_count,
        instance_count: req.body.instance_count,
        metadata: req.body.metadata,
      },
      tenantId: resolveTenantOrThrow(req),
      actorRole: actorRole(req),
    });
    emitRadiologyEvent('order-acquired', { tenantId: req.tenantId });
    return success(res, result, 'Radiology order acquired');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to mark acquired:', { error: err.message });
    next(err);
  }
});

/**
 * E-8 — POST /radiology/:id/sign-off
 * Radiologist signs off the report (locks it from further edits).
 */
router.post('/:id/sign-off', requireRadiologySigner, paramId(), validate, async (req, res, next) => {
  try {
    const result = await radiologyService.signOffReport(parseInt(req.params.id, 10), {
      signed_off_by: req.user?.uid,
      result_classification: req.body?.result_classification ?? req.body?.resultClassification,
      classification_basis: req.body?.classification_basis ?? req.body?.classificationBasis,
      idempotencyKey: req.get('Idempotency-Key'),
      tenantId: resolveTenantOrThrow(req),
      actorRole: actorRole(req),
    });
    if (result.diagnostic_generation?.replayed !== true) {
      emitRadiologyEvent('report-signed-off', { tenantId: req.tenantId });
    }
    return success(res, result, 'Radiology report signed off');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to sign off report:', { error: err.message });
    next(err);
  }
});

/**
 * D50 — POST /radiology/:id/addendum
 * Append a signed immutable generation to a SIGNED radiology report.
 * The original report and sign-off metadata stay untouched. Required
 * body includes addendum text, explicit result classification, structured
 * classification basis, and clinical significance.
 */
router.post('/:id/addendum', requireRadiologySigner, paramId(), validate, async (req, res, next) => {
  try {
    const result = await radiologyService.appendReportAddendum(
      parseInt(req.params.id, 10),
      {
        addendum: req.body?.addendum,
        addendum_by: req.user?.uid,
        result_classification: req.body?.result_classification ?? req.body?.resultClassification,
        classification_basis: req.body?.classification_basis ?? req.body?.classificationBasis,
        clinical_significance: req.body?.clinical_significance ?? req.body?.clinicalSignificance,
        idempotencyKey: req.get('Idempotency-Key'),
        tenantId: resolveTenantOrThrow(req),
        actorRole: actorRole(req),
      },
    );
    if (result.diagnostic_generation?.replayed !== true) {
      emitRadiologyEvent('report-addendum', { tenantId: req.tenantId });
    }
    return success(res, result, 'Radiology report addendum appended');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to append report addendum:', { error: err.message });
    next(err);
  }
});

/**
 * POST /radiology/:id/peer-reviews
 * Record a post-sign-off peer review. This does not mutate report content.
 */
router.post('/:id/peer-reviews', requireRadiologySigner, paramId(), validate, async (req, res, next) => {
  try {
    const review = await radiologyService.recordPeerReview(
      parseInt(req.params.id, 10),
      {
        reviewer_uid: req.user?.uid,
        discrepancy_score: req.body.discrepancy_score ?? req.body.discrepancyScore,
        outcome: req.body.outcome,
        comments: req.body.comments,
        addendum_recommendation: req.body.addendum_recommendation ?? req.body.addendumRecommendation,
        metadata: req.body.metadata,
      },
      {
        tenantId: resolveTenantOrThrow(req),
        actorUid: req.user?.uid,
        actorRole: actorRole(req),
      },
    );
    emitRadiologyEvent('peer-review-recorded', { tenantId: req.tenantId });
    return success(res, review, 'Radiology peer review recorded', 201);
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to record radiology peer review:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/patient/:uid
 * Get radiology history for a patient
 */
router.get('/patient/:uid', guardRadiologyPatientView, async (req, res, next) => {
  try {
    const { uid } = req.params;
    const filters = {
      page: req.query.page,
      limit: req.query.limit,
      tenantId: resolveTenantOrThrow(req),
    };

    const result = await radiologyService.getPatientHistory(uid, filters);
    return success(res, result.orders, 'Patient radiology history retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return handleOperationalError(res, err);
    }
    logger.error('Failed to get patient radiology history:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/:id
 * Get detail for a single radiology order
 */
router.get('/:id', guardRadiologyOrderById, async (req, res, next) => {
  try {
    const { id } = req.params;
    const order = await radiologyService.getOrderDetail(parseInt(id, 10), {
      tenantId: resolveTenantOrThrow(req),
    });
    return success(res, order, 'Radiology order detail retrieved');
  } catch (err) {
    if (err.isOperational) {
      return handleOperationalError(res, err);
    }
    logger.error('Failed to get radiology order detail:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /radiology/:id/contrast
 * Amend the contrast plan on an order still awaiting acquisition
 * (protocolling). Runs the same contrast/allergy screen as order creation:
 * a contrast-relevant allergy hit returns 409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED
 * with the matched allergies unless an acknowledged override
 * ({ override: { reason, approvedBy? } }) is supplied.
 */
router.put('/:id/contrast', paramId(), ...radiologyContrastPlanValidator, validate, async (req, res, next) => {
  try {
    const result = await radiologyService.setContrastPlan(parseInt(req.params.id, 10), {
      contrast_planned: req.body.contrast_planned ?? req.body.contrastPlanned,
      contrast_agent: req.body.contrast_agent ?? req.body.contrastAgent,
      // Required when the amendment clears an existing contrast plan.
      reason: req.body.reason ?? req.body.clear_reason,
      override: req.body.override,
      contrast_override_reason: req.body.contrast_override_reason,
      contrast_override_by: req.body.contrast_override_by,
    }, {
      tenantId: resolveTenantOrThrow(req),
      actorUid: req.user?.uid || null,
      actorRole: actorRole(req),
    });
    emitRadiologyEvent('contrast-plan-updated', { tenantId: req.tenantId });
    return success(res, result, 'Radiology contrast plan updated');
  } catch (err) {
    if (err.isOperational) return handleOperationalError(res, err);
    logger.error('Failed to update radiology contrast plan:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /radiology/:id/cancel
 * Cancel a radiology order
 */
router.put('/:id/cancel', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await radiologyService.cancelOrder(parseInt(id, 10), req.user?.uid, {
      tenantId: resolveTenantOrThrow(req),
      actorRole: actorRole(req),
    });
    emitRadiologyEvent('order-cancelled', { tenantId: req.tenantId });
    return success(res, result, 'Radiology order cancelled successfully');
  } catch (err) {
    if (err.isOperational) {
      return handleOperationalError(res, err);
    }
    logger.error('Failed to cancel radiology order:', { error: err.message });
    next(err);
  }
});

export default router;
