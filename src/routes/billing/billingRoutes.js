// src/routes/billing/billingRoutes.js
// Billing & Invoicing Routes (JWT required)

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import billingService from '../../services/billing/billingService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { requiredUUID, requiredString, requiredNumber, requiredEnum, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

/**
 * POST /billing/invoice
 * Create a new invoice (staff/admin only)
 */
router.post('/invoice', requiredUUID('patient_uid'), requiredNumber('total_amount', { min: 0 }), validate, async (req, res, next) => {
  try {
    if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can create invoices', 403);
    }

    const invoiceData = {
      patient_uid: req.body.patient_uid,
      appointment_id: req.body.appointment_id,
      type: req.body.type,
      items: req.body.items,
      subtotal: req.body.subtotal,
      tax_amount: req.body.tax_amount,
      discount_amount: req.body.discount_amount,
      total_amount: req.body.total_amount,
      payment_method: req.body.payment_method,
      notes: req.body.notes,
      issued_by: req.user?.uid || null,
      due_date: req.body.due_date,
    };

    const invoice = await billingService.createInvoice(invoiceData);

    return success(res, invoice, 'Invoice created successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to create invoice:', { error: err.message });
    next(err);
  }
});

/**
 * GET /billing/invoices/patient/:patientUid
 * Get invoices for a patient
 */
router.get('/invoices/patient/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const filters = {
      status: req.query.status,
      type: req.query.type,
      page: req.query.page,
      limit: req.query.limit,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
    };

    const result = await billingService.getPatientInvoices(patientUid, filters);

    return success(res, result.invoices, 'Patient invoices retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get patient invoices:', { error: err.message });
    next(err);
  }
});

/**
 * GET /billing/invoice/:id
 * Get invoice detail with payment history
 */
router.get('/invoice/:id', async (req, res, next) => {
  try {
    const invoiceId = parseInt(req.params.id, 10);
    if (isNaN(invoiceId)) {
      return error(res, 'Invalid invoice ID', 400);
    }

    const invoice = await billingService.getInvoiceDetail(invoiceId);

    return success(res, invoice, 'Invoice detail retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get invoice detail:', { error: err.message });
    next(err);
  }
});

/**
 * POST /billing/invoice/:id/payment
 * Record a payment against an invoice
 */
router.post('/invoice/:id/payment', paramId(), requiredNumber('amount', { min: 0 }), requiredEnum('payment_method', ['CASH', 'CARD', 'UPI', 'INSURANCE', 'CHEQUE']), validate, async (req, res, next) => {
  try {
    if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can record payments', 403);
    }

    const invoiceId = parseInt(req.params.id, 10);
    if (isNaN(invoiceId)) {
      return error(res, 'Invalid invoice ID', 400);
    }

    const { amount, method, transaction_ref } = req.body;
    const processedBy = req.user?.uid || null;

    const result = await billingService.recordPayment(
      invoiceId,
      amount,
      method,
      processedBy,
      transaction_ref
    );

    return success(res, result, 'Payment recorded successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to record payment:', { error: err.message });
    next(err);
  }
});

/**
 * GET /billing/revenue
 * Get revenue statistics (admin only)
 */
router.get('/revenue', async (req, res, next) => {
  try {
    if (!isAdmin(req.user?.role)) {
      return error(res, 'Only admin can access revenue stats', 403);
    }

    const { date_from, date_to } = req.query;

    if (!date_from || !date_to) {
      return error(res, 'date_from and date_to query params are required', 400);
    }

    const stats = await billingService.getRevenueStats(date_from, date_to);

    return success(res, stats, 'Revenue statistics retrieved');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get revenue stats:', { error: err.message });
    next(err);
  }
});

/**
 * POST /billing/insurance/claim
 * Submit an insurance claim
 */
router.post('/insurance/claim', requiredUUID('patient_uid'), requiredString('policy_number', 50), requiredNumber('claim_amount', { min: 0 }), validate, async (req, res, next) => {
  try {
    if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can submit insurance claims', 403);
    }

    const claimData = {
      patient_uid: req.body.patient_uid,
      invoice_id: req.body.invoice_id,
      insurance_provider: req.body.insurance_provider,
      policy_number: req.body.policy_number,
      claim_amount: req.body.claim_amount,
      documents: req.body.documents,
    };

    const claim = await billingService.submitInsuranceClaim(claimData);

    return success(res, claim, 'Insurance claim submitted successfully', 201);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to submit insurance claim:', { error: err.message });
    next(err);
  }
});

/**
 * GET /billing/insurance/claims
 * List insurance claims with filters
 */
router.get('/insurance/claims', async (req, res, next) => {
  try {
    const filters = {
      patient_uid: req.query.patient_uid,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await billingService.getInsuranceClaims(filters);

    return success(res, result.claims, 'Insurance claims retrieved', 200, {
      pagination: result.pagination,
    });
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get insurance claims:', { error: err.message });
    next(err);
  }
});

/**
 * PUT /billing/insurance/claim/:id
 * Update insurance claim status
 */
router.put('/insurance/claim/:id', paramId(), validate, async (req, res, next) => {
  try {
    if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can update claim status', 403);
    }

    const claimId = parseInt(req.params.id, 10);
    if (isNaN(claimId)) {
      return error(res, 'Invalid claim ID', 400);
    }

    const { status, approved_amount, reason } = req.body;

    const claim = await billingService.updateClaimStatus(
      claimId,
      status,
      approved_amount,
      reason
    );

    return success(res, claim, 'Insurance claim updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to update insurance claim:', { error: err.message });
    next(err);
  }
});

export default router;
