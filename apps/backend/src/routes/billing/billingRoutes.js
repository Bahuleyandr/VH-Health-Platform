// src/routes/billing/billingRoutes.js
// Billing & Invoicing Routes (JWT required)

import { Router } from 'express';
import { validationResult } from 'express-validator';
import logger from '../../logging/logger.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import billingService from '../../services/billing/billingService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isPatient, isStaff } from '../../utils/roleHelpers.js';
import { requiredUUID, requiredString, requiredNumber, requiredEnum, paramId } from '../../validators/sharedValidators.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

function tenantOf(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || req.tenant?.id || DEFAULT_TENANT_ID;
}

function ensurePatientSelfAccess(req, patientUid) {
  if (!isPatient(req.user?.role)) return null;
  if (String(req.user?.uid || '').toLowerCase() === String(patientUid || '').toLowerCase()) {
    return null;
  }
  return 'Patients can only access their own billing records';
}

/**
 * POST /billing/invoice
 * Create a new invoice (staff/admin only)
 */
router.post('/invoice', requireIdempotencyKey({ required: false, scope: 'invoice' }), requiredUUID('patient_uid'), requiredNumber('total_amount', { min: 0 }), validate, async (req, res, next) => {
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
      tenant_id: tenantOf(req),
    };

    const invoice = await billingService.createInvoice(invoiceData);

    // Audit the money-mutation (audit §3 / fix 9 — V1 billing had no audit on
    // money writes). No PHI/amount values, only ids + structural flags.
    await logAudit(req, 'BILLING_V1_INVOICE_CREATED', {
      invoice_id: invoice?.id ?? null,
      patient_uid: invoiceData.patient_uid,
      invoice_type: invoiceData.type ?? null,
    }, { resource: 'invoice', resourceId: invoice?.id ?? null });

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
    const patientAccessError = ensurePatientSelfAccess(req, patientUid);
    if (patientAccessError) {
      return error(res, patientAccessError, 403);
    }
    const filters = {
      status: req.query.status,
      type: req.query.type,
      page: req.query.page,
      limit: req.query.limit,
      date_from: req.query.date_from,
      date_to: req.query.date_to,
    };

    const result = await billingService.getPatientInvoices(patientUid, filters, {
      tenantId: tenantOf(req),
    });

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

    const invoice = await billingService.getInvoiceDetail(invoiceId, {
      tenantId: tenantOf(req),
      requester: {
        role: req.user?.role,
        uid: req.user?.uid,
      },
    });

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
router.post('/invoice/:id/payment', requireIdempotencyKey({ required: false, scope: 'payment' }), paramId(), requiredNumber('amount', { min: 0 }), requiredEnum('payment_method', ['CASH', 'CARD', 'UPI', 'INSURANCE', 'CHEQUE']), validate, async (req, res, next) => {
  try {
    if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can record payments', 403);
    }

    const invoiceId = parseInt(req.params.id, 10);
    if (isNaN(invoiceId)) {
      return error(res, 'Invalid invoice ID', 400);
    }

    const { amount, payment_method: method, transaction_ref } = req.body;
    const processedBy = req.user?.uid || null;

    const result = await billingService.recordPayment(
      invoiceId,
      amount,
      method,
      processedBy,
      transaction_ref,
      tenantOf(req)
    );

    // Audit the payment write (fix 9). Mode + reference-presence only — never
    // the raw amount or transaction reference.
    await logAudit(req, 'BILLING_V1_PAYMENT_RECORDED', {
      invoice_id: invoiceId,
      mode: method ?? null,
      reference_present: Boolean(transaction_ref),
    }, { resource: 'invoice_payment', resourceId: invoiceId });

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
 * Get revenue statistics (admin + billing staff)
 *
 * BILLING_STAFF runs the cashier/collection desk and needs the daily
 * revenue figures; the role-workflow sweep caught this route 403ing
 * them because the guard was admin-only. INSURANCE_COORDINATOR is
 * deliberately NOT added — that desk works claims, not collections.
 */
router.get('/revenue', async (req, res, next) => {
  try {
    if (!isAdmin(req.user?.role) && req.user?.role !== 'BILLING_STAFF') {
      return error(res, 'Only admin or billing staff can access revenue stats', 403);
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
router.post('/insurance/claim', requireIdempotencyKey({ required: false, scope: 'insurance_claim' }), requiredUUID('patient_uid'), requiredString('policy_number', 50), requiredNumber('claim_amount', { min: 0 }), validate, async (req, res, next) => {
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
      tenant_id: tenantOf(req),
    };

    const claim = await billingService.submitInsuranceClaim(claimData);

    // Audit the claim write (fix 9).
    await logAudit(req, 'BILLING_V1_INSURANCE_CLAIM_SUBMITTED', {
      claim_id: claim?.id ?? null,
      patient_uid: claimData.patient_uid,
      invoice_id: claimData.invoice_id ?? null,
    }, { resource: 'insurance_claim', resourceId: claim?.id ?? null });

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
    let patientUid = req.query.patient_uid;
    if (isPatient(req.user?.role)) {
      if (patientUid && String(patientUid).toLowerCase() !== String(req.user?.uid || '').toLowerCase()) {
        return error(res, 'Patients can only access their own insurance claims', 403);
      }
      patientUid = req.user?.uid;
    }

    const filters = {
      patient_uid: patientUid,
      status: req.query.status,
      page: req.query.page,
      limit: req.query.limit,
    };

    const result = await billingService.getInsuranceClaims(filters, {
      tenantId: tenantOf(req),
    });

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
    // Tighter role gate. Marking a TPA claim "paid" is a financial event
    // and must not be reachable by NURSING_STAFF / DOCTOR / generic staff
    // tokens (the previous isStaff() let any staff token through). See
    // finding 2026-05-08-tpa-insurance-claim-billing-claim-paid-without-payment-record.
    const role = String(req.user?.role || '').toUpperCase();
    const ALLOWED = new Set([
      'ADMIN', 'SUPER_ADMIN',
      'BILLING_STAFF', 'BILLING_INCHARGE',
      'FINANCE_INCHARGE', 'TPA_DESK',
    ]);
    if (!ALLOWED.has(role)) {
      return error(res, 'Insurance claim updates are restricted to billing/admin roles', 403);
    }

    const claimId = parseInt(req.params.id, 10);
    if (isNaN(claimId)) {
      return error(res, 'Invalid claim ID', 400);
    }

    const {
      status, approved_amount, reason, rejection_reason, documents, payment_reference,
      non_payable_amount, disallowed_reason,
    } = req.body;

    // Settling a claim must carry payment evidence. Block "paid" without a
    // payment_reference (UTR / cheque / NEFT id). See same finding above —
    // financial-control failure.
    if (status === 'paid' && !payment_reference) {
      return error(
        res,
        'A payment_reference (UTR / cheque / NEFT id) is required to mark a claim paid.',
        400,
        { code: 'PAYMENT_REFERENCE_REQUIRED' },
      );
    }

    const claim = await billingService.updateClaimStatus(
      claimId,
      status,
      approved_amount,
      // Allow either `reason` or the more explicit `rejection_reason` body
      // field — previously the field was silently dropped. See finding
      // 2026-05-08-tpa-insurance-claim-billing-claim-update-drops-fields.
      {
        rejection_reason: rejection_reason ?? reason,
        documents,
        payment_reference,
        non_payable_amount,
        disallowed_reason,
        actor_uid: req.user?.uid ?? null,
        // Tenant-scope the claim lookup (fix 7) — blocks cross-tenant claim
        // IDOR on the SERIAL claim id.
        tenantId: tenantOf(req),
      },
    );

    // Audit the claim status mutation (fix 9). Status + reference-presence only.
    await logAudit(req, 'BILLING_V1_INSURANCE_CLAIM_STATUS_UPDATED', {
      claim_id: claimId,
      status,
      payment_reference_present: Boolean(payment_reference),
    }, { resource: 'insurance_claim', resourceId: claimId });

    return success(res, claim, 'Insurance claim updated successfully');
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to update insurance claim:', { error: err.message });
    next(err);
  }
});

/**
 * POST /billing/insurance/claim/:id/enhancement
 * Open an enhancement claim against an existing preauth — used mid-stay
 * when the patient's plan exceeds the approved length-of-stay or extra
 * complications add cost. See finding
 * 2026-05-08-tpa-insurance-claim-doctor-enhancement-workflow-absent.
 */
router.post(
  '/insurance/claim/:id/enhancement',
  paramId(),
  requiredNumber('enhancement_amount', { min: 0 }),
  validate,
  async (req, res, next) => {
    try {
      // Same RBAC as the parent update — clinical role can request, billing
      // role can update status downstream.
      const role = String(req.user?.role || '').toUpperCase();
      const ALLOWED = new Set([
        'ADMIN', 'SUPER_ADMIN',
        'DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR',
        'BILLING_STAFF', 'BILLING_INCHARGE',
        'FINANCE_INCHARGE', 'TPA_DESK',
      ]);
      if (!ALLOWED.has(role)) {
        return error(res, 'Enhancement requests are restricted to clinical or billing roles', 403);
      }

      const parentClaimId = parseInt(req.params.id, 10);
      if (isNaN(parentClaimId)) {
        return error(res, 'Invalid claim ID', 400);
      }

      // `clinical_justification` is the structured template object;
      // `justification` is the legacy free-text string. The service
      // normalises whichever is supplied. Finding:
      // 2026-05-09-tpa-insurance-claim-doctor-no-clinical-justification-template
      const { enhancement_amount, justification, clinical_justification } = req.body;
      const created = await billingService.createEnhancementClaim({
        parentClaimId,
        enhancementAmount: enhancement_amount,
        justification: justification ?? null,
        clinicalJustification: clinical_justification ?? null,
        actorUid: req.user?.uid ?? null,
      });
      return success(res, created, 'Enhancement claim opened', 201);
    } catch (err) {
      if (err.isOperational) {
        return error(res, err.message, err.statusCode);
      }
      logger.error('Failed to open enhancement claim:', { error: err.message });
      next(err);
    }
  },
);

export default router;
