// src/routes/billing/billingV2Routes.js
//
// Billing v2 — line-item invoices + GST + advance + refund + receipts.
// Mounted at /api/v1/billing/v2/*. The original /billing/* surface
// stays for backwards compat; new screens use this.
//
// Auth: JWT required. Roles allowed: ADMIN, SUPER_ADMIN, HR_STAFF (for
// reads), and "billing" generally requires admin/staff write power.
// Refund approval requires ADMIN.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as billing from '../../services/billing/billingV2Service.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

// Wrap each handler with try/catch + AppError → response so route
// definitions stay terse.
function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('billingV2 route error:', err);
      return error(res, err.message || 'Billing error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

// ── Service master ────────────────────────────────────────────────────
router.get('/services', wrap(async (req) => billing.listServiceMaster({
  category: req.query.category,
  search: req.query.q,
  includeInactive: req.query.includeInactive === 'true',
})));

router.post('/services', requireAdmin, wrap(async (req) => billing.createServiceMaster(req.body)));
router.patch('/services/:id', requireAdmin, wrap(async (req) =>
  billing.updateServiceMaster(req.params.id, req.body),
));

// ── Invoices ──────────────────────────────────────────────────────────
router.post('/invoices', requireStaffOrAdmin, wrap(async (req) =>
  billing.createDraftInvoice({ ...req.body, created_by: req.user?.uid }),
));

router.get('/invoices', requireStaffOrAdmin, wrap(async (req) => billing.listInvoices({
  patient_uid: req.query.patient_uid,
  status: req.query.status,
  invoice_type: req.query.invoice_type,
  date_from: req.query.date_from,
  date_to: req.query.date_to,
  page: req.query.page || 1,
  limit: req.query.limit || 20,
})));

router.get('/invoices/:id', requireStaffOrAdmin, wrap(async (req) =>
  billing.getInvoice(req.params.id),
));

router.post('/invoices/:id/items', requireStaffOrAdmin, wrap(async (req) =>
  billing.addInvoiceItem(req.params.id, req.body),
));

router.delete('/invoices/:id/items/:itemId', requireStaffOrAdmin, wrap(async (req) =>
  billing.removeInvoiceItem(req.params.id, req.params.itemId),
));

router.post('/invoices/:id/discount', requireStaffOrAdmin, wrap(async (req) =>
  billing.applyDiscount(req.params.id, { ...req.body, approved_by: req.user?.uid }),
));

router.post('/invoices/:id/issue', requireStaffOrAdmin, wrap(async (req) =>
  billing.issueInvoice(req.params.id),
));

router.post('/invoices/:id/void', requireAdmin, wrap(async (req) =>
  billing.voidInvoice(req.params.id, { ...req.body, voided_by: req.user?.uid }),
));

// ── Payments ──────────────────────────────────────────────────────────
router.post('/payments', requireStaffOrAdmin, wrap(async (req) =>
  billing.collectPayment({ ...req.body, collected_by: req.user?.uid }),
));

router.post('/payments/:id/reverse', requireAdmin, wrap(async (req) =>
  billing.reversePayment(req.params.id, { ...req.body, reversed_by: req.user?.uid }),
));

// ── Advances ──────────────────────────────────────────────────────────
router.post('/advances', requireStaffOrAdmin, wrap(async (req) =>
  billing.collectAdvance({ ...req.body, collected_by: req.user?.uid }),
));

router.get('/advances', requireStaffOrAdmin, wrap(async (req) => billing.listAdvances({
  patient_uid: req.query.patient_uid,
  admission_id: req.query.admission_id,
  status: req.query.status,
})));

router.post('/advances/:id/settle', requireStaffOrAdmin, wrap(async (req) =>
  billing.settleAdvance({
    advance_id: req.params.id,
    invoice_id: req.body.invoice_id,
    amount: req.body.amount,
    settled_by: req.user?.uid,
  }),
));

// ── Refunds ───────────────────────────────────────────────────────────
router.post('/refunds', requireStaffOrAdmin, wrap(async (req) =>
  billing.raiseRefund({ ...req.body, raised_by: req.user?.uid }),
));

router.get('/refunds', requireStaffOrAdmin, wrap(async (req) => billing.listRefunds({
  approval_status: req.query.approval_status,
  patient_uid: req.query.patient_uid,
})));

router.post('/refunds/:id/approve', requireAdmin, wrap(async (req) =>
  billing.approveRefund(req.params.id, { approved_by: req.user?.uid }),
));

router.post('/refunds/:id/reject', requireAdmin, wrap(async (req) =>
  billing.rejectRefund(req.params.id, { ...req.body, rejected_by: req.user?.uid }),
));

router.post('/refunds/:id/pay', requireStaffOrAdmin, wrap(async (req) =>
  billing.markRefundPaid(req.params.id, { ...req.body, paid_by: req.user?.uid }),
));

// ── Reports ───────────────────────────────────────────────────────────
router.get('/reports/daily-collection', requireStaffOrAdmin, wrap(async (req) =>
  billing.dailyCollection({
    date: req.query.date,
    mode: req.query.mode,
    shift: req.query.shift,
    collected_by: req.query.collected_by,
  }),
));

router.get('/reports/outstanding', requireStaffOrAdmin, wrap(async (req) =>
  billing.outstandingBills({
    days_old: req.query.days_old,
    department: req.query.department,
    limit: req.query.limit || 100,
  }),
));

export default router;
