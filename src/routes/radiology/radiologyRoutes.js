// src/routes/radiology/radiologyRoutes.js
// Radiology Module Routes

import { Router } from 'express';
import radiologyService from '../../services/radiology/radiologyService.js';
import { success, error } from '../../utils/responseHelper.js';
import logger from '../../logging/logger.js';

const router = Router();

/**
 * POST /radiology/orders
 * Create a new radiology order
 */
router.post('/orders', async (req, res, next) => {
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
router.put('/:id/report', async (req, res, next) => {
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
router.put('/:id/cancel', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await radiologyService.cancelOrder(parseInt(id, 10), req.user?.uid);
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
