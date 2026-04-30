// src/routes/compliance/breachRoutes.js
// HIPAA Data Breach Management Routes + GDPR DataProcessingActivity
// register + compliance dashboard (admin only).

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import * as breachService from '../../services/compliance/breachService.js';
import {
  archiveDataProcessingActivity,
  getDataProcessingActivity,
  listDataProcessingActivities,
  upsertDataProcessingActivity,
} from '../../services/compliance/dataProcessingActivityService.js';
import { getComplianceDashboard } from '../../services/compliance/complianceDashboardService.js';
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

// ---------------------------------------------------------------------------
// GDPR Art. 33 / Art. 34 — regulator + data subject notification
// ---------------------------------------------------------------------------

/**
 * POST /compliance/breach/:id/notify-regulator
 * Body: { regulator_reference, jurisdiction, risk_assessment?, dpa_id?, cross_border_impact? }
 */
router.post('/breach/:id/notify-regulator', async (req, res, next) => {
  try {
    const breachId = req.params.id;
    const b = req.body || {};
    const result = await breachService.notifyRegulator({
      breachId,
      regulatorReference: b.regulator_reference,
      jurisdiction: b.jurisdiction,
      riskAssessment: b.risk_assessment,
      dpaId: b.dpa_id,
      crossBorderImpact: b.cross_border_impact,
      notifiedBy: req.user?.uid || req.user?.id || null,
    });
    return success(res, result, 'Regulator notification recorded');
  } catch (err) { return next(err); }
});

/**
 * POST /compliance/breach/:id/notify-data-subjects
 * Body: { notification_count }
 */
router.post('/breach/:id/notify-data-subjects', async (req, res, next) => {
  try {
    const breachId = req.params.id;
    const result = await breachService.notifyDataSubjects({
      breachId,
      notificationCount: req.body?.notification_count,
      notifiedBy: req.user?.uid || req.user?.id || null,
    });
    return success(res, result, 'Data subject notification recorded');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// GDPR Art. 30 — data processing activities register
// ---------------------------------------------------------------------------

router.put('/processing-activities', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertDataProcessingActivity({
      tenantId: req.tenantId, id: b.id,
      activityCode: b.activity_code, displayName: b.display_name,
      description: b.description, purposes: b.purposes,
      dataSubjectCategories: b.data_subject_categories,
      personalDataCategories: b.personal_data_categories,
      specialCategoryData: b.special_category_data,
      recipientCategories: b.recipient_categories,
      crossBorderTransfers: b.cross_border_transfers,
      crossBorderDestinations: b.cross_border_destinations,
      crossBorderSafeguards: b.cross_border_safeguards,
      retentionPeriodDays: b.retention_period_days,
      retentionBasis: b.retention_basis,
      securityMeasures: b.security_measures,
      lawfulBasis: b.lawful_basis,
      legitimateInterestsAssessment: b.legitimate_interests_assessment,
      dpiaRequired: b.dpia_required,
      dpiaCompletedAt: b.dpia_completed_at,
      dpiaReference: b.dpia_reference,
      status: b.status, metadata: b.metadata,
      createdBy: req.user?.uid || req.user?.id || null,
    });
    return success(res, row, 'Data processing activity saved');
  } catch (err) { return next(err); }
});

router.get('/processing-activities', async (req, res, next) => {
  try {
    const result = await listDataProcessingActivities({
      tenantId: req.tenantId,
      status: req.query.status || null,
      lawfulBasis: req.query.lawful_basis || null,
      dpiaRequired: req.query.dpia_required != null ? req.query.dpia_required === 'true' : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Data processing activities retrieved');
  } catch (err) { return next(err); }
});

router.get('/processing-activities/:id', async (req, res, next) => {
  try {
    const row = await getDataProcessingActivity({
      tenantId: req.tenantId, id: req.params.id,
    });
    return success(res, row, 'Data processing activity retrieved');
  } catch (err) { return next(err); }
});

router.delete('/processing-activities/:id', async (req, res, next) => {
  try {
    const row = await archiveDataProcessingActivity({
      tenantId: req.tenantId, id: req.params.id,
    });
    return success(res, row, 'Data processing activity archived');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Compliance dashboard
// ---------------------------------------------------------------------------

router.get('/dashboard', async (req, res, next) => {
  try {
    const result = await getComplianceDashboard({ tenantId: req.tenantId });
    return success(res, result, 'Compliance dashboard retrieved');
  } catch (err) { return next(err); }
});

export default router;
