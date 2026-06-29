// src/routes/radiology/radiologyRoutes.js
// Radiology Module Routes

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import radiologyService from '../../services/radiology/radiologyService.js';
import { success, error } from '../../utils/responseHelper.js';
import { requiredUUID, requiredString, paramId } from '../../validators/sharedValidators.js';
import { emitRadiologyEvent } from '../../utils/websocket/realtimeEmitter.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * POST /radiology/orders
 * Create a new radiology order
 */
router.post('/orders', requiredUUID('patient_uid'), requiredString('modality', 50), requiredString('body_part', 100), validate, async (req, res, next) => {
  try {
    const orderData = {
      patient_uid: req.body.patient_uid,
      encounter_id: req.body.encounter_id,
      modality: req.body.modality,
      body_part: req.body.body_part,
      clinical_indication: req.body.clinical_indication,
      priority: req.body.priority,
      ordered_by: req.user?.uid || null,
      notes: req.body.notes
    };

    const order = await radiologyService.createOrder(orderData);
    emitRadiologyEvent('order-created', { tenantId: req.tenantId });
    return success(res, order, 'Radiology order created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
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
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await radiologyService.getWorklist(filters);
    return success(res, result.orders, 'Radiology worklist retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get radiology worklist:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /radiology/:id/report
 * Submit a radiology report
 */
router.put('/:id/report', paramId(), validate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const reportData = {
      report: req.body.report,
      findings: req.body.findings,
      impression: req.body.impression,
      images: req.body.images,
      reported_by: req.user?.uid || null
    };

    const result = await radiologyService.submitReport(parseInt(id, 10), reportData);
    emitRadiologyEvent('report-submitted', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report submitted successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
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
    });
    emitRadiologyEvent('order-acquired', { tenantId: req.tenantId });
    return success(res, result, 'Radiology order acquired');
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('Failed to mark acquired:', { error: err.message });
    next(err);
  }
});

/**
 * E-8 — POST /radiology/:id/sign-off
 * Radiologist signs off the report (locks it from further edits).
 */
router.post('/:id/sign-off', paramId(), validate, async (req, res, next) => {
  try {
    const result = await radiologyService.signOffReport(parseInt(req.params.id, 10), {
      signed_off_by: req.user?.uid,
    });
    emitRadiologyEvent('report-signed-off', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report signed off');
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('Failed to sign off report:', { error: err.message });
    next(err);
  }
});

/**
 * D50 — POST /radiology/:id/addendum
 * Append an addendum to a SIGNED radiology report. The original
 * sign-off metadata stays untouched; the addendum is appended to the
 * report blob with a labelled header (timestamp + author) and a
 * matching audit_logs entry. Required body: { addendum: string }.
 */
router.post('/:id/addendum', paramId(), validate, async (req, res, next) => {
  try {
    const result = await radiologyService.appendReportAddendum(
      parseInt(req.params.id, 10),
      {
        addendum: req.body?.addendum,
        addendum_by: req.user?.uid,
      },
    );
    emitRadiologyEvent('report-addendum', { tenantId: req.tenantId });
    return success(res, result, 'Radiology report addendum appended');
  } catch (err) {
    if (err.isOperational) return error(res, err.message, err.statusCode);
    logger.error('Failed to append report addendum:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/patient/:uid
 * Get radiology history for a patient
 */
router.get('/patient/:uid', async (req, res, next) => {
  try {
    const { uid } = req.params;
    const filters = {
      page: req.query.page,
      limit: req.query.limit
    };

    const result = await radiologyService.getPatientHistory(uid, filters);
    return success(res, result.orders, 'Patient radiology history retrieved', 200, {
      pagination: result.pagination
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get patient radiology history:', { error: err.message });
    next(err);
  }
});

/**
 * GET /radiology/:id
 * Get detail for a single radiology order
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const order = await radiologyService.getOrderDetail(parseInt(id, 10));
    return success(res, order, 'Radiology order detail retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get radiology order detail:', { error: err.message });
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
    const result = await radiologyService.cancelOrder(parseInt(id, 10), req.user?.uid);
    emitRadiologyEvent('order-cancelled', { tenantId: req.tenantId });
    return success(res, result, 'Radiology order cancelled successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to cancel radiology order:', { error: err.message });
    next(err);
  }
});

export default router;
