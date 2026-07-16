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
import { getCertificationCockpit } from '../../services/compliance/certificationCockpitService.js';
import { getComplianceDashboard } from '../../services/compliance/complianceDashboardService.js';
import {
  getNextNumber,
  listNumberingSeries,
  upsertNumberingSeries,
} from '../../services/compliance/numberingSeriesService.js';
import {
  archiveRetentionPolicy,
  getRetentionForTable,
  listDataRetentionPolicies,
  upsertDataRetentionPolicy,
} from '../../services/compliance/dataRetentionPolicyService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { requiredString, requiredEnum, paramId } from '../../validators/sharedValidators.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

// ---------------------------------------------------------------------------
// Tenant-scoped incident READ surface (owner decision 2026-07-13): each
// hospital's privacy incidents are visible to its OWN HR + admin roles only;
// SUPER_ADMIN gets the cross-tenant view. The mount admits
// PEOPLE_OPERATIONS_ROUTE_ROLES (SUPER_ADMIN, ADMIN, HR_STAFF); every route
// below the router.use(requireRole(...ADMIN_ROUTE_ROLES)) guard further down
// stays admin-only.
// ---------------------------------------------------------------------------

/**
 * GET /compliance/breaches
 * List the caller's tenant's breaches (SUPER_ADMIN: all tenants).
 * Query: status?, severity?, page?, limit?
 */
router.get('/breaches', async (req, res, next) => {
  try {
    const { status, severity, page, limit } = req.query;
    const result = await breachService.getBreaches({
      status,
      severity,
      page,
      limit,
      tenantId: req.tenantId,
      crossTenant: req.user?.role === 'SUPER_ADMIN',
    });

    return success(res, result.breaches, 'Breaches retrieved', 200, result.pagination);
  } catch (err) {
    logger.error('Failed to list breaches:', { error: err.message });
    next(err);
  }
});

/**
 * GET /compliance/breach/:id
 * Get breach details with timeline (own tenant; SUPER_ADMIN: any tenant).
 */
router.get('/breach/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await breachService.getBreachTimeline(id, {
      tenantId: req.tenantId,
      crossTenant: req.user?.role === 'SUPER_ADMIN',
    });

    return success(res, result, 'Breach details retrieved');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to get breach');
    }
    logger.error('Failed to get breach:', { error: err.message });
    next(err);
  }
});

/**
 * GET /compliance/dashboard
 * Compliance dashboard for the caller's tenant (SUPER_ADMIN: cross-tenant).
 */
router.get('/dashboard', async (req, res, next) => {
  try {
    const result = await getComplianceDashboard({
      tenantId: req.tenantId,
      scope: req.user?.role === 'SUPER_ADMIN' ? 'all' : 'tenant',
    });
    return success(res, result, 'Compliance dashboard retrieved');
  } catch (err) { return next(err); }
});

// Everything below is admin-only: breach lifecycle writes, GDPR registers,
// numbering series, retention policies, certification cockpit.
router.use(requireRole(...ADMIN_ROUTE_ROLES));

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
      tenantId: req.tenantId,
    });

    logger.info('Breach reported via API', { breach_id: breach.breach_id, admin_uid: reportedBy });

    return success(res, breach, 'Data breach reported successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to report breach');
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
    const breach = await breachService.containBreach(id, containment_actions, adminId, { tenantId: req.tenantId });

    return success(res, breach, 'Breach marked as contained');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to contain breach');
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
    const breach = await breachService.resolveBreach(id, resolution_notes, adminId, { tenantId: req.tenantId });

    return success(res, breach, 'Breach marked as resolved');
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to resolve breach');
    }
    logger.error('Failed to resolve breach:', { error: err.message });
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
      tenantId: req.tenantId,
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
      tenantId: req.tenantId,
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
// Numbering series (E2)
// ---------------------------------------------------------------------------

router.put('/numbering-series', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertNumberingSeries({
      tenantId: req.tenantId, id: b.id,
      code: b.code, displayName: b.display_name,
      formatTemplate: b.format_template,
      startingValue: b.starting_value, padding: b.padding,
      resetCadence: b.reset_cadence,
      status: b.status, metadata: b.metadata,
    });
    return success(res, row, 'Numbering series saved');
  } catch (err) { return next(err); }
});

router.get('/numbering-series', async (req, res, next) => {
  try {
    const result = await listNumberingSeries({
      tenantId: req.tenantId,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Numbering series retrieved');
  } catch (err) { return next(err); }
});

router.post('/numbering-series/:code/next', async (req, res, next) => {
  try {
    const result = await getNextNumber({
      tenantId: req.tenantId, code: req.params.code,
    });
    return success(res, result, 'Next number issued', 201);
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Data retention policies (E2)
// ---------------------------------------------------------------------------

router.put('/retention-policies', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertDataRetentionPolicy({
      tenantId: req.tenantId, id: b.id,
      policyCode: b.policy_code, appliesToTable: b.applies_to_table,
      displayName: b.display_name, description: b.description,
      retentionDays: b.retention_days, action: b.action, basis: b.basis,
      legalHoldAware: b.legal_hold_aware,
      dataProcessingActivityId: b.data_processing_activity_id,
      status: b.status, metadata: b.metadata,
      createdBy: req.user?.uid || req.user?.id || null,
    });
    return success(res, row, 'Retention policy saved');
  } catch (err) { return next(err); }
});

router.get('/retention-policies', async (req, res, next) => {
  try {
    const result = await listDataRetentionPolicies({
      tenantId: req.tenantId,
      status: req.query.status || null,
      action: req.query.action || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Retention policies retrieved');
  } catch (err) { return next(err); }
});

router.get('/retention-policies/lookup/:table', async (req, res, next) => {
  try {
    const row = await getRetentionForTable({
      tenantId: req.tenantId, appliesToTable: req.params.table,
    });
    if (!row) return success(res, null, 'No active retention policy for this table');
    return success(res, row, 'Retention policy retrieved');
  } catch (err) { return next(err); }
});

router.delete('/retention-policies/:id', async (req, res, next) => {
  try {
    const row = await archiveRetentionPolicy({
      tenantId: req.tenantId, id: req.params.id,
    });
    return success(res, row, 'Retention policy archived');
  } catch (err) { return next(err); }
});

// ---------------------------------------------------------------------------
// Certification cockpit (dashboard moved to the tenant-scoped read surface
// at the top of this router)
// ---------------------------------------------------------------------------

router.get('/certification-cockpit', async (req, res, next) => {
  try {
    const result = await getCertificationCockpit({ tenantId: req.tenantId });
    return success(res, result, 'Certification evidence cockpit retrieved');
  } catch (err) { return next(err); }
});

export default router;
