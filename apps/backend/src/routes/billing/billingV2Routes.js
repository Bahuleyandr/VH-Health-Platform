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
import * as cashDrawer from '../../services/billing/cashDrawerService.js';
import * as payLinks from '../../services/billing/paymentLinkService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();
const BILLING_V2_EXTRA_STAFF_ROLES = ['SUPER_ADMIN', 'FINANCE_INCHARGE', 'BILLING_INCHARGE'];
const CASH_DRAWER_REVIEWER_ROLES = ['ADMIN', 'SUPER_ADMIN', 'FINANCE_INCHARGE'];

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
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!isStaff(role) && !isAdmin(role) && !BILLING_V2_EXTRA_STAFF_ROLES.includes(role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  next();
}

function requireCashDrawerReviewer(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!CASH_DRAWER_REVIEWER_ROLES.includes(role)) {
    return error(res, 'Cash-drawer review requires FINANCE_INCHARGE or admin', 403);
  }
  next();
}

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
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
  billing.applyDiscount(req.params.id, {
    ...req.body,
    approved_by: req.user?.uid,
    approved_by_role: req.user?.role,
  }),
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

// ── Cash-drawer sessions (cashier shift-close + reconciliation) ───────
// Closes findings:
//   2026-05-09-inpatient-admission-billing-no-cashier-shift-reconciliation
//   2026-05-10-inpatient-admission-billing-cash-drawer-reconciliation-missing

router.post('/cash-drawer/sessions/open', requireStaffOrAdmin, wrap(async (req) =>
  cashDrawer.openSession({
    tenantId: tenantOf(req),
    cashier_uid: req.body.cashier_uid || req.user?.uid,
    shift: req.body.shift,
    opening_float: req.body.opening_float,
  }),
));

router.post('/cash-drawer/sessions/:id/close', requireStaffOrAdmin, wrap(async (req) =>
  cashDrawer.closeSession({
    tenantId: tenantOf(req),
    id: req.params.id,
    cashier_uid: req.user?.uid,
    counted_denominations: req.body.counted_denominations,
    variance_reason: req.body.variance_reason,
  }),
));

router.post('/cash-drawer/sessions/:id/review', requireCashDrawerReviewer, wrap(async (req) =>
  cashDrawer.reviewSession({
    tenantId: tenantOf(req),
    id: req.params.id,
    reviewer_uid: req.user?.uid,
    review_notes: req.body.review_notes,
  }),
));

router.get('/cash-drawer/sessions', requireStaffOrAdmin, wrap(async (req) =>
  cashDrawer.listSessions({
    tenantId: tenantOf(req),
    cashier_uid: req.query.cashier_uid,
    shift: req.query.shift,
    status: req.query.status,
    requires_review: req.query.requires_review,
    limit: req.query.limit,
  }),
));

router.get('/cash-drawer/sessions/:id', requireStaffOrAdmin, wrap(async (req) =>
  cashDrawer.getSession({
    tenantId: tenantOf(req),
    id: req.params.id,
  }),
));

// ── Payment links (UPI / gateway) ─────────────────────────────────────
// Sprint 4. Cashier creates a link, fans it out via WhatsApp/email,
// then either marks paid manually (UPI) or the gateway webhook flips
// status (when wired). Existing collectPayment is reused so invoice
// totals and daily-collection rollups stay consistent.

router.post('/payment-links', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.createPaymentLink({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/payment-links', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.listPaymentLinks({
    tenantId: tenantOf(req),
    patient_uid: req.query.patient_uid,
    status: req.query.status,
    invoice_id: req.query.invoice_id,
    limit: req.query.limit || 100,
  }),
));

router.get('/payment-links/:token', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.getPaymentLink({
    tenantId: tenantOf(req),
    link_token: req.params.token,
  }),
));

router.post('/payment-links/:token/send', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.sendPaymentLink({
    tenantId: tenantOf(req),
    link_token: req.params.token,
    channels: req.body.channels,
    patient_phone: req.body.patient_phone,
    patient_email: req.body.patient_email,
    hospital_short_url_base: req.body.hospital_short_url_base,
  }),
));

router.post('/payment-links/:token/mark-paid', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.markPaymentLinkPaid({
    tenantId: tenantOf(req),
    link_token: req.params.token,
    paid_via: req.body.paid_via,
    paid_reference: req.body.paid_reference,
    performed_by: req.user?.uid,
  }),
));

router.post('/payment-links/:token/cancel', requireStaffOrAdmin, wrap(async (req) =>
  payLinks.cancelPaymentLink({
    tenantId: tenantOf(req),
    link_token: req.params.token,
    reason: req.body.reason,
  }),
));

router.post('/payment-links/run-expire-stale', requireAdmin, wrap(async () =>
  payLinks.expireStaleLinks(),
));

export default router;
